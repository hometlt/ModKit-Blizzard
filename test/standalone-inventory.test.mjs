import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  buildInventory,
  createHostContributionContractRegistry,
  inventoryHasErrors,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const repository = JSON.parse(
  await readFile(new URL('../modkit.repository.json', import.meta.url), 'utf8'),
)
const migratedRoots = ['blizzard-common-formats', 'blizzard-diablo', 'blizzard-warcraft-3']

async function codecManifests(extensionPath) {
  const result = []
  for (const relativeDirectory of ['contributions', 'codecs']) {
    const directory = join(repositoryRoot, extensionPath, relativeDirectory)
    const visit = async current => {
      for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (entry.name.endsWith('.json')) {
          const manifest = JSON.parse(await readFile(path, 'utf8'))
          if (manifest.contract?.id === 'modkit/codec-contribution') result.push(manifest)
        }
      }
    }
    await visit(directory)
  }
  return result
}

test('all Blizzard roots load into one valid standalone inventory', async () => {
  assert.equal(repository.extensions.length, 10)
  const inputs = await Promise.all(
    repository.extensions.map(async extension => ({
      ...(await loadExtensionDirectory(join(repositoryRoot, extension.path))),
      execution: { origin: 'bundled', allowTrustedInProcess: true },
    })),
  )
  const inventory = await buildInventory(inputs, createHostContributionContractRegistry())
  assert.equal(inventory.extensions.length, repository.extensions.length)
  assert.equal(inventoryHasErrors(inventory), false, JSON.stringify(inventory, null, 2))
  assert.deepEqual(
    inventory.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
  )
  assert.deepEqual(
    inventory.extensions
      .map(extension => `${extension.manifest.publisher}/${extension.manifest.id}`)
      .sort(),
    repository.extensions.map(extension => extension.id).sort(),
  )
})

test('every migrated runtime entrypoint imports as a codec module', async () => {
  const seen = new Set()
  for (const extensionPath of migratedRoots) {
    for (const manifest of await codecManifests(extensionPath)) {
      for (const variant of manifest.runtimeVariants ?? []) {
        const key = `${extensionPath}:${variant.entrypoint}`
        if (seen.has(key)) continue
        seen.add(key)
        const module = await import(
          pathToFileURL(join(repositoryRoot, extensionPath, variant.entrypoint)).href
        )
        assert.equal(module.abiVersion, 1, key)
        assert.equal(typeof module.createCodec, 'function', key)
      }
    }
  }
  assert.equal(seen.size, 10)
})

test('runtime roots contain no migration receipts or nested license directories', async () => {
  for (const extension of repository.extensions) {
    const names = await readdir(new URL(`../${extension.path}/`, import.meta.url))
    assert.equal(
      names.some(name => /migration|mk2-conversion/iu.test(name)),
      false,
      extension.path,
    )
    assert.equal(
      names.some(name => /^licenses?$/iu.test(name)),
      false,
      extension.path,
    )
  }
})
