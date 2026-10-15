/**
 * @module SC2 map image
 *
 * PNG in/out for StarCraft II map data: 16-bit grayscale for height maps and
 * cliff levels (lossless, round-trippable with a reference), and 8-bit RGB
 * false-color blends for texture masks (visualization).
 *
 * Browser-safe (uses `pako` for zlib). 3D surface export and real-texture (DDS)
 * compositing are out of scope — they live in the separate `m3` workspace.
 */

export {
  heightToPng,
  pngToHeight,
  cliffLevelToPng,
  pngToCliffLevel,
  pathingToPng,
  cellFlagsToPng,
  paintedPathingToPng,
  overlayToPng,
  composeOverlayToPng,
  vertexColorToPng,
  textureToPng,
} from './map-image.js'
export type {
  CellFlagsToPngOptions,
  ComposeOverlayOptions,
  HeightChannel,
  OverlayToPngOptions,
  PaintedPathingToPngOptions,
  PathingToPngOptions,
  TextureToPngOptions,
  VertexColorToPngOptions,
} from './map-image.js'

export {
  analyzeVertexCliffLevels,
  vertexCliffLevelsToPng,
  analyzeCellCliffLevels,
  cellCliffLevelsToPng,
  analyzeCliffLattice,
  analyzeCliffFaces,
  analyzeRamps,
  analyzeNoPathing,
  analyzeMapMarkers,
  analyzeMapCatalog,
  analyzeCliffLines,
  analyzePlayableBounds,
  placeFootprint,
  paintedSubCell,
  offsetStrands,
  smoothCliffLine,
  cliffLevelColor,
  latticeCorners,
  tileLevelField,
  tileFaceSegments,
  vertexLevelAt,
  renderMapOverview,
  mapOverviewToPng,
  MAP_OVERVIEW_DOCUMENTS,
  TILE_NONE,
  TILE_FLAT,
  TILE_WALL,
  TILE_RAMP,
} from './overview.js'
export type {
  CatalogEntity,
  CatalogSnapshot,
  CellCliffLevels,
  CliffLattice,
  CliffLine,
  Footprint,
  MapCatalog,
  ObjectData,
  ObjectKind,
  Point,
  MapMarker,
  MapMarkerKind,
  ResourceSupply,
  Strand,
  MapOverview,
  MapOverviewOptions,
  PathingMask,
  PlayableBounds,
  RampShape,
  RampSide,
  Rgb,
  Segment,
  VertexCliffLevels,
} from './overview.js'

export {
  encodeGray16,
  decodeGray16,
  encodeRGB8,
  decodePng,
} from './png.js'
export type { DecodedPng, ColorType } from './png.js'
