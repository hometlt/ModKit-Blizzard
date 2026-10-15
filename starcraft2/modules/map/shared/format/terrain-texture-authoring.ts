/**
 * SC2 Maps owner: author one or several native terrain palettes (1–8 ordered MASK slots).
 * Connects t3Terrain.xml's tileSet, textureSetList, textureList and block assignments
 * to CTerrain.BlendTextures in TerrainData.xml. Imported CTerrainTex definitions
 * belong to TerrainTexData.xml; stock IDs remain references to dependencies.
 * Uses the existing editor XML reader/writer and preserves unrelated elements,
 * including cliff/ramp geometry and catalog Lighting. Does not infer source-game
 * material matches, rasterize weights, encode media or qualify Editor rendering.
 * Defaults to set 0; explicit blockPalettes assign up to eight sets. Callers supply matching MASK
 * slot order and retain/package the referenced media through existing owners.
 */
import { readEditorXml, writeEditorXml, type EditorXmlElement } from './formats/editor-xml.js'

export interface TerrainPaletteTexture {
  id: string
  /** Omit for a material already supplied by the map's dependencies. */
  diffuse?: string
  normal?: string
}

export interface TerrainPaletteInput {
  terrainXml: string
  terrainDataXml: string
  terrainTexDataXml?: string
  terrainId: string
  textures: readonly TerrainPaletteTexture[]
  /** Repeats across the whole native map, then UV offsets (t3Terrain.xml). */
  uvTiling: readonly [number, number, number, number]
  /** Explicit block-local palettes; absent retains the established single-set behavior.
   * Block indices are native south-first row-major, each block spans eight terrain cells. */
  blockPalettes?: {
    readonly sets: readonly { readonly id: string; readonly textureIds: readonly string[] }[]
    readonly assignments: readonly number[]
  }
}

/** Construct an element for the existing native XML serializer. */
const element = (name: string, attributes: Record<string, string>, children: readonly EditorXmlElement[] = []): EditorXmlElement =>
  ({ name, attributes, children, text: '' })

