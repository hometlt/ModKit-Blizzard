import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const coreRoot = resolve(process.env.MODKIT_CORE_ROOT ?? resolve(repositoryRoot, '..', 'modkit-core'))
const packages = ['codec-kit', 'core', 'host', 'sdk', 'testkit', 'vfs']

test('link mode resolves every shared Modkit package from MODKIT_CORE_ROOT', () => {
  assert.equal(process.env.MODKIT_LINK_MODE, 'core')
  for (const packageName of packages) {
    const packageRoot = resolve(coreRoot, 'packages', packageName)
    const manifestPath = resolve(packageRoot, 'package.json')
    assert.ok(existsSync(manifestPath), `${packageName} package root`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const exported = manifest.exports['.']
    const entry = typeof exported === 'string' ? exported : exported.default
    assert.equal(
      import.meta.resolve(`@modkit/${packageName}`),
      pathToFileURL(resolve(packageRoot, entry)).href,
      packageName,
    )
  }
})
