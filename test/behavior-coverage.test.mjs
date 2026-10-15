import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const receipt = JSON.parse(
  await readFile(new URL('./behavior/coverage-receipt.json', import.meta.url), 'utf8'),
)
const sourceRoot = join(repositoryRoot, receipt.sourceSnapshotRoot)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('behavior coverage receipt owns only the migrated Blizzard format families', async () => {
  assert.equal(receipt.schemaVersion, 1)
  assert.deepEqual(receipt.excludedFamilies, ['starcraft2', 'm3'])
  assert.deepEqual(
    receipt.suites.flatMap(suite => suite.formats),
    ['BLP1', 'BLP2', 'APP', 'TEX', 'MDX', 'MDL'],
  )
  assert.equal(
    receipt.suites.reduce((sum, suite) => sum + suite.testCases, 0),
    16,
  )
  assert.equal(receipt.sourceRepository, 'historical modkit-core')
  assert.match(receipt.sourceCommit, /^[0-9a-f]{40}$/u)
  for (const packagePath of receipt.sourcePackages) await access(join(sourceRoot, packagePath))
})

test('copied behavior tests and their Core source snapshots are pinned', async () => {
  for (const suite of receipt.suites) {
    await access(join(repositoryRoot, suite.extensionRoot))
    // A superseded suite leaves the run, so the suite that replaced it has to exist and say why.
    if (suite.supersededBy !== undefined) {
      await access(join(repositoryRoot, suite.supersededBy))
      assert.ok(suite.reason, `${suite.id} superseded without a reason`)
    }
    const [source, target] = await Promise.all([
      readFile(join(sourceRoot, suite.sourceTest)),
      readFile(join(repositoryRoot, suite.targetTest)),
    ])
    assert.equal(digest(source), suite.sourceSha256, `${suite.id} source drift`)
    assert.equal(digest(target), suite.targetSha256, `${suite.id} local drift`)
    const text = target.toString('utf8')
    assert.equal((text.match(/\bit\(/gu) ?? []).length, suite.testCases, suite.id)
    assert.match(text, /@modkit\/sdk/u, suite.id)
    assert.doesNotMatch(text, /extensions['"], ['"]mk2/u, suite.id)
  }
})

test('copied fixtures remain byte-identical to the Core testkit evidence', async () => {
  for (const fixture of receipt.fixtures) {
    const [source, target] = await Promise.all([
      readFile(join(sourceRoot, 'packages/testkit/test/fixtures/mk2-synthetic', fixture.name)),
      readFile(join(repositoryRoot, 'test/behavior/fixtures', fixture.name)),
    ])
    assert.equal(digest(source), fixture.sha256, `${fixture.name} source drift`)
    assert.equal(digest(target), fixture.sha256, `${fixture.name} copied fixture drift`)
    assert.deepEqual(target, source, fixture.name)
  }
})

test('behavior tests use the current Modkit SDK and Host package artifacts', async () => {
  const packageManifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  assert.match(packageManifest.devDependencies['@modkit/sdk'], /^(?:workspace:\*|file:\.\/vendor\/)/u)
  assert.match(packageManifest.devDependencies['@modkit/host'], /^(?:workspace:\*|file:\.\/vendor\/)/u)
})
