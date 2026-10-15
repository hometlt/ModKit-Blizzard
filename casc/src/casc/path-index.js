import { bytesToHex, hexToBytes } from './binary.js'

/**
 * Columnar name table for a CASC root: paths, content keys and sizes in typed arrays.
 *
 * An installed StarCraft II root names ~666k files. Held the obvious way — one JS object per
 * file, with its path and a 32-char hex content key — that table costs ~460 MB of V8 heap. The
 * archive worker runs under a 896 MB heap cap it shares with every other extension in the window,
 * so building the index alone was enough to kill it (`ERR_WORKER_OUT_OF_MEMORY`) and drop a map
 * preview back to the entry list. The same table in typed arrays is ~80 MB of *external* memory
 * and leaves the JS heap flat; strings are decoded only for the rows a caller actually touches.
 * The keys are front-coded (see the class), which brings the table to ~27 MB.
 *
 * Rows are sorted by their normalized key (lower-case, `/`-separated), so lookup, prefix listing
 * and the namespace source's paging cursors are all binary searches over one order. A row whose
 * display path differs from its key keeps the original spelling in a side map — real SC2 roots
 * are lower-case throughout, so that map stays empty.
 */

const CONTENT_KEY_BYTES = 16
/** Rows per front-coded key block; see {@link CascPathIndex}. */
const BLOCK_ROWS = 16
const CACHE_MAGIC = 0x434e444d // 'MDNC'
const CACHE_VERSION = 3
const CACHE_HEADER_BYTES = 16

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const NO_CONTENT_KEY = new Uint8Array(CONTENT_KEY_BYTES)

/** Lower-case, `/`-separated — the form rows are keyed and sorted by. */
export function normalizeIndexKey(path) {
  return String(path).replace(/\\/g, '/').toLowerCase()
}

function grownTo(array, minLength) {
  if (array.length >= minLength) return array
  const grown = new array.constructor(Math.max(array.length * 2, minLength, 1024))
  grown.set(array)
  return grown
}

/** Compare a stored row's key bytes against a needle. */
function compareKey(keys, start, end, needle) {
  const shared = Math.min(end - start, needle.length)
  for (let i = 0; i < shared; i++) {
    const difference = keys[start + i] - needle[i]
    if (difference !== 0) return difference
  }
  return end - start - needle.length
}

/** Compare two stored rows. Hot: this runs ~13M times while sorting an installed SC2 root. */
function compareRows(keys, keyOff, left, right) {
  let a = keyOff[left]
  let b = keyOff[right]
  const aEnd = keyOff[left + 1]
  const bEnd = keyOff[right + 1]
  while (a < aEnd && b < bEnd) {
    const difference = keys[a++] - keys[b++]
    if (difference !== 0) return difference
  }
  return aEnd - keyOff[left] - (bEnd - keyOff[right])
}

/**
 * Sort rows by key bytes with a three-way radix quicksort (Bentley–Sedgewick). Installed SC2
 * paths share ~30-byte prefixes (`mods/liberty.sc2mod/base.sc2assets/…`), so a comparison sort
 * re-reads each prefix on every one of its ~13M comparisons (~0.9 s for 666k rows); this reads
 * a byte position once per partition. Equal keys come out in row order, as from a stable sort.
 */
function sortRows(keys, keyOff, order) {
  const byteAt = (row, depth) => {
    const at = keyOff[row] + depth
    return at < keyOff[row + 1] ? keys[at] : -1
  }
  const stack = [0, order.length, 0]
  while (stack.length > 0) {
    const depth = stack.pop()
    const hi = stack.pop()
    const lo = stack.pop()
    if (hi - lo < 2) continue
    if (hi - lo < 12) {
      for (let i = lo + 1; i < hi; i++) {
        const row = order[i]
        let j = i
        while (j > lo && compareRowsFrom(keys, keyOff, order[j - 1], row, depth) > 0) {
          order[j] = order[j - 1]
          j--
        }
        order[j] = row
      }
      continue
    }
    const a = byteAt(order[lo], depth)
    const b = byteAt(order[(lo + hi) >>> 1], depth)
    const c = byteAt(order[hi - 1], depth)
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b
    let lt = lo
    let gt = hi - 1
    let i = lo
    while (i <= gt) {
      const value = byteAt(order[i], depth)
      if (value < pivot) {
        const swap = order[lt]
        order[lt++] = order[i]
        order[i++] = swap
      } else if (value > pivot) {
        const swap = order[gt]
        order[gt--] = order[i]
        order[i] = swap
      } else i++
    }
    stack.push(lo, lt, depth, gt + 1, hi, depth)
    if (pivot >= 0) stack.push(lt, gt + 1, depth + 1)
    else order.subarray(lt, gt + 1).sort()
  }
}

