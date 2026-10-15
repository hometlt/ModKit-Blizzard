import { beforeAll, describe, expect, it } from 'vitest'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  revisionId,
  type JsonObject,
  type LogicalResourceDiscoveryIdentity,
  type LogicalResourceDiscoveryResult,
  type LogicalResourceReadBatchRequest,
  type LogicalResourceReadBatchResult,
  type ModelAnimationClip,
  type ResourceBudget,
} from '@modkit/sdk'
import type { Diagnostic } from '@modkit/core'
import {
  readUvmAnimationClips,
  readUvmAnimationMaterialTargets,
} from '@modkit/uv/model/animation-clips'
import { composeUvmAnimationBundle } from '@modkit/scene/uvm'
import { createRenderMaterialSampler } from '@modkit/scene/materials'
import { readUvmContainer } from '@modkit/uv/model/container'
import { bindM3SequenceIndices } from '../dist/m3/uvm/animation-binding.js'
import {
  bindM3MaterialTracks,
  bindM3MaterialTimelines,
  m3SiblingStemAssociation,
  type M3BindingMaterial,
} from '../dist/m3/uvm/material-binding.js'
import { convertM3ProjectionToUvm } from '../dist/m3/uvm/converter.js'
import { createM3aMaterialBindingFixture } from './fixtures/m3a-material-binding.js'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import {
  createFilesystemInputResolver,
  loadExtensionDirectory,
  openFileArtifactSource,
} from '@modkit/host/node'

const budget: ResourceBudget = {
  maxInputBytes: 16_777_216n,
  maxScalarBytes: 16_777_216,
  maxDepth: 128,
  maxNodes: 100_000,
  maxDiagnostics: 1000,
}
const containerBudget = {
  ...budget,
  maxInputBytes: Number(budget.maxInputBytes),
  maxJsonBytes: budget.maxScalarBytes,
}
const revision = revisionId('provider-token:binding-v1')
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('fixture object absent')
  return value as JsonObject
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError('fixture value absent')
  return value
}
const track = {
  lineType: 1,
  globalSeqId: null,
  keys: [
    { frame: 0, vector: [2] },
    { frame: 1, vector: [6] },
  ],
}
function material(standard: JsonObject, referenceIndex = 0): M3BindingMaterial {
  return {
    referenceIndex,
    name: 'base static identity',
    shader: {
      id: 'modkit.render-material.v1',
      parameters: {
        renderModel: { version: 1, layers: [], standard, metadata: { native: 'unchanged' } },
      },
    },
  }
}
const base = material({
  layers: { diffuse: { slot: 'diffuse', texturePath: 'Textures/A.dds', uvSource: 0, wrapX: true } },
})
function source(index = 2, path = 'textures\\a.dds') {
  return material({
    layers: {
      diffuse: {
        slot: 'diffuse',
        texturePath: path,
        uvSource: 0,
        wrapX: true,
        alphaFactor: {
          value: 9,
          sequenceTracks: [{ sequenceIndex: index, track, concurrent: true, wrapSeconds: 1 }],
        },
        flipbook: {
          rows: 2,
          cols: 2,
          frame: { value: 3, sequenceTracks: [{ sequenceIndex: index, track }] },
        },
      },
    },
    parallaxHeight: { value: 9, sequenceTracks: [{ sequenceIndex: index, track }] },
  })
}
const sequences = bindM3SequenceIndices(
  { clips: [{ id: 'base' }], nativeSequenceIndices: [3] },
  [
    { logicalId: 'A.m3a', clips: [{ id: 'sidecar-a' }], nativeSequenceIndices: [2] },
    { logicalId: 'B.m3a', clips: [{ id: 'sidecar-b' }], nativeSequenceIndices: [7] },
  ],
  budget,
)

