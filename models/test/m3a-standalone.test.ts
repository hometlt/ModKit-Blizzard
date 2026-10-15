import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
  type Inventory,
  type OpenSubjectOptions,
} from '@modkit/host'
import {
  createFilesystemInputResolver,
  loadExtensionDirectory,
  openFileArtifactSource,
} from '@modkit/host/node'
import {
  revisionId,
  type ArtifactByteSource,
  type JsonObject,
  type ModelAnimationClip,
  type ResourceBudget,
} from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'
import type { ModelProjection } from '@modkit/uv/model/materializer'
import { exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import { projectStandaloneM3Bundle } from '../dist/m3/uvm/standalone.js'
import { decodeM3Animations } from '../src/m3/runtime/animation.js'
import { decodeM3Attachments } from '../src/m3/runtime/attachments.js'
import { encodeM3JsonModel } from '../src/m3/writer.js'

const budget: ResourceBudget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}
const containerBudget = {
  ...budget,
  maxInputBytes: Number(budget.maxInputBytes),
  maxJsonBytes: budget.maxScalarBytes,
}
const fixtureUrl = new URL('./fixtures/m3/model.m3', import.meta.url)
const fixtureHash = 'a9a126d0a2b7b54bc6ac70948a40bf34bd26260f063af498cc94ff3d9a528cda'
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
let bytes: Uint8Array, directory: string, inventory: Inventory, disabledInventory: Inventory

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

beforeAll(async () => {
  bytes = Uint8Array.from(await readFile(fixtureUrl))
  expect(sha256(bytes)).toBe(fixtureHash)
  directory = await mkdtemp(join(tmpdir(), 'modkit-standalone-m3a-'))
  await writeFile(join(directory, 'actual.M3A'), bytes, { flag: 'wx' })
  const extension = {
    ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
    execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
  }
  inventory = await buildInventory([extension], createHostContributionContractRegistry())
  disabledInventory = await buildInventory([extension], createHostContributionContractRegistry(), {
    disabledContributions: ['blizzard/m3a'],
  })
})

afterAll(async () => {
  if (directory === undefined) return
  const path = resolve(directory),
    within = relative(resolve(tmpdir()), path)
  if (
    within.startsWith('..') ||
    dirname(path) !== resolve(tmpdir()) ||
    !basename(path).startsWith('modkit-standalone-m3a-')
  )
    throw new Error('unexpected standalone fixture cleanup target')
  await rm(path, { recursive: true, force: true })
})

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('expected a JSON object')
  return value as JsonObject
}
function memorySource(uri: string, payload = bytes, onRead?: () => void): ArtifactByteSource {
  return {
    kind: 'bytes',
    ref: { id: 'opaque-standalone-input', uri },
    revision: revisionId(`content-hash.sha256:${sha256(payload)}`),
    size: BigInt(payload.byteLength),
    async read(offset, length, signal) {
      signal?.throwIfAborted()
      onRead?.()
      return payload.slice(Number(offset), Number(offset) + length)
    },
    async *stream(range, signal) {
      signal?.throwIfAborted()
      onRead?.()
      const offset = Number(range?.offset ?? 0n)
      yield payload.slice(
        offset,
        range?.length === undefined ? undefined : offset + Number(range.length),
      )
    },
  }
}
function options(
  source: ArtifactByteSource,
  path: string,
  selectedInventory = inventory,
): OpenSubjectOptions {
  return {
    inventory: selectedInventory,
    source,
    path,
    intent: 'full',
    target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
    grant: { id: 'standalone-m3a-owner', classes: ['read-source'] },
    executionBackends: backends,
    budget,
  }
}
async function opened(
  source: ArtifactByteSource,
  path: string,
  selectedInventory = inventory,
  closedOrigin = false,
) {
  const result = await openSubject({
    ...options(source, path, selectedInventory),
    // The ordinary M3 control may name optional textures. Scope those lookups to this closed
    // fixture directory while retaining the caller's original bytes, explicit path and opaque URI.
    ...(closedOrigin
      ? {
          resolveInput: createFilesystemInputResolver({
            primaryPath: join(directory, 'actual.M3A'),
            roots: [directory],
            inventory: selectedInventory,
          }),
        }
      : {}),
  })
  if (result.state !== 'opened')
    throw new Error(`standalone route failed: ${JSON.stringify(result)}`)
  return result
}

