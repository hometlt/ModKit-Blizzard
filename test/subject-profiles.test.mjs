import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const repository = JSON.parse(await readFile(resolve(root, 'modkit.repository.json'), 'utf8'))

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'))
}

async function contributionFiles(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await contributionFiles(path)))
    else if (
      entry.name === 'codec.json' ||
      entry.name === 'provider.json' ||
      (basename(directory) === 'contributions' && entry.name.endsWith('.json'))
    )
      found.push(path)
  }
  return found
}

test('repository subject profiles are confined, linked and complete', async () => {
  assert.deepEqual(Object.keys(repository.subjects).sort(), ['games', 'vendors'])
  assert.deepEqual(repository.subjects.vendors, ['subjects/vendors/blizzard.json'])
  assert.deepEqual(repository.subjects.games, [
    'subjects/games/starcraft-2.json',
    'subjects/games/diablo-3.json',
    'subjects/games/warcraft-3.json',
    'subjects/games/starcraft-1.json',
    'subjects/games/heroes-of-the-storm.json',
    'subjects/games/world-of-warcraft.json',
  ])

  const vendor = await json(repository.subjects.vendors[0])
  assert.equal(vendor.kind, 'vendor')
  assert.equal(vendor.id, 'blizzard')
  assert.equal(vendor.displayName, 'Blizzard')
  assert.equal(new URL(vendor.officialSite).protocol, 'https:')

  const extensionIds = new Set(repository.extensions.map(extension => extension.id))
  const contributionIds = new Set()
  for (const extension of repository.extensions) {
    const packageRoot = resolve(root, extension.path)
    for (const file of await contributionFiles(packageRoot)) contributionIds.add((await json(file)).id)
  }
  for (const path of repository.subjects.games) {
    const game = await json(path)
    assert.equal(game.kind, 'game')
    assert.equal(game.vendorId, vendor.id)
    assert.match(game.id, /^blizzard\//u)
    for (const requirement of game.extensionRequirements ?? [])
      assert.equal(extensionIds.has(requirement.id), true, requirement.id)
    for (const capability of game.capabilityRequirements ?? []) {
      assert.ok(capability.displayName)
      for (const id of capability.contributionIds ?? [])
        assert.equal(contributionIds.has(id), true, id)
    }
    for (const resource of game.resources ?? [])
      assert.equal(new URL(resource.url).protocol, 'https:')
  }
})
