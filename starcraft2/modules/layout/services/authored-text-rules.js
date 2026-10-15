import { parseXmlElements } from '../../../shared/inspection/structured-text.js'
import { defineAuthoredTextFormat } from '../../../shared/editing/authored-text-format.js'

export const sc2LayoutAuthoredText = defineAuthoredTextFormat({
  formatId: 'sc2-layout',
  offerId: 'sc2-layout-source',
  evidenceId: 'sc2-layout-writer-v1',
  label: 'SC2Layout',
  validate(text, budget) {
    parseXmlElements(text, budget, 'Desc', 'SC2Layout')
  },
})