describe('host-selected standalone M3A interpretation', () => {
  it('declares a suffix-only contribution with complete operation permissions and portable workers', () => {
    const contribution = inventory.extensions
      .flatMap(extension => extension.contributions)
      .find(item => item.manifest?.id === 'blizzard/m3a')
    if (contribution?.manifest === undefined) throw new Error('standalone M3A manifest absent')
    expect(contribution.activationEligible).toBe(true)
    const manifest = object(contribution.manifest)
    expect(object(manifest['spec'])['match']).toEqual({ extensions: ['m3a'] })
    expect(object(manifest['spec'])['companions']).toEqual([])
    expect(manifest['runtimeVariants']).toEqual([
      expect.objectContaining({
        entrypoint: './codecs/m3a/runtime.js',
        executionProfile: 'trusted-in-process',
        target: { environments: ['node'] },
        requestedPermissionClasses: ['read-source', 'write-source'],
      }),
      expect.objectContaining({
        entrypoint: './codecs/m3a/runtime.browser.js',
        executionProfile: 'worker-brokered',
        target: { environments: ['browser-worker', 'node-worker'] },
        requestedPermissionClasses: ['read-source', 'write-source'],
      }),
    ])
  })

  it.each([
    ['actual.m3a', 'memory:opaque', 'blizzard/m3a', true],
    ['actual.M3A', 'memory:contradiction.m3', 'blizzard/m3a', true],
    ['actual.m3', 'memory:contradiction.m3a', 'blizzard/m3', false],
    ['renamed.dat', 'memory:contradiction.m3a', 'blizzard/m3', false],
  ] as const)(
    'uses explicit path %s before source URI %s',
    async (path, uri, expectedId, standalone) => {
      const result = await opened(memorySource(uri), path, inventory, !standalone)
      try {
        expect(result.selected).toMatchObject({
          contributionId: expectedId,
          confidence: standalone ? 1 : 0.99,
        })
        const descriptor = await result.session.descriptor()
        if (descriptor.interpretation !== 'codec') throw new Error('codec descriptor absent')
        expect(descriptor.identity.codecId).toBe(expectedId)
        const scene = await result.session.dataSource('common.view/model-scene-source', 1)
        try {
          const info = await scene.value.info()
          if (standalone) {
            expect(info).toMatchObject({
              meshes: 0,
              primitives: 0,
              materials: 0,
              textures: 0,
              geometryAccess: 'decoded',
            })
            expect(info.bounds).toBeUndefined()
            expect((await scene.value.meshes({ limit: 100 })).items).toEqual([])
            expect(
              (await scene.value.nodes({ limit: 100 })).items.every(
                node => node.meshIds.length === 0,
              ),
            ).toBe(true)
            expect(
              descriptor.dataSources.some(
                item => item.contract === 'common.view/model-material-source',
              ),
            ).toBe(false)
            expect(descriptor.operations).toContainEqual(
              expect.objectContaining({ id: 'model.write', state: 'available' }),
            )
            expect(descriptor.operations).toContainEqual(
              expect.objectContaining({
                id: 'model.edit',
                state: 'available',
              }),
            )
            expect(descriptor.diagnostics).toContainEqual(
              expect.objectContaining({ code: 'x3.m3/m3a-sidecar-standalone' }),
            )
          } else {
            expect(info.meshes).toBeGreaterThan(0)
            expect(info.materials).toBeGreaterThan(0)
            expect(info.textures).toBeGreaterThan(0)
            expect(
              descriptor.diagnostics.some(item => item.code === 'x3.m3/m3a-sidecar-standalone'),
            ).toBe(false)
          }
        } finally {
          await scene.release()
        }
      } finally {
        await result.session.dispose()
      }
    },
  )

  it('captures the explicit path before an awaited source read can mutate the caller request', async () => {
    const holder: { request?: OpenSubjectOptions } = {}
    const source = memorySource('memory:looks-like.m3', bytes, () => {
      if (holder.request !== undefined) Object.assign(holder.request, { path: 'changed.m3' })
    })
    const request = options(source, 'captured.m3a')
    holder.request = request
    const result = await openSubject(request)
    if (result.state !== 'opened') throw new Error('captured request did not open')
    try {
      expect(request.path).toBe('changed.m3')
      expect(result.selected.contributionId).toBe('blizzard/m3a')
    } finally {
      await result.session.dispose()
    }
  })

  it.each(['wrong-magic', 'truncated-header'] as const)(
    'refuses %s despite the M3A suffix',
    async mode => {
      const invalid = mode === 'wrong-magic' ? Uint8Array.from(bytes) : bytes.slice(0, 4)
      if (mode === 'wrong-magic') invalid.fill(0, 0, 4)
      const result = await openSubject(
        options(memorySource('memory:invalid', invalid), 'invalid.m3a'),
      )
      if (result.state === 'opened') await result.session.dispose()
      expect(result.state).toBe('unresolved')
    },
  )

  it.each(['missing', 'disabled'] as const)(
    'makes the generic signature fallback explicit when M3A is %s',
    async mode => {
      // Keep genuine attested contribution objects; only the public inventory selection is narrowed.
      const absent: Inventory = {
        ...inventory,
        extensions: inventory.extensions.map(extension => ({
          ...extension,
          contributions: extension.contributions.filter(
            item => item.manifest?.id !== 'blizzard/m3a',
          ),
        })),
      }
      const result = await opened(
        memorySource('memory:fallback'),
        'actual.m3a',
        mode === 'missing' ? absent : disabledInventory,
        true,
      )
      try {
        expect(result.selected).toMatchObject({ contributionId: 'blizzard/m3', confidence: 0.99 })
        if (mode === 'disabled')
          expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: 'x3.host/candidate-suppressed' }),
          )
        const scene = await result.session.dataSource('common.view/model-scene-source', 1)
        try {
          expect((await scene.value.info()).meshes).toBeGreaterThan(0)
        } finally {
          await scene.release()
        }
      } finally {
        await result.session.dispose()
      }
    },
  )

  it(
    'round-trips standalone M3A through source-free UVM without a native blob',
    async () => {
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      const encoded = await encodeM3JsonModel(
        {
          format: 'gltf',
          meshes: [],
          materials: [{
            name: 'Standalone material binding',
            layers: [],
            standard: {
              layers: {
                diffuse: {
                  slot: 'diffuse',
                  alphaFactor: {
                    value: 1,
                    sequenceTracks: [{
                      sequenceIndex: 0,
                      concurrent: false,
                      track: {
                        lineType: 1,
                        globalSeqId: null,
                        keys: [
                          { frame: 0, vector: [1] },
                          { frame: 1, vector: [0.5] },
                        ],
                      },
                    }],
                  },
                },
              },
            },
          }],
          skeleton: {
            bones: [{ index: 0, name: 'Root', parentIndex: -1, inverseBindMatrix: identity }],
          },
          animations: [
            {
              name: 'Cover',
              durationSeconds: 1,
              looping: true,
              nodeTracks: [
                {
                  boneIndex: 0,
                  translation: {
                    lineType: 1,
                    keys: [
                      { frame: 0, vector: [0, 0, 0] },
                      { frame: 1, vector: [1, 0, 0] },
                    ],
                  },
                  visibility: {
                    lineType: 0,
                    keys: [
                      { frame: 0, vector: [1] },
                      { frame: 1, vector: [0] },
                    ],
                  },
                },
              ],
            },
          ],
          effects: { particles: [], ribbons: [] },
          bounds: null,
          metadata: { assetKind: 'm3a-animation-bundle', m3aHash: 3747707700 },
        },
        { fileName: 'cover.m3a', includeTextures: false },
        budget,
      )
      const actual = encoded.bytes
      const result = await opened(memorySource('memory:source-free-m3a', actual), 'cover.m3a')
      try {
        const exported = await result.session
          .operations()
          .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
        if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
          throw new Error(`source-free M3A export failed: ${JSON.stringify(exported)}`)
        const container = readUvmContainer(exported.output.value, containerBudget)
        const envelope = object(object(container.document['extras'])['BlizzardM3'])
        expect(envelope).toMatchObject({
          schemaVersion: 1,
          format: 'm3a',
          profile: 'portable-animation-v1',
          residual: { m3aHash: 3747707700, m3aHashes: [] },
        })
        expect(container.document['extensionsUsed']).not.toContain('UV_source_blob')
        expect(object(container.document['extensions'])['UV_source_blob']).toBeUndefined()
        expect(envelope['source']).toBeUndefined()
        expect(object(envelope['residual'])['animationTracks']).toEqual([
          expect.objectContaining({
            sequenceIndex: 0,
            animId: expect.any(Number),
            sdField: 'sdr3',
            frames: [0, 1000],
            values: [1, 0.5],
          }),
        ])

        const written = await result.session.operations().invoke('model-write', {
          schemaVersion: 1,
          uvmBytesHex: Buffer.from(exported.output.value).toString('hex'),
        })
        if (written.state !== 'ok' || written.output.kind !== 'bytes')
          throw new Error(`source-free M3A write failed: ${JSON.stringify(written)}`)
        const [beforeAnimation, afterAnimation, beforeAttachments, afterAttachments] = await Promise.all([
          decodeM3Animations(actual, budget),
          decodeM3Animations(written.output.value, budget),
          decodeM3Attachments(actual, budget),
          decodeM3Attachments(written.output.value, budget),
        ])
        expect(
          afterAnimation.clips.map(clip => ({
            name: clip.name,
            channels: clip.channels.length,
          })),
        ).toEqual(
          beforeAnimation.clips.map(clip => ({
            name: clip.name,
            channels: clip.channels.length,
          })),
        )
        expect(afterAttachments.primaryAnimationHash).toBe(3747707700)
        expect(afterAttachments.additionalAnimationHashes).toEqual([])
        expect(afterAttachments.sockets).toEqual(beforeAttachments.sockets)
        expect(afterAnimation.residualAnimationTracks).toEqual(
          beforeAnimation.residualAnimationTracks,
        )
      } finally {
        await result.session.dispose()
      }
    },
    30_000,
  )

  it(
    'round-trips the retail sequence-end event as structured BlizzardM3 metadata',
    async () => {
      const encoded = (await readFile(
        new URL('./fixtures/m3/cybros-cover.m3a.b64', import.meta.url),
        'utf8',
      )).replace(/\s/g, '')
      const source = Uint8Array.from(Buffer.from(encoded, 'base64'))
      const result = await opened(memorySource('memory:cybros-source-free-m3a', source), 'cover.m3a')
      try {
        const exported = await result.session
          .operations()
          .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
        if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
          throw new Error(`retail source-free M3A export failed: ${JSON.stringify(exported)}`)
        const container = readUvmContainer(exported.output.value, containerBudget)
        const envelope = object(object(container.document['extras'])['BlizzardM3'])
        const residual = object(envelope['residual'])
        expect(residual['animationEvents']).toEqual([
          expect.objectContaining({
            sequenceIndex: 0,
            stcOrder: 1,
            concurrent: true,
            priority: 0,
            animId: 104820057,
            frames: [1000],
            events: [expect.objectContaining({ name: 'Evt_SeqEnd', version: 2 })],
          }),
        ])
        expect(container.document['extensionsUsed']).not.toContain('UV_source_blob')
        const written = await result.session.operations().invoke('model-write', {
          schemaVersion: 1,
          uvmBytesHex: Buffer.from(exported.output.value).toString('hex'),
        })
        if (written.state !== 'ok' || written.output.kind !== 'bytes')
          throw new Error(`retail source-free M3A write failed: ${JSON.stringify(written)}`)
        const [before, after] = await Promise.all([
          decodeM3Animations(source, budget),
          decodeM3Animations(written.output.value, budget),
        ])
        expect(before.unsupportedChannels).toBe(0)
        expect(after.unsupportedChannels).toBe(0)
        expect(after.animationEvents).toEqual(before.animationEvents)
        expect(after.clips.map(clip => ({ name: clip.name, channels: clip.channels }))).toEqual(
          before.clips.map(clip => ({ name: clip.name, channels: clip.channels })),
        )
      } finally {
        await result.session.dispose()
      }
    },
    30_000,
  )
})