/** {@link compareRows} from byte `depth` on, rows that tie falling back to their order. */
function compareRowsFrom(keys, keyOff, left, right, depth) {
  let a = keyOff[left] + depth
  let b = keyOff[right] + depth
  const aEnd = keyOff[left + 1]
  const bEnd = keyOff[right + 1]
  while (a < aEnd && b < bEnd) {
    const difference = keys[a++] - keys[b++]
    if (difference !== 0) return difference
  }
  return aEnd - a - (bEnd - b) || left - right
}

function u32View(bytes, offset, length) {
  const start = bytes.byteOffset + offset
  // A Uint32Array needs a 4-aligned start; a buffer read off disk may not give one.
  return start % 4 === 0
    ? new Uint32Array(bytes.buffer, start, length)
    : new Uint32Array(bytes.slice(offset, offset + length * 4).buffer)
}

/**
 * Builds a {@link CascPathIndex}. Rows may be appended in any order and as raw bytes, so a root
 * parser never has to materialize a path string per file; `build()` sorts and de-duplicates.
 */
export class CascPathIndexBuilder {
  keys = new Uint8Array(1 << 16)
  keyEnd = 0
  keyOff = new Uint32Array(1025)
  contentKeys = new Uint8Array(1024 * CONTENT_KEY_BYTES)
  sizes = new Uint32Array(1024)
  packages = new Uint32Array(1024)
  display = new Map()
  count = 0

  /**
   * Append one row. `pathBytes[0..pathLength)` is the path as stored in the root; it is
   * normalized in place into the key block, and its original spelling is kept only when the two
   * differ. `contentKey` is read from `contentKeyOffset` for {@link CONTENT_KEY_BYTES} bytes.
   */
  add(pathBytes, pathLength, contentKey, contentKeyOffset, contentSize, packageIndex) {
    const row = this.count
    this.keyOff = grownTo(this.keyOff, row + 2)
    this.contentKeys = grownTo(this.contentKeys, (row + 1) * CONTENT_KEY_BYTES)
    this.sizes = grownTo(this.sizes, row + 1)
    this.packages = grownTo(this.packages, row + 1)
    this.keys = grownTo(this.keys, this.keyEnd + pathLength)
    this.keyOff[row] = this.keyEnd

    let ascii = true
    let changed = false
    for (let i = 0; i < pathLength; i++) {
      const byte = pathBytes[i]
      if (byte > 0x7f) {
        ascii = false
        break
      }
      const lowered = byte === 0x5c ? 0x2f : byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
      if (lowered !== byte) changed = true
      this.keys[this.keyEnd + i] = lowered
    }
    if (ascii) {
      if (changed) {
        this.display.set(row, decoder.decode(pathBytes.subarray(0, pathLength)))
      }
      this.keyEnd += pathLength
    } else {
      // Non-ASCII names are rare enough to pay for string normalization, and must follow the
      // same case rules as a caller's `normalizeIndexKey` or their lookups would miss.
      const shown = decoder.decode(pathBytes.subarray(0, pathLength))
      const key = normalizeIndexKey(shown)
      if (key !== shown) this.display.set(row, shown)
      const keyBytes = encoder.encode(key)
      this.keys = grownTo(this.keys, this.keyEnd + keyBytes.length)
      this.keys.set(keyBytes, this.keyEnd)
      this.keyEnd += keyBytes.length
    }

    this.keyOff[row + 1] = this.keyEnd
    // Byte loops, not `set(subarray(…))`: a view object per row is ~1.3M allocations per build.
    const at = row * CONTENT_KEY_BYTES
    for (let i = 0; i < CONTENT_KEY_BYTES; i++) {
      this.contentKeys[at + i] = contentKey[contentKeyOffset + i]
    }
    this.sizes[row] = contentSize
    this.packages[row] = packageIndex
    this.count = row + 1
  }

  /** Append a row from a plain `{ path, contentKey, contentSize, packageIndex }` record. */
  addFile(file) {
    const pathBytes = encoder.encode(String(file.path))
    const contentKey =
      typeof file.contentKey === 'string' && file.contentKey.length === CONTENT_KEY_BYTES * 2
        ? hexToBytes(file.contentKey)
        : NO_CONTENT_KEY
    this.add(
      pathBytes,
      pathBytes.length,
      contentKey,
      0,
      file.contentSize ?? 0,
      file.packageIndex ?? 0,
    )
  }

