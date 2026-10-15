import { parseXmlElements } from '../../../shared/inspection/structured-text.js'
import { defineAuthoredTextFormat } from '../../../shared/editing/authored-text-format.js'

export const sc2DataAuthoredText = defineAuthoredTextFormat({
  formatId: 'sc2-data',
  offerId: 'sc2-data-source',
  evidenceId: 'sc2-data-writer-v1',
  label: 'SC2 GameData',
  validate(text, budget) {
    parseXmlElements(text, budget, 'Catalog', 'SC2 GameData')
  },
})
