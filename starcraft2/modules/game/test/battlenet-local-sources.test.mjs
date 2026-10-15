import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { BattleNetCacheSource } from '../../../dist/modules/game/battlenet/content-sources/cache-source.js'
import { Sc2FolderSource, Sc2MapsCacheSource } from '../../../dist/modules/game/battlenet/content-sources/local-files.js'
import { Sc2DesktopContentSources } from '../../../dist/modules/game/battlenet/content-sources/local-content-sources.js'
import { decodeCacheHeader } from '../../../dist/modules/game/battlenet/content-sources/cache-header.js'

const bytes = text => Buffer.from(text, 'utf8')
const hash = data => createHash('sha256').update(data).digest('hex')
const layers = context => context.layers.map(layer => [layer.sourceId, layer.sourcePath])
const vint = value => {
  let n = BigInt(value), out = [Number(n & 63n) << 1]; n >>= 6n
  while (n) { out[out.length - 1] |= 128; out.push(Number(n & 127n)); n >>= 7n }
  return Buffer.from(out)
}
const integer = n => Buffer.concat([Buffer.from([9]), vint(n)])
const blob = data => Buffer.concat([Buffer.from([2]), vint(data.length), data])
const array = items => Buffer.concat([Buffer.from([0]), vint(items.length), ...items])
const struct = fields => Buffer.concat([Buffer.from([5]), vint(Object.keys(fields).length), ...Object.entries(fields).flatMap(([key, value]) => [vint(key), value])])
const handle = (type, data) => Buffer.concat([bytes(type), Buffer.from([0, 0]), bytes('US'), Buffer.from(hash(data), 'hex')])
const archive = encodeFreshMpq([{ path: 'Base.SC2Data/GameData/Units.xml', bytes: bytes('<Catalog/>') }], 1024 * 1024)
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'modkit-local-sc2-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function cached(root, type, data) {
  const name = `${hash(data)}.${type}`, path = join(root, name.slice(0, 2), name.slice(2, 4))
  await mkdir(path, { recursive: true }); await writeFile(join(path, name), data)
  return name
}
const header = (mpq, locale, id = 1) => struct({ 0: struct({
  0: struct({ 0: integer(id), 1: integer(65537) }), 1: blob(bytes('Original.SC2Mod')),
  2: blob(handle('s2ma', mpq)), 4: struct({ 0: struct({ 1: integer(0), 2: integer(7) }) }),
  8: array([struct({ 0: Buffer.concat([Buffer.from([7]), bytes('ruRU')]), 1: array([blob(handle('s2ml', locale))]) })]),
}) })

