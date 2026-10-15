/**
 * `sc2-data` -> `AssetDescriptor` v1.
 *
 * Every trait state, operation state, metadata row, and diagnostic is derived from the loaded
 * document rather than declared statically. In particular the descriptor is where this codec
 * tells the truth about single-source context: a document whose entities inherit from outside
 * their own file reports `structure.hierarchy` as `partial` and `source.dependencies` as
 * `dependency-required`, each carrying a diagnostic, instead of advertising a fully resolved
 * catalog it does not have.
 *
 * Phase D item 3 consolidated the catalog/entity halves of `@modkitx/ops`'s `renameEntities` and
 * `@modkitx/export`'s catalog exporters into this codec, so `edit.content` and `export.convert`
 * are now backed by real implementations (`edit.ts`, `export.ts`). Operations still owned by
 * other packages — entity cards (`@modkitx/wiki`) and override-layer compare — remain declared
 * and reported `disabled` with a reason: listing them as available would be a lie, and omitting
 * them would hide section 9's Data row from a host enumerating the domain.
 */

import {
  ASSET_DESCRIPTOR_SCHEMA_VERSION,
  type ArtifactContext,
  type AssetConstraints,
  type AssetDescriptor,
  type AssetIdentity,
  type AssetOperationDescriptor,
  type CapabilityInstance,
  type MetadataGroup,
  type ViewerContributionDescriptor,
} from '@modkit/codec-kit/legacy/assets'
import { DATA_OPERATION_IDS } from '../catalog-engine/operations.js'
import type { AssetSourceDescriptor, DetectionResult } from '@modkit/codec-kit/legacy/assets'
import type { Sc2DataDocument } from './document.js'
import { SC2_DATA_CODEC_ID, SC2_DATA_CODEC_VERSION } from './identity.js'
import {
  CHAIN_REQUIRED_COMPARE,
  NOT_IMPLEMENTED_CARDS,
  sc2DataFindings,
  sc2DataMetadata,
  sc2DataOperationState,
  sc2DataTraits,
  sc2DataUnsupportedFeatures,
} from './summary.js'
export {
  MISSING_CONSTANTS_DIAGNOSTIC_ID,
  SINGLE_SOURCE_DIAGNOSTIC_ID,
  UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID,
} from './summary.js'

/** The legacy document: the domain document over full legacy source/detection DTOs. */
export type Sc2DataArtifactDocument = Sc2DataDocument<AssetSourceDescriptor, DetectionResult>


/** Stable handler ID for one of this codec's operations. */
export function sc2DataHandlerId(operationId: string): string {
  return `${SC2_DATA_CODEC_ID}.${operationId}`
}

/**
 * The codec-level operation table: what `sc2-data` can ever offer, covering section 9's Data row.
 *
 * `describe()` re-derives per-document states from this list, so the two can never drift.
 */
export const SC2_DATA_OPERATIONS: readonly AssetOperationDescriptor[] = Object.freeze([
  {
    id: DATA_OPERATION_IDS.inspect,
    state: 'available',
    mutatesSource: false,
    label: 'Inspect catalog',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.inspect),
    permissions: ['read-source'],
    outputs: [{ id: 'summary', label: 'Catalog summary', mediaType: 'application/json' }],
  },
  {
    id: DATA_OPERATION_IDS.query,
    state: 'available',
    mutatesSource: false,
    label: 'Browse and query entities',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.query),
    permissions: ['read-source'],
    outputs: [{ id: 'entities', label: 'Matching entities', mediaType: 'application/json' }],
  },
  {
    id: DATA_OPERATION_IDS.resolveInheritance,
    state: 'available',
    mutatesSource: false,
    label: 'Resolve inheritance',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.resolveInheritance),
    permissions: ['read-source'],
    outputs: [{ id: 'fields', label: 'Effective fields', mediaType: 'application/json' }],
  },
  {
    id: DATA_OPERATION_IDS.references,
    state: 'available',
    mutatesSource: false,
    label: 'Find references',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.references),
    permissions: ['read-source'],
    outputs: [{ id: 'references', label: 'Reference ranges', mediaType: 'application/json' }],
  },
  {
    id: DATA_OPERATION_IDS.diagnostics,
    state: 'available',
    mutatesSource: false,
    label: 'Validate GameData',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.diagnostics),
    permissions: ['read-source'],
    outputs: [
      { id: 'diagnostics', label: 'Validation diagnostics', mediaType: 'application/json' },
    ],
  },
  {
    id: DATA_OPERATION_IDS.compare,
    state: 'disabled',
    mutatesSource: false,
    label: 'Compare override layers',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.compare),
    reason: CHAIN_REQUIRED_COMPARE as NonNullable<AssetOperationDescriptor['reason']>,
  },
  {
    id: DATA_OPERATION_IDS.edit,
    state: 'available',
    // Matching the sc2-document-metadata / sc2-mod convention: the transaction produces
    // AssetOutputs plus an AssetEditPlan; persisting them back to the AssetSource is the host's
    // job, so the codec itself never writes.
    mutatesSource: false,
    label: 'Rename catalog entities',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.edit),
    permissions: ['read-source', 'write-workspace'],
    // Edited GameData files are rebuilt from parsed entries, so comments and original
    // formatting are normalized. See edit.ts's reserialized diagnostic.
    preservesUnknownData: false,
    outputs: [
      {
        id: 'gamedata',
        label: 'Rewritten GameData XML',
        mediaType: 'application/xml',
        multiple: true,
        lossy: true,
      },
    ],
  },
  {
    id: DATA_OPERATION_IDS.export,
    state: 'available',
    mutatesSource: false,
    label: 'Export catalog',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.export),
    permissions: ['read-source'],
    outputs: [
      { id: 'json', label: 'Catalog JSON', mediaType: 'application/json' },
      {
        id: 'gamedata',
        label: 'Catalog GameData XML',
        mediaType: 'application/xml',
        multiple: true,
      },
    ],
  },
  {
    id: DATA_OPERATION_IDS.entityCards,
    state: 'disabled',
    mutatesSource: false,
    label: 'Entity cards',
    handlerId: sc2DataHandlerId(DATA_OPERATION_IDS.entityCards),
    reason: NOT_IMPLEMENTED_CARDS as NonNullable<AssetOperationDescriptor['reason']>,
  },
])

