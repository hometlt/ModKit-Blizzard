import { CascPathIndex, CascPathIndexBuilder } from './path-index.js'
/**
 * MNDX root file parser for StarCraft II (and Heroes of the Storm) CASC storages.
 *
 * SC2's root is name-addressed: file paths resolve through a MAR name database (a
 * compressed name-fragment trie) to an `MNDX_CKEY_ENTRY` holding the content key.
 * There is no fileDataId/listfile shortcut. This is a faithful TypeScript port of
 * CascLib's `CascRootFile_MNDX.cpp` (Ladislav Zezula), bottom-up: byte stream →
 * generic/bit arrays → sparse array (rank/select) → path-fragment table → file-name
 * database (recursive trie) → MAR file → root handler.
 *
 * All in-file integers are little-endian DWORDs; trie arithmetic is unsigned 32-bit,
 * so hot paths use `>>> 0` and `Math.imul`. Assumes a little-endian host (Node).
 */
const MNDX_MAR_SIGNATURE = 0x0052414d // 'MAR\0'
const MNDX_ROOT_SIGNATURE = 0x58444e4d // 'MNDX'
const MNDX_LAST_CKEY_ENTRY = 0x80000000
const CASC_INVALID_INDEX = 0xffffffff
const MAR_PACKAGE_NAMES = 0
const MAR_STRIPPED_NAMES = 1
const MAR_FULL_NAMES = 2
const MAR_COUNT = 3
const MNDX_SEARCH_INITIALIZING = 0
const MNDX_SEARCH_SEARCHING = 2
const MNDX_SEARCH_FINISHED = 4
// table_1BA1818: for a byte `b` (0..255) and rank `r` (0..7), table[r*256 + b] is the
// 0-based position of the r-th set bit of b counting from the LSB, or 7 if b has fewer
// than r+1 set bits. CascLib hardcodes this 0x800-byte table; we generate it (and a
// test pins it to known reference values) to avoid transcribing 2048 bytes by hand.
/** Exported for tests only (not re-exported from the package index). */
export const SELECT_TABLE = buildSelectTable()
function buildSelectTable() {
  const t = new Uint8Array(0x800)
  for (let r = 0; r < 8; r++) {
    for (let b = 0; b < 256; b++) {
      let count = 0
      let pos = 7
      for (let bit = 0; bit < 8; bit++) {
        if (b & (1 << bit)) {
          if (count === r) {
            pos = bit
            break
          }
          count++
        }
      }
      t[r * 256 + b] = pos
    }
  }
  return t
}
// HOTS: GetNumberOfSetBits — popcount of each byte lane, summed into successive bytes.
function getNumberOfSetBits(value32) {
  let v = value32 >>> 0
  v = (((v >>> 1) & 0x55555555) + (v & 0x55555555)) >>> 0
  v = (((v >>> 2) & 0x33333333) + (v & 0x33333333)) >>> 0
  v = (((v >>> 4) & 0x0f0f0f0f) + (v & 0x0f0f0f0f)) >>> 0
  const all = Math.imul(v, 0x01010101) >>> 0
  return {
    lower08: all & 0xff,
    lower16: (all >>> 8) & 0xff,
    lower24: (all >>> 16) & 0xff,
    lower32: (all >>> 24) & 0xff,
  }
}
function getNumberOfSetBits32(value32) {
  return getNumberOfSetBits(value32).lower32
}
// -----------------------------------------------------------------------------
// TByteStream
class ByteStream {
  data
  view
  pos
  constructor(data, offset = 0) {
    this.data = data
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.pos = offset
  }
  u32() {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v >>> 0
  }
  // ULONGLONG. Item byte-counts here are < 2^53, safe as a JS number.
  u64() {
    const lo = this.view.getUint32(this.pos, true)
    const hi = this.view.getUint32(this.pos + 4, true)
    this.pos += 8
    return hi * 0x100000000 + lo
  }
  skip(n) {
    this.pos += n
  }
  // TGenericArray<T>::LoadFromStream — byteCount (u64) then itemCount=byteCount/itemSize
  // items, then padding to the next 8-byte boundary.
  arrayByteCount(itemSize) {
    const byteCount = this.u64()
    if (byteCount % itemSize !== 0)
      throw new Error('MNDX array byte count not a multiple of item size')
    return byteCount
  }
  alignTo8(byteCount) {
    this.skip((8 - (byteCount % 8)) % 8)
  }
  loadDwordArray() {
    const byteCount = this.arrayByteCount(4)
    // Copy into a fresh, 0-aligned ArrayBuffer so the Uint32Array view is valid
    // regardless of the source offset's alignment.
    const copy = new Uint8Array(byteCount)
    copy.set(this.data.subarray(this.pos, this.pos + byteCount))
    this.skip(byteCount)
    this.alignTo8(byteCount)
    return new Uint32Array(copy.buffer)
  }
  loadByteArray() {
    const byteCount = this.arrayByteCount(1)
    const out = new Uint8Array(byteCount)
    out.set(this.data.subarray(this.pos, this.pos + byteCount))
    this.skip(byteCount)
    this.alignTo8(byteCount)
    return out
  }
  loadStructArray(itemSize, parse) {
    const byteCount = this.arrayByteCount(itemSize)
    const count = byteCount / itemSize
    const out = new Array(count)
    for (let i = 0; i < count; i++) out[i] = parse(this.view, this.pos + i * itemSize)
    this.skip(byteCount)
    this.alignTo8(byteCount)
    return out
  }
}
// -----------------------------------------------------------------------------
// TBitEntryArray — packed fixed-width entries inside a DWORD array
class BitEntryArray {
  items = new Uint32Array(0)
  bitsPerEntry = 0
  entryBitMask = 0
  getItem(entryIndex) {
    const bitPos = entryIndex * this.bitsPerEntry
    const itemIndex = bitPos >>> 5
    const startBit = bitPos & 0x1f
    const endBit = startBit + this.bitsPerEntry
    let result
    if (endBit > 0x20) {
      result =
        ((this.items[itemIndex + 1] << (0x20 - startBit)) |
          (this.items[itemIndex] >>> startBit)) >>>
        0
    } else {
      result = this.items[itemIndex] >>> startBit
    }
    return (result & this.entryBitMask) >>> 0
  }
  static load(stream) {
    const arr = new BitEntryArray()
    arr.items = stream.loadDwordArray()
    arr.bitsPerEntry = stream.u32()
    if (arr.bitsPerEntry > 0x20) throw new Error('MNDX BitEntryArray: bits per entry > 32')
    arr.entryBitMask = stream.u32()
    stream.u64() // TotalEntries (validation only)
    return arr
  }
}
class SparseArray {
  itemBits = new Uint32Array(0)
  totalItemCount = 0
  validItemCount = 0
  baseVals = []
  indexToItem0 = new Uint32Array(0)
  indexToItem1 = new Uint32Array(0)
  static load(stream) {
    const a = new SparseArray()
    a.itemBits = stream.loadDwordArray()
    a.totalItemCount = stream.u32()
    a.validItemCount = stream.u32()
    if (a.validItemCount > a.totalItemCount) throw new Error('MNDX SparseArray: valid > total')
    a.baseVals = stream.loadStructArray(12, (dv, off) => {
      const d1 = dv.getUint32(off + 4, true)
      const d2 = dv.getUint32(off + 8, true)
      return {
        base200: dv.getUint32(off, true) >>> 0,
        add40: d1 & 0x7f,
        add80: (d1 >>> 7) & 0xff,
        addC0: (d1 >>> 15) & 0xff,
        add100: (d1 >>> 23) & 0x1ff,
        add140: d2 & 0x1ff,
        add180: (d2 >>> 9) & 0x1ff,
        add1c0: (d2 >>> 18) & 0x1ff,
      }
    })
    a.indexToItem0 = stream.loadDwordArray()
    a.indexToItem1 = stream.loadDwordArray()
    return a
  }
  isEmpty() {
    return this.totalItemCount === 0
  }
  isItemPresent(index) {
    return (this.itemBits[index >>> 5] & (1 << (index & 0x1f))) !== 0
  }
  // HOTS: GetItemValueAt — rank: number of set bits strictly before `index`.
  getItemValueAt(index) {
    const bv = this.baseVals[index >>> 9]
    let value = bv.base200
    switch (((index >>> 6) & 0x07) - 1) {
      case 0:
        value += bv.add40
        break
      case 1:
        value += bv.add80
        break
      case 2:
        value += bv.addC0
        break
      case 3:
        value += bv.add100
        break
      case 4:
        value += bv.add140
        break
      case 5:
        value += bv.add180
        break
      case 6:
        value += bv.add1c0
        break
    }
    if (index & 0x20) value += getNumberOfSetBits32(this.itemBits[(index >>> 5) - 1])
    const bitMask = ((1 << (index & 0x1f)) - 1) >>> 0
    return value + getNumberOfSetBits32((this.itemBits[index >>> 5] & bitMask) >>> 0)
  }
  findGroupItems0(index) {
    let minGroup = this.indexToItem0[index >>> 9] >>> 9
    const maxGroup = (this.indexToItem0[(index >>> 9) + 1] + 0x1ff) >>> 9
    if (maxGroup - minGroup < 10) {
      while (index >= ((minGroup << 9) >>> 0) - this.baseVals[minGroup + 1].base200 + 0x200)
        minGroup++
    } else {
      let mn = minGroup
      let mx = maxGroup
      while (mn + 1 < mx) {
        const mid = (mx + mn) >>> 1
        if (index < ((mx << 9) >>> 0) - this.baseVals[mx].base200) mx = mid
        else mn = mid
      }
      minGroup = mn
    }
    return minGroup
  }
  findGroupItems1(index) {
    const groupIndex = index >>> 9
    let startValue = this.indexToItem1[groupIndex] >>> 9
    const nextValue = (this.indexToItem1[groupIndex + 1] + 0x1ff) >>> 9
    if (nextValue - startValue < 10) {
      while (index >= this.baseVals[startValue + 1].base200) startValue++
    } else {
      if (startValue + 1 < nextValue) {
        const mid = (nextValue + startValue) >>> 1
        if (index < this.baseVals[mid].base200) {
          // nextValue = mid (unused after single step in reference)
        } else {
          startValue = mid
        }
      }
    }
    return startValue
  }
  // HOTS: GetItem0 — select over the *inverted* bits (zero bits).
  getItem0(index) {
    if ((index & 0x1ff) === 0) return this.indexToItem0[index >>> 9]
    const groupIndex = this.findGroupItems0(index)
    const bv = this.baseVals[groupIndex]
    let edx = (index + bv.base200 - ((groupIndex << 9) >>> 0)) >>> 0
    let dwordIndex = groupIndex << 4
    if (edx < 0x100 - bv.add100) {
      if (edx < 0x80 - bv.add80) {
        if (edx >= 0x40 - bv.add40) {
          dwordIndex += 2
          edx = (edx + bv.add40 - 0x40) >>> 0
        }
      } else {
        if (edx < 0xc0 - bv.addC0) {
          dwordIndex += 4
          edx = (edx + bv.add80 - 0x80) >>> 0
        } else {
          dwordIndex += 6
          edx = (edx + bv.addC0 - 0xc0) >>> 0
        }
      }
    } else {
      if (edx < 0x180 - bv.add180) {
        if (edx < 0x140 - bv.add140) {
          dwordIndex += 8
          edx = (edx + bv.add100 - 0x100) >>> 0
        } else {
          dwordIndex += 10
          edx = (edx + bv.add140 - 0x140) >>> 0
        }
      } else {
        if (edx < 0x1c0 - bv.add1c0) {
          dwordIndex += 12
          edx = (edx + bv.add180 - 0x180) >>> 0
        } else {
          dwordIndex += 14
          edx = (edx + bv.add1c0 - 0x1c0) >>> 0
        }
      }
    }
    let bitGroup = ~this.itemBits[dwordIndex] >>> 0
    let zeroBits = getNumberOfSetBits(bitGroup)
    if (edx >= zeroBits.lower32) {
      bitGroup = ~this.itemBits[++dwordIndex] >>> 0
      edx -= zeroBits.lower32
      zeroBits = getNumberOfSetBits(bitGroup)
    }
    let itemIndex = dwordIndex << 5
    if (edx < zeroBits.lower16) {
      if (edx >= zeroBits.lower08) {
        bitGroup >>>= 0x08
        itemIndex += 0x08
        edx -= zeroBits.lower08
      }
    } else {
      if (edx < zeroBits.lower24) {
        bitGroup >>>= 0x10
        itemIndex += 0x10
        edx -= zeroBits.lower16
      } else {
        bitGroup >>>= 0x18
        itemIndex += 0x18
        edx -= zeroBits.lower24
      }
    }
    edx = (edx << 8) >>> 0
    bitGroup &= 0xff
    return SELECT_TABLE[bitGroup + edx] + itemIndex
  }
  // HOTS: GetItem1 — select over the *normal* bits (set bits).
  getItem1(index) {
    if ((index & 0x1ff) === 0) return this.indexToItem1[index >>> 9]
    const groupIndex = this.findGroupItems1(index)
    const bv = this.baseVals[groupIndex]
    let dist = (index - bv.base200) >>> 0
    let dwordIndex = groupIndex << 4
    if (dist < bv.add100) {
      if (dist < bv.add80) {
        if (dist >= bv.add40) {
          dist -= bv.add40
          dwordIndex += 2
        }
      } else {
        if (dist < bv.addC0) {
          dist -= bv.add80
          dwordIndex += 4
        } else {
          dist -= bv.addC0
          dwordIndex += 6
        }
      }
    } else {
      if (dist < bv.add180) {
        if (dist < bv.add140) {
          dist -= bv.add100
          dwordIndex += 8
        } else {
          dist -= bv.add140
          dwordIndex += 10
        }
      } else {
        if (dist < bv.add1c0) {
          dist -= bv.add180
          dwordIndex += 12
        } else {
          dist -= bv.add1c0
          dwordIndex += 14
        }
      }
    }
    let bitGroup = this.itemBits[dwordIndex] >>> 0
    let setBits = getNumberOfSetBits(bitGroup)
    if (dist >= setBits.lower32) {
      bitGroup = this.itemBits[++dwordIndex] >>> 0
      dist -= setBits.lower32
      setBits = getNumberOfSetBits(bitGroup)
    }
    let itemIndex = dwordIndex << 5
    if (dist < setBits.lower16) {
      if (dist >= setBits.lower08) {
        itemIndex += 0x08
        bitGroup >>>= 0x08
        dist -= setBits.lower08
      }
    } else {
      if (dist < setBits.lower24) {
        bitGroup >>>= 0x10
        itemIndex += 0x10
        dist -= setBits.lower16
      } else {
        bitGroup >>>= 0x18
        itemIndex += 0x18
        dist -= setBits.lower24
      }
    }
    bitGroup &= 0xff
    dist = (dist << 8) >>> 0
    return SELECT_TABLE[bitGroup + dist] + itemIndex
  }
}
function newPathStop(loBitsIndex, field4, count) {
  return {
    loBitsIndex,
    field4,
    count,
    hiBitsIndexPathFragment: CASC_INVALID_INDEX,
    field10: 0xffffffff,
  }
}
class Struct40 {
  pathStops = []
  pathBuffer = [] // built path, as byte values
  nodeIndex = 0
  pathLength = 0
  itemCount = 0
  searchPhase = MNDX_SEARCH_INITIALIZING
  beginSearch() {
    this.pathBuffer = []
    this.pathStops = []
    this.pathLength = 0
    this.nodeIndex = 0
    this.itemCount = 0
    this.searchPhase = MNDX_SEARCH_SEARCHING
  }
  calcHashValue(mask) {
    return ((mask[this.pathLength] ?? 0) ^ (this.nodeIndex << 5) ^ this.nodeIndex) >>> 0
  }
}
class MndxSearch {
  mask
  struct40 = new Struct40()
  szFoundPath = []
  cchFoundPath = 0
  nIndex = 0
  constructor(mask) {
    this.mask = mask
  }
  get cchSearchMask() {
    return this.mask.length
  }
}
// -----------------------------------------------------------------------------
// TPathFragmentTable
class PathFragmentTable {
  pathFragments = new Uint8Array(0)
  pathMarks = new SparseArray()
  static load(stream) {
    const t = new PathFragmentTable()
    t.pathFragments = stream.loadByteArray()
    t.pathMarks = SparseArray.load(stream)
    return t
  }
  comparePathFragment(search, fragmentOffset) {
    const s = search.struct40
    let off = fragmentOffset
    if (this.pathMarks.isEmpty()) {
      while (this.pathFragments[off] === search.mask[s.pathLength]) {
        s.pathLength++
        off++
        if (this.pathFragments[off] === 0) return true
        if (s.pathLength >= search.cchSearchMask) return false
      }
      return false
    }
    while (this.pathFragments[off] === search.mask[s.pathLength]) {
      s.pathLength++
      if (this.pathMarks.isItemPresent(off++)) return true
      if (off >= search.cchSearchMask) return false
    }
    return false
  }
  copyPathFragment(search, fragmentOffset) {
    const s = search.struct40
    let off = fragmentOffset
    if (this.pathMarks.isEmpty()) {
      while (this.pathFragments[off] !== 0) s.pathBuffer.push(this.pathFragments[off++])
    } else {
      while (!this.pathMarks.isItemPresent(off)) s.pathBuffer.push(this.pathFragments[off++])
    }
  }
  compareAndCopyPathFragment(search, fragmentOffset) {
    const s = search.struct40
    let off = fragmentOffset
    if (this.pathMarks.isEmpty()) {
      while (s.pathLength < search.cchSearchMask) {
        if (this.pathFragments[off] !== search.mask[s.pathLength]) return false
        s.pathBuffer.push(this.pathFragments[off++])
        s.pathLength++
        if (this.pathFragments[off] === 0) return true
      }
      while (this.pathFragments[off] !== 0) s.pathBuffer.push(this.pathFragments[off++])
    } else {
      while (off < search.cchSearchMask) {
        if (this.pathFragments[off] !== search.mask[s.pathLength]) return false
        s.pathBuffer.push(this.pathFragments[off])
        s.pathLength++
        if (this.pathMarks.isItemPresent(off++)) return true
      }
      while (!this.pathMarks.isItemPresent(off)) s.pathBuffer.push(this.pathFragments[off++])
    }
    return true
  }
}
class FileNameDatabase {
  collisionTable = new SparseArray()
  fileNameIndexes = new SparseArray()
  collisionHiBitsIndexes = new SparseArray()
  loBitsTable = new Uint8Array(0)
  hiBitsTable = new BitEntryArray()
  pathFragmentTable = new PathFragmentTable()
  childDb
  hashTable = []
  hashTableMask = 0
  field214 = 0
  get fileNameValidCount() {
    return this.fileNameIndexes.validItemCount
  }
  static load(stream) {
    const db = new FileNameDatabase()
    db.collisionTable = SparseArray.load(stream)
    db.fileNameIndexes = SparseArray.load(stream)
    db.collisionHiBitsIndexes = SparseArray.load(stream)
    db.loBitsTable = stream.loadByteArray()
    db.hiBitsTable = BitEntryArray.load(stream)
    db.pathFragmentTable = PathFragmentTable.load(stream)
    if (
      db.collisionHiBitsIndexes.validItemCount !== 0 &&
      db.pathFragmentTable.pathFragments.length === 0
    ) {
      db.childDb = FileNameDatabase.load(stream)
    }
    db.hashTable = stream.loadStructArray(12, (dv, off) => ({
      nodeIndex: dv.getUint32(off, true) >>> 0,
      nextIndex: dv.getUint32(off + 4, true) >>> 0,
      fragmentOffset: dv.getUint32(off + 8, true) >>> 0,
    }))
    db.hashTableMask = db.hashTable.length - 1
    db.field214 = stream.u32()
    stream.u32() // dwBitMask (Struct10 config; validation only)
    return db
  }
  static loadMar(marData) {
    const stream = new ByteStream(marData)
    if (stream.u32() !== MNDX_MAR_SIGNATURE)
      throw new Error('MNDX MAR file is missing MAR signature')
    return FileNameDatabase.load(stream)
  }
  isPathFragmentSingleChar(e) {
    return (e.fragmentOffset & 0xffffff00) === 0xffffff00
  }
  isPathFragmentString(index) {
    return this.collisionHiBitsIndexes.isItemPresent(index)
  }
  getPathFragmentOffset1(indexLoBits) {
    const indexHiBits = this.collisionHiBitsIndexes.getItemValueAt(indexLoBits)
    return ((this.hiBitsTable.getItem(indexHiBits) << 8) | this.loBitsTable[indexLoBits]) >>> 0
  }
  getPathFragmentOffset2(state, indexLoBits) {
    if (state.hi === CASC_INVALID_INDEX)
      state.hi = this.collisionHiBitsIndexes.getItemValueAt(indexLoBits)
    else state.hi++
    return ((this.hiBitsTable.getItem(state.hi) << 8) | this.loBitsTable[indexLoBits]) >>> 0
  }
  // HOTS: ComparePathFragment
  comparePathFragment(search) {
    const s = search.struct40
    const nodeIndex = s.calcHashValue(search.mask) & this.hashTableMask
    const e = this.hashTable[nodeIndex]
    if (e.nodeIndex === s.nodeIndex) {
      if (!this.isPathFragmentSingleChar(e)) {
        if (this.childDb) {
          if (!this.childDb.comparePathFragmentByIndex(search, e.fragmentOffset)) return false
        } else {
          if (!this.pathFragmentTable.comparePathFragment(search, e.fragmentOffset)) return false
        }
      } else {
        s.pathLength++
      }
      s.nodeIndex = e.nextIndex
      return true
    }
    let colTableIndex = (this.collisionTable.getItem0(s.nodeIndex) + 1) >>> 0
    s.nodeIndex = (colTableIndex - s.nodeIndex - 1) >>> 0
    const hiState = { hi: CASC_INVALID_INDEX }
    while (this.collisionTable.isItemPresent(colTableIndex)) {
      if (this.isPathFragmentString(s.nodeIndex)) {
        const fragmentOffset = this.getPathFragmentOffset2(hiState, s.nodeIndex)
        const savePathLength = s.pathLength
        if (this.childDb) {
          if (this.childDb.comparePathFragmentByIndex(search, fragmentOffset)) return true
        } else {
          if (this.pathFragmentTable.comparePathFragment(search, fragmentOffset)) return true
        }
        if (s.pathLength !== savePathLength) return false
      } else {
        if (this.loBitsTable[s.nodeIndex] === search.mask[s.pathLength]) {
          s.pathLength++
          return true
        }
      }
      s.nodeIndex = (s.nodeIndex + 1) >>> 0
      colTableIndex = (colTableIndex + 1) >>> 0
    }
    return false
  }
  // HOTS: ComparePathFragmentByIndex
  comparePathFragmentByIndex(search, tableIndexArg) {
    const s = search.struct40
    let tableIndex = tableIndexArg >>> 0
    for (;;) {
      const e = this.hashTable[tableIndex & this.hashTableMask]
      if (tableIndex === e.nextIndex) {
        if (!this.isPathFragmentSingleChar(e)) {
          if (this.childDb) {
            if (!this.childDb.comparePathFragmentByIndex(search, e.fragmentOffset)) return false
          } else {
            if (!this.pathFragmentTable.comparePathFragment(search, e.fragmentOffset)) return false
          }
        } else {
          if (search.mask[s.pathLength] !== (e.fragmentOffset & 0xff)) return false
          s.pathLength++
        }
        tableIndex = e.nodeIndex
        if (tableIndex === 0) return true
        if (s.pathLength >= search.cchSearchMask) return false
      } else {
        if (this.isPathFragmentString(tableIndex)) {
          const fragmentOffset = this.getPathFragmentOffset1(tableIndex)
          if (this.childDb) {
            if (!this.childDb.comparePathFragmentByIndex(search, fragmentOffset)) return false
          } else {
            if (!this.pathFragmentTable.comparePathFragment(search, fragmentOffset)) return false
          }
        } else {
          if (this.loBitsTable[tableIndex] !== search.mask[s.pathLength]) return false
          s.pathLength++
        }
        if (tableIndex <= this.field214) return true
        if (s.pathLength >= search.cchSearchMask) return false
        const eax = this.collisionTable.getItem1(tableIndex)
        tableIndex = (eax - tableIndex - 1) >>> 0
      }
    }
  }
  // HOTS: CopyPathFragmentByIndex
  copyPathFragmentByIndex(search, tableIndexArg) {
    const s = search.struct40
    let tableIndex = tableIndexArg >>> 0
    for (;;) {
      const e = this.hashTable[tableIndex & this.hashTableMask]
      if (tableIndex === e.nextIndex) {
        if (!this.isPathFragmentSingleChar(e)) {
          if (this.childDb) this.childDb.copyPathFragmentByIndex(search, e.fragmentOffset)
          else this.pathFragmentTable.copyPathFragment(search, e.fragmentOffset)
        } else {
          s.pathBuffer.push(e.fragmentOffset & 0xff)
        }
        tableIndex = e.nodeIndex
        if (tableIndex === 0) return
      } else {
        if (this.isPathFragmentString(tableIndex)) {
          const fragmentOffset = this.getPathFragmentOffset1(tableIndex)
          if (this.childDb) this.childDb.copyPathFragmentByIndex(search, fragmentOffset)
          else this.pathFragmentTable.copyPathFragment(search, fragmentOffset)
        } else {
          s.pathBuffer.push(this.loBitsTable[tableIndex])
        }
        if (tableIndex <= this.field214) return
        tableIndex = (0xffffffff - tableIndex + this.collisionTable.getItem1(tableIndex)) >>> 0
      }
    }
  }
  // HOTS: CompareAndCopyPathFragment
  compareAndCopyPathFragment(search) {
    const s = search.struct40
    const tableIndex = s.calcHashValue(search.mask) & this.hashTableMask
    const e = this.hashTable[tableIndex]
    if (s.nodeIndex === e.nodeIndex) {
      if (!this.isPathFragmentSingleChar(e)) {
        if (this.childDb) {
          if (!this.childDb.compareAndCopyPathFragmentByIndex(search, e.fragmentOffset))
            return false
        } else {
          if (!this.pathFragmentTable.compareAndCopyPathFragment(search, e.fragmentOffset))
            return false
        }
      } else {
        s.pathBuffer.push(e.fragmentOffset & 0xff)
        s.pathLength++
      }
      s.nodeIndex = e.nextIndex
      return true
    }
    let colTableIndex = (this.collisionTable.getItem0(s.nodeIndex) + 1) >>> 0
    s.nodeIndex = (colTableIndex - s.nodeIndex - 1) >>> 0
    const hiState = { hi: CASC_INVALID_INDEX }
    while (this.collisionTable.isItemPresent(colTableIndex)) {
      if (this.isPathFragmentString(s.nodeIndex)) {
        const fragmentOffset = this.getPathFragmentOffset2(hiState, s.nodeIndex)
        const savePathLength = s.pathLength
        if (this.childDb) {
          if (this.childDb.compareAndCopyPathFragmentByIndex(search, fragmentOffset)) return true
        } else {
          if (this.pathFragmentTable.compareAndCopyPathFragment(search, fragmentOffset)) return true
        }
        if (savePathLength !== s.pathLength) return false
      } else {
        if (this.loBitsTable[s.nodeIndex] === search.mask[s.pathLength]) {
          s.pathBuffer.push(this.loBitsTable[s.nodeIndex])
          s.pathLength++
          return true
        }
      }
      s.nodeIndex = (s.nodeIndex + 1) >>> 0
      colTableIndex = (colTableIndex + 1) >>> 0
    }
    return false
  }
  // HOTS: CompareAndCopyPathFragmentByIndex
  compareAndCopyPathFragmentByIndex(search, tableIndexArg) {
    const s = search.struct40
    let tableIndex = tableIndexArg >>> 0
    for (;;) {
      const e = this.hashTable[tableIndex & this.hashTableMask]
      if (tableIndex === e.nextIndex) {
        if (!this.isPathFragmentSingleChar(e)) {
          if (this.childDb) {
            if (!this.childDb.compareAndCopyPathFragmentByIndex(search, e.fragmentOffset))
              return false
          } else {
            if (!this.pathFragmentTable.compareAndCopyPathFragment(search, e.fragmentOffset))
              return false
          }
        } else {
          if ((e.fragmentOffset & 0xff) !== search.mask[s.pathLength]) return false
          s.pathBuffer.push(e.fragmentOffset & 0xff)
          s.pathLength++
        }
        tableIndex = e.nodeIndex
        if (tableIndex === 0) return true
      } else {
        if (this.isPathFragmentString(tableIndex)) {
          const fragmentOffset = this.getPathFragmentOffset1(tableIndex)
          if (this.childDb) {
            if (!this.childDb.compareAndCopyPathFragmentByIndex(search, fragmentOffset))
              return false
          } else {
            if (!this.pathFragmentTable.compareAndCopyPathFragment(search, fragmentOffset))
              return false
          }
        } else {
          if (this.loBitsTable[tableIndex] !== search.mask[s.pathLength]) return false
          s.pathBuffer.push(this.loBitsTable[tableIndex])
          s.pathLength++
        }
        if (tableIndex <= this.field214) return true
        tableIndex = (0xffffffff - tableIndex + this.collisionTable.getItem1(tableIndex)) >>> 0
      }
      if (s.pathLength >= search.cchSearchMask) break
    }
    this.copyPathFragmentByIndex(search, tableIndex)
    return true
  }
  // HOTS: DoSearch — stateful enumeration; returns one result per call, false at end.
  doSearch(search) {
    const s = search.struct40
    if (s.searchPhase === MNDX_SEARCH_INITIALIZING) {
      s.beginSearch()
      while (s.pathLength < search.cchSearchMask) {
        if (!this.compareAndCopyPathFragment(search)) {
          s.searchPhase = MNDX_SEARCH_FINISHED
          return false
        }
      }
      s.pathStops.push(newPathStop(s.nodeIndex, 0, s.pathBuffer.length))
      s.itemCount = 1
      if (this.fileNameIndexes.isItemPresent(s.nodeIndex)) {
        search.szFoundPath = s.pathBuffer.slice()
        search.cchFoundPath = s.pathBuffer.length
        search.nIndex = this.fileNameIndexes.getItemValueAt(s.nodeIndex)
        return true
      }
      s.searchPhase = MNDX_SEARCH_SEARCHING
    }
    if (s.searchPhase === MNDX_SEARCH_SEARCHING) {
      for (;;) {
        if (s.itemCount === s.pathStops.length) {
          const last = s.pathStops[s.pathStops.length - 1]
          const colTableIndex = (this.collisionTable.getItem0(last.loBitsIndex) + 1) >>> 0
          s.pathStops.push(
            newPathStop((colTableIndex - last.loBitsIndex - 1) >>> 0, colTableIndex, 0),
          )
        }
        const stop = s.pathStops[s.itemCount]
        if (this.collisionTable.isItemPresent(stop.field4++)) {
          s.itemCount++
          if (this.isPathFragmentString(stop.loBitsIndex)) {
            const hiState = { hi: stop.hiBitsIndexPathFragment }
            const fragmentOffset = this.getPathFragmentOffset2(hiState, stop.loBitsIndex)
            stop.hiBitsIndexPathFragment = hiState.hi
            if (this.childDb) this.childDb.copyPathFragmentByIndex(search, fragmentOffset)
            else this.pathFragmentTable.copyPathFragment(search, fragmentOffset)
          } else {
            s.pathBuffer.push(this.loBitsTable[stop.loBitsIndex])
          }
          stop.count = s.pathBuffer.length
          if (this.fileNameIndexes.isItemPresent(stop.loBitsIndex)) {
            if (stop.field10 === 0xffffffff)
              stop.field10 = this.fileNameIndexes.getItemValueAt(stop.loBitsIndex)
            else stop.field10++
            search.szFoundPath = s.pathBuffer.slice()
            search.cchFoundPath = s.pathBuffer.length
            search.nIndex = stop.field10
            return true
          }
        } else {
          if (s.itemCount === 1) {
            s.searchPhase = MNDX_SEARCH_FINISHED
            return false
          }
          s.pathStops[s.itemCount - 1].loBitsIndex++
          const edi = s.pathStops[s.itemCount - 2].count
          s.pathBuffer.length = edi
          s.itemCount--
        }
      }
    }
    return false
  }
}
/**
 * A parsed MNDX root: every file path with its content key, stored as columns.
 *
 * An installed StarCraft II root names ~666k files, so the table itself is the memory problem —
 * see {@link CascPathIndex}. This class only knows how to fill one from the MAR trie.
 */
