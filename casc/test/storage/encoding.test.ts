import { describe, expect, it } from 'vitest'
import { parseEncodingTable } from '../../src/casc/encoding.js'

function hex(hexString: string): number[] {
  return Array.from(hexString.matchAll(/[0-9a-f]{2}/gi), m => Number.parseInt(m[0], 16))
}

function be(value: number, size: number): number[] {
  const out = new Array<number>(size)
  for (let i = size - 1; i >= 0; i--) {
    out[i] = value & 0xff
    value >>>= 8
  }
  return out
}

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

interface FixtureEntry {
  contentKey: string
  encodingKeys: string[]
  size: number
}

function buildPage(entries: FixtureEntry[], pageSize: number): number[] {
  const bytes: number[] = []
  for (const entry of entries) {
    bytes.push(...le16(entry.encodingKeys.length), ...be(entry.size, 4), ...hex(entry.contentKey))
    for (const encodingKey of entry.encodingKeys) bytes.push(...hex(encodingKey))
  }
  bytes.push(0x00, 0x00)
  while (bytes.length < pageSize) bytes.push(0)
  return bytes
}

function buildEncodingTable(pages: FixtureEntry[][]): Uint8Array {
  const pageSizeKb = 1
  const pageSize = pageSizeKb * 1024
  const contentKeyLength = 16
  const encodingKeyLength = 16
  const header = [
    0x45,
    0x4e,
    0x01,
    contentKeyLength,
    encodingKeyLength,
    ...be(pageSizeKb, 2),
    0x00,
    0x04,
    ...be(pages.length, 4),
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...be(0, 4),
  ]
  const index = pages.flatMap(page => [
    ...hex(page[0]?.contentKey ?? '00000000000000000000000000000000'),
    ...new Array(16).fill(0),
  ])
  const pageBytes = pages.flatMap(page => buildPage(page, pageSize))
  return new Uint8Array([...header, ...index, ...pageBytes])
}

describe('encoding table parsing', () => {
  it('maps content keys to encoding keys lazily', () => {
    const contentKey = '00112233445566778899aabbccddeeff'
    const encodingKey = 'ffeeddccbbaa99887766554433221100'
    const table = parseEncodingTable(
      buildEncodingTable([[{ contentKey, encodingKeys: [encodingKey], size: 5 }]]),
    )

    expect(table.size).toBe(1)
    expect(table.getEncodingKey(contentKey)).toBe(encodingKey)
    expect(table.get(contentKey)).toEqual({ contentKey, encodingKeys: [encodingKey], size: 5 })
    expect(table.has(contentKey.toUpperCase())).toBe(true)
  })

  it('binary-searches the page index before scanning the target page', () => {
    const firstKey = '00112233445566778899aabbccddeeff'
    const secondKey = '80112233445566778899aabbccddeeff'
    const secondEncodingKey = '11223344556677889900aabbccddeeff'
    const table = parseEncodingTable(
      buildEncodingTable([
        [{ contentKey: firstKey, encodingKeys: ['ffeeddccbbaa99887766554433221100'], size: 1 }],
        [{ contentKey: secondKey, encodingKeys: [secondEncodingKey], size: 2 }],
      ]),
    )

    expect(table.getEncodingKey(secondKey)).toBe(secondEncodingKey)
    expect(table.size).toBe(2)
  })

  it('keeps every encoding key of a content key that has several, and reads the first', () => {
    const contentKey = '20112233445566778899aabbccddeeff'
    const encodingKeys = ['aa'.repeat(16), 'bb'.repeat(16)]
    const table = parseEncodingTable(
      buildEncodingTable([
        [
          { contentKey: '10112233445566778899aabbccddeeff', encodingKeys: ['cc'.repeat(16)], size: 1 },
          { contentKey, encodingKeys, size: 7 },
          { contentKey: '30112233445566778899aabbccddeeff', encodingKeys: ['dd'.repeat(16)], size: 3 },
        ],
      ]),
    )

    expect(table.get(contentKey)).toEqual({ contentKey, encodingKeys, size: 7 })
    expect(table.getEncodingKey(contentKey)).toBe(encodingKeys[0])
    expect(table.getEncodingKey('30112233445566778899aabbccddeeff')).toBe('dd'.repeat(16))
  })

  it('returns undefined for content keys outside the indexed ranges', () => {
    const table = parseEncodingTable(
      buildEncodingTable([
        [
          {
            contentKey: '40112233445566778899aabbccddeeff',
            encodingKeys: ['ffeeddccbbaa99887766554433221100'],
            size: 1,
          },
        ],
      ]),
    )

    expect(table.getEncodingKey('00112233445566778899aabbccddeeff')).toBeUndefined()
    expect(table.getEncodingKey('50112233445566778899aabbccddeeff')).toBeUndefined()
  })
})
