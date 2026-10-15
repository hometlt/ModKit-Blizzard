/**
 * The World of Warcraft CASC root (`root` of the build config, magic `TSFM` since 8.2): files by
 * FileDataID, with content keys, locale and content flags, and Jenkins hashes of the names a few
 * of them still carry. The root names no paths — the client finds files by ID — so a reader lists
 * each file as `filedataid/<id>`; names come from a listfile, which this module does not read.
 *
 * Reads the 8.2 header (magic, total, named), the 10.1.7+ header (magic, header size, version,
 * total, named) with version 1 and 2 blocks, and the pre-8.2 root without magic (content key and
 * name hash interleaved). One root holds a file once per locale and platform variant; the variant
 * the installed client loads is chosen ({@link wowRootFiles}). Pure: no Node imports.
 */

/** `TSFM` read as a little-endian 32-bit word. */
const TSFM = 0x4d465354
const CONTENT_KEY_BYTES = 16
const LOAD_ON_WINDOWS = 0x8
const LOAD_ON_MAC = 0x10
const LOW_VIOLENCE = 0x80
const NO_NAME_HASH = 0x10000000

/** Root locale flags by `.build.info` locale tag. */
const LOCALES: Readonly<Record<string, number>> = Object.freeze({
  enUS: 0x2, koKR: 0x4, frFR: 0x10, deDE: 0x20, zhCN: 0x40, esES: 0x80, zhTW: 0x100, enGB: 0x200,
  enCN: 0x400, enTW: 0x800, esMX: 0x1000, ruRU: 0x2000, ptBR: 0x4000, itIT: 0x8000, ptPT: 0x10000,
})

/** The locale flag of a tag (`ruRU`), or of `enUS` for one the root does not know. */
export function wowLocaleFlag(locale: string | undefined): number {
  return LOCALES[locale ?? ''] ?? 0x2
}

export function isWowRoot(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === TSFM
}

/** The files a client of one locale loads: sorted IDs, and where each one's content key lies in the root. */
export interface WowRootFiles {
  readonly fileDataIds: Uint32Array
  readonly contentKeyOffsets: Uint32Array
}

interface Block {
  readonly count: number
  readonly contentFlags: number
  readonly localeFlags: number
  readonly deltas: number
  readonly contentKeys: number
  /** Bytes from one record's content key to the next: 16, or 24 in the pre-8.2 interleaved layout. */
  readonly stride: number
}

function* blocks(bytes: Uint8Array): Generator<Block> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (at: number) => {
    if (at + 4 > bytes.byteLength) throw new Error('WoW CASC root ends inside a block header')
    return view.getUint32(at, true)
  }
  let at = 0
  let version = 0
  let namesOptional = false
  let interleaved = false
  if (u32(0) === TSFM) {
    const second = u32(4)
    if (second > 1000) {
      // 8.2: magic, total, named — the second word is a file count, not a header size.
      namesOptional = second !== u32(8)
      at = 12
    } else {
      version = u32(8)
      if (version > 2) throw new Error(`WoW CASC root version ${version} is unsupported`)
      namesOptional = u32(12) !== u32(16)
      at = second
    }
  } else {
    interleaved = true
  }
  while (at < bytes.byteLength) {
    const count = u32(at)
    let contentFlags: number
    let localeFlags: number
    if (version === 2) {
      localeFlags = u32(at + 4)
      if (at + 17 > bytes.byteLength) throw new Error('WoW CASC root ends inside a block header')
      contentFlags = (u32(at + 8) | u32(at + 12) | (bytes[at + 16]! << 17)) >>> 0
      at += 17
    } else {
      contentFlags = u32(at + 4)
      localeFlags = u32(at + 8)
      at += 12
    }
    const deltas = at
    at += count * 4
    const contentKeys = at
    const named = interleaved || !(namesOptional && (contentFlags & NO_NAME_HASH) !== 0)
    const stride = interleaved ? CONTENT_KEY_BYTES + 8 : CONTENT_KEY_BYTES
    at += count * stride + (named && !interleaved ? count * 8 : 0)
    if (at > bytes.byteLength) throw new Error('WoW CASC root block extends beyond the root')
    yield { count, contentFlags, localeFlags, deltas, contentKeys, stride }
  }
}

/**
 * How well a variant suits the client: its locale (or every locale), then not the low-violence
 * cut, then not a macOS-only file. The best variant of each ID is the one the reader lists.
 */