export class MndxNameDb extends CascPathIndex {
  static parse(rootData) {
    return loadMndx(rootData).build(this)
  }
  /** Build from plain records (the on-disk cache path, tests, and hand-made roots). */
  static fromEntries(files) {
    return this.fromFiles(files)
  }
}

// A variable specifier, so a browser bundle does not try to resolve it.
const NODE_WORKER_THREADS = 'node:worker_threads'

/** Whether this realm is Node's main thread, where a long parse stalls everything else in it. */
export async function onNodeMainThread() {
  try {
    return (await import(NODE_WORKER_THREADS)).isMainThread === true
  } catch {
    return false
  }
}

/**
 * Parse an MNDX root in a worker thread (`mndx-thread.js`). An installed StarCraft II root takes
 * ~1 s of JavaScript to parse; the calling thread only copies the root in and maps the finished
 * index out. Rejects when the realm has no worker threads or the parse fails — the caller still
 * holds the root and can parse in place.
 */
export async function parseMndxInThread(rootBytes) {
  const { Worker } = await import(NODE_WORKER_THREADS)
  const worker = new Worker(new URL('./mndx-thread.js', import.meta.url))
  try {
    const answer = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error(`MNDX parse thread exited with code ${code}`)))
      const copy = rootBytes.slice()
      worker.postMessage(copy, [copy.buffer])
    })
    if (answer.error !== undefined) throw new Error(answer.error)
    return MndxNameDb.deserialize(answer.index)
  } finally {
    await worker.terminate()
  }
}

