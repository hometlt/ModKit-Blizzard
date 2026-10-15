import { defineAuthoredTextFormat } from '../../../shared/editing/authored-text-format.js'

export const sc2StringsAuthoredText = defineAuthoredTextFormat({
  formatId: 'sc2-strings',
  offerId: 'sc2-strings-source',
  evidenceId: 'sc2-strings-writer-v1',
  label: 'SC2 strings',
  validate(text, budget) {
    let entries = 0
    for (const raw of text.split(/\r\n|\r|\n/u)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('//') || line.startsWith('#')) continue
      const separator = raw.indexOf('=')
      if (separator < 1) {
        throw new TypeError('SC2 strings contains a non-empty line without a key/value separator')
      }
      if (raw.slice(0, separator).trim() === '') {
        throw new TypeError('SC2 strings contains an empty key')
      }
      entries += 1
      if (entries > budget.maxNodes) {
        throw new RangeError('SC2 string entries exceed maxNodes budget')
      }
    }
    if (entries === 0) throw new TypeError('SC2 strings contains no key/value entries')
  },
})
