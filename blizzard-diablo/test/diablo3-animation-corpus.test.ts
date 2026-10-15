import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  linkedExtensionInputs,
  linkedInProcessBackend,
  openNestedSubject,
  openSubject,
  registerServiceDefinitionsOrThrow,
} from '@modkit/host'
import { createFilesystemInputResolver, loadExtensionDirectory, openFileArtifactSource } from '@modkit/host/node'
import { decodePngSamples } from '@modkit/codec-kit/raster'
import type { SceneRendererPrimitive } from '@modkit/sdk'
import { sceneModule } from '@modkit/scene/module'
import { createModelSceneSampler } from '@modkit/scene/model'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { readUvmContainer } from '@modkit/uv/model/container'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { camera } from '../../models/test/uvm-conversion-render.js'

/**
 * Animated appearances of the installed game, played through the product route: the appearance
 * opened from the storage as a nested subject (the actor's animation set attached by
 * `blizzard/diablo3-app`), exported to UVM, reopened by the core UVM codec and rendered by
 * `model.render` at several times of one clip. For each model the skinned geometry must stay
 * finite and near its rest size, the clip must move it, and the rendered frames must differ.
 * Frames and a summary are written to MODKIT_D3_ANIMATION_OUT (or a temporary folder).
 */
const extension = join(import.meta.dirname, '..')
const { discoverDiablo3Installations } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href)) as typeof import('../dist/game/installation.js')

const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'diablo3-animation-corpus', classes: ['read-source'] } as const
const budget = { maxInputBytes: 268_435_456n, maxDepth: 128, maxNodes: 2_000_000, maxScalarBytes: 268_435_456, maxDiagnostics: 1000 }
const containerBudget = { maxInputBytes: budget.maxScalarBytes, maxJsonBytes: budget.maxScalarBytes, maxNodes: budget.maxNodes, maxDepth: budget.maxDepth }
const viewport = 256
/** Models to play: the hero first, then a spread of the appearances an actor of the same name animates. */
const MODELS = Number(process.env['MODKIT_D3_ANIMATION_MODELS'] ?? '8')
const FRACTIONS = [0, 0.25, 0.5, 0.75]

/** Positions after each primitive's own transform, as the renderer places them. */
function worldPositions(primitives: readonly SceneRendererPrimitive[]): number[] {
  const out: number[] = []
  for (const primitive of primitives) {
    const m = primitive.transform
    const p = primitive.positions
    for (let i = 0; i + 2 < p.length; i += 3) {
      const [x, y, z] = [p[i]!, p[i + 1]!, p[i + 2]!]
      if (m === undefined) out.push(x, y, z)
      else out.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!)
    }
  }
  return out
}

