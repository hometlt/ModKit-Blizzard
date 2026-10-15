import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkCodecProviderSplit } from '../scripts/check-codec-provider-split.mjs'

const fixtureRoots = []
test.after(async () => Promise.all(fixtureRoots.map(root => rm(root, { force: true, recursive: true }))))

test('codec/provider layout gate accepts valid modules and rejects swapped contracts and ambient codec authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modkit-codec-provider-'))
  fixtureRoots.push(root)
  await writeFile(join(root, 'modkit.repository.json'), JSON.stringify({ extensions: [{ id: 'example/demo', path: 'demo' }] }))
  await mkdir(join(root, 'demo'), { recursive: true })
  await writeFile(join(root, 'demo', 'package.json'), JSON.stringify({ modkit: { contributionManifests: ['./modules/*/codecs/*/codec.json', './modules/*/providers/*/provider.json'] } }))
  const codec = join(root, 'demo', 'codecs', 'alpha'); const provider = join(root, 'demo', 'providers', 'indexer')
  await mkdir(codec, { recursive: true }); await mkdir(provider, { recursive: true })
  await writeFile(join(codec, 'codec.json'), JSON.stringify({ contract: { id: 'modkit/codec-contribution' }, runtimeVariants: [{ requestedPermissionClasses: ['read-source'] }] }))
  await writeFile(join(provider, 'provider.json'), JSON.stringify({ contract: { id: 'modkit/service-provider-contribution' } }))
  assert.deepEqual(await checkCodecProviderSplit(root), [])

  await writeFile(join(codec, 'codec.json'), JSON.stringify({ contract: { id: 'modkit/service-provider-contribution' }, runtimeVariants: [{ requestedPermissionClasses: ['network'] }] }))
  const errors = await checkCodecProviderSplit(root)
  assert.equal(errors.some(error => error.includes('codecs must use')), true)
  assert.equal(errors.some(error => error.includes('forbidden permission network')), true)
})

test('codec/provider layout gate checks nested domain manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modkit-codec-provider-nested-'))
  fixtureRoots.push(root)
  await writeFile(join(root, 'modkit.repository.json'), JSON.stringify({ extensions: [{ id: 'example/demo', path: 'demo' }] }))
  const codec = join(root, 'demo', 'modules', 'style', 'codecs', 'style')
  const provider = join(root, 'demo', 'modules', 'style', 'providers', 'language')
  await mkdir(codec, { recursive: true }); await mkdir(provider, { recursive: true })
  await writeFile(join(root, 'demo', 'package.json'), JSON.stringify({ modkit: { contributionManifests: ['./modules/*/codecs/*/codec.json', './modules/*/providers/*/provider.json'] } }))
  await writeFile(join(codec, 'codec.json'), JSON.stringify({ id: 'example/style', contract: { id: 'modkit/service-provider-contribution' }, runtimeVariants: [{ requestedPermissionClasses: ['network'] }] }))
  await writeFile(join(provider, 'provider.json'), JSON.stringify({ id: 'example/style-language', contract: { id: 'modkit/codec-contribution' } }))
  const errors = await checkCodecProviderSplit(root)
  assert.equal(errors.some(error => error.includes('codecs must use')), true, errors.join('\n'))
  assert.equal(errors.some(error => error.includes('forbidden permission network')), true, errors.join('\n'))
  assert.equal(errors.some(error => error.includes('providers must use')), true, errors.join('\n'))
})
