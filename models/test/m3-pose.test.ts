import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { createModelPoseSampler } from '@modkit/codec-kit/model/skeleton'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'
import { decodeM3Skeleton } from '../src/m3/skeleton.node.js'
import { decodeM3Animations } from '../src/m3/animation.node.js'
import { decodeM3Geometry } from '../src/m3/geometry.node.js'
import { decodeM3Materials } from '../src/m3/material.node.js'
import { projectM3MaterialBatches } from '../dist/m3/material-batches.js'
import { projectM3SkinBindings } from '../dist/m3/skeleton-projection.js'
import { findModkitCoreWorkspace } from './workspace-root.js'
import { loadUvTools, drainModelProjection } from '@modkit/testkit'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import { loadExtensionDirectory, createFilesystemInputResolver } from '@modkit/host/node'
import {
  revisionId,
  type ArtifactByteSource,
  type ModelSceneSource,
  type ModelSkeletonSource,
  type ModelAnimationSource,
  type ModelMaterialSource,
  type SceneRendererPrimitive,
  type SceneRenderRequest,
  type SceneRenderFrame,
} from '@modkit/sdk'

const fixtures = new URL('./fixtures/m3/', import.meta.url)
const schema = new URL('../src/m3/native/structures.xml', import.meta.url)
const budget = { maxDepth: 128, maxNodes: 1_000_000, maxScalarBytes: 256 * 1024 * 1024 }
installM3PlatformAdapters({ DOMParser: DOMParser as unknown as typeof globalThis.DOMParser })

const coreRoot = findModkitCoreWorkspace(import.meta.dirname)
const modelInventory = async (format: 'm3' | 'uvm') =>
  buildInventory(
    [
      {
        ...(await loadExtensionDirectory(
          format === 'uvm'
            ? join(coreRoot, 'extensions', 'models')
            : join(import.meta.dirname, '..'),
        )),
        execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
      },
    ],
    createHostContributionContractRegistry(),
  )
