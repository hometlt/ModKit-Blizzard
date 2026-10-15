import { describe, it, expect } from 'vitest'
import { parseMapEntries } from '../../shared/format/parse-map.js'
import { serializeMapEntries, mapToJson, mapFromJson } from '../../shared/format/serialize-map.js'
import { Build } from './helpers.js'

function hmap(base = 100): Uint8Array {
  // Cell field order: heightBase, heightAdjustments, mask.
  return new Build().ascii('HMAP').u32(101).u32(1).u32(1).pad(16).u16(base).u16(10).u16(1).done()
}

function entries(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['t3HeightMap', hmap()],
    ['Unmodeled.bin', new Uint8Array([9, 8, 7])],
  ])
}

describe('serializeMapEntries', () => {
  it('reproduces the original files when nothing is edited', () => {
    const data = parseMapEntries(entries())
    const out = serializeMapEntries(data)
    expect(Array.from(out.get('t3HeightMap')!)).toEqual(Array.from(hmap()))
    expect(Array.from(out.get('Unmodeled.bin')!)).toEqual([9, 8, 7])
  })

  it('reflects edits to a modeled field and preserves unmodeled files', () => {
    const data = parseMapEntries(entries())
    data.height!.cells[0]!.heightBase = 250
    const out = serializeMapEntries(data)
    expect(Array.from(out.get('t3HeightMap')!)).toEqual(Array.from(hmap(250)))
    expect(Array.from(out.get('Unmodeled.bin')!)).toEqual([9, 8, 7]) // untouched
  })

  it('adds a newly-attached field under its canonical name', () => {
    const data = parseMapEntries(new Map())
    data.height = parseMapEntries(new Map([['t3HeightMap', hmap()]])).height!
    const out = serializeMapEntries(data)
    expect(out.has('t3HeightMap')).toBe(true)
  })
})

describe('JSON interchange', () => {
  it('round-trips model → JSON → model (the writer canary)', () => {
    const data = parseMapEntries(entries())
    const restored = mapFromJson(mapToJson(data))
    expect(restored.height?.cells[0]?.heightBase).toBe(100)
    expect(restored.rawFiles.size).toBe(2)
    expect(Array.from(restored.rawFiles.get('Unmodeled.bin')!)).toEqual([9, 8, 7])
  })

  it('carries edits through JSON', () => {
    const data = parseMapEntries(entries())
    data.height!.cells[0]!.heightBase = 200
    const restored = mapFromJson(mapToJson(data))
    expect(restored.height?.cells[0]?.heightBase).toBe(200)
  })
})
