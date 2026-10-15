import { describe, expect, it } from 'vitest'
import { getActiveBuild, parseBuildInfo } from '../../src/casc/config.js'
import { isWowRoot, wowLocaleFlag, wowRootFiles } from '../../src/casc/wow-root.js'

const EN_US = 0x2
const RU_RU = 0x2000

interface Block { ids: number[]; locale: number; content?: number; key: number; names?: boolean }

/** A 10.1.7+ root (`TSFM`, header size 24, version 2); the content key of record `i` is `key + i` repeated. */
function wowRoot(blocks: Block[], { total = 0, named = 0 } = {}): Uint8Array {
  const parts: number[] = []
  const u32 = (value: number) => parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24)
  u32(0x4d465354); u32(24); u32(2); u32(total); u32(named); u32(0)
  for (const block of blocks) {
    u32(block.ids.length); u32(block.locale); u32(block.content ?? 0); u32(0); parts.push(0)
    block.ids.forEach((id, i) => u32(id - (i === 0 ? 0 : block.ids[i - 1]! + 1)))
    block.ids.forEach((_, i) => parts.push(...new Array<number>(16).fill(block.key + i)))
    if (block.names !== false) block.ids.forEach(() => parts.push(...new Array<number>(8).fill(0xee)))
  }
  return Uint8Array.from(parts)
}

describe('World of Warcraft root', () => {
  it('lists each FileDataID once, in the variant the client of its locale loads', () => {
    const root = wowRoot([
      { ids: [5], locale: EN_US, key: 0x10 },
      { ids: [5], locale: RU_RU, key: 0x20 },
      { ids: [9], locale: 0xffffffff, content: 0x80, key: 0x30 }, // the low-violence cut
      { ids: [9], locale: 0xffffffff, key: 0x38 },
      { ids: [12], locale: 0xffffffff, content: 0x10000000, key: 0x40, names: false },
    ], { total: 3, named: 2 })
    expect(isWowRoot(root)).toBe(true)
    const files = wowRootFiles(root, wowLocaleFlag('ruRU'))
    expect([...files.fileDataIds]).toEqual([5, 9, 12])
    expect([...files.contentKeyOffsets].map(at => root[at])).toEqual([0x20, 0x38, 0x40])
    const english = wowRootFiles(root, wowLocaleFlag('enUS'))
    expect([...english.contentKeyOffsets].map(at => root[at])).toEqual([0x10, 0x38, 0x40])
  })

  it('refuses a block that runs past the root', () => {
    const root = wowRoot([{ ids: [1, 2], locale: EN_US, key: 1 }])
    expect(() => wowRootFiles(root.subarray(0, root.length - 4), EN_US)).toThrow(/extends beyond/u)
  })

  it('opens one of several products a folder holds', () => {
    const info = parseBuildInfo([
      'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|CDN Path!STRING:0|Product!STRING:0',
      'eu|1|00000000000000000000000000000001|00|tpr/wow|wow',
      'eu|1|00000000000000000000000000000002|00|tpr/wow|wow_classic',
    ].join('\n'))
    expect(getActiveBuild(info).buildKey).toBe('00000000000000000000000000000001')
    expect(getActiveBuild(info, 'wow_classic').buildKey).toBe('00000000000000000000000000000002')
    expect(() => getActiveBuild(info, 'wow_beta')).toThrow(/no active wow_beta/u)
  })
})
