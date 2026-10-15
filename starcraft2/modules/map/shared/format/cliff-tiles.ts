/**
 * SC2 Maps owner for native cliff geometry: level/corner codes, wall lattice,
 * authored ramp side pieces, world placement and rotated stock mesh candidates.
 * Full-level authoring emits native CliffCell records from explicit vertex levels;
 * it does not infer source topology, author ramp frames or encode binary files.
 */
import { CLIFF_CELL_FLAT, CLIFF_CELL_RAMP, CLIFF_CELL_WALL, type CliffCell, type TerrainRamp } from './terrain-params.js'
import { dequantizeCliffLevel, type CliffLevelResult } from './formats/sync-cliff-level.js'
import type { HeightMapResult } from './formats/height-map.js'

export interface CliffTile {
  x: number
  y: number
  z: number
  /** Bottom-left, bottom-right, top-right, top-left. */
  code: string
  variation: number
  /**
   * Index into `TerrainInfo.cliffSets` — which `CCliff` supplies this tile's
   * mesh and material. Only set when tiles come from the map's authored
   * `<cliffCellList>`; undefined means "caller picks" (derived tiles).
   */
  cliffSetIndex?: number
  /**
   * True when the map painted this tile as part of a ramp. Ramp geometry is
   * authored in `<rampList>`, so a ramp tile whose code resolves to no mesh is
   * EXPECTED, not a failure.
   */
  ramp?: boolean
  /**
   * `<cliffCellList>` index this tile came from — i.e. its lattice cell. Lets the
   * caller tell the terrain builder exactly which lattice cells end up covered by
   * a real mesh, so it only opens a hole where something fills it.
   */
  cellIndex?: number
}

export interface CliffModelCandidate {
  path: string
  rotation: number
  variation: number
}

/** Full cliff levels, four apart: A=0, B=4, C=8, D=12. */
const BASE_LETTERS = 'ABCD'
const LEVELS_PER_BASE = 4
/** Sub-level letter = `N` + band + step, so Q is B+2, R is B+3 or C+2, S is C+3. */
const STEP_LETTER_ORIGIN = 'N'.charCodeAt(0)

/**
 * The `_CODE_` letter for a dequantized cliff level (A=0, B=4, C=8, D=12; sub-levels between).
 *
 * Sub-levels (ramps) are lettered by band AND step: `N` + band + step. Measured on the shipped
 * CliffMade20 ramp meshes, whose names come in pairs with identical geometry one band apart
 * (`BBQR`≡`CCRS`, `BQQR`≡`CRRS`, `QBRQ`≡`RCSR`), and on Amphion, where every one of the 42
 * `<rampList>` corner codes resolves under this rule and none under a per-band Q/R/S. It also keeps
 * `CliffNatural0_BQRC` (B, B+2, B+3, C) and `CliffNatural0_CRSD` (C, C+2, C+3, D).
 *
 * Levels at or above 16 (a fifth full level) have no letter and stay undefined —
 * the caller reports them rather than guessing.
 */
export function cliffLetterForLevel(level: number): string | undefined {
  const base = Math.floor(level / LEVELS_PER_BASE)
  const baseLetter = BASE_LETTERS[base]
  if (baseLetter === undefined) return undefined
  const offset = level - base * LEVELS_PER_BASE
  return offset === 0 ? baseLetter : String.fromCharCode(STEP_LETTER_ORIGIN + base + offset)
}

/** The `_CODE_` letter for one raw CLIF value. */
export function cliffLetter(raw: number): string | undefined {
  return cliffLetterForLevel(dequantizeCliffLevel(raw))
}

/**
 * The corner code of a tile from its four dequantized corner levels. Meshes name four full levels
 * (A–D) and the ramp steps between them, none above D: no shipped cliff set has a step of D's band
 * (a T, D+3, appears in no mesh name). A tile above D takes the mesh of the same shape whole bands
 * lower: every band above B is the same two units (`CCliffMesh.CliffHeights`, `cliffLevelOffsetZ`),
 * so Washout's C→E main-base wall is the B→D mesh and its D→E ramps (`STDS`) the C-band `CRRS`,
 * each placed at its own lowest corner. Level A lies deeper than that ladder, so no band shift may
 * reach it: a tile spanning A to above D stays uncoded, for the caller to report.
 */
