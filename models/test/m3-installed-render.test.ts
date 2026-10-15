import { mkdir, writeFile } from 'node:fs/promises'
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
  type OpenedSubject,
} from '@modkit/host'
import { createNodeInstallationProbes, loadExtensionDirectory } from '@modkit/host/node'
import type { JsonObject, ModelAnimationSource } from '@modkit/sdk'
import type { GameInstallationDiscovery } from '@modkit/sdk/games'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { sceneModule } from '@modkit/scene/module'
import { createModelSceneSampler } from '@modkit/scene/model'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { encodeRgbaPng } from '@modkit/scene/output/png'
import { readUvmContainer } from '@modkit/uv/model/container'
import { findBlizzardExtensionRoot, findModkitCoreWorkspace } from './workspace-root.js'
import { camera } from './uvm-conversion-render.js'

/**
 * Evidence route: render installed M3 models through the ordinary host — VFS mount → CASC subject →
 * nested M3 subject (textures via the host resource session) → `render-m3-scene`.
 *
 * MODKIT_M3_RENDER_BASENAMES=vespenegeyser_ex2.m3,… MODKIT_M3_RENDER_OUT=<dir>
 * optional: MODKIT_M3_RENDER_ROOTS (namespace prefixes, highest priority first),
 * MODKIT_M3_RENDER_CLIPS (regex), MODKIT_M3_RENDER_TIMES (seconds), MODKIT_M3_RENDER_SIZE,
 * MODKIT_M3_RENDER_ZOOM, MODKIT_M3_RENDER_ELEVATION (radians), MODKIT_M3_RENDER_TEAM_COLOR_INTENSITY.
 */
const env = process.env
const basenames = env['MODKIT_M3_RENDER_BASENAMES']?.split(',').filter(Boolean) ?? []
const out = env['MODKIT_M3_RENDER_OUT']
// ponytail: fixed SC2 multiplayer dependency chain; a map/mod workspace load order replaces it
// once the render is driven from an opened map instead of a bare model.
const roots = (
  env['MODKIT_M3_RENDER_ROOTS'] ??
  ['voidmulti', 'void', 'swarmmulti', 'swarm', 'libertymulti', 'liberty', 'core']
    .map(mod => `mods/${mod}.sc2mod/base.sc2assets`)
    .join(',')
).split(',')
const clipPattern = new RegExp(env['MODKIT_M3_RENDER_CLIPS'] ?? '^stand', 'iu')
const times = (env['MODKIT_M3_RENDER_TIMES'] ?? '0,0.5,1,2').split(',').map(Number)
const size = Number(env['MODKIT_M3_RENDER_SIZE'] ?? 384)
const zoom = Number(env['MODKIT_M3_RENDER_ZOOM'] ?? 0.6)
const elevation =
  env['MODKIT_M3_RENDER_ELEVATION'] === undefined ? undefined : Number(env['MODKIT_M3_RENDER_ELEVATION'])
// 0 renders a neutral object (no team color), as SC2 does for resources and doodads.
const teamColorIntensity =
  env['MODKIT_M3_RENDER_TEAM_COLOR_INTENSITY'] === undefined
    ? undefined
    : Number(env['MODKIT_M3_RENDER_TEAM_COLOR_INTENSITY'])
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'm3-installed-render', classes: ['read-source'] } as const
const budget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 8_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}
// Same isometric basis as `camera()`, column-major; billboarded effects need the view matrix.
const isometricView = [
  0.70710678, -0.40824829, 0.57735027, 0, 0, 0.81649658, 0.57735027, 0, -0.70710678, -0.40824829,
  0.57735027, 0, 0, 0, 0, 1,
]
const { discoverStarcraft2Installations } = (await import(
  new URL('../../starcraft2/modules/game/providers/installation/provider.js', import.meta.url).href
)) as { discoverStarcraft2Installations: GameInstallationDiscovery['discover'] }
const json = (value: unknown) =>
  JSON.stringify(value, (_, item: unknown) => (typeof item === 'bigint' ? String(item) : item), 2)

