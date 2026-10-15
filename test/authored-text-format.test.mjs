import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { defineAuthoredTextFormat } from '../starcraft2/shared/editing/authored-text-format.js'
import { authoredTextFormats } from '../starcraft2/shared/editing/providers/authored-text/runtime.js'

test('authored-text format API validates and freezes a complete rule', () => {
  const validate = () => undefined
  const rule = defineAuthoredTextFormat({
    formatId: 'example-text',
    offerId: 'example-text-source',
    evidenceId: 'example-text-writer-v1',
    label: 'Example text',
    validate,
  })

  assert.equal(Object.isFrozen(rule), true)
  assert.equal(rule.validate, validate)
  assert.throws(
    () => defineAuthoredTextFormat({ ...rule, offerId: '' }),
    /offerId must be a non-empty string/,
  )
  assert.throws(
    () => defineAuthoredTextFormat({ ...rule, validate: undefined }),
    /validate must be a function/,
  )
})

test('authored-text runtime rules match the published writer offers', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../starcraft2/shared/editing/providers/authored-text/provider.json', import.meta.url),
      'utf8',
    ),
  )
  const published = manifest.spec.provides
    .map(offer => ({
      formatId: offer.facet.formatId,
      offerId: offer.offerId,
      evidenceId: offer.facet.fidelityEvidenceId,
    }))
    .sort((left, right) => left.offerId.localeCompare(right.offerId))
  const registered = [...authoredTextFormats].sort((left, right) =>
    left.offerId.localeCompare(right.offerId),
  )

  assert.deepEqual(registered, published)
})
