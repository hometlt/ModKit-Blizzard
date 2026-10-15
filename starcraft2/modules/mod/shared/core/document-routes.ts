/**
 * Stable metadata for document families recognised by `SC2ModReader`.
 *
 * The reader consumes these exact matchers, while coverage tooling consumes
 * the IDs. Keep the module dependency-free so it remains browser-safe.
 */

export interface ModDocumentRouteDescriptor {
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
  /** Case-insensitive archive-relative path matcher used by the loader. */
  readonly pathPattern: RegExp
}

function route<const Id extends string, const CoverageId extends string>(
  id: Id,
  coverageId: CoverageId,
  pathPattern: RegExp,
): ModDocumentRouteDescriptor & { readonly id: Id; readonly coverageId: CoverageId } {
  return { id, coverageId, pathPattern }
}

export const MOD_DOCUMENT_ROUTES = {
  catalogXml: route(
    'mod:catalog-xml',
    'catalog-xml',
    /^(?:base\.sc2data\/)?GameData\/[^/]+\.xml$/i,
  ),
  includeManifest: {
    ...route('mod:include-manifest', 'include-manifests', /^(?:base\.sc2data\/)?GameData\.xml$/i),
    canonicalPath: 'GameData.xml',
  },
  localizedStrings: route(
    'mod:localized-strings',
    'localized-strings',
    /^([a-z]{4})\.sc2data\/localizeddata\/([^/]+\.txt)$/i,
  ),
  layout: route('mod:layout', 'sc2-layout', /\.sc2layout$/i),
  editorCategories: route(
    'mod:editor-categories',
    'editor-categories',
    /^(?:base\.sc2data\/)?editordata\/editorcategories\.xml$/i,
  ),
  editorCategoryStrings: route(
    'mod:editor-category-strings',
    'editor-categories',
    /^([a-z]{4})\.sc2data\/localizeddata\/editor\/editorcategorystrings\.txt$/i,
  ),
  assetStrings: route(
    'mod:asset-strings',
    'asset-aliases',
    /^(?:base\.sc2data\/)?gamedata\/(assets|assetsproduct)\.txt$/i,
  ),
  bankList: route('mod:bank-list', 'bank-list', /(?:^|\/)BankList\.xml$/i),
  fontStyles: route('mod:font-styles', 'font-styles', /(?:^|\/)FontStyles\.SC2Style$/i),
  componentList: {
    ...route('mod:component-list', 'component-list', /^ComponentList\.SC2Components$/i),
    canonicalPath: 'ComponentList.SC2Components',
  },
  documentInfo: {
    ...route('mod:document-info', 'document-info', /^DocumentInfo$/i),
    canonicalPath: 'DocumentInfo',
  },
  documentHeader: route('mod:document-header', 'document-header', /^DocumentHeader$/i),
  versionFile: route('mod:version-file', 'version-file', /\.version$/i),
  opaqueFile: route('mod:opaque-file', 'unknown-raw-files', /^.*$/),
} as const

export const MOD_DOCUMENT_ROUTE_LIST: readonly ModDocumentRouteDescriptor[] = Object.freeze(
  Object.values(MOD_DOCUMENT_ROUTES),
)

const SEMANTIC_EXTENSIONS = new Set([
  'blizwiz', 'galaxy', 'json', 'sc2components', 'sc2layout', 'sc2style',
  'sc2triggers', 'txt', 'version', 'xml',
])

/** Text and metadata read for semantic resource views; binary assets stay in the VFS. */
export function isSemanticModEntry(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const name = normalized.split('/').at(-1) ?? normalized
  if (name === 'documentinfo' || name === 'componentlist.sc2components' ||
      MOD_DOCUMENT_ROUTES.documentHeader.pathPattern.test(normalized)) return true
  return SEMANTIC_EXTENSIONS.has(name.split('.').at(-1) ?? '')
}

export type ModDocumentRouteId =
  (typeof MOD_DOCUMENT_ROUTES)[keyof typeof MOD_DOCUMENT_ROUTES]['id']