function diagonal(points: readonly number[]): number {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < points.length; i += 3)
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, points[i + axis]!)
      max[axis] = Math.max(max[axis]!, points[i + axis]!)
    }
  return Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!)
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')('installed Diablo III animations', () => {
  it('plays real clips: the skinned model moves, stays whole, and renders different frames', async () => {
    const installation = (await discoverDiablo3Installations({ gameId: 'blizzard/diablo-3', maxCandidates: 16 })).installations[0]
    if (installation === undefined) throw new Error('no Diablo III installation discovered (set MODKIT_DIABLO3_ROOT)')
    const linked = linkedExtensionInputs([sceneModule])
    const inventory = await buildInventory(
      [
        ...linked.inputs,
        ...(await Promise.all(
          [join(extension, '..', 'casc'), extension, join(extension, '..', '..', 'modkit-core', 'extensions', 'models')].map(async root => ({
            ...(await loadExtensionDirectory(root)),
            execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
          })),
        )),
      ],
      createHostContributionContractRegistry(),
    )
    const serviceDefinitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
    const executionBackends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)])
    const common = { inventory, executionBackends, serviceDefinitions, target, grant, budget, intent: 'full' as const }
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(installation.normalizedPath).href)
    const casc = await openSubject({ ...common, source: artifactNamespaceSourceFromVfsMount(mount), path: installation.normalizedPath })
    if (casc.state !== 'opened') throw new Error(`CASC did not open: ${casc.state}`)
    const out = process.env['MODKIT_D3_ANIMATION_OUT'] ?? (await mkdtemp(join(tmpdir(), 'modkit-d3-animation-')))
    await mkdir(out, { recursive: true })
    const summary: Record<string, unknown>[] = []
    const heldPoses: Record<string, unknown>[] = []
    const skipped: Record<string, number> = { notOpened: 0, notExported: 0, noClips: 0 }

    const names = async (prefix: string, suffix: string) => {
      const source = await casc.session.dataSource('common.view/namespace-entry-source', 1)
      const found: string[] = []
      try {
        let cursor: string | undefined
        do {
          const page = await source.value.list(prefix, { limit: 4096, ...(cursor === undefined ? {} : { cursor }) })
          for (const item of page.items) if (item.kind === 'file' && item.path.endsWith(suffix)) found.push(item.path.slice(prefix.length, -suffix.length))
          cursor = page.nextCursor
        } while (cursor !== undefined)
      } finally {
        await source.release()
      }
      return found
    }
    try {
      // an appearance is animated through the actor of its own name
      const actors = new Set(await names('actor/', '.acr'))
      const animatedByName = (await names('appearance/', '.app')).filter(name => actors.has(name)).sort()
      // creatures first (their skeletons move every limb), spread over the alphabet; then props
      const creature = /^(zombie|skeleton|goatman|fallen|spider|ghoul|wraith|lacuni|scavenger|succubus|wolf|beast|snake|wasp|cultist|creeper|ghost|golem|bat|rat|crab|worm|priest|witch|angel|demon|p\d_)/iu
      const spread = (list: readonly string[], count: number) => list.filter((_, index) => index % Math.max(1, Math.floor(list.length / count)) === 0)
      const creatures = animatedByName.filter(name => creature.test(name))
      // the heroes of each class, then creatures, then any animated prop
      const heroes = ['barbarian', 'demonhunter', 'monk', 'witchdoctor', 'wizard', 'crusader', 'necromancer'].flatMap(hero => [`${hero}_male`, `${hero}_female`]).filter(name => actors.has(name))
      const candidates = [...heroes.slice(0, 3), ...spread(creatures, MODELS * 8), ...spread(animatedByName, MODELS * 4)]
      summary.push(skipped)
      skipped['pairs'] = animatedByName.length
      skipped['creatures'] = creatures.length

      for (const name of candidates) {
        if (summary.length > MODELS) break
        if (summary.some(item => item['model'] === name)) continue
        const entryId = `appearance/${name}.app`
        const opened = (await openNestedSubject({ ...common, parent: casc.session, entryId })).result
        if (opened.state !== 'opened') {
          skipped['notOpened']! += 1
          continue
        }
        let uvmBytes: Uint8Array
        try {
          const exported = await opened.session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
          if (exported.state !== 'ok' || exported.output.kind !== 'bytes') {
            skipped['notExported']! += 1
            continue
          }
          uvmBytes = exported.output.value
        } finally {
          await opened.session.dispose()
        }
        const { document, binary } = readUvmContainer(uvmBytes, containerBudget)
        const { scene, rig } = readUvmModel(document, binary, budget)
        if (rig.clips.length === 0) {
          skipped['noClips']! += 1
          continue
        }
        const projection = { ...scene, skeleton: rig.bindings }
        const rest = worldPositions(createModelSceneSampler(projection, { maxBytes: budget.maxScalarBytes }).sample(0).primitives)
        const restSize = diagonal(rest)
        // a walk or run moves every limb, then an attack, then the rest; some clips are held states
        // (a door "closed"), so the first of up to six that moves the mesh is played
        const ordered = [
          ...rig.clips.filter(item => /walk|run/iu.test(item.name)),
          ...rig.clips.filter(item => /attack/iu.test(item.name)),
          ...rig.clips,
        ].filter((item, index, all) => all.indexOf(item) === index)
        const play = (clip: (typeof rig.clips)[number]) => {
          const duration = clip.durationSeconds ?? (clip.frameRate === undefined ? 1 : clip.frames / clip.frameRate)
          const sampler = createModelSceneSampler(projection, { clip, maxBytes: budget.maxScalarBytes })
          const frames = FRACTIONS.map(fraction => {
            const primitives = sampler.sample(fraction * duration).primitives
            return { time: fraction * duration, primitives, points: worldPositions(primitives) }
          })
          // how far the clip moves the mesh: mean vertex displacement from the first frame
          const displacement = frames.map(frame => {
            let sum = 0
            const base = frames[0]!.points
            for (let i = 0; i < frame.points.length; i += 3)
              sum += Math.hypot(frame.points[i]! - base[i]!, frame.points[i + 1]! - base[i + 1]!, frame.points[i + 2]! - base[i + 2]!)
            return sum / Math.max(1, frame.points.length / 3) / restSize
          })
          return { clip, duration, frames, displacement }
        }
        const tried: string[] = []
        let played = play(ordered[0]!)
        for (const candidate of ordered.slice(0, 6)) {
          played = play(candidate)
          tried.push(candidate.name)
          if (Math.max(...played.displacement) > 0.002) break
        }
        const { clip, duration, frames, displacement } = played
        const sizes = frames.map(frame => diagonal(frame.points) / restSize)
        // every clip tried holds one pose (breakables break by physics, doors hold a state): listed, not played
        if (Math.max(...displacement) <= 0.002) {
          heldPoses.push({ model: name, tried })
          continue
        }
        // the textures the model names, beside the UVM, where the reopened UVM resolves them
        for (const image of (document as { images?: { uri?: string }[] }).images ?? []) {
          if (image.uri === undefined) continue
          const extracted = await casc.session.operations().invoke('extract-entry', { entryId: image.uri })
          if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') continue
          await mkdir(join(out, image.uri, '..'), { recursive: true })
          await writeFile(join(out, image.uri), extracted.output.value)
        }

        // render every frame with one camera that holds all of them
        const uvmPath = join(out, `${name}.uvm.glb`)
        await writeFile(uvmPath, uvmBytes)
        const uvm = await openSubject({
          ...common,
          source: await openFileArtifactSource(uvmPath),
          path: uvmPath,
          resolveInput: createFilesystemInputResolver({ primaryPath: uvmPath, roots: [out], inventory }),
        })
        if (uvm.state !== 'opened') throw new Error(`${entryId} UVM did not reopen: ${uvm.reason}`)
        const pixels: Uint8Array[] = []
        try {
          const viewProjection = Array.from(camera(frames.flatMap(frame => frame.primitives)), (value, index) => (index % 4 === 2 ? -value : value))
          for (const [index, frame] of frames.entries()) {
            const rendered = await uvm.session.operations().invoke('render-uvm-scene', {
              schemaVersion: 1,
              viewport: { width: viewport, height: viewport },
              camera: { viewProjection },
              rendererId: 'modkit.headless',
              clipId: clip.id,
              time: frame.time,
              clearColor: [0.1, 0.1, 0.12, 1],
            })
            if (rendered.state !== 'ok' || rendered.output.kind !== 'bytes') throw new Error(`${entryId} render failed: ${JSON.stringify(rendered).slice(0, 300)}`)
            await writeFile(join(out, `${name}.${index}.png`), rendered.output.value)
            pixels.push((await decodePngSamples(rendered.output.value)).samples)
          }
        } finally {
          await uvm.session.dispose()
        }
        const changedPixels = pixels.map(frame => {
          let changed = 0
          for (let i = 0; i < frame.length; i += 4) if (frame[i] !== pixels[0]![i] || frame[i + 1] !== pixels[0]![i + 1] || frame[i + 2] !== pixels[0]![i + 2]) changed += 1
          return changed
        })
        summary.push({
          model: name,
          clips: rig.clips.length,
          clip: clip.name,
          tried,
          duration: Math.round(duration * 1000) / 1000,
          bones: rig.bindings.length,
          vertices: rest.length / 3,
          finite: frames.every(frame => frame.points.every(Number.isFinite)),
          displacement: displacement.map(value => Math.round(value * 1000) / 1000),
          sizes: sizes.map(value => Math.round(value * 100) / 100),
          changedPixels,
        })
      }
    } finally {
      await casc.session.dispose()
      await writeFile(join(out, 'summary.json'), JSON.stringify({ played: summary, heldPoses }, null, 1))
      console.log('Diablo III animations:', out, JSON.stringify({ played: summary, heldPoses }))
    }
    const models = summary.slice(1)
    expect(models.length).toBe(MODELS)
    for (const model of models as { model: string; finite: boolean; displacement: number[]; sizes: number[]; changedPixels: number[] }[]) {
      expect(model.finite, model.model).toBe(true)
      // the clip moves the mesh, and no pose flies apart or collapses
      expect(Math.max(...model.displacement), model.model).toBeGreaterThan(0.002)
      expect(model.sizes.every(size => size > 0.3 && size < 3), `${model.model} ${model.sizes.join(' ')}`).toBe(true)
      expect(Math.max(...model.changedPixels), model.model).toBeGreaterThan(0)
    }
  }, 3_600_000)
})
