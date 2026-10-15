/**
 * `sc2-data` summary as narrow domain values: per-document operation states, capability traits,
 * metadata groups and single-source findings. The native codec projects these directly; the
 * legacy descriptor in `describe.ts` wraps them.
 */

import { DATA_OPERATION_IDS } from '../catalog-engine/operations.js'
import type { Sc2DataDocument } from './document.js'
import { SC2_DATA_CODEC_ID, SC2_DATA_XML_ROOT, dataBasename } from './identity.js'

type Scalar = string | number | boolean

export interface Sc2DataMetadataEntry {
  readonly id: string
  readonly label: string
  readonly value: Scalar | readonly string[]
  readonly kind?: 'text' | 'path' | 'id' | 'number' | 'boolean' | 'list'
}

export interface Sc2DataMetadataGroup {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly entries: readonly Sc2DataMetadataEntry[]
}

export interface Sc2DataTrait {
  readonly id: string
  readonly version: number
  readonly state: 'available' | 'partial' | 'dependency-required'
  readonly parameters: Readonly<Record<string, Scalar | readonly string[]>>
  readonly diagnosticIds?: readonly string[]
}

export interface Sc2DataFinding {
  readonly id: string
  readonly severity: 'error' | 'warning' | 'info'
  /** Historical dotted code, e.g. `sc2-data.single-source-context`. */
  readonly code: string
  readonly category: 'partial-support' | 'missing-companion' | 'malformed'
  readonly message: string
  readonly detail?: Readonly<Record<string, Scalar | readonly string[]>>
}

export interface Sc2DataOperationReason {
  readonly code: string
  readonly message: string
  readonly diagnosticIds?: readonly string[]
}

export interface Sc2DataOperationState {
  readonly state: 'available' | 'disabled' | 'dependency-required'
  readonly reason?: Sc2DataOperationReason
  readonly diagnosticIds?: readonly string[]
}

/** Raised when entities inherit from an ancestor outside the loaded document set. */
export const UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID = 'sc2-data.inheritance.chain-not-supplied'
export const MALFORMED_DOCUMENT_DIAGNOSTIC_ID = 'sc2-data.document.malformed'
/** Raised when no `CConst` entity is present to drive `##token##` substitution. */
export const MISSING_CONSTANTS_DIAGNOSTIC_ID = 'sc2-data.tokens.constants-not-supplied'
/** Raised because reference/diagnostic checks are limited to the loaded document set. */
export const SINGLE_SOURCE_DIAGNOSTIC_ID = 'sc2-data.context.single-source'

/**
 * Why `edit.content` degrades rather than staying `available` when the chain is incomplete.
 *
 * A catalog rename resolves token attributes through `<?token?>` declarations that live on
 * ancestors (`token-decls.ts`), so a missing ancestor does not merely narrow the result — it makes
 * a token-typed reference unrecognizable as a link, and the edit silently under-patches. That is
 * a correctness hazard, not a partial view, so the operation reports `dependency-required` with
 * the same diagnostics `edit.ts` attaches to the plan. Read-only operations that merely return
 * less (`sc2-data.resolve-inheritance`, `asset.search`, `export.convert`) stay `available` and
 * carry the diagnostics instead.
 */
export const CHAIN_REQUIRED_EDIT = {
  code: 'other',
  message:
    'Renaming catalog entities needs the full inheritance chain: `<?token?>` declarations live ' +
    'on ancestors, so token-typed references to a renamed entity would go unpatched. Open this ' +
    'catalog through a GameContentResolver-backed chain first.',
  diagnosticIds: [UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID, SINGLE_SOURCE_DIAGNOSTIC_ID],
} as const

export const NOT_IMPLEMENTED_CARDS = {
  code: 'not-implemented',
  message:
    'SC2 entity-card assembly lives in @modkitx/wiki and is absorbed into sc2-data in Phase D ' +
    '("Move SC2 entity-card assembly into sc2-data"); the descriptor serves catalog summary ' +
    'metadata only.',
} as const

export const CHAIN_REQUIRED_COMPARE = {
  code: 'other',
  message:
    'Comparing an entity across override layers needs the mod dependency chain. This codec ' +
    'opens one already-resolved source; a GameContentResolver-backed chain is owned by ' +
    'mods-processing and is not wired into the data domain yet.',
  diagnosticIds: [SINGLE_SOURCE_DIAGNOSTIC_ID],
} as const

