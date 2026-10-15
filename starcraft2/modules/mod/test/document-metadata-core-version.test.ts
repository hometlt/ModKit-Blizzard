import { describe, expect, it } from 'vitest'
import {
  parseVersionFile,
  resolveTypeTag,
  typeTagFor,
  typeTagForVersionPath,
  TYPE_TAG_MAP,
  writeVersionFile,
} from '../../../dist/modules/mod/codecs/document-metadata/core/index.js'

function u32(buffer: Uint8Array, offset: number): number {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(offset, true)
}

describe('.version file codec', () => {
  it('writes and parses v2 using build/version/entry/timestamp fields', () => {
    const vf = writeVersionFile({
      typeTag: 'adag',
      buildNumber: 91115,
      majorVersion: 5,
      minorVersion: 0,
      patchVersion: 13,
      entryCount: 42847,
      timestamp: 1712345678,
    })

    expect(vf.length).toBe(44)
    expect(u32(vf, 0x08)).toBe(2)
    expect(u32(vf, 0x0C)).toBe(91115)
    expect(u32(vf, 0x10)).toBe(5)
    expect(u32(vf, 0x14)).toBe(0)
    expect(u32(vf, 0x18)).toBe(13)
    expect(u32(vf, 0x1C)).toBe(91115)
    expect(u32(vf, 0x20)).toBe(42847)
    expect(u32(vf, 0x24)).toBe(1712345678)
    expect(u32(vf, 0x28)).toBe(1)

    const parsed = parseVersionFile(vf)!
    expect(parsed).toMatchObject({
      typeTag: 'adag',
      formatVersion: 2,
      buildNumber: 91115,
      majorVersion: 5,
      minorVersion: 0,
      patchVersion: 13,
      buildNumber2: 91115,
      entryCount: 42847,
      timestamp: 1712345678,
      terminal: 1,
      bytesConsumed: 44,
    })
  })

  it('writes and parses v1 without buildNumber2', () => {
    const vf = writeVersionFile({
      typeTag: 'ofni',
      formatVersion: 1,
      buildNumber: 20727,
      majorVersion: 1,
      minorVersion: 4,
      patchVersion: 3,
      entryCount: 18,
      timestamp: 1320000000,
    })

    expect(vf.length).toBe(40)
    expect(u32(vf, 0x08)).toBe(1)
    expect(u32(vf, 0x18)).toBe(3)
    expect(u32(vf, 0x1C)).toBe(18)
    expect(u32(vf, 0x20)).toBe(1320000000)
    expect(u32(vf, 0x24)).toBe(1)

    const parsed = parseVersionFile(vf)!
    expect(parsed.formatVersion).toBe(1)
    expect(parsed.buildNumber2).toBe(0)
    expect(parsed.entryCount).toBe(18)
    expect(parsed.timestamp).toBe(1320000000)
  })

  it('writes and parses v0 without patch, buildNumber2, or entryCount', () => {
    const vf = writeVersionFile({
      typeTag: 'adag',
      formatVersion: 0,
      buildNumber: 13636,
      majorVersion: 0,
      minorVersion: 1,
      timestamp: 1264291200,
    })

    expect(vf.length).toBe(36)
    expect(u32(vf, 0x08)).toBe(0)
    expect(u32(vf, 0x18)).toBe(1264291200)
    expect(u32(vf, 0x1C)).toBe(0)

    const parsed = parseVersionFile(vf)!
    expect(parsed.formatVersion).toBe(0)
    expect(parsed.patchVersion).toBe(0)
    expect(parsed.buildNumber2).toBe(0)
    expect(parsed.entryCount).toBe(0)
    expect(parsed.terminal).toBe(0)
  })

  it('returns null for an empty sidecar', () => {
    expect(parseVersionFile(new Uint8Array(0))).toBeNull()
  })

  it('throws on an unexpected fixed record size', () => {
    expect(() => parseVersionFile(new Uint8Array(42))).toThrow('unexpected size')
  })

  it('throws on a bad prefix', () => {
    const buf = writeVersionFile({ typeTag: 'girt', buildNumber: 95841 })
    buf.set([0x48, 0x32, 0x43, 0x53], 0) // "H2CS"
    expect(() => parseVersionFile(buf)).toThrow('bad prefix')
  })

  it('throws when the embedded format version does not match the fixed size', () => {
    const buf = writeVersionFile({ typeTag: 'girt', buildNumber: 95841 })
    new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(0x08, 1, true)
    expect(() => parseVersionFile(buf)).toThrow('requires 40 bytes')
  })

  it('keeps deprecated aliases mapped to the corrected fields', () => {
    const parsed = parseVersionFile(writeVersionFile({
      typeTag: 'ipam',
      buildNumber: 95000,
      majorVersion: 5,
      minorVersion: 0,
      patchVersion: 13,
      buildNumber2: 96000,
      entryCount: 3,
      timestamp: 0x65ff1280,
    }))!

    expect(parsed.buildCreated).toBe(parsed.buildNumber)
    expect(parsed.unknown1).toBe(parsed.majorVersion)
    expect(parsed.unknown2).toBe(parsed.minorVersion)
    expect(parsed.schemaVersion).toBe(parsed.patchVersion)
    expect(parsed.buildLastSaved).toBe(parsed.buildNumber2)
    expect(parsed.changeCount).toBe(parsed.entryCount)
    expect(parsed.contentHash).toBe(parsed.timestamp)
  })

  it('accepts legacy write field names as compatibility aliases', () => {
    const parsed = parseVersionFile(writeVersionFile({
      typeTag: 'txet',
      buildCreated: 88500,
      unknown1: 5,
      unknown2: 0,
      schemaVersion: 13,
      buildLastSaved: 95841,
      changeCount: 6,
      contentHash: 1712345678,
    }))!

    expect(parsed.buildNumber).toBe(88500)
    expect(parsed.patchVersion).toBe(13)
    expect(parsed.buildNumber2).toBe(95841)
    expect(parsed.entryCount).toBe(6)
    expect(parsed.timestamp).toBe(1712345678)
  })

  it('can infer the type tag from a file type name', () => {
    const parsed = parseVersionFile(writeVersionFile({
      fileType: 'MapInfo',
      buildNumber: 95000,
    }))!

    expect(parsed.typeTag).toBe('ipam')
  })

  it('can infer the type tag from a ComponentList FourCC', () => {
    const parsed = parseVersionFile(writeVersionFile({
      fileType: 'trig',
      buildNumber: 95000,
    }))!

    expect(parsed.typeTag).toBe('girt')
  })

  it('can infer the type tag from an archive version path', () => {
    const parsed = parseVersionFile(writeVersionFile({
      versionPath: 'Base.SC2Data/UI/Layout/DescIndex.version',
      buildNumber: 95000,
    }))!

    expect(parsed.typeTag).toBe('iuiu')
  })

  it('rejects unknown writer component identifiers', () => {
    expect(() => writeVersionFile({ fileType: 'Unknown', buildNumber: 1 })).toThrow('provide typeTag')
  })

  it('validates terminal against the editor serializer range', () => {
    expect(() => writeVersionFile({
      typeTag: 'girt',
      buildNumber: 1,
      terminal: 1_000_001,
    })).toThrow('terminal must be between 0 and 1000000')
  })
})

