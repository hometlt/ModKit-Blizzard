import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import { withServedLanguageFeatures } from '../../../../shared/language/served-feature.js'
import {
  SC2_MAP_OBJECTS_LANGUAGE_ID,
  SC2_MAP_PRELOAD_LANGUAGE_ID,
  SC2_MIXED_WORKSPACE_LANGUAGE_IDS,
  createSc2WorkspaceLinkIndex,
} from '@modkit/blizzard-starcraft2/galaxy/sc2-workspace-links'
import { createSc2MapDocumentLanguage } from '../../../../dist/modules/map/providers/language/src/language.js'

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

const languageIds = Object.freeze([SC2_MAP_OBJECTS_LANGUAGE_ID, SC2_MAP_PRELOAD_LANGUAGE_ID])

export function createProvider(selection, context) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1)
    throw new TypeError(
      `Unsupported SC2 map document language selection ${selection.contract}@${selection.major}`,
    )
  return Object.freeze({
    value: withServedLanguageFeatures({
      contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT,
      languageIds,
      workspaceLanguageIds: SC2_MIXED_WORKSPACE_LANGUAGE_IDS,
      ...createSc2MapDocumentLanguage(languageIds, createSc2WorkspaceLinkIndex),
    }, context?.modContexts, ['hover', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename'], ['documentSymbols']),
    release: async () => undefined,
  })
}
