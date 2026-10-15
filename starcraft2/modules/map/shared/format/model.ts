/**
 * Aggregate map model + shared types.
 *
 * `SC2MapData` is the single source of truth every layer above the codecs
 * consumes (io source/sink, map-image renderers). Every field is optional — a
 * map may not contain every embedded file — and `rawFiles` keeps every embedded
 * file verbatim so a write can be byte-exact even for formats not yet modelled.
 */

import type { HeightMapResult } from './formats/height-map.js'
import type { SyncHeightResult } from './formats/sync-height-map.js'
import type { CliffLevelResult } from './formats/sync-cliff-level.js'
import type { PathingInfoResult } from './formats/pathing-info.js'
import type { CellFlagsResult } from './formats/cell-flags.js'
import type { TextureMasksResult } from './formats/texture-masks.js'
import type { FluffDoodadResult } from './formats/fluff-doodad.js'
import type { WaterResult } from './formats/water.js'
import type { MapInfoResult } from './formats/map-info.js'
import type { TerrainInfo } from './terrain-params.js'
import type { PlacedObjectsResult } from './formats/objects.js'
import type { RegionsResult } from './formats/regions.js'
import type { SyncTextureInfoResult } from './formats/sync-texture-info.js'
import type { VertexColorResult } from './formats/vertex-color.js'
import type { BankListResult } from './formats/bank-list.js'
import type { PreloadResult } from './formats/preload.js'
import type { ScenarioPropertiesResult } from './formats/scenario-properties.js'
import type { EditorCategoriesResult } from './formats/editor-categories.js'
import type { LocalesResult } from './formats/locales.js'
import type { IncludesResult } from './formats/includes.js'
import type { FileHashResult } from './formats/file-hash.js'
import type { HardTileResult } from './formats/hard-tile.js'
import type { PaintedPathingResult } from './formats/painted-pathing.js'
import type { TerrainBinaryResult } from './formats/terrain-binary.js'
import type { AIDataResult } from './formats/ai-data.js'

export interface SC2MapData {
  info?: MapInfoResult
  height?: HeightMapResult
  syncHeight?: SyncHeightResult
  cliffLevel?: CliffLevelResult
  pathing?: PathingInfoResult
  cellFlags?: CellFlagsResult
  textureMasks?: TextureMasksResult
  fluff?: FluffDoodadResult
  water?: WaterResult
  terrain?: TerrainInfo
  /** Placed units, doodads, points, and cameras (from the `Objects` file). */
  objects?: PlacedObjectsResult
  /** Named trigger regions (from the `Regions` file). */
  regions?: RegionsResult
  /** Per-cell texture layer data (from `t3SyncTextureInfo`). */
  syncTextureInfo?: SyncTextureInfoResult
  /** Per-vertex terrain color paint strokes (from `t3VertCol`). */
  vertexColor?: VertexColorResult
  /** Bank file declarations (from `BankList`). */
  bankList?: BankListResult
  /** Preload hints listing catalog entities the map pre-warms (from `Preload`). */
  preload?: PreloadResult
  /** Map/scenario metadata: name, description, author, loading-screen settings (from `ScenarioProperties`). */
  scenarioProperties?: ScenarioPropertiesResult
  /** Custom editor category definitions (from `GameData/EditorCategoryData.xml`). */
  editorCategories?: EditorCategoriesResult
  /** Available locale codes (from `Locales.xml`). */
  locales?: LocalesResult
  /** Catalog XML include list (from `Includes.xml` / `GameData.xml`). */
  includes?: IncludesResult
  /** SHA-512 archive integrity hash (from `FileHash`). */
  fileHash?: FileHashResult
  /** Hard-tile placement data (from `t3HardTile`). Partially understood; raw bytes always preserved. */
  hardTile?: HardTileResult
  /** Painted pathing override layer (from `PaintedPathingLayer`). Raw pass-through — no public spec. */
  paintedPathing?: PaintedPathingResult
  /** Non-XML terrain geometry file (from `Terrain`). Raw pass-through — no public spec. */
  terrainBinary?: TerrainBinaryResult
  /** Custom AI document (from `AIData.xml`/`CustomAI`), see `formats/ai-data.ts`. */
  aiData?: AIDataResult

  /**
   * Every embedded file kept verbatim (archive name → bytes), including
   * formats this package does not yet parse. Guarantees lossless repack.
   */
  rawFiles: Map<string, Uint8Array>
}