describe('native M3A MATM and exact sequence binding', () => {
  it('keeps native holes and distinct source identities while assigning dense combined indices', () => {
    expect(sequences).toEqual([
      { source: 'base', nativeSequenceIndex: 3, clipId: 'base', combinedSequenceIndex: 0 },
      {
        source: 'sidecar',
        logicalId: 'A.m3a',
        nativeSequenceIndex: 2,
        clipId: 'sidecar-a',
        combinedSequenceIndex: 1,
      },
      {
        source: 'sidecar',
        logicalId: 'B.m3a',
        nativeSequenceIndex: 7,
        clipId: 'sidecar-b',
        combinedSequenceIndex: 2,
      },
    ])
  })
  it('merges compatible tracks in source order with native neutral defaults and explicit atlas loss', () => {
    const output = bindM3MaterialTracks(
      [base],
      [
        { logicalId: 'A.m3a', materials: [source()] },
        { logicalId: 'B.m3a', materials: [source(7)] },
      ],
      sequences,
      budget,
    )
    expect(output.sources).toEqual([
      { logicalId: 'A.m3a', sourceTracks: 3, mergedTracks: 2, unmappedTracks: 1 },
      { logicalId: 'B.m3a', sourceTracks: 3, mergedTracks: 2, unmappedTracks: 1 },
    ])
    const render = object(required(output.materials[0]?.shader).parameters['renderModel']),
      standard = object(render['standard'])
    expect(render['metadata']).toEqual({ native: 'unchanged' })
    expect(standard['parallaxHeight']).toEqual({
      value: 0,
      sequenceTracks: [1, 2].map(sequenceIndex => ({ sequenceIndex, track })),
    })
    const diffuse = object(object(standard['layers'])['diffuse'])
    expect(diffuse['alphaFactor']).toEqual({
      value: 1,
      sequenceTracks: [1, 2].map(sequenceIndex => ({
        sequenceIndex,
        track,
        concurrent: true,
        wrapSeconds: 1,
      })),
    })
    expect(diffuse['texturePath']).toBe('Textures/A.dds')
    expect(diffuse['flipbook']).toBeUndefined()
    expect(base).toEqual(
      material({
        layers: {
          diffuse: { slot: 'diffuse', texturePath: 'Textures/A.dds', uvSource: 0, wrapX: true },
        },
      }),
    )
  })
  it('does not compact MATM holes into a different target material', () => {
    const output = bindM3MaterialTracks(
      [base],
      [{ logicalId: 'A.m3a', materials: [{ ...source(), referenceIndex: 1 }] }],
      sequences,
      budget,
    )
    expect(output.materials).toEqual([base])
    expect(output.sources[0]).toMatchObject({ sourceTracks: 3, mergedTracks: 0, unmappedTracks: 3 })
  })
  it('rejects incompatible texture layout without replacing the active base material', () => {
    const output = bindM3MaterialTracks(
      [base],
      [{ logicalId: 'A.m3a', materials: [source(2, 'different.dds')] }],
      sequences,
      budget,
    )
    expect(output.materials).toEqual([base])
    expect(output.sources[0]?.unmappedTracks).toBe(3)
  })
  it('reports tracks whose native sequence was rejected instead of binding them by array position', () => {
    const output = bindM3MaterialTracks(
      [base],
      [{ logicalId: 'A.m3a', materials: [source(0)] }],
      sequences,
      budget,
    )
    expect(output.sources[0]).toMatchObject({ sourceTracks: 3, mergedTracks: 0, unmappedTracks: 3 })
  })
  it.each(['duplicate-clips', 'missing-index', 'duplicate-native'] as const)(
    'refuses invalid source mapping: %s',
    kind => {
      expect(() =>
        bindM3SequenceIndices(
          {
            clips: [{ id: 'one' }, { id: kind === 'duplicate-clips' ? 'one' : 'two' }],
            nativeSequenceIndices:
              kind === 'missing-index' ? [0] : kind === 'duplicate-native' ? [0, 0] : [0, 1],
          },
          [],
          budget,
        ),
      ).toThrow()
    },
  )
  it('bounds metadata and observes cancellation before cloning tracks', () => {
    expect(() =>
      bindM3MaterialTracks([base], [], sequences, { ...budget, maxScalarBytes: 30 }),
    ).toThrow()
    const controller = new AbortController()
    controller.abort(new Error('cancel binding'))
    expect(() => bindM3MaterialTracks([base], [], sequences, budget, controller.signal)).toThrow(
      expect.objectContaining({ name: 'AbortError', message: 'operation cancelled' }),
    )
  })
  it('uses only explicit host logical identity for the exact native stem predicate', () => {
    expect(m3SiblingStemAssociation('Models/HERO.M3', 'models/Hero-Walk.M3A')).toBe(true)
    expect(m3SiblingStemAssociation('Models/Hero.m3', 'elsewhere/Hero-Walk.m3a')).toBe(false)
    expect(m3SiblingStemAssociation('Models/Hero.m3', 'models/Other.m3a')).toBe(false)
    expect(m3SiblingStemAssociation('Models/Hero.m3', 'Hero-Walk.m3a')).toBe(false)
  })
})

