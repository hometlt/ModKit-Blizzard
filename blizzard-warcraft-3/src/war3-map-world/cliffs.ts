/**
 * Where Warcraft III draws cliff and ramp pieces on a map, and how a ramp lifts the ground.
 *
 * Adapted from WarsmashModEngine (AGPL-3.0, `references/WarsmashModEngine`,
 * `core/src/com/etheller/warsmash/viewer5/handlers/w3x/environment/Terrain.java`: the cliff flags
 * of the constructor, `updateCliffMeshes`, `isCornerRampEntrance`, `getRampLetter`,
 * `updateGroundHeights` and `realTileTexture`), by the owner's decision of 2026-09-29; notice in
 * `licenses/WARSMASH-NOTICE.md`.
 *
 * Warsmash turns every piece a quarter turn (`vec3(vPosition.y, -vPosition.x, …)`) and spells its
 * corners top left, top right, bottom right, bottom left. Here the piece stands unturned with its
 * origin on the bottom-right corner of the cells it covers and the corners spelled bottom left, top
 * left, top right, bottom right, as mdx-m3-viewer places cliffs: the same pieces under another name.
 * The ramp models of the installation agree with both — `CliffTransLAAH0` spans two cells along x and
 * `CliffTransAAHL0` two along y, their corner heights on the high cell spelling the name.
 */

/** The corner fields of `war3map.w3e` the pieces read (levels are whole cliff levels). */
export interface PieceCorner {
  readonly groundHeight: number
  readonly layerHeight: number
  readonly ramp: number
  readonly cliffTexture: number
  readonly cliffVariation: number
}

export interface PieceTerrain {
  readonly mapSize: ArrayLike<number>
  readonly corners: readonly (readonly PieceCorner[])[]
}

export interface TerrainPiece {
  readonly kind: 'cliff' | 'ramp'
  /** Corner letters bottom left, top left, top right, bottom right: A, B, C… above the lowest; L, H on a ramp. */
  readonly name: string
  /** The lower-left cell the piece covers and how many cells it covers each way. */
  readonly x: number
  readonly y: number
  readonly width: 1 | 2
  readonly height: 1 | 2
  /** The lowest cliff level of the named cell. */
  readonly base: number
  /** The map's cliff tileset index (15, "none", already resolved). */
  readonly cliffTexture: number
  readonly variation: number
}

export interface TerrainPieces {
  readonly pieces: readonly TerrainPiece[]
  /** Levels a corner rises for standing at the foot of a ramp entrance (0 or ½). */
  rampLift(x: number, y: number): number
  /** The cliff tileset whose ground a corner shows, or undefined for its own ground tileset. */
  groundCliff(x: number, y: number): number | undefined
}

/** The ramp models the game ships (`Doodads\Terrain\CliffTrans`, `CityCliffTrans`); Warsmash's `ramps`. */
const RAMP_NAMES: ReadonlySet<string> = new Set([
  'AAHL', 'AALH', 'ABHL', 'AHLA', 'ALHA', 'ALHB', 'BALH', 'BHLA',
  'HAAL', 'HBAL', 'HLAA', 'HLAB', 'LAAH', 'LABH', 'LHAA', 'LHBA',
])

const cache = new WeakMap<PieceTerrain, TerrainPieces>()

