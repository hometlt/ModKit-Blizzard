import assert from 'node:assert/strict'
import test from 'node:test'
import { Sc2DesktopContentSources } from '../../../dist/modules/game/battlenet/content-sources/local-content-sources.js'

// An installed game keeps its stock packages in CASC: `MODKIT_SC2_INSTALLATION=<dir>`.
const installedGame = process.env.MODKIT_SC2_INSTALLATION

test('a workspace search reads the CASC storage in pages, narrowed inside the source', {
  skip: installedGame === undefined && 'MODKIT_SC2_INSTALLATION is not set',
}, async () => {
  // Offline a listing and a search see the same installed files; online a listing adds CDN ones.
  const sources = new Sc2DesktopContentSources({ installationDirectory: installedGame, wizardDirectories: [], cascOnline: false })
  const walk = async path => (await Promise.all((await sources.list('local:casc', path))
    .map(entry => entry.directory ? walk(entry.path) : [entry]))).flat()
  const all = async (path, query) => {
    const items = []
    let cursor
    do {
      const page = await sources.files('local:casc', path, { ...query, ...(cursor === undefined ? {} : { cursor }) })
      items.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return items
  }
  try {
    // Small pages: the same files a folder walk finds, spelled the same way.
    const folder = 'Mods/Core.SC2Mod/Base.SC2Data'
    const walked = (await walk(folder)).map(item => `${item.path}|${item.size}`).sort()
    assert.ok(walked.length > 100)
    assert.deepEqual((await all(folder, { limit: 97 })).map(item => `${item.path}|${item.size}`).sort(), walked)

    const xml = await all('', { extensions: ['xml'], limit: 10_000 })
    assert.ok(xml.length > 1000)
    assert.ok(xml.every(item => item.path.endsWith('.xml') && /^(Mods|Campaigns)\//u.test(item.path)))

    const named = await all('', { pattern: 'Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml', limit: 50 })
    assert.ok(named.some(item => item.path === 'Mods/liberty.sc2mod/base.sc2data/gamedata/unitdata.xml'))
    assert.ok(named.every(item => item.path.toLowerCase().includes('liberty')))

    const bare = await all('Mods', { extensions: [''], limit: 10_000 })
    assert.ok(bare.every(item => !item.path.slice(item.path.lastIndexOf('/') + 1).includes('.')))
    assert.equal(await sources.files('local:documents', '', { limit: 10 }), undefined)
  } finally { await sources.dispose() }
})

test('local:casc offline lists only the files whose bytes the installation keeps', {
  skip: installedGame === undefined && 'MODKIT_SC2_INSTALLATION is not set',
}, async () => {
  const sources = new Sc2DesktopContentSources({ installationDirectory: installedGame, wizardDirectories: [], cascOnline: false })
  const walk = async path => (await Promise.all((await sources.list('local:casc', path))
    .map(entry => entry.directory ? walk(entry.path) : [entry]))).flat()
  try {
    // Every file Core lists reads: a partial install names other locales' files without their bytes.
    const listed = await walk('Mods/Core.SC2Mod')
    assert.ok(listed.length > 100)
    for (const file of listed) await sources.read('local:casc', file.path, 64 << 20)
    const page = await sources.files('local:casc', 'Mods/Core.SC2Mod', { limit: 10_000 })
    // The stock DocumentInfo the source projects is spelled in lower case by a search.
    const spelled = items => items.map(item => item.path.toLowerCase()).sort()
    assert.deepEqual(spelled(page.items), spelled(listed))
  } finally {
    await sources.dispose()
  }
})

// Reads Blizzard's CDN: `MODKIT_CASC_CDN=1` with an installed game whose storage lacks a locale.
test('local:casc online lists another locale and reads it from the CDN once, into the cache', {
  skip: (installedGame === undefined || process.env.MODKIT_CASC_CDN !== '1') && 'MODKIT_SC2_INSTALLATION and MODKIT_CASC_CDN=1 are not set',
}, async () => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cache = await mkdtemp(join(process.env.MKTEMP ?? tmpdir(), 'casc-cdn-'))
  const open = online => new Sc2DesktopContentSources({ installationDirectory: installedGame, wizardDirectories: [],
    indexCacheDirectory: cache, cascOnline: online })
  try {
    const walk = async (sources, path) => (await Promise.all((await sources.list('local:casc', path))
      .map(entry => entry.directory ? walk(sources, entry.path) : [entry]))).flat()
    const offline = open(false)
    const installed = new Set((await walk(offline, 'Mods/Core.SC2Mod')).map(entry => entry.path.toLowerCase()))
    await offline.dispose()
    const sources = open(true)
    const missing = (await walk(sources, 'Mods/Core.SC2Mod'))
      .find(entry => entry.path.endsWith('.xml') && entry.size < 1 << 20 && !installed.has(entry.path.toLowerCase()))
    assert.ok(missing, 'the installation holds every file of Core; nothing to read from the CDN')
    const path = missing.path
    const bytes = await sources.read('local:casc', path, 64 << 20)
    assert.equal(bytes.byteLength, missing.size)
    assert.match(new TextDecoder().decode(bytes.subarray(0, 64)), /<\?xml/u)
    await sources.dispose()
    const [folder] = await readdir(cache)
    assert.ok((await readdir(join(cache, folder, 'cdn'), { recursive: true })).length > 0)
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
})
