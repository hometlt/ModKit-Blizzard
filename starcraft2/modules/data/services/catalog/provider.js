/**
 * SC2 catalog analysis and resolved-workspace provider. Ordered native XML goes through the single
 * catalog engine/schema owner; localization line syntax goes through the public Strings owner.
 * Supplies dependency-aware effective entities, structure defaults, typed links, localization,
 * compact authoring indexes, provenance and Data/subject data sources. Workspace planning and
 * typed-edit/graph-isolation requests delegate to the existing Data edit owners, not a new writer.
 * Complete full-catalog plans separately name active-root creation destinations, so truthful
 * listings of empty mods do not remove namespace-entry authoring; these names request no reads.
 * Public surfaces: providers/{catalog-analysis,resolved-data}/provider.json and @modkit/sdk/data.
 * Uses bounded revision-pinned document snapshots, resource-plan accounting, output limits and
 * cancellation; incomplete dependencies/schema evidence stay explicit. This service does not read
 * CASC/MPQ or installations itself, execute Galaxy, render UI or claim universal native writing.
 * The analysis core — which documents load, their typed parse, resolution through catalog-engine —
 * is catalog-analysis.ts, shared with the Data session of a loaded mod (data-session.ts), so a full
 * analysis and a session answer the same values and provenance.
 * A session's full projection reuses its retained parse/inheritance state after the same input
 * validation; localization, usage relations, normalization and resource evidence still run here.
 * Root-scoped ModContext queries bind the full retained snapshot to SHA-256 checked Host inputs,
 * consume bounded facets and rebind only declared source positions. Typed previews fork that
 * canonical ordered model; standalone/partial plans retain the existing complete analyzer.
 * Native edit/isolation and card/table/calculation owners load only when their asynchronous
 * operation is requested, so opening the retained catalog avoids unused UI/authoring imports.
 */
import { parseSc2StringsOrdered } from '@modkit/blizzard-starcraft2/strings/core'
import {
  EDITOR_CATEGORIES_PATH,
  GAMEDATA_INCLUDES_PATH,
  KNOWN_CATALOG_FILES,
  editorCategoriesMetadata,
  effectiveSchemas,
  parseCatalogDocuments,
  resolveThroughEngine,
  resolvedFieldsForSchemas,
} from '@modkit/blizzard-starcraft2/data/catalog-analysis'
import { buildStarcraft2AuthoringIndex } from '@modkit/blizzard-starcraft2/data/authoring-index'
import * as dataSdk from '@modkit/sdk/data'
import {
  STARCRAFT2_CATALOG_FILES,
  STARCRAFT2_DATA_SCHEMA_COVERAGE,
  STARCRAFT2_DATA_SCHEMA_PROVENANCE,
} from '../schema/full-data-schema.js'
import { normalizeStarcraft2ResolvedSnapshot } from './resolved-data-normalization.js'
import { queryStarcraft2ContextWorkspaceProjection } from '@modkit/blizzard-starcraft2/data/context-workspace-projection'
import { mapCatalogUsages } from '@modkit/blizzard-starcraft2/map/catalog-usages'

export { STARCRAFT2_DATA_SCHEMA_REVISION } from '../schema/data-schema-identity.js'
export {
  STARCRAFT2_DATA_NAMESPACES,
  STARCRAFT2_DATA_SCHEMAS,
  STARCRAFT2_DATA_SCHEMA_COVERAGE,
  STARCRAFT2_DATA_SCHEMA_PROVENANCE,
  STARCRAFT2_TYPE_NAMESPACES,
} from '../schema/full-data-schema.js'

const ANALYZER_ID = 'blizzard.starcraft2.data'
const GAME_ID = 'blizzard/starcraft-2'
const { DATA_CATALOG_ANALYSIS_CONTRACT, RESOLVED_DATA_WORKSPACE_CONTRACT, resolveDataCatalog } =
  dataSdk
const MAXIMUM_DOCUMENTS = 16_384
const MAXIMUM_TEXT_BYTES = 536_870_912
const MAXIMUM_DOCUMENT_BYTES = 67_108_864
const MAXIMUM_ENTITIES = 100_000
const MAXIMUM_DEPTH = 256
const MAXIMUM_QUERIES = 256
const MAXIMUM_LOCALIZATION_DOCUMENTS = 256
const MAXIMUM_LOCALES = 8
const MAXIMUM_LOCALIZATION_KEYS = 10_000
const MAXIMUM_REQUIREMENTS = 16_384
const MAXIMUM_PAGE_SIZE = 1_000
const MAXIMUM_SNAPSHOTS = 4
const MAXIMUM_AUTHORING_INDEX_BYTES = 48 * 1_024 * 1_024
const PRIORITY_CATALOG_FILES = Object.freeze([
  'sc2data.xml',
  'abildata.xml',
  'actordata.xml',
  'behaviordata.xml',
  'buttondata.xml',
  'effectdata.xml',
  'unitdata.xml',
  // Placed units' and doodads' footprints: what a map preview draws as blocked ground.
  'footprintdata.xml',
  'upgradedata.xml',
  'weapondata.xml',
  'modeldata.xml',
  'lightdata.xml',
  'terraindata.xml',
  'terraintexdata.xml',
  'waterdata.xml',
  'cliffdata.xml',
  'cliffdoodaddata.xml',
  'cliffmeshdata.xml',
  'terrainobjectdata.xml',
  'texturedata.xml',
])

const CATALOG_FILES = STARCRAFT2_CATALOG_FILES
/** A map's documents that name catalog entities; their usages become relations. */
const MAP_USAGE_FILES = Object.freeze(['objects', 'preload.xml'])
const isMapRoot = rootPath => /\.sc2map$/iu.test(rootPath)
const encoder = new TextEncoder()

const projectionFacet = contract => Object.freeze({ contract, major: 1 })
const LIVE_DEFINITION_FACETS = Object.freeze([
  projectionFacet('common.view/tree-data-source'),
  projectionFacet('common.view/table-data-source'),
  projectionFacet('common.view/relation-graph-source'),
])

