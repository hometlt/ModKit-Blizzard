import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const receipt = JSON.parse(
  await readFile(resolve(repositoryRoot, 'test', 'former-core-test-ownership.json'), 'utf8'),
)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('every audited former Core loader has one explicit owner and rationale', () => {
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.entries.length, 24)
  assert.equal(new Set(receipt.entries.map(entry => entry.source)).size, receipt.entries.length)
  for (const entry of receipt.entries) {
    assert.match(entry.source, /^packages\/(?:host|testkit)\/test\/.+\.test\.ts$/u)
    assert.ok(['migrated', 'generic-core-owned'].includes(entry.disposition), entry.source)
    assert.ok(entry.reason.length >= 48, entry.source)
  }
})

test('historical Core source identities remain pinned without reading Core', () => {
  assert.equal(receipt.coreRepository, '../modkit-core')
  for (const entry of receipt.entries) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u, entry.source)
  }
})

test('copied suites and fixtures are pinned in the Blizzard repository', async () => {
  const localEntries = receipt.entries.filter(entry => entry.local !== undefined)
  assert.equal(localEntries.length, 4)
  for (const entry of localEntries) {
    assert.equal(digest(await readFile(resolve(repositoryRoot, entry.local))), entry.localSha256, entry.local)
  }
  for (const fixture of receipt.fixtures) {
    assert.equal(digest(await readFile(resolve(repositoryRoot, fixture.path))), fixture.sha256, fixture.path)
  }
})

test('installed SC2 corpus suites declare conditional execution', async () => {
  for (const path of [
    'models/test/m3-animation.test.ts',
    'models/test/m3-material.test.ts',
    'models/test/m3-skeleton.test.ts',
    'models/test/m3a-corpus-audit.test.ts',
    'mpq/test/native-preserving-workflow.test.ts',
    'starcraft2/test/full-data-schema-corpus.test.ts',
    'starcraft2/test/map-preview-provider-corpus.test.ts',
    'starcraft2/test/resolved-data-placeholders-corpus.test.ts',
    'test/integration/sc2-runtime-catalog-real.test.ts',
  ]) {
    const source = await readFile(resolve(repositoryRoot, path), 'utf8')
    assert.match(source, /skipIf|\bskip\(\)/u, path)
  }
})
