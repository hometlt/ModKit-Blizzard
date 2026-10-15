/**
 * `sc2-bank` domain boundary: detection, the opened bank and its edits as narrow SC2 values.
 *
 * Nothing here speaks the legacy asset DTOs (`AssetSource`, `DetectionResult`, `AssetDescriptor`).
 * The native codec projects these values directly; the legacy `Sc2BankCodec` in
 * `artifact-codec.ts` wraps them and survives only as the parity oracle in the tests.
 * The algorithms themselves (parse, validate, raw-preserving patch, signature) stay in
 * `shared/core`, the MK2 port.
 */

import {
  calculateBankSignature,
  inferBankSignatureInfo,
  parseBank,
  patchBankSignatureXml,
  patchBankValueXml,
  toSignatureInfo,
  validateBank,
  verifyBankSignature,
} from '../../../shared/core/core.js'
import type {
  BankValidationReport,
  InferredBankSignatureInfo,
  PatchBankValueOptions,
  SC2Bank,
  SC2BankSignatureInfo,
} from '../../../shared/core/core.js'
import { SC2_BANK_CODEC_ID, SC2_BANK_EXTENSION, SC2_GAME_ID } from './identity.js'

/** Bounded header window used for the cheap structural sniff. */
export const SC2_BANK_HEADER_BYTES = 4096
const BANK_ROOT_TAG_RE = /<Bank[\s>]/

export interface Sc2BankDetectionEvidence {
  readonly kind: 'structure' | 'extension' | 'context'
  readonly detail: string
}

export interface Sc2BankDetection {
  readonly confidence: number
  readonly evidence: readonly Sc2BankDetectionEvidence[]
  readonly requiredRanges: readonly { readonly offset: number; readonly length: number }[]
  /** Set when only the `.SC2Bank` extension matched. */
  readonly extensionOnly: boolean
}

const clamp = (value: number): number => Math.max(0, Math.min(1, Number(value.toFixed(4))))

/**
 * Bounded structural detection. A `<Bank` root in the header window is structure evidence
 * (0.9, +0.05 for the extension, +0.05 for declared SC2 context); the extension alone is 0.3.
 */
export function detectSc2BankHeader(
  header: Uint8Array,
  name: string,
  gameId?: string,
): Sc2BankDetection {
  const evidence: Sc2BankDetectionEvidence[] = []
  const hasExtension = name.toLowerCase().endsWith(SC2_BANK_EXTENSION)
  const window = header.subarray(0, SC2_BANK_HEADER_BYTES)
  const hasRoot = BANK_ROOT_TAG_RE.test(new TextDecoder('utf-8').decode(window))
  const inContext = gameId === SC2_GAME_ID
  const fileName = name.split(/[\\/]/u).pop() ?? name
  if (hasRoot) evidence.push({ kind: 'structure', detail: 'header window contains a <Bank ...> root tag' })
  if (hasExtension) evidence.push({ kind: 'extension', detail: `root name ${fileName}` })
  if (inContext) evidence.push({ kind: 'context', detail: `declared game ${SC2_GAME_ID}` })
  const ranges = [{ offset: 0, length: SC2_BANK_HEADER_BYTES }]
  if (hasRoot) {
    const confidence = 0.9 + (hasExtension ? 0.05 : 0) + (inContext ? 0.05 : 0)
    return { confidence: clamp(confidence), evidence, requiredRanges: ranges, extensionOnly: false }
  }
  if (hasExtension) return { confidence: 0.3, evidence, requiredRanges: ranges, extensionOnly: true }
  return { confidence: 0, evidence: [], requiredRanges: [], extensionOnly: false }
}

/** An opened bank: raw XML (for raw-preserving edits), the parsed bank and its identity. */
export interface Sc2BankModel {
  readonly path: string
  readonly xml: string
  readonly bank: SC2Bank
  /** Author/player IDs inferred from `path`, following `.../<playerId>/Banks/<authorId>/...`. */
  readonly inferredInfo: InferredBankSignatureInfo
  /** Signing inputs: explicit ones win over the inferred ones. */
  readonly signatureInfo?: SC2BankSignatureInfo
  readonly validation: BankValidationReport
}

export function openSc2Bank(
  xml: string,
  path: string,
  explicitInfo?: SC2BankSignatureInfo,
): Sc2BankModel {
  const bank = parseBank(xml)
  const inferredInfo = inferBankSignatureInfo(path)
  const signatureInfo = explicitInfo ?? toSignatureInfo(inferredInfo)
  return {
    path,
    xml,
    bank,
    inferredInfo,
    ...(signatureInfo === undefined ? {} : { signatureInfo }),
    validation: validateBank(bank, signatureInfo === undefined ? {} : { signatureInfo }),
  }
}

/**
 * - `absent`: the bank carries no `<Signature>`;
 * - `valid`: it verifies against the known signing inputs;
 * - `invalid`: signing inputs are known and the signature does not match them;
 * - `unverifiable`: a signature exists but author/player/bank name are unknown.
 */