export function terrainPieces(terrain: PieceTerrain): TerrainPieces {
  const cached = cache.get(terrain)
  if (cached !== undefined) return cached
  const columns = terrain.mapSize[0] ?? 0
  const rows = terrain.mapSize[1] ?? 0
  const index = (x: number, y: number) => y * columns + x
  const corner = (x: number, y: number) => terrain.corners[y]?.[x]
  const layer = (x: number, y: number) => corner(x, y)?.layerHeight ?? 0
  // Ramp flags and cliff textures change as pieces claim corners, as in Warsmash.
  const ramp = new Uint8Array(columns * rows)
  const cliffTexture = new Uint8Array(columns * rows)
  const romp = new Uint8Array(columns * rows)
  for (let y = 0; y < rows; y += 1)
    for (let x = 0; x < columns; x += 1) {
      ramp[index(x, y)] = (corner(x, y)?.ramp ?? 0) !== 0 ? 1 : 0
      cliffTexture[index(x, y)] = corner(x, y)?.cliffTexture ?? 0
    }
  const isRamp = (x: number, y: number) => ramp[index(x, y)] === 1
  const inCells = (x: number, y: number) => x >= 0 && y >= 0 && x < columns - 1 && y < rows - 1
  /** A cell whose corners stand on different levels. */
  const isCliff = (x: number, y: number) =>
    inCells(x, y) && !(layer(x, y) === layer(x + 1, y) && layer(x, y) === layer(x, y + 1) && layer(x, y) === layer(x + 1, y + 1))
  /** Four ramp corners, not a diagonal: sloped ground between two levels. */
  const entrance = (x: number, y: number) =>
    inCells(x, y) &&
    isRamp(x, y) && isRamp(x + 1, y) && isRamp(x, y + 1) && isRamp(x + 1, y + 1) &&
    !(layer(x, y) === layer(x + 1, y + 1) && layer(x, y + 1) === layer(x + 1, y))

  const pieces: TerrainPiece[] = []
  for (let x = 0; x < columns - 1; x += 1)
    for (let y = 0; y < rows - 1; y += 1) {
      if (!isCliff(x, y)) continue
      const bottomLeft = layer(x, y)
      const bottomRight = layer(x + 1, y)
      const topLeft = layer(x, y + 1)
      const topRight = layer(x + 1, y + 1)
      const base = Math.min(bottomLeft, bottomRight, topLeft, topRight)
      const facingDown = topLeft >= bottomLeft && topRight >= bottomRight
      const facingLeft = bottomRight >= bottomLeft && topRight >= topLeft
      let texture = cliffTexture[index(x, y)]!
      // 15 names no set: the first other corner's, top left, top right, bottom right; else the second set.
      if (texture === 15) {
        const found = [index(x, y + 1), index(x + 1, y + 1), index(x + 1, y)].map(at => cliffTexture[at]!).find(value => value !== 15)
        if (found === undefined) texture = 1
        else cliffTexture[index(x, y)] = texture = found
      }
      if (!(facingDown && y === 0) && !(!facingDown && y >= rows - 2) && !(facingLeft && x === 0) && !(!facingLeft && x >= columns - 2)) {
        const vertical = isRamp(x, y) !== isRamp(x + 1, y) && isRamp(x, y + 1) !== isRamp(x + 1, y + 1)
        const horizontal = isRamp(x, y) !== isRamp(x, y + 1) && isRamp(x + 1, y) !== isRamp(x + 1, y + 1)
        if (vertical || horizontal) {
          let invalid = (vertical && isCliff(x, y + (facingDown ? -1 : 1))) || (horizontal && isCliff(x + (facingLeft ? -1 : 1), y))
          // A ramp over more than one level has no model; its first such corner is a ramp no more.
          if (!invalid)
            for (const [cx, cy] of [[x, y + 1], [x + 1, y + 1], [x + 1, y], [x, y]] as const)
              if (layer(cx, cy) - base > 1) {
                ramp[index(cx, cy)] = 0
                invalid = true
                break
              }
          const letter = (cx: number, cy: number) => {
            const height = layer(cx, cy) - base
            return isRamp(cx, cy) ? (height === 0 ? 'L' : 'H') : String.fromCharCode(65 + height)
          }
          const name = letter(x, y) + letter(x, y + 1) + letter(x + 1, y + 1) + letter(x + 1, y)
          if (!invalid && RAMP_NAMES.has(name)) {
            // The piece runs down the slope from the named cell, the high one.
            const px = x - (horizontal && facingLeft ? 1 : 0)
            const py = y - (vertical && facingDown ? 1 : 0)
            const same = pieces.findLastIndex(piece => piece.x === px && piece.y === py)
            if (same >= 0) pieces.splice(same, 1)
            pieces.push({ kind: 'ramp', name, x: px, y: py, width: horizontal ? 2 : 1, height: vertical ? 2 : 1, base, cliffTexture: texture, variation: 0 })
            const nx = x + (facingLeft ? -1 : 1) * (horizontal ? 1 : 0)
            const ny = y + (facingDown ? -1 : 1) * (vertical ? 1 : 0)
            romp[index(x, y)] = 1
            romp[index(nx, ny)] = 1
            for (const at of [index(x, y), index(x + 1, y), index(x, y + 1), index(x + 1, y + 1), index(nx, ny)]) cliffTexture[at] = texture
            continue
          }
        }
      }
      if (entrance(x, y)) continue
      pieces.push({
        kind: 'cliff',
        name: [bottomLeft, topLeft, topRight, bottomRight].map(level => String.fromCharCode(65 + level - base)).join(''),
        x,
        y,
        width: 1,
        height: 1,
        base,
        cliffTexture: texture,
        variation: corner(x, y)?.cliffVariation ?? 0,
      })
    }

  const result: TerrainPieces = {
    pieces,
    rampLift(x, y) {
      for (let dx = -1; dx <= 0; dx += 1)
        for (let dy = -1; dy <= 0; dy += 1) {
          const cx = x + dx
          const cy = y + dy
          if (!inCells(cx, cy)) continue
          const base = Math.min(layer(cx, cy), layer(cx + 1, cy), layer(cx, cy + 1), layer(cx + 1, cy + 1))
          if (layer(x, y) === base && entrance(cx, cy)) return 0.5
        }
      return 0
    },
    groundCliff(x, y) {
      for (let dx = -1; dx <= 0; dx += 1)
        for (let dy = -1; dy <= 0; dy += 1) {
          const cx = x + dx
          const cy = y + dy
          if (cx < 0 || cy < 0 || cx >= columns || cy >= rows) continue
          // Sloped ground no ramp piece claimed keeps its own tileset.
          if (isCliff(cx, cy) && isRamp(cx, cy) && isRamp(cx + 1, cy) && isRamp(cx, cy + 1) && isRamp(cx + 1, cy + 1) &&
              romp[index(cx, cy)] === 0 && romp[index(cx + 1, cy)] === 0 && romp[index(cx, cy + 1)] === 0 && romp[index(cx + 1, cy + 1)] === 0)
            return undefined
          if (romp[index(cx, cy)] === 1 || isCliff(cx, cy)) {
            const texture = cliffTexture[index(cx, cy)]!
            return texture === 15 ? 1 : texture
          }
        }
      return undefined
    },
  }
  cache.set(terrain, result)
  return result
}
