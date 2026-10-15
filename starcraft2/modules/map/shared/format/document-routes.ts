/**
 * Stable IDs and basename aliases consumed by the aggregate map loader.
 *
 * Keep this module data-only and browser-safe: coverage tooling imports it
 * without loading any of the binary/text codecs used by `parseMapEntries`.
 */

export interface MapDocumentRouteDescriptor {
  /** Stable loader route ID used by coverage and diagnostics tooling. */
  readonly id: string
  /**
   * Stable ID of the owning entry in the StarCraft II document-coverage inventory, which lives
   * at `extensions/blizzard/starcraft-2/src/document-coverage` since 2026-08-08 (it was
   * `@modkitx/document-registry`). Its suite asserts every route here names exactly one entry
   * there — the only thing anchoring this field, and it is not an import, so nothing breaks
   * loudly if the two drift.
   */
  readonly coverageId: string
  /** Lower-cased basenames accepted by the aggregate loader. */
  readonly names: readonly string[]
}

export const MAP_DOCUMENT_ROUTES = [
  { id: 'map:map-info', coverageId: 'map-info', names: ['mapinfo'] },
  {
    id: 'map:height-map',
    coverageId: 'map-height-layers',
    names: ['t3heightmap', 'mapheightmap'],
  },
  {
    id: 'map:sync-height-map',
    coverageId: 'map-height-layers',
    names: ['t3syncheightmap', 'mapsyncheightmap'],
  },
  {
    id: 'map:sync-cliff-level',
    coverageId: 'map-height-layers',
    names: ['t3syncclifflevel', 'mapsyncclifflevel'],
  },
  {
    id: 'map:pathing-info',
    coverageId: 'map-pathing-layers',
    names: ['t3syncpathinginfo', 'mappathinginfo'],
  },
  {
    id: 'map:cell-flags',
    coverageId: 'map-height-layers',
    names: ['t3cellflags', 'mapcellflags'],
  },
  {
    id: 'map:texture-masks',
    coverageId: 'map-texture-layers',
    names: ['t3texturemasks', 'maptexturemasks'],
  },
  {
    id: 'map:fluff-doodad',
    coverageId: 'map-terrain-decorations',
    names: ['t3fluffdoodad', 'mapfluffdoodad'],
  },
  {
    id: 'map:water',
    coverageId: 'map-terrain-decorations',
    names: ['t3water', 'mapwater'],
  },
  { id: 'map:terrain-xml', coverageId: 'map-terrain', names: ['t3terrain.xml'] },
  { id: 'map:objects', coverageId: 'map-objects', names: ['objects', 'mapobjects'] },
  { id: 'map:regions', coverageId: 'map-regions', names: ['regions', 'mapregions'] },
  {
    id: 'map:sync-texture-info',
    coverageId: 'map-texture-layers',
    names: ['t3synctextureinfo', 'mapsyntextureinfo'],
  },
  {
    id: 'map:vertex-color',
    coverageId: 'map-texture-layers',
    names: ['t3vertcol', 'mapvertexcolor'],
  },
  { id: 'map:bank-list', coverageId: 'bank-list', names: ['banklist'] },
  { id: 'map:preload', coverageId: 'preload', names: ['preload'] },
  {
    id: 'map:scenario-properties',
    coverageId: 'scenario-properties',
    names: ['scenarioproperties'],
  },
  {
    id: 'map:editor-categories',
    coverageId: 'editor-categories',
    names: ['editorcategorydata', 'editorcategories'],
  },
  {
    id: 'map:locale-manifest',
    coverageId: 'locale-manifests',
    names: ['locales.xml', 'locales'],
  },
  {
    id: 'map:include-manifest',
    coverageId: 'include-manifests',
    names: ['includes.xml', 'gamedata.xml', 'includes'],
  },
  { id: 'map:file-hash', coverageId: 'file-hash', names: ['filehash'] },
  {
    id: 'map:hard-tile',
    coverageId: 'map-pathing-layers',
    names: ['t3hardtile', 'maphardtile'],
  },
  {
    id: 'map:painted-pathing',
    coverageId: 'map-pathing-layers',
    names: ['paintedpathinglayer'],
  },
  { id: 'map:terrain-binary', coverageId: 'map-terrain', names: ['terrain'] },
  { id: 'map:ai-data', coverageId: 'ai-data', names: ['aidata.xml', 'aidata'] },
] as const satisfies readonly MapDocumentRouteDescriptor[]

export type MapDocumentRouteId = (typeof MAP_DOCUMENT_ROUTES)[number]['id']
