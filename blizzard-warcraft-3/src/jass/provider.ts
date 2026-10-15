/** Service-provider boundary for the `jass` language services (`language.ts`). */
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import { createJassLanguageProvider } from './language.js'

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection: { readonly contract: string; readonly major: number }) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1)
    throw new TypeError(
      `unsupported JASS language selection ${selection.contract}@${String(selection.major)}`,
    )
  return Object.freeze({
    value: Object.freeze(createJassLanguageProvider()),
    release: async (): Promise<void> => undefined,
  })
}
