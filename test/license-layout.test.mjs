import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const ignoredDirectories = new Set(['.git', 'node_modules', 'vendor'])

async function collectLicenseDirectories(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (/^(?:licenses|third_party_licenses)$/iu.test(entry.name)) result.push(path)
    await collectLicenseDirectories(path, result)
  }
  return result
}

test('the repository has exactly one central license directory', async () => {
  const directories = await collectLicenseDirectories(repositoryRoot)
  assert.deepEqual(
    directories.map(path => relative(repositoryRoot, path).replaceAll('\\', '/')),
    ['licenses'],
  )
  const files = await readdir(new URL('../licenses/', import.meta.url))
  assert.deepEqual(files.sort(), [
    'GALAXY-LANGUAGE-NOTICE.md',
    'GPL-2.0-only.txt',
    'MIT.txt',
    'README.md',
    'THIRD-PARTY-NOTICES.md',
    'TRADEMARKS.md',
    'WarsmashModEngine-AGPL-3.0.txt',
    'mdx-m3-viewer-MIT.txt',
    'plaxtony-MIT.txt',
    's2protocol-MIT.txt',
    'sax-BlueOak-1.0.0.md',
    'war3-model-MIT.txt',
  ])
})

test('legal documents refer to central license paths', async () => {
  const notices = await readFile(new URL('../licenses/THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8')
  assert.match(notices, /licenses\/sax-BlueOak-1\.0\.0\.md/u)
  assert.match(notices, /licenses\/plaxtony-MIT\.txt/u)
  assert.doesNotMatch(notices, /THIRD_PARTY_LICENSES/u)
})