/** Legacy operation ids in descriptor order. */
export const SC2_DATA_OPERATION_ORDER = Object.freeze([
  DATA_OPERATION_IDS.inspect,
  DATA_OPERATION_IDS.query,
  DATA_OPERATION_IDS.resolveInheritance,
  DATA_OPERATION_IDS.references,
  DATA_OPERATION_IDS.diagnostics,
  DATA_OPERATION_IDS.compare,
  DATA_OPERATION_IDS.edit,
  DATA_OPERATION_IDS.export,
  DATA_OPERATION_IDS.entityCards,
] as const)

/** One operation's state for this document. */
export function sc2DataOperationState(
  document: Sc2DataDocument,
  operationId: string,
): Sc2DataOperationState {
  const unresolved = document.stats.unresolvedParents.length
  switch (operationId) {
    case DATA_OPERATION_IDS.compare:
      return { state: 'disabled', reason: CHAIN_REQUIRED_COMPARE }
    case DATA_OPERATION_IDS.entityCards:
      return { state: 'disabled', reason: NOT_IMPLEMENTED_CARDS }
    // Inheritance still resolves — just not completely — so the operation stays available and
    // carries the diagnostic explaining what a caller will and will not get back.
    case DATA_OPERATION_IDS.resolveInheritance:
      return unresolved > 0
        ? { state: 'available', diagnosticIds: [UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID] }
        : { state: 'available' }
    // A rename that cannot see an ancestor's `<?token?>` declarations under-patches, which is a
    // correctness hazard rather than a narrower answer — so it degrades instead of warning.
    case DATA_OPERATION_IDS.edit:
      return unresolved > 0
        ? {
            state: 'dependency-required',
            reason: CHAIN_REQUIRED_EDIT,
            diagnosticIds: [UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID, SINGLE_SOURCE_DIAGNOSTIC_ID],
          }
        : { state: 'available' }
    // Export still produces real output; `mode: 'full'` is merely partially resolved.
    case DATA_OPERATION_IDS.export:
      return unresolved > 0
        ? {
            state: 'available',
            diagnosticIds: [UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID, SINGLE_SOURCE_DIAGNOSTIC_ID],
          }
        : { state: 'available' }
    case DATA_OPERATION_IDS.diagnostics:
    case DATA_OPERATION_IDS.references:
    case DATA_OPERATION_IDS.query:
      return { state: 'available', diagnosticIds: [SINGLE_SOURCE_DIAGNOSTIC_ID] }
    default:
      return { state: 'available' }
  }
}

/**
 * Catalog rename and catalog JSON/XML export landed in Phase D item 3; entity-card assembly
 * (still in @modkitx/wiki) has not. `catalog-edit-formatting` records the one thing the edit
 * surface genuinely cannot do: preserve comments and original XML formatting.
 */
export function sc2DataUnsupportedFeatures(document: Sc2DataDocument): string[] {
  const unsupported = ['catalog-edit-formatting', 'entity-cards']
  if (document.stats.unresolvedParents.length > 0) unsupported.push('dependency-chain-resolution')
  return unsupported
}

function entry(
  id: string,
  label: string,
  value: Sc2DataMetadataEntry['value'],
  kind?: Sc2DataMetadataEntry['kind'],
): Sc2DataMetadataEntry {
  return { id, label, value, ...(kind ? { kind } : {}) }
}

export function sc2DataFindings(document: Sc2DataDocument): Sc2DataFinding[] {
  const { stats } = document
  const diagnostics: Sc2DataFinding[] = []

  for (const file of document.files) {
    if (file.malformed === undefined) continue
    diagnostics.push({
      id: `${MALFORMED_DOCUMENT_DIAGNOSTIC_ID}:${file.path}`,
      severity: 'error',
      category: 'malformed',
      code: 'sc2-data.document-malformed',
      message: `${file.path} is not well-formed XML, so it contributes no catalog entries: ${file.malformed}`,
      detail: { path: file.path },
    })
  }

  if (stats.unresolvedParents.length > 0) {
    const sample = stats.unresolvedParents
      .slice(0, 5)
      .map(item => `${item.namespace}.${item.id} -> ${item.parent}`)
    diagnostics.push({
      id: UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID,
      severity: 'warning',
      category: 'partial-support',
      code: 'sc2-data.inheritance-chain-not-supplied',
      message:
        `${stats.unresolvedParents.length} entit${stats.unresolvedParents.length === 1 ? 'y' : 'ies'} ` +
        'inherit from an ancestor outside the loaded document set, so resolved fields are ' +
        'partially merged. Load the mod dependency chain to resolve them ' +
        `(e.g. ${sample.join('; ')}).`,
      detail: { unresolved: stats.unresolvedParents.length, sample },
    })
  }

  if (stats.constEntityCount === 0) {
    diagnostics.push({
      id: MISSING_CONSTANTS_DIAGNOSTIC_ID,
      severity: 'info',
      category: 'missing-companion',
      code: 'sc2-data.constants-not-supplied',
      message:
        'No CConst entity is loaded, so `##token##` substitution falls back to per-entity ' +
        'token declarations only. SC2 keeps global constants in a separate GameData file.',
    })
  }

  diagnostics.push({
    id: SINGLE_SOURCE_DIAGNOSTIC_ID,
    severity: 'info',
    category: 'partial-support',
    code: 'sc2-data.single-source-context',
    message:
      `Loaded ${document.files.length} catalog file(s). Reference existence, override ` +
      'comparison, and localized-text checks are evaluated against this set only; the full ' +
      'mod dependency chain is resolved by mods-processing, not by this codec.',
    detail: { files: document.files.map(file => file.path) },
  })

  return diagnostics
}

