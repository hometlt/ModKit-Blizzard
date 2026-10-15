import { defineAuthoredTextFormat } from '../../../shared/editing/authored-text-format.js'
import { parseXmlElements } from '../../../shared/inspection/structured-text.js'

export const sc2TriggersAuthoredText = defineAuthoredTextFormat({
  formatId: 'sc2-triggers',
  offerId: 'sc2-triggers-source',
  evidenceId: 'sc2-triggers-writer-v1',
  label: 'SC2 TriggerData',
  validate(text, budget) {
    parseXmlElements(text, budget, 'TriggerData', 'SC2 TriggerData')
  },
})
