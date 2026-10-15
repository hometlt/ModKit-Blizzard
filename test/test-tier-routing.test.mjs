import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const text = async path => readFile(resolve(repositoryRoot, path), 'utf8')

test('quick and owner never select installed-game corpus routes', async () => {
  const manifest = JSON.parse(await text('package.json'))
  assert.match(manifest.scripts['test:quick'], /test:extensions:quick/u)
  assert.match(manifest.scripts['test:quick'], /test:tiers/u)
  assert.doesNotMatch(manifest.scripts['test:quick'], /test:real/u)
  assert.match(manifest.scripts['test:owner'], /test:extensions:owner/u)
  assert.doesNotMatch(manifest.scripts['test:owner'], /test:real/u)

  const config = await text('test/vitest.config.mjs')
  assert.match(config, /MODKIT_TEST_INSTALLED_CORPUS = selected\.corpus/u)
  assert.match(config, /mpq\/test\/native-preserving-workflow\.test\.ts/u)
  assert.match(config, /test\/integration\/sc2-triggers-c2-real\.test\.ts/u)
  assert.match(config, /test\/integration\/\*\*\/\*\.test\.ts/u)
  assert.match(manifest.scripts['test:extensions:quick'], /run-vitest-tier\.mjs quick/u)
  assert.match(manifest.scripts['test:extensions:owner'], /run-vitest-tier\.mjs owner/u)
})

test('real and full explicitly retain the physical-corpus failure routes', async () => {
  const manifest = JSON.parse(await text('package.json'))
  assert.match(manifest.scripts['test:full'], /test:owner && pnpm run test:real/u)
  assert.match(manifest.scripts['test:real'], /test:extensions:real/u)

  const config = await text('test/vitest.config.mjs')
  assert.match(config, /corpus: '1'/u)
  assert.match(config, /mpq\/test\/native-preserving-workflow\.test\.ts/u)
  assert.match(config, /test\/integration\/sc2-runtime-catalog-real\.test\.ts/u)
  assert.match(config, /test\/integration\/sc2-triggers-c2-real\.test\.ts/u)
})
