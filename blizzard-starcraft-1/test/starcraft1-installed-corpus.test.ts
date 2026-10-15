/**
 * The installed game through the product route: installation discovery, then the host opens its
 * maps (`Maps\**\*.scm|scx` over blizzard/mpq) and, from the Remastered storage (blizzard/casc),
 * the string table and the campaign scenarios as nested subjects. Runs in the `real` tier only.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nestedSubjectServices, openNestedSubject } from '@modkit/host'
import { createModkit, createNodeInstallationProbes } from '@modkit/host/node'
import type { RasterImageSource, TableDataSource } from '@modkit/sdk'

const extension = join(import.meta.dirname, '..')
const { createContentSources, STARCRAFT1_ROOT_ID } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href
)) as typeof import('../dist/game/content-sources.js')
const { discoverStarcraft1Installations } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')

const installation = process.env['MODKIT_TEST_INSTALLED_CORPUS'] === '1'
  ? (await discoverStarcraft1Installations({ gameId: 'blizzard/starcraft-1', maxCandidates: 16 }, createNodeInstallationProbes())).installations[0]
  : undefined
const remastered = installation?.displayName === 'StarCraft: Remastered'
const grant = { id: 'starcraft1-corpus', classes: ['read-source'] } as const
const budget = { maxInputBytes: 64_000_000n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 16_000_000, maxDiagnostics: 1000 }
/** Editors make maps of any size up to 256 tiles a side (Benzene 1.1 is 128 × 112), not only the standard ones. */
const sized = (summary: Record<string, unknown>) => [summary['width'], summary['height']].every(value => typeof value === 'number' && value >= 1 && value <= 256)

type Opened = Awaited<ReturnType<Awaited<ReturnType<typeof createModkit>>['open']>>

async function inspect(session: NonNullable<Opened['session']>, operations: readonly { id: string; handlerId: string }[]) {
  const result = await session.operations().invoke(operations.find(item => item.id === 'view.inspect')!.handlerId, null as never)
  if (result.state !== 'ok') throw new Error(JSON.stringify(result))
  return (result.output as { value: Record<string, unknown> }).value
}

