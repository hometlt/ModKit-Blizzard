/** Service-provider entrypoint for SC2 and Storm cutscene language analysis. */
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import { withServedLanguageFeatures } from '../../../../shared/language/served-feature.js'
import {
  createCutsceneLanguageProvider,
  CUTSCENE_LANGUAGE_IDS,
} from '../../../../dist/modules/cutscene/providers/language/src/language.js'

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection, context) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `Unsupported cutscene language selection ${selection.contract}@${selection.major}`,
    )
  }
  const provider = createCutsceneLanguageProvider()
  return Object.freeze({
    value: withServedLanguageFeatures({
      ...provider,
      languageIds: CUTSCENE_LANGUAGE_IDS,
    }, context?.modContexts, ['hover', 'completion', 'signatureHelp', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename', 'workspaceSymbols'], ['documentSymbols', 'formatting', 'codeActions', 'documentColors', 'colorPresentations']),
    release: async () => undefined,
  })
}

