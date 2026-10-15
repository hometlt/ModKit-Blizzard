/**
 * @module SC2 map format
 *
 * Read/write codecs for the binary files embedded in StarCraft II `.SC2Map`
 * archives. Pure and browser-safe (DataView only — no `node:*`).
 */

export {
  readHeightMap, writeHeightMap, levelFromCell, HEIGHT_MAP_MAGIC,
} from './formats/height-map.js'
export type { HeightCell, HeightMapResult, TerrainParams, TerrainGeometry } from './formats/height-map.js'

export {
  readSyncHeightMap, writeSyncHeightMap, SYNC_HEIGHT_MAGIC,
} from './formats/sync-height-map.js'
export type { SyncHeightCell, SyncHeightResult } from './formats/sync-height-map.js'

export {
  readSyncCliffLevel, writeSyncCliffLevel, dequantizeCliffLevel, SYNC_CLIFF_MAGIC,
} from './formats/sync-cliff-level.js'
export type { CliffLevelResult } from './formats/sync-cliff-level.js'

export {
  readPathingInfo, writePathingInfo, PATHING_INFO_MAGIC,
} from './formats/pathing-info.js'
export type { PathingInfoResult } from './formats/pathing-info.js'

export { readCellFlags, writeCellFlags, CELL_FLAGS_MAGIC } from './formats/cell-flags.js'
export type { CellFlagsResult } from './formats/cell-flags.js'

export { readCellAttribute, writeCellAttribute } from './formats/cell-attribute.js'
export type { CellAttributeResult, CellAttributeOptions } from './formats/cell-attribute.js'

export {
  readTextureMasks, writeTextureMasks, textureMaskWeight, extractLayerWeights, setTextureMaskWindow,
  TEXTURE_MASKS_MAGIC, TEXTURE_BLOCK_SIZE,
} from './formats/texture-masks.js'
export type { TextureMasksResult } from './formats/texture-masks.js'

export { readFluffDoodad, writeFluffDoodad, FLUFF_DOODAD_MAGIC } from './formats/fluff-doodad.js'
export type { FluffDoodad, FluffDoodadResult } from './formats/fluff-doodad.js'

export { readWater, writeWater, encodeWaterTemplateId, WATER_MAGIC } from './formats/water.js'
export type { WaterZone, WaterResult } from './formats/water.js'

export { readMapInfo, writeMapInfo, mapInfoEditorTerrainContext, setMapInfoEditorTerrainContext, MAP_INFO_MAGIC } from './formats/map-info.js'
export type { MapInfoResult } from './formats/map-info.js'

export { parseTerrainXml, CLIFF_CELL_FLAT, CLIFF_CELL_WALL, CLIFF_CELL_RAMP } from './terrain-params.js'
export type {
  CliffCell,
  TerrainInfo,
  TerrainRamp,
  TerrainRampFrame,
  TerrainTexture,
} from './terrain-params.js'

export { parseMapEntries } from './parse-map.js'
export type { ParseMapOptions } from './parse-map.js'
export { MAP_DOCUMENT_ROUTES } from './document-routes.js'
export type { MapDocumentRouteDescriptor, MapDocumentRouteId } from './document-routes.js'

export { serializeMapEntries, mapToJson, mapFromJson } from './serialize-map.js'
export type { MapJson } from './serialize-map.js'

export {
  readObjects, writeObjects, getObjectEntityLinks,
} from './formats/objects.js'
export type {
  PlacedUnit, PlacedDoodad, PlacedPoint, PlacedCamera,
  ObjectTexture, ObjectFlag, ObjectCameraValue,
  PlacedObjectsResult, ObjectEntityLink,
} from './formats/objects.js'

export { readRegions, writeRegions } from './formats/regions.js'
export type {
  MapRegion, RegionsResult, RegionShape, CircleShape, RectShape, DiamondShape, UnknownShape,
} from './formats/regions.js'

export {
  readSyncTextureInfo, writeSyncTextureInfo, SYNC_TEXTURE_INFO_MAGIC,
} from './formats/sync-texture-info.js'
export type { SyncTextureInfoResult } from './formats/sync-texture-info.js'

