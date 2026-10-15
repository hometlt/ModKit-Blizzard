import { sc2BankAuthoredText } from '../../../../modules/banks/services/authored-text-rules.js'
import { sc2DataAuthoredText } from '../../../../modules/data/services/authored-text-rules.js'
import { galaxyAuthoredText } from '../../../../modules/galaxy/services/authored-text-rules.js'
import { sc2LayoutAuthoredText } from '../../../../modules/layout/services/authored-text-rules.js'
import { sc2StringsAuthoredText } from '../../../../modules/strings/services/authored-text-rules.js'
import { sc2TriggersAuthoredText } from '../../../../modules/triggers/services/authored-text-rules.js'
import { createAuthoredTextProvider } from './engine.js'

const specifications = Object.freeze([
  galaxyAuthoredText,
  sc2StringsAuthoredText,
  sc2LayoutAuthoredText,
  sc2DataAuthoredText,
  sc2TriggersAuthoredText,
  sc2BankAuthoredText,
])

export const authoredTextFormats = Object.freeze(
  specifications.map(({ formatId, offerId, evidenceId }) =>
    Object.freeze({ formatId, offerId, evidenceId }),
  ),
)

export const abiVersion = 1
export const provides = Object.freeze(['common.edit/writer'])

export function createProvider(selection, context) {
  return createAuthoredTextProvider(specifications, selection, context)
}
