import {
  ASSET_DESCRIPTOR_SCHEMA_VERSION,
  type ArtifactContext,
  type AssetConstraints,
  type AssetDescriptor,
  type AssetDiagnostic,
  type AssetIdentity,
  type AssetOperationDescriptor,
  type AssetSourceDescriptor,
  type DetectionResult,
  type CapabilityInstance,
  type MetadataGroup,
  type ViewerContributionDescriptor,
} from '@modkit/codec-kit/legacy/assets'
import { LAYOUT_OPERATION_IDS } from '../layout-engine/operations.js'
import type { Sc2LayoutDocument } from './document.js'
import { SC2_LAYOUT_CODEC_ID, SC2_LAYOUT_CODEC_VERSION } from './identity.js'
import { sc2LayoutDiagnostics, sc2LayoutMetadata, sc2LayoutTraits } from './summary.js'
export {
  SC2_LAYOUT_EDIT_DIAGNOSTIC_ID,
  SC2_LAYOUT_LANGUAGE_DIAGNOSTIC_ID,
  SC2_LAYOUT_VISUAL_RENDER_DIAGNOSTIC_ID,
  SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID,
} from './summary.js'
import {
  SC2_LAYOUT_EDIT_DIAGNOSTIC_ID,
  SC2_LAYOUT_LANGUAGE_DIAGNOSTIC_ID,
  SC2_LAYOUT_VISUAL_RENDER_DIAGNOSTIC_ID,
  SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID,
} from './summary.js'

/** The legacy document: the domain document over full legacy source/detection DTOs. */
export type Sc2LayoutArtifactDocument = Sc2LayoutDocument<AssetSourceDescriptor, DetectionResult>

export function sc2LayoutHandlerId(operationId: string): string {
  return `${SC2_LAYOUT_CODEC_ID}.${operationId}`
}

const WORKSPACE_REQUIRED = {
  code: 'missing-companion',
  message:
    'Semantic layout resolution requires a schema-backed Store over the ordered mod dependency workspace.',
  diagnosticIds: [SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID],
} as const

// The renderer itself is no longer the missing piece: `src/rendering/` is this codec's since
// R3·S7 (it was `@modkitx/layout-render`). What is still missing is what the single-source
// adapter cannot supply — the ordered mod-dependency workspace and the schema-backed Store —
// which is the same gap as `dependency-workspace-resolution`, not a second one.
const VISUAL_RENDER_UNAVAILABLE = {
  code: 'runtime-unavailable',
  message:
    'Visual rendering requires the resolved layout workspace and a schema-backed Store; the render pipeline itself is present in this codec.',
  diagnosticIds: [SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID, SC2_LAYOUT_VISUAL_RENDER_DIAGNOSTIC_ID],
} as const

const LANGUAGE_UNAVAILABLE = {
  code: 'runtime-unavailable',
  message:
    'Schema diagnostics and language features require the full layout language workspace, which this single-source adapter does not attach.',
  diagnosticIds: [SC2_LAYOUT_LANGUAGE_DIAGNOSTIC_ID],
} as const

const EDIT_UNAVAILABLE = {
  code: 'missing-companion',
  message: 'Reference rename planning requires the coordinating catalog rename from sc2-mod.',
  diagnosticIds: [SC2_LAYOUT_EDIT_DIAGNOSTIC_ID],
} as const

const SAVE_UNAVAILABLE = {
  code: 'host-unsupported',
  message: 'Saving requires a writable source host and a raw-preserving layout edit transaction.',
  diagnosticIds: [SC2_LAYOUT_EDIT_DIAGNOSTIC_ID],
} as const