/** Decodes one material texture through the host resource session and the DDS codec to PNG. */
async function dumpTexture(
  common: Omit<Parameters<typeof openSubject>[0], 'source' | 'path'>,
  m3: OpenedSubject,
  logicalId: string,
) {
  const resolved = await m3.resources!.resolve({
    id: `dump:${logicalId}`,
    logicalId,
    role: 'texture',
    scopes: ['workspace-dependency-layer'],
  })
  if (resolved.state !== 'resolved' || resolved.lease.value.kind !== 'bytes')
    return { logicalId, state: resolved.state }
  try {
    const dds = await openSubject({ ...common, source: resolved.lease.value, path: logicalId })
    if (dds.state !== 'opened') return { logicalId, state: 'unopened' }
    try {
      const raster = await dds.session.dataSource('common.view/raster-image-source', 1)
      try {
        const info = await raster.value.info()
        const region = await raster.value.readRegion?.({
          x: 0, y: 0, width: info.width, height: info.height,
          frame: 0, mipLevel: 0, layer: 0, face: 0, slice: 0,
          pixelFormat: 'rgba8', maxBytes: budget.maxScalarBytes,
        })
        if (region === undefined) return { logicalId, info }
        const rgba = new Uint8Array(region.width * region.height * 4)
        for (let row = 0; row < region.height; row++)
          rgba.set(region.pixels.subarray(row * region.rowStride, row * region.rowStride + region.width * 4), row * region.width * 4)
        const file = `texture.${logicalId.split('/').at(-1)!.replace(/\W+/gu, '_')}.png`
        await writeFile(join(out!, file), await encodeRgbaPng({ width: region.width, height: region.height, rgba }))
        return { logicalId, info, file }
      } finally {
        await raster.release()
      }
    } finally {
      await dds.session.dispose()
    }
  } finally {
    await resolved.lease.release()
  }
}