describe('.version type tags', () => {
  it('resolves known raw tags', () => {
    expect(resolveTypeTag('ofni')).toBe('DocumentInfo')
    expect(resolveTypeTag('adag')).toBe('GameData')
    expect(resolveTypeTag('txet')).toBe('GameText')
    expect(resolveTypeTag('rtta')).toBe('Attributes')
    expect(resolveTypeTag('iuiu')).toBe('DescIndex')
    expect(resolveTypeTag('stuc')).toBe('Index')
    expect(resolveTypeTag('tnof')).toBe('FontStyles')
    expect(resolveTypeTag('ipam')).toBe('MapInfo')
    expect(resolveTypeTag('rret')).toBe('t3Terrain')
    expect(resolveTypeTag('bolp')).toBe('Objects')
    expect(resolveTypeTag('iger')).toBe('Regions')
    expect(resolveTypeTag('girt')).toBe('Triggers')
    expect(resolveTypeTag('iaia')).toBe('CustomAI')
    expect(resolveTypeTag('xxxx')).toBeUndefined()
  })

  it('looks up raw tags by file type name', () => {
    expect(typeTagFor('Triggers')).toBe('girt')
    expect(typeTagFor('GameData')).toBe('adag')
    expect(typeTagFor('MapInfo')).toBe('ipam')
    expect(typeTagFor('Index (cutscenes)')).toBe('stuc')
    expect(typeTagFor('trig')).toBe('girt')
    expect(typeTagFor('mapi')).toBe('ipam')
    expect(typeTagFor('text')).toBe('txet')
    expect(typeTagFor('Unknown')).toBeUndefined()
  })

  it('looks up raw tags by version path', () => {
    expect(typeTagForVersionPath('MapInfo.version')).toBe('ipam')
    expect(typeTagForVersionPath('Base.SC2Data/UI/Layout/DescIndex.version')).toBe('iuiu')
    expect(typeTagForVersionPath('Base.SC2Data/Cutscenes/Index.version')).toBe('stuc')
    expect(typeTagForVersionPath('Unknown.version')).toBeUndefined()
  })

  it('preserves the known observed tag table', () => {
    expect(Object.keys(TYPE_TAG_MAP).sort()).toEqual([
      'adag',
      'bolp',
      'girt',
      'iaia',
      'iger',
      'ipam',
      'iuiu',
      'ofni',
      'rret',
      'rtta',
      'stuc',
      'tnof',
      'txet',
    ])
  })
})
