import { bytesToHex, hexToBytes, readUintBE, sliceExact } from './binary.js'

/**
 * The content-key → encoding-key table of a CASC build, as columns.
 *
 * The ENCODING file of an installed StarCraft II is 44 MB decoded, and a reader used to keep all
 * of it: the content-key pages it answers from, and the encoding-spec pages after them that no
 * read ever consults. Only what a lookup needs is kept here — the sorted content keys, each one's
 * first encoding key and its size (~29 MB for 722k entries). A content key with more than one
 * encoding key (rare; CASC reads the first, as CascLib does) keeps the rest in a side map.
 */
export class EncodingTable {
  constructor(count, contentKeyLength, encodingKeyLength, contentKeys, encodingKeys, sizes, more) {
    this.count = count
    this.contentKeyLength = contentKeyLength
    this.encodingKeyLength = encodingKeyLength
    this.contentKeys = contentKeys
    this.encodingKeys = encodingKeys
    this.sizes = sizes
    this.more = more
  }
  get size() {
    return this.count
  }
  get(contentKey) {
    const index = this.indexOf(contentKey)
    if (index === -1) return undefined
    return {
      contentKey: this.hexAt(this.contentKeys, this.contentKeyLength, index),
      encodingKeys: [
        this.hexAt(this.encodingKeys, this.encodingKeyLength, index),
        ...(this.more.get(index) ?? []),
      ],
      size: this.sizes[index],
    }
  }
  getEncodingKey(contentKey) {
    const index = this.indexOf(contentKey)
    return index === -1 ? undefined : this.hexAt(this.encodingKeys, this.encodingKeyLength, index)
  }
  has(contentKey) {
    return this.indexOf(contentKey) !== -1
  }
  hexAt(column, width, index) {
    return bytesToHex(column.subarray(index * width, (index + 1) * width))
  }
  /** Row of the content key at `bytes[at..]`, or -1 — no hex on the way, for scans of every file. */
  indexOfBytes(bytes, at) {
    const width = this.contentKeyLength
    const keys = this.contentKeys
    let low = 0
    let high = this.count
    while (low < high) {
      const middle = (low + high) >>> 1
      let difference = 0
      for (let i = 0, row = middle * width; i < width && difference === 0; i++) {
        difference = keys[row + i] - bytes[at + i]
      }
      if (difference === 0) return middle
      if (difference < 0) low = middle + 1
      else high = middle
    }
    return -1
  }
  /** Row of `contentKey` (hex, any case), or -1. */
  indexOf(contentKey) {
    const clean = contentKey.trim().toLowerCase()
    const width = this.contentKeyLength
    if (clean.length !== width * 2) return -1
    const needle = hexToBytes(clean)
    const keys = this.contentKeys
    let low = 0
    let high = this.count
    while (low < high) {
      const middle = (low + high) >>> 1
      let difference = 0
      for (let i = 0, at = middle * width; i < width && difference === 0; i++) {
        difference = keys[at + i] - needle[i]
      }
      if (difference === 0) return middle
      if (difference < 0) low = middle + 1
      else high = middle
    }
    return -1
  }
}

/**
 * Where the content-key pages of an ENCODING file end, from its first 22 bytes (`undefined` while
 * fewer are read): all {@link parseEncodingTable} reads. The encoding-key pages and specs after
 * them are most of a large file and are never consulted.
 */
export function encodingPagesEnd(head) {
  if (head.length < 22) return undefined
  if (head[0] !== 0x45 || head[1] !== 0x4e) throw new Error('CASC encoding file is missing EN magic')
  const pageSize = readUintBE(head, 5, 2) * 1024
  const pageCount = readUintBE(head, 9, 4)
  return 22 + readUintBE(head, 18, 4) + pageCount * (head[3] + 16) + pageCount * pageSize
}

/**
 * Read the content-key pages of an ENCODING file into an {@link EncodingTable}. The pages are
 * sorted by content key (the page index names each page's first key), so the columns come out
 * sorted and a lookup is one binary search.
 */
export function parseEncodingTable(data) {
  if (data.length < 22 || data[0] !== 0x45 || data[1] !== 0x4e) {
    throw new Error('CASC encoding file is missing EN magic')
  }
  const contentKeyLength = data[3]
  const encodingKeyLength = data[4]
  if (contentKeyLength <= 0 || encodingKeyLength <= 0) {
    throw new Error('CASC encoding file has invalid key lengths')
  }
  const pageSize = readUintBE(data, 5, 2) * 1024
  if (pageSize <= 0) throw new Error('CASC encoding file has invalid page size')
  const pageCount = readUintBE(data, 9, 4)
  const eSpecBlockSize = readUintBE(data, 18, 4)
  const pagesStart = 22 + eSpecBlockSize + pageCount * (contentKeyLength + 16)
  if (pagesStart > data.length) throw new Error('CASC encoding page index extends beyond buffer')

  // Each page entry: key count (1), content size (5, big-endian), content key, encoding keys.
  const forEachEntry = visit => {
    for (let page = 0; page < pageCount; page++) {
      let offset = pagesStart + page * pageSize
      if (offset > data.length) throw new Error('CASC encoding page extends beyond buffer')
      const end = Math.min(offset + pageSize, data.length)
      while (offset + 6 <= end) {
        const keyCount = data[offset]
        if (keyCount === 0) break
        const entryLength = 6 + contentKeyLength + keyCount * encodingKeyLength
        if (offset + entryLength > end) throw new Error('CASC encoding table ended inside a page entry')
        visit(offset, keyCount)
        offset += entryLength
      }
    }
  }
  let count = 0
  forEachEntry(() => count++)
  const contentKeys = new Uint8Array(count * contentKeyLength)
  const encodingKeys = new Uint8Array(count * encodingKeyLength)
  const sizes = new Float64Array(count)
  const more = new Map()
  let row = 0
  forEachEntry((offset, keyCount) => {
    sizes[row] = data[offset + 1] * 2 ** 32 + readUintBE(data, offset + 2, 4)
    const keyAt = offset + 6
    for (let i = 0; i < contentKeyLength; i++) {
      contentKeys[row * contentKeyLength + i] = data[keyAt + i]
    }
    const encodingAt = keyAt + contentKeyLength
    for (let i = 0; i < encodingKeyLength; i++) {
      encodingKeys[row * encodingKeyLength + i] = data[encodingAt + i]
    }
    if (keyCount > 1) {
      const rest = []
      for (let k = 1; k < keyCount; k++) {
        rest.push(
          bytesToHex(
            sliceExact(data, encodingAt + k * encodingKeyLength, encodingKeyLength, 'CASC encoding key'),
          ),
        )
      }
      more.set(row, rest)
    }
    row++
  })
  return new EncodingTable(
    count,
    contentKeyLength,
    encodingKeyLength,
    contentKeys,
    encodingKeys,
    sizes,
    more,
  )
}
export function contentKeyToBytes(contentKey) {
  return hexToBytes(contentKey)
}