  /** Sort by key, drop repeated keys (the last one wins, as a map insert would) and compact. */
  build(Index = CascPathIndex) {
    const { keys, keyOff, count } = this
    const order = new Uint32Array(count)
    for (let i = 0; i < count; i++) order[i] = i
    sortRows(keys, keyOff, order)
    const kept = new Uint32Array(count)
    let rows = 0
    for (let i = 0; i < count; i++) {
      const row = order[i]
      // A later row carrying the same key wins, as a map insert would; the sort is stable, so
      // that row is the next one in the run.
      if (i + 1 < count && compareRows(keys, keyOff, row, order[i + 1]) === 0) continue
      kept[rows++] = row
    }

    const blockOff = new Uint32Array(Math.ceil(rows / BLOCK_ROWS) + 1)
    let outKeys = new Uint8Array(Math.max(1024, this.keyEnd >>> 2))
    let at = 0
    const outContentKeys = new Uint8Array(rows * CONTENT_KEY_BYTES)
    const outSizes = new Uint32Array(rows)
    const outPackages = new Uint32Array(rows)
    const outDisplay = new Map()
    for (let i = 0; i < rows; i++) {
      const row = kept[i]
      const start = keyOff[row]
      const end = keyOff[row + 1]
      let shared = 0
      if (i % BLOCK_ROWS === 0) blockOff[i / BLOCK_ROWS] = at
      else {
        const previous = keyOff[kept[i - 1]]
        const limit = Math.min(end - start, keyOff[kept[i - 1] + 1] - previous)
        while (shared < limit && keys[start + shared] === keys[previous + shared]) shared++
      }
      outKeys = grownTo(outKeys, at + 10 + end - start)
      if (i % BLOCK_ROWS !== 0) at = writeVarint(outKeys, at, shared)
      at = writeVarint(outKeys, at, end - start - shared)
      for (let from = start + shared; from < end; ) outKeys[at++] = keys[from++]
      for (let k = 0, from = row * CONTENT_KEY_BYTES, to = i * CONTENT_KEY_BYTES; k < CONTENT_KEY_BYTES; k++) {
        outContentKeys[to + k] = this.contentKeys[from + k]
      }
      outSizes[i] = this.sizes[row]
      outPackages[i] = this.packages[row]
      if (this.display.size > 0) {
        const shown = this.display.get(row)
        if (shown !== undefined) outDisplay.set(i, shown)
      }
    }
    blockOff[blockOff.length - 1] = at
    return new Index(rows, outKeys.slice(0, at), blockOff, outContentKeys, outSizes, outPackages, outDisplay)
  }
}

function writeVarint(bytes, at, value) {
  while (value >= 0x80) {
    bytes[at++] = (value & 0x7f) | 0x80
    value >>>= 7
  }
  bytes[at++] = value
  return at
}

export class CascPathIndex {
  /**
   * `keys` holds the rows front-coded in blocks of {@link BLOCK_ROWS}: a block's first key in
   * full (`varint length, bytes`), every other one as what it adds to its predecessor (`varint
   * shared, varint length, bytes`). Sorted paths share most of their bytes — an installed SC2
   * root's 65 MB of keys take 10.5 MB — and a lookup still binary-searches the block heads in
   * place, then decodes one block. `blockOff[b]` is where block `b` starts.
   */
  constructor(count, keys, blockOff, contentKeys, sizes, packages, display) {
    this.count = count
    this.keys = keys
    this.blockOff = blockOff
    this.contentKeys = contentKeys
    this.sizes = sizes
    this.packages = packages
    this.display = display
    // The last decoded block: listings walk rows in order, so most calls land in it.
    this.decodedBlock = -1
    this.decoded = new Uint8Array(1024)
    this.decodedOff = new Uint32Array(BLOCK_ROWS + 1)
  }

  get size() {
    return this.count
  }

  /** Decode block `block` into {@link decoded}; row `r` of it is `decodedOff[r]..[r + 1]`. */
  decodeBlock(block) {
    if (this.decodedBlock === block) return
    const keys = this.keys
    const rows = Math.min(BLOCK_ROWS, this.count - block * BLOCK_ROWS)
    let at = this.blockOff[block]
    let out = 0
    let previous = 0
    for (let r = 0; r < rows; r++) {
      let shared = 0
      if (r > 0) {
        for (let shift = 0; ; shift += 7) {
          const byte = keys[at++]
          shared |= (byte & 0x7f) << shift
          if (byte < 0x80) break
        }
      }
      let length = 0
      for (let shift = 0; ; shift += 7) {
        const byte = keys[at++]
        length |= (byte & 0x7f) << shift
        if (byte < 0x80) break
      }
      if (this.decoded.length < out + shared + length) {
        this.decoded = grownTo(this.decoded, out + shared + length)
      }
      const decoded = this.decoded
      decoded.copyWithin(out, previous, previous + shared)
      for (let k = 0; k < length; k++) decoded[out + shared + k] = keys[at + k]
      at += length
      this.decodedOff[r] = out
      previous = out
      out += shared + length
    }
    this.decodedOff[rows] = out
    this.decodedBlock = block
  }