export function sc2DataTraits(document: Sc2DataDocument): Sc2DataTrait[] {
  const { stats, structure, files } = document
  const traits: Sc2DataTrait[] = []
  const unresolved = stats.unresolvedParents.length

  traits.push({
    id: 'game.catalog',
    version: 1,
    state: 'available',
    parameters: {
      types: stats.rootTypes.length,
      namespaces: stats.namespaces.length,
      entities: stats.entityCount,
    },
  })

  // The parent-chain tree. Real, but only fully walkable when every ancestor is present.
  traits.push({
    id: 'structure.hierarchy',
    version: 1,
    state: unresolved > 0 ? 'partial' : 'available',
    parameters: { nodes: stats.entityCount, lazy: false, unresolvedParents: unresolved },
    ...(unresolved > 0 ? { diagnosticIds: [UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID] } : {}),
  })

  // The dependency chain itself is never resolved here — that is a GameContentResolver's job.
  traits.push({
    id: 'source.dependencies',
    version: 1,
    state: unresolved > 0 ? 'dependency-required' : 'available',
    parameters: { count: files.length, resolved: files.length },
    diagnosticIds:
      unresolved > 0
        ? [UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID, SINGLE_SOURCE_DIAGNOSTIC_ID]
        : [SINGLE_SOURCE_DIAGNOSTIC_ID],
  })

  traits.push({
    id: 'code.source',
    version: 1,
    state: 'available',
    parameters: { language: 'xml', encoding: 'utf-8' },
  })

  traits.push({
    id: 'content.metadata',
    version: 1,
    state: 'available',
    parameters: {
      root: structure.hasCatalogRoot ? SC2_DATA_XML_ROOT : (structure.rootTag ?? ''),
      files: files.length,
    },
  })

  if (stats.constEntityCount > 0) {
    traits.push({
      id: 'content.styles',
      version: 1,
      state: 'available',
      parameters: { kinds: ['token'], count: stats.constEntityCount },
    })
  }

  return traits
}

export function sc2DataMetadata(document: Sc2DataDocument): Sc2DataMetadataGroup[] {
  const { stats, source, files, structure } = document
  return [
    {
      id: 'identity',
      label: 'GameData',
      order: 10,
      entries: [
        entry('name', 'Name', dataBasename(source.path || source.name), 'text'),
        entry('path', 'Path', source.path, 'path'),
        entry('codec', 'Codec', SC2_DATA_CODEC_ID, 'id'),
        entry('root', 'Root element', structure.rootTag ?? '', 'text'),
        entry('files', 'Loaded files', files.length, 'number'),
      ],
    },
    {
      id: 'catalog',
      label: 'Catalog',
      order: 20,
      entries: [
        entry('entities', 'Entities', stats.entityCount, 'number'),
        entry('namespaces', 'Namespaces', [...stats.namespaces], 'list'),
        entry('rootTypes', 'Entry types', [...stats.rootTypes], 'list'),
        entry('constants', 'Constant entities', stats.constEntityCount, 'number'),
      ],
    },
    {
      id: 'resolution',
      label: 'Resolution',
      order: 30,
      entries: [
        entry('unresolvedParents', 'Unresolved parents', stats.unresolvedParents.length, 'number'),
        entry(
          'chainSupplied',
          'Dependency chain supplied',
          stats.unresolvedParents.length === 0,
          'boolean',
        ),
      ],
    },
  ]
}

