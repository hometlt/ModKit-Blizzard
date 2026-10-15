import { describe, expect, it } from 'vitest'
import {
  cliffLetter,
  cliffLevelOffsetZ,
  cliffModelCandidates,
  cliffTileCode,
  cliffTilesFromCells,
  cliffTilesFromLevels,
  cliffVertexLevels,
  rampCornerTiles,
} from '../../shared/format/cliff-tiles.js'

describe('SC2 cliff tile resolution', () => {
  it('maps CLIF values to the model naming alphabet', () => {
    expect([0, 64, 72, 88, 104, 128, 192].map(cliffLetter)).toEqual([
      'A',
      'B',
      'P',
      'Q',
      'R',
      'C',
      'D',
    ])
  })

  it('letters sub-levels by band and step — CliffMade20 ramp meshes pair BBQR with CCRS', () => {
    // N + band + step: A band (levels 1,2,3), B band (5,6,7), C band (9,10,11).
    expect([16, 32, 48].map(cliffLetter)).toEqual(['O', 'P', 'Q'])
    expect([72, 88, 104].map(cliffLetter)).toEqual(['P', 'Q', 'R'])
    expect([136, 152, 168].map(cliffLetter)).toEqual(['Q', 'R', 'S'])
    // …and each band's own full level still reads as its base letter.
    expect([0, 64, 128, 192].map(cliffLetter)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('leaves levels past the D band unlettered for the caller to report', () => {
    expect(cliffLetter(256)).toBeUndefined()
  })

  it('places level A a full eight units below B, not on the 0.5-per-level ladder', () => {
    // Confirmed against t3HeightMap.heightAdjustments, which dequantizes to
    // exactly these per-level offsets on real maps.
    expect([0, 4, 8, 12].map(cliffLevelOffsetZ)).toEqual([-8, 0, 2, 4])
    // Ramp sub-levels interpolate at half a unit each.
    expect([5, 6, 7].map(cliffLevelOffsetZ)).toEqual([0.5, 1, 1.5])
  })

  it('emits a C→D ramp tile instead of counting it unsupported', () => {
    const result = cliffTilesFromLevels(
      {
        version: 100,
        sizeX: 2,
        sizeY: 2,
        heights: [192, 128, 176, 168],
        _raw: { padding: new Uint8Array(16), trailing: new Uint8Array() },
      },
      6,
    )
    expect(result).toEqual({
      tiles: [{ x: 1, y: 1, z: 8, code: 'DCSS', variation: 0 }],
      unsupported: 0,
    })
  })

  it('builds one centred 2x2 tile in documented corner order', () => {
    const result = cliffTilesFromLevels(
      {
        version: 100,
        sizeX: 2,
        sizeY: 2,
        heights: [0, 64, 192, 128],
        _raw: { padding: new Uint8Array(16), trailing: new Uint8Array() },
      },
      6,
      10,
      20,
    )
    expect(result).toEqual({
      tiles: [{ x: 11, y: 21, z: -2, code: 'ABCD', variation: 0 }],
      unsupported: 0,
    })
  })

  it('places a tile at its lowest corner level and applies map transforms', () => {
    const result = cliffTilesFromLevels(
      {
        version: 100,
        sizeX: 3,
        sizeY: 3,
        // only the window at (0,0) is mixed: corner (0,0) is A, the rest of it is B
        heights: [0, 64, 64, 64, 64, 64, 64, 64, 64],
        _raw: { padding: new Uint8Array(16), trailing: new Uint8Array() },
      },
      6,
      10,
      20,
      2,
      3,
      5,
      2,
    )
    // Level A sits eight units below standardHeight: (6 - 8) * 2 + 5 = 1.
    expect(result.tiles).toEqual([{ x: 12, y: 23, z: 1, code: 'ABBB', variation: 0 }])
  })

  describe('authored <cliffCellList> tiles', () => {
    // A 5x5 height-vertex grid holds a 2x2 cell lattice; cell 0 has its corner vertices at
    // (0,0), (2,0), (2,2), (0,2) and its piece centred on (1,1).
    const grid = (levels: number[]) => ({ sizeX: 5, sizeY: 5, levels })
    const flat = Array.from({ length: 25 }, () => 4)

    it('reads a height map vertex level from its cliff offset', () => {
      // A −8, B 0, C +2, D +4, ramp steps of half a unit; quantized at scale 0.5, bias 8.
      const vertices = cliffVertexLevels(
        {
          version: 100,
          sizeX: 6,
          sizeY: 1,
          cells: [0, 16, 17, 20, 23, 24].map(heightAdjustments => ({
            heightBase: 0,
            heightAdjustments,
            mask: 0,
          })),
          _raw: { padding: new Uint8Array(16), trailing: new Uint8Array() },
        },
        { quantizeScale: 0.5, quantizeBias: 8 },
      )
      expect(vertices).toEqual({ sizeX: 6, sizeY: 1, levels: [0, 4, 5, 8, 11, 12] })
    })

    it('codes the authored cell from the cliff level at its four corner vertices', () => {
      // Corner order BL, BR, TR, TL. On Amphion every wall cell has unequal corner levels and every
      // flat cell equal ones, and the shipped meshes wall half a unit in from the low corners.
      const cornerLow = [...flat]
      cornerLow[0] = 0
      const result = cliffTilesFromCells(
        grid(cornerLow),
        [{ index: 0, flags: 1, cliffSetIndex: 1, variation: 3 }],
        6,
      )

      expect(result.tiles).toEqual([
        { x: 1, y: 1, z: -2, code: 'ABBB', variation: 3, cliffSetIndex: 1, cellIndex: 0 },
      ])
      expect(result).toMatchObject({ flat: 0, ramp: 0, unsupported: 0, uniform: 0 })
    })

    it('ignores the vertices inside the cell — the mesh, not the height field, shapes those', () => {
      const centreLow = [...flat]
      centreLow[1 * 5 + 1] = 0
      const result = cliffTilesFromCells(
        grid(centreLow),
        [{ index: 0, flags: 1, cliffSetIndex: 1, variation: 3 }],
        6,
      )
      expect(result.tiles).toEqual([])
      expect(result.uniform).toBe(1)
    })

    it('takes the tile Z from the lowest corner wherever it sits in the code', () => {
      const bbaa = [...flat]
      bbaa[2 * 5 + 0] = 0
      bbaa[2 * 5 + 2] = 0
      const result = cliffTilesFromCells(
        grid(bbaa),
        [{ index: 0, flags: 1, cliffSetIndex: 0, variation: 0 }],
        6,
      )

      expect(result.tiles).toMatchObject([{ code: 'BBAA', z: -2 }])
    })

    it('applies the map transform to the piece position', () => {
      const cornerLow = [...flat]
      cornerLow[0] = 0
      const result = cliffTilesFromCells(
        grid(cornerLow),
        [{ index: 0, flags: 1, cliffSetIndex: 0, variation: 0 }],
        6,
        { originX: 10, originY: 20, originZ: 5, scaleX: 2, scaleY: 3, scaleZ: 2 },
      )
      // Level A sits eight units below standardHeight: (6 - 8) * 2 + 5 = 1.
      expect(result.tiles).toMatchObject([{ x: 12, y: 23, z: 1 }])
    })

    it('skips cells the map painted flat — they carry no wall', () => {
      const result = cliffTilesFromCells(
        grid([...flat]),
        [{ index: 0, flags: 0, cliffSetIndex: 0, variation: 0 }],
        6,
      )
      expect(result.tiles).toEqual([])
      expect(result.flat).toBe(1)
    })

    it('skips ramp cells — their 2x4 and 4x4 side pieces come from <rampList>', () => {
      const cornerLow = [...flat]
      cornerLow[0] = 0
      const result = cliffTilesFromCells(
        grid(cornerLow),
        [{ index: 0, flags: 2, cliffSetIndex: 0, variation: 1 }],
        6,
      )
      expect(result.tiles).toEqual([])
      expect(result.ramp).toBe(1)
    })

    it('reports an out-of-band cell as unsupported', () => {
      // E over B: shifting it into the lettered bands would put its low corners on level A, which
      // lies deeper than the two-unit ladder, so no mesh shapes it.
      const tall = [...flat]
      tall[0] = 16
      const result = cliffTilesFromCells(
        grid(tall),
        [{ index: 0, flags: 1, cliffSetIndex: 0, variation: 0 }],
        6,
      )
      expect(result.tiles).toEqual([])
      expect(result).toMatchObject({ unsupported: 1, flat: 0, uniform: 0 })
    })

    it('codes a wall above D with the mesh of the same shape a band lower, at its own level', () => {
      // Washout's main base stands on level 16 (E): its C→E wall is the B→D mesh, and its D→E wall the
      // C→D one. Both sit at their own lowest corner (C at +2, D at +4 over standardHeight 6).
      const onC = Array.from({ length: 25 }, () => 8)
      onC[0] = 16
      const onD = Array.from({ length: 25 }, () => 12)
      onD[0] = 16
      const cell = [{ index: 0, flags: 1, cliffSetIndex: 0, variation: 0 }]
      expect(cliffTilesFromCells(grid(onC), cell, 6).tiles).toMatchObject([{ code: 'DBBB', z: 8 }])
      expect(cliffTilesFromCells(grid(onD), cell, 6).tiles).toMatchObject([{ code: 'DCCC', z: 10 }])
      expect(cliffTileCode([20, 16, 16, 16])).toBe('DCCC')
      expect(cliffTileCode([0, 16, 16, 16])).toBeUndefined()
      expect(cliffTileCode([4, 8, 12, 12])).toBe('BCDD')
      // Its D→E ramps: no cliff set ships a step of D's band (no T in any mesh name), so the ramp
      // takes the C-band mesh of the same shape (CliffMade21_CRRS is a rotation of RSCR).
      expect(cliffTileCode([14, 15, 12, 14])).toBe('RSCR')
      expect(cliffTileCode([8, 10, 11, 12])).toBe('CRSD')
    })

    it('tags a wall cell whose corner sits on a ramp slope, whose code ships no mesh', () => {
      const sub = [...flat]
      sub[2] = 6
      const result = cliffTilesFromCells(
        grid(sub),
        [{ index: 0, flags: 1, cliffSetIndex: 0, variation: 1 }],
        6,
      )
      expect(result.tiles).toMatchObject([{ code: 'BQBB', ramp: true }])
      expect(result.ramp).toBe(1)
    })
  })

  it('asks a wall tile only for its shipped smallest rotation, authored variation then _00', () => {
    // AABA turned three quarters is AAAB, the one rotation the asset set ships.
    expect(
      cliffModelCandidates('Assets\\Cliffs\\CliffNatural0\\', 'CliffNatural0', 'AABA', 2),
    ).toEqual([
      { path: 'Assets\\Cliffs\\CliffNatural0\\CliffNatural0_AAAB_02.m3', rotation: (3 * Math.PI) / 2, variation: 2 },
      { path: 'Assets\\Cliffs\\CliffNatural0\\CliffNatural0_AAAB_00.m3', rotation: (3 * Math.PI) / 2, variation: 0 },
    ])
  })

  it('places a ramp corner piece on its frame centre, one cell off the tile lattice', () => {
    // Samples touching centre (2,2), BL BR TR TL: B+3, B, B+2, B+2 → RBQQ (ships rotated as BQQR).
    // A ramp frame is authored on the sample grid, so its piece sits half a unit inside the centre.
    const result = rampCornerTiles(
      {
        version: 100,
        sizeX: 5,
        sizeY: 5,
        heights: [
          64, 64, 64, 64, 64,
          64, 112, 64, 64, 64,
          64, 96, 96, 64, 64,
          64, 64, 64, 64, 64,
          64, 64, 64, 64, 64,
        ],
        _raw: { padding: new Uint8Array(16), trailing: new Uint8Array() },
      },
      [
        {
          dir: 4,
          lo: 1,
          hi: 2,
          cliffSetIndex: 1,
          frames: { leftLo: { up: [0, -1], right: [-1, 0], center: [2, 2], width: 2, height: 2 } },
          variations: { leftLo: 0 },
        },
      ],
      6,
    )
    expect(result).toEqual({
      tiles: [{ x: 2, y: 2, z: 6, code: 'RBQQ', variation: 0, cliffSetIndex: 1, ramp: true }],
      unsupported: 0,
    })
    expect(cliffModelCandidates('Assets\\Cliffs\\CliffMade20\\', 'CliffMade20', 'RBQQ', 0)[0]).toEqual({
      path: 'Assets\\Cliffs\\CliffMade20\\CliffMade20_BQQR_00.m3',
      rotation: Math.PI / 2,
      variation: 0,
    })
  })

  it('joins a ramp side into the high ground beside the ramp top with the corner cap', () => {
    // Amphion's ramp west of the centre, cells x 63..68, y 69..80 of t3SyncCliffLevel: low ground B
    // west (x <= 63) and along both sides, the ramp B+1..B+3 over x 64..66 and y 71..78, the deck C
    // from x 67 east. South of the ramp top the deck goes on (cell 67,70 is C); north of it the
    // ground is low (67,79 is B). The SC2 editor shows a metal corner cap on the south side and the
    // plain side wall on the north side.
    const [B, P, Q, R, C] = [64, 72, 88, 104, 128]
    const sizeX = 6
    const row = (y: number): number[] =>
      y >= 71 && y <= 78 ? [B, P, Q, R, C, C] : y === 79 ? [B, B, B, B, B, C] : [B, B, B, B, C, C]
    const heights = Array.from({ length: 12 }, (_, index) => row(69 + index)).flat()
    // Local coordinates: x 63 → 0, y 69 → 0.
    const frame = (cy: number) => ({ up: [1, 0] as [number, number], right: [0, -1] as [number, number], center: [3, cy - 69] as [number, number], width: 2, height: 2 })
    const result = rampCornerTiles(
      { version: 100, sizeX, sizeY: 12, heights, _raw: { padding: new Uint8Array(16), trailing: new Uint8Array() } },
      [
        {
          dir: 3,
          lo: 1,
          hi: 2,
          cliffSetIndex: 1,
          frames: { leftLo: frame(79), rightLo: frame(71) },
          variations: { leftLo: 0, rightLo: 0 },
        },
      ],
      6,
    )
    expect(result.tiles.map(tile => tile.code)).toEqual(['QRBB', 'BCRQ'])
    // Both stand on the low ground: the joined sample does not lift the piece.
    expect(result.tiles.map(tile => tile.z)).toEqual([6, 6])
    expect(cliffModelCandidates('Assets\\Cliffs\\CliffMade20\\', 'CliffMade20', 'BCRQ', 0)[0]!.path).toBe(
      'Assets\\Cliffs\\CliffMade20\\CliffMade20_BCRQ_00.m3',
    )
  })

  it('tries every rotation of a ramp code, smallest first', () => {
    const candidates = cliffModelCandidates('Assets\\Cliffs\\CliffMade20\\', 'CliffMade20', 'RQBQ', 0)
    expect(candidates.map(candidate => candidate.path.slice(-11))).toEqual([
      '_BQRQ_00.m3',
      '_QBQR_00.m3',
      '_QRQB_00.m3',
      '_RQBQ_00.m3',
    ])
  })
})