describe.skipIf(basenames.length === 0 || out === undefined)('installed M3 render evidence', () => {
  it('renders the requested installed models through the M3 codec', async () => {
    // MODKIT_M3_RENDER_INSTALLATION names another CASC installation on the M3 engine (Heroes of the Storm).
    const other = env['MODKIT_M3_RENDER_INSTALLATION']?.trim()
    const configured = env['MODKITX_SC2_ROOT']?.trim()
    const discovery = other ? { installations: [{ normalizedPath: other }] } : await discoverStarcraft2Installations({
      gameId: 'blizzard/starcraft-2',
      maxCandidates: 128,
      ...(configured ? { configuredPaths: [configured] } : {}),
    }, createNodeInstallationProbes())
    const installation = discovery.installations[0]
    if (installation === undefined) throw new Error('requires an SC2 installation')
    const core = findModkitCoreWorkspace(import.meta.dirname)
    const blizzard = findBlizzardExtensionRoot(import.meta.dirname)
    const linked = linkedExtensionInputs([sceneModule])
    const inventory = await buildInventory(
      [
        ...linked.inputs,
        ...(await Promise.all(
          ['casc', 'models'].map(name => join(blizzard, name))
            .concat(['images', 'models'].map(name => join(core, 'extensions', name)))
            .map(async directory => ({
              ...(await loadExtensionDirectory(directory)),
              execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
            })),
        )),
      ],
      createHostContributionContractRegistry(),
    )
    const serviceDefinitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
    const common = {
      inventory,
      executionBackends: createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)]),
      serviceDefinitions,
      target,
      grant,
      budget,
      intent: 'full' as const,
    }
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(installation.normalizedPath).href)
    const sessions: OpenedSubject[] = []
    await mkdir(out!, { recursive: true })
    try {
      const casc = await openSubject({
        ...common,
        source: artifactNamespaceSourceFromVfsMount(mount),
        path: installation.normalizedPath,
      })
      if (casc.state !== 'opened') throw new Error(`CASC: ${json(casc.diagnostics)}`)
      sessions.push(casc)
      const namespace = await casc.session.dataSource('common.view/namespace-entry-source', 1)
      const entries = await namespace.value
        .search?.({ kind: 'basename-any', caseSensitive: false, basenames }, { limit: 64 })
        .finally(() => namespace.release())
      // Entry listing for inspection: MODKIT_M3_RENDER_LIST=mods/liberty.sc2mod/base.sc2assets/assets/cliffs/,…
      for (const prefix of env['MODKIT_M3_RENDER_LIST']?.split(',').filter(Boolean) ?? []) {
        const source = await casc.session.dataSource('common.view/namespace-entry-source', 1)
        const paths: string[] = []
        try {
          let cursor: string | undefined
          do {
            const page = await source.value.list(prefix, { limit: 256, ...(cursor === undefined ? {} : { cursor }) })
            paths.push(...page.items.map(item => item.path))
            cursor = page.nextCursor
          } while (cursor !== undefined && paths.length < 100_000)
        } finally {
          await source.release()
        }
        await writeFile(join(out!, `list.${prefix.replace(/\W+/gu, '_')}.txt`), paths.join('\n'))
      }
      // Raw entries for inspection: MODKIT_M3_RENDER_EXTRACT=mods/liberty.sc2mod/base.sc2data/gamedata/actordata.xml,…
      for (const entryId of env['MODKIT_M3_RENDER_EXTRACT']?.split(',').filter(Boolean) ?? []) {
        const result = await casc.session.operations().invoke('extract-entry', { entryId })
        if (result.state === 'ok' && result.output.kind === 'bytes')
          await writeFile(join(out!, `extract.${entryId.replace(/\W+/gu, '_')}`), result.output.value)
      }
      const receipt: unknown[] = []
      for (const entryId of entries?.items.map(item => item.path) ?? []) {
        try {
          // The model's own assets component: <base|locale>.sc2assets of an SC2 mod, .stormassets of a Heroes mod.
          const assets = /\/[a-z]+\.(?:sc2|storm)assets\//iu.exec(entryId)
          const own = assets === null ? entryId : entryId.slice(0, assets.index + assets[0].length - 1)
          const logicalRoots = [...new Set([own, ...roots])].map(pathPrefix => ({
            rootId: pathPrefix,
            pathPrefix,
          }))
          // M3A sidecars bound by hash: Heroes keeps them beside the model's folder
          // (MODKIT_M3_RENDER_ANIMATIONS=assets/units/heroes, relative to the model's assets root).
          const animations = env['MODKIT_M3_RENDER_ANIMATIONS']?.split(',').filter(Boolean) ?? []
          const nested = await openNestedSubject({
            ...common,
            parent: casc.session,
            entryId,
            logicalRoots,
            ...(animations.length === 0
              ? {}
              : {
                  resourceDiscovery: [
                    {
                      role: 'sidecar' as const,
                      extension: '.m3a',
                      searches: animations.map(logicalPrefix => ({ rootId: own, logicalPrefix })),
                      limits: {
                        pageItems: 256,
                        maxPages: 64,
                        maxEntries: 16_384,
                        maxCandidates: 1024,
                        maxBytes: 1_073_741_824n,
                      },
                    },
                  ],
                }),
          })
          const m3 = nested.result
          if (m3.state !== 'opened') throw new Error(`${entryId}: ${json(m3.diagnostics)}`)
          sessions.push(m3)
          // The session's own clips, companions (discovered M3A) included; the UVM export keeps only the base's.
          const animationLease = await m3.session.dataSource('common.view/model-animation-source', 1)
          const sessionClips = await (animationLease.value as ModelAnimationSource)
            .clips({ limit: 1024 })
            .then(page => page.items.map(clip => ({ id: clip.id, name: clip.name })))
            .finally(() => animationLease.release())
          const invoke = async (handler: string, request: JsonObject) => {
            const result = await m3.session.operations().invoke(handler, request)
            if (result.state !== 'ok' || result.output.kind !== 'bytes')
              throw new Error(`${handler}: ${json(result)}`)
            return { bytes: result.output.value, diagnostics: result.diagnostics }
          }
          const exported = await invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
          const { document, binary } = readUvmContainer(exported.bytes)
          const { scene, rig } = readUvmModel(document, binary, budget)
          const primitives = createModelSceneSampler(
            { ...scene, skeleton: rig.bindings },
            { maxBytes: budget.maxScalarBytes },
          ).sample(0).primitives
          // The fitted camera bounds only the meshes; zoom out so emitted particles stay in frame.
          // Its z row points toward the viewer while the renderers keep the nearer (smaller) depth,
          // so negate it or far geometry overwrites near geometry.
          let viewProjection = Array.from(camera(primitives), (value, index) =>
            index % 4 === 2 ? -value * zoom : index % 4 < 2 ? value * zoom : value,
          )
          let viewMatrix = isometricView
          if (elevation !== undefined) {
            // Game-like orbit (e.g. 1.0 rad ≈ SC2 top-down), same scale, centered on the meshes.
            const scale = Math.hypot(viewProjection[0]!, viewProjection[4]!, viewProjection[8]!)
            const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
            for (const primitive of primitives)
              for (let i = 0; i < primitive.positions.length; i += 3)
                for (let axis = 0; axis < 3; axis++) {
                  const value = primitive.positions[i + axis]!
                  bounds[axis * 2] = Math.min(bounds[axis * 2]!, value)
                  bounds[axis * 2 + 1] = Math.max(bounds[axis * 2 + 1]!, value)
                }
            const center = [0, 1, 2].map(axis => (bounds[axis * 2]! + bounds[axis * 2 + 1]!) / 2)
            const azimuth = Math.PI / 4
            const z = [
              Math.cos(elevation) * Math.sin(azimuth),
              Math.sin(elevation),
              Math.cos(elevation) * Math.cos(azimuth),
            ]
            const x = [Math.cos(azimuth), 0, -Math.sin(azimuth)]
            const y = [z[1]! * x[2]! - z[2]! * x[1]!, z[2]! * x[0]! - z[0]! * x[2]!, z[0]! * x[1]! - z[1]! * x[0]!]
            viewMatrix = new Array(16).fill(0)
            viewProjection = new Array(16).fill(0)
            ;[x, y, z].forEach((row, i) => {
              const sign = i === 2 ? -1 : 1
              const depth = row.reduce((sum, value, k) => sum + value * center[k]!, 0)
              row.forEach((value, column) => {
                viewMatrix[column * 4 + i] = value
                viewProjection[column * 4 + i] = value * scale * sign
              })
              viewMatrix[12 + i] = -depth
              viewProjection[12 + i] = -depth * scale * sign
            })
            viewMatrix[15] = viewProjection[15] = 1
          }
          const stem = entryId.split('/').at(-1)!.replace(/\.m3$/iu, '')
          await writeFile(join(out!, `${stem}.uvm.glb`), exported.bytes)
          await writeFile(join(out!, `${stem}.camera.json`), json({ viewProjection, viewMatrix }))
          const frames: unknown[] = []
          const clips = rig.clips.filter(clip => clipPattern.test(clip.name || clip.id))
          for (const clip of clips.length > 0 ? clips : [undefined]) {
            for (const time of times) {
              const frame = await invoke('render-m3-scene', {
                schemaVersion: 1,
                metersPerSourceUnit: 1,
                viewport: { width: size, height: size },
                camera: { viewProjection, viewMatrix },
                clearColor: [0.08, 0.08, 0.1, 1],
                rendererId: 'modkit.headless',
                collisions: false,
                time,
                ...(clip === undefined ? {} : { clipId: clip.id }),
                ...(teamColorIntensity === undefined
                  ? {}
                  : { materialContext: { teamColorIntensity } }),
              })
              const file = `${stem}.${(clip?.name ?? 'bind').replace(/\W+/gu, '_')}.t${time}.png`
              await writeFile(join(out!, file), frame.bytes)
              frames.push({
                file,
                diagnostics: [...new Set(frame.diagnostics.map(item => `${item.code}: ${item.message}`))],
              })
            }
          }
          const textures: unknown[] = []
          if (env['MODKIT_M3_RENDER_TEXTURES'] === '1') {
            const authored = [
              ...JSON.stringify((document as { materials?: unknown }).materials).matchAll(
                /"texturePath":"([^"]+)"/gu,
              ),
            ].map(match => match[1]!)
            const logicalIds = new Set([
              ...authored,
              ...(m3.resources?.provenance().map(item => item.logicalId) ?? []),
            ])
            for (const logicalId of logicalIds) textures.push(await dumpTexture(common, m3, logicalId))
          }
          await writeFile(
            join(out!, `${stem}.materials.json`),
            json({ materials: (document as { materials?: unknown }).materials, extensions: (document as { extensions?: unknown }).extensions }),
          )
          // Geometry probe: bounds and the mean height (native M3 +Z) of vertices per x/y quadrant.
          const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
          const quadrants = new Map<string, { sum: number; count: number; max: number }>()
          for (const primitive of primitives)
            for (let i = 0; i < primitive.positions.length; i += 3) {
              const [x, y, z] = [primitive.positions[i]!, primitive.positions[i + 1]!, primitive.positions[i + 2]!]
              ;[x, y, z].forEach((value, axis) => {
                bounds[axis * 2] = Math.min(bounds[axis * 2]!, value)
                bounds[axis * 2 + 1] = Math.max(bounds[axis * 2 + 1]!, value)
              })
              const key = `x${x < 0 ? '-' : '+'}y${y < 0 ? '-' : '+'}`
              const entry = quadrants.get(key) ?? { sum: 0, count: 0, max: -Infinity }
              entry.sum += z
              entry.count += 1
              entry.max = Math.max(entry.max, z)
              quadrants.set(key, entry)
            }
          receipt.push({
            entryId,
            logicalRoots,
            textures,
            bounds: bounds.map(value => Number(value.toFixed(3))),
            quadrants: Object.fromEntries(
              [...quadrants].map(([key, value]) => [key, { mean: Number((value.sum / value.count).toFixed(3)), max: Number(value.max.toFixed(3)) }]),
            ),
            primitives: primitives.length,
            sessionClips,
            clips: rig.clips.map(clip => ({ id: clip.id, name: clip.name, seconds: clip.durationSeconds })),
            resources: m3.resources?.provenance().map(item => ({
              logicalId: item.logicalId,
              state: item.state,
            })),
            exportDiagnostics: exported.diagnostics.map(item => `${item.code}: ${item.message}`),
            frames,
          })
        } catch (error) {
          // One model failing (a CDN-only entry, a codec refusal) is recorded; the rest still render.
          receipt.push({ entryId, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await writeFile(join(out!, 'receipt.json'), json(receipt))
      expect(receipt.length).toBeGreaterThan(0)
    } finally {
      for (const opened of sessions.reverse()) await opened.session.dispose()
      await mount.dispose()
      await vfs.dispose()
    }
  }, 600_000)
})
