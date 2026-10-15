import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryName = 'modkit-extensions-blizzard'
const historicalName = ['modkit', 'blizzard'].join('-')
const excludedDirectories = new Set(['.git', '.tmp', 'dist', 'node_modules', 'vendor'])

async function findHistoricalReferences(directory = repositoryRoot) {
  const references = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        references.push(...(await findHistoricalReferences(absolutePath)))
      }
      continue
    }
    if (!entry.isFile()) continue
    const contents = await readFile(absolutePath)
    if (!contents.includes(Buffer.from(historicalName))) continue
    const lines = contents.toString('utf8').split(/\r?\n/u)
    for (const line of lines) {
      if (line.includes(historicalName)) {
        references.push([relative(repositoryRoot, absolutePath).replaceAll('\\', '/'), line.trim()])
      }
    }
  }
  return references.sort(([leftPath, leftLine], [rightPath, rightLine]) =>
    `${leftPath}:${leftLine}`.localeCompare(`${rightPath}:${rightLine}`),
  )
}

test('repository uses its physical identity without changing stable package coordinates', async () => {
  assert.equal(basename(repositoryRoot), repositoryName)
  const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'))
  assert.equal(packageManifest.name, '@modkit/blizzard-extensions')
  const readme = await readFile(resolve(repositoryRoot, 'README.md'), 'utf8')
  assert.match(readme, new RegExp(`\\b${repositoryName}\\b`, 'u'))
  const galaxyNotice = await readFile(
    resolve(repositoryRoot, 'licenses', 'GALAXY-LANGUAGE-NOTICE.md'),
    'utf8',
  )
  assert.match(galaxyNotice, new RegExp(`\\b${repositoryName}\\b`, 'u'))
})

test('the previous repository token remains only in stable historical provenance identifiers', async () => {
  assert.deepEqual(await findHistoricalReferences(), [
    [
      'starcraft2/modules/map/codecs/package/src/world-writer.js',
      `implementation: '${historicalName}/starcraft2/modules/map/codecs/package/src/world-writer.js',`,
    ],
    [
      'starcraft2/modules/triggers/services/galaxy-conversion/service.js',
      `adaptation: '${historicalName}/structured-trigger-galaxy@3',`,
    ],
    [
      'starcraft2/modules/triggers/services/galaxy-conversion/service.js',
      `galaxyParser: '${historicalName}/galaxy-language/language-core',`,
    ],
    [
      'starcraft2/test/sc2-map-world-writer.test.ts',
      `corpusId: '${historicalName}/starcraft2/test/sc2-map-world-writer',`,
    ],
  ])
})