  /** The normalized key of row `index` — what rows are sorted by. */
  keyAt(index) {
    const row = index % BLOCK_ROWS
    this.decodeBlock((index - row) / BLOCK_ROWS)
    return decoder.decode(this.decoded.subarray(this.decodedOff[row], this.decodedOff[row + 1]))
  }

  /**
   * Visit the keys of rows `start..end` in order as bytes, `bytes[from..to)`, decoding each block
   * once and making nothing per row: a search over every name reads them all, and most of them
   * only to be ruled out. `visit` may ask {@link keyAt} of the row it was handed; it returns
   * `false` to stop.
   */
  forEachKey(start, end, visit) {
    for (let row = Math.max(0, start); row < Math.min(end, this.count); row++) {
      const slot = row % BLOCK_ROWS
      this.decodeBlock((row - slot) / BLOCK_ROWS)
      const from = this.decodedOff[slot]
      if (visit(this.decoded, from, this.decodedOff[slot + 1], row) === false) return
    }
  }

  /** The path as the root spelled it (equal to the key unless the root used mixed case). */
  pathAt(index) {
    return this.display.get(index) ?? this.keyAt(index)
  }

  contentKeyAt(index) {
    return bytesToHex(
      this.contentKeys.subarray(index * CONTENT_KEY_BYTES, (index + 1) * CONTENT_KEY_BYTES),
    )
  }

  contentSizeAt(index) {
    return this.sizes[index]
  }

  fileAt(index) {
    return Object.freeze({
      path: this.pathAt(index),
      contentKey: this.contentKeyAt(index),
      contentSize: this.sizes[index],
      packageIndex: this.packages[index],
    })
  }

  /** First row whose key is >= `key` (already normalized). */
  lowerBound(key) {
    const needle = encoder.encode(key)
    const keys = this.keys
    // Blocks whose head sorts before the needle; a head is stored whole, so it compares in place.
    let low = 0
    let high = this.blockOff.length - 1
    while (low < high) {
      const middle = (low + high) >>> 1
      let at = this.blockOff[middle]
      let length = 0
      for (let shift = 0; ; shift += 7) {
        const byte = keys[at++]
        length |= (byte & 0x7f) << shift
        if (byte < 0x80) break
      }
      if (compareKey(keys, at, at + length, needle) < 0) low = middle + 1
      else high = middle
    }
    if (low === 0) return 0
    // The answer is in block `low - 1` (its head is smaller) or is the next block's head.
    const block = low - 1
    this.decodeBlock(block)
    const rows = Math.min(BLOCK_ROWS, this.count - block * BLOCK_ROWS)
    for (let r = 1; r < rows; r++) {
      if (compareKey(this.decoded, this.decodedOff[r], this.decodedOff[r + 1], needle) >= 0) {
        return block * BLOCK_ROWS + r
      }
    }
    return Math.min(this.count, low * BLOCK_ROWS)
  }

  indexOf(path) {
    const key = normalizeIndexKey(path)
    const at = this.lowerBound(key)
    return at < this.count && this.keyAt(at) === key ? at : -1
  }

  getByPath(path) {
    const at = this.indexOf(path)
    return at === -1 ? undefined : this.fileAt(at)
  }

  /**
   * True if `path` is a known file OR a directory prefix of one. A CASC root stores only files,
   * so a folder "exists" iff some file lives under it.
   */
  hasPrefix(path) {
    const key = normalizeIndexKey(path).replace(/\/+$/, '')
    if (key === '') return this.count > 0
    if (this.indexOf(key) !== -1) return true
    const prefix = `${key}/`
    const at = this.lowerBound(prefix)
    return at < this.count && this.keyAt(at).startsWith(prefix)
  }

  listPaths(prefix = '') {
    const key = normalizeIndexKey(prefix).replace(/\/+$/, '')
    if (key === '') {
      const all = []
      for (let i = 0; i < this.count; i++) all.push(this.pathAt(i))
      return all.sort()
    }
    const withSlash = `${key}/`
    const out = []
    for (let i = this.lowerBound(withSlash); i < this.count; i++) {
      if (!this.keyAt(i).startsWith(withSlash)) break
      out.push(this.pathAt(i).slice(withSlash.length))
    }
    return out.sort()
  }

