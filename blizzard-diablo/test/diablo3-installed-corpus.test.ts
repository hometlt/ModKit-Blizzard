import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openNestedSubject,
  openSubject,
  type OpenedSubject,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'

/**
 * Evidence route on the installed game: installation discovery → VFS mount → CASC subject →
 * nested APP/TEX/STL subjects through the ordinary host. The installation comes from the provider's
 * own discovery (MODKIT_DIABLO3_ROOT, uninstall registry, platform defaults), never a path here.
 *
 * Every real run opens a fixed, even spread of the sorted listing (300 appearances, 600
 * textures, 400 string lists, a few minutes) plus every entry a full pass has refused.
 * MODKIT_D3_FULL_SWEEP=1 opens every appearance, texture and string list instead (about two
 * hours; run it as a separate process).
 * MODKIT_D3_OUT — optional file for the JSON receipt.
 */
const extension = join(import.meta.dirname, '..')
const { discoverDiablo3Installations } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')

const { parseDiablo3Appearance } = (await import(
  pathToFileURL(join(extension, 'dist', 'diablo3-app', 'appearance.js')).href
)) as typeof import('../dist/diablo3-app/appearance.js')

const full = process.env['MODKIT_D3_FULL_SWEEP'] === '1'
/**
 * Characters whose default look hides most submeshes: heroes (one look per hero state) and
 * followers, whose look 0 lists every armour tier while the naked body repeats the light tier
 * vertex for vertex. Each must still draw a body.
 */
const bodies = ['templar', 'scoundrel', 'enchantress', 'monk_male', 'wizard_female', 'x1_crusader_male']
/** Entries per group; 0 opens all of them. */
const sample = { appearances: full ? 0 : 300, textures: full ? 0 : 600, stringLists: full ? 0 : 400 }
/**
 * Every entry the first full pass of the installed corpus (2.8.0.99920) refused, checked on every
 * run: arenas above the old maxNodes, cube maps stored as one rectangle and back-to-back faces,
 * and mip tables listing levels past the end of the file.
 */
const regressions = [
  'appearance/pvp_keep_arena.app', 'appearance/pvp_zolt_ruins_arena.app', 'appearance/x1_adria_boss_arena_e01_s01.app',
  'appearance/x1_pand_ext_240_cellar_03.app', 'appearance/x1_pand_ext_240_cellar_05.app', 'appearance/x1_westm_boss_e01_s01.app',
  'appearance/x1_westmarch_hub_e01_n04.app',
  ...['bronze_irradiance', 'characterselect_irradiancecube', 'dead_irradiance', 'gold_irradiance', 'hellirradiance',
    'iceshard_irradiance', 'irradiance', 'irradiance2', 'irradiance3', 'irradiance_dialogue', 'manaorb_irradiance',
    'selection_hostile_irradiance', 'selection_irradiance', 'silver_irradiance', 'bluelightning_strokes', 'curse_ampdamage', 'frostcloud_rnd', 'gfiresplash', 'lightningwash_meteor', 'raidenbolt', 'raidenstream',
    'sheetlightning', 'sheetlightning_green', 'sheetlightning_red', 'torchflare_01', 'torchflare_blue', 'torchflare_red', 'torchpole_01']
    .map(name => `textures/${name}.tex`),
]
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'diablo3-installed-corpus', classes: ['read-source'] } as const
const budget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 2_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}

/** Every `step`-th entry, so a sample spans the whole listing rather than its first letters. */
function spread<T>(items: readonly T[], count: number): readonly T[] {
  if (count <= 0 || items.length <= count) return items
  const step = items.length / count
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * step)]!)
}

