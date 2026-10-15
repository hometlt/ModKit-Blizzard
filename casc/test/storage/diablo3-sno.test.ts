import { describe, expect, it } from 'vitest'
import {
  DIABLO3_SNO_MAGIC,
  isDiablo3Sno,
  parseDiablo3Font,
  parseDiablo3SnoHeader,
  parseDiablo3TextureHeader,
} from '../../src/casc/diablo3-sno.js'

function snoFixture(version = 47, length = 0x270): Uint8Array {
  const bytes = new Uint8Array(length)
  const dv = new DataView(bytes.buffer)
  dv.setUint32(0, DIABLO3_SNO_MAGIC, true)
  dv.setUint32(4, version, true)
  dv.setInt32(0x10, -1234, true)
  dv.setUint32(0x1c, 0x20, true)
  return bytes
}

describe('Diablo III SNO headers', () => {
  it('identifies a SNO using its root-assigned asset extension', () => {
    const bytes = snoFixture()
    expect(isDiablo3Sno(bytes, 'Textures/Hero.tex')).toBe(true)
    expect(isDiablo3Sno(bytes, 'Actor/Hero.acr')).toBe(false)
    expect(isDiablo3Sno(bytes, 'unknown.bin')).toBe(false)
  })

  it('parses the common preamble and group information', () => {
    expect(parseDiablo3SnoHeader(snoFixture(), 'Textures/Hero.tex')).toMatchObject({
      magic: DIABLO3_SNO_MAGIC,
      version: 47,
      snoId: -1234,
      flags: 0x20,
      group: { assetIndex: 44, directory: 'Textures', extension: 'tex' },
      expectedVersion: 47,
      versionMatches: true,
    })
  })

  it('parses the v47 texture descriptor and active mip count', () => {
    const bytes = snoFixture()
    const dv = new DataView(bytes.buffer)
    dv.setUint32(0x20, 12, true)
    dv.setUint32(0x24, 512, true)
    dv.setUint32(0x28, 256, true)
    dv.setUint32(0x2c, 1, true)
    dv.setUint32(0x30, 2, true)
    dv.setUint32(0x34, 1, true)
    dv.setUint32(0x3c, 1024, true)
    dv.setUint32(0x44, 256, true)
    dv.setUint32(0x218, 3, true)
    dv.setUint32(0x21c, 0x280, true)
    dv.setUint32(0x220, 240, true)

    expect(parseDiablo3TextureHeader(bytes)).toEqual({
      pixelFormat: 12,
      width: 512,
      height: 256,
      depth: 1,
      flags: 2,
      extraMipCount: 1,
      mipCount: 2,
      frameCount: 3,
      frameTableOffset: 0x280,
      frameTableSize: 240,
    })
  })

  it('rejects truncated SNO data', () => {
    expect(() => parseDiablo3SnoHeader(new Uint8Array(12), 'Textures/Hero.tex')).toThrow(
      /truncated/,
    )
  })

  it.each([
    ['0000.otf', 'ExocetBlizzardOT-Light.otf', 'OTTO', 'opentype-cff'],
    ['0000.ttf', 'BlizzardGlobal.ttf', '\u0000\u0001\u0000\u0000', 'truetype'],
  ])('extracts an embedded %s payload from a v50 font SNO', (source, name, tag, kind) => {
    const bytes = snoFixture(50, 0xd8 + 16)
    const dv = new DataView(bytes.buffer)
    new TextEncoder().encodeInto(source, bytes.subarray(0x20, 0x60))
    new TextEncoder().encodeInto(name, bytes.subarray(0x60, 0xb8))
    dv.setUint32(0xb8, 0xc8, true)
    dv.setUint32(0xbc, 16, true)
    for (let index = 0; index < 4; index += 1) bytes[0xd8 + index] = tag.charCodeAt(index)

    const font = parseDiablo3Font(bytes, 'Font/Test.fnt')
    expect(font.sourceName).toBe(source)
    expect(font.embeddedName).toBe(name)
    expect(font.embeddedOffset).toBe(0xd8)
    expect(font.embeddedSize).toBe(16)
    expect(font.embeddedKind).toBe(kind)
    expect(font.header.group?.extension).toBe('fnt')
  })
})
