import { createHash } from 'node:crypto'
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
  createHostServiceResolver,
  linkedExtensionInputs,
  linkedInProcessBackend,
  openNestedSubject,
  openSubject,
  registerServiceDefinitionsOrThrow,
  type OpenedSubject,
} from '@modkit/host'
import { createNodeInstallationProbes, loadExtensionDirectory } from '@modkit/host/node'
import {
  revisionId,
  type ArtifactByteSource,
  type JsonObject,
  type RasterResourceResult,
} from '@modkit/sdk'
import type { GameInstallationDiscovery } from '@modkit/sdk/games'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { sceneModule } from '@modkit/scene/module'
import { createModelSceneSampler } from '@modkit/scene/model'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { renderUvm } from '@modkit/scene/uvm/render'
import { encodeRgbaPng } from '@modkit/scene/output/png'
import { readUvmContainer } from '@modkit/uv/model/container'
import { findBlizzardExtensionRoot, findModkitCoreWorkspace } from './workspace-root.js'
import { camera } from './uvm-conversion-render.js'

const cases = [
  {
    name: 'artifact1',
    root: 'campaigns/liberty.sc2campaign/base.sc2assets',
    dependencies: ['mods/liberty.sc2mod/base.sc2assets'],
    path: 'assets/campaign/terran/artifact1/artifact1.m3',
    size: 60_128,
    sha256: 'fb7680019ca7ec88aeb37591a7477c2555dd674d57f0c7486736ccb11919a436',
    textureCount: 6,
    cube: {
      logicalId: 'Assets/Textures/Artifact_CubicReflection.dds',
      sha256: '9a3dbb3fe383824be9a2e22712bb43506979a89eee438dacc4d7d68687ef2742',
      width: 128,
      height: 128,
      faces: 6,
      mipLevels: 8,
    },
  },
] as const
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'm3-uvm-retail-read', classes: ['read-source'] } as const
const budget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type DecodedSurfaces = Extract<RasterResourceResult, { state: 'decoded-surfaces' }>
const { discoverStarcraft2Installations } = (await import(
  new URL('../../starcraft2/modules/game/providers/installation/provider.js', import.meta.url).href
)) as { discoverStarcraft2Installations: GameInstallationDiscovery['discover'] }
function memorySource(bytes: Uint8Array): ArtifactByteSource {
  const id = `memory://uvm-retail/${hash(bytes)}`
  return {
    kind: 'bytes',
    ref: { id, uri: id },
    revision: revisionId(`content-hash.sha256:${hash(bytes)}`),
    size: BigInt(bytes.length),
    async read(offset, length) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
}
async function output(opened: OpenedSubject, handler: string, request: JsonObject) {
  const result = await opened.session.operations().invoke(handler, request)
  if (result.state !== 'ok' || result.output.kind !== 'bytes')
    throw new Error(`${handler}: ${JSON.stringify(result)}`)
  return { bytes: result.output.value, diagnostics: result.diagnostics }
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] === '0')(
  'retail M3 textured UVM route',
  () => {
    it.each(cases)(
      '$name renders its actual DDS through the ordinary host and shared scene',
      async fixture => {
        const configured = process.env['MODKITX_SC2_ROOT']?.trim()
        const discovery = await discoverStarcraft2Installations({
          gameId: 'blizzard/starcraft-2',
          maxCandidates: 128,
          ...(configured ? { configuredPaths: [configured] } : {}),
        }, createNodeInstallationProbes())
        const installation = discovery.installations[0]
        if (installation === undefined)
          throw new Error('retail UVM proof requires an SC2 installation')
        const core = findModkitCoreWorkspace(import.meta.dirname)
        const blizzard = findBlizzardExtensionRoot(import.meta.dirname)
        const linked = linkedExtensionInputs([sceneModule])
        const inventory = await buildInventory(
          [
            ...linked.inputs,
            ...(await Promise.all(
              [
                join(blizzard, 'casc'),
                join(blizzard, 'models'),
                join(core, 'extensions/images'),
                join(core, 'extensions/models'),
              ].map(async directory => ({
                ...(await loadExtensionDirectory(directory)),
                execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
              })),
            )),
          ],
          createHostContributionContractRegistry(),
        )
        const serviceDefinitions = createBundledServiceDefinitionRegistry()
        await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
        const executionBackends = createExecutionBackendRegistry([
          linkedInProcessBackend(linked.modules),
        ])
        const common = {
          inventory,
          executionBackends,
          serviceDefinitions,
          target,
          grant,
          budget,
          intent: 'full' as const,
        }
        const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
        const mount = await vfs.openMount(pathToFileURL(installation.normalizedPath).href)
        const sessions: OpenedSubject[] = []
        try {
          const casc = await openSubject({
            ...common,
            source: artifactNamespaceSourceFromVfsMount(mount),
            path: installation.normalizedPath,
          })
          if (casc.state !== 'opened') throw new Error(`CASC: ${JSON.stringify(casc.diagnostics)}`)
          sessions.push(casc)
          const entryId = `${fixture.root}/${fixture.path}`
          const original = await output(casc, 'extract-entry', { entryId })
          expect(original.bytes.length).toBe(fixture.size)
          expect(hash(original.bytes)).toBe(fixture.sha256)
          // These are explicit campaign roots, never a search over every mod in the installation.
          const logicalRoots = [
            { rootId: 'liberty-campaign', pathPrefix: fixture.root },
            ...fixture.dependencies.map(pathPrefix => ({ rootId: pathPrefix, pathPrefix })),
          ]
          const nested = await openNestedSubject({
            ...common,
            parent: casc.session,
            entryId,
            logicalRoots,
          })
          const m3 = nested.result
          if (m3.state !== 'opened' || m3.resources === undefined)
            throw new Error(`M3 resources: ${JSON.stringify(m3.diagnostics)}`)
          sessions.push(m3)
          expect(m3.selected.contributionId).toBe('blizzard/m3')
          const exported = await output(m3, 'model-export-uvm', {
            schemaVersion: 1,
            metersPerSourceUnit: 1,
          })
          const { document, binary } = readUvmContainer(exported.bytes)
          const { scene, rig } = readUvmModel(document, binary, budget)
          const sample = createModelSceneSampler(
            { ...scene, skeleton: rig.bindings },
            { maxBytes: budget.maxScalarBytes },
          ).sample(0)
          expect(sample.primitives).toHaveLength(2)
          const viewProjection = Array.from(camera(sample.primitives))
          const request: JsonObject = {
            schemaVersion: 1,
            viewport: { width: 192, height: 192 },
            camera: { viewProjection },
            clearColor: [0.025, 0.025, 0.04, 1],
            rendererId: 'modkit.headless',
            collisions: false,
          }
          // Explicit test scene inputs, not a recovered native environment/camera transform.
          const environmentRequest = (
            worldToEnvironment: readonly number[],
            eyePosition: readonly [number, number, number],
          ): JsonObject => ({
            ...request,
            camera: { viewProjection, eyePosition: [...eyePosition] },
            materialContext: {
              environment: { worldToEnvironment: [...worldToEnvironment] },
            },
          })
          const rotatedEnvironment = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]
          const explicitEnvironmentRequest = environmentRequest(rotatedEnvironment, [3, 4, 5])
          const environmentControls = [
            {
              name: 'environment-identity',
              request: environmentRequest(
                [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                [3, 4, 5],
              ),
            },
            {
              name: 'environment-eye',
              request: environmentRequest(rotatedEnvironment, [-3, 4, 5]),
            },
          ]
          const nativeFrame = await output(m3, 'render-m3-scene', {
            ...request,
            metersPerSourceUnit: 1,
          })
          const resourceRecords = m3.resources
            .provenance()
            .filter(item => item.requirementId.startsWith('uvm-material-resource-'))
          expect(resourceRecords.length).toBeGreaterThan(0)
          if (resourceRecords.some(item => item.state !== 'resolved')) {
            const namespace = await casc.session.dataSource('common.view/namespace-entry-source', 1)
            try {
              const matches = await namespace.value.search?.(
                {
                  kind: 'basename-any',
                  caseSensitive: false,
                  basenames: resourceRecords.map(
                    item => item.logicalId.split('/').at(-1) ?? item.logicalId,
                  ),
                },
                { limit: 64 },
              )
              console.info(
                'Unresolved fixture resource locations:',
                matches?.items.map(item => item.path),
              )
            } finally {
              await namespace.release()
            }
          }
          expect(
            resourceRecords.every(item => item.state === 'resolved'),
            JSON.stringify(resourceRecords, (_, value: unknown) =>
              typeof value === 'bigint' ? String(value) : value,
            ),
          ).toBe(true)
          expect(
            nativeFrame.diagnostics.filter(item =>
              /(?:texture-unresolved|image-unrendered|material-feature-unrendered|raster-.*(?:failed|unavailable)|resource-.*missing)/u.test(
                item.code,
              ),
            ),
          ).toEqual([])
          expect(
            nativeFrame.diagnostics.filter(
              item => item.code === 'common.uvm/material-image-first-surface',
            ),
          ).toEqual([])
          const effectViewMatrix = [
            0.70710678, -0.40824829, 0.57735027, 0, 0, 0.81649658, 0.57735027, 0, -0.70710678,
            -0.40824829, 0.57735027, 0, 0, 0, 0, 1,
          ]
          const effectRequest: JsonObject = {
            ...request,
            time: 1,
            camera: { viewProjection, viewMatrix: effectViewMatrix },
          }
          const effectFrame = await output(m3, 'render-m3-scene', {
            ...effectRequest,
            metersPerSourceUnit: 1,
          })
          expect(effectFrame.bytes).not.toEqual(nativeFrame.bytes)
          expect(
            effectFrame.diagnostics.filter(
              item =>
                item.code === 'common.uvm/effect-camera-required' ||
                item.message.includes('texturePath') ||
                /(?:texture-unresolved|image-unrendered|raster-.*(?:failed|unavailable)|resource-.*missing)/u.test(
                  item.code,
                ),
            ),
          ).toEqual([])
          const effectResources = m3.resources
            .provenance()
            .filter(
              item =>
                item.requirementId.startsWith('uvm-material-resource-') &&
                ['assets/textures/smokewispy10.dds', 'assets/textures/lightcone4.dds'].includes(
                  item.logicalId.toLowerCase(),
                ),
            )
          expect(effectResources).toHaveLength(2)
          expect(effectResources.every(item => item.state === 'resolved')).toBe(true)

          const textureProof: unknown[] = []
          const decoded = new Map<string, DecodedSurfaces>()
          for (const logicalId of new Set(resourceRecords.map(item => item.logicalId))) {
            const resolved = await m3.resources.resolve({
              id: `proof:${logicalId}`,
              logicalId,
              role: 'texture',
              scopes: ['workspace-dependency-layer'],
            })
            if (resolved.state !== 'resolved' || resolved.lease.value.kind !== 'bytes')
              throw new Error(`DDS missing: ${logicalId}`)
            try {
              const source = resolved.lease.value
              const dds = await openSubject({ ...common, source, path: logicalId })
              if (dds.state !== 'opened') throw new Error(`DDS did not open: ${logicalId}`)
              try {
                expect(dds.selected.contributionId).toBe('modkit/dds')
                const raster = await dds.session.dataSource('common.view/raster-image-source', 1)
                try {
                  const info = await raster.value.info()
                  const surfaces: DecodedSurfaces['surfaces'][number][] = []
                  let remaining = budget.maxScalarBytes
                  // Read each DDS face independently through its public raster capability.
                  // This reference never calls the host's all-face acquisition helper.
                  for (let face = 0; face < info.faces; face++) {
                    const subresource = { frame: 0, mipLevel: 0, layer: 0, face, slice: 0 }
                    const region = await raster.value.readRegion?.({
                      x: 0,
                      y: 0,
                      width: info.width,
                      height: info.height,
                      ...subresource,
                      pixelFormat: 'rgba8',
                      maxBytes: remaining,
                    })
                    if (region === undefined) throw new Error(`DDS face ${face} has no pixels`)
                    expect(region.width).toBe(info.width)
                    expect(region.height).toBe(info.height)
                    expect(region.pixels.byteLength).toBeLessThanOrEqual(remaining)
                    remaining -= region.pixels.byteLength
                    surfaces.push({
                      subresource,
                      region: { ...region, pixels: region.pixels.slice() },
                    })
                  }
                  decoded.set(logicalId, {
                    state: 'decoded-surfaces',
                    info,
                    surfaces,
                    diagnostics: [],
                  })
                  const size = Number(source.size)
                  if (!Number.isSafeInteger(size) || size > Number(budget.maxInputBytes))
                    throw new Error('DDS proof byte budget')
                  const sha256 = hash(await source.read(0n, size))
                  if (logicalId === fixture.cube.logicalId) {
                    expect(sha256).toBe(fixture.cube.sha256)
                    expect(info).toMatchObject({
                      width: fixture.cube.width,
                      height: fixture.cube.height,
                      faces: fixture.cube.faces,
                      mipLevels: fixture.cube.mipLevels,
                    })
                    expect(surfaces.map(surface => surface.subresource.face)).toEqual([
                      0, 1, 2, 3, 4, 5,
                    ])
                  }
                  textureProof.push({
                    logicalId,
                    provenance: resolved.provenance,
                    bytes: size,
                    sha256,
                    info,
                    surfaces: surfaces.map(({ subresource, region }) => ({
                      subresource,
                      width: region.width,
                      height: region.height,
                      rowStride: region.rowStride,
                      pixelsSha256: hash(region.pixels),
                    })),
                  })
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
          expect(decoded.size).toBe(fixture.textureCount)
          expect([...decoded.values()].filter(result => result.info.faces === 6)).toHaveLength(1)
          const cube = decoded.get(fixture.cube.logicalId)
          const cubeFace0 = cube?.surfaces[0]
          if (cube === undefined || cubeFace0 === undefined)
            throw new Error('retail cube reference is missing')
          const face0Decoded = new Map(decoded)
          face0Decoded.set(fixture.cube.logicalId, {
            ...cube,
            info: { ...cube.info, faces: 1 },
            surfaces: [cubeFace0],
          })
          const renderer = createHostServiceResolver({
            ...common,
            definitions: serviceDefinitions,
            budgets: budget,
          })
          let face0Approximation: Uint8Array
          const environmentPngs = new Map<string, Uint8Array>()
          const environmentProof: {
            readonly name: string
            readonly request: JsonObject
            readonly pngSha256: string
            readonly ordinaryM3Comparison: 'equal' | 'not-compared'
            readonly diagnostics: Awaited<ReturnType<typeof renderUvm>>['diagnostics']
          }[] = []
          try {
            // Separate public DDS capabilities supply the UVM reference frame. This is shared
            // scene equivalence, not a claim of retail engine/native GPU pixel equivalence.
            const referenceFrame = (
              resources: ReadonlyMap<string, DecodedSurfaces>,
              renderRequest: JsonObject = request,
            ) =>
              renderUvm(exported.bytes, renderRequest, {
                contracts: renderer.port,
                budget,
                rasterResources: {
                  async read(request) {
                    if (request.kind !== 'logical') throw new Error('unexpected embedded image')
                    // The scene asks for the mip that fits its budget (core b9c9b686).
                    expect(request.selection).toEqual({ face: 'all', mipLevel: 'fit' })
                    const found = resources.get(request.requirement.logicalId)
                    if (found === undefined) throw new Error('uncaptured material texture')
                    expect(
                      found.surfaces.reduce(
                        (sum, surface) => sum + surface.region.pixels.byteLength,
                        0,
                      ),
                    ).toBeLessThanOrEqual(request.maxBytes)
                    return found
                  },
                },
              })
            const convertedFrame = await referenceFrame(decoded)
            expect(convertedFrame.statistics.fragments).toBeGreaterThan(0)
            expect(await encodeRgbaPng(convertedFrame)).toEqual(nativeFrame.bytes)
            // Deliberately repeat the previous approximation: face 0 is presented as a
            // single 2D image. This proves that the actual cube changes the retail frame.
            face0Approximation = await encodeRgbaPng(await referenceFrame(face0Decoded))
            expect(face0Approximation).not.toEqual(nativeFrame.bytes)

            const explicitM3Frame = await output(m3, 'render-m3-scene', {
              ...explicitEnvironmentRequest,
              metersPerSourceUnit: 1,
            })
            expect(
              explicitM3Frame.diagnostics.filter(item =>
                /(?:texture-unresolved|image-unrendered|material-feature-unrendered|raster-.*(?:failed|unavailable)|resource-.*missing)/u.test(
                  item.code,
                ),
              ),
            ).toEqual([])
            const explicitUvmFrame = await referenceFrame(decoded, explicitEnvironmentRequest)
            const unrenderedEnvironmentDiagnostic = (item: {
              readonly code: string
              readonly severity: string
            }) =>
              item.severity === 'error' ||
              /(?:texture-unresolved|image-unrendered|material-feature-unrendered|raster-.*(?:failed|unavailable)|resource-.*missing)/u.test(
                item.code,
              )
            expect(explicitUvmFrame.diagnostics.filter(unrenderedEnvironmentDiagnostic)).toEqual([])
            expect(explicitUvmFrame.statistics.fragments).toBeGreaterThan(0)
            const explicitPng = await encodeRgbaPng(explicitUvmFrame)
            expect(explicitPng).toEqual(explicitM3Frame.bytes)
            expect(explicitPng).not.toEqual(nativeFrame.bytes)
            environmentPngs.set('environment', explicitPng)
            environmentProof.push({
              name: 'environment',
              request: explicitEnvironmentRequest,
              pngSha256: hash(explicitPng),
              ordinaryM3Comparison: 'equal',
              diagnostics: explicitUvmFrame.diagnostics,
            })
            // Change one supplied coordinate input at a time; the default path and image
            // payloads stay the same. These are public UVM sensitivity controls.
            for (const control of environmentControls) {
              const controlFrame = await referenceFrame(decoded, control.request)
              expect(controlFrame.diagnostics.filter(unrenderedEnvironmentDiagnostic)).toEqual([])
              expect(controlFrame.statistics.fragments).toBeGreaterThan(0)
              const controlPng = await encodeRgbaPng(controlFrame)
              expect(controlPng).not.toEqual(explicitPng)
              environmentPngs.set(control.name, controlPng)
              environmentProof.push({
                name: control.name,
                request: control.request,
                pngSha256: hash(controlPng),
                ordinaryM3Comparison: 'not-compared',
                diagnostics: controlFrame.diagnostics,
              })
            }
            // Reusing the renderer after explicit environment calls must not retain context.
            expect(await encodeRgbaPng(await referenceFrame(decoded))).toEqual(nativeFrame.bytes)
          } finally {
            await renderer.release()
          }

          const bare = await openSubject({
            ...common,
            source: memorySource(exported.bytes),
            path: 'bare.uvm.glb',
          })
          if (bare.state !== 'opened') throw new Error('negative-control UVM did not open')
          expect(bare.selected.contributionId).toBe('modkit/model-uvm')
          let fallback: Uint8Array
          try {
            const frame = await output(bare, 'render-uvm-scene', request)
            expect(frame.diagnostics.map(item => item.code)).toContain(
              'common.scene/material-texture-unresolved',
            )
            expect(frame.bytes).not.toEqual(nativeFrame.bytes)
            fallback = frame.bytes
          } finally {
            await bare.session.dispose()
          }
          expect(hash((await output(casc, 'extract-entry', { entryId })).bytes)).toBe(
            fixture.sha256,
          )
          const proof = {
            fixture,
            request,
            sourceUnchanged: true,
            uvmScenePngEqual: true,
            cubeFace0PngDifferent: true,
            cubeFaceOrder: ['+X', '-X', '+Y', '-Y', '+Z', '-Z'],
            explicitEnvironment: {
              contextSource: 'test-authored scene inputs; no inferred native defaults',
              variants: environmentProof,
              matrixAndEyeControlsDiffer: true,
              defaultAfterExplicitPngEqual: true,
            },
            effects: {
              request: effectRequest,
              pngSha256: hash(effectFrame.bytes),
              staticFrameDifferent: true,
              resolvedTextures: effectResources.map(item => item.logicalId),
              diagnostics: effectFrame.diagnostics,
            },
            limitations: [
              'explicit corpus dependency roots; no automatic game-context selection',
              'mip 0 at frame, layer and slice 0; no mip-selection or cube UV-transform proof',
              'face-0 negative control is a deliberate 2D approximation, not a native renderer oracle',
              'shared scene equivalence; no retail engine or native GPU pixel oracle',
              'explicit environment controls do not recover the native matrix or prove a native eye-vector interpolation variant',
            ],
            pngSha256: hash(nativeFrame.bytes),
            fallbackPngSha256: hash(fallback),
            face0ApproximationPngSha256: hash(face0Approximation),
            diagnostics: nativeFrame.diagnostics,
            textures: textureProof,
          }
          const evidence = process.env['MODKIT_M3_UVM_TEXTURED_EVIDENCE_DIR']
          if (evidence !== undefined) {
            await mkdir(evidence, { recursive: true })
            await writeFile(join(evidence, `${fixture.name}.png`), nativeFrame.bytes, {
              flag: 'wx',
            })
            await writeFile(join(evidence, `${fixture.name}.fallback.png`), fallback, {
              flag: 'wx',
            })
            await writeFile(
              join(evidence, `${fixture.name}.face0-approximation.png`),
              face0Approximation,
              {
                flag: 'wx',
              },
            )
            await writeFile(join(evidence, `${fixture.name}.uvm.glb`), exported.bytes, {
              flag: 'wx',
            })
            await writeFile(join(evidence, `${fixture.name}.effects.png`), effectFrame.bytes, {
              flag: 'wx',
            })
            for (const [name, png] of environmentPngs)
              await writeFile(join(evidence, `${fixture.name}.${name}.png`), png, { flag: 'wx' })
            await writeFile(
              join(evidence, `${fixture.name}.json`),
              JSON.stringify(
                proof,
                (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
                2,
              ),
              { flag: 'wx' },
            )
          }
          console.info(
            `[sc2-uvm-retail] ${fixture.name}: ${textureProof.length} decoded DDS, png=${proof.pngSha256}`,
          )
        } finally {
          for (const opened of sessions.reverse()) await opened.session.dispose()
          await mount.dispose()
          await vfs.dispose()
        }
      },
      300_000,
    )
  },
)