async function listFiles(subject: OpenedSubject, prefix: string, extensionName: string) {
  const source = await subject.session.dataSource('common.view/namespace-entry-source', 1)
  const paths: string[] = []
  try {
    let cursor: string | undefined
    do {
      const page = await source.value.list(prefix, {
        limit: 256,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const item of page.items)
        if (item.kind === 'file' && item.path.toLowerCase().endsWith(`.${extensionName}`))
          paths.push(item.path)
      cursor = page.nextCursor
    } while (cursor !== undefined)
  } finally {
    await source.release()
  }
  return paths.sort()
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')(
  'installed Diablo III through CASC',
  () => {
    it('opens and decodes appearances and textures found by discovery', async () => {
      const discovery = await discoverDiablo3Installations({
        gameId: 'blizzard/diablo-3',
        maxCandidates: 16,
      })
      const installation = discovery.installations[0]
      if (installation === undefined)
        throw new Error(
          `no Diablo III installation discovered (set MODKIT_DIABLO3_ROOT): ${JSON.stringify(discovery.probes)}`,
        )

      const extensions = await Promise.all(
        [join(extension, '..', 'casc'), extension].map(async root => ({
          ...(await loadExtensionDirectory(root)),
          execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
        })),
      )
      const inventory = await buildInventory(extensions, createHostContributionContractRegistry())
      const executionBackends = createExecutionBackendRegistry([
        {
          profile: 'trusted-in-process',
          supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
          async activate(context) {
            return {
              module: (await import(context.entrypoint.href)) as Record<string, unknown>,
              release: async () => undefined,
            }
          },
        },
      ])
      const common = { inventory, executionBackends, target, grant, budget, intent: 'full' as const }
      const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
      const mount = await vfs.openMount(pathToFileURL(installation.normalizedPath).href)
      const casc = await openSubject({
        ...common,
        source: artifactNamespaceSourceFromVfsMount(mount),
        path: installation.normalizedPath,
      })
      if (casc.state !== 'opened') throw new Error(`CASC did not open: ${JSON.stringify(casc)}`)

      const failures: { entry: string; reason: string }[] = []
      const receipt = {
        installation: { path: installation.normalizedPath, version: installation.version },
        appearances: { listed: 0, opened: 0, vertices: 0, sockets: 0, collisions: 0, hulls: 0, events: 0, eventsAtSockets: 0 },
        textures: { listed: 0, opened: 0, pixelFormats: {} as Record<string, number> },
        stringLists: { listed: 0, opened: 0, entries: 0 },
        failures,
      }
      async function nested(entryId: string, contributionId: string, check: (subject: OpenedSubject) => Promise<void>) {
        let subject
        try {
          subject = (await openNestedSubject({ ...common, parent: casc.session, entryId })).result
        } catch (error) {
          failures.push({ entry: entryId, reason: `open threw: ${String(error)}`.slice(0, 400) })
          return
        }
        if (subject.state !== 'opened') {
          failures.push({ entry: entryId, reason: `${subject.state}: ${JSON.stringify(subject.diagnostics ?? subject)}`.slice(0, 400) })
          return
        }
        try {
          if (subject.selected.contributionId !== contributionId)
            throw new Error(`routed to ${subject.selected.contributionId}`)
          await check(subject)
        } catch (error) {
          failures.push({ entry: entryId, reason: String(error).slice(0, 400) })
        } finally {
          await subject.session.dispose()
        }
      }

      try {
        const appearances = await listFiles(casc, 'Appearance', 'app')
        const textures = await listFiles(casc, 'Textures', 'tex')
        const stringLists = await listFiles(casc, 'StringList', 'stl')
        receipt.stringLists.listed = stringLists.length
        expect(stringLists.length).toBeGreaterThan(0)
        receipt.appearances.listed = appearances.length
        receipt.textures.listed = textures.length
        expect(appearances.length).toBeGreaterThan(0)
        expect(textures.length).toBeGreaterThan(0)

        for (const entry of [...new Set([...regressions.filter(item => item.endsWith('.app')), ...spread(appearances, sample.appearances)])])
          await nested(entry, 'blizzard/diablo3-app', async subject => {
            const result = await subject.session
              .operations()
              .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
            if (result.state !== 'ok' || result.output.kind !== 'bytes')
              throw new Error(`model-export-uvm: ${JSON.stringify(result).slice(0, 300)}`)
            const bytes = result.output.value
            const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)
            const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
              accessors?: { count: number; type: string }[]
              meshes?: { primitives: { attributes: { POSITION?: number } }[] }[]
              nodes?: { extensions?: Record<string, unknown> }[]
              animations?: { extensions?: { UV_game_animation_events?: { events?: { socket?: number }[] } } }[]
            }
            const vertices = (document.meshes ?? [])
              .flatMap(mesh => mesh.primitives)
              .reduce((sum, primitive) => sum + (document.accessors?.[primitive.attributes.POSITION ?? -1]?.count ?? 0), 0)
            if (vertices === 0) throw new Error('exported no vertices')
            receipt.appearances.opened += 1
            receipt.appearances.vertices += vertices
            for (const node of document.nodes ?? []) {
              if (node.extensions?.['UV_game_socket'] !== undefined) receipt.appearances.sockets += 1
              const collision = node.extensions?.['UV_game_collision'] as { shapes?: { kind?: string }[] } | undefined
              if (collision !== undefined) receipt.appearances.collisions += 1
              for (const shape of collision?.shapes ?? []) if (shape.kind === 'convex-hull') receipt.appearances.hulls += 1
            }
            for (const animation of document.animations ?? [])
              for (const event of animation.extensions?.UV_game_animation_events?.events ?? []) {
                receipt.appearances.events += 1
                if (event.socket !== undefined) receipt.appearances.eventsAtSockets += 1
              }
          })

        for (const name of bodies) {
          const entry = `appearance/${name}.app`
          const extracted = await casc.session.operations().invoke('extract-entry', { entryId: entry })
          if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
            failures.push({ entry, reason: `extract-entry: ${extracted.state}` })
            continue
          }
          const model = parseDiablo3Appearance(extracted.output.value, name)
          if (!model.meshes.some(mesh => mesh.metadata?.['defaultVisible'] === true))
            failures.push({ entry, reason: 'no submesh is visible in the default look' })
          // Hardpoints are model-space in the file and stored relative to their bone: a hand or weapon
          // mount sits within reach of its bone, never a whole body height away.
          const hardpoints = (model.metadata?.['hardpoints'] ?? []) as { name: string; parentIndex: number; matrix: number[] }[]
          if (!hardpoints.some(hardpoint => /weapon/iu.test(hardpoint.name) && hardpoint.parentIndex >= 0))
            failures.push({ entry, reason: 'no weapon hardpoint on a bone' })
          for (const hardpoint of hardpoints.filter(item => item.parentIndex >= 0))
            if (Math.hypot(hardpoint.matrix[12]!, hardpoint.matrix[13]!, hardpoint.matrix[14]!) > 80)
              failures.push({ entry, reason: `hardpoint ${hardpoint.name} is far from its bone` })
        }

        for (const entry of [...new Set([...regressions.filter(item => item.endsWith('.tex')), ...spread(textures, sample.textures)])])
          await nested(entry, 'blizzard/diablo3-tex', async subject => {
            const raster = await subject.session.dataSource('common.view/raster-image-source', 1)
            try {
              const info = await raster.value.info()
              const region = await raster.value.readRegion?.({
                x: 0, y: 0, width: info.width, height: info.height,
                frame: 0, mipLevel: 0, layer: 0, face: 0, slice: 0,
                pixelFormat: 'rgba8', maxBytes: budget.maxScalarBytes,
              })
              if (region === undefined || region.width !== info.width || region.height !== info.height)
                throw new Error(`mip 0 of ${info.width}x${info.height} was not decoded`)
              const inspected = await subject.session.operations().invoke('inspect', {})
              const format =
                inspected.state === 'ok' && inspected.output.kind === 'json'
                  ? String((inspected.output.value as { pixelFormat?: string }).pixelFormat)
                  : 'unknown'
              receipt.textures.pixelFormats[format] = (receipt.textures.pixelFormats[format] ?? 0) + 1
              receipt.textures.opened += 1
            } finally {
              await raster.release()
            }
          })

        for (const entry of spread(stringLists, sample.stringLists))
          await nested(entry, 'blizzard/diablo3-stl', async subject => {
            const inspected = await subject.session.operations().invoke('inspect', {})
            if (inspected.state !== 'ok' || inspected.output.kind !== 'json') throw new Error('inspect failed')
            const summary = inspected.output.value as { entries: number; hashMismatches: number }
            if (summary.hashMismatches !== 0) throw new Error(`${summary.hashMismatches} label hashes differ`)
            const table = await subject.session.dataSource('common.view/table-data-source', 1)
            try {
              const shape = await table.value.shape()
              if (shape.rows !== summary.entries) throw new Error(`table has ${shape.rows} rows for ${summary.entries} entries`)
            } finally {
              await table.release()
            }
            receipt.stringLists.opened += 1
            receipt.stringLists.entries += summary.entries
          })
      } finally {
        await casc.session.dispose()
        const out = process.env['MODKIT_D3_OUT']
        if (out !== undefined) await writeFile(out, JSON.stringify(receipt, null, 2))
      }
      expect(failures).toEqual([])
      // most appearances carry attach points; many carry collision capsules or bone shapes
      expect(receipt.appearances.sockets).toBeGreaterThan(receipt.appearances.opened)
      expect(receipt.appearances.collisions).toBeGreaterThan(0)
      // bone collision shapes: most are cooked convex polytopes
      expect(receipt.appearances.hulls).toBeGreaterThan(0)
      // clips the actors link carry their timed events, most at a hardpoint's socket
      expect(receipt.appearances.eventsAtSockets).toBeGreaterThan(0)
    }, full ? 4 * 3_600_000 : 1_800_000)
  },
)
