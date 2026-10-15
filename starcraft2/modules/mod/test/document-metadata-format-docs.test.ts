import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const codecRoot = resolve(import.meta.dirname, '../codecs/document-metadata')
const formatDoc = join(codecRoot, 'FORMAT.md')

const cases = [
  { name: '.version', marker: '## `.version`', owner: 'core/version-file.ts' },
  { name: 'DocumentHeader', marker: '## `DocumentHeader`', owner: 'core/document-header.ts' },
  { name: 'DocumentHeader reverse analysis', marker: '### Reverse-analysis notes', owner: 'core/document-header.ts' },
  { name: 'DocumentInfo', marker: '## `DocumentInfo`', owner: 'core/document-info.ts' },
] as const

describe('document metadata format documentation', () => {
  const documentation = readFileSync(formatDoc, 'utf8')
  for (const testCase of cases) {
    it(`${testCase.name} has repository documentation and an implementation owner`, () => {
      expect(documentation).toContain(testCase.marker)
      expect(existsSync(join(codecRoot, testCase.owner))).toBe(true)
    })
  }
})
