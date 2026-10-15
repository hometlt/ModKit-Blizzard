import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const module = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')
const community = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'dist', 'game', 'community-data.js')).href
)) as typeof import('../dist/game/community-data.js')

const COLUMNS = 'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Path!STRING:0|Version!STRING:0|Product!STRING:0'

/** A `.build.info` table as the Battle.net agent writes it, one row per `[active, product, version]`. */
async function cascRoot(rows: readonly (readonly [number, string, string])[]): Promise<string> {
  await mkdir('C:/MKTEMP/modkit-wow-test', { recursive: true })
  const root = await mkdtemp('C:/MKTEMP/modkit-wow-test/install-')
  const lines = rows.map(([active, product, version], index) =>
    `eu|${String(active)}|${String(index + 1).padStart(32, '0')}|tpr/wow|${version}|${product}`)
  await writeFile(join(root, '.build.info'), `${COLUMNS}\n${lines.join('\n')}\n`, 'utf8')
  await mkdir(join(root, 'Data'))
  return root
}

const discover = (root: string) =>
  module.discoverWowInstallations({ gameId: 'blizzard/world-of-warcraft', configuredPaths: [root], maxCandidates: 8 })

describe('World of Warcraft installation discovery', () => {
  it('confirms a folder by its active WoW products, retail first, and reports them all', async () => {
    const root = await cascRoot([[1, 'wow_classic', '5.5.1.1'], [1, 'wow', '12.1.0.69933'], [0, 'wowt', '12.2.0.1']])
    const result = await discover(root)
    expect(result.installations).toHaveLength(1)
    expect(result.installations[0]!.version).toBe('12.1.0.69933')
    expect((await module.installedWowProducts(root)).map(item => item.product)).toEqual(['wow', 'wow_classic'])
    expect(result.installations[0]!.evidence.find(item => item.kind === 'wow-build-products')?.detail)
      .toBe('wow=12.1.0.69933;wow_classic=5.5.1.1')
  })

  it('refuses another CASC product: a .build.info proves CASC, not WoW', async () => {
    const result = await discover(await cascRoot([[1, 's2', '5.0.14']]))
    expect(result.installations).toHaveLength(0)
    expect(result.diagnostics.map(item => item.code)).toContain('blizzard.world-of-warcraft/installation-not-found')
  })

  it('takes the uninstall entry (a flavor folder names its installation) and keeps every origin', async () => {
    const root = await cascRoot([[1, 'wow', '12.1.0.69933']])
    const result = await module.discoverWowInstallations(
      { gameId: 'blizzard/world-of-warcraft', searchPaths: [root], maxCandidates: 8 },
      {
        registryValues: async (hive, key, names) =>
          hive === 'HKLM' && key.endsWith(String.raw`Uninstall\World of Warcraft`) ? { [names[0]!]: join(root, '_retail_') } : {},
      } as Parameters<typeof module.discoverWowInstallations>[1],
    )
    expect(result.installations).toHaveLength(1)
    expect([...result.installations[0]!.origins].sort()).toEqual(['registry', 'search-folder'])
  })

  it('reads the TACT key list and skips what is not a key', () => {
    const keys = community.parseTactKeys('FA505078126ACB3E BDC51862ABED79B2DE48C8E7E66C6200 15444\nnot a key\n')
    expect([...keys.keys()]).toEqual(['fa505078126acb3e'])
    expect(keys.get('fa505078126acb3e')![0]).toBe(0xbd)
  })
})
