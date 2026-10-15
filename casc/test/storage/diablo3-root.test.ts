import { describe, expect, it } from 'vitest'
import {
  Diablo3NameDb,
  isDiablo3Root,
  parseDiablo3CoreToc,
  parseDiablo3Packages,
} from '../../src/casc/diablo3-root.js'

const ROOT_SIGNATURE = 0x8007d0c4
const SUBDIR_SIGNATURE = 0xeaf1fe87
const PACKAGES_SIGNATURE = 0xaabb0002
const CORE_HEADER_SIZE = 70 * 3 * 4 + 4

function key(byte: number): Uint8Array {
  return new Uint8Array(16).fill(byte)
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0').repeat(16)
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function text(value: string): Uint8Array {
  return new Uint8Array([...new TextEncoder().encode(value), 0])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function named(contentKey: Uint8Array, name: string): Uint8Array {
  return concat(contentKey, text(name))
}

function rootFixture(): Uint8Array {
  return concat(u32(ROOT_SIGNATURE), u32(1), named(key(1), 'Base'))
}

function subdirFixture(): Uint8Array {
  return concat(
    u32(SUBDIR_SIGNATURE),
    u32(1),
    key(4),
    u32(7),
    u32(1),
    key(5),
    u32(7),
    u32(2),
    u32(2),
    named(key(2), 'CoreTOC.dat'),
    named(key(3), 'Data_D3\\PC\\Misc\\Packages.dat'),
  )
}

function coreTocFixture(): Uint8Array {
  const out = new Uint8Array(CORE_HEADER_SIZE + 12 + 5)
  const view = new DataView(out.buffer)
  view.setUint32(44 * 4, 1, true)
  view.setUint32(70 * 4 + 44 * 4, 0, true)
  view.setUint32(CORE_HEADER_SIZE, 44, true)
  view.setUint32(CORE_HEADER_SIZE + 4, 7, true)
  view.setUint32(CORE_HEADER_SIZE + 8, 0, true)
  out.set(text('Hero'), CORE_HEADER_SIZE + 12)
  return out
}

function packagesFixture(): Uint8Array {
  return concat(
    u32(PACKAGES_SIGNATURE),
    u32(2),
    text('Textures\\Hero.tex'),
    text('Textures\\Hero\\0002.bin'),
  )
}

describe('Diablo III CASC root', () => {
  it('recognizes the Diablo III root signature', () => {
    expect(isDiablo3Root(rootFixture())).toBe(true)
    expect(isDiablo3Root(new Uint8Array(4))).toBe(false)
  })

  it('parses CoreTOC file-index names and Packages.dat extensions', () => {
    expect(parseDiablo3CoreToc(coreTocFixture()).get(7)).toEqual({
      assetIndex: 44,
      fileIndex: 7,
      name: 'Hero',
    })
    expect(parseDiablo3Packages(packagesFixture()).get('textures/hero')).toBe('Textures/Hero.tex')
  })

  it('builds named and indexed asset paths through content keys', async () => {
    const payloads = new Map([
      [hex(1), subdirFixture()],
      [hex(2), coreTocFixture()],
      [hex(3), packagesFixture()],
    ])
    const db = await Diablo3NameDb.parse(rootFixture(), async contentKey => {
      const bytes = payloads.get(contentKey)
      if (!bytes) throw new Error(`missing fixture key ${contentKey}`)
      return bytes
    })

    expect(db.getByPath('base/coretoc.dat')?.contentKey).toBe(hex(2))
    expect(db.getByPath('Textures/Hero.tex')).toMatchObject({
      contentKey: hex(4),
      kind: 'asset',
      assetIndex: 44,
      fileIndex: 7,
    })
    expect(db.getByPath('Textures/7.tex')?.path).toBe('Textures/Hero.tex')
    expect(db.getByPath('textures/hero/0002.bin')).toMatchObject({
      contentKey: hex(5),
      subIndex: 2,
    })
    expect(db.hasPrefix('textures')).toBe(true)
    expect(db.listPaths('Textures')).toEqual(['Hero.tex', 'Hero/0002.bin'])
  })

  it('rejects truncated directory records', async () => {
    await expect(
      Diablo3NameDb.parse(rootFixture().subarray(0, 8), async () => new Uint8Array()),
    ).rejects.toThrow(/named entry/)
  })
})
