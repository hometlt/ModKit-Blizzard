/**
 * StarCraft tilesets (`tileset\<era>.cv5/.vx4ex/.vr4/.vf4/.wpe`) and the terrain they draw.
 *
 * A map tile (MTXM) names a tile group (`(tile >> 4) & 0x7ff`; bit 15 marks creep) and a variant in
 * it (`tile & 15`); the group
 * record in `.cv5` (52 bytes: 20 of group data, then 16 u16 megatile ids) gives the megatile. A
 * megatile is 4 × 4 minitiles: `.vx4ex` (Remastered, u32) or `.vx4` (classic, u16) holds each
 * minitile's reference — its id in `.vr4` shifted left once, bit 0 set when it is drawn mirrored
 * left to right. A `.vr4` minitile is 8 × 8 palette indices; `.wpe` is the 256-colour palette. So a
 * tile is 32 × 32 pixels. `.vf4` holds 16 u16 flags per megatile, one per minitile: bit 0 walkable,
 * bits 1–2 the ground level (0 low, 1 middle, 2 high).
 */

export interface Tileset {
  /** Megatile of every group and variant: `megatiles[group * 16 + variant]`. */
  readonly megatiles: Uint16Array
  /** Minitile reference of every megatile's minitile: `references[megatile * 16 + row * 4 + column]`. */
  readonly references: Uint32Array
  /** 8 × 8 palette indices per minitile. */
  readonly pixels: Uint8Array
  /** Flags of every megatile's minitile, in the order of `references`. */
  readonly flags: Uint16Array
  /** 256 RGBA8 colours. */
  readonly colors: Uint8Array
}

export interface TilesetFiles {
  readonly cv5: Uint8Array
  /** `.vx4ex` (u32 references) or, with `wide: false`, a classic `.vx4` (u16). */
  readonly vx4: Uint8Array
  readonly wide: boolean
  readonly vr4: Uint8Array
  readonly vf4: Uint8Array
  /** 256 RGBA8 colours, read from `.wpe` with codec-kit's palette reader. */
  readonly colors: Uint8Array
}

const GROUP_BYTES = 52
const GROUP_MEGATILES = 20
const MINITILE_BYTES = 64

export function readTileset(files: TilesetFiles): Tileset {
  const groups = Math.floor(files.cv5.byteLength / GROUP_BYTES)
  const cv5 = new DataView(files.cv5.buffer, files.cv5.byteOffset, files.cv5.byteLength)
  const megatiles = new Uint16Array(groups * 16)
  for (let group = 0; group < groups; group += 1)
    for (let variant = 0; variant < 16; variant += 1)
      megatiles[group * 16 + variant] = cv5.getUint16(group * GROUP_BYTES + GROUP_MEGATILES + 2 * variant, true)
  const width = files.wide ? 4 : 2
  const vx4 = new DataView(files.vx4.buffer, files.vx4.byteOffset, files.vx4.byteLength)
  const references = new Uint32Array(Math.floor(files.vx4.byteLength / width))
  for (let index = 0; index < references.length; index += 1)
    references[index] = files.wide ? vx4.getUint32(index * 4, true) : vx4.getUint16(index * 2, true)
  const vf4 = new DataView(files.vf4.buffer, files.vf4.byteOffset, files.vf4.byteLength)
  const flags = new Uint16Array(Math.floor(files.vf4.byteLength / 2))
  for (let index = 0; index < flags.length; index += 1) flags[index] = vf4.getUint16(index * 2, true)
  if (files.colors.byteLength !== 256 * 4) throw new RangeError('a tileset palette has 256 RGBA colours')
  return { megatiles, references, pixels: files.vr4, flags, colors: files.colors }
}

/**
 * The megatile a map tile draws; 0 (the tileset's null megatile) for a group the tileset lacks. Bit 15
 * of a map tile marks creep and is not part of the group (`(tile >> 4) & 0x7ff`, as the game reads it).
 */
export const megatileOf = (tileset: Tileset, tile: number) => tileset.megatiles[tile & 0x7fff] ?? 0