export function cliffTileCode(levels: readonly number[]): string | undefined {
  const top = Math.max(...levels)
  const highest = (BASE_LETTERS.length - 1) * LEVELS_PER_BASE
  const shift = top > highest ? Math.ceil((top - highest) / LEVELS_PER_BASE) * LEVELS_PER_BASE : 0
  if (shift > 0 && Math.min(...levels) - shift < LEVELS_PER_BASE) return undefined
  const letters = levels.map(level => cliffLetterForLevel(level - shift))
  return letters.every(letter => letter !== undefined) ? letters.join('') : undefined
}

/** Whether a corner code has a ramp sub-level corner. */
const hasStepLetter = (code: string) => /[^ABCD]/u.test(code)

/** World-Z of cliff level B — every other level is placed relative to it. */
const CLIFF_LEVEL_B = 4
/** World units per cliff level, for B and above. */
const WORLD_Z_PER_LEVEL = 0.5
/**
 * Level A does not sit on that ladder: it is a full eight units below B, not the
 * two the linear rule would give. Both constants are confirmed by
 * `t3HeightMap.heightAdjustments`, which dequantizes to exactly these per-level
 * offsets on real maps (A −8, B 0, C +2, D +4).
 */
const LEVEL_A_OFFSET_Z = -8

/**
 * World-Z offset of a cliff level, relative to `t3Terrain.xml`'s `standardHeight`
 * (which is the world Z of level B). Cliff M3s are authored relative to their
 * lowest named corner, so this is what positions a tile.
 */
export function cliffLevelOffsetZ(level: number): number {
  return level === 0 ? LEVEL_A_OFFSET_Z : (level - CLIFF_LEVEL_B) * WORLD_Z_PER_LEVEL
}

/**
 * Lowest cliff level among a tile's four raw corners — the level the tile's
 * mesh is authored relative to, so the one that positions it.
 *
 * Written out rather than `raw.map(dequantizeCliffLevel)`: that passes the
 * array INDEX as the function's optional second parameter (`baseCliffLevel`),
 * which clamps corner `i` up to `i << 6`. Corners 2 and 3 could then never
 * report a level below 8 and 12, so any tile whose low corners sit late in the
 * array — `BBAA`, `BAAB`, `BAAA` — took the wrong minimum and was placed up to
 * eight units too high.
 */
export function minCliffLevel(raw: readonly number[]): number {
  let min = Infinity
  for (const value of raw) {
    const level = dequantizeCliffLevel(value)
    if (level < min) min = level
  }
  return min
}

export interface CliffTileTransform {
  originX?: number
  originY?: number
  originZ?: number
  scaleX?: number
  scaleY?: number
  scaleZ?: number
}

/**
 * Cliff level of every height vertex, in CLIF units (A=0, B=4, C=8, D=12, ramp sub-levels between).
 * Row-major over the `t3HeightMap` grid, which is one vertex larger than the cell grid each way.
 */
export interface CliffVertexLevels {
  sizeX: number
  sizeY: number
  levels: number[]
}

/**
 * SC2 Maps owner: author the native 2x2 cliff-cell lattice from explicit full
 * vertex levels. This is target geometry, not inference of source-game levels.
 * Ramp sublevels require authored ramp frames and are refused here; never close
 * a passage by silently treating its intermediate levels as a wall.
 */
export function authorCliffCells(vertices: CliffVertexLevels, cliffSetIndex: number): CliffCell[] {
  const { sizeX, sizeY, levels } = vertices
  if (!Number.isSafeInteger(sizeX) || !Number.isSafeInteger(sizeY) || sizeX < 3 || sizeY < 3 ||
      (sizeX - 1) % 2 !== 0 || (sizeY - 1) % 2 !== 0 || levels.length !== sizeX * sizeY)
    throw new RangeError('SC2 cliff authoring requires an odd vertex grid and one level per vertex')
  if (!Number.isSafeInteger(cliffSetIndex) || cliffSetIndex < 0)
    throw new RangeError('SC2 cliff-set index must be a nonnegative integer')
  if (levels.some(level => !Number.isSafeInteger(level) || level < 0 || level % 4 !== 0))
    throw new RangeError('SC2 full cliff levels must be nonnegative multiples of four; ramps require frames')
  const cells: CliffCell[] = []
  const columns = (sizeX - 1) / 2
  for (let y = 0; y < sizeY - 1; y += 2) {
    for (let x = 0; x < sizeX - 1; x += 2) {
      const corners = [levels[y * sizeX + x]!, levels[y * sizeX + x + 2]!,
        levels[(y + 2) * sizeX + x + 2]!, levels[(y + 2) * sizeX + x]!]
      if (cliffTileCode(corners) === undefined)
        throw new RangeError(`SC2 cliff tile at ${x},${y} has no representable corner code`)
      cells.push({ index: (y / 2) * columns + x / 2,
        flags: corners.every(level => level === corners[0]) ? CLIFF_CELL_FLAT : CLIFF_CELL_WALL,
        cliffSetIndex, variation: 0 })
    }
  }
  return cells
}