export {
  readVertexColor, writeVertexColor, VTCL_MAGIC, VTCL_VERSION,
} from './formats/vertex-color.js'
export type {
  VertexColorResult, VtclEntry, VtclEntryHeader,
} from './formats/vertex-color.js'

export { readBankList, writeBankList } from './formats/bank-list.js'
export type { BankEntry, BankListResult } from './formats/bank-list.js'

export { readPreload, writePreload, PRELOAD_TAG_LINKS } from './formats/preload.js'
export type { PreloadEntry, PreloadResult } from './formats/preload.js'

export {
  readPreloadAssetDb,
  writePreloadAssetDb,
  resolvePreloadAssetPaths,
  preloadAssetDbEntries,
} from './formats/preload-asset-db.js'
export type {
  PreloadAssetDbEntry,
  PreloadAssetDbResult,
  PreloadAssetDbSection,
} from './formats/preload-asset-db.js'

export { readScenarioProperties, writeScenarioProperties, getPropertyValue } from './formats/scenario-properties.js'
export type { PropertyEntry, ScenarioPropertiesResult } from './formats/scenario-properties.js'

export { readEditorCategories, writeEditorCategories, parseEditorCategoriesValue } from './formats/editor-categories.js'
export type { EditorCategory, EditorCategoryValue, EditorCategoriesResult } from './formats/editor-categories.js'

export { readLocales, writeLocales } from './formats/locales.js'
export type { LocaleEntry, LocalesResult } from './formats/locales.js'

export { readIncludes, writeIncludes } from './formats/includes.js'
export type { CatalogInclude, IncludesResult } from './formats/includes.js'

export { readFileHash, writeFileHash, fileHashToHex } from './formats/file-hash.js'
export type { FileHashResult } from './formats/file-hash.js'

export { readHardTile, writeHardTile, writeHardTile102, replaceHardTileGroups, repairHardTileGroupKeys } from './formats/hard-tile.js'
export type { HardTileResult, HardTileBlock, HardTileSubBlock, HardTileWriteBlock } from './formats/hard-tile.js'

export {
  readPaintedPathing, writePaintedPathing, paintedValueAt,
  PAINTED_GRID_SIZE, PAINTED_LAYER_BYTE_LENGTH,
} from './formats/painted-pathing.js'
export type { PaintedPathingResult } from './formats/painted-pathing.js'

export { readTerrainBinary, writeTerrainBinary } from './formats/terrain-binary.js'
export type { TerrainBinaryResult } from './formats/terrain-binary.js'

export { readAIData, writeAIData, writeEditorLayout as writeAIDataEditorLayout } from './formats/ai-data.js'
export { readAttributes, writeAttributes, writeAttributesEditorLayout } from './formats/attributes.js'
export type { AttributesResult, AttributeDefinition, AttributeValueDefinition } from './formats/attributes.js'
export type { EditorXmlElement } from './formats/editor-xml.js'
export type {
  AIDataResult, AIDataElement, CustomAiDefinition, CustomAiStep, CustomAiTime, CustomAiPoint, CustomAiUnit, DifficultyValues,
} from './formats/ai-data.js'

export { Cursor, Writer } from './binary.js'
export { placeCliffRampTemplate, widenDiagonalCliffRampTemplate, rankDiagonalCliffRampPlacements, writeTerrainRampList } from './ramp-authoring.js'
export type { CliffRampGrid, CliffRampTemplate, CliffRampPlacementCandidate } from './ramp-authoring.js'
export { authorTerrainTexturePalette } from './terrain-texture-authoring.js'
export type { TerrainPaletteInput, TerrainPaletteTexture } from './terrain-texture-authoring.js'
export type { SC2MapData } from './model.js'

export {
  authorCliffCells,
  cliffLetter,
  cliffLetterForLevel,
  cliffLevelOffsetZ,
  cliffVertexLevels,
  minCliffLevel,
  cliffTilesFromCells,
  cliffTilesFromLevels,
  cliffModelCandidates,
  rampCornerTiles,
  type AuthoredCliffTilesResult,
  type CliffTile,
  type CliffTileTransform,
  type CliffVertexLevels,
  type CliffModelCandidate,
} from './cliff-tiles.js'