function score(block: Block, locale: number): number {
  const mac = (block.contentFlags & LOAD_ON_MAC) !== 0 && (block.contentFlags & LOAD_ON_WINDOWS) === 0
  return ((block.localeFlags & locale) !== 0 ? 4 : 0)
    + ((block.contentFlags & LOW_VIOLENCE) === 0 ? 2 : 0)
    + (mac ? 0 : 1)
}

/** Every file of the root once, as the client of `locale` (a root locale flag) loads it. */
export function wowRootFiles(bytes: Uint8Array, locale: number): WowRootFiles {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let maxId = -1
  for (const block of blocks(bytes)) {
    let id = -1
    for (let i = 0; i < block.count; i++) id += 1 + view.getInt32(block.deltas + i * 4, true)
    if (id > maxId) maxId = id
  }
  // IDs are dense enough (WoW 12: 3.3M files below ~7M) for a table per ID instead of a map.
  const best = new Int8Array(maxId + 1).fill(-1)
  const offsets = new Uint32Array(maxId + 1)
  let files = 0
  for (const block of blocks(bytes)) {
    const rank = score(block, locale)
    let id = -1
    for (let i = 0; i < block.count; i++) {
      id += 1 + view.getInt32(block.deltas + i * 4, true)
      if (id < 0) throw new Error('WoW CASC root names a negative FileDataID')
      if (best[id]! >= rank) continue
      if (best[id] === -1) files++
      best[id] = rank
      offsets[id] = block.contentKeys + i * block.stride
    }
  }
  const fileDataIds = new Uint32Array(files)
  const contentKeyOffsets = new Uint32Array(files)
  for (let id = 0, row = 0; id <= maxId; id++) {
    if (best[id] === -1) continue
    fileDataIds[row] = id
    contentKeyOffsets[row++] = offsets[id]!
  }
  return { fileDataIds, contentKeyOffsets }
}

/** A community listfile (`id;path` lines) as columns over its bytes, sorted by FileDataID. */
export interface WowListfile {
  readonly bytes: Uint8Array
  readonly fileDataIds: Uint32Array
  /** Where each path starts and ends in `bytes`. */
  readonly starts: Uint32Array
  readonly ends: Uint32Array
}

/**
 * Parse a listfile without a string per line: 2+ million lines, ~140 MB. A line that is not
 * `digits;path` is skipped; a repeated ID keeps its last path, as the listfile's own tools do.
 */
export function parseWowListfile(bytes: Uint8Array): WowListfile {
  let lines = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) lines++
  const ids = new Uint32Array(lines + 1)
  const starts = new Uint32Array(lines + 1)
  const ends = new Uint32Array(lines + 1)
  let count = 0
  let sorted = true
  for (let at = 0; at < bytes.length;) {
    let end = bytes.indexOf(0x0a, at)
    if (end === -1) end = bytes.length
    let id = 0
    let i = at
    while (i < end && bytes[i]! >= 0x30 && bytes[i]! <= 0x39) id = id * 10 + bytes[i++]! - 0x30
    let pathEnd = end
    while (pathEnd > i + 1 && (bytes[pathEnd - 1] === 0x0d || bytes[pathEnd - 1] === 0x20)) pathEnd--
    if (i > at && bytes[i] === 0x3b && pathEnd > i + 1 && id <= 0xffffffff) {
      if (count > 0 && id <= ids[count - 1]!) sorted = false
      ids[count] = id
      starts[count] = i + 1
      ends[count++] = pathEnd
    }
    at = end + 1
  }
  if (sorted) return { bytes, fileDataIds: ids.subarray(0, count), starts: starts.subarray(0, count), ends: ends.subarray(0, count) }
  // An ID and its line number in one exactly representable double: IDs < 2^31, lines < 2^22.
  const order = new Float64Array(count)
  for (let row = 0; row < count; row++) order[row] = ids[row]! * 4194304 + row
  order.sort()
  const out = { ids: new Uint32Array(count), starts: new Uint32Array(count), ends: new Uint32Array(count) }
  let kept = 0
  for (let k = 0; k < count; k++) {
    const row = order[k]! % 4194304
    if (kept > 0 && out.ids[kept - 1] === ids[row]) kept--
    out.ids[kept] = ids[row]!
    out.starts[kept] = starts[row]!
    out.ends[kept++] = ends[row]!
  }
  return { bytes, fileDataIds: out.ids.subarray(0, kept), starts: out.starts.subarray(0, kept), ends: out.ends.subarray(0, kept) }
}
