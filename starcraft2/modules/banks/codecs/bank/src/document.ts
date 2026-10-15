/**
 * `sc2-bank` document: what `open()` returns.
 *
 * The document **wraps** rather than replaces what `@modkitx/bank/core` already produces: `bank`
 * is `parseBank`'s exact `SC2Bank`, `editor` is a plain `SC2BankEditor` over it, and `validation`
 * is `validateBank`'s exact report. Nothing is re-parsed or re-shaped — mirrors
 * `mods-processing/src/sc2-mod/document.ts`'s "wraps rather than replaces" note, adapted from a
 * Node file path (`loadBankFile`) to a generic `AssetSource`.
 */

import { SC2BankEditor } from '../../../shared/core/core.js'
import type {
  BankValidationReport,
  InferredBankSignatureInfo,
  SC2Bank,
  SC2BankSignatureInfo,
} from '../../../shared/core/core.js'
import type {
  ArtifactContext,
  AssetSource,
  AssetSourceDescriptor,
  DetectionResult,
} from '@modkit/codec-kit/legacy/assets'
import { openSc2Bank } from './domain.js'
import { SC2_BANK_CODEC_ID } from './identity.js'

export interface Sc2BankDocument {
  readonly codecId: typeof SC2_BANK_CODEC_ID
  /** The source this document was opened from, as passed to `open()`. */
  readonly source: AssetSourceDescriptor
  /** Detection result captured during `open()`; carried into `describe()`'s identity. */
  readonly detection: DetectionResult
  /** Raw XML text, kept for `patchBankValueXml`/`patchBankSignatureXml`'s raw-preserving edits. */
  readonly xml: string
  /** `@modkitx/bank/core`'s `parseBank(xml)` result, unchanged. */
  readonly bank: SC2Bank
  /** A plain `SC2BankEditor` over `bank`, unchanged from what `@modkitx/bank` itself constructs. */
  readonly editor: SC2BankEditor
  /** Author/player IDs inferred from `source.path`, following `.../Banks/<authorId>/...`. */
  readonly inferredInfo: InferredBankSignatureInfo
  /** Resolved signature info, when both `authorId` and `playerId` were inferable. */
  readonly signatureInfo?: SC2BankSignatureInfo
  /** `validateBank`'s exact report. */
  readonly validation: BankValidationReport
  readonly context: ArtifactContext
}

/** Assemble the document from an already-read source. */
export function createSc2BankDocument(init: {
  readonly source: AssetSourceDescriptor
  readonly detection: DetectionResult
  readonly xml: string
  readonly context: ArtifactContext
}): Sc2BankDocument {
  const { bank, inferredInfo, signatureInfo, validation } = openSc2Bank(init.xml, init.source.path)
  const editor = new SC2BankEditor(bank, signatureInfo)

  return {
    codecId: SC2_BANK_CODEC_ID,
    source: init.source,
    detection: init.detection,
    xml: init.xml,
    bank,
    editor,
    inferredInfo,
    ...(signatureInfo !== undefined ? { signatureInfo } : {}),
    validation,
    context: init.context,
  }
}

/** Read and decode the full source. A bank file is small XML text; whole-source reads are safe. */
export async function readSc2BankXml(
  source: AssetSource,
  context: ArtifactContext = {},
): Promise<string> {
  const bytes = await source.read(
    context.cancellation ? { cancellation: context.cancellation } : undefined,
  )
  return new TextDecoder('utf-8').decode(bytes)
}
