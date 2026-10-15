/**
 * Service-provider entrypoint for the `sc2-style` language services.
 *
 * The analysis lives in `language.ts`, beside the codec that owns the format, matching how the bank
 * and the other SC2 language providers are wired. MK2 shipped this format's vocabulary to every
 * other language and never checked the format itself; this is the contribution boundary that fixes
 * that, and the file it points at is the same one the codec's own diagnostics come from.
 */
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import {
  createSc2StyleLanguageProvider,
  SC2_STYLE_LANGUAGE_ID,
} from '../../../../../dist/modules/style/providers/language/src/language.js'

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection, context) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `Unsupported SC2 style language selection ${selection.contract}@${selection.major}`,
    )
  }
  const provider = createSc2StyleLanguageProvider(context?.modContexts === undefined ? {} : { modContexts: context.modContexts })
  return Object.freeze({
    value: Object.freeze({
      ...provider,
      languageIds: Object.freeze([SC2_STYLE_LANGUAGE_ID]),
    }),
    release: async () => undefined,
  })
}
