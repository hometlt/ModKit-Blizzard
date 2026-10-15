import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import test from 'node:test'
import {
  SC2_EDITOR_PREFERENCES_KEY,
  documentsDirectory,
  editorWizardDirectories,
  parseWizardExtraDirectories,
} from '../../../dist/modules/game/battlenet/content-sources/windows-folders.js'
import { Sc2DesktopContentSources, discoverLocalOptions, localOptions } from '../../../dist/modules/game/battlenet/content-sources/local-content-sources.js'

// The host's probes give REG_BINARY as lowercase hex digits (core 174a97c5).
const hexOf = text => Buffer.from(text, 'latin1').toString('hex')
const noRegistry = { registryValues: async () => ({}) }

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'modkit-sc2-folders-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('takes Documents from the host probes, else ~/Documents', async t => {
  const root = await scratch(t)
  const moved = join(root, 'OneDrive', 'Documents')
  await mkdir(moved, { recursive: true })
  const fallback = join(homedir(), 'Documents')
  const probes = { ...noRegistry, knownFolder: async folder => (folder === 'documents' ? moved : undefined) }
  assert.equal(await documentsDirectory(probes), moved)
  assert.equal(await documentsDirectory(), fallback)
  // A host from before knownFolder, a failing probe and a folder that is not there.
  assert.equal(await documentsDirectory(noRegistry), fallback)
  assert.equal(await documentsDirectory({ ...noRegistry, knownFolder: async () => { throw new Error('probe') } }), fallback)
  assert.equal(await documentsDirectory({ ...noRegistry, knownFolder: async () => join(root, 'gone') }), fallback)
})

test('reads the editor wizard folders through the host registry probe', async t => {
  const root = await scratch(t)
  const documents = join(root, 'StarCraft II')
  const extra = join(root, 'Extra')
  await mkdir(join(documents, 'EditorWizards'), { recursive: true })
  await mkdir(extra)
  const asked = []
  const probes = {
    async registryValues(hive, key, names) {
      asked.push([hive, key, names])
      return { WizardExtraDirsEnabled: hexOf(`${extra};${join(root, 'gone')}\0`) }
    },
  }
  assert.deepEqual(await editorWizardDirectories(documents, probes), [join(documents, 'EditorWizards'), extra])
  assert.deepEqual(asked, [['HKCU', SC2_EDITOR_PREFERENCES_KEY, ['WizardExtraDirsEnabled']]])
  assert.deepEqual(await editorWizardDirectories(documents), [join(documents, 'EditorWizards')])
  const failing = { registryValues: async () => { throw new Error('no key') } }
  assert.deepEqual(await editorWizardDirectories(documents, failing), [join(documents, 'EditorWizards')])
})

test('discovery puts the caches under the probed ProgramData and keeps configured folders', async t => {
  const root = await scratch(t)
  const programData = join(root, 'ProgramData')
  const documents = join(root, 'Documents')
  await mkdir(programData)
  await mkdir(documents)
  const probes = { ...noRegistry, knownFolder: async folder => (folder === 'program-data' ? programData : documents) }
  const blizzard = join(programData, 'Blizzard Entertainment')
  const found = await discoverLocalOptions({}, probes)
  assert.equal(found.documentsDirectory, join(documents, 'StarCraft II'))
  assert.equal(found.battleNetCacheDirectory, join(blizzard, 'Battle.net', 'Cache'))
  assert.equal(found.sc2MapsCacheDirectory, join(blizzard, 'StarCraft II', 'Maps', 'Cache'))
  const kept = await discoverLocalOptions({ battleNetCacheDirectory: join(root, 'mine'), documentsDirectory: join(root, 'docs') }, probes)
  assert.equal(kept.battleNetCacheDirectory, join(root, 'mine'))
  assert.equal(kept.documentsDirectory, join(root, 'docs'))
  assert.equal(kept.sc2MapsCacheDirectory, join(blizzard, 'StarCraft II', 'Maps', 'Cache'))
  // Without probes nothing is guessed here; the source's own defaults apply later.
  const bare = await discoverLocalOptions({ documentsDirectory: join(root, 'docs') })
  assert.equal(bare.battleNetCacheDirectory, undefined)
})

test('decodes WizardExtraDirsEnabled with one and with two folders', () => {
  // SC2Editor 5.0.16 writes one NUL-terminated ASCII string; folders are separated by `;`.
  const one = hexOf('C:\\Wizards\\A\\\0')
  const two = hexOf('C:\\Wizards\\A\\;C:\\Wizards\\A\\w2\\\0')
  assert.deepEqual(parseWizardExtraDirectories(one), ['C:\\Wizards\\A'])
  assert.deepEqual(parseWizardExtraDirectories(two), ['C:\\Wizards\\A', 'C:\\Wizards\\A\\w2'])
  assert.deepEqual(parseWizardExtraDirectories(hexOf('relative\\folder\0')), [])
  assert.deepEqual(parseWizardExtraDirectories('not-hex'), [])
})

test('layers wizard folders beneath every mod context over ordinary local folder sources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'modkit-sc2-wizards-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, 'EditorWizards')
  const second = join(root, 'Extra')
  await mkdir(first, { recursive: true })
  await mkdir(second, { recursive: true })
  await writeFile(join(second, 'Tool.BlizWiz'), '<wizardfile/>')
  const sources = new Sc2DesktopContentSources(localOptions({
    documentsDirectory: root,
    battleNetCacheDirectory: join(root, 'cache'),
    wizardDirectories: [first, second],
  }))
  t.after(() => sources.dispose())
  await writeFile(join(root, 'Main.galaxy'), 'void main() {}')
  const context = await sources.openModContext({ schemaVersion: 1, target: join(root, 'Main.galaxy') })
  t.after(() => context.dispose())
  assert.deepEqual(context.layers.filter(layer => layer.provenance === 'setting').map(layer => [layer.sourceId, layer.sourcePath, layer.role]), [
    ['local:editor-wizards:0', '', 'dependency'],
    ['local:editor-wizards:1', '', 'dependency'],
  ])
  const listed = await sources.list('local:editor-wizards:1', '')
  assert.deepEqual(listed.map(item => item.name), ['Tool.BlizWiz'])
  assert.throws(() => localOptions({ wizardDirectories: 'C:\\one' }), /wizardDirectories/)
})
