/**
 * Service-provider entrypoint for the `sc2-strings` language services.
 *
 * The analysis lives in `language.ts`, beside the codec that owns the format; this file is only the
 * contribution boundary the host resolves through, matching how the bank and the other SC2 language
 * providers are wired. MK2 shipped a strings language module and MK3 had none — not because the
 * work was missing, but because nothing published it.
 */
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import {
  createSc2StringsLanguageProvider,
  SC2_STRINGS_LANGUAGE_ID,
} from '../../../../dist/modules/strings/providers/language/src/language.js'

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection, context) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `Unsupported SC2 strings language selection ${selection.contract}@${selection.major}`,
    )
  }
  const provider = createSc2StringsLanguageProvider(
    context?.modContexts === undefined ? {} : { modContexts: context.modContexts },
  )
  return Object.freeze({
    value: Object.freeze({
      ...provider,
      languageIds: Object.freeze([SC2_STRINGS_LANGUAGE_ID]),
    }),
    release: async () => undefined,
  })
}