function recordOf(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function positiveLimit(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}`)
  }
  return value
}

function normalizeLogicalPath(value, label) {
  nonEmptyString(value, label)
  if (value.includes('\0') || /^[a-z]:[\\/]/iu.test(value) || /^[\\/]/u.test(value)) {
    throw new TypeError(`${label} must be a confined logical path`)
  }
  const parts = []
  for (const part of value.replace(/\\/gu, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new TypeError(`${label} must not escape its workspace root`)
    parts.push(part.toLowerCase())
  }
  if (parts.length === 0) throw new TypeError(`${label} must name a logical path`)
  return parts.join('/')
}

function withOwnerMetadata(value, ownerMetadata) {
  return ownerMetadata === undefined || value.ownerMetadata === ownerMetadata
    ? value
    : Object.freeze({ ...value, ownerMetadata })
}

function localeId(value, label) {
  nonEmptyString(value, label)
  if (!/^[a-z]{2}(?:[-_]?[a-z]{2})?$/iu.test(value)) {
    throw new TypeError(`${label} must be a bounded language or language-region id`)
  }
  const normalized = value.replace(/[-_]/gu, '')
  return normalized.length === 2
    ? normalized.toLowerCase()
    : `${normalized.slice(0, 2).toLowerCase()}${normalized.slice(2).toUpperCase()}`
}

function validateWorkspacePlanRequest(request) {
  const value = recordOf(request)
  if (value === undefined) throw new TypeError('workspace data plan request must be an object')
  const workspace = recordOf(value.workspace)
  if (workspace === undefined || workspace.schemaVersion !== 1) {
    throw new TypeError('workspace data plan requires a ModWorkspaceLock v1')
  }
  if (workspace.gameId !== GAME_ID) {
    throw new TypeError(`StarCraft II data planning cannot inspect ${String(workspace.gameId)}`)
  }
  if (workspace.complete !== true) {
    throw new TypeError('workspace data plan requires a complete ModWorkspaceLock')
  }
  nonEmptyString(workspace.workspaceId, 'workspace.workspaceId')
  if (!Array.isArray(workspace.loadOrder) || !Array.isArray(workspace.sources)) {
    throw new TypeError('workspace data plan requires immutable loadOrder and sources')
  }
  const logicalRoots = Array.isArray(workspace.logicalRoots)
    ? workspace.logicalRoots
    : [...workspace.loadOrder].reverse()
  if (
    !Array.isArray(value.locales) ||
    value.locales.length === 0 ||
    value.locales.length > MAXIMUM_LOCALES
  ) {
    throw new TypeError(`locales must contain between one and ${MAXIMUM_LOCALES} entries`)
  }
  const locales = value.locales.map((locale, index) => localeId(locale, `locales[${index}]`))
  if (new Set(locales).size !== locales.length) throw new TypeError('locales must be unique')
  const maxRequirements = positiveLimit(
    value.maxRequirements,
    'maxRequirements',
    MAXIMUM_REQUIREMENTS,
  )
  const rootIds = new Set()
  for (const [index, root] of workspace.loadOrder.entries()) {
    const item = recordOf(root)
    if (item === undefined) throw new TypeError(`workspace.loadOrder[${index}] must be an object`)
    nonEmptyString(item.rootId, `workspace.loadOrder[${index}].rootId`)
    normalizeLogicalPath(item.sourcePath, `workspace.loadOrder[${index}].sourcePath`)
    if (rootIds.has(item.rootId)) throw new TypeError(`workspace root ${item.rootId} is duplicated`)
    rootIds.add(item.rootId)
  }
  const logicalRootIds = logicalRoots.map(root => root?.rootId)
  const logicalRootSet = new Set(logicalRootIds)
  if (
    logicalRoots.length !== workspace.loadOrder.length ||
    logicalRootSet.size !== logicalRoots.length ||
    logicalRootIds.some(rootId => !rootIds.has(rootId)) ||
    [...rootIds].some(rootId => !logicalRootSet.has(rootId))
  ) {
    throw new TypeError('workspace.logicalRoots must contain exactly the loadOrder roots')
  }
  return { workspace, logicalRoots, locales, maxRequirements }
}

const GAMEDATA_DIRECTORY = 'base.sc2data/gamedata'
// The host lists at most 64 directories per plan (`DATA_WORKSPACE_LISTING_LIMITS`).
const MAXIMUM_LISTING_QUERIES = 64

/**
 * What a complete listing of a root's GameData folder shows: the standard catalogs it holds, and
 * every other `*.xml` under it (flat or nested). The others are candidates only: the game loads them
 * when the root's `GameData.xml` declares them (Liberty declares CollectionSkin, SC2Events and its
 * WarChest seasons), which analysis checks against that file — a plan has no file text. Roots
 * without a complete listing keep the fixed list.
 */
function listedCatalogFiles(listings) {
  const byRoot = new Map()
  for (const listing of Array.isArray(listings) ? listings : []) {
    const item = recordOf(listing)
    if (item?.complete !== true || typeof item.rootId !== 'string' || !Array.isArray(item.paths) ||
        String(item.prefix).toLowerCase() !== GAMEDATA_DIRECTORY) continue
    const standard = new Set()
    const candidates = new Set()
    for (const path of item.paths) {
      const match = typeof path === 'string'
        ? /^base\.sc2data\/gamedata\/(.+\.xml)$/iu.exec(path.replaceAll('\\', '/'))
        : null
      if (match === null) continue
      const file = match[1].toLowerCase()
      if (KNOWN_CATALOG_FILES.has(file)) standard.add(file)
      else candidates.add(file)
    }
    byRoot.set(item.rootId, { standard, candidates: [...candidates].sort() })
  }
  return byRoot
}

/** Plan actual ordered reads and separate bounded prospective active catalogs through one owner. */
export async function planStarcraft2DataWorkspace(request) {
  request.signal?.throwIfAborted()
  const { workspace, logicalRoots, locales, maxRequirements } =
    validateWorkspacePlanRequest(request)
  const listed = listedCatalogFiles(request.listings)
  const planned = []
  const localizationRequirementCount = locales.length * logicalRoots.length
  const fullCatalogRequirementCount = workspace.loadOrder.length * (CATALOG_FILES.length + 1)
  const usageRequirementCount =
    workspace.loadOrder.filter(root => isMapRoot(root.sourcePath)).length * MAP_USAGE_FILES.length
  const fullCatalogCoverage =
    fullCatalogRequirementCount + usageRequirementCount + localizationRequirementCount <=
    maxRequirements
  const catalogFiles = fullCatalogCoverage
    ? CATALOG_FILES
    : PRIORITY_CATALOG_FILES
  for (const root of workspace.loadOrder) {
    const rootPath = normalizeLogicalPath(root.sourcePath, `${root.rootId}.sourcePath`)
    const present = fullCatalogCoverage ? listed.get(root.rootId) : undefined
    const files = present === undefined
      ? catalogFiles
      : [...catalogFiles.filter(file => present.standard.has(file)), ...present.candidates]
    if (present !== undefined && present.candidates.length > 0)
      planned.push(
        Object.freeze({
          requirementId: `gamedata-includes:${root.rootId}`,
          rootId: root.rootId,
          path: `${rootPath}/${GAMEDATA_INCLUDES_PATH}`,
          kind: 'catalog',
          required: false,
        }),
      )
    for (const file of files) {
      planned.push(
        Object.freeze({
          requirementId: `catalog:${root.rootId}:${file}`,
          rootId: root.rootId,
          path: `${rootPath}/base.sc2data/gamedata/${file}`,
          kind: 'catalog',
          required: false,
        }),
      )
    }
    planned.push(
      Object.freeze({
        requirementId: `editor-categories:${root.rootId}`,
        rootId: root.rootId,
        path: `${rootPath}/${EDITOR_CATEGORIES_PATH}`,
        kind: 'catalog',
        required: false,
      }),
    )
  }
  for (const root of workspace.loadOrder) {
    const rootPath = normalizeLogicalPath(root.sourcePath, `${root.rootId}.sourcePath`)
    if (!isMapRoot(rootPath)) continue
    for (const file of MAP_USAGE_FILES) {
      planned.push(
        Object.freeze({
          requirementId: `usage:${root.rootId}:${file}`,
          rootId: root.rootId,
          path: `${rootPath}/${file}`,
          kind: 'usage',
          required: false,
        }),
      )
    }
  }
  // Locale priority is stronger than root priority; within one locale lookup is winner-first.
  for (const locale of locales) {
    for (const root of logicalRoots) {
      const rootPath = normalizeLogicalPath(root.sourcePath, `${root.rootId}.sourcePath`)
      planned.push(
        Object.freeze({
          requirementId: `localization:${locale}:${root.rootId}`,
          rootId: root.rootId,
          path: `${rootPath}/${locale.toLowerCase()}.sc2data/localizeddata/gamestrings.txt`,
          kind: 'localization',
          locale,
          required: false,
        }),
      )
    }
  }
  const truncated = planned.length > maxRequirements
  const requirements = Object.freeze(planned.slice(0, maxRequirements))
  const activeRoot = workspace.loadOrder.find(root => root.rootId === workspace.activeRootId)
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    gameId: workspace.gameId,
    analyzerId: ANALYZER_ID,
    requirements,
    ...(fullCatalogCoverage && !truncated && activeRoot !== undefined
      ? {
          creationCandidates: Object.freeze(CATALOG_FILES.map(file => Object.freeze({
            rootId: activeRoot.rootId,
            path: `${normalizeLogicalPath(activeRoot.sourcePath, `${activeRoot.rootId}.sourcePath`)}/base.sc2data/gamedata/${file}`,
          }))),
        }
      : {}),
    diagnostics: Object.freeze([
      ...(fullCatalogCoverage
        ? []
        : [
            Object.freeze({
              severity: 'warning',
              code: 'blizzard.starcraft2/data-plan-full-catalog-budget-unavailable',
              message: `full catalog planning needs ${fullCatalogRequirementCount + localizationRequirementCount} requirements; the ${maxRequirements}-requirement budget uses EditorCategories.xml, the official sc2data.xml bootstrap and ${PRIORITY_CATALOG_FILES.length - 1} Product-GA gameplay/render priority catalogs per root`,
            }),
          ]),
      ...(truncated
        ? [
            Object.freeze({
              severity: 'error',
              code: 'blizzard.starcraft2/data-plan-truncated',
              message: `workspace data plan requires ${planned.length} reads but maxRequirements is ${maxRequirements}`,
            }),
          ]
        : []),
    ]),
    complete: !truncated,
    // Ask once for each root's GameData folder, so the next plan names the catalogs it holds.
    ...(request.listings === undefined && fullCatalogCoverage &&
      workspace.loadOrder.length <= MAXIMUM_LISTING_QUERIES
      ? {
          listingQueries: Object.freeze(workspace.loadOrder.map(root =>
            Object.freeze({ rootId: root.rootId, prefix: GAMEDATA_DIRECTORY }))),
        }
      : {}),
  })
}

function validateRequest(request) {
  const value = recordOf(request)
  if (value === undefined) throw new TypeError('catalog analysis request must be an object')
  nonEmptyString(value.workspaceId, 'workspaceId')
  if (value.gameId !== GAME_ID) {
    throw new TypeError(`StarCraft II catalog analysis cannot inspect ${String(value.gameId)}`)
  }
  const maxDocuments = positiveLimit(value.maxDocuments, 'maxDocuments', MAXIMUM_DOCUMENTS)
  const maxTextBytes = positiveLimit(value.maxTextBytes, 'maxTextBytes', MAXIMUM_TEXT_BYTES)
  positiveLimit(value.maxEntities, 'maxEntities', MAXIMUM_ENTITIES)
  positiveLimit(value.maxDepth, 'maxDepth', MAXIMUM_DEPTH)
  if (!Array.isArray(value.documents) || value.documents.length > maxDocuments) {
    throw new TypeError(
      `documents must be an array with at most maxDocuments (${maxDocuments}) entries`,
    )
  }
  if (!Array.isArray(value.queries) || value.queries.length > MAXIMUM_QUERIES) {
    throw new TypeError(`queries must be an array with at most ${MAXIMUM_QUERIES} entries`)
  }
  const localizationDocuments = value.localizationDocuments ?? []
  if (
    !Array.isArray(localizationDocuments) ||
    localizationDocuments.length > MAXIMUM_LOCALIZATION_DOCUMENTS
  ) {
    throw new TypeError(
      `localizationDocuments must contain at most ${MAXIMUM_LOCALIZATION_DOCUMENTS} entries`,
    )
  }
  const usageDocuments = value.usageDocuments ?? []
  if (!Array.isArray(usageDocuments) || usageDocuments.length > maxDocuments) {
    throw new TypeError(`usageDocuments must contain at most maxDocuments (${maxDocuments}) entries`)
  }
  const locales = value.locales ?? []
  if (!Array.isArray(locales) || locales.length > MAXIMUM_LOCALES) {
    throw new TypeError(`locales must contain at most ${MAXIMUM_LOCALES} entries`)
  }
  const normalizedLocales = locales.map((locale, index) => localeId(locale, `locales[${index}]`))
  if (new Set(normalizedLocales).size !== normalizedLocales.length) {
    throw new TypeError('locales must be unique')
  }
  const localizationKeys = value.localizationKeys ?? []
  if (
    !Array.isArray(localizationKeys) ||
    localizationKeys.length > MAXIMUM_LOCALIZATION_KEYS ||
    !localizationKeys.every(key => typeof key === 'string' && key.length > 0)
  ) {
    throw new TypeError(
      `localizationKeys must contain at most ${MAXIMUM_LOCALIZATION_KEYS} non-empty strings`,
    )
  }
  let totalBytes = 0
  const validateDocument = (document, index, label) => {
    const item = recordOf(document)
    if (item === undefined) throw new TypeError(`${label}[${index}] must be an object`)
    nonEmptyString(item.rootId, `${label}[${index}].rootId`)
    nonEmptyString(item.path, `${label}[${index}].path`)
    if (typeof item.text !== 'string')
      throw new TypeError(`${label}[${index}].text must be a string`)
    const size = encoder.encode(item.text).byteLength
    if (size > MAXIMUM_DOCUMENT_BYTES) {
      throw new TypeError(`${label}[${index}] exceeds ${MAXIMUM_DOCUMENT_BYTES} bytes`)
    }
    totalBytes += size
    return item
  }
  value.documents.forEach((document, index) => validateDocument(document, index, 'documents'))
  localizationDocuments.forEach((document, index) => {
    const item = validateDocument(document, index, 'localizationDocuments')
    localeId(item.locale, `localizationDocuments[${index}].locale`)
  })
  usageDocuments.forEach((document, index) => validateDocument(document, index, 'usageDocuments'))
  if (totalBytes > maxTextBytes) {
    throw new TypeError(`document text exceeds maxTextBytes (${totalBytes} > ${maxTextBytes})`)
  }
  value.queries.forEach((query, index) => {
    const item = recordOf(query)
    if (item === undefined) throw new TypeError(`queries[${index}] must be an object`)
    nonEmptyString(item.namespace, `queries[${index}].namespace`)
    nonEmptyString(item.entityId, `queries[${index}].entityId`)
  })
  if (value.snapshotId !== undefined) nonEmptyString(value.snapshotId, 'snapshotId')
  return {
    ...value,
    localizationDocuments,
    usageDocuments,
    locales: normalizedLocales,
    localizationKeys,
  }
}

/** Adapt native last-line-wins Strings entries to winner-first Data patches with source evidence. */
function parseLocalizationDocument(document, documentIndex) {
  const locale = localeId(document.locale, `localizationDocuments[${documentIndex}].locale`)
  const patches = new Map()
  const diagnostics = []
  const source = Object.freeze({
    rootId: document.rootId,
    path: document.path,
    documentIndex,
    ...(document.revision === undefined ? {} : { revision: document.revision }),
  })
  for (const [lineIndex, line] of parseSc2StringsOrdered(document.text).lines.entries()) {
    if (line.raw.trim() === '' || /^\s*(?:#|\/\/)/u.test(line.raw)) continue
    if (!line.isEntry || line.key.length === 0) {
      diagnostics.push(
        Object.freeze({
          severity: 'warning',
          code: 'blizzard.starcraft2/localization-line-malformed',
          message: `${document.path}:${lineIndex + 1} has no non-empty key before '='`,
          source,
        }),
      )
      continue
    }
    const key = line.key.trim()
    if (key.length === 0 || key.includes('\0')) {
      diagnostics.push(
        Object.freeze({
          severity: 'warning',
          code: 'blizzard.starcraft2/localization-key-refused',
          message: `${document.path}:${lineIndex + 1} has an invalid localization key`,
          source,
        }),
      )
      continue
    }
    if (patches.has(key)) {
      diagnostics.push(
        Object.freeze({
          severity: 'warning',
          code: 'blizzard.starcraft2/localization-key-duplicate',
          message: `${document.path}:${lineIndex + 1} declares localization key ${key} more than once; the last declaration wins`,
          fieldId: key,
          source,
        }),
      )
    }
    patches.set(key, Object.freeze({ locale, key, value: line.value, source }))
  }
  return { patches: [...patches.values()], diagnostics }
}

function collectLocalizationValues(value, field, keys) {
  if (field.linkNamespace === '') {
    if (typeof value === 'string' && value.length > 0) keys.add(value)
    if (Array.isArray(value)) {
      for (const item of value) collectLocalizationValues(item, field, keys)
    }
  }
  if (field.fields === undefined) return
  const values = Array.isArray(value) ? value : [value]
  for (const item of values) {
    const record = recordOf(item)
    if (record === undefined) continue
    const nested = recordOf(record.value) ?? record
    for (const child of field.fields) {
      if (nested[child.fieldId] !== undefined) {
        collectLocalizationValues(nested[child.fieldId], child, keys)
      }
    }
  }
}

function localizationKeysFromPatches(patches, schemas) {
  const keys = new Set()
  for (const patch of patches) {
    const schema = schemas.get(patch.typeId)
    if (schema === undefined) continue
    const fields = new Map(
      resolvedFieldsForSchemas(patch.typeId, schemas).map(field => [field.fieldId, field]),
    )
    for (const [fieldId, value] of Object.entries(patch.fields)) {
      const field = fields.get(fieldId)
      if (field !== undefined) collectLocalizationValues(value, field, keys)
    }
  }
  return keys
}

function hashText(value) {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function snapshotIdentity(value) {
  const source = [
    value.snapshotId ?? '',
    value.workspaceId,
    ...value.documents.flatMap(document => [
      document.rootId,
      document.path,
      document.revision ?? '',
      hashText(document.text),
    ]),
    ...value.localizationDocuments.flatMap(document => [
      document.locale,
      document.rootId,
      document.path,
      document.revision ?? '',
      hashText(document.text),
    ]),
  ].join('\0')
  return `provider-token:sc2-data-${hashText(source)}`
}

function projectionEvidence(
  value,
  snapshotId,
  catalogDocuments,
  localizationDocuments,
  unresolvedRequirements,
) {
  const adapter = Object.freeze({ id: ANALYZER_ID, version: '1.1.0' })
  const projectionPlan = Object.freeze({
    adapter,
    subjectRevision: snapshotId,
    facets: Object.freeze(
      LIVE_DEFINITION_FACETS.map(ref => Object.freeze({ ref, state: 'published' })),
    ),
  })
  const projectionReceipt = Object.freeze({
    form: 'local',
    adapter,
    subjectRevision: snapshotId,
    companions: Object.freeze([]),
    basis: Object.freeze({
      handedness: 'right',
      upAxis: 'z',
      forwardAxis: '-y',
      unit: 'source-unit',
      sourceUnit: 'sc2-game-unit',
    }),
    planes: Object.freeze([
      Object.freeze({
        planeId: 'schema',
        state: 'normalized',
        note: `${STARCRAFT2_DATA_SCHEMA_COVERAGE.typeCount} native catalog schema types across ${STARCRAFT2_DATA_SCHEMA_COVERAGE.namespaceCount} namespaces from ${STARCRAFT2_DATA_SCHEMA_PROVENANCE.legacySchemaCommit}; ${STARCRAFT2_DATA_SCHEMA_PROVENANCE.digest}`,
      }),
      Object.freeze({
        planeId: 'effective-definitions',
        state: catalogDocuments === 0 ? 'lost' : 'normalized',
        note: `${catalogDocuments} ordered native catalog document(s); ${unresolvedRequirements} planned resource(s) unresolved`,
      }),
      Object.freeze({
        planeId: 'localization',
        state: localizationDocuments === 0 ? 'lost' : 'normalized',
        note:
          localizationDocuments === 0
            ? 'no requested localization resource resolved'
            : `${localizationDocuments} winner-first localization document(s); values may use an explicitly recorded locale fallback`,
      }),
      Object.freeze({
        planeId: 'relations',
        state: 'normalized',
        note: `${STARCRAFT2_DATA_SCHEMA_COVERAGE.linkFieldCount} generated typed link declarations normalize to relation edges, including explicit dead targets`,
      }),
    ]),
    evidence: Object.freeze([
      Object.freeze({
        kind: 'observed',
        statement: `${catalogDocuments} catalog and ${localizationDocuments} localization document(s) parsed through a revision-pinned workspace snapshot`,
      }),
      Object.freeze({
        kind: 'declared',
        statement: `schema provenance is pinned to legacy repository ${STARCRAFT2_DATA_SCHEMA_PROVENANCE.legacyRepositoryCommit} and schema source ${STARCRAFT2_DATA_SCHEMA_PROVENANCE.legacySchemaCommit}`,
      }),
    ]),
    confidence: unresolvedRequirements === 0 ? 'high' : 'partial',
  })
  return { projectionPlan, projectionReceipt }
}

/** The full projector's exact resource-plan accounting, shared with bounded context delivery. */
function validateWorkspaceAccounting(value) {
  const plannedDocumentCount = positiveLimit(value.plannedDocumentCount, 'plannedDocumentCount', MAXIMUM_REQUIREMENTS)
  if (!Array.isArray(value.unresolvedRequirementIds) ||
      !value.unresolvedRequirementIds.every(item => typeof item === 'string' && item.length > 0) ||
      new Set(value.unresolvedRequirementIds).size !== value.unresolvedRequirementIds.length ||
      value.documents.length + value.localizationDocuments.length + value.usageDocuments.length +
        value.unresolvedRequirementIds.length !== plannedDocumentCount) {
    throw new TypeError('resolved workspace analysis requires exact bounded resource-plan accounting')
  }
  return value.unresolvedRequirementIds.length
}

/** Validate full projection inputs without parsing, resolving, or reading another resource.
 * @param {import('@modkit/sdk/data').ResolvedDataWorkspaceAnalysisRequest} request
 * @returns {import('@modkit/sdk/data').ResolvedDataWorkspaceAnalysisRequest}
 */
export function validateStarcraft2ResolvedDataRequest(request) {
  request.signal?.throwIfAborted()
  const value = validateRequest(request)
  validateWorkspaceAccounting(value)
  return value
}

/** Shared standalone/session projection; validate before acquiring retained catalog state. */
async function analyzeStarcraft2DataInternal(request, includeWorkspaceFacets, authoringIndex = false, prepareCatalog) {
  request.signal?.throwIfAborted()
  const value = includeWorkspaceFacets ? validateStarcraft2ResolvedDataRequest(request) : validateRequest(request)
  if (authoringIndex) {
    positiveLimit(value.maxOutputBytes, 'maxOutputBytes', MAXIMUM_AUTHORING_INDEX_BYTES)
  }
  const localizationPatches = []
  const providerDiagnostics = []
  const unresolvedRequirements = includeWorkspaceFacets ? value.unresolvedRequirementIds.length : 0
  if (includeWorkspaceFacets) {
    if (unresolvedRequirements > 0) {
      providerDiagnostics.push(
        Object.freeze({
          severity: 'error',
          code: 'blizzard.starcraft2/data-plan-resources-unresolved',
          message: `${unresolvedRequirements} planned workspace data resource(s) did not resolve: ${value.unresolvedRequirementIds.join(', ')}`,
        }),
      )
    }
  }
  // Choose retained state only after the same input and resource-plan validation as standalone.
  const prepared = prepareCatalog?.(value)
  if (prepared !== undefined) {
    if (!includeWorkspaceFacets || authoringIndex ||
        prepared.maxDepth !== value.maxDepth || prepared.maxEntities !== value.maxEntities ||
        prepared.documents.length !== value.documents.length ||
        prepared.documents.some((document, index) => {
          const input = value.documents[index]
          return input.rootId !== document.rootId || input.path !== document.path ||
            input.text !== document.text || input.revision !== document.revision
        })) {
      throw new TypeError('prepared SC2 catalog does not match the validated projection inputs')
    }
    if (prepared.incomplete) {
      providerDiagnostics.push(Object.freeze({
        severity: 'error',
        code: 'blizzard.starcraft2/data-session-chain-incomplete',
        message: 'The loaded mod chain could not supply every catalog document',
      }))
    }
    providerDiagnostics.push(...prepared.diagnostics.slice(0, prepared.parsedDiagnosticCount))
  }
  // The catalog documents in the order the game loads them, typed by the catalog analysis core.
  const {
    patches,
    engineDocuments,
    structureDefaults,
    schemaExtensions,
    unverifiedTypes,
    unverifiedFields,
    unsupportedElements,
    anonymousEntities,
    editorCategories,
  } = prepared?.parsed ?? parseCatalogDocuments(value.documents, {
    includeWorkspaceFacets,
    maxDepth: value.maxDepth,
    maxEntities: value.maxEntities,
    signal: request.signal,
    diagnostics: providerDiagnostics,
  })
  value.localizationDocuments.forEach((document, documentIndex) => {
    const parsed = parseLocalizationDocument(document, documentIndex)
    localizationPatches.push(...parsed.patches)
    providerDiagnostics.push(...parsed.diagnostics)
  })
  request.signal?.throwIfAborted()
  if (unverifiedTypes.size > 0) {
    providerDiagnostics.push(
      Object.freeze({
        severity: 'warning',
        code: 'blizzard.starcraft2/data-schema-type-unverified',
        message: `${unverifiedTypes.size} installed catalog type(s) were preserved through an inferred schema extension: ${[...unverifiedTypes].sort().slice(0, 32).join(', ')}`,
      }),
    )
  }
  if (unverifiedFields.size > 0) {
    providerDiagnostics.push(
      Object.freeze({
        severity: 'warning',
        code: 'blizzard.starcraft2/data-schema-field-unverified',
        message: `${unverifiedFields.size} installed catalog field path(s) were preserved without claiming typed-link semantics: ${[...unverifiedFields].sort().slice(0, 32).join(', ')}`,
      }),
    )
  }
  if (unsupportedElements.size > 0) {
    providerDiagnostics.push(
      Object.freeze({
        severity: 'warning',
        code: 'blizzard.starcraft2/data-catalog-element-unsupported',
        message: `${unsupportedElements.size} non-catalog root element kind(s) were explicitly excluded: ${[...unsupportedElements].sort().slice(0, 32).join(', ')}`,
      }),
    )
  }
  if (anonymousEntities > 0) {
    providerDiagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.starcraft2/data-default-definitions-preserved',
        message: `${anonymousEntities} anonymous/default catalog declaration(s) were preserved with deterministic @default identities`,
      }),
    )
  }
  if (includeWorkspaceFacets) {
    providerDiagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.starcraft2/data-schema-full-coverage',
        message: `${STARCRAFT2_DATA_SCHEMA_COVERAGE.typeCount} types, ${STARCRAFT2_DATA_SCHEMA_COVERAGE.directFieldCount + STARCRAFT2_DATA_SCHEMA_COVERAGE.structureFieldCount} direct/structured fields, ${STARCRAFT2_DATA_SCHEMA_COVERAGE.linkFieldCount} typed links and ${STARCRAFT2_DATA_SCHEMA_COVERAGE.namespaceCount} namespaces loaded from ${STARCRAFT2_DATA_SCHEMA_PROVENANCE.legacySchemaCommit}; ${STARCRAFT2_DATA_SCHEMA_PROVENANCE.digest}`,
      }),
    )
  }
  const schemas = effectiveSchemas(schemaExtensions)
  const schemasByType = new Map(schemas.map(schema => [schema.typeId, schema]))
  const localizationKeys = localizationKeysFromPatches(patches, schemasByType)
  for (const key of value.localizationKeys) localizationKeys.add(key)
  const snapshotId = snapshotIdentity(value)
  const projection = projectionEvidence(
    value,
    snapshotId,
    value.documents.length,
    value.localizationDocuments.length,
    unresolvedRequirements,
  )
  const ownerMetadata = includeWorkspaceFacets ? editorCategoriesMetadata(editorCategories) : undefined
  const templateEntityKeys = patches
    .filter(patch => patch.defaultTemplate === true)
    .map(patch => `${patch.namespace}\0${patch.entityId}`)
  const engine = prepared?.resolution ?? resolveThroughEngine(patches, engineDocuments, value, providerDiagnostics)
  // Every entity resolves now, in declaration order, so missing parents report in that order.
  engine.entities()
  if (prepared !== undefined) {
    providerDiagnostics.push(...prepared.diagnostics.slice(prepared.parsedDiagnosticCount))
  }
  if (authoringIndex) {
    const index = buildStarcraft2AuthoringIndex({
      workspaceId: value.workspaceId,
      gameId: value.gameId,
      analyzerId: ANALYZER_ID,
      snapshotId,
      schemas,
      entities: engine.authoringEntities(structureDefaults),
      patchCount: patches.length,
      diagnostics: providerDiagnostics,
      ...(ownerMetadata === undefined ? {} : { ownerMetadata }),
      complete:
        unresolvedRequirements === 0 &&
        providerDiagnostics.every(diagnostic => diagnostic.severity !== 'error'),
      maxOutputBytes: value.maxOutputBytes,
    })
    return withOwnerMetadata(index, ownerMetadata)
  }
  const commonSnapshot = withOwnerMetadata(
    resolveDataCatalog({
      workspaceId: value.workspaceId,
      gameId: value.gameId,
      analyzerId: ANALYZER_ID,
      schemas,
      patches: engine.entities(),
      // The engine already resolved each entity flat; merging its patch again was ~4 s of a cold Void.
      patchesResolved: true,
      queries: value.queries,
      ...(includeWorkspaceFacets
        ? {
            localizationPatches,
            localePreferences: value.locales,
            localizationKeys: [...localizationKeys],
            diagnostics: providerDiagnostics,
            snapshotId,
            projectionPlan: projection.projectionPlan,
            projectionReceipt: projection.projectionReceipt,
            includeWorkspaceFacets: true,
            includeFieldSources: true,
            ...(ownerMetadata === undefined ? {} : { ownerMetadata }),
          }
        : {}),
      maxEntities: value.maxEntities,
      maxDepth: value.maxDepth,
    }),
    ownerMetadata,
  )
  const resolvedSnapshot = engine.provenance(commonSnapshot, includeWorkspaceFacets)
  const snapshot = includeWorkspaceFacets
    ? normalizeStarcraft2ResolvedSnapshot(
        withUsageRelations(resolvedSnapshot, value.usageDocuments),
        {
          templateEntityKeys,
        },
      )
    : resolvedSnapshot
  if (includeWorkspaceFacets || providerDiagnostics.length === 0) return snapshot
  return Object.freeze({
    ...snapshot,
    diagnostics: Object.freeze([...snapshot.diagnostics, ...providerDiagnostics]),
    complete:
      snapshot.complete && providerDiagnostics.every(diagnostic => diagnostic.severity !== 'error'),
  })
}

/**
 * The entities a map's placed objects and preload list name, as relations from those documents:
 * an entity lists them among its users, and a name that resolves to nothing is reported like any
 * dead catalog link.
 */
function withUsageRelations(snapshot, usageDocuments) {
  if (usageDocuments.length === 0) return snapshot
  const relations = usageDocuments.flatMap((document, documentIndex) =>
    mapCatalogUsages(document.path, document.text).map(usage =>
      Object.freeze({
        from: Object.freeze({ namespace: usage.document, entityId: usage.owner }),
        to: Object.freeze({ namespace: usage.namespace, entityId: usage.entityId }),
        role: usage.role,
        dead: false,
        source: Object.freeze({
          rootId: document.rootId,
          path: document.path,
          documentIndex,
          ...(document.revision === undefined ? {} : { revision: document.revision }),
        }),
      }),
    ),
  )
  return Object.freeze({ ...snapshot, relations: Object.freeze([...snapshot.relations, ...relations]) })
}

/** Existing catalog-analysis@1 behavior: no workspace/live additions on the wire. */
export const analyzeStarcraft2Data = request => analyzeStarcraft2DataInternal(request, false)

export const analyzeStarcraft2ResolvedData = request => analyzeStarcraft2DataInternal(request, true)

/**
 * The same complete workspace projection over a Data session's prepared canonical catalog.
 * The selector runs after existing byte/query/resource-plan validation and must return matching
 * native documents and bounds. It reuses parsing/inheritance only; localization, usages, schema
 * evidence, diagnostics, normalization and source provenance retain their existing owners.
 * @param {import('@modkit/sdk/data').ResolvedDataWorkspaceAnalysisRequest} request
 * @param {(request: import('@modkit/sdk/data').ResolvedDataWorkspaceAnalysisRequest) => import('./data-session.js').Starcraft2CatalogProjectionState} prepare
 * @returns {Promise<import('@modkit/sdk/data').ResolvedDataWorkspaceSnapshot>}
 */
export function projectStarcraft2ResolvedDataFromPreparedCatalog(request, prepare) {
  return analyzeStarcraft2DataInternal(request, true, false, prepare)
}

export const analyzeStarcraft2DataAuthoringIndex = request =>
  analyzeStarcraft2DataInternal(request, true, true)

export const abiVersion = 1
export const provides = Object.freeze([
  DATA_CATALOG_ANALYSIS_CONTRACT,
  RESOLVED_DATA_WORKSPACE_CONTRACT,
])

function createResolvedWorkspaceProvider(context) {
  const workspaces = new Map()
  const snapshots = new Map()
  const rememberWorkspace = (workspace, dataPlan) => {
    workspaces.delete(workspace.workspaceId)
    workspaces.set(workspace.workspaceId, Object.freeze({ workspace, dataPlan }))
    while (workspaces.size > MAXIMUM_SNAPSHOTS) workspaces.delete(workspaces.keys().next().value)
  }
  const remember = (snapshot, analysisRequest, canonicalContext = false) => {
    if (typeof snapshot.snapshotId !== 'string') {
      throw new TypeError('resolved workspace analyzer returned no snapshot identity')
    }
    const planned = workspaces.get(snapshot.workspaceId)
    snapshots.delete(snapshot.snapshotId)
    snapshots.set(
      snapshot.snapshotId,
      Object.freeze({
        snapshot,
        canonicalContext,
        analysisRequest: Object.freeze({ ...analysisRequest }),
        ...(planned === undefined ? {} : planned),
      }),
    )
    while (snapshots.size > MAXIMUM_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value)
    return snapshot
  }
  const entryFor = snapshotId => {
    nonEmptyString(snapshotId, 'snapshotId')
    const entry = snapshots.get(snapshotId)
    if (entry === undefined) {
      throw new RangeError(
        `snapshot ${snapshotId} is stale, unknown or evicted from this provider lease`,
      )
    }
    return entry
  }
  const editingEntryFor = snapshotId => {
    const entry = entryFor(snapshotId)
    if (entry.workspace === undefined || entry.dataPlan === undefined) {
      throw new RangeError(
        `snapshot ${snapshotId} has no pinned workspace plan; call plan before analyze`,
      )
    }
    return entry
  }
  /** Existing standalone projection or the fully bound canonical context projection. */
  const analyzeProjection = async (request, baseline, requireCanonical = false) => {
    const value = validateStarcraft2ResolvedDataRequest(request)
    const planned = workspaces.get(value.workspaceId)
    const retained = context?.modContexts === undefined || planned?.workspace === undefined
      ? undefined
      : await queryStarcraft2ContextWorkspaceProjection(context.modContexts, planned.workspace, value, baseline)
    if (retained === undefined) {
      if (requireCanonical) throw new TypeError('canonical Data edit preview no longer has its pinned loaded model')
      return { snapshot: await analyzeStarcraft2ResolvedData(value), canonicalContext: false }
    }
    const snapshotId = snapshotIdentity(value)
    const projection = projectionEvidence(value, snapshotId, value.documents.length,
      value.localizationDocuments.length, value.unresolvedRequirementIds.length)
    return { snapshot: Object.freeze({ ...retained, snapshotId,
      projectionPlan: projection.projectionPlan, projectionReceipt: projection.projectionReceipt }), canonicalContext: true }
  }
  /** Prospective edits fork the same canonical ordered model; standalone previews keep their owner. */
  const previewFor = entry => entry.canonicalContext !== true
    ? analyzeStarcraft2ResolvedData
    : async prospective => (await analyzeProjection(prospective, entry.analysisRequest, true)).snapshot
  const open = async (request, kind) => {
    request?.signal?.throwIfAborted()
    const maxPageSize = positiveLimit(request.maxPageSize, 'maxPageSize', MAXIMUM_PAGE_SIZE)
    const entry = entryFor(request?.snapshotId)
    const { openStarcraft2DataSource } = await import('../projections/data-sources.js')
    request?.signal?.throwIfAborted()
    return openStarcraft2DataSource(entry.snapshot, kind, maxPageSize, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  }
  // A card's sources open their declarations: the documents analysed and the roots they came from.
  const declarations = new WeakMap()
  const openSubjectFacts = async request => {
    request?.signal?.throwIfAborted()
    const entry = entryFor(request?.snapshotId)
    const { openStarcraft2SubjectFactsSource, provenanceDeclarations } = await import('../projections/data-sources.js')
    request?.signal?.throwIfAborted()
    let declare = declarations.get(entry)
    if (declare === undefined) {
      const analysed = entry.analysisRequest ?? {}
      declare = provenanceDeclarations(
        [...(analysed.documents ?? []), ...(analysed.localizationDocuments ?? [])],
        entry.workspace,
      )
      declarations.set(entry, declare)
    }
    return openStarcraft2SubjectFactsSource(entry.snapshot, request, declare)
  }
  const openSubjectCalculations = async request => {
    request?.signal?.throwIfAborted()
    const snapshot = entryFor(request?.snapshotId).snapshot
    const { openStarcraft2SubjectCalculationsSource } = await import('../projections/data-sources.js')
    request?.signal?.throwIfAborted()
    return openStarcraft2SubjectCalculationsSource(snapshot, request)
  }
  return Object.freeze({
    contract: RESOLVED_DATA_WORKSPACE_CONTRACT,
    providerId: ANALYZER_ID,
    gameIds: Object.freeze([GAME_ID]),
    plan: async request => {
      const dataPlan = await planStarcraft2DataWorkspace(request)
      rememberWorkspace(request.workspace, dataPlan)
      return dataPlan
    },
    analyze: async request => {
      const projected = await analyzeProjection(request)
      return remember(projected.snapshot, request, projected.canonicalContext)
    },
    openSchemaTree: request => open(request, 'schema-tree'),
    openDefinitionTable: request => open(request, 'definition-table'),
    openLocalizationTable: request => open(request, 'localization-table'),
    openRelations: request => open(request, 'relations'),
    /** Additive extension projection; it does not create another catalog or host registry. */
    openSubjectFacts,
    /** Strict read-only calculation projection over the same pinned catalog snapshot. */
    openSubjectCalculations,
    /** One resolver is shared by cards/tables/trees, code actions and MCP adapters. */
    resolveEditTarget: async request => {
      const entry = editingEntryFor(request?.snapshotId)
      const { resolveStarcraft2DataEditTarget } = await import('../editing/edit-target.js')
      return resolveStarcraft2DataEditTarget(entry, request)
    },
    /** Prospective bytes plus a fresh resolution; commit remains a host responsibility. */
    planEdit: async request => {
      const entry = editingEntryFor(request?.snapshotId)
      const { planStarcraft2DataEdit } = await import('../editing/edit-target.js')
      return planStarcraft2DataEdit(entry, request, previewFor(entry))
    },
    /** Read-only shared-object impact over the pinned resolved graph. */
    analyzeIsolation: async request => {
      const snapshot = entryFor(request?.snapshotId).snapshot
      const { analyzeStarcraft2GraphIsolation } = await import('../editing/graph-isolation.js')
      return analyzeStarcraft2GraphIsolation(snapshot, request)
    },
    /** Prospective clone plus exact-owner rewire; commit remains a host responsibility. */
    planIsolation: async request => {
      const entry = editingEntryFor(request?.snapshotId)
      const { planStarcraft2GraphIsolation } = await import('../editing/edit-target.js')
      return planStarcraft2GraphIsolation(entry, request, previewFor(entry))
    },
  })
}

export function createProvider(selection, context) {
  if (
    selection.major !== 1 ||
    (selection.contract !== DATA_CATALOG_ANALYSIS_CONTRACT &&
      selection.contract !== RESOLVED_DATA_WORKSPACE_CONTRACT)
  ) {
    throw new TypeError(
      `unsupported data-catalog selection ${selection.contract}@${selection.major}`,
    )
  }
  const value =
    selection.contract === DATA_CATALOG_ANALYSIS_CONTRACT
      ? Object.freeze({
          contract: DATA_CATALOG_ANALYSIS_CONTRACT,
          analyzerId: ANALYZER_ID,
          gameIds: Object.freeze([GAME_ID]),
          analyze: analyzeStarcraft2Data,
        })
      : createResolvedWorkspaceProvider(context)
  return Object.freeze({
    value,
    release: async () => undefined,
  })
}
