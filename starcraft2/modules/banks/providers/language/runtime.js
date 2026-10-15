/**
 * Service-provider entrypoint for the `sc2-bank` language services.
 *
 * The analysis itself lives in `language.ts`, next to the codec that owns the format; this file is
 * only the contribution boundary the host resolves through. Keeping them apart matters because the
 * same analysis is used two ways: a host that activates this contribution (VS Code, which already
 * consumes `common.language/document-analysis` for every route in its inventory) and a surface that
 * bridges the provider onto an embedded editor.
 */
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import { withServedLanguageFeatures } from '../../../../shared/language/served-feature.js'
import {
  createSc2BankLanguageProvider,
  SC2_BANK_LANGUAGE_ID,
} from '../../../../dist/modules/banks/providers/language/src/language.js'
import {
  createSc2BankListLanguageProvider,
  SC2_BANK_LIST_LANGUAGE_ID,
} from '../../../../dist/modules/banks/providers/language/src/bank-list-language.js'

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection, context) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `Unsupported SC2 bank language selection ${selection.contract}@${selection.major}`,
    )
  }
  const bankList = selection.offerId === 'sc2-bank-list-document-analysis-v1'
  const provider = bankList ? createSc2BankListLanguageProvider() : createSc2BankLanguageProvider()
  return Object.freeze({
    value: withServedLanguageFeatures({
      ...provider,
      languageIds: Object.freeze([bankList ? SC2_BANK_LIST_LANGUAGE_ID : SC2_BANK_LANGUAGE_ID]),
    }, context?.modContexts, ['hover', 'completion', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'], ['documentSymbols', 'formatting', 'codeActions']),
    release: async () => undefined,
  })
}