describe.skipIf(installation === undefined)('installed StarCraft', () => {
  it('opens every map that names its scenario; a protected one without names is reported, not guessed', async () => {
    const maps = join(installation!.installPath, 'Maps')
    const files = (await readdir(maps, { recursive: true })).filter(name => /\.sc[mx]$/iu.test(name))
    expect(files.length).toBeGreaterThan(0)
    const m = await createModkit({ extensions: [join(extension, '..', 'mpq'), extension], roots: [maps], budget })
    const archives = await createModkit({ extensions: [join(extension, '..', 'mpq')], roots: [maps], budget })
    const opened: string[] = []
    const protectedMaps: string[] = []
    try {
      for (const file of files) {
        const map = await m.open(join(maps, file))
        try {
          const snapshot = map.snapshot
          if (snapshot.state === 'opened' && snapshot.selected.contributionId === 'blizzard/starcraft1-map') {
            expect(snapshot.descriptor.diagnostics.filter(item => item.severity === 'error'), file).toEqual([])
            const summary = await inspect(map.session!, snapshot.descriptor.operations)
            expect(sized(summary), `${file} ${JSON.stringify(summary)}`).toBe(true)
            opened.push(file)
            continue
          }
        } finally {
          await map.close()
        }
        // Not ours: then the archive must be one that names no scenario — no listfile, or tables the
        // MPQ reader refuses — which the game still reads by the scenario's hash (Core/Formats, handoff).
        const archive = await archives.open(join(maps, file))
        try {
          if (archive.snapshot.state === 'opened') {
            const lease = await archive.session!.dataSource('common.view/namespace-entry-source', 1)
            const listed = await (lease.value as { list(prefix: string, page: { limit: number }): Promise<{ items: { path: string }[] }> })
              .list('', { limit: 64 })
              .finally(() => lease.release())
            expect(listed.items.some(item => item.path.toLowerCase() === 'staredit/scenario.chk'), `${file} names its scenario`).toBe(false)
          }
        } finally {
          await archive.close()
        }
        protectedMaps.push(file)
      }
    } finally {
      await m.close()
      await archives.close()
    }
    console.info(`StarCraft maps: ${String(opened.length)} opened, ${String(protectedMaps.length)} protected: ${protectedMaps.join(', ')}`)
    expect(opened.length).toBeGreaterThan(protectedMaps.length)
  }, 1_200_000)

  it.skipIf(!remastered)('reads the Remastered string table and campaign scenarios out of the storage', async () => {
    const m = await createModkit({ extensions: [join(extension, '..', 'casc'), extension], roots: [installation!.installPath], budget })
    const casc = await m.open(installation!.installPath)
    try {
      if (casc.snapshot.state !== 'opened') throw new Error(JSON.stringify(casc.snapshot))
      const nested = (entryId: string) =>
        openNestedSubject({ ...nestedSubjectServices(m.services), parent: casc.session!, entryId, grant, budget, intent: 'full' })

      // The data tables, named from the storage's string tables: the game's own numbers.
      const row = async (entryId: string, index: number) => {
        const opened = await nested(entryId)
        if (opened.result.state !== 'opened') throw new Error(`${entryId}: ${JSON.stringify(opened.result.diagnostics)}`)
        try {
          expect(opened.result.selected.contributionId).toBe('blizzard/starcraft1-dat')
          const table = await opened.result.session.dataSource('common.view/table-data-source', 1)
          try {
            const source = table.value as TableDataSource
            const header = (await source.shape()).header!
            const cells = (await source.rows({ kind: 'range', from: index, count: 1 })).items[0]!.cells
            return Object.fromEntries(header.map((name, column) => [name, cells[column]]))
          } finally {
            await table.release()
          }
        } finally {
          await opened.result.session.dispose()
        }
      }
      expect(await row('arr/units.dat', 0)).toMatchObject({ name: 'Terran Marine', hitPoints: '10240', mineralCost: '50', buildTime: '360', groundWeapon: '0', placementBox: '17, 20' })
      expect(await row('arr/weapons.dat', 0)).toMatchObject({ name: 'Gauss Rifle', damage: '6', maximumRange: '128', cooldown: '15' })

      // A tileset by its .cv5, the era's other files beside it in the storage: every megatile drawn.
      const tileset = await nested('tileset/badlands.cv5')
      if (tileset.result.state !== 'opened') throw new Error(JSON.stringify(tileset.result.diagnostics))
      try {
        expect(tileset.result.selected.contributionId).toBe('blizzard/starcraft1-tileset')
        const raster = await tileset.result.session.dataSource('common.view/raster-image-source', 1)
        try {
          const info = await (raster.value as RasterImageSource).info()
          expect([info.width, info.height % 32]).toEqual([1024, 0])
          expect(info.height).toBeGreaterThan(32 * 100)
        } finally {
          await raster.release()
        }
      } finally {
        await tileset.result.session.dispose()
      }

      const tbl = await nested('rez/stat_txt.tbl')
      if (tbl.result.state !== 'opened') throw new Error(JSON.stringify(tbl.result.diagnostics))
      try {
        expect(tbl.result.selected.contributionId).toBe('blizzard/starcraft1-tbl')
        const table = await tbl.result.session.dataSource('common.view/table-data-source', 1)
        const rows = await (table.value as TableDataSource).rows({ kind: 'range', from: 0, count: 2 }).finally(() => table.release())
        // A unit's name, then what the editors keep after it: its group and subgroup.
        expect(rows.items[0]?.cells).toEqual(['1', 'Terran Marine', '* / Ground Units'])
      } finally {
        await tbl.result.session.dispose()
      }

      const lease = await casc.session!.dataSource('common.view/namespace-entry-source', 1)
      const scenarios: string[] = []
      try {
        const source = lease.value as { list(prefix: string, page: { limit: number; cursor?: string }): Promise<{ items: { path: string; size?: bigint }[]; nextCursor?: string }> }
        for (let cursor: string | undefined, first = true; first || cursor !== undefined; first = false) {
          const page = await source.list('sd/campaign', { limit: 256, ...(cursor === undefined ? {} : { cursor }) })
          // The storage keeps some empty placeholders (sd/campaign/starcraft/swar): nothing to open.
          scenarios.push(...page.items.filter(item => item.path.endsWith('/scenario.chk') && item.size !== 0n).map(item => item.path))
          cursor = page.nextCursor
        }
      } finally {
        await lease.release()
      }
      expect(scenarios.length).toBeGreaterThan(50)
      for (const entryId of scenarios) {
        const scenario = await nested(entryId)
        if (scenario.result.state !== 'opened') throw new Error(`${entryId}: ${JSON.stringify(scenario.result.diagnostics)}`)
        try {
          expect(scenario.result.selected.contributionId, entryId).toBe('blizzard/starcraft1-chk')
          const summary = await inspect(scenario.result.session, scenario.result.descriptor.operations)
          // Remastered keeps the scenario strings of these copies empty (the names are in the localized
          // copies under locales/): what must hold is the scenario itself.
          expect(sized(summary) && (summary['players'] as number) > 0, `${entryId} ${JSON.stringify(summary)}`).toBe(true)
          expect(scenario.result.descriptor.diagnostics.filter(item => item.severity === 'error'), entryId).toEqual([])
          // The storage it lies in holds its tileset: the terrain is drawn, one pixel a tile at level 5.
          expect(summary['terrain'], entryId).toBe(true)
          const raster = await scenario.result.session.dataSource('common.view/raster-image-source', 1)
          try {
            const source = raster.value as RasterImageSource
            const width = summary['width'] as number
            const height = summary['height'] as number
            const minimap = await source.readRegion!({ x: 0, y: 0, width, height, mipLevel: 5, pixelFormat: 'rgba8', maxBytes: width * height * 4 })
            let lit = 0
            for (let pixel = 0; pixel < width * height; pixel += 1) if (minimap.pixels[pixel * 4]! + minimap.pixels[pixel * 4 + 1]! + minimap.pixels[pixel * 4 + 2]! > 0) lit += 1
            expect(lit, entryId).toBeGreaterThan((width * height) / 4)
          } finally {
            await raster.release()
          }
        } finally {
          await scenario.result.session.dispose()
        }
      }
    } finally {
      await casc.close()
      await m.close()
    }
  }, 1_200_000)

  it.skipIf(!remastered)('serves the Remastered storage as one tree through the content source', async () => {
    const sources = await createContentSources({ installationDirectory: installation!.installPath })
    try {
      const top = (await sources.list(STARCRAFT1_ROOT_ID, '')).map(entry => entry.name.toLowerCase())
      expect(top).toEqual(expect.arrayContaining(['arr', 'rez', 'tileset', 'unit']))
      const tbl = await sources.read(STARCRAFT1_ROOT_ID, 'rez/stat_txt.tbl', 1 << 20)
      expect(new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength).getUint16(0, true)).toBeGreaterThan(1000)
      const found = await sources.files!(STARCRAFT1_ROOT_ID, '', { limit: 20, pattern: 'arr/units.dat' })
      expect(found.items.map(item => item.path.toLowerCase())).toContain('arr/units.dat')

      // An installed map opens inside the game: its tileset comes from the installation behind it.
      const map = (await readdir(join(installation!.installPath, 'Maps'))).find(name => /\.scm$/iu.test(name))!
      const context = await sources.openModContext!({ target: join(installation!.installPath, 'Maps', map) })
      try {
        expect(context.layers.map(layer => layer.id)).toEqual(['starcraft1-game', 'primary'])
        expect(await context.locate('staredit/scenario.chk')).toMatchObject({ layerId: 'primary' })
        expect(await context.locate('tileset/badlands.cv5')).toMatchObject({ layerId: 'starcraft1-game' })
        expect((await context.read('starcraft1-game', 'tileset/badlands.wpe', 4096)).byteLength).toBe(1024)
      } finally {
        await context.dispose()
      }
    } finally {
      await sources.dispose?.()
    }
  }, 600_000)
})