it('keeps descriptive visibility channels intact when removing active primitive targets', () => {
  const clip: ModelAnimationClip = {
    id: 'sequence',
    name: 'Visibility',
    kind: 'animation',
    provenance: 'direct',
    frames: 2,
    durationSeconds: 1,
    nativeTimeBounds: { startMilliseconds: 0, endMilliseconds: 1000 },
    channels: [
      {
        target: 'mesh-0-primitive-0',
        kind: 'visibility',
        firstFrame: 0,
        lastFrame: 1,
        interpolation: 'step',
        samples: [
          { frame: 0, timeSeconds: 0, value: [1] },
          { frame: 1, timeSeconds: 1, value: [0] },
        ],
      },
    ],
  }
  const projection: ModelProjection = {
    info: {
      scenes: 1,
      nodes: 1,
      meshes: 1,
      primitives: 1,
      materials: 1,
      textures: 1,
      animations: 1,
      geometryAccess: 'decoded',
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    nodes: [
      {
        id: 'node',
        name: 'Source',
        childIds: [],
        meshIds: ['mesh'],
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
    animations: [clip],
    resourceClosure: { mode: 'logical', entries: [{ role: 'texture', logicalId: 'source.dds' }] },
  }
  const bundle = projectStandaloneM3Bundle(projection)
  expect(bundle.animations).toBe(projection.animations)
  expect(bundle.animations).toEqual([clip])
  expect(bundle.info.bounds).toBeUndefined()
  expect(bundle.nodes?.[0]?.meshIds).toEqual([])
  expect(bundle.resourceClosure?.entries).toEqual([])
  expect(projection.nodes?.[0]?.meshIds).toEqual(['mesh'])
  expect(projection.info.meshes).toBe(1)
})