  *files() {
    for (let i = 0; i < this.count; i++) yield this.fileAt(i)
  }

  /** Build an index from plain `{ path, contentKey, contentSize, packageIndex }` records. */
  static fromFiles(files) {
    const builder = new CascPathIndexBuilder()
    for (const file of files) builder.addFile(file)
    return builder.build(this)
  }

  /**
   * Serialize for the on-disk root cache. The columns are already the wire format, so this is a
   * few block copies, and {@link deserialize} maps them back without touching a single row.
   */
  serialize() {
    const displayBytes = []
    for (const [index, shown] of this.display) displayBytes.push([index, encoder.encode(shown)])
    const displayLength = displayBytes.reduce((total, [, bytes]) => total + 8 + bytes.length, 4)
    const fixed = this.count * 4 * 2 + this.blockOff.length * 4 + this.count * CONTENT_KEY_BYTES
    const out = new Uint8Array(CACHE_HEADER_BYTES + fixed + this.keys.length + displayLength)
    const view = new DataView(out.buffer)
    view.setUint32(0, CACHE_MAGIC, true)
    view.setUint32(4, CACHE_VERSION, true)
    view.setUint32(8, this.count, true)
    view.setUint32(12, this.keys.length, true)
    let offset = CACHE_HEADER_BYTES
    for (const column of [this.sizes, this.packages, this.blockOff]) {
      out.set(new Uint8Array(column.buffer, column.byteOffset, column.length * 4), offset)
      offset += column.length * 4
    }
    out.set(this.contentKeys, offset)
    offset += this.contentKeys.length
    out.set(this.keys, offset)
    offset += this.keys.length
    view.setUint32(offset, displayBytes.length, true)
    offset += 4
    for (const [index, bytes] of displayBytes) {
      view.setUint32(offset, index, true)
      view.setUint32(offset + 4, bytes.length, true)
      out.set(bytes, offset + 8)
      offset += 8 + bytes.length
    }
    return out
  }

  /** Map a {@link serialize} blob back. Throws on a bad, foreign or outdated cache. */
  static deserialize(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.byteLength < CACHE_HEADER_BYTES || view.getUint32(0, true) !== CACHE_MAGIC) {
      throw new Error('CASC path index cache: bad magic')
    }
    if (view.getUint32(4, true) !== CACHE_VERSION) {
      throw new Error('CASC path index cache: version mismatch')
    }
    const count = view.getUint32(8, true)
    const keyLength = view.getUint32(12, true)
    let offset = CACHE_HEADER_BYTES
    const sizes = u32View(bytes, offset, count)
    offset += count * 4
    const packages = u32View(bytes, offset, count)
    offset += count * 4
    const blocks = Math.ceil(count / BLOCK_ROWS) + 1
    const blockOff = u32View(bytes, offset, blocks)
    offset += blocks * 4
    const contentKeys = bytes.subarray(offset, offset + count * CONTENT_KEY_BYTES)
    offset += count * CONTENT_KEY_BYTES
    const keys = bytes.subarray(offset, offset + keyLength)
    offset += keyLength
    if (offset + 4 > bytes.byteLength) throw new Error('CASC path index cache: truncated')
    const display = new Map()
    const displayCount = view.getUint32(offset, true)
    offset += 4
    for (let i = 0; i < displayCount; i++) {
      const index = view.getUint32(offset, true)
      const length = view.getUint32(offset + 4, true)
      display.set(index, decoder.decode(bytes.subarray(offset + 8, offset + 8 + length)))
      offset += 8 + length
    }
    if (offset > bytes.byteLength) throw new Error('CASC path index cache: truncated')
    return new this(count, keys, blockOff, contentKeys, sizes, packages, display)
  }
}

/**
 * The same read surface over an already-standardized array of entries, for the roots small
 * enough to keep as objects (TVFS, Diablo III, the StarCraft I text root).
 */
export function arrayPathIndex(entries) {
  return Object.freeze({
    size: entries.length,
    keyAt: index => entries[index].path,
    contentSizeAt: index => entries[index].contentSize,
    forEachKey(start, end, visit) {
      for (let row = Math.max(0, start); row < Math.min(end, entries.length); row++) {
        const bytes = encoder.encode(entries[row].path)
        if (visit(bytes, 0, bytes.length, row) === false) return
      }
    },
    lowerBound(key) {
      let low = 0
      let high = entries.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (entries[middle].path < key) low = middle + 1
        else high = middle
      }
      return low
    },
  })
}
