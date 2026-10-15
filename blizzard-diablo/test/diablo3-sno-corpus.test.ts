import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openNestedSubject,
  openSubject,
  registerServiceDefinitionsOrThrow,
  type OpenedSubject,
} from '@modkit/host'
import { createNodeInstallationFiles, loadExtensionDirectory } from '@modkit/host/node'
import type { TreeDataSource, TreeNodeRef } from '@modkit/sdk'
import type { WorldSceneItem } from '@modkit/sdk/maps'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'

/**
 * Evidence route for Diablo III game data: the installed storage opened through the host, SNO files
 * of many groups opened as nested subjects, decoded by `blizzard/diablo3-sno` with the type
 * registry `blizzard/diablo3-sno-registry` recovers from the installation's own executable, which the
 * provider reads through the host's installation files, as VS Code offers them — no filesystem grant.
 */
const extension = join(import.meta.dirname, '..')
const { discoverDiablo3Installations } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href)) as typeof import('../dist/game/installation.js')
const dist = async <Module>(path: string) => (await import(pathToFileURL(join(extension, 'dist', 'diablo3-sno', path)).href)) as Module
const { createProvider } = await dist<typeof import('../dist/diablo3-sno/provider.js')>('provider.js')
const { SnoDecoder } = await dist<typeof import('../dist/diablo3-sno/decode.js')>('decode.js')
const { sceneLinks, markerSetMarkers } = await dist<typeof import('../dist/diablo3-sno/scene-markers.js')>('scene-markers.js')

const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'diablo3-sno-corpus', classes: ['read-source'] } as const
const budget = { maxInputBytes: 268_435_456n, maxDepth: 128, maxNodes: 4_000_000, maxScalarBytes: 268_435_456, maxDiagnostics: 1000 }

interface TreeNode {
  readonly ref: TreeNodeRef
  readonly label: string
  readonly preview?: string
}

