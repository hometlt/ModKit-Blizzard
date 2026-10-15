/**
 * `sc2-bank` -> `AssetDescriptor` v1.
 *
 * Every trait, operation state, metadata row, and diagnostic below is derived from the opened
 * document, never declared statically — mirrors `mods-processing/src/sc2-mod/describe.ts`. The
 * one operation that is genuinely conditional per-document is `save.sign`: signing itself *is*
 * implemented in `@modkitx/bank` (`SC2BankEditor.sign`, `calculateBankSignature`), but a specific
 * document is only signable when its author/player IDs were resolved.
 */

import {
  ASSET_DESCRIPTOR_SCHEMA_VERSION,
  type ArtifactContext,
  type AssetConstraints,
  type AssetDescriptor,
  type AssetDiagnostic,
  type AssetIdentity,
  type AssetOperationDescriptor,
  type CapabilityInstance,
  type MetadataGroup,
  type ViewerContributionDescriptor,
} from '@modkit/codec-kit/legacy/assets'
import { SAVE_OPERATION_IDS } from '@modkit/codec-kit/legacy/semantic'
import type { Sc2BankDocument } from './document.js'
import { sc2BankMetadata } from './domain.js'
import { SC2_BANK_CODEC_ID, SC2_BANK_CODEC_VERSION } from './identity.js'

/** Stable handler ID for one of this codec's operations. */
export function sc2BankHandlerId(operationId: string): string {
  return `${SC2_BANK_CODEC_ID}.${operationId}`
}

const NOT_SIGNABLE_REASON = {
  code: 'not-implemented',
  message:
    'Author/player IDs could not be inferred from the source path (expected ' +
    '.../Banks/<authorId>/<bankName>.SC2Bank under a .../<playerId>/Banks/ ancestor) and no ' +
    'declared signatureInfo was available. Signing itself is implemented in @modkitx/bank; only ' +
    'this document lacks the identity it needs.',
} as const

/**
 * The codec-level operation table: what `sc2-bank` can ever offer. `describe()` re-derives
 * per-document states from this list (only `save.sign` can flip to `disabled`), so the two can
 * never drift.
 */
export const SC2_BANK_OPERATIONS: readonly AssetOperationDescriptor[] = Object.freeze([
  {
    id: SAVE_OPERATION_IDS.inspect,
    state: 'available',
    mutatesSource: false,
    label: 'Inspect bank',
    handlerId: sc2BankHandlerId(SAVE_OPERATION_IDS.inspect),
    permissions: ['read-source'],
    outputs: [{ id: 'card', label: 'Bank card data', mediaType: 'application/json' }],
  },
  {
    id: SAVE_OPERATION_IDS.validate,
    state: 'available',
    mutatesSource: false,
    label: 'Validate bank',
    handlerId: sc2BankHandlerId(SAVE_OPERATION_IDS.validate),
    permissions: ['read-source'],
    outputs: [
      { id: 'diagnostics', label: 'Validation diagnostics', mediaType: 'application/json' },
    ],
  },
  {
    id: SAVE_OPERATION_IDS.patchValue,
    state: 'available',
    mutatesSource: true,
    label: 'Patch value',
    handlerId: sc2BankHandlerId(SAVE_OPERATION_IDS.patchValue),
    permissions: ['read-source'],
    // patchBankValueXml/patchBankSignatureXml rewrite only the targeted attribute/tag —
    // everything else in the original XML (whitespace, comments, quote style) is preserved.
    preservesUnknownData: true,
    roundTripSafe: true,
    outputs: [{ id: 'xml', label: 'Patched raw XML', mediaType: 'application/xml' }],
  },
  {
    id: SAVE_OPERATION_IDS.saveAs,
    state: 'available',
    mutatesSource: false,
    label: 'Save bank as',
    handlerId: sc2BankHandlerId(SAVE_OPERATION_IDS.saveAs),
    permissions: ['read-source'],
    outputs: [{ id: 'xml', label: 'Serialized bank XML', mediaType: 'application/xml' }],
  },
  {
    id: SAVE_OPERATION_IDS.exportRaw,
    state: 'available',
    mutatesSource: false,
    label: 'Export raw XML',
    handlerId: sc2BankHandlerId(SAVE_OPERATION_IDS.exportRaw),
    permissions: ['read-source'],
    preservesUnknownData: true,
    roundTripSafe: true,
    outputs: [
      { id: 'xml', label: 'Original raw XML bytes', role: 'raw', mediaType: 'application/xml' },
    ],
  },
  {
    // Default state; describeSc2Bank() overrides this per-document (see buildOperations).
    id: SAVE_OPERATION_IDS.sign,
    state: 'disabled',
    mutatesSource: true,
    label: 'Sign bank',
    handlerId: sc2BankHandlerId(SAVE_OPERATION_IDS.sign),
    permissions: ['read-source'],
    reason: NOT_SIGNABLE_REASON,
  },
])