function loadMndx(root) {
  const dv = new DataView(root.buffer, root.byteOffset, root.byteLength)
  const u32 = o => dv.getUint32(o, true) >>> 0
  // FILE_MNDX_HEADER
  if (u32(0) !== MNDX_ROOT_SIGNATURE) throw new Error('MNDX root is missing MNDX signature')
  const headerVersion = u32(4)
  const formatVersion = u32(8)
  if (formatVersion < 1 || formatVersion > 2)
    throw new Error(`MNDX root: unsupported format version ${formatVersion}`)
  // FILE_MNDX_INFO: header (12) + optional 8 bytes (v2) + 7 DWORDs (0x1C)
  let p = 12
  if (headerVersion === 2) p += 8
  const marInfoOffset = u32(p)
  const marInfoCount = u32(p + 4)
  const marInfoSize = u32(p + 8)
  const ckeyEntriesOffset = u32(p + 12)
  const ckeyEntriesCount = u32(p + 16)
  const fileNameCount = u32(p + 20)
  const ckeyEntrySize = u32(p + 24)
  if (marInfoCount > MAR_COUNT || marInfoSize !== 20)
    throw new Error('MNDX root: bad MAR info table')
  if (ckeyEntrySize !== 24) throw new Error('MNDX root: unexpected CKey entry size')
  // Load the MAR name databases
  const marDatabases = []
  for (let i = 0; i < marInfoCount; i++) {
    const o = marInfoOffset + marInfoSize * i
    const info = { marIndex: u32(o), dataSize: u32(o + 4), dataOffset: u32(o + 12) }
    marDatabases[i] = FileNameDatabase.loadMar(
      root.subarray(info.dataOffset, info.dataOffset + info.dataSize),
    )
  }
  if (marDatabases.length !== MAR_COUNT)
    throw new Error('MNDX root: all three MAR files are required')
  // CKey entries (each MNDX_CKEY_ENTRY: Flags(4), CKey(16), ContentSize(4)) stay in the root
  // bytes; an installed SC2 root holds ~666k of them, and one object with a hex key per entry
  // was a large part of what put the archive worker over its heap cap.
  const ckeyEntryOffset = i => ckeyEntriesOffset + i * ckeyEntrySize
  // Map file-name index → first CKey entry index of that name group
  const fileNameIndexToCKeyIndex = new Array(fileNameCount + 1)
  let nFileNameIndex = 0
  fileNameIndexToCKeyIndex[nFileNameIndex++] = 0
  for (let i = 0; i < ckeyEntriesCount; i++) {
    if (nFileNameIndex > fileNameCount) break
    if (u32(ckeyEntryOffset(i)) & MNDX_LAST_CKEY_ENTRY)
      fileNameIndexToCKeyIndex[nFileNameIndex++] = i + 1
  }
  if (nFileNameIndex - 1 !== fileNameCount) {
    throw new Error(`MNDX root: CKey grouping mismatch (${nFileNameIndex - 1} != ${fileNameCount})`)
  }
  // Package names from MAR file 0
  const packages = loadPackageNames(marDatabases[MAR_PACKAGE_NAMES])
  // Enumerate stripped names (MAR file 1); each name index → group of CKey entries,
  // one per package. Full path = "<package>/<stripped name>".
  const strippedDb = marDatabases[MAR_STRIPPED_NAMES]
  if (strippedDb.fileNameValidCount !== fileNameCount) {
    throw new Error('MNDX root: stripped-name DB file count mismatch')
  }
  void MAR_FULL_NAMES // full-names DB is loaded/validated but enumeration uses stripped + packages
  // Paths are assembled as bytes ("<package>/<stripped name>") straight into the index builder:
  // the trie hands out the name as bytes, so no path string is created per file.
  const packageBytes = packages.map(name =>
    name === undefined ? undefined : new TextEncoder().encode(name),
  )
  const builder = new CascPathIndexBuilder()
  let path = new Uint8Array(1024)
  const search = new MndxSearch(new Uint8Array(0))
  while (strippedDb.doSearch(search)) {
    if (search.nIndex >= fileNameCount) continue
    const name = search.szFoundPath
    const nameLength = search.cchFoundPath
    for (let i = fileNameIndexToCKeyIndex[search.nIndex]; i < ckeyEntriesCount; i++) {
      const o = ckeyEntryOffset(i)
      const flags = u32(o)
      const packageIndex = flags & 0x00ffffff
      const pkg = packageBytes[packageIndex]
      if (pkg !== undefined) {
        const length = pkg.length + 1 + nameLength
        if (path.length < length) path = new Uint8Array(length * 2)
        path.set(pkg, 0)
        path[pkg.length] = 0x2f // '/'
        for (let k = 0; k < nameLength; k++) path[pkg.length + 1 + k] = name[k]
        builder.add(path, length, root, o + 4, u32(o + 20), packageIndex)
      }
      if (flags & MNDX_LAST_CKEY_ENTRY) break
    }
  }
  return builder
}
function loadPackageNames(db) {
  const packages = []
  const search = new MndxSearch(new Uint8Array(0))
  while (db.doSearch(search)) {
    packages[search.nIndex] = decodeBytes(search.szFoundPath, search.cchFoundPath)
  }
  return packages
}
function decodeBytes(bytes, length) {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[i])
  return out
}
