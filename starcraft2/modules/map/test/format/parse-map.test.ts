import { describe, it, expect } from 'vitest'
import { parseMapEntries } from '../../shared/format/parse-map.js'
import { writeHeightMap } from '../../shared/format/formats/height-map.js'
import { writeCellFlags } from '../../shared/format/formats/cell-flags.js'
import { Build } from './helpers.js'

function hmap(): Uint8Array {
  return new Build()
    .ascii('HMAP').u32(101).u32(1).u32(1).pad(16)
    .u16(10).u16(100).u16(1)
    .done()
}

function cellFlags(): Uint8Array {
  return new Build().ascii('LFCT').u32(101).pad(16).u32(2).u32(1).bytes(0x00, 0x03).done()
}

function terrainXml(): Uint8Array {
  const xml = '<terrain><heightMap quantizeScale="0.5" quantizeBias="1" standardHeight="2"/></terrain>'
  return new TextEncoder().encode(xml)
}

describe('parseMapEntries', () => {
  it('routes editor names to typed fields and keeps every file raw', () => {
    const files = new Map<string, Uint8Array>([
      ['t3HeightMap', hmap()],
      ['t3CellFlags', cellFlags()],
      ['t3Terrain.xml', terrainXml()],
      ['AIData.xml', new TextEncoder().encode('<AIData><Config id="A"/></AIData>')],
      ['SomethingUnknown', new Uint8Array([1, 2, 3])],
    ])
    const data = parseMapEntries(files)
    expect(data.height?.sizeX).toBe(1)
    expect(Array.from(data.cellFlags!.types)).toEqual([0x00, 0x03])
    expect(data.terrain?.quantizeScale).toBe(0.5)
    expect(data.aiData?.unknown?.[0]?.name).toBe('Config')
    expect(data.rawFiles.size).toBe(5) // all files preserved, incl. the unknown one
    expect(data.rawFiles.has('SomethingUnknown')).toBe(true)
  })

  it('matches MPQ-alias names and nested paths case-insensitively', () => {
    const files = new Map<string, Uint8Array>([['Base/mapHeightMap', hmap()]])
    const data = parseMapEntries(files)
    expect(data.height?.sizeX).toBe(1)
  })

  it('round-trips a routed file via rawFiles', () => {
    const files = new Map<string, Uint8Array>([['t3HeightMap', hmap()]])
    const data = parseMapEntries(files)
    // the typed model re-serializes to the same bytes
    expect(Array.from(writeHeightMap(data.height!))).toEqual(Array.from(hmap()))
    // and rawFiles holds the exact original
    expect(Array.from(data.rawFiles.get('t3HeightMap')!)).toEqual(Array.from(hmap()))
    void writeCellFlags
  })

  it('is lenient: a corrupt known file does not throw, reports via onError', () => {
    const errors: string[] = []
    const files = new Map<string, Uint8Array>([
      ['t3HeightMap', new Uint8Array([0x48, 0x4d, 0x41, 0x50, 0x01])], // valid magic, truncated
    ])
    const data = parseMapEntries(files, { onError: (n) => errors.push(n) })
    expect(data.height).toBeUndefined()
    expect(errors).toEqual(['t3HeightMap'])
    expect(data.rawFiles.size).toBe(1) // raw bytes still kept
  })
})
