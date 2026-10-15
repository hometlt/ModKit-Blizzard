/**
 * The `sc2-bank` `GameArtifactCodec` adapter.
 *
 * It owns no SC2 bank parsing: detection mirrors `packages/bank`'s own structural check
 * (`parseBank`'s `<Bank>` root requirement), loading delegates to `@modkitx/bank/core`'s
 * `parseBank`/`inferBankSignatureInfo`/`validateBank`/`SC2BankEditor`, and the operations below
 * are thin projections over those values plus `@modkitx/bank/core`'s raw-preserving patch and
 * signature functions.
 *
 * Unlike `Sc2ModCodec`, this codec needs no injected host: `@modkitx/bank/core` is pure
 * (no CASC readers, no caches, no manager to share), so there is nothing to construct with.
 */

import {
  calculateBankSignature,
  patchBankSignatureXml,
  patchBankValueXml,
  serializeBank,
  verifyBankSignature,
} from '../../../shared/core/core.js'
import type {
  BankXmlPatchResult,
  SC2BankSignatureInfo,
  SerializeBankOptions,
} from '../../../shared/core/core.js'
import {
  createArtifactOperationSession,
  type ArtifactContext,
  type ArtifactOperationSession,
  type ArtifactOperationSessionOptions,
  type AssetDescriptor,
  type AssetOperationDescriptor,
  type AssetSource,
  type AssetSourceKind,
  type DetectionResult,
  type GameArtifactCodec,
  type GameArtifactKind,
} from '@modkit/codec-kit/legacy/assets'
import { ModkitError } from '@modkit/codec-kit/legacy/core'
import { SAVE_OPERATION_IDS } from '@modkit/codec-kit/legacy/semantic'
import { describeSc2Bank, SC2_BANK_OPERATIONS, sc2BankHandlerId } from './describe.js'
import { detectSc2Bank, SC2_BANK_SOURCE_KINDS } from './detect.js'
import { createSc2BankDocument, readSc2BankXml, type Sc2BankDocument } from './document.js'
import { SC2_BANK_CODEC_ID, SC2_GAME_ID } from './identity.js'

export class Sc2BankCodec implements GameArtifactCodec<Sc2BankDocument> {
  readonly id = SC2_BANK_CODEC_ID
  readonly kind: GameArtifactKind = 'save'
  readonly supportedGames: readonly string[] = [SC2_GAME_ID]
  readonly sourceKinds: readonly AssetSourceKind[] = SC2_BANK_SOURCE_KINDS
  readonly operations: readonly AssetOperationDescriptor[] = SC2_BANK_OPERATIONS

  detect(source: AssetSource, context: ArtifactContext = {}): Promise<DetectionResult> {
    return detectSc2Bank(source, context)
  }

  /**
   * Parse the bank.
   *
   * Detection runs first and is retained on the document so `describe()` can report real
   * evidence and confidence instead of a hardcoded 1.0 — mirrors `Sc2ModCodec.open()`. A
   * low-confidence detection does not block the open; routing is the registry's job.
   */
  async open(source: AssetSource, context: ArtifactContext = {}): Promise<Sc2BankDocument> {
    const detection = await this.detect(source, context)
    const xml = await readSc2BankXml(source, context)
    return createSc2BankDocument({ source: source.descriptor, detection, xml, context })
  }

  async describe(
    document: Sc2BankDocument,
    context: ArtifactContext = {},
  ): Promise<AssetDescriptor> {
    return describeSc2Bank(document, context)
  }

  createSession(
    document: Sc2BankDocument,
    context: ArtifactContext,
    descriptor: AssetDescriptor,
    options: ArtifactOperationSessionOptions = {},
  ): ArtifactOperationSession {
    return createArtifactOperationSession({
      codecId: this.id,
      document,
      context,
      descriptor,
      ...options,
      handlers: {
        [sc2BankHandlerId(SAVE_OPERATION_IDS.inspect)]: ({ descriptor: current }) =>
          current.metadata,
        [sc2BankHandlerId(SAVE_OPERATION_IDS.validate)]: () => this.validate(document),
        [sc2BankHandlerId(SAVE_OPERATION_IDS.patchValue)]: ({ input }) =>
          this.patchValue(
            document,
            input as unknown as {
              section: string
              key: string
              type: string
              value: string
            },
          ),
        [sc2BankHandlerId(SAVE_OPERATION_IDS.saveAs)]: ({ input }) =>
          this.saveAs(document, (input ?? {}) as SerializeBankOptions),
        [sc2BankHandlerId(SAVE_OPERATION_IDS.exportRaw)]: () => this.exportRaw(document),
        [sc2BankHandlerId(SAVE_OPERATION_IDS.sign)]: () => this.sign(document),
      },
    })
  }

  // --- registered operation handlers ------------------------------------------------------
  // Each maps 1:1 onto an operation ID declared in `describe()`.

  /** `asset.validate` — the descriptor's diagnostics, so a host never sees two different verdicts. */
  async validate(document: Sc2BankDocument) {
    const descriptor = await this.describe(document, document.context)
    return descriptor.diagnostics.filter(diagnostic => diagnostic.severity !== 'info')
  }

  /**
   * `edit.content` — raw-preserving patch of a single key's value. Only the targeted attribute
   * (or the whole `<Value .../>` tag, on a type change) is rewritten; everything else in the
   * original XML (whitespace, comments, quote style, unrelated keys) is untouched.
   */
  patchValue(
    document: Sc2BankDocument,
    request: {
      readonly section: string
      readonly key: string
      readonly type: string
      readonly value: string
    },
  ): BankXmlPatchResult {
    return patchBankValueXml(document.xml, request)
  }

  /** `save.sign` — recompute and embed the author/player signature in the raw XML. */
  sign(document: Sc2BankDocument, signatureInfo?: SC2BankSignatureInfo): BankXmlPatchResult {
    const info = signatureInfo ?? document.signatureInfo
    if (info === undefined) {
      throw new ModkitError({
        code: 'CONFIG_INVALID',
        message:
          'SC2Bank signing cannot proceed because no signatureInfo was inferred or provided.',
        context: { codecId: this.id, sourcePath: document.source.path },
        hint: 'Open the bank from its player Banks path or provide explicit signature metadata.',
      })
    }
    const signature = calculateBankSignature(document.bank, info)
    return patchBankSignatureXml(document.xml, signature)
  }

  /** Verifies the bank's embedded signature against `signatureInfo` (inferred or provided). */
  verify(document: Sc2BankDocument, signatureInfo?: SC2BankSignatureInfo): boolean {
    const info = signatureInfo ?? document.signatureInfo
    if (info === undefined) return false
    return verifyBankSignature(document.bank, info)
  }

  /** `source.save-as` — serialize the parsed bank (re-formats; use `patchValue`/`sign` to preserve raw XML). */
  saveAs(document: Sc2BankDocument, options: SerializeBankOptions = {}): string {
    return serializeBank(document.bank, options)
  }

  /** `export.raw` — the original raw XML bytes, byte-for-byte. */
  exportRaw(document: Sc2BankDocument): string {
    return document.xml
  }
}

/** Convenience factory mirroring the other `<domain>-processing` packages' style. */
export function createSc2BankCodec(): Sc2BankCodec {
  return new Sc2BankCodec()
}