async function children(tree: TreeDataSource, parent: TreeNodeRef): Promise<TreeNode[]> {
  const nodes: TreeNode[] = []
  let cursor: string | undefined
  do {
    const page = await tree.children(parent, { limit: 256, ...(cursor === undefined ? {} : { cursor }) })
    for (const ref of page.items) {
      const facts = await tree.facts(ref)
      nodes.push({ ref, label: facts.label, ...(facts.preview === undefined ? {} : { preview: facts.preview }) })
    }
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return nodes
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')('installed Diablo III game data', () => {
  it('decodes SNO files of every group without a dedicated codec with the registry of the installation', async () => {
    const installation = (await discoverDiablo3Installations({ gameId: 'blizzard/diablo-3', maxCandidates: 16 })).installations[0]
    if (installation === undefined) throw new Error('no Diablo III installation discovered (set MODKIT_DIABLO3_ROOT)')
    const inventory = await buildInventory(
      await Promise.all(
        // the core models root reopens an exported UVM, as the world's model route does
        [join(extension, '..', 'casc'), extension, join(extension, '..', '..', 'modkit-core', 'extensions', 'models')].map(async root => ({
          ...(await loadExtensionDirectory(root)),
          execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
        })),
      ),
      createHostContributionContractRegistry(),
    )
    const serviceDefinitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
    const executionBackends = createExecutionBackendRegistry([
      {
        profile: 'trusted-in-process',
        supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
        async activate(context) {
          return { module: (await import(context.entrypoint.href)) as Record<string, unknown>, release: async () => undefined }
        },
      },
    ])
    // the host's installation files, over the installation discovery confirmed (VS Code: the selected one)
    const installationFiles = createNodeInstallationFiles({ installationOf: gameId => (gameId === 'blizzard/diablo-3' ? installation.normalizedPath : undefined) })
    const common = { inventory, executionBackends, serviceDefinitions, target, grant, budget, installationFiles, intent: 'full' as const }
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(installation.normalizedPath).href)
    const casc = await openSubject({ ...common, source: artifactNamespaceSourceFromVfsMount(mount), path: installation.normalizedPath })
    if (casc.state !== 'opened') throw new Error(`CASC did not open: ${casc.state}`)
    const namespace = await casc.session.dataSource('common.view/namespace-entry-source', 1)
    const entryOf = async (path: string) => {
      const page = await namespace.value.list(path, { limit: 8 })
      const entry = page.items.find(item => item.path === path)
      if (entry === undefined) throw new Error(`${path} is not in the storage`)
      return entry.id
    }
    /** The first file of a folder: one sample of each group. */
    const firstOf = async (folder: string) => (await namespace.value.list(`${folder}/`, { limit: 1 })).items[0]?.path
    const open = async (path: string): Promise<OpenedSubject> => {
      const opened = (await openNestedSubject({ ...common, parent: casc.session, entryId: await entryOf(path) })).result
      if (opened.state !== 'opened') throw new Error(`${path} did not open: ${JSON.stringify(opened).slice(-800)}`)
      expect(opened.selected.contributionId, path).toBe('blizzard/diablo3-sno')
      return opened
    }
    const summaryOf = async (subject: OpenedSubject) => {
      const inspected = await subject.session.operations().invoke('inspect', {})
      if (inspected.state !== 'ok' || inspected.output.kind !== 'json') throw new Error('inspect failed')
      return inspected.output.value as { group: string; snoId: number; members: number; truncated: boolean }
    }
    const receipt: Record<string, unknown> = {}
    try {
      // an actor names its appearance (12742 is barbarian_male.app) and its animation set
      const actor = await open('actor/barbarian_male.acr')
      try {
        expect((await summaryOf(actor)).group).toBe('Actor')
        const tree = await actor.session.dataSource('common.view/tree-data-source', 1)
        const members = await children(tree.value, await tree.value.root())
        receipt['actor'] = members.slice(0, 6).map(node => `${node.label}=${node.preview}`)
        // members read by their names where WhiteoutLib's table fits the registry, type and offset beside
        expect(members.some(node => node.label === 'snoAppearance · DT_SNO@0x14' && node.preview === 'SNO 12742 (.app)')).toBe(true)
        expect(members.some(node => node.label === 'snoAnimSet · DT_SNO@0x68' && node.preview === 'SNO 11626 (.ans)')).toBe(true)
        // no navigation mesh: the map-layer operations say why instead of answering
        expect(actor.descriptor.operations?.find(operation => operation.id === 'map.layers')?.state).toBe('disabled')
        await tree.release()
      } finally {
        await actor.session.dispose()
      }
      // a scene lists its marker sets; an array of SNO ids names their group like a single one does
      const scene = await open('scene/1000monsterfight_e01_s02.scn')
      try {
        const tree = await scene.session.dataSource('common.view/tree-data-source', 1)
        const members = await children(tree.value, await tree.value.root())
        const markerSets = members.find(node => node.label === 'DT_VARIABLEARRAY<DT_SNO>@0xf0')
        const items = markerSets === undefined ? [] : await children(tree.value, markerSets.ref)
        receipt['scene'] = items.map(node => node.preview)
        expect(items.length).toBeGreaterThan(0)
        expect(items.every(node => node.preview?.endsWith('(.mrk)'))).toBe(true)
        await tree.release()
        // its navigation mesh reads through the shared map-layer operations
        const layers = await scene.session.operations().invoke('map-layers', {})
        if (layers.state !== 'ok' || layers.output.kind !== 'json') throw new Error(`map.layers failed: ${JSON.stringify(layers).slice(0, 600)}`)
        const list = (layers.output.value as { layers: { id: string; width: number; height: number }[] }).layers
        receipt['layers'] = list.map(layer => `${layer.id} ${layer.width}x${layer.height}`)
        expect(list.find(layer => layer.id === 'height')).toMatchObject({ width: 96, height: 96 })
        const heights = await scene.session.operations().invoke('map-layer-read', { layer: 'height' })
        if (heights.state !== 'ok' || heights.output.kind !== 'json') throw new Error('map.layer-read failed')
        const grid = heights.output.value as { values: number[] }
        expect(grid.values).toHaveLength(96 * 96)
        receipt['heightRange'] = [Math.min(...grid.values), Math.max(...grid.values)]
      } finally {
        await scene.session.dispose()
      }
      // what the scene places: the markers of its marker sets, read by SNO id through the storage
      {
        const registry = await createProvider({ contract: 'blizzard/diablo3-sno-registry', major: 1 }, { installationFiles }).value.registry({})
        const decoder = new SnoDecoder(registry)
        const decodeAs = async (path: string, group: string) => {
          const extracted = await casc.session.operations().invoke('extract-entry', { entryId: path })
          if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') throw new Error(`${path} did not extract`)
          return decoder.decode(extracted.output.value, decoder.rootOf(group)!, { maxMembers: 1_000_000, maxDepth: 16 }).value
        }
        // (e01's marker sets are empty in the client; e03's hold its encounters, lights and sounds)
        const links = sceneLinks(await decodeAs('scene/1000monsterfight_e03_s02.scn', 'Scene'), registry.groups)
        expect(links.appearance).toBeGreaterThan(0)
        expect(links.markerSets.length).toBeGreaterThan(0)
        const markers = (await Promise.all(links.markerSets.map(async id => markerSetMarkers(await decodeAs(`MarkerSet/${id}.mrk`, 'MarkerSet'))))).flat()
        const placed: Record<string, number> = {}
        for (const marker of markers) placed[registry.groups[marker.sno.group ?? -1] ?? String(marker.sno.group)] = (placed[registry.groups[marker.sno.group ?? -1] ?? String(marker.sno.group)] ?? 0) + 1
        receipt['markers'] = { appearance: links.appearance, markerSets: links.markerSets, count: markers.length, placed, first: markers.slice(0, 3) }
        expect(markers.length).toBeGreaterThan(0)
        // the placement is a unit quaternion and the marker names what it places
        expect(markers.every(marker => Math.abs(Math.hypot(...marker.rotation) - 1) < 1e-3)).toBe(true)
        expect(placed['.acr']).toBeGreaterThan(0)
      }
      // a scene as a world: navigation terrain, its mesh and its markers with their models (a cave
      // entrance whose floor rises 36 units, so an actor placed on the wrong square would show it)
      const world = await open('scene/a2dun_cave_s_entrance_01.scn')
      try {
        const lease = await world.session.dataSource('common.view/world-scene-source', 1)
        try {
          const source = lease.value
          const info = await source.info()
          const all = async (facet: string) => {
            const items: WorldSceneItem[] = []
            let cursor: string | undefined
            do {
              const page = await source.page({ facet, limit: 4096, ...(cursor === undefined ? {} : { cursor }) })
              items.push(...page.items)
              cursor = page.nextCursor
            } while (cursor !== undefined)
            return items
          }
          // the navigation mesh: the scene's ground is its own mesh, so there is no terrain facet
          const terrain = (await all('navigation')).filter(item => item.facet === 'navigation')
          expect((await all('terrain')).filter(item => item.facet === 'terrain')).toHaveLength(0)
          const objects = (await all('objects')).filter(item => item.facet === 'objects')
          const resources = (await all('resources')).filter(item => item.facet === 'resources')
          // an actor stands on the navigation surface: its height is the height of the square under it
          const size = Math.abs((terrain[1]?.uvwPosition?.x ?? 0) - (terrain[0]?.uvwPosition?.x ?? 0))
          const heightAt = new Map(terrain.map(item => [`${item.x}:${item.y}`, item.uvwPosition!.y]))
          const standing = (transposed: boolean) =>
            objects
              .filter(item => item.kind === 'doodad' && item.name !== 'Scene mesh')
              .flatMap(item => {
                const [column, row] = [Math.floor(item.uvwPosition!.x / size), Math.floor(-item.uvwPosition!.z / size)]
                const height = heightAt.get(transposed ? `${row}:${column}` : `${column}:${row}`)
                return height === undefined ? [] : [Math.abs(item.uvwPosition!.y - height)]
              })
              .sort((left, right) => left - right)
          const offsets = standing(false)
          // the squares run x fastest: read the other way round, the actors float or sink
          const across = standing(true)
          receipt['world'] = {
            facets: info.facets.map(facet => `${facet.facet} ${facet.state} ${facet.itemCount}${facet.reason === undefined ? '' : ` (${facet.reason})`}`),
            squareSize: size,
            medianStandingOffset: offsets[Math.floor(offsets.length / 2)],
            medianOffsetTransposed: across[Math.floor(across.length / 2)],
            heights: [Math.min(...terrain.map(item => item.uvwPosition!.y)), Math.max(...terrain.map(item => item.uvwPosition!.y))],
            count: offsets.length,
            resources: resources.slice(0, 3).map(item => item.modelResource?.logicalId),
          }
          expect(terrain).toHaveLength(96 * 96)
          expect(objects.length).toBeGreaterThan(1)
          expect(resources.length).toBeGreaterThan(1)
          expect(offsets[Math.floor(offsets.length / 2)]).toBeLessThan(1)
          expect(across[Math.floor(across.length / 2)]).toBeGreaterThan(10)
          // the models: the scene's own mesh and an actor's appearance convert through the host's model port
          const models: Record<string, unknown> = {}
          for (const resource of resources.slice(0, 2)) {
            const model = await source.model!(resource.id, { maxBytes: 64 * 1024 * 1024, maxMeshes: 256, maxNodes: 1024, maxPrimitives: 512, maxPrimitiveBytes: 16 * 1024 * 1024 })
            models[resource.modelResource?.logicalId ?? resource.id] =
              model.state === 'converted'
                ? { meshes: model.meshes.length, primitives: model.primitives.length, nodes: model.nodes?.length ?? 0, textures: model.textures?.length ?? 0, uvm: model.uvmBytes?.byteLength ?? 0, complete: model.complete }
                : model.diagnostics.map(item => item.message)
          }
          receipt['models'] = models
          for (const model of Object.values(models)) expect(model).toMatchObject({ primitives: expect.any(Number) })
          expect(Object.values(models).every(model => (model as { primitives: number }).primitives > 0)).toBe(true)
        } finally {
          await lease.release()
        }
      } finally {
        await world.session.dispose()
      }
      // GameBalance affixlist: 2,998 affix rows
      const balance = await open('gamebalance/affixlist.gam')
      try {
        const tree = await balance.session.dataSource('common.view/tree-data-source', 1)
        const tables = await children(tree.value, await tree.value.root())
        const affixes = tables.find(node => node.label.startsWith('AffixTable'))
        const table = affixes === undefined ? [] : await children(tree.value, affixes.ref)
        receipt['gamebalance'] = table.map(node => `${node.label}=${node.preview}`)
        expect(table.some(node => node.preview === 'AffixTableEntry[2998]')).toBe(true)
        await tree.release()
      } finally {
        await balance.session.dispose()
      }
      // one file of every group the codec claims opens and decodes
      const groups: Record<string, number> = {}
      for (const folder of ['actor', 'adventure', 'ambientsound', 'anim', 'anim2d', 'animset', 'cloth', 'conversation', 'effectgroup', 'encounter', 'explosion', 'font', 'gamebalance', 'globals', 'levelarea', 'light', 'markerset', 'monster', 'observer', 'particle', 'physics', 'power', 'quest', 'rope', 'scene', 'scenegroup', 'shadermap', 'shaders', 'shakes', 'skillkit', 'sound', 'soundbank', 'surface', 'trail', 'ui', 'weather', 'worlds', 'recipe', 'condition', 'act', 'material', 'questrange', 'lore', 'reverb', 'physmesh', 'music', 'tutorial', 'bossencounter', 'accolade']) {
        const path = await firstOf(folder)
        if (path === undefined) continue
        const subject = await open(path)
        try {
          const summary = await summaryOf(subject)
          groups[summary.group] = summary.members
        } finally {
          await subject.session.dispose()
        }
      }
      receipt['groups'] = groups
      // effects: an effect group names what it spawns and where; a particle's animated values read as keys
      const effects: Record<string, unknown> = {}
      const efgFolder = await namespace.value.list('effectgroup/', { limit: 40 })
      for (const item of efgFolder.items) {
        const subject = await open(item.path)
        try {
          const graph = await subject.session.dataSource('common.view/relation-graph-source', 1)
          const edges = (await graph.value.edges({ limit: 200 })).items
          await graph.release()
          const placed = edges.filter(edge => edge.role?.includes(' · at ') === true)
          if (placed.length > 0) {
            effects['effectGroup'] = { file: item.path, edges: edges.length, sample: placed.slice(0, 3).map(edge => `${edge.to} ${edge.role}`) }
            break
          }
        } finally {
          await subject.session.dispose()
        }
      }
      expect(effects['effectGroup'], 'an effect group spawning something at a hardpoint').toBeDefined()
      const particlePath = await firstOf('particle')
      if (particlePath !== undefined) {
        const particle = await open(particlePath)
        try {
          const tree = await particle.session.dataSource('common.view/tree-data-source', 1)
          const members = await children(tree.value, await tree.value.root())
          const curves = members.filter(node => /^\d+ keys?/u.test(node.preview ?? ''))
          effects['particle'] = { file: particlePath, curves: curves.length, sample: curves.slice(0, 3).map(node => `${node.label}: ${node.preview}`) }
          expect(curves.length).toBeGreaterThan(10)
          const graph = await particle.session.dataSource('common.view/relation-graph-source', 1)
          effects['particleLinks'] = (await graph.value.edges({ limit: 20 })).items.map(edge => `${edge.to} ${edge.role ?? ''}`)
          await graph.release()
          await tree.release()
        } finally {
          await particle.session.dispose()
        }
      }
      receipt['effects'] = effects
      expect(Object.keys(groups).length).toBeGreaterThan(30)
    } finally {
      await namespace.release()
      await casc.session.dispose()
      console.log('Diablo III SNO data:', JSON.stringify(receipt))
    }
  }, 900_000)
})