/** Viewer contributions this codec offers; the shell maps the IDs to real components. */
export const SC2_BANK_CONTRIBUTIONS: readonly ViewerContributionDescriptor[] = Object.freeze([
  {
    id: 'sc2-bank.overview',
    kind: 'stage',
    priority: 60,
    label: 'Bank overview',
    requiresTraits: [{ id: 'structure.hierarchy' }],
  },
])

function buildDiagnostics(document: Sc2BankDocument): AssetDiagnostic[] {
  return document.validation.findings.map((finding, index) => ({
    id: `sc2-bank.validate.${finding.code}.${index}`,
    severity: finding.severity,
    code: `sc2-bank.${finding.code}`,
    message: finding.message,
    source: SC2_BANK_CODEC_ID,
    path: finding.path,
  }))
}

function buildTraits(document: Sc2BankDocument): CapabilityInstance[] {
  const keyCount = document.bank.sections.reduce((sum, section) => sum + section.keys.length, 0)
  const traits: CapabilityInstance[] = [
    {
      id: 'structure.hierarchy',
      version: 1,
      state: 'available',
      parameters: { sections: document.bank.sections.length, keys: keyCount },
    },
    {
      id: 'content.metadata',
      version: 1,
      state: 'available',
      parameters: {
        version: document.bank.version ?? null,
        hasSignature: document.bank.signature !== undefined,
      },
    },
  ]
  return traits
}

function diagnosticIdsFor(
  document: Sc2BankDocument,
  severities: readonly ('error' | 'warning' | 'info')[],
): string[] {
  return document.validation.findings
    .map((finding, index) => ({ finding, id: `sc2-bank.validate.${finding.code}.${index}` }))
    .filter(({ finding }) => severities.includes(finding.severity))
    .map(({ id }) => id)
}

function buildOperations(document: Sc2BankDocument): AssetOperationDescriptor[] {
  const validateDiagnosticIds = diagnosticIdsFor(document, ['error', 'warning'])
  return SC2_BANK_OPERATIONS.map(operation => {
    if (operation.id === SAVE_OPERATION_IDS.validate && validateDiagnosticIds.length > 0) {
      return { ...operation, diagnosticIds: validateDiagnosticIds }
    }
    if (operation.id === SAVE_OPERATION_IDS.sign && document.signatureInfo !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { reason: _reason, ...available } = operation
      return { ...available, state: 'available' as const }
    }
    return operation
  })
}

function buildMetadata(document: Sc2BankDocument): MetadataGroup[] {
  return sc2BankMetadata({ ...document, path: document.source.path }).map(group => ({
    ...group,
    entries: group.entries.map(entry => ({ ...entry })),
  }))
}

function buildIdentity(document: Sc2BankDocument): AssetIdentity {
  return {
    pluginId: SC2_BANK_CODEC_ID,
    pluginVersion: SC2_BANK_CODEC_VERSION,
    formatId: SC2_BANK_CODEC_ID,
    formatLabel: 'StarCraft II bank',
    mediaType: 'application/xml',
    categories: ['semantic-game-asset'],
    confidence: document.detection.confidence,
    detection: document.detection.evidence,
  }
}

function buildConstraints(_document: Sc2BankDocument): AssetConstraints {
  return {
    readOnly: false,
    seekable: true,
    randomAccess: true,
    trusted: true,
  }
}

/** Build the serializable `AssetDescriptor` for an opened SC2 bank. */
export function describeSc2Bank(
  document: Sc2BankDocument,
  _context: ArtifactContext = {},
): AssetDescriptor {
  return {
    schemaVersion: ASSET_DESCRIPTOR_SCHEMA_VERSION,
    source: document.source,
    identity: buildIdentity(document),
    traits: buildTraits(document),
    operations: buildOperations(document),
    constraints: buildConstraints(document),
    contributions: SC2_BANK_CONTRIBUTIONS,
    metadata: buildMetadata(document),
    diagnostics: buildDiagnostics(document),
  }
}
