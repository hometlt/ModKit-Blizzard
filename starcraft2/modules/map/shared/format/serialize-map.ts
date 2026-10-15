/**
 * Serialize a `SC2MapData` model back to embedded files — inverse of
 * `parseMapEntries`. Starts from a copy of `rawFiles`, re-emits modeled fields
 * over their matching keys (so edits are reflected) and passes everything else
 * through verbatim. `terrain` is parse-only and never re-serialized.
 *
 * Also a browser-safe JSON interchange (`mapToJson` / `mapFromJson`).
 */

import type { SC2MapData } from './model.js'
import { parseMapEntries } from './parse-map.js'

const utf8enc = new TextEncoder()
import { writeHeightMap } from './formats/height-map.js'
import { writeSyncHeightMap } from './formats/sync-height-map.js'
import { writeSyncCliffLevel } from './formats/sync-cliff-level.js'
import { writePathingInfo } from './formats/pathing-info.js'
import { writeCellFlags } from './formats/cell-flags.js'
import { writeTextureMasks } from './formats/texture-masks.js'
import { writeFluffDoodad } from './formats/fluff-doodad.js'
import { writeWater } from './formats/water.js'
import { writeMapInfo } from './formats/map-info.js'
import { writeObjects } from './formats/objects.js'
import { writeRegions } from './formats/regions.js'
import { writeSyncTextureInfo } from './formats/sync-texture-info.js'
import { writeVertexColor } from './formats/vertex-color.js'
import { writeBankList } from './formats/bank-list.js'
import { writePreload } from './formats/preload.js'
import { writeScenarioProperties } from './formats/scenario-properties.js'
import { writeEditorCategories } from './formats/editor-categories.js'
import { writeLocales } from './formats/locales.js'
import { writeIncludes } from './formats/includes.js'
import { writeFileHash } from './formats/file-hash.js'
import { writeHardTile } from './formats/hard-tile.js'
import { writePaintedPathing } from './formats/painted-pathing.js'
import { writeTerrainBinary } from './formats/terrain-binary.js'
import { writeAIData } from './formats/ai-data.js'

interface WriteRoute {
  field: keyof SC2MapData
  canonical: string
  names: string[]
  write: (value: unknown) => Uint8Array
}

const WRITE_ROUTES: WriteRoute[] = [
  { field: 'info', canonical: 'MapInfo', names: ['mapinfo'], write: (v) => writeMapInfo(v as never) },
  { field: 'height', canonical: 't3HeightMap', names: ['t3heightmap', 'mapheightmap'], write: (v) => writeHeightMap(v as never) },
  { field: 'syncHeight', canonical: 't3SyncHeightMap', names: ['t3syncheightmap', 'mapsyncheightmap'], write: (v) => writeSyncHeightMap(v as never) },
  { field: 'cliffLevel', canonical: 't3SyncCliffLevel', names: ['t3syncclifflevel', 'mapsyncclifflevel'], write: (v) => writeSyncCliffLevel(v as never) },
  { field: 'pathing', canonical: 't3SyncPathingInfo', names: ['t3syncpathinginfo', 'mappathinginfo'], write: (v) => writePathingInfo(v as never) },
  { field: 'cellFlags', canonical: 't3CellFlags', names: ['t3cellflags', 'mapcellflags'], write: (v) => writeCellFlags(v as never) },
  { field: 'textureMasks', canonical: 't3TextureMasks', names: ['t3texturemasks', 'maptexturemasks'], write: (v) => writeTextureMasks(v as never) },
  { field: 'fluff', canonical: 't3FluffDoodad', names: ['t3fluffdoodad', 'mapfluffdoodad'], write: (v) => writeFluffDoodad(v as never) },
  { field: 'water', canonical: 't3Water', names: ['t3water', 'mapwater'], write: (v) => writeWater(v as never) },
  {
    field: 'objects',
    canonical: 'Objects',
    names: ['objects', 'mapobjects'],
    write: (v) => utf8enc.encode(writeObjects(v as never)),
  },
  {
    field: 'regions',
    canonical: 'Regions',
    names: ['regions', 'mapregions'],
    write: (v) => utf8enc.encode(writeRegions(v as never)),
  },
  {
    field: 'syncTextureInfo',
    canonical: 't3SyncTextureInfo',
    names: ['t3synctextureinfo', 'mapsyntextureinfo'],
    write: (v) => writeSyncTextureInfo(v as never),
  },
  {
    field: 'vertexColor',
    canonical: 't3VertCol',
    names: ['t3vertcol', 'mapvertexcolor'],
    write: (v) => writeVertexColor(v as never),
  },
  {
    field: 'bankList',
    canonical: 'BankList',
    names: ['banklist'],
    write: (v) => utf8enc.encode(writeBankList(v as never)),
  },
  {
    field: 'preload',
    canonical: 'Preload',
    names: ['preload'],
    write: (v) => utf8enc.encode(writePreload(v as never)),
  },
  {
    field: 'scenarioProperties',
    canonical: 'ScenarioProperties',
    names: ['scenarioproperties'],
    write: (v) => utf8enc.encode(writeScenarioProperties(v as never)),
  },
  {
    field: 'editorCategories',
    canonical: 'EditorCategoryData',
    names: ['editorcategorydata', 'editorcategories'],
    write: (v) => utf8enc.encode(writeEditorCategories(v as never)),
  },
  {
    field: 'locales',
    canonical: 'Locales.xml',
    names: ['locales.xml', 'locales'],
    write: (v) => utf8enc.encode(writeLocales(v as never)),
  },
  {
    field: 'includes',
    canonical: 'Includes.xml',
    names: ['includes.xml', 'gamedata.xml', 'includes'],
    write: (v) => utf8enc.encode(writeIncludes(v as never)),
  },
  {
    field: 'fileHash',
    canonical: 'FileHash',
    names: ['filehash'],
    write: (v) => writeFileHash(v as never),
  },
  {
    field: 'hardTile',
    canonical: 't3HardTile',
    names: ['t3hardtile', 'maphardtile'],
    write: (v) => writeHardTile(v as never),
  },
  {
    field: 'paintedPathing',
    canonical: 'PaintedPathingLayer',
    names: ['paintedpathinglayer'],
    write: (v) => writePaintedPathing(v as never),
  },
  {
    field: 'terrainBinary',
    canonical: 'Terrain',
    names: ['terrain'],
    write: (v) => writeTerrainBinary(v as never),
  },
  {
    field: 'aiData',
    canonical: 'AIData.xml',
    names: ['aidata.xml', 'aidata'],
    write: (v) => utf8enc.encode(writeAIData(v as never)),
  },
]