/**
 * The editor writes each height vertex's cliff offset into `t3HeightMap.heightAdjustments`
 * (A −8, B 0, C +2, D +4, ramps in 0.5 steps between). Those vertex levels — not the per-cell
 * `t3SyncCliffLevel` — are what the cliff meshes are chosen from: on Amphion every one of the 1196
 * authored wall cells has unequal levels at its four corner vertices and every flat cell has
 * equal ones, with no exception either way, while the cell field disagrees on a third of them.
 *
 * ponytail: sub-levels below B are not lettered; no map with an A→B ramp has been seen.
 */
export function cliffVertexLevels(
  heightMap: HeightMapResult,
  params: { readonly quantizeScale: number; readonly quantizeBias: number },
): CliffVertexLevels {
  const levels = heightMap.cells.map(cell => {
    const adjustment = cell.heightAdjustments * params.quantizeScale - params.quantizeBias
    return adjustment <= LEVEL_A_OFFSET_Z / 2
      ? 0
      : CLIFF_LEVEL_B + Math.max(0, Math.round(adjustment / WORLD_Z_PER_LEVEL))
  })
  return { sizeX: heightMap.sizeX, sizeY: heightMap.sizeY, levels }
}

export interface AuthoredCliffTilesResult {
  tiles: CliffTile[]
  /** Authored cells whose level dequantized past the D band (no letter). */
  unsupported: number
  /** Cells the map itself painted flat (`f=0`) — interior of a cliff region. */
  flat: number
  /** Cells with a wall/ramp role whose four corners share a level (no step to wall). */
  uniform: number
  /** Ramp-owned cells emitted with a sub-level code, or that the map painted `f=2`. */
  ramp: number
}

/**
 * One 2x2 piece per authored `<cliffCellList>` cell. Cell `(i, j)` covers terrain cells
 * `2i, 2i+1` × `2j, 2j+1`, so its piece is centred on vertex `(2i+1, 2j+1)` and its code is the
 * cliff level at its four CORNER vertices `(2i, 2j)`, `(2i+2, 2j)`, `(2i+2, 2j+2)`, `(2i, 2j+2)`.
 * The shipped meshes are built for exactly that: `BBCC` walls half a unit in from its low edge
 * and `BBBC` is a 45° wedge, so a one-unit staircase in the cell field draws as the straight
 * diagonal the editor shows.
 *
 * The cliff SET (`cid`) and mesh VARIATION (`cvar`) are authored per cell and cannot be recovered
 * from levels. Flat cells carry no wall and are skipped; ramp cells are emitted with their
 * sub-level code and tagged, so an unresolvable ramp code reads as expected rather than failure.
 */