/** Reject XML control characters before the XML owner performs escaping. */
function checkedText(value: string, label: string): string {
  if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid ${label}`)
  return value
}

/** Replace named children without dropping unrelated native fields. */
function replaceChildren(parent: EditorXmlElement, replacements: readonly EditorXmlElement[]): EditorXmlElement {
  const names = new Set(replacements.map(child => child.name))
  const emitted = new Set<string>()
  const children = parent.children.flatMap(child => {
    if (!names.has(child.name)) return [child]
    if (emitted.has(child.name)) return []
    emitted.add(child.name)
    return replacements.filter(replacement => replacement.name === child.name)
  })
  children.push(...replacements.filter(child => !emitted.has(child.name)))
  return { ...parent, children }
}

/** Upsert one catalog identity, refusing ambiguous duplicate entries. */
function upsertCatalog(root: EditorXmlElement, entry: EditorXmlElement): EditorXmlElement {
  const matches = root.children.filter(child => child.name === entry.name && child.attributes['id'] === entry.attributes['id'])
  if (matches.length > 1) throw new TypeError(`Duplicate catalog identity ${entry.attributes['id']}`)
  const previous = matches[0]
  const updated = previous ? replaceChildren(previous, entry.children) : entry
  return { ...root, children: previous ? root.children.map(child => child === previous ? updated : child) : [...root.children, updated] }
}

/** Author a complete single-palette binding; geometry and binary MASK bytes stay with their owners. */
export function authorTerrainTexturePalette(input: TerrainPaletteInput): {
  terrainXml: string; terrainDataXml: string; terrainTexDataXml: string
} {
  const id = checkedText(input.terrainId, 'terrain ID')
  if (input.textures.length < 1 || input.textures.length > (input.blockPalettes ? 64 : 8)) throw new RangeError('A native terrain palette requires 1–8 textures per set (64 total)')
  if (new Set(input.textures.map(texture => texture.id)).size !== input.textures.length) throw new TypeError('Duplicate terrain texture ID')
  if (input.uvTiling.length !== 4 || !input.uvTiling.every(Number.isFinite) || input.uvTiling[0] <= 0 || input.uvTiling[1] <= 0)
    throw new RangeError('Invalid terrain UV tiling')
  const terrain = readEditorXml(input.terrainXml, 'terrain', 't3Terrain.xml')
  const version = Number(terrain.attributes['version'])
  if (!Number.isSafeInteger(version) || version < 114 || version > 115) throw new RangeError('Palette authoring requires terrain XML version 114–115')
  const heightMaps = terrain.children.filter(child => child.name === 'heightMap')
  if (heightMaps.length !== 1) throw new TypeError('Expected one native heightMap')
  const heightMap = heightMaps[0]!
  const dimensions = (heightMap.attributes['dim'] ?? '').trim().split(/\s+/u).map(Number)
  if (dimensions.length !== 2 || !dimensions.every(n => Number.isSafeInteger(n) && n > 1 && n <= 257 && (n - 1) % 8 === 0))
    throw new RangeError('Native palette blocks require dimensions 9–257 on an eight-cell lattice')
  const blocks = ((dimensions[0]! - 1) / 8) * ((dimensions[1]! - 1) / 8)
  const sets = input.blockPalettes?.sets ?? [{ id, textureIds: input.textures.map(t => t.id) }]
  const assignments = input.blockPalettes?.assignments ?? Array<number>(blocks).fill(0)
  const defined = new Set(input.textures.map(t => t.id))
  if (sets.length < 1 || sets.length > 8 || new Set(sets.map(s => s.id)).size !== sets.length)
    throw new RangeError('Native terrain requires 1–8 uniquely named texture sets')
  const channels = new Map<string, number>()
  for (const set of sets) {
    checkedText(set.id, 'texture set ID')
    const occupied = set.textureIds.filter(Boolean)
    if (occupied.length < 1 || set.textureIds.length > 8 || new Set(occupied).size !== occupied.length || occupied.some(t => !defined.has(t)))
      throw new RangeError('Each set requires 1–8 unique declared textures')
    set.textureIds.forEach((texture, channel) => {
      if (!texture) return
      if (channels.has(texture) && channels.get(texture) !== channel) throw new RangeError(`Terrain texture ${texture} uses different channels across sets`)
      channels.set(texture, channel)
    })
  }
  if (assignments.length !== blocks || assignments.some(i => !Number.isSafeInteger(i) || i < 0 || i >= sets.length))
    throw new RangeError('Every native block needs a valid texture set assignment')
  let catalog = readEditorXml(input.terrainDataXml, 'Catalog', 'TerrainData.xml')
  let textures = readEditorXml(input.terrainTexDataXml ?? '<Catalog/>', 'Catalog', 'TerrainTexData.xml')
  if (catalog.children.some(child => child.name === 'CTerrainTex')) throw new TypeError('CTerrainTex belongs in TerrainTexData.xml')
  for (const texture of input.textures) {
    checkedText(texture.id, 'texture ID')
    if (texture.normal !== undefined && texture.diffuse === undefined) throw new TypeError('Imported normal requires a diffuse image')
    if (texture.diffuse === undefined && textures.children.some(child => child.name === 'CTerrainTex' && child.attributes['id'] === texture.id))
      throw new TypeError('Stock terrain texture is overridden locally; provide an explicit imported definition')
    if (texture.diffuse !== undefined) {
      if (texture.normal === undefined) throw new TypeError('Imported terrain texture requires an explicit normal image')
      textures = upsertCatalog(textures, element('CTerrainTex', { id: texture.id }, [
        element('Texture', { value: checkedText(texture.diffuse, 'diffuse path') }),
        element('Normalmap', { value: checkedText(texture.normal, 'normal path') }),
        element('HeightMapScale', { value: '0' }),
      ]))
    }
  }
  // Explicit indices replace inherited BlendTextures in the same MASK slot order.
  for (const set of sets) catalog = upsertCatalog(catalog, element('CTerrain', { id: set.id }, Array.from({ length: 8 }, (_, index) =>
    element('BlendTextures', { index: String(index), value: set.textureIds[index] ?? '' }))))
  const patchedHeightMap = replaceChildren({ ...heightMap, attributes: { ...heightMap.attributes, tileSet: id, uvtiling: input.uvTiling.join(' ') } }, [
    element('textureSetList', { num: '8' }, Array.from({ length: 8 }, (_, index) => element('textureSet', { i: String(index), name: sets[index]?.id ?? '' }))),
    element('textureList', { num: '64' }, Array.from({ length: 64 }, (_, index) => element('texture', { i: String(index), name: sets[Math.floor(index / 8)]?.textureIds[index % 8] ?? '' }))),
    element('blockTextureSetList', { num: String(blocks) }, assignments.map((set, index) => element('blockTextureSet', { i: String(index), tileSet: String(set) }))),
  ])
  return {
    terrainXml: writeEditorXml({ ...terrain, children: terrain.children.map(child => child === heightMap ? patchedHeightMap : child) }),
    terrainDataXml: writeEditorXml(catalog),
    terrainTexDataXml: writeEditorXml(textures),
  }
}