test('cache flattens hashed folders, resolves the referenced localized name, and lazily opens a verified MPQ', async t => {
  const root = await setup(t), locale = bytes('<Locale><e id="1">Wrong title</e><e id="7">Карта &amp; мод</e></Locale>')
  await cached(root, 's2ml', locale); await cached(root, 's2ma', archive)
  await cached(root, 's2mh', header(archive, locale))
  // Same name but distinct native identity/revision must remain a separate row.
  await cached(root, 's2mh', header(archive, locale, 2))
  const source = new BattleNetCacheSource(root)
  try {
    const rows = await source.list('')
    assert.equal(rows.length, 2); assert(rows.every(row => row.name.startsWith('Карта & мод [')))
    assert(rows.every(row => !row.path.includes('/')))
    const base = rows[0].path
    const metadata = JSON.parse(Buffer.from(await source.read(`${base}/metadata.json`, 10000)).toString())
    assert.equal(metadata.archivePresent, true); assert.equal(metadata.originalName, 'Original.SC2Mod')
    const resolved = await source.resolveArchive({
      file: `${hash(archive)}.s2ma`,
      sha256: hash(archive),
      type: 's2ma',
      region: 'US',
    })
    assert.equal(resolved.state, 'resolved')
    assert.equal(resolved.path, `${base}/Content`)
    const missingSha = '0'.repeat(64)
    assert.deepEqual(await source.resolveArchive({
      file: `${missingSha}.s2ma`, sha256: missingSha, type: 's2ma', region: 'US',
    }), {
      sourceId: 'local:cache',
      state: 'missing',
      handle: { file: `${missingSha}.s2ma`, sha256: missingSha, type: 's2ma', region: 'US' },
    })
    await assert.rejects(
      source.resolveArchive({ file: 'bad.s2ma', sha256: 'bad', type: 's2ma', region: 'US' }),
      /Invalid Blizzard cache handle/u,
    )
    assert((await source.list(base)).some(item => item.name === 'Content'))
    const content = await source.list(`${base}/Content`)
    assert.equal(content[0].name, 'Base.SC2Data')
    assert.equal(Buffer.from(await source.read(`${base}/Content/Base.SC2Data/GameData/Units.xml`, 100)).toString(), '<Catalog/>')
    assert.equal(Buffer.from(await source.read(`${base}/Content/base.sc2data/gamedata/units.xml`, 100)).toString(), '<Catalog/>')
    await assert.rejects(source.read(`${base}/Content/Base.SC2Data/GameData/Units.xml`, 2), /limit/)
  } finally { await source.dispose() }
})
test('desktop sources open a replay inside the cache archives it names', async t => {
  const root = await setup(t)
  const replay = join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'replays', 'Gresvan-LE.SC2Replay')
  const sources = new Sc2DesktopContentSources({ documentsDirectory: root, battleNetCacheDirectory: root })
  try {
    const context = await sources.openModContext({ schemaVersion: 1, target: replay })
    try {
      // None of its twelve archives is in this empty cache: each is named, none is guessed.
      assert.equal(context.unresolved.length, 12)
      assert.ok(context.unresolved.every(id => /^s2ma:eu:[0-9a-f]{64}$/u.test(id)))
      assert.deepEqual(layers(context), [['host', replay.replaceAll('\\', '/')]])
    } finally { await context.dispose() }
  } finally { await sources.dispose() }
})
test('missing archives, unlinked archives, malformed headers and corruption remain explicit', async t => {
  const root = await setup(t), locale = bytes('<Locale/>')
  await cached(root, 's2mh', header(archive, locale))
  await cached(root, 's2mh', bytes('invalid header'))
  const orphan = encodeFreshMpq([{ path: 'Readme.txt', bytes: bytes('orphan') }], 1024 * 1024)
  const orphanName = await cached(root, 's2ma', orphan)
  const source = new BattleNetCacheSource(root)
  try {
    const rows = await source.list(''); assert.equal(rows.length, 3)
    const missing = rows.find(row => row.name.startsWith('Original'))
    assert(missing.name.includes('метаданные'))
    assert(!(await source.list(missing.path)).some(row => row.name === 'Content'))
    const unknown = rows.find(row => row.name.startsWith('Неизвестная'))
    await writeFile(join(root, orphanName.slice(0, 2), orphanName.slice(2, 4), orphanName), bytes('corrupt'))
    await assert.rejects(source.list(`${unknown.path}/Content`), /SHA-256/)
    await assert.rejects(source.read('../outside', 10), /Invalid/)
    await source.refresh(); assert.equal((await source.list('')).length, 3)
  } finally { await source.dispose() }
})
test('installation source exposes only Maps/Mods, opens packed and loose projects, and refuses links', async t => {
  const root = await setup(t)
  await mkdir(join(root, 'Maps', 'Loose.SC2Map'), { recursive: true })
  await mkdir(join(root, 'Mods')); await mkdir(join(root, 'Secrets'))
  await writeFile(join(root, 'Maps', 'Packed.SC2Mod'), archive)
  await writeFile(join(root, 'Maps', 'Loose.SC2Map', 'MapScript.galaxy'), bytes('void main() {}'))
  await symlink(join(root, 'Secrets'), join(root, 'Mods', 'linked'), 'junction')
  const source = new Sc2FolderSource(root, 'local:installation', 'SC2', ['Maps', 'Mods'])
  try {
    assert.deepEqual((await source.list('')).map(e => e.name), ['Maps', 'Mods'])
    assert((await source.list('Maps')).every(e => e.directory))
    assert.equal((await source.list('Maps/Packed.SC2Mod'))[0].name, 'Base.SC2Data')
    assert.equal(Buffer.from(await source.read('Maps/Loose.SC2Map/MapScript.galaxy', 100)).toString(), 'void main() {}')
    await assert.rejects(source.list('Secrets'), /Maps or Mods/)
    await assert.rejects(source.list('Maps/../Secrets'), /Invalid/)
    assert.deepEqual(await source.list('Mods'), [])
    await assert.rejects(source.list('Mods/linked'), /links/)
    assert.deepEqual(await source.resolveLocalPath(''), { path: await realpath(root), kind: 'directory' })
    assert.equal((await source.resolveLocalPath('Maps/Packed.SC2Mod/Base.SC2Data')).path, join(root, 'Maps', 'Packed.SC2Mod'))
  } finally { await source.dispose() }
})
test('SC2 map cache projects hash-named s2ma folders as logical maps and mods', async t => {
  const root = await setup(t)
  const known = `${'a'.repeat(64)}.s2ma`, unknown = `${'b'.repeat(64)}.s2ma`
  await mkdir(join(root, known, '00000000'), { recursive: true })
  await mkdir(join(root, unknown), { recursive: true })
  await writeFile(join(root, known, '00000000', 'hardTile.bin'), bytes('tile'))
  const source = new Sc2MapsCacheSource(root, async () => new Map([[known, 'Original.SC2Mod']]))
  try {
    const rows = await source.list('')
    assert(rows.some(item => item.name === 'Original.SC2Mod'))
    assert(rows.some(item => item.name.endsWith('.SC2Map')))
    assert(rows.every(item => !item.name.endsWith('.s2ma')))
    assert.equal(Buffer.from(await source.read('Original.SC2Mod/00000000/hardTile.bin', 100)).toString(), 'tile')
    const local = await source.resolveLocalPath('Original.SC2Mod/00000000/hardTile.bin')
    assert.equal(local.kind, 'file')
    assert.equal(local.path, join(root, known, '00000000', 'hardTile.bin'))
  } finally { await source.dispose() }
})
test('documents exposes banks, saves, replays, hotkeys and settings without opening network sessions', async t => {
  const root = await setup(t), names = ['Campaign.SC2Bank', 'Mission.SC2Save', 'Match.SC2Replay', 'Custom.SC2Hotkeys', 'Variables.txt']
  for (const name of names) await writeFile(join(root, name), bytes(name))
  const sources = new Sc2DesktopContentSources({ documentsDirectory: root, battleNetCacheDirectory: root,
    sc2MapsCacheDirectory: root, installationDirectory: root })
  try {
    const snapshot = await sources.snapshot()
    assert.equal(snapshot.roots.length, 4); assert.equal(snapshot.connections.length, 0)
    assert.equal((await sources.list('local:documents', '')).length, 5)
    assert.equal((await sources.list('local:sc2-maps-cache', '')).length, 5)
    assert.equal(Buffer.from(await sources.read('local:documents', 'Custom.SC2Hotkeys', 100)).toString(), 'Custom.SC2Hotkeys')
    assert.throws(() => sources.connect('us'), /not configured/)
  } finally { await sources.dispose() }
})
test('cache parser rejects truncated data, duplicate fields and deep or oversized collections', () => {
  for (const data of [Buffer.from([5, 2]), Buffer.from([0, 3]),
    Buffer.concat([...Array.from({ length: 66 }, () => Buffer.from([4, 1])), integer(0)]),
    Buffer.concat([Buffer.from([0]), vint(100001)])]) {
    assert.throws(() => decodeCacheHeader(data))
  }
  assert.throws(() => decodeCacheHeader(Buffer.concat([Buffer.from([5, 4, 0, 9, 0, 0, 9, 0])])), /Duplicate/)
})
test('local roots coexist with online roots and cannot redirect local reads to the network', async t => {
  const root = await setup(t)
  let remoteReads = 0, remoteDisposed = false
  const remote = { snapshot: async () => ({ regions: [{ id: 'us', label: 'NA' }], connections: [],
    roots: [{ id: 'public:us', label: 'Public', kind: 'public', region: 'us' }] }),
    read: async () => { remoteReads++; return bytes('remote') }, dispose: async () => { remoteDisposed = true } }
  const sources = new Sc2DesktopContentSources({ battleNetCacheDirectory: root,
    sc2MapsCacheDirectory: root, documentsDirectory: root }, remote)
  assert.equal((await sources.snapshot()).roots.length, 4)
  await assert.rejects(sources.read('local:documents', '../outside', 100), /Invalid/)
  assert.equal(remoteReads, 0)
  assert.equal(Buffer.from(await sources.read('public:us', 'readme', 100)).toString(), 'remote')
  await sources.dispose(); assert(remoteDisposed)
})
test('an installed mod opens over its engine layering, naming what it declares but nothing holds', async t => {
  const root = await setup(t), installation = join(root, 'install')
  await mkdir(join(installation, 'Mods', 'Core.SC2Mod'), { recursive: true })
  const liberty = join(installation, 'Mods', 'Liberty.SC2Mod')
  await writeFile(liberty, encodeFreshMpq([
    { path: 'DocumentInfo', bytes: bytes('<DocInfo><Dependencies><Value>bnet:Extra/0.0/1,file:Mods/Extra.SC2Mod</Value></Dependencies></DocInfo>') },
  ], 1024 * 1024))
  const sources = new Sc2DesktopContentSources({ documentsDirectory: root, battleNetCacheDirectory: root, installationDirectory: installation })
  try {
    const context = await sources.openModContext({ schemaVersion: 1, target: liberty })
    try {
      // Core comes from the engine layering; Extra, from Liberty's DocumentInfo, is held by nothing.
      assert.deepEqual(layers(context), [
        ['local:installation', 'Mods/Core.SC2Mod'],
        ['host', liberty.replaceAll('\\', '/')],
      ])
      assert.deepEqual(context.unresolved, ['Extra.SC2Mod'])
    } finally { await context.dispose() }
  } finally { await sources.dispose() }
})
test('an installed Story campaign opens through the campaign and data layers beneath it', async t => {
  const root = await setup(t), installation = join(root, 'install')
  for (const packagePath of [
    'Mods/Core.SC2Mod',
    'Mods/Liberty.SC2Mod',
    'Campaigns/Liberty.SC2Campaign',
    'Mods/Swarm.SC2Mod',
    'Campaigns/Swarm.SC2Campaign',
    'Mods/Void.SC2Mod',
    'Campaigns/Void.SC2Campaign',
    'Campaigns/VoidStory.SC2Campaign',
  ]) await mkdir(join(installation, packagePath), { recursive: true })
  const sources = new Sc2DesktopContentSources({
    documentsDirectory: root,
    battleNetCacheDirectory: root,
    installationDirectory: installation,
  })
  try {
    const context = await sources.openModContext({
      schemaVersion: 1,
      target: { sourceId: 'local:installation', path: 'Campaigns/VoidStory.SC2Campaign' },
    })
    try {
      assert.deepEqual(context.unresolved, [])
      assert.deepEqual(context.layers.map(layer => layer.sourcePath), [
        'Mods/Core.SC2Mod',
        'Mods/Liberty.SC2Mod',
        'Campaigns/Liberty.SC2Campaign',
        'Mods/Swarm.SC2Mod',
        'Campaigns/Swarm.SC2Campaign',
        'Mods/Void.SC2Mod',
        'Campaigns/Void.SC2Campaign',
        'Campaigns/VoidStory.SC2Campaign',
      ])
    } finally { await context.dispose() }
  } finally { await sources.dispose() }
})
// An installed game keeps its stock packages in CASC, not in `Mods`: `MODKIT_SC2_INSTALLATION=<dir>`.
const installedGame = process.env.MODKIT_SC2_INSTALLATION
test('stock packages open out of an installed game\'s CASC storage', {
  skip: installedGame === undefined && 'MODKIT_SC2_INSTALLATION is not set',
}, async () => {
  const sources = new Sc2DesktopContentSources({ installationDirectory: installedGame, wizardDirectories: [] })
  try {
    const context = await sources.openModContext({ schemaVersion: 1, target: { sourceId: 'local:casc', path: 'Mods/Void.SC2Mod' } })
    try {
      assert.deepEqual(context.unresolved, [])
      assert.deepEqual(context.layers.map(layer => `${layer.sourceId}:${layer.sourcePath}`), [
        'local:casc:Mods/Core.SC2Mod', 'local:casc:Mods/Liberty.SC2Mod', 'local:casc:Mods/Swarm.SC2Mod', 'local:casc:Mods/Void.SC2Mod'])
    } finally { await context.dispose() }
    assert.deepEqual((await sources.list('local:casc', '')).map(item => item.name), ['Campaigns', 'Mods'])
    const textures = await sources.list('local:casc', 'Mods/Core.SC2Mod/Base.SC2Assets/Assets/Textures')
    const texture = textures.find(item => !item.directory && item.name.endsWith('.dds'))
    const bytes = await sources.read('local:casc', texture.path, texture.size)
    assert.equal(bytes.byteLength, texture.size)
    assert.equal(Buffer.from(bytes.subarray(0, 4)).toString('latin1'), 'DDS ')
  } finally { await sources.dispose() }
})