interface NativeProjection {
  readonly clips: readonly ModelAnimationClip[]
  readonly nativeSequenceIndices: readonly number[]
  readonly materials: readonly M3BindingMaterial[]
  readonly fatal: boolean
}
interface BindingResult {
  readonly clips: readonly ModelAnimationClip[]
  readonly accepted: readonly {
    logicalId: string
    revision: typeof revision
    sourceBytes: Uint8Array
    materials: readonly M3BindingMaterial[]
    clipIds: readonly string[]
    nativeSequenceIndices: readonly number[]
    binding: string
  }[]
  readonly diagnostics: readonly Diagnostic[]
  readonly admissionComplete?: boolean
}
let nativeBase: Uint8Array, nativeSidecar: Uint8Array
beforeAll(async () => {
  nativeBase = await createM3aMaterialBindingFixture({ bones: true, value: 0 })
  nativeSidecar = await createM3aMaterialBindingFixture({ bones: false, value: 9 })
})
async function decoded(bytes: Uint8Array) {
  const { decodeM3Animations } = (await import(
    new URL('../src/m3/animation.node.js', import.meta.url).href
  )) as {
    decodeM3Animations(bytes: Uint8Array, budget: ResourceBudget): Promise<NativeProjection>
  }
  const { decodeM3Materials } = (await import(
    new URL('../src/m3/material.node.js', import.meta.url).href
  )) as {
    decodeM3Materials(bytes: Uint8Array, budget: ResourceBudget): Promise<NativeProjection>
  }
  return {
    animation: await decodeM3Animations(bytes, budget),
    material: await decodeM3Materials(bytes, budget),
  }
}
async function project(
  context?: LogicalResourceDiscoveryIdentity,
  options: {
    candidateRoot?: string
    bytes?: Uint8Array
    base?: Uint8Array
    refusal?: boolean
  } = {},
) {
  const bytes = options.bytes ?? nativeSidecar
  const baseBytes = options.base ?? nativeBase
  let calls = 0
  const port = {
    async readBatch(
      request: LogicalResourceReadBatchRequest,
    ): Promise<LogicalResourceReadBatchResult> {
      calls++
      expect(request).toMatchObject({
        concurrency: 4,
        readTimeoutMs: 8000,
        totalTimeoutMs: 10000,
        maxBytes: budget.maxInputBytes - BigInt(baseBytes.length),
      })
      if (options.refusal)
        return {
          state: 'refused',
          reason: 'source-revision-changed',
          message: 'stale batch',
          items: [],
          bytes: 0n,
        }
      return {
        state: 'complete',
        bytes: BigInt(bytes.length),
        items: request.items.map(item => ({
          state: 'read',
          bytes,
          revision,
          provenance: {
            requirementId: item.requirement.id,
            logicalId: item.requirement.logicalId,
            role: 'sidecar',
            state: 'resolved',
            revision,
            bytes: BigInt(bytes.length),
            cached: false,
            scopes: item.requirement.scopes,
          },
        })),
      }
    },
    async provenance() {
      return []
    },
  }
  const discovery: LogicalResourceDiscoveryResult = {
    state: 'complete',
    candidates: [
      {
        logicalId: 'models/Hero-Walk.m3a',
        rootId: options.candidateRoot ?? 'root',
        expectedRevision: revision,
        size: BigInt(bytes.length),
      },
    ],
    receipt: { complete: true, pages: 1, entries: 1, candidates: 1, bytes: BigInt(bytes.length) },
    ...(context === undefined ? {} : { context }),
  }
  const { discoverM3AnimationSidecars } = (await import(
    new URL('../src/m3/sidecar-projection.node.js', import.meta.url).href
  )) as {
    discoverM3AnimationSidecars(options: {
      baseBytes: Uint8Array
      candidateDiscovery: { discover(): Promise<LogicalResourceDiscoveryResult> }
      resources: typeof port
      budget: ResourceBudget
      includeSources: true
    }): Promise<BindingResult>
  }
  return {
    result: await discoverM3AnimationSidecars({
      baseBytes,
      candidateDiscovery: {
        async discover() {
          return discovery
        },
      },
      resources: port,
      budget,
      includeSources: true,
    }),
    calls,
  }
}