/** Viewer contributions this codec offers; the shell maps the IDs to real components. */
export const SC2_DATA_CONTRIBUTIONS: readonly ViewerContributionDescriptor[] = Object.freeze([
  {
    id: 'sc2-data.entities',
    kind: 'tree',
    priority: 60,
    label: 'Catalog entities',
    requiresTraits: [{ id: 'game.catalog' }],
  },
  {
    id: 'sc2-data.entity-fields',
    kind: 'panel',
    priority: 50,
    label: 'Effective fields',
    // Inheritance resolution degrades to `partial` without the chain, but the panel still shows
    // real (partially merged) fields, so the requirement accepts that state explicitly.
    requiresTraits: [{ id: 'structure.hierarchy', states: ['available', 'partial'] }],
    requiresOperations: [DATA_OPERATION_IDS.resolveInheritance],
  },
  {
    id: 'sc2-data.source',
    kind: 'stage',
    priority: 40,
    label: 'GameData XML',
    requiresTraits: [{ id: 'code.source' }],
  },
  {
    id: 'sc2-data.diagnostics',
    kind: 'panel',
    priority: 30,
    label: 'Diagnostics',
    requiresOperations: [DATA_OPERATION_IDS.diagnostics],
  },
])

function buildOperations(document: Sc2DataDocument): AssetOperationDescriptor[] {
  return SC2_DATA_OPERATIONS.map(operation => {
    const { state, reason, diagnosticIds } = sc2DataOperationState(document, operation.id)
    return {
      ...operation,
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(diagnosticIds === undefined ? {} : { diagnosticIds }),
    } as AssetOperationDescriptor
  })
}

function buildIdentity(document: Sc2DataArtifactDocument): AssetIdentity {
  return {
    pluginId: SC2_DATA_CODEC_ID,
    pluginVersion: SC2_DATA_CODEC_VERSION,
    formatId: SC2_DATA_CODEC_ID,
    formatLabel: 'StarCraft II GameData',
    mediaType: 'application/xml',
    categories: ['semantic-game-asset', 'code'],
    confidence: document.detection.confidence,
    detection: document.detection.evidence,
  }
}

function buildConstraints(document: Sc2DataArtifactDocument): AssetConstraints {
  return {
    // The codec produces AssetEditPlans and AssetOutputs; it never writes back to the source
    // itself, so the source stays read-only from this adapter's point of view.
    readOnly: true,
    seekable: document.source.seekable,
    randomAccess: document.source.randomAccess,
    trusted: false,
    unsupportedFeatures: sc2DataUnsupportedFeatures(document),
  }
}

/** Build the serializable `AssetDescriptor` for an opened SC2 GameData document. */
export function describeSc2Data(
  document: Sc2DataArtifactDocument,
  _context: ArtifactContext = {},
): AssetDescriptor {
  return {
    schemaVersion: ASSET_DESCRIPTOR_SCHEMA_VERSION,
    source: document.source,
    identity: buildIdentity(document),
    traits: sc2DataTraits(document) as CapabilityInstance[],
    operations: buildOperations(document),
    constraints: buildConstraints(document),
    contributions: SC2_DATA_CONTRIBUTIONS,
    metadata: sc2DataMetadata(document) as MetadataGroup[],
    diagnostics: sc2DataFindings(document).map(item => ({ ...item, source: SC2_DATA_CODEC_ID })),
  }
}