const backends = createExecutionBackendRegistry([
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

async function openModel(bytes: Uint8Array, format: 'm3' | 'uvm', primaryPath?: string) {
  const uri = `memory://uvm-pose/fixture.${format === 'uvm' ? 'uvm.glb' : 'm3'}`
  const source: ArtifactByteSource = {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision: revisionId(`content-hash.sha256:${createHash('sha256').update(bytes).digest('hex')}`),
    size: BigInt(bytes.byteLength),
    read: async (offset, length) => bytes.slice(Number(offset), Number(offset) + length),
  }
  const inventory = await modelInventory(format)
  const result = await openSubject({
    inventory,
    source,
    path: format === 'uvm' ? 'fixture.uvm.glb' : 'fixture.m3',
    intent: 'full',
    target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
    grant: { id: 'm3-uvm-pose', classes: ['read-source'] },
    executionBackends: backends,
    ...(primaryPath === undefined
      ? {}
      : {
          resolveInput: createFilesystemInputResolver({
            primaryPath,
            roots: [fileURLToPath(fixtures)],
            inventory,
          }),
        }),
    budget: { ...budget, maxInputBytes: 268_435_456n, maxDiagnostics: 100 },
  })
  if (result.state !== 'opened')
    throw new Error(`${format} did not open: ${JSON.stringify(result)}`)
  return result
}

describe('M3 skeleton and skin pose through common contracts', () => {
  for (const file of [
    'model.m3',
    'corpus/portrait.m3',
    'corpus/Harbinger.m3',
    'corpus/analysisterminal.m3',
    'corpus/aiur_cliffrocks_00.m3',
    'cybros-cover.m3a.b64',
  ]) {
    it(`binds every bone and samples finite world matrices for ${file}`, async () => {
      const stored = await readFile(new URL(file, fixtures))
      const bytes = new Uint8Array(
        file.endsWith('.b64') ? Buffer.from(stored.toString().trim(), 'base64') : stored,
      )
      const skeleton = await decodeM3Skeleton(bytes, budget)
      const animation = await decodeM3Animations(bytes, budget)
      expect(skeleton.rejectedLocalPoses).toBe(0)
      expect(skeleton.sceneNodes).toHaveLength(skeleton.bindings.length)
      for (const [index, binding] of skeleton.bindings.entries()) {
        expect(binding).toMatchObject({ nodeId: `bone/${binding.boneIndex}`, boneIndex: index })
        if (binding.parentBoneIndex !== null) expect(binding.parentBoneIndex).toBeLessThan(skeleton.bindings.length)
      }
      for (const clip of animation.clips) {
        const sampler = createModelPoseSampler({
          bindings: skeleton.bindings,
          hierarchyId: 'm3/bone-table',
          clip,
        })
        for (const time of [-1, 0, 0.06, 0.12, 0.5, 1, 2.5]) {
          const { bones } = sampler.sample(time)
          expect(bones).toHaveLength(skeleton.bindings.length)
          for (const pose of bones) {
            expect(pose.worldMatrix).toHaveLength(16)
            expect(pose.worldMatrix.every(Number.isFinite)).toBe(true)
          }
        }
      }
      const materials = await decodeM3Materials(bytes, budget)
      const base = projectM3MaterialBatches(
        await decodeM3Geometry(bytes, budget),
        materials.primitiveBindings,
        budget,
      )
      const bound = projectM3SkinBindings(base, skeleton.bindings, skeleton.sceneNodes, budget)
      expect(bound.rejected).toBe(0)
      expect(bound.geometry.nodes).toHaveLength(base.nodes.length + skeleton.bindings.length)
      for (const primitive of bound.geometry.primitives)
        if (primitive.boneIndices !== undefined) expect(primitive.hierarchyId).toBe('m3/bone-table')
      const tools = await loadUvTools(coreRoot)
      const geometry = bound.geometry
      const nativeSubject = await openModel(bytes, 'm3', fileURLToPath(new URL(file, fixtures)))
      let projection
      try {
        const scene = await nativeSubject.session.dataSource('common.view/model-scene-source', 1)
        const bones = await nativeSubject.session.dataSource('common.view/model-skeleton-source', 1)
        const clips = await nativeSubject.session.dataSource(
          'common.view/model-animation-source',
          1,
        )
        const materialFacet =
          materials.materials.length === 0
            ? undefined
            : await nativeSubject.session.dataSource('common.view/model-material-source', 1)
        try {
          projection = await drainModelProjection(scene.value as ModelSceneSource, {
            maxBytes: budget.maxScalarBytes,
            skeletonSource: bones.value as ModelSkeletonSource,
            animationSource: clips.value as ModelAnimationSource,
            ...(materialFacet === undefined
              ? {}
              : { materialSource: materialFacet.value as ModelMaterialSource }),
          })
        } finally {
          await scene.release()
          await bones.release()
          await clips.release()
          await materialFacet?.release()
        }
      } finally {
        await nativeSubject.session.dispose()
      }
      const materialize = () =>
        tools.materializer.materializeUvmCore(projection, {
          scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
          profile: 'UVM/core@1.0',
          subjectRevision: revisionId(
            `content-hash.sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          ),
          options: { assetId: `fixture/${file}`, sourceFormat: 'm3' },
        })
      // Six referenced vertices in this immutable corpus file have all-zero native weights.
      // They remain readable in M3. glTF requires unit sums; export must not silently normalize
      // them or turn their unknown deformation into a static identity binding.
      if (file === 'corpus/portrait.m3') {
        let zeroWeightVertices = 0
        for (const primitive of projection.primitives ?? []) {
          const weights = primitive.boneWeights
          if (weights === undefined) continue
          for (let offset = 0; offset < weights.length; offset += 4)
            if (weights.subarray(offset, offset + 4).every(value => value === 0))
              zeroWeightVertices++
        }
        expect(zeroWeightVertices).toBe(6)
        expect(materialize).toThrow('skin weights must sum to one')
      } else {
        const written = materialize()
        const containers = (await import(
          pathToFileURL(join(coreRoot, 'packages/uv/dist/model/container.js')).href
        )) as typeof import('../../../modkit-core/packages/uv/dist/model/container.js')
        const imported = containers.readUvmContainer(written.bytes)
        const extensions = imported.document['extensions'] as Record<string, unknown>
        expect(extensions['UV_source_blob']).toBeUndefined()
        const uvmBytes = written.bytes
        const validator = (await import(
          pathToFileURL(
            join(
              coreRoot,
              '..',
              'references',
              'modkitmk2',
              'node_modules',
              '.pnpm',
              'gltf-validator@2.0.0-dev.3.10',
              'node_modules',
              'gltf-validator',
              'module.mjs',
            ),
          ).href
        )) as {
          validateBytes(
            bytes: Uint8Array,
            options: { uri: string },
          ): Promise<{
            issues: {
              numErrors: number
              messages: { severity: number; code: string; message: string }[]
            }
          }>
        }
        const validation = await validator.validateBytes(uvmBytes, { uri: `${file}.uvm.glb` })
        expect(
          validation.issues.numErrors,
          JSON.stringify(
            validation.issues.messages.filter(item => item.severity === 0).slice(0, 30),
          ),
        ).toBe(0)
        const reopened = await openModel(uvmBytes, 'uvm')
        try {
          const scene = await reopened.session.dataSource('common.view/model-scene-source', 1)
          const bones = await reopened.session.dataSource('common.view/model-skeleton-source', 1)
          const clips = await reopened.session.dataSource('common.view/model-animation-source', 1)
          try {
            const restored = await drainModelProjection(scene.value as ModelSceneSource, {
              maxBytes: budget.maxScalarBytes,
              skeletonSource: bones.value as ModelSkeletonSource,
              animationSource: clips.value as ModelAnimationSource,
            })
            expect(restored.skeleton).toHaveLength(skeleton.bindings.length)
            expect(restored.animations).toHaveLength(animation.clips.length)
            // The render owner consumes the reopened UVM projection, with no M3 renderer path.
            const sceneModule = (await import(
              pathToFileURL(join(coreRoot, 'packages/scene/dist/model/index.js')).href
            )) as {
              createModelSceneSampler(
                projection: unknown,
                options: unknown,
              ): {
                sample(time: number): {
                  primitives: readonly SceneRendererPrimitive[]
                  diagnostics: readonly { code: string }[]
                }
              }
            }
            const renderer = (await import(
              pathToFileURL(join(coreRoot, 'packages/scene/dist/render/headless.js')).href
            )) as {
              renderHeadless(request: SceneRenderRequest): Promise<SceneRenderFrame>
            }
            const framing = (await import(
              pathToFileURL(join(coreRoot, 'packages/ui/dist/model/index.js')).href
            )) as {
              framePrimitives(primitives: readonly SceneRendererPrimitive[]): unknown
              createOrbitController(): { basis(): unknown }
              modelCamera(
                framing: unknown,
                basis: unknown,
                distance: number,
                viewport: { width: number; height: number },
              ): unknown
              modelSceneRequest(options: unknown): SceneRenderRequest
            }
            const renderClip = restored.animations?.find(clip => clip.kind === 'animation')
            const player = sceneModule.createModelSceneSampler(
              {
                ...restored,
                nodes: restored.nodes ?? [],
                meshes: restored.meshes ?? [],
                primitives: restored.primitives ?? [],
              },
              { ...(renderClip === undefined ? {} : { clip: renderClip }) },
            )
            const poses = [player.sample(0), player.sample(0.12)]
            for (const pose of poses) {
              // Standalone M3A has no mesh; it must not gain invented display geometry.
              if (file.endsWith('.m3a.b64')) expect(pose.primitives).toHaveLength(0)
              else expect(pose.primitives.length).toBeGreaterThan(0)
              expect(pose.diagnostics.map(item => item.code)).not.toContain(
                'common.model/skin-unavailable',
              )
              expect(pose.diagnostics.map(item => item.code)).not.toContain(
                'common.model/pose-unavailable',
              )
            }
            const viewport = { width: 128, height: 96 }
            const camera = framing.modelCamera(
              framing.framePrimitives(poses.flatMap(pose => [...pose.primitives])),
              framing.createOrbitController().basis(),
              1,
              viewport,
            )
            for (const pose of poses) {
              const frame = await renderer.renderHeadless(
                framing.modelSceneRequest({ primitives: pose.primitives, camera, viewport }),
              )
              expect(frame.diagnostics).toEqual([])
              if (file.endsWith('.m3a.b64')) expect(frame.statistics.fragments).toBe(0)
              else expect(frame.statistics.fragments).toBeGreaterThan(0)
              expect(frame.statistics.primitives).toBe(pose.primitives.length)
            }
            const sourceNodeOrder = [...geometry.nodes].sort((a, b) =>
              Buffer.from(a.id).compare(Buffer.from(b.id)),
            )
            const nodeMap = new Map(
              sourceNodeOrder.map((node, index) => [node.id, `node-${index}`]),
            )
            for (const [clipIndex, originalClip] of animation.clips.entries()) {
              const restoredClip = restored.animations![clipIndex]!
              const original = createModelPoseSampler({
                bindings: skeleton.bindings,
                hierarchyId: 'm3/bone-table',
                clip: originalClip,
              })
              const artifact = createModelPoseSampler({
                bindings: restored.skeleton!,
                hierarchyId: 'skin-0',
                clip: restoredClip,
              })
              for (const time of [-1, 0, 0.06, 0.12, 0.5, 1, 2.5]) {
                const actual = new Map(artifact.sample(time).bones.map(bone => [bone.nodeId, bone]))
                for (const bone of original.sample(time).bones) {
                  const target = actual.get(nodeMap.get(bone.nodeId)!)!
                  expect(target).toBeDefined()
                  for (const field of ['worldMatrix', 'skinningMatrix'] as const) {
                    expect(target[field]).toHaveLength(bone[field]!.length)
                    for (const [index, value] of bone[field]!.entries())
                      expect(
                        Math.abs(target[field]![index]! - value),
                        `${file}/${clipIndex}/${time}/${bone.nodeId}/${field}/${index}`,
                      ).toBeLessThanOrEqual(0.00001 * Math.max(1, Math.abs(value)))
                  }
                }
              }
            }
          } finally {
            await scene.release()
            await bones.release()
            await clips.release()
          }
        } finally {
          await reopened.session.dispose()
        }
      }
      expect(() =>
        projectM3SkinBindings(
          base,
          skeleton.bindings,
          skeleton.sceneNodes,
          budget,
          AbortSignal.abort(),
        ),
      ).toThrow('cancelled')
    })
  }
})