export type Sc2BankSignatureState = 'absent' | 'valid' | 'invalid' | 'unverifiable'

export function sc2BankSignatureState(
  model: Sc2BankModel,
  info: SC2BankSignatureInfo | undefined = model.signatureInfo,
): Sc2BankSignatureState {
  if (model.bank.signature === undefined) return 'absent'
  if (info === undefined) return 'unverifiable'
  return verifyBankSignature(model.bank, info) ? 'valid' : 'invalid'
}

export class Sc2BankSigningError extends Error {
  override readonly name = 'Sc2BankSigningError'
}

const NO_SIGNING_INPUTS =
  'SC2Bank signing cannot proceed because no signatureInfo was inferred or provided. ' +
  'Open the bank from its player Banks path or provide explicit signature metadata.'

/** Recompute and embed the signature over the raw XML. */
export function signSc2Bank(
  model: Sc2BankModel,
  info: SC2BankSignatureInfo | undefined = model.signatureInfo,
): { readonly xml: string; readonly changed: boolean } {
  if (info === undefined) throw new Sc2BankSigningError(NO_SIGNING_INPUTS)
  const signed = patchBankSignatureXml(model.xml, calculateBankSignature(model.bank, info))
  if (!signed.ok) throw new Sc2BankSigningError(signed.reason)
  return signed
}

/** What an edit did to the bank signature. */
export type Sc2BankEditSignature =
  | 'absent'
  | 'unchanged'
  | 're-signed'
  | 'will-be-invalid'

export interface Sc2BankEdit {
  readonly xml: string
  readonly changed: boolean
  readonly signature: Sc2BankEditSignature
  /** Present exactly when `signature` is `will-be-invalid`. */
  readonly warning?: string
}

/**
 * Raw-preserving value edit with the bank signing policy.
 *
 * A signed bank is re-signed only when its signature verified against the known inputs before the
 * edit — that proves the inputs are the right ones. Otherwise (inputs unknown, or the signature
 * already did not match them) the edit is still produced but reported as `will-be-invalid`, so
 * no caller writes an invalid signature without being told.
 */
export function editSc2BankValue(model: Sc2BankModel, request: PatchBankValueOptions): Sc2BankEdit {
  const patch = patchBankValueXml(model.xml, request)
  if (!patch.ok) throw new TypeError(patch.reason)
  const state = sc2BankSignatureState(model)
  if (state === 'absent') return { xml: patch.xml, changed: patch.changed, signature: 'absent' }
  if (!patch.changed) return { xml: patch.xml, changed: false, signature: 'unchanged' }
  if (state === 'valid') {
    const signed = signSc2Bank({ ...model, xml: patch.xml, bank: parseBank(patch.xml) })
    return { xml: signed.xml, changed: true, signature: 're-signed' }
  }
  return {
    xml: patch.xml,
    changed: true,
    signature: 'will-be-invalid',
    warning:
      state === 'unverifiable'
        ? 'This bank is signed, but its bank name, author and player IDs are unknown, so it cannot ' +
          'be re-signed: the signature will be invalid after this edit and StarCraft II will reject ' +
          'the bank. Open it from its player Banks folder or sign it with explicit identity.'
        : 'This bank signature did not match its bank name, author and player IDs before the edit; ' +
          'it is left as is and will be invalid after this edit.',
  }
}

export interface Sc2BankMetadataEntry {
  readonly id: string
  readonly label: string
  readonly value: string | number | boolean
  readonly kind?: 'text' | 'path' | 'id' | 'number' | 'boolean'
}

export interface Sc2BankMetadataGroup {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly entries: readonly Sc2BankMetadataEntry[]
}

export function sc2BankMetadata(model: Sc2BankModel): Sc2BankMetadataGroup[] {
  const { bank, inferredInfo, signatureInfo } = model
  return [
    {
      id: 'identity',
      label: 'Bank',
      order: 10,
      entries: [
        { id: 'name', label: 'Name', value: inferredInfo.bankName, kind: 'text' },
        { id: 'path', label: 'Path', value: model.path, kind: 'path' },
        { id: 'codec', label: 'Codec', value: SC2_BANK_CODEC_ID, kind: 'id' },
        { id: 'version', label: 'Version', value: bank.version ?? '(none)', kind: 'text' },
        { id: 'sections', label: 'Sections', value: bank.sections.length, kind: 'number' },
      ],
    },
    {
      id: 'signature',
      label: 'Signature',
      order: 20,
      entries: [
        { id: 'present', label: 'Signature present', value: bank.signature !== undefined, kind: 'boolean' },
        ...(signatureInfo !== undefined
          ? [
              { id: 'authorId', label: 'Author ID', value: signatureInfo.authorId, kind: 'id' as const },
              { id: 'playerId', label: 'Player ID', value: signatureInfo.playerId, kind: 'id' as const },
            ]
          : [
              {
                id: 'unresolved',
                label: 'Author/player IDs',
                value: 'could not be inferred from path',
                kind: 'text' as const,
              },
            ]),
      ],
    },
  ]
}