/**
 * RGBA pixels of the terrain window `x, y, width, height` — in pixels of the level, where level `m`
 * draws a tile as `32 >> m` pixels (level 5: one pixel a tile, the minimap). A level below 0 is not
 * drawn; a pixel of a coarser level is the full-size pixel at its top-left corner.
 */
// ponytail: nearest sampling for the coarser levels; a box filter when a smoother minimap matters.
export function renderTerrain(
  tiles: Uint16Array,
  mapWidth: number,
  tileset: Tileset,
  window: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  level = 0,
): Uint8Array {
  const step = 1 << level
  const rgba = new Uint8Array(window.width * window.height * 4)
  const mapHeight = Math.floor(tiles.length / mapWidth)
  for (let row = 0; row < window.height; row += 1) {
    const sourceY = (window.y + row) * step
    const tileY = sourceY >> 5
    if (tileY >= mapHeight) continue
    for (let column = 0; column < window.width; column += 1) {
      const sourceX = (window.x + column) * step
      const tileX = sourceX >> 5
      if (tileX >= mapWidth) continue
      const index = megatilePixel(tileset, megatileOf(tileset, tiles[tileY * mapWidth + tileX]!), sourceX & 31, sourceY & 31)
      const at = (row * window.width + column) * 4
      rgba[at] = tileset.colors[index * 4]!
      rgba[at + 1] = tileset.colors[index * 4 + 1]!
      rgba[at + 2] = tileset.colors[index * 4 + 2]!
      rgba[at + 3] = 255
    }
  }
  return rgba
}

/** The palette index of pixel (`x`, `y`) of a megatile, 0 ≤ x, y < 32. */
export function megatilePixel(tileset: Tileset, megatile: number, x: number, y: number): number {
  const reference = tileset.references[megatile * 16 + (y >> 3) * 4 + (x >> 3)] ?? 0
  const pixelX = reference & 1 ? 7 - (x & 7) : x & 7
  return tileset.pixels[(reference >>> 1) * MINITILE_BYTES + (y & 7) * 8 + pixelX] ?? 0
}

/** Megatiles a tileset atlas lays out per row. */
export const ATLAS_COLUMNS = 32

/** The tileset's megatiles as an atlas, `ATLAS_COLUMNS` a row, at `level` as in `renderTerrain`. */
export function renderAtlas(
  tileset: Tileset,
  window: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  level = 0,
): Uint8Array {
  const step = 1 << level
  const megatiles = Math.floor(tileset.references.length / 16)
  const rgba = new Uint8Array(window.width * window.height * 4)
  for (let row = 0; row < window.height; row += 1)
    for (let column = 0; column < window.width; column += 1) {
      const sourceX = (window.x + column) * step
      const sourceY = (window.y + row) * step
      const megatile = (sourceY >> 5) * ATLAS_COLUMNS + (sourceX >> 5)
      if ((sourceX >> 5) >= ATLAS_COLUMNS || megatile >= megatiles) continue
      const index = megatilePixel(tileset, megatile, sourceX & 31, sourceY & 31)
      const at = (row * window.width + column) * 4
      rgba[at] = tileset.colors[index * 4]!
      rgba[at + 1] = tileset.colors[index * 4 + 1]!
      rgba[at + 2] = tileset.colors[index * 4 + 2]!
      rgba[at + 3] = 255
    }
  return rgba
}

/** The flags of every minitile of the map, `mapWidth * 4` wide, row 0 at the north edge. */
export function minitileFlags(tiles: Uint16Array, mapWidth: number, tileset: Tileset): Uint16Array {
  const mapHeight = Math.floor(tiles.length / mapWidth)
  const flags = new Uint16Array(mapWidth * 4 * mapHeight * 4)
  for (let tileY = 0; tileY < mapHeight; tileY += 1)
    for (let tileX = 0; tileX < mapWidth; tileX += 1) {
      const megatile = megatileOf(tileset, tiles[tileY * mapWidth + tileX]!)
      for (let row = 0; row < 4; row += 1)
        for (let column = 0; column < 4; column += 1)
          flags[(tileY * 4 + row) * mapWidth * 4 + tileX * 4 + column] = tileset.flags[megatile * 16 + row * 4 + column] ?? 0
    }
  return flags
}
