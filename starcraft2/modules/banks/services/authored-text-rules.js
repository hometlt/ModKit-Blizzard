import { parseXmlElements } from '../../../shared/inspection/structured-text.js'
import { defineAuthoredTextFormat } from '../../../shared/editing/authored-text-format.js'

export const sc2BankAuthoredText = defineAuthoredTextFormat({
  formatId: 'sc2-bank',
  offerId: 'sc2-bank-unsigned-source',
  evidenceId: 'sc2-bank-unsigned-writer-v1',
  label: 'unsigned SC2 bank',
  validate(text, budget) {
    parseXmlElements(text, budget, 'Bank', 'SC2 bank')
    if (/<Signature\b/iu.test(text)) {
      throw new TypeError('signed SC2 banks require signing support and are read-only')
    }
  },
})
