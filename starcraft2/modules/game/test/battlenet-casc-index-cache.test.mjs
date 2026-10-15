import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalInstallation, installationCacheFolder } from '@modkit/blizzard-casc/root-cache-node'
import { Sc2DesktopContentSources } from '../../../dist/modules/game/battlenet/content-sources/local-content-sources.js'

// An installed game keeps its stock packages in CASC: `MODKIT_SC2_INSTALLATION=<dir>`.
const installedGame = process.env.MODKIT_SC2_INSTALLATION

test('local:casc names its build for index caches and keeps its name index in the shared directory', {
  skip: installedGame === undefined && 'MODKIT_SC2_INSTALLATION is not set',
}, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'modkit-casc-index-cache-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const shared = join(scratch, 'index-cache')
  const own = join(scratch, 'content-sources-cache')
  // The copy this source kept in its own directory before the shared one, under the raw path.
  const legacy = join(own, 'casc-index', installationCacheFolder(installedGame))
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'old.bin'), 'x')

  const sources = new Sc2DesktopContentSources({
    installationDirectory: installedGame,
    wizardDirectories: [],
    cacheDirectory: own,
    indexCacheDirectory: shared,
  })
  t.after(() => sources.dispose())
  const root = (await sources.snapshot()).roots.find(item => item.id === 'local:casc')
  assert.equal(root?.product, 's2')
  assert.equal(root?.game, 'starcraft2')
  // The build key, then the version of the stock metadata this source projects.
  assert.match(root?.revision ?? '', /^[0-9a-f]{32}:/u)

  assert.ok((await sources.list('local:casc', 'Mods')).length > 0)
  await assert.rejects(stat(legacy))
  const folder = installationCacheFolder(canonicalInstallation(installedGame))
  assert.deepEqual(await readdir(shared), [folder])
  assert.deepEqual(JSON.parse(await readFile(join(shared, folder, 'cache.json'), 'utf8')), {
    game: 'starcraft2',
    product: 's2',
    kind: 'names',
    installation: canonicalInstallation(installedGame),
  })
})

test('local:casc keeps no name index for a product the user turned off', {
  skip: installedGame === undefined && 'MODKIT_SC2_INSTALLATION is not set',
}, async t => {
  const shared = await mkdtemp(join(tmpdir(), 'modkit-casc-index-off-'))
  t.after(() => rm(shared, { recursive: true, force: true }))
  const sources = new Sc2DesktopContentSources({
    installationDirectory: installedGame,
    wizardDirectories: [],
    indexCacheDirectory: shared,
    indexCaches: { s2: { names: false } },
  })
  t.after(() => sources.dispose())
  assert.ok((await sources.list('local:casc', 'Mods')).length > 0)
  assert.deepEqual(await readdir(shared), [])
})
