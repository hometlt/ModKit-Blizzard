import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkModuleMap } from '../scripts/check-module-map.mjs'

const fixtureRoots = []
test.after(async () => Promise.all(fixtureRoots.map(root => rm(root, { force: true, recursive: true }))))

async function fixture({ manifests, contributions }) {
  const root = await mkdtemp(join(tmpdir(), 'modkit-module-map-'))
  fixtureRoots.push(root)
  await mkdir(join(root, 'architecture'), { recursive: true })
  await mkdir(join(root, 'demo', 'contributions'), { recursive: true })
  await writeFile(join(root, 'modkit.repository.json'), JSON.stringify({ extensions: [{ id: 'example/demo', path: 'demo' }] }))
  await writeFile(join(root, 'demo', 'package.json'), JSON.stringify({ modkit: { contributionManifests: ['./contributions/*.json'] } }))
  await writeFile(join(root, 'architecture', 'module-map.json'), JSON.stringify({ schemaVersion: 1, contributions }, null, 2))
  await Promise.all(manifests.map(({ name, id, contractId = 'modkit/codec-contribution' }) => writeFile(join(root, 'demo', 'contributions', name), JSON.stringify({ id, contract: { id: contractId } }))))
  return root
}

test('module map emits a deterministic source-to-future-path inventory', async () => {
  const root = await fixture({
    manifests: [
      { name: 'z.json', id: 'example/z' },
      { name: 'a.json', id: 'example/a' },
      { name: 'subject.json', id: 'example/subject', contractId: 'modkit/subject-kind-definition' },
    ],
    contributions: { 'example/a': 'modules/a/codecs/a', 'example/z': 'modules/z/codecs/z' },
  })
  assert.deepEqual(await checkModuleMap(root, { check: false }), [])
  assert.deepEqual(await checkModuleMap(root), [])
})

test('module map rejects duplicate contribution ids and target paths', async () => {
  const duplicateIdRoot = await fixture({
    manifests: [{ name: 'a.json', id: 'example/a' }, { name: 'b.json', id: 'example/a' }],
    contributions: { 'example/a': 'modules/a/codecs/a' },
  })
  assert.equal((await checkModuleMap(duplicateIdRoot)).some(error => error.includes('duplicate contribution id')), true)

  const duplicateTargetRoot = await fixture({
    manifests: [{ name: 'a.json', id: 'example/a' }, { name: 'b.json', id: 'example/b' }],
    contributions: { 'example/a': 'modules/shared/codecs/a', 'example/b': 'modules/shared/codecs/a' },
  })
  assert.equal((await checkModuleMap(duplicateTargetRoot)).some(error => error.includes('target path')), true)

  const traversalTargetRoot = await fixture({
    manifests: [{ name: 'a.json', id: 'example/a' }],
    contributions: { 'example/a': '../outside' },
  })
  assert.equal((await checkModuleMap(traversalTargetRoot)).some(error => error.includes('normalized relative POSIX path')), true)
})

test('module map rejects a missing source and generated-inventory drift', async () => {
  const missingTargetRoot = await fixture({
    manifests: [{ name: 'image-operations.json', id: 'example/image-operations', contractId: 'modkit/service-provider-contribution' }],
    contributions: {},
  })
  assert.equal((await checkModuleMap(missingTargetRoot)).some(error => error.includes('has no module-map target')), true)

  const missingSourceRoot = await fixture({
    manifests: [{ name: 'a.json', id: 'example/a' }],
    contributions: { 'example/a': 'modules/a/codecs/a', 'example/missing': 'modules/missing/codecs/missing' },
  })
  assert.equal((await checkModuleMap(missingSourceRoot)).some(error => error.includes('has no source manifest')), true)

  const driftRoot = await fixture({
    manifests: [{ name: 'a.json', id: 'example/a' }],
    contributions: { 'example/a': 'modules/a/codecs/a' },
  })
  await checkModuleMap(driftRoot, { check: false })
  await writeFile(join(driftRoot, 'architecture', 'module-map.json'), JSON.stringify({ schemaVersion: 1, contributions: { 'example/a': 'modules/a/providers/a' } }))
  assert.equal((await checkModuleMap(driftRoot)).some(error => error.includes('generated inventory is stale')), true)
})