export function cliffTilesFromCells(
  vertices: CliffVertexLevels,
  cells: readonly CliffCell[],
  standardHeight: number,
  transform: CliffTileTransform = {},
): AuthoredCliffTilesResult {
  const { originX = 0, originY = 0, originZ = 0, scaleX = 1, scaleY = 1, scaleZ = 1 } = transform
  const latticeX = (vertices.sizeX - 1) >> 1
  const latticeY = (vertices.sizeY - 1) >> 1
  const level = (x: number, y: number) => vertices.levels[y * vertices.sizeX + x]!
  const tiles: CliffTile[] = []
  let unsupported = 0
  let flat = 0
  let uniform = 0
  let ramp = 0
  for (const cell of cells) {
    if (cell.flags === CLIFF_CELL_FLAT) {
      flat += 1
      continue
    }
    // Ramp meshes are 2x4 and 4x4 side pieces placed by `rampCornerTiles` on the `<rampList>`
    // frames; the ramp's own cells carry no 2x2 piece (their codes would ship no mesh anyway).
    if (cell.flags === CLIFF_CELL_RAMP) {
      ramp += 1
      continue
    }
    const tileX = cell.index % latticeX
    const tileY = (cell.index / latticeX) | 0
    if (tileY >= latticeY) continue
    const x = tileX * 2
    const y = tileY * 2
    if (x + 2 >= vertices.sizeX || y + 2 >= vertices.sizeY) continue
    const corners = [level(x, y), level(x + 2, y), level(x + 2, y + 2), level(x, y + 2)]
    if (corners.every(value => value === corners[0])) {
      uniform += 1
      continue
    }
    const code = cliffTileCode(corners)
    if (code === undefined) {
      unsupported += 1
      continue
    }
    // A wall cell whose corner vertex sits on a ramp slope gets a sub-level letter; that code ships
    // no mesh and the ramp's own pieces cover it.
    const isRamp = hasStepLetter(code)
    if (isRamp) ramp += 1
    tiles.push({
      x: originX + (x + 1) * scaleX,
      y: originY + (y + 1) * scaleY,
      z: originZ + (standardHeight + cliffLevelOffsetZ(Math.min(...corners))) * scaleZ,
      code,
      variation: cell.variation,
      cliffSetIndex: cell.cliffSetIndex,
      cellIndex: cell.index,
      ...(isRamp ? { ramp: true } : {}),
    })
  }
  return { tiles, unsupported, flat, uniform, ramp }
}

const RAMP_CORNERS = ['leftLo', 'leftHi', 'rightLo', 'rightHi'] as const

/**
 * Side pieces of the map's `<rampList>`: one tile per corner frame that carries a variation,
 * centred on the frame — one cell off the tile lattice — with its code read from the 2x2 cliff
 * cells around that centre. Verified on Amphion: all 42 corner codes resolve to shipped
 * CliffMade20 meshes. The ramp surface itself is the heightmap.
 */
export function rampCornerTiles(
  cliff: CliffLevelResult,
  ramps: readonly TerrainRamp[],
  standardHeight: number,
  transform: CliffTileTransform = {},
): { tiles: CliffTile[]; unsupported: number } {
  const { originX = 0, originY = 0, originZ = 0, scaleX = 1, scaleY = 1, scaleZ = 1 } = transform
  const tiles: CliffTile[] = []
  let unsupported = 0
  for (const ramp of ramps)
    for (const corner of RAMP_CORNERS) {
      const frame = ramp.frames[corner]
      const variation = ramp.variations[corner]
      if (frame === undefined || variation === undefined || frame.width === 0) continue
      const [cx, cy] = frame.center
      if (cx < 1 || cy < 1 || cx >= cliff.sizeX || cy >= cliff.sizeY) {
        unsupported += 1
        continue
      }
      // A <rampList> frame is authored on the sample grid, not the wall lattice: its code comes from
      // the samples touching its centre. Measured on Amphion: all 42 corner codes resolve to shipped
      // CliffMade20 meshes this way, while reading corners two apart (as a wall tile does) leaves 14
      // codes that ship in no set.
      const cells = [
        [cx - 1, cy - 1],
        [cx, cy - 1],
        [cx, cy],
        [cx - 1, cy],
      ] as const
      const sample = (x: number, y: number) =>
        x < 0 || y < 0 || x >= cliff.sizeX || y >= cliff.sizeY
          ? undefined
          : cliff.heights[y * cliff.sizeX + x]
      const raw = cells.map(([x, y]) => sample(x, y)!)
      // Where the ground beside the top of the ramp is already high, the side wall does not end at
      // the ramp: it turns into the cliff of that high ground, and SC2 places the joining piece that
      // makes the turn (CliffMade20 BCRQ/BQRC, a metal corner cap) instead of the plain side wall.
      // So a low-ground sample on the piece's upper half (toward `up`) reads the cell one step further
      // up the ramp when that cell is higher. On Amphion this changes exactly 4 of the 42 corners, all
      // beside a deck corner, all to shipped meshes; the SC2 editor shows the cap on the ramp west of
      // the centre (66,71) and the plain wall on its other side (66,79), as this rule gives.
      const [upX, upY] = [Math.round(frame.up[0]), Math.round(frame.up[1])]
      const low = minCliffLevel(raw)
      raw.forEach((value, index) => {
        const [x, y] = cells[index]!
        const upper = (x - (cx - 0.5)) * upX + (y - (cy - 0.5)) * upY > 0
        if (!upper || dequantizeCliffLevel(value) !== low) return
        const beyond = sample(x + upX, y + upY)
        if (beyond !== undefined && dequantizeCliffLevel(beyond) > low) raw[index] = beyond
      })
      const code = cliffTileCode(raw.map(value => dequantizeCliffLevel(value)))
      if (code === undefined) {
        unsupported += 1
        continue
      }
      tiles.push({
        x: originX + cx * scaleX,
        y: originY + cy * scaleY,
        z: originZ + (standardHeight + cliffLevelOffsetZ(minCliffLevel(raw))) * scaleZ,
        code,
        variation,
        cliffSetIndex: ramp.cliffSetIndex,
        ramp: true,
      })
    }
  return { tiles, unsupported }
}

