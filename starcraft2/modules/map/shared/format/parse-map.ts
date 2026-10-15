/**
 * Parse-all: turn a set of embedded `.SC2Map` files into one `SC2MapData` model.
 *
 * Pure and browser-safe — the caller supplies the already-loaded files as a
 * `Map<name, bytes>` (from an MPQ, a ZIP, a folder, or a JSON dump). Container
 * loading lives in the `sc2-map` codec's Node entry (`openMap`); this is the routing core.
 *
 * Files are matched by **basename**, case-insensitively, accepting both the
 * editor names (`t3HeightMap`, `MapInfo`, …) and the MPQ aliases (`mapHeightMap`,
 * …). Every input file is kept verbatim in `rawFiles` so a later write stays
 * lossless even for formats this package does not model. Per-file parse failures
 * are non-fatal: the typed field is left unset, the raw bytes are still kept, and
 * the error (if any) is collected in the optional `onError` callback.
 */

import type { SC2MapData } from './model.js'
import { readHeightMap } from './formats/height-map.js'
import { readSyncHeightMap } from './formats/sync-height-map.js'
import { readSyncCliffLevel } from './formats/sync-cliff-level.js'
import { readPathingInfo } from './formats/pathing-info.js'
import { readCellFlags } from './formats/cell-flags.js'
import { readTextureMasks } from './formats/texture-masks.js'
import { readFluffDoodad } from './formats/fluff-doodad.js'
import { readWater } from './formats/water.js'
import { readMapInfo } from './formats/map-info.js'
import { parseTerrainXml } from './terrain-params.js'
import { readObjects } from './formats/objects.js'
import { readRegions } from './formats/regions.js'
import { readSyncTextureInfo } from './formats/sync-texture-info.js'
import { readVertexColor } from './formats/vertex-color.js'
import { readBankList } from './formats/bank-list.js'
import { readPreload } from './formats/preload.js'
import { readScenarioProperties } from './formats/scenario-properties.js'
import { readEditorCategories } from './formats/editor-categories.js'
import { readLocales } from './formats/locales.js'
import { readIncludes } from './formats/includes.js'
import { readFileHash } from './formats/file-hash.js'
import { readHardTile } from './formats/hard-tile.js'
import { readPaintedPathing } from './formats/painted-pathing.js'
import { readTerrainBinary } from './formats/terrain-binary.js'
import { readAIData } from './formats/ai-data.js'
import { MAP_DOCUMENT_ROUTES } from './document-routes.js'
import type { MapDocumentRouteId } from './document-routes.js'

const utf8 = new TextDecoder('utf-8')

type Assign = (data: SC2MapData, bytes: Uint8Array) => void

const ASSIGN_BY_ROUTE: Record<MapDocumentRouteId, Assign> = {
  'map:map-info': (d, b) => (d.info = readMapInfo(b)),
  'map:height-map': (d, b) => (d.height = readHeightMap(b)),
  'map:sync-height-map': (d, b) => (d.syncHeight = readSyncHeightMap(b)),
  'map:sync-cliff-level': (d, b) => (d.cliffLevel = readSyncCliffLevel(b)),
  'map:pathing-info': (d, b) => (d.pathing = readPathingInfo(b)),
  'map:cell-flags': (d, b) => (d.cellFlags = readCellFlags(b)),
  'map:texture-masks': (d, b) => (d.textureMasks = readTextureMasks(b)),
  'map:fluff-doodad': (d, b) => (d.fluff = readFluffDoodad(b)),
  'map:water': (d, b) => (d.water = readWater(b)),
  'map:terrain-xml': (d, b) => (d.terrain = parseTerrainXml(utf8.decode(b))),
  'map:objects': (d, b) => (d.objects = readObjects(utf8.decode(b))),
  'map:regions': (d, b) => (d.regions = readRegions(utf8.decode(b))),
  'map:sync-texture-info': (d, b) => (d.syncTextureInfo = readSyncTextureInfo(b)),
  'map:vertex-color': (d, b) => (d.vertexColor = readVertexColor(b)),
  'map:bank-list': (d, b) => (d.bankList = readBankList(utf8.decode(b))),
  'map:preload': (d, b) => (d.preload = readPreload(utf8.decode(b))),
  'map:scenario-properties': (d, b) =>
    (d.scenarioProperties = readScenarioProperties(utf8.decode(b))),
  'map:editor-categories': (d, b) => (d.editorCategories = readEditorCategories(utf8.decode(b))),
  'map:locale-manifest': (d, b) => (d.locales = readLocales(utf8.decode(b))),
  'map:include-manifest': (d, b) => (d.includes = readIncludes(utf8.decode(b))),
  'map:file-hash': (d, b) => (d.fileHash = readFileHash(b)),
  'map:hard-tile': (d, b) => (d.hardTile = readHardTile(b)),
  'map:painted-pathing': (d, b) => (d.paintedPathing = readPaintedPathing(b)),
  // The non-XML "Terrain" file (distinct from t3Terrain.xml).
  'map:terrain-binary': (d, b) => (d.terrainBinary = readTerrainBinary(b)),
  'map:ai-data': (d, b) => (d.aiData = readAIData(utf8.decode(b))),
}

const ROUTE_BY_NAME = new Map<string, Assign>()
for (const route of MAP_DOCUMENT_ROUTES) {
  const assign = ASSIGN_BY_ROUTE[route.id]
  for (const name of route.names) ROUTE_BY_NAME.set(name, assign)
}

function basename(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return (slash === -1 ? name : name.slice(slash + 1)).toLowerCase()
}

export interface ParseMapOptions {
  /** Called when a known file fails to parse (non-fatal). */
  onError?: (name: string, error: unknown) => void
}

export function parseMapEntries(
  files: Map<string, Uint8Array>,
  options: ParseMapOptions = {},
): SC2MapData {
  const data: SC2MapData = { rawFiles: new Map(files) }
  for (const [name, bytes] of files) {
    const assign = ROUTE_BY_NAME.get(basename(name))
    if (!assign) continue
    try {
      assign(data, bytes)
    } catch (error) {
      options.onError?.(name, error)
    }
  }
  return data
}
