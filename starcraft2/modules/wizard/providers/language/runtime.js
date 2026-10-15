import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import {
  SC2_WIZARD_LANGUAGE_ID,
  createSc2WizardLanguageProvider,
} from '../../../../dist/modules/wizard/providers/language/src/language.js'

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection, context) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `Unsupported SC2 wizard language selection ${selection.contract}@${selection.major}`,
    )
  }
  const provider = createSc2WizardLanguageProvider(context?.modContexts === undefined ? {} : { modContexts: context.modContexts })
  return Object.freeze({
    value: Object.freeze({
      ...provider,
      languageIds: Object.freeze([SC2_WIZARD_LANGUAGE_ID]),
    }),
    release: async () => undefined,
  })
}
