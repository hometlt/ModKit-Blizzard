/**
 * Real wizards, read in place.
 *
 * Three claims per file, each of which the spec-derived fixtures cannot make: the bytes are the
 * ones the baseline was recorded against, the model writes them back byte for byte, and the checker
 * says exactly what `fixtures/corpus.json` says it says. The last one is a regression net for false
 * positives: every hard error here was once a finding about the checker rather than the file.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyzeWizardDocument,
  parseWizardDocument,
  writeWizardDocument,
} from '../codecs/wizard/src/core/index.js'
import { createStarcraft2WizardSchema } from '../codecs/wizard/src/schema.js'
import { editIsolationFailures } from './edit-isolation.js'

const corpus = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/corpus.json'), 'utf8')) as {
  files: { path: string; sha256: string; wizards: number; diagnostics: Record<string, number> }[]
}
const root =
  process.env.MODKITX_SC2_WIZARD_CORPUS_ROOT?.trim() ||
  resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'AllRaces')
const schema = createStarcraft2WizardSchema()

describe.skipIf(process.env.MODKIT_TEST_INSTALLED_CORPUS !== '1' || !existsSync(root))(
  'SC2 data wizard real corpus',
  () => {
    it.each(corpus.files.map(file => [file.path, file] as const))('%s', (_path, file) => {
      const bytes = readFileSync(resolve(root, file.path))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
      const text = bytes.toString('utf8')
      const document = parseWizardDocument(text)
      expect(writeWizardDocument(document)).toBe(text)
      expect(document.file.wizards).toHaveLength(file.wizards)
      const counts: Record<string, number> = {}
      for (const item of analyzeWizardDocument(document, { schema, compatibilityMode: 'editor-compatible' }).diagnostics) {
        const key = `${item.severity}:${item.code.replace(/^sc2-wizard-/u, '')}`
        counts[key] = (counts[key] ?? 0) + 1
      }
      expect(counts).toEqual(file.diagnostics)
      // Every value edit.field can write lands on that value alone.
      expect(editIsolationFailures(text).failures).toEqual([])
    })
  },
)
