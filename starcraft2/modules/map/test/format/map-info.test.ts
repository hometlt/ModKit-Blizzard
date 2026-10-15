import { describe, it, expect } from 'vitest'
import { readMapInfo, resizeMapInfo, writeMapInfo, mapInfoEditorTerrainContext,
  setMapInfoEditorTerrainContext } from '../../shared/format/formats/map-info.js'
import { Build } from './helpers.js'

/** MapInfo header + a body containing two null-terminated strings. */
function sample(): Uint8Array {
  return new Build()
    .ascii('IpaM') // "MapI" stored as a little-endian DWORD
    .u32(39) // version
    .u32(123) // unknown1
    .u32(0) // unknown2
    .u32(192) // width
    .u32(256) // height
    .ascii('Black').u8(0) // body string 1
    .ascii('MarSara').u8(0) // body string 2
    .bytes(0x01, 0x02, 0x03) // misc tail bytes
    .done()
}

function sampleWithBoundary(): Uint8Array {
  return new Build()
    .ascii('IpaM')
    .u32(39)
    .u32(123)
    .u32(0)
    .u32(192)
    .u32(256)
    .ascii('Black').u8(0)
    .ascii('MarSara').u8(0)
    .u32(16)
    .u32(24)
    .u32(176)
    .u32(232)
    .bytes(0xaa, 0xbb, 0xcc)
    .done()
}

describe('readMapInfo', () => {
  it('parses the reliable header fields', () => {
    const r = readMapInfo(sample())
    expect(r.version).toBe(39)
    expect(r.unknown1).toBe(123)
    expect(r.width).toBe(192)
    expect(r.height).toBe(256)
  })

  it('preserves the version-dependent body and surfaces strings', () => {
    const r = readMapInfo(sample())
    expect(r.strings).toContain('Black')
    expect(r.strings).toContain('MarSara')
    expect(r.body.length).toBeGreaterThan(0)
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('XapI').u32(39).u32(0).u32(0).u32(1).u32(1).done()
    expect(() => readMapInfo(bad)).toThrow(/bad magic/)
  })

  it('throws on truncated header', () => {
    expect(() => readMapInfo(sample().subarray(0, 18))).toThrow(/Truncated/)
  })
})

describe('writeMapInfo', () => {
  it('round-trips byte-exact', () => {
    const original = sample()
    expect(Array.from(writeMapInfo(readMapInfo(original)))).toEqual(Array.from(original))
  })

  it('allows editing width/height while preserving the body', () => {
    const r = readMapInfo(sample())
    r.width = 100
    r.height = 200
    const r2 = readMapInfo(writeMapInfo(r))
    expect(r2.width).toBe(100)
    expect(r2.height).toBe(200)
    expect(Array.from(r2.body)).toEqual(Array.from(r.body))
  })

  it('requires and verifies an explicit playable boundary when dimensions change', () => {
    const source = readMapInfo(sampleWithBoundary())
    expect(source.boundary).toEqual({ left: 16, bottom: 24, right: 176, top: 232 })
    expect(() => resizeMapInfo(source, 64, 96)).toThrow(/explicit playable boundary/u)
    const resized = resizeMapInfo(source, 64, 96, 'full-map')
    expect(resized).toMatchObject({
      width: 64,
      height: 96,
      boundary: { left: 0, bottom: 0, right: 64, top: 96 },
    })
    expect(resized.body.subarray(-3)).toEqual(Uint8Array.of(0xaa, 0xbb, 0xcc))
  })
})

/** Qualified v39 fixture: native observed prefix length, strings, rectangle, opaque tail.
 * This supplements the zero-prefix synthetic boundary fixtures used by the legacy reader. */
function editorContextSample() {
  const source = readMapInfo(sampleWithBoundary())
  const body = new Uint8Array(18 + source.body.length)
  body.set([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1], 0)
  body.set(source.body, 18)
  return readMapInfo(writeMapInfo({ ...source, body }))
}

describe('qualified v39 Editor terrain context', () => {
  it('changes shorter, equal and longer context IDs while preserving opaque bytes and source', () => {
    const source = editorContextSample(), original = writeMapInfo(source)
    const suffix = source.body.subarray(18 + 'Black\0MarSara\0'.length)
    for (const target of ['AA', 'ABCDEFG', 'UVWGeneratedTerrain']) {
      const result = setMapInfoEditorTerrainContext(source, 'MarSara', target)
      expect(mapInfoEditorTerrainContext(result)).toBe(target)
      expect(result.boundary).toEqual(source.boundary)
      expect(result.body.subarray(0, 18 + 'Black\0'.length)).toEqual(source.body.subarray(0, 18 + 'Black\0'.length))
      expect(result.body.subarray(18 + 'Black\0'.length + target.length + 1)).toEqual(suffix)
      expect(writeMapInfo(result).subarray(0, 24)).toEqual(original.subarray(0, 24))
      expect(writeMapInfo(source)).toEqual(original)
      result.body[0] = 99
      expect(writeMapInfo(source)).toEqual(original)
    }
  })

  it('refuses other layouts, stale old IDs, missing bounds and invalid identities', () => {
    const source = editorContextSample()
    expect(mapInfoEditorTerrainContext(readMapInfo(sampleWithBoundary()))).toBeUndefined()
    expect(() => setMapInfoEditorTerrainContext(readMapInfo(sampleWithBoundary()), 'MarSara', 'New')).toThrow(/layout/)
    expect(() => setMapInfoEditorTerrainContext({ ...source, version: 31 }, 'MarSara', 'New')).toThrow(/layout/)
    expect(() => setMapInfoEditorTerrainContext(source, 'Different', 'New')).toThrow(/expected old/)
    expect(() => setMapInfoEditorTerrainContext({ ...source, body: source.body.subarray(0, 24) }, 'MarSara', 'New')).toThrow(/layout/)
    for (const id of ['', 'A', 'x\0y', 'x\ny', 'Рельеф', 'x'.repeat(129)])
      expect(() => setMapInfoEditorTerrainContext(source, 'MarSara', id)).toThrow(/ASCII/)
  })

  it('composes with resize in both orders without changing the context or opaque suffix', () => {
    const source = editorContextSample()
    const first = resizeMapInfo(setMapInfoEditorTerrainContext(source, 'MarSara', 'UVWGeneratedTerrain'), 64, 96, 'full-map')
    const second = setMapInfoEditorTerrainContext(resizeMapInfo(source, 64, 96, 'full-map'), 'MarSara', 'UVWGeneratedTerrain')
    expect(writeMapInfo(first)).toEqual(writeMapInfo(second))
    expect(first.body.subarray(-3)).toEqual(Uint8Array.of(0xaa, 0xbb, 0xcc))
    expect(first.boundary).toEqual({ left: 0, bottom: 0, right: 64, top: 96 })
  })
})
