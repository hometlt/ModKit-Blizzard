import { describe, it, expect } from 'vitest'
import { parseTerrainXml } from '../../shared/format/terrain-params.js'
import { levelFromCell } from '../../shared/format/formats/height-map.js'

const XML = `<?xml version="1.0" encoding="us-ascii"?>
<terrain version="113">
  <heightMap tileSet="MarSara" dim="137 161 " quantizeBias="9.055906e+000" quantizeScale="4.609336e-004" standardHeight="7.973049e+000">
    <textureList num="3">
      <texture i="0" name="MarSaraDirt"/>
      <texture i="1" name="MarSaraRocky"/>
      <texture i="2" name="MarSaraConcrete"/>
    </textureList>
  </heightMap>
</terrain>`

describe('parseTerrainXml', () => {
  it('reads the map-selected cliff catalog ids in index order', () => {
    const terrain = parseTerrainXml(`
      <heightMap tileSet="TheVoid2">
        <cliffSetList num="2">
          <cliffSet i="0" name="ShakurasCliff0"/>
          <cliffSet i="1" name="CompoundFacilityCliff1"/>
        </cliffSetList>
      </heightMap>`)
    expect(terrain.cliffSets).toEqual(['ShakurasCliff0', 'CompoundFacilityCliff1'])
  })

  it('reads authored cliff cells independently of attribute order', () => {
    const terrain = parseTerrainXml(`
      <terrain>
        <cliffCellList num="4" numOccupied="2">
          <cc cvar="3" cid="1" f="1" i="0"/>
          <cc i="2" f="2" cid="0" cvar="1"/>
          <cc i="invalid" f="1" cid="0" cvar="0"/>
        </cliffCellList>
      </terrain>`)
    expect(terrain.cliffCellCount).toBe(4)
    expect(terrain.cliffCells).toEqual([
      { index: 0, flags: 1, cliffSetIndex: 1, variation: 3 },
      { index: 2, flags: 2, cliffSetIndex: 0, variation: 1 },
    ])
  })

  it('decodes authored ramp frames and omits sentinel values', () => {
    const terrain = parseTerrainXml(`
      <terrain>
        <rampList>
          <ramp dir="3" hi="3" lo="2" cid="1"
            leftLo="u(1, 0) r(0, 1) c=(12.5, -4) w=2 h=3"
            leftHi="u(0, 0) r(0, 0) c=(0, 0) w=0 h=0"
            leftLoVar="2" leftHiVar="4294967295"/>
        </rampList>
      </terrain>`)
    expect(terrain.ramps).toEqual([
      {
        dir: 3,
        hi: 3,
        lo: 2,
        cliffSetIndex: 1,
        frames: {
          leftLo: {
            up: [1, 0],
            right: [0, 1],
            center: [12.5, -4],
            width: 2,
            height: 3,
          },
        },
        variations: { leftLo: 2 },
      },
    ])
  })

  it('extracts the quantize params (scientific notation)', () => {
    const t = parseTerrainXml(XML)
    expect(t.quantizeBias).toBeCloseTo(9.055906, 5)
    expect(t.quantizeScale).toBeCloseTo(0.0004609336, 9)
    expect(t.standardHeight).toBeCloseTo(7.973049, 5)
  })

  it('extracts tileSet, dim, and the texture list in order', () => {
    const t = parseTerrainXml(XML)
    expect(t.tileSet).toBe('MarSara')
    expect(t.dimX).toBe(137)
    expect(t.dimY).toBe(161)
    expect(t.textures).toEqual([
      { index: 0, name: 'MarSaraDirt' },
      { index: 1, name: 'MarSaraRocky' },
      { index: 2, name: 'MarSaraConcrete' },
    ])
  })

  it('feeds levelFromCell', () => {
    const t = parseTerrainXml(XML)
    const lvl = levelFromCell({ heightAdjustments: 8000, heightBase: 8000, mask: 0 }, t)
    expect(Number.isFinite(lvl)).toBe(true)
  })

  it('returns safe defaults when fields are absent', () => {
    const t = parseTerrainXml('<terrain/>')
    expect(t.quantizeScale).toBe(0)
    expect(t.textures).toEqual([])
    expect(t.tileSet).toBeUndefined()
  })
})