const WRITE_ROUTE_BY_NAME = new Map<string, WriteRoute>()
for (const r of WRITE_ROUTES) for (const n of r.names) WRITE_ROUTE_BY_NAME.set(n, r)

function basename(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return (slash === -1 ? name : name.slice(slash + 1)).toLowerCase()
}

export function serializeMapEntries(data: SC2MapData): Map<string, Uint8Array> {
  const out = new Map(data.rawFiles)
  const written = new Set<keyof SC2MapData>()
  for (const key of [...out.keys()]) {
    const route = WRITE_ROUTE_BY_NAME.get(basename(key))
    if (route && data[route.field] != null) {
      out.set(key, route.write(data[route.field]))
      written.add(route.field)
    }
  }
  for (const route of WRITE_ROUTES) {
    if (data[route.field] != null && !written.has(route.field)) {
      out.set(route.canonical, route.write(data[route.field]))
    }
  }
  return out
}

// --- browser-safe base64 + JSON interchange ---

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64C = Uint8Array.from(B64, (c) => c.charCodeAt(0))
const PAD = 0x3d

function base64Encode(bytes: Uint8Array): string {
  const len = bytes.length
  const outLen = Math.ceil(len / 3) * 4
  const chars = new Uint8Array(outLen)
  let o = 0
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < len ? bytes[i + 1]! : 0
    const b2 = i + 2 < len ? bytes[i + 2]! : 0
    chars[o++] = B64C[b0 >> 2]!
    chars[o++] = B64C[((b0 & 0x03) << 4) | (b1 >> 4)]!
    chars[o++] = i + 1 < len ? B64C[((b1 & 0x0f) << 2) | (b2 >> 6)]! : PAD
    chars[o++] = i + 2 < len ? B64C[b2 & 0x3f]! : PAD
  }
  let out = ''
  const CHUNK = 0x8000
  for (let i = 0; i < outLen; i += CHUNK) {
    out += String.fromCharCode(...chars.subarray(i, Math.min(i + CHUNK, outLen)))
  }
  return out
}

const B64_INV = (() => {
  const m = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i
  return m
})()

function base64Decode(str: string): Uint8Array {
  const clean = str.replace(/=+$/, '')
  const out = new Uint8Array((clean.length * 3) >> 2)
  let o = 0
  let buf = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INV[clean.charCodeAt(i)]!
    if (v < 0) continue
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

export interface MapJson {
  version: 1
  files: Record<string, string>
}

export function mapToJson(data: SC2MapData): string {
  const files = serializeMapEntries(data)
  const obj: Record<string, string> = {}
  for (const [name, bytes] of files) obj[name] = base64Encode(bytes)
  const json: MapJson = { version: 1, files: obj }
  return JSON.stringify(json)
}

export function mapFromJson(json: string): SC2MapData {
  const parsed = JSON.parse(json) as MapJson
  const files = new Map<string, Uint8Array>()
  for (const [name, b64] of Object.entries(parsed.files)) files.set(name, base64Decode(b64))
  return parseMapEntries(files)
}