/**
 * Derive tiles from the level field alone — the fallback for maps with no
 * `<cliffCellList>`. Prefer `cliffTilesFromCells` when the map authors one.
 */
export function cliffTilesFromLevels(
  cliff: CliffLevelResult,
  standardHeight: number,
  originX = 0,
  originY = 0,
  scaleX = 1,
  scaleY = 1,
  originZ = 0,
  scaleZ = 1,
): { tiles: CliffTile[]; unsupported: number } {
  const tiles: CliffTile[] = []
  let unsupported = 0
  for (let y = 0; y + 1 < cliff.sizeY; y += 2) {
    for (let x = 0; x + 1 < cliff.sizeX; x += 2) {
      const raw = [
        cliff.heights[y * cliff.sizeX + x]!,
        cliff.heights[y * cliff.sizeX + x + 1]!,
        cliff.heights[(y + 1) * cliff.sizeX + x + 1]!,
        cliff.heights[(y + 1) * cliff.sizeX + x]!,
      ]
      if (raw.every(value => value === raw[0])) continue
      const code = cliffTileCode(raw.map(value => dequantizeCliffLevel(value)))
      if (code === undefined) {
        unsupported += 1
        continue
      }
      const minimumLevel = minCliffLevel(raw)
      tiles.push({
        x: originX + (x + 1) * scaleX,
        y: originY + (y + 1) * scaleY,
        // Cliff M3s are authored relative to their lowest named corner, so the
        // tile sits at that corner's level (see `cliffLevelOffsetZ`). Placing
        // every piece at standardHeight lifts A/B cliffs a full eight units.
        z: originZ + (standardHeight + cliffLevelOffsetZ(minimumLevel)) * scaleZ,
        code,
        variation: Math.abs(((x >> 1) * 73856093) ^ ((y >> 1) * 19349663)) & 3,
      })
    }
  }
  return { tiles, unsupported }
}

/**
 * Candidate paths in deterministic preference order.
 *
 * Only one rotation of each corner code ships. For wall codes (A–D) it is always the
 * lexicographically smallest rotation — verified against all 66 wall codes of CliffNatural0 and
 * CliffMade20 — so a wall tile needs just that file, at the authored variation or `_00` (rare codes
 * ship a single variation). Ramp codes (sub-level letters) break the rule for 3 of 18, so
 * they try every rotation, smallest first. Each missing candidate is a failed resource lookup; the former blind
 * 4 rotations × 5 variations cost ~20 lookups per model and dominated Amphion's load time.
 */
export function cliffModelCandidates(
  modelPath: string,
  meshId: string,
  code: string,
  preferredVariation: number,
): CliffModelCandidate[] {
  const folder = modelPath.replace(/[\\/]+$/, '')
  const variations = [preferredVariation, 0].filter((value, index, all) => all.indexOf(value) === index)
  const rotations = [0, 1, 2, 3]
    .map(quarterTurns => ({ quarterTurns, code: code.slice(quarterTurns) + code.slice(0, quarterTurns) }))
    .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
  const out: CliffModelCandidate[] = []
  for (const rotation of hasStepLetter(code.toUpperCase()) ? rotations : rotations.slice(0, 1))
    for (const variation of variations)
      out.push({
        path: `${folder}\\${meshId}_${rotation.code}_${String(variation).padStart(2, '0')}.m3`,
        rotation: rotation.quarterTurns * (Math.PI / 2),
        variation,
      })
  return out
}