export const SC2_LAYOUT_OPERATIONS: readonly AssetOperationDescriptor[] = Object.freeze([
  {
    id: LAYOUT_OPERATION_IDS.parse,
    state: 'available',
    mutatesSource: false,
    label: 'Parse SC2Layout',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.parse),
    permissions: ['read-source'],
    outputs: [{ id: 'layout', label: 'Parsed layout', mediaType: 'application/json' }],
  },
  {
    id: LAYOUT_OPERATION_IDS.resolve,
    state: 'dependency-required',
    mutatesSource: false,
    label: 'Resolve layout workspace',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.resolve),
    reason: WORKSPACE_REQUIRED,
  },
  {
    id: LAYOUT_OPERATION_IDS.render,
    state: 'available',
    mutatesSource: false,
    label: 'Render structural layout preview',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.render),
    permissions: ['read-source'],
    preservesUnknownData: false,
    roundTripSafe: false,
    outputs: [{ id: 'html', label: 'Structural layout preview', mediaType: 'text/html' }],
  },
  {
    id: LAYOUT_OPERATION_IDS.renderVisual,
    state: 'dependency-required',
    mutatesSource: false,
    label: 'Render resolved visual layout',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.renderVisual),
    reason: VISUAL_RENDER_UNAVAILABLE,
    outputs: [{ id: 'html', label: 'Visual layout', mediaType: 'text/html' }],
  },
  {
    id: LAYOUT_OPERATION_IDS.inspect,
    state: 'available',
    mutatesSource: false,
    label: 'Inspect layout structure',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.inspect),
    permissions: ['read-source'],
    outputs: [{ id: 'summary', label: 'Layout summary', mediaType: 'application/json' }],
  },
  {
    id: LAYOUT_OPERATION_IDS.validate,
    state: 'dependency-required',
    mutatesSource: false,
    label: 'Validate layout against schema',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.validate),
    reason: LANGUAGE_UNAVAILABLE,
    outputs: [{ id: 'diagnostics', label: 'Diagnostics', mediaType: 'application/json' }],
  },
  {
    id: LAYOUT_OPERATION_IDS.edit,
    state: 'dependency-required',
    mutatesSource: true,
    label: 'Edit layout',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.edit),
    reason: EDIT_UNAVAILABLE,
  },
  {
    id: LAYOUT_OPERATION_IDS.languageFeatures,
    state: 'dependency-required',
    mutatesSource: false,
    label: 'Use layout language features',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.languageFeatures),
    reason: LANGUAGE_UNAVAILABLE,
  },
  {
    id: LAYOUT_OPERATION_IDS.exportHtml,
    state: 'available',
    mutatesSource: false,
    label: 'Export structural diagnostic HTML',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.exportHtml),
    permissions: ['read-source'],
    preservesUnknownData: false,
    roundTripSafe: false,
    outputs: [
      {
        id: 'html',
        label: 'Structural diagnostic HTML',
        mediaType: 'text/html',
        extension: '.html',
        formatId: 'html',
      },
    ],
  },
  {
    id: LAYOUT_OPERATION_IDS.raw,
    state: 'available',
    mutatesSource: false,
    label: 'Export original layout XML',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.raw),
    permissions: ['read-source'],
    preservesUnknownData: true,
    roundTripSafe: true,
    outputs: [
      {
        id: 'raw',
        label: 'Original layout XML',
        mediaType: 'application/xml',
        extension: '.SC2Layout',
        formatId: SC2_LAYOUT_CODEC_ID,
      },
    ],
  },
  {
    id: LAYOUT_OPERATION_IDS.save,
    state: 'disabled',
    mutatesSource: true,
    label: 'Save layout source',
    handlerId: sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.save),
    reason: SAVE_UNAVAILABLE,
  },
] satisfies readonly AssetOperationDescriptor[])

export const SC2_LAYOUT_CONTRIBUTIONS: readonly ViewerContributionDescriptor[] = Object.freeze([
  {
    id: 'sc2-layout.visual',
    kind: 'stage',
    priority: 80,
    label: 'Visual layout',
    requiresTraits: [{ id: 'game.layout', states: ['available', 'partial'] }],
    requiresOperations: [LAYOUT_OPERATION_IDS.renderVisual],
  },
  {
    id: 'sc2-layout.structure',
    kind: 'tree',
    priority: 70,
    label: 'Layout structure',
    requiresTraits: [{ id: 'structure.hierarchy' }],
    requiresOperations: [LAYOUT_OPERATION_IDS.inspect],
  },
  {
    id: 'sc2-layout.structural-preview',
    kind: 'stage',
    priority: 60,
    label: 'Structural preview',
    requiresTraits: [{ id: 'game.layout', states: ['partial', 'available'] }],
    requiresOperations: [LAYOUT_OPERATION_IDS.render],
  },
  {
    id: 'sc2-layout.metadata',
    kind: 'panel',
    priority: 50,
    label: 'Layout properties',
    requiresTraits: [{ id: 'content.metadata' }],
  },
  {
    id: 'sc2-layout.diagnostics',
    kind: 'panel',
    priority: 30,
    label: 'Diagnostics',
    requiresOperations: [LAYOUT_OPERATION_IDS.validate],
  },
])

function buildDiagnostics(document: Sc2LayoutDocument): readonly AssetDiagnostic[] {
  return sc2LayoutDiagnostics(document).map(item => ({ ...item, source: SC2_LAYOUT_CODEC_ID }))
}

function buildIdentity(document: Sc2LayoutArtifactDocument): AssetIdentity {
  return {
    pluginId: SC2_LAYOUT_CODEC_ID,
    pluginVersion: SC2_LAYOUT_CODEC_VERSION,
    formatId: SC2_LAYOUT_CODEC_ID,
    formatLabel: 'StarCraft II Layout',
    mediaType: 'application/vnd.blizzard.sc2layout+xml',
    categories: ['semantic-game-asset', 'code', 'document'],
    confidence: document.detection.confidence,
    detection: document.detection.evidence,
  }
}

function buildConstraints(document: Sc2LayoutArtifactDocument): AssetConstraints {
  return {
    readOnly: true,
    seekable: document.source.seekable,
    randomAccess: document.source.randomAccess,
    trusted: false,
    unsupportedFeatures: [
      'dependency-workspace-resolution',
      'schema-validation',
      'visual-layout-rendering',
      'asset-string-font-resolution',
      'language-service',
      'source-save',
      'html-to-layout-conversion',
    ],
  }
}

export function describeSc2Layout(
  document: Sc2LayoutArtifactDocument,
  _context: ArtifactContext = {},
): AssetDescriptor {
  return {
    schemaVersion: ASSET_DESCRIPTOR_SCHEMA_VERSION,
    source: document.source,
    identity: buildIdentity(document),
    traits: sc2LayoutTraits(document) as readonly CapabilityInstance[],
    operations: SC2_LAYOUT_OPERATIONS,
    constraints: buildConstraints(document),
    contributions: SC2_LAYOUT_CONTRIBUTIONS,
    metadata: sc2LayoutMetadata(document) as readonly MetadataGroup[],
    diagnostics: buildDiagnostics(document),
  }
}