describe('native material-only M3A admission and UVM catalog', () => {
  it('binds a filesystem material-only sibling through ordinary M3 open, facets and public UVM export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'modkit-m3a-binding-'))
    try {
      const primaryPath = join(directory, 'Hero.m3'),
        sidecarPath = join(directory, 'Hero-Walk.m3a')
      await writeFile(primaryPath, nativeBase, { flag: 'wx' })
      await writeFile(sidecarPath, nativeSidecar, { flag: 'wx' })
      const source = await openFileArtifactSource(primaryPath),
        sidecar = await openFileArtifactSource(sidecarPath)
      const inventory = await buildInventory(
        [
          {
            ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
            execution: { origin: 'bundled', allowTrustedInProcess: true },
          },
        ],
        createHostContributionContractRegistry(),
      )
      const result = await openSubject({
        source,
        path: primaryPath,
        inventory,
        intent: 'full',
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
        grant: { id: 'm3a-binding-owner', classes: ['read-source'] },
        budget,
        resolveInput: createFilesystemInputResolver({ primaryPath, roots: [directory], inventory }),
        executionBackends: createExecutionBackendRegistry([
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
        ]),
        logicalResourceDiscovery: [
          {
            role: 'sidecar',
            extension: '.m3a',
            async discover() {
              return {
                state: 'complete',
                context: { primaryLogicalId: 'Hero.m3', rootId: 'fixture' },
                candidates: [
                  {
                    logicalId: 'Hero-Walk.m3a',
                    rootId: 'fixture',
                    expectedRevision: sidecar.revision,
                    size: BigInt(nativeSidecar.length),
                    scopes: ['sibling-directory'],
                  },
                ],
                receipt: {
                  complete: true,
                  pages: 1,
                  entries: 1,
                  candidates: 1,
                  bytes: BigInt(nativeSidecar.length),
                },
              }
            },
          },
        ],
      })
      if (result.state !== 'opened')
        throw new Error(`native material binding open failed: ${JSON.stringify(result)}`)
      try {
        const descriptor = await result.session.descriptor()
        expect(
          JSON.stringify(descriptor, (_key, value) =>
            typeof value === 'bigint' ? String(value) : value,
          ),
        ).not.toContain('sourceBytes')
        const skeleton = await result.session.dataSource('common.view/model-skeleton-source', 1)
        try {
          const bones = (await skeleton.value.bindings({ limit: 10 })).items
          expect(bones).toHaveLength(1)
          expect(bones[0]).toMatchObject({
            localPose: { translation: [10, 20, 30], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            inverseBindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10, -20, -30, 1],
          })
        } finally {
          await skeleton.release()
        }
        const animation = await result.session.dataSource('common.view/model-animation-source', 1)
        try {
          const clips = (await animation.value.clips({ limit: 10 })).items
          expect(clips).toHaveLength(2)
          expect(clips.at(-1)).toMatchObject({
            sequenceIndex: 1,
            frames: 2,
            channels: [],
            durationSeconds: 1,
          })
        } finally {
          await animation.release()
        }
        const materialSource = await result.session.dataSource(
          'common.view/model-material-source',
          1,
        )
        try {
          const material = required((await materialSource.value.materials({ limit: 10 })).items[0])
          expect(
            object(object(required(material.shader).parameters['renderModel'])['standard'])[
              'parallaxHeight'
            ],
          ).toMatchObject({
            sequenceTracks: [
              expect.objectContaining({ sequenceIndex: 0 }),
              expect.objectContaining({ sequenceIndex: 1 }),
            ],
          })
        } finally {
          await materialSource.release()
        }
        const exported = await result.session
          .operations()
          .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
        if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
          throw new Error('native binding UVM export failed')
        const container = readUvmContainer(exported.output.value, containerBudget)
        expect(readUvmAnimationClips(container.document)?.at(-1)).toMatchObject({
          sourceId: 'm3-sequence-0',
          sourceSequenceIndex: 0,
          durationSeconds: 1,
        })
        const envelope = object(object(container.document['extras'])['BlizzardM3'])
        expect(envelope).toMatchObject({ schemaVersion: 1, format: 'm3' })
        expect(Object.keys(object(envelope['mapping']))).toEqual(['frame'])
        expect(object(container.document['extensions'])['UV_source_blob']).toBeUndefined()
        // The same bytes selected as standalone M3A keep materials inactive, yet expose only
        // known neutral animated properties for explicit generic composition into the base.
        const standalone = await openSubject({
          source: sidecar,
          path: sidecarPath,
          inventory,
          intent: 'full',
          target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
          grant: { id: 'm3a-binding-standalone', classes: ['read-source'] },
          budget,
          resolveInput: createFilesystemInputResolver({
            primaryPath: sidecarPath,
            roots: [directory],
            inventory,
          }),
          executionBackends: createExecutionBackendRegistry([
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
          ]),
        })
        if (standalone.state !== 'opened')
          throw new Error('standalone material bundle failed to open')
        try {
          expect(standalone.selected.contributionId, JSON.stringify(standalone.candidates)).toBe(
            'blizzard/m3a',
          )
          const exportedBundle = await standalone.session
            .operations()
            .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
          if (exportedBundle.state !== 'ok' || exportedBundle.output.kind !== 'bytes')
            throw new Error('standalone material bundle export failed')
          const bundle = readUvmContainer(exportedBundle.output.value, containerBudget)
          for (const name of ['materials', 'textures', 'images', 'meshes'])
            expect(bundle.document[name] ?? []).toEqual([])
          const targets = readUvmAnimationMaterialTargets(bundle.document)
          expect(targets).toHaveLength(1)
          expect(targets[0]?.properties).toEqual([
            {
              path: '/renderModel/standard/parallaxHeight',
              value: 9,
              sequenceTracks: [{ sequenceIndex: 0, track }],
            },
          ])
          expect(JSON.stringify(targets)).not.toMatch(/texturePath|BlizzardM3|sourceBytes|metadata/)
          const sourceClip = required(readUvmAnimationClips(bundle.document)?.[0])
          expect(sourceClip).toMatchObject({ frames: 2, durationSeconds: 1, kind: 'animation' })
          const attached = await composeUvmAnimationBundle(
            container,
            bundle,
            {
              id: 'bind-native-material',
              clips: [{ sourceId: sourceClip.id, id: 'bound-material-only', sequenceIndex: 2 }],
              materials: [{ sourceKind: 'animation-target', source: 0, target: 0 }],
            },
            { budget: containerBudget },
          )
          const activeMaterials = attached.container.document['materials']
          if (!Array.isArray(activeMaterials)) throw new Error('composed material absent')
          const params = object(
            object(object(activeMaterials[0])['extensions'])['UV_game_material'],
          )['params']
          const sampler = createRenderMaterialSampler(params, {
            maxDepth: budget.maxDepth,
            maxNodes: budget.maxNodes,
            maxBytes: budget.maxScalarBytes,
          })
          expect(
            [0, 0.5, 1].map(
              time =>
                sampler.sample({ time, sequenceTime: time, sequenceIndex: 2 })[0]?.material
                  .parallaxHeight?.value,
            ),
          ).toEqual([2, 4, 6])
          expect(
            sampler.sample({ time: 0.5, sequenceTime: 0.5, sequenceIndex: 3 })[0]?.material
              .parallaxHeight?.value,
          ).toBe(0)
          expect(readUvmAnimationClips(attached.container.document)?.at(-1)).toMatchObject({
            id: 'bound-material-only',
            sourceSequenceIndex: 2,
          })
        } finally {
          await standalone.session.dispose()
        }
      } finally {
        await result.session.dispose()
      }
    } finally {
      const target = resolve(directory),
        within = relative(resolve(tmpdir()), target)
      if (
        within.startsWith('..') ||
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('modkit-m3a-binding-')
      )
        throw new Error('unexpected fixture cleanup target')
      await rm(target, { recursive: true, force: true })
    }
  })
  it('admits matching hashes without a naming witness and refuses mismatching hashes despite a valid stem', async () => {
    const base = await createM3aMaterialBindingFixture({ hash: 42 }),
      matching = await createM3aMaterialBindingFixture({ bones: false, hash: 42, value: 9 })
    expect((await project(undefined, { base, bytes: matching })).result.accepted).toHaveLength(1)
    expect(
      (await project({ primaryLogicalId: 'models/Hero.m3', rootId: 'root' }, { base })).result
        .accepted,
    ).toEqual([])
  })
  it('admits material-only binding when both authored skeletons are empty', async () => {
    const base = await createM3aMaterialBindingFixture({ bones: false, value: 0 })
    const { result } = await project(
      { primaryLogicalId: 'models/Hero.m3', rootId: 'root' },
      { base },
    )
    expect(result.accepted).toHaveLength(1)
    expect(result.clips[0]?.channels).toEqual([])
  })
  it('keeps the old hash-only gate when the host supplied no naming witness', async () => {
    const { result } = await project()
    expect(result.accepted).toEqual([])
    expect(result.diagnostics.some(item => item.code === 'x3.m3/m3a-sidecar-hash-mismatch')).toBe(
      true,
    )
  })
  it('refuses a stem witness from a different root without guessing another namespace', async () => {
    expect(
      (await project({ primaryLogicalId: 'models/Hero.m3', rootId: 'different' })).result.accepted,
    ).toEqual([])
  })
  it('keeps staged binding empty after a fatal host batch refusal', async () => {
    const { result, calls } = await project(
      { primaryLogicalId: 'models/Hero.m3', rootId: 'root' },
      { refusal: true },
    )
    expect(calls).toBe(1)
    expect(result.admissionComplete).toBe(false)
    expect(result.accepted).toEqual([])
    expect(result.clips).toEqual([])
  })
  it('does not reinterpret an empty table caused by a refused skeleton reference as material-only', async () => {
    const bytes = await createM3aMaterialBindingFixture({ bones: false, malformedSkeleton: true })
    const { result } = await project(
      { primaryLogicalId: 'models/Hero.m3', rootId: 'root' },
      { bytes },
    )
    expect(result.accepted).toEqual([])
    expect(result.diagnostics.some(item => item.code.includes('skeleton'))).toBe(true)
  })
  it('binds a genuine empty-skeleton bundle, preserves material keys and writes an empty-TRS clip catalog', async () => {
    const { result } = await project({ primaryLogicalId: 'models/Hero.m3', rootId: 'root' })
    expect(result.accepted).toHaveLength(1)
    const sidecar = required(result.accepted[0])
    expect(sidecar.binding).toBe('sibling-stem')
    expect(sidecar.nativeSequenceIndices).toEqual([0])
    expect(result.clips[0]?.channels).toEqual([])
    const { animation, material: baseMaterials } = await decoded(nativeBase)
    const map = bindM3SequenceIndices(
      { clips: animation.clips, nativeSequenceIndices: animation.nativeSequenceIndices },
      [
        {
          logicalId: sidecar.logicalId,
          clips: result.clips,
          nativeSequenceIndices: sidecar.nativeSequenceIndices,
        },
      ],
      budget,
    )
    const bound = bindM3MaterialTracks(
      baseMaterials.materials,
      [{ logicalId: sidecar.logicalId, materials: sidecar.materials }],
      map,
      budget,
    )
    expect(bound.sources[0]).toMatchObject({ sourceTracks: 1, mergedTracks: 1, unmappedTracks: 0 })
    const clips = [...animation.clips, ...result.clips].map((clip, sequenceIndex) => ({
      ...clip,
      sequenceIndex,
    }))
    const timing = bindM3MaterialTimelines(clips, bound.materials, budget)
    expect(timing.clips.at(-1)).toMatchObject({
      frames: 2,
      kind: 'animation',
      durationSeconds: 1,
      nativeTimeBounds: { startMilliseconds: 100, endMilliseconds: 1100 },
      channels: [],
    })
    const output = await convertM3ProjectionToUvm(
      sidecar.sourceBytes,
      {
        info: {
          scenes: 1,
          nodes: 0,
          meshes: 0,
          primitives: 0,
          materials: 0,
          textures: 0,
          animations: 0,
          geometryAccess: 'decoded',
        },
        nodes: [],
        meshes: [],
        primitives: [],
        animations: timing.clips.slice(animation.clips.length).map((clip, sequenceIndex) => ({
          ...clip,
          sequenceIndex,
          sourceSequenceIndex: sequenceIndex,
        })),
        excludedFacetIds: [],
      },
      {},
      {
        assetId: 'native-fixture',
        subjectRevision: revision,
        metersPerSourceUnit: 1,
        budget: containerBudget,
        sourceFormat: 'm3a',
        animationMaterialTargets: sidecar.materials.map(material => ({
          id: `material-${material.referenceIndex}`,
          ...(material.name === undefined ? {} : { name: material.name }),
          type: 'standard',
          layers: [],
          ...(material.shader === undefined ? {} : { shader: material.shader }),
        })),
      },
    )
    const container = readUvmContainer(output.bytes, containerBudget)
    expect(readUvmAnimationClips(container.document)?.at(-1)).toMatchObject({
      sourceId: sidecar.clipIds[0],
      sourceSequenceIndex: 0,
      durationSeconds: 1,
      frames: 2,
    })
    expect(readUvmAnimationClips(container.document)?.at(-1)?.animation).toBeUndefined()
    const mappings = object(object(object(container.document['extras'])['BlizzardM3'])['mapping'])
    expect(Object.keys(mappings)).toEqual(['frame'])
    expect(object(container.document['extensions'])['UV_source_blob']).toBeUndefined()
  })
})
