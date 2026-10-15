/**
 * `sc2-bank` bounded structural detection.
 *
 * `packages/bank`'s own structural check lives inside `parseBank` (`bank.ts`'s `findBankRoot`,
 * which requires a `<Bank>` root or throws). Detection must stay abortable and never fully
 * decode the asset (canonical architecture, section 5, pipeline rule 2), so this only looks for
 * a `<Bank` root tag inside a bounded header window — the same requirement `findBankRoot`
 * enforces, approximated cheaply. Full validation happens in `open()` via the real `parseBank`.
 */

import { readSourceHeader } from '@modkit/codec-kit/legacy/assets'
import type {
  ArtifactContext,
  AssetSource,
  AssetSourceKind,
  DetectionResult,
} from '@modkit/codec-kit/legacy/assets'
import { detectSc2BankHeader, SC2_BANK_HEADER_BYTES } from './domain.js'
import { SC2_BANK_CODEC_ID, SC2_GAME_ID } from './identity.js'

/** A bank file is always one addressable byte payload — never a directory or archive tree. */
export const SC2_BANK_SOURCE_KINDS: readonly AssetSourceKind[] = ['file', 'archive-entry']

/**
 * Bounded structural detection of an SC2 bank file.
 *
 * Confidence composition:
 *
 * - a validated `<Bank ...>` root within the header window: `structure` evidence, confidence 1
 *   ("A negative structural check must outweigh extension" — `ASSET_CAPABILITIES.md` section 7);
 * - `.SC2Bank` extension alone (no structural root found in the window): weak `extension`
 *   evidence only, confidence well below a validated match;
 * - declared SC2 game context: `context` evidence, contributing a small amount on top of a
 *   structural match, never sufficient alone.
 */
export async function detectSc2Bank(
  source: AssetSource,
  context: ArtifactContext = {},
): Promise<DetectionResult> {
  const descriptor = source.descriptor
  const header = await readSourceHeader(source, SC2_BANK_HEADER_BYTES, context.cancellation)
  const detected = detectSc2BankHeader(
    header,
    descriptor.name,
    context.gameId === SC2_GAME_ID || descriptor.context?.gameId === SC2_GAME_ID ? SC2_GAME_ID : undefined,
  )
  const result: DetectionResult = {
    pluginId: SC2_BANK_CODEC_ID,
    confidence: detected.confidence,
    evidence: [...detected.evidence],
    requiredRanges: [...detected.requiredRanges],
  }
  if (!detected.extensionOnly) return result
  return {
    ...result,
    diagnostics: [
      {
        id: 'sc2-bank.detect.extension-only',
        severity: 'warning',
        category: 'ambiguous-detection',
        code: 'sc2-bank.extension-only',
        message:
          'Matched the .SC2Bank extension but no <Bank> root was found in the header window.',
        source: SC2_BANK_CODEC_ID,
      },
    ],
  }
}
