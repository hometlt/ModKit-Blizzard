import { defineAuthoredTextFormat } from '../../../shared/editing/authored-text-format.js'
import { plausibleGalaxy, scanGalaxy } from '../../../shared/language/galaxy-analysis.js'

export const galaxyAuthoredText = defineAuthoredTextFormat({
  formatId: 'galaxy',
  offerId: 'galaxy-source',
  evidenceId: 'sc2-galaxy-writer-v1',
  label: 'Galaxy',
  validate(text, budget) {
    if (!plausibleGalaxy(text)) throw new TypeError('Galaxy source has no declaration')
    scanGalaxy(text, budget)
  },
})
