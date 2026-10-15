/**
 * `blizzard/wow-m2` on a synthetic bundle (`./m2-fixtures.ts`): the reader's numbers against the ones
 * written, then the codec opened as the host opens it — companions by `filedataid/<id>` through a
 * logical-resource port — its facets, and `model.export-uvm` through the shared materializer.
 * Imports the built `dist`, the copy the manifest runs.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  revisionId,
  type ArtifactByteSource,
  type AssetInput,
  type Codec,
  type ContributionContext,
  type LogicalResourcePort,
  type ModelAnimationSource,
  type ModelMaterialSource,
  type ModelResourceRefsSource,
  type ModelSceneSource,
  type ResourceBudget,
} from '@modkit/sdk'
import { ANIM_FILE_ID, SKIN_FILE_ID, TEXTURE_FILE_ID, SKELETON_FILE_ID, PARENT_SKELETON_FILE_ID,
  fixtureBundle, fixtureMaterialBundle, fixtureAnimationPages, fixtureSkeleton, fixtureSharedSkeleton, fixtureBonePose, fixtureBonePoseBundle, packQuat } from './m2-fixtures.js'
import { createStandardMaterialPrograms, createRenderMaterialSampler } from '@modkit/scene/materials'
import { createModelSceneSampler } from '@modkit/scene/model'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { readUvmContainer } from '@modkit/uv/model/container'

const dist = join(import.meta.dirname, '..', 'dist', 'm2')
type Reader = typeof import('../src/m2/reader.js')
const reader = (await import(pathToFileURL(join(dist, 'reader.js')).href)) as Reader
const { buildM2Scene } = (await import(pathToFileURL(join(dist, 'scene.js')).href)) as typeof import('../src/m2/scene.js')
const { composeSkeleton } = (await import(pathToFileURL(join(dist, 'skeleton.js')).href)) as typeof import('../src/m2/skeleton.js')

const budget: ResourceBudget = { maxInputBytes: 10_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 10_000_000, maxDiagnostics: 100 }

/** A resource port serving `files` by logical id, recording what was asked. */
interface ResourceBatchObservation { readonly ids: readonly string[]; readonly maxBytes: bigint | undefined }
function resources(files: ReadonlyMap<string, Uint8Array>, asked: string[] = [], batches?: ResourceBatchObservation[]): LogicalResourcePort {
  return {
    async readBatch(request) {
      batches?.push({ ids: request.items.map(item => item.requirement.logicalId), maxBytes: request.maxBytes })
      return {
        state: 'complete',
        bytes: 0n,
        items: request.items.map(item => {
          asked.push(item.requirement.logicalId)
          const bytes = files.get(item.requirement.logicalId)
          return bytes === undefined
            ? { state: 'unresolved', reason: 'not-found', message: 'absent' }
            : { state: 'read', bytes, revision: revisionId('content-hash.sha256:fixture'), provenance: {} as never }
        }),
      } as never
    },
    async discover() { throw new Error('unused') },
    async resolve() { throw new Error('unused') },
    async provenance() { return [] },
    async identity() { return { primaryLogicalId: 'creature/fixture/fixture.m2' } as never },
  }
}

function source(bytes: Uint8Array): ArtifactByteSource {
  const uri = 'memory://wow/fixture.m2'
  return {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision: revisionId('content-hash.sha256:wow-m2-fixture'),
    size: BigInt(bytes.byteLength),
    async read(offset, length) { return bytes.slice(Number(offset), Number(offset) + length) },
    async *stream() { yield bytes },
  }
}

function input(value: ArtifactByteSource): AssetInput {
  const binding = { sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: value.ref, revision: value.revision }
  return {
    originKind: 'single',
    bindings: [binding],
    primaryBindingId: 'content',
    revisions: { topology: 'single', revision: value.revision, bindings: [{ bindingId: 'content', revision: value.revision }], compositionFingerprint: value.ref.id },
    bindingsFor: () => [],
    async openBinding() { return { value, async release() { return undefined } } },
  } as unknown as AssetInput
}

async function open(bytes: Uint8Array, files: ReadonlyMap<string, Uint8Array> | undefined, asked?: string[],
  options: { readonly budget?: ResourceBudget; readonly batches?: ResourceBatchObservation[];
    readonly logicalResources?: LogicalResourcePort } = {}) {
  const testBudget = options.budget ?? budget
  const logicalResources = options.logicalResources ?? (files === undefined ? undefined : resources(files, asked, options.batches))
  const context: ContributionContext = {
    budgets: testBudget,
    diagnostics: { report: () => undefined },
    contracts: { async resolve() { throw new Error('none') }, async resolveUnknown() { throw new Error('none') } },
    ...(logicalResources === undefined ? {} : { logicalResources }),
  } as ContributionContext
  const module = (await import(pathToFileURL(join(dist, 'codec.js')).href)) as { createCodec(context: ContributionContext): Codec }
  return module.createCodec(context).open(input(source(bytes)), 'inspect', testBudget)
}

async function lease<T>(session: Awaited<ReturnType<typeof open>>, contract: string): Promise<T> {
  return (await session.dataSource(contract, 1)).value as T
}

describe('WoW M2 reader', () => {
  it('reads stored-in-model sequences without ANIM and keeps runtime cache offsets distinct', () => {
    const bundle = fixtureBundle()
    for (const flags of [0x100, 0x120, 0x110]) {
      const bytes = bundle.model.slice()
      const raw = reader.md20Of(bytes, 1000).md20
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
      const sequences = view.getUint32(0x20, true)
      view.setUint32(sequences + 12, flags, true)
      const parsed = reader.readM2(bytes, { maxRecords: 1000 })
      expect(reader.isExternalSequence(parsed.sequences[0]!)).toBe(false)
      expect(parsed.bones[1]!.translation.perSequence[0]!.values).toEqual([[0, 0, 0], [1, 0, 0]])
      expect(parsed.bones[1]!.translation.missing).not.toContain(0)
    }
    const bytes = bundle.model.slice()
    const raw = reader.md20Of(bytes, 1000).md20
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    view.setUint32(view.getUint32(0x20, true) + 64 + 12, 0x10, true)
    const absent = reader.readM2(bytes, { maxRecords: 1000 })
    expect(reader.isExternalSequence(absent.sequences[1]!)).toBe(false)
    expect(absent.bones[1]!.translation.missing).toContain(1)
    const cached = reader.readM2(bytes, { maxRecords: 1000, animBuffers: new Map([[1, reader.animPayload(bundle.anim, 1000)!]]) })
    expect(cached.bones[1]!.translation.perSequence[1]!.values).toEqual([[0, 0, 0], [0, 2, 0]])
  })

  it('reads facial BONE offsets independently of SKEL and rejects malformed or unrelated records', () => {
    const bytes = fixtureBonePose()
    const pose = reader.readBonePose(bytes, 100, 2)
    expect(pose.prelude).toBe(1)
    expect(pose.offsets.map(offset => offset.bone)).toEqual([0, 1])
    expect(pose.offsets.map(offset => offset.matrix[12])).toEqual([0.25, 1.25])
    expect(pose.offsets[0]!.matrix).toHaveLength(16)
    expect(pose.chunks.map(chunk => chunk.tag)).toEqual(['BIDA', 'BOMT'])
    expect(pose.chunks[0]!.offset).toBe(12)
    expect(() => reader.readBonePose(bytes, 1, 2)).toThrow(/budget/iu)
    expect(() => reader.readBonePose(fixtureBonePose([0, 2]), 100, 2)).toThrow(/outside/iu)
    expect(() => reader.readBonePose(fixtureBonePose([0, 0]), 100, 2)).toThrow(/duplicated/iu)
    expect(() => reader.readBonePose(fixtureBonePose([0, 1], 1), 100)).toThrow(/mismatched/iu)
    expect(() => reader.readBonePose(bytes.subarray(0, bytes.length - 1), 100)).toThrow()
    const wrong = bytes.slice()
    new DataView(wrong.buffer).setUint32(0, 2, true)
    expect(() => reader.readBonePose(wrong, 100)).toThrow(/unsupported BONE/iu)
    const nonFinite = bytes.slice()
    new DataView(nonFinite.buffer).setFloat32(pose.chunks[1]!.offset, NaN, true)
    expect(() => reader.readBonePose(nonFinite, 100)).toThrow(/finite/iu)
    const tail = new Uint8Array(bytes.length + 1)
    tail.set(bytes)
    expect(() => reader.readBonePose(tail, 100)).toThrow(/incomplete/iu)
    const cancelled = new AbortController()
    cancelled.abort()
    expect(() => reader.readBonePose(bytes, 100, 2, cancelled.signal)).toThrow(/abort/iu)
  })

  const bundle = fixtureBundle()
  const anim = reader.animPayload(bundle.anim, 1000)!

  it('reads the chunked container, header, tracks and the external sequence from its .anim', () => {
    const model = reader.readM2(bundle.model, { maxRecords: 1000, animBuffers: new Map([[1, anim]]) })
    expect(model.version).toBe(274)
    expect(model.name).toBe('Fixture')
    expect(model.chunks.map(chunk => chunk.tag)).toEqual(['MD21', 'SFID', 'TXID', 'AFID'])
    expect(model.fileIds).toMatchObject({ skins: [SKIN_FILE_ID], textures: [TEXTURE_FILE_ID, 0], animations: [{ animId: 4, subAnimId: 0, fileId: ANIM_FILE_ID }] })
    expect(model.sequences.map(sequence => [sequence.id, sequence.duration, sequence.flags])).toEqual([[0, 1000, 0x20], [4, 500, 0]])
    const bone = model.bones[1]!
    expect(bone.parent).toBe(0)
    expect(bone.pivot).toEqual([0, 0, 1])
    expect(bone.translation.perSequence[0]).toEqual({ times: [0, 1000], values: [[0, 0, 0], [1, 0, 0]] })
    expect(bone.translation.perSequence[1]).toEqual({ times: [0, 500], values: [[0, 0, 0], [0, 2, 0]] })
    expect(bone.rotation.globalSequence).toBe(0)
    const turned = bone.rotation.perSequence[0]!.values[1]!
    expect(turned.map(component => Math.round(component * 1000) / 1000)).toEqual([0, 0, 1, 0])
    expect(model.textureWeights[0]!.perSequence[0]!.values[0]).toBeCloseTo(0x4000 / 0x7fff)
    expect(model.vertices.count).toBe(3)
    expect([...model.vertices.boneIndices.subarray(0, 4)]).toEqual([1, 0, 0, 0])
    expect(model.attachments).toMatchObject([{ id: 1, bone: 1, position: [0, 0, 2] }])
    expect(model.events[0]).toMatchObject({ identifier: '$FSD', data: 77, bone: 1 })
    expect(model.events[0]!.times.perSequence[0]!.times).toEqual([250])
  })

  it('leaves an external sequence without its .anim empty and names it missing', () => {
    const model = reader.readM2(bundle.model, { maxRecords: 1000 })
    expect(model.bones[1]!.translation.perSequence[1]).toEqual({ times: [], values: [] })
    expect(model.bones[1]!.translation.missing).toEqual([1])
  })

  it('decodes the compressed quaternion as the client does, not as the wiki publishes', () => {
    expect(reader.quatComponent(packQuat([1])[0]!)).toBe(1)
    expect(reader.quatComponent(0)).toBe(-1)
    expect(reader.quatComponent(32767)).toBeCloseTo(-1 / 65535, 9)
  })

  it('retains a constant value without timestamps and refuses mismatched native key counts', () => {
    const flat = bundle.flat.slice()
    const view = new DataView(flat.buffer)
    const bones = view.getUint32(0x30, true)
    const track = bones + 88 + 16
    const times = view.getUint32(track + 8, true)
    const values = view.getUint32(track + 16, true)
    view.setUint32(times, 0, true)
    view.setUint32(values, 1, true)
    expect(reader.readM2(flat, { maxRecords: 1000 }).bones[1]?.translation.perSequence[0]).toEqual({ times: [0], values: [[0, 0, 0]] })
    view.setUint32(times, 2, true)
    expect(() => reader.readM2(flat, { maxRecords: 1000 })).toThrow(/mismatched/u)
  })

  it('reads the skin and refuses a truncated model, a foreign skin and an old version', () => {
    const skin = reader.readSkin(bundle.skin, 1000)
    expect([...skin.vertices]).toEqual([0, 1, 2])
    expect(skin.submeshes[0]).toMatchObject({ vertexCount: 3, indexStart: 0, indexCount: 3 })
    expect(skin.batches[0]).toMatchObject({ textureCount: 2, materialIndex: 0 })
    expect(() => reader.readM2(bundle.model.subarray(0, 40), { maxRecords: 1000 })).toThrow(RangeError)
    expect(() => reader.readSkin(bundle.model, 1000)).toThrow(/SKIN/u)
    const old = bundle.flat.slice()
    new DataView(old.buffer).setUint32(4, 260, true)
    expect(() => reader.readM2(old, { maxRecords: 1000 })).toThrow(/version 260/u)
    new DataView(old.buffer).setUint32(4, 275, true)
    expect(() => reader.readM2(old, { maxRecords: 1000 })).toThrow(/version 275/u)
  })

  it('folds the high word of a submesh index start from its level field', () => {
    const skin = bundle.skin.slice()
    const submesh = new DataView(skin.buffer).getUint32(28 + 4, true)
    new DataView(skin.buffer).setUint16(submesh + 2, 1, true)
    expect(reader.readSkin(skin, 1000).submeshes[0]!.indexStart).toBe(0x10000)
  })
})

describe('blizzard/wow-m2 codec', () => {
  it('reserves cached ANIM bytes before BONE prefetch and refuses exhausted quota without another read', async () => {
    const bundle = fixtureBonePoseBundle()
    const observations: ResourceBatchObservation[] = []
    const files = new Map([
      [`filedataid/${String(SKIN_FILE_ID)}`, bundle.skin], [`filedataid/${String(ANIM_FILE_ID)}`, bundle.anim],
      ['filedataid/9001', fixtureBonePose()], ['filedataid/9002', fixtureBonePose()],
    ])
    const session = await open(bundle.model, files, undefined, { batches: observations })
    try {
      const facet = await session.dataSource('common.view/model-scene-source', 1)
      await facet.release()
      const boneBatch = observations.find(batch => batch.ids.includes('filedataid/9001'))!
      expect(boneBatch.maxBytes).toBe(BigInt(budget.maxScalarBytes - bundle.anim.byteLength))
      expect(boneBatch.maxBytes).toBeLessThan(BigInt(budget.maxScalarBytes))
    } finally { await session.dispose() }

    // Valid AFM2 plus an opaque native chunk fills the quota without changing its keyframe data.
    const ceiling = Math.max(bundle.model.byteLength, bundle.anim.byteLength + 8)
    const paddedAnim = new Uint8Array(ceiling)
    paddedAnim.set(bundle.anim)
    paddedAnim.set(new TextEncoder().encode('PADD'), bundle.anim.byteLength)
    new DataView(paddedAnim.buffer).setUint32(bundle.anim.byteLength + 4, ceiling - bundle.anim.byteLength - 8, true)
    files.set(`filedataid/${String(ANIM_FILE_ID)}`, paddedAnim)
    const exhausted: ResourceBatchObservation[] = []
    const limited = await open(bundle.model, files, undefined, {
      budget: { ...budget, maxScalarBytes: ceiling }, batches: exhausted,
    })
    try {
      await expect(limited.dataSource('common.view/model-scene-source', 1)).rejects.toThrow(/exhaust.*maxScalarBytes/iu)
      expect(exhausted.some(batch => batch.ids.some(id => id === 'filedataid/9001' || id === 'filedataid/9002'))).toBe(false)
      expect(exhausted.some(batch => batch.ids.includes(`filedataid/${String(ANIM_FILE_ID)}`))).toBe(true)
    } finally { await limited.dispose() }
  })

  it('reads deduplicated BFID offsets through the same resource port without replacing the skeleton', async () => {
    const bundle = fixtureBonePoseBundle()
    for (const companion of [undefined, fixtureBonePose([2])] as const) {
      const asked: string[] = []
      const files = new Map([
        [`filedataid/${String(SKIN_FILE_ID)}`, bundle.skin], [`filedataid/${String(ANIM_FILE_ID)}`, bundle.anim],
        ['filedataid/9001', fixtureBonePose()],
      ])
      if (companion !== undefined) files.set('filedataid/9002', companion)
      const session = await open(bundle.model, files, asked)
      try {
        const result = await session.operations().invoke('inspect', null)
        if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('inspect failed')
        expect(result.output.value).toMatchObject({ bones: 2, animFilesRead: 1, bonePoseFilesNamed: 2,
          bonePoseFilesRead: companion === undefined ? 1 : 2, bonePoseFilesDecoded: 1, bonePoseOffsets: 2 })
        expect(asked.filter(id => id === 'filedataid/9001')).toHaveLength(1)
        expect(asked.filter(id => id === 'filedataid/9002')).toHaveLength(1)
        const clips = (await (await lease<ModelAnimationSource>(session, 'common.view/model-animation-source')).clips({ limit: 10 })).items
        expect(clips).toHaveLength(2)
        expect(clips[1]!.channels.find(channel => channel.kind === 'translation')!.samples!.map(sample => sample.value))
          .toEqual([[0, 0, 1], [0, 2, 1]])
      } finally { await session.dispose() }
    }
  })

  const bundle = fixtureBundle()
  const files = new Map([
    [`filedataid/${String(SKIN_FILE_ID)}`, bundle.skin],
    [`filedataid/${String(ANIM_FILE_ID)}`, bundle.anim],
  ])

  it('publishes the scene, materials, textures and clips of the model and its companions', async () => {
    const session = await open(bundle.model, files)
    const result = await session.operations().invoke('inspect', null)
    if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('inspect failed')
    expect(result.output.value).toMatchObject({ format: 'wow-m2', name: 'Fixture', vertices: 3, bones: 2, sequences: 2, batches: 1, animFilesRead: 1 })

    const scene = await lease<ModelSceneSource>(session, 'common.view/model-scene-source')
    const info = await scene.info()
    expect(info).toMatchObject({ upAxis: '+z', geometryAccess: 'decoded', meshes: 1, primitives: 1 })
    const nodes = (await scene.nodes({ limit: 100 })).items
    expect(nodes.map(node => node.id)).toEqual(['root', 'bone-0', 'bone-1', 'attachment-0'])
    expect(nodes[2]!.trs?.translation).toEqual([0, 0, 1])
    expect(nodes[2]!.billboard).toMatchObject({ mode: 'inverse-camera' })
    expect(nodes[3]!.trs?.translation).toEqual([0, 0, 1])
    const primitive = await scene.primitive!('batch-0', { maxBytes: 1_000_000 })
    expect([...primitive.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect([...primitive.indices!]).toEqual([0, 1, 2])
    expect([...primitive.boneIndices!.subarray(0, 4)]).toEqual([1, 0, 0, 0])
    expect(primitive.boneWeights![0]).toBe(1)

    const materials = (await (await lease<ModelMaterialSource>(session, 'common.view/model-material-source')).materials({ limit: 10 })).items
    expect(materials[0]).toMatchObject({
      alphaMode: 'blend',
      doubleSided: true,
      depthWrite: false,
      layers: [{ slot: 'diffuse', resourceId: `filedataid/${String(TEXTURE_FILE_ID)}`, uvSource: 0 }],
      shader: { parameters: { blendMode: 'alpha-blend', replaceableTextureTypes: [1] } },
    })
    expect(materials[0]!.baseColorFactor![3]).toBeCloseTo(0x4000 / 0x7fff)
    const refs = (await (await lease<ModelResourceRefsSource>(session, 'common.view/model-resource-refs-source')).references({ limit: 10 })).items
    expect(refs).toEqual([{ id: `filedataid/${String(TEXTURE_FILE_ID)}`, role: 'texture', provenance: 'reference-only' }])

    const clips = (await (await lease<ModelAnimationSource>(session, 'common.view/model-animation-source')).clips({ limit: 10 })).items
    expect(clips.map(clip => [clip.id, clip.durationSeconds])).toEqual([['sequence-0', 1], ['sequence-1', 0.5]])
    const walk = clips[1]!.channels.find(channel => channel.kind === 'translation')!
    // the key plus the bone's rest offset from its parent's pivot
    expect(walk.samples!.map(sample => sample.value)).toEqual([[0, 0, 1], [0, 2, 1]])
    const spin = clips[1]!.channels.find(channel => channel.kind === 'rotation')!
    expect(spin).toMatchObject({ concurrent: true, wrapSeconds: 1, interpolation: 'spherical-linear' })
    expect(clips[0]!.events).toEqual([{ timeSeconds: 0.25, name: '$FSD', nodeId: 'bone-1', payload: { data: 77, event: 0, position: [0, 0, 0] } }])
    await session.dispose()
  })

  it('exports UVM through the shared materializer', async () => {
    const session = await open(bundle.model, files)
    const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
    if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
    const bytes = result.output.value as Uint8Array
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF')
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)
    const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as Record<string, unknown[]>
    expect(document['meshes']).toHaveLength(1)
    expect(document['animations']).toHaveLength(2)
    expect(JSON.stringify(document['images'])).toContain(`filedataid/${String(TEXTURE_FILE_ID)}`)
    await session.dispose()
  })

  it('retains skinned vertex motion and the attachment anchor at start, midpoint and end in metres', async () => {
    const bytes = bundle.model.slice()
    const raw = reader.md20Of(bytes, 1000).md20
    const native = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    const bones = native.getUint32(0x30, true)
    native.setUint32(bones + 88 + 4, 0x80, true) // transformed, without a camera-facing billboard
    native.setUint16(bones + 88 + 36, 0, true) // hold the first quantised quaternion
    const sequences = native.getUint32(0x20, true)
    native.setUint32(sequences + 64 + 12, 1, true) // once: the final sample does not wrap to zero
    const session = await open(bytes, files)
    try {
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error('pose UVM export failed')
      const container = readUvmContainer(result.output.value as Uint8Array, {
        maxInputBytes: 10_000_000, maxJsonBytes: 10_000_000, maxNodes: 100_000, maxDepth: 64,
      })
      const decoded = readUvmModel(container.document, container.binary, { maxScalarBytes: 10_000_000 })
      const clip = decoded.rig.clips.find(clip => clip.sequenceIndex === 1)!
      expect(clip.loop).toBe('once')
      const sampler = createModelSceneSampler({ ...decoded.scene, skeleton: decoded.rig.bindings, nodePoses: decoded.rig.nodePoses }, { clip })
      const document = container.document as unknown as { nodes: { extensions?: { UV_game_socket?: unknown } }[] }
      const socket = decoded.scene.nodes[document.nodes.findIndex(node => node.extensions?.UV_game_socket !== undefined)]!.id
      for (const [time, moved] of [[0, 0], [0.25, 1], [0.5, 2]] as const) {
        const sampled = sampler.sample(time)
        const primitive = sampled.primitives[0]!
        const p = primitive.positions
        expect(primitive.transform).toBeDefined()
        const matrix = primitive.transform!
        // Scene primitive positions are interpreted with their explicit root frame, even for skin.
        const position = [0, 1, 2].map(axis => matrix[axis]! * p[0]! + matrix[axis + 4]! * p[1]! + matrix[axis + 8]! * p[2]! + matrix[axis + 12]!)
        expect(sampled.diagnostics).toEqual([])
        // Native +Y movement becomes -Z; 1 yard = 0.9144m, applied once by the materializer.
        expect(position[0]).toBeCloseTo(0, 4)
        expect(position[1]).toBeCloseTo(0, 4)
        expect(position[2]).toBeCloseTo(-moved * 0.9144, 4)
        const anchor = sampled.nodeTransforms.get(socket)!
        expect(anchor[12]).toBeCloseTo(0, 4)
        expect(anchor[13]).toBeCloseTo(2 * 0.9144, 4)
        expect(anchor[14]).toBeCloseTo(-moved * 0.9144, 4)
      }
    } finally { await session.dispose() }
  })

  it('opens without companions as metadata and says why', async () => {
    const session = await open(bundle.model, new Map())
    const scene = await lease<ModelSceneSource>(session, 'common.view/model-scene-source')
    expect((await scene.info()).geometryAccess).toBe('metadata-only')
    const result = await session.operations().invoke('inspect', null)
    if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('inspect failed')
    expect(result.output.value).toMatchObject({ animFilesRead: 0, animFilesNamed: 1 })
    await session.dispose()
  })

  it.each(['not-found', 'not-allowlisted', 'path-refused', 'scope-unsupported', 'budget-exceeded',
    'cycle-detected', 'session-disposed', 'source-revision-changed', 'permission-missing',
    'deadline-exceeded', 'read-failed', 'size-mismatch'])('retains only the typed item reason %s', async reason => {
    const port: LogicalResourcePort = { ...resources(new Map()), async readBatch(request) {
      return { state: 'complete', bytes: 0n,
        items: request.items.map(() => ({ state: 'unresolved', reason, message: 'PRIVATE_BACKEND_TEXT' })) } as never
    } }
    const session = await open(bundle.model, undefined, undefined, { logicalResources: port })
    try {
      const diagnostics = (await session.descriptor()).diagnostics.filter(d => d.code.startsWith('blizzard.wow-m2/resource-'))
      expect(diagnostics.length).toBeGreaterThan(0)
      for (const item of diagnostics) expect(item).toMatchObject({
        code: 'blizzard.wow-m2/resource-unresolved', data: { state: 'unresolved', reason } })
      expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_BACKEND_TEXT|filedataid\//u)
    } finally { await session.dispose() }
  })

  it.each(['request-invalid', 'context-unavailable', 'deadline-exceeded', 'budget-exceeded'])('retains batch refusal %s when items are empty', async reason => {
    const port: LogicalResourcePort = { ...resources(new Map()), async readBatch() {
      return { state: 'refused', reason, message: 'PRIVATE_BATCH_TEXT', items: [], bytes: 0n } as never
    } }
    const session = await open(bundle.model, undefined, undefined, { logicalResources: port })
    try {
      const diagnostics = (await session.descriptor()).diagnostics.filter(d => d.code.startsWith('blizzard.wow-m2/resource-'))
      expect(diagnostics.length).toBeGreaterThan(0)
      for (const item of diagnostics) expect(item).toMatchObject({
        code: 'blizzard.wow-m2/resource-refused', data: { state: 'refused', reason } })
      expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_BATCH_TEXT|filedataid\//u)
    } finally { await session.dispose() }
  })

  it('does not coerce or publish an unknown reason or backend message', async () => {
    let coerced = 0
    const opaque = { [Symbol.toPrimitive]() { coerced++; throw new Error('PRIVATE_REASON') } }
    for (const reason of [opaque, 'PRIVATE_UNKNOWN_REASON', 'request-invalid', undefined]) {
      const port: LogicalResourcePort = { ...resources(new Map()), async readBatch(request) {
        return { state: 'complete', bytes: 0n, items: request.items.map(() => ({ state: 'unresolved', reason,
          get message() { throw new Error('PRIVATE_MESSAGE_GETTER') } })) } as never
      } }
      const session = await open(bundle.model, undefined, undefined, { logicalResources: port })
      try {
        const diagnostics = (await session.descriptor()).diagnostics.filter(d => d.code.startsWith('blizzard.wow-m2/resource-'))
        expect(diagnostics.length).toBeGreaterThan(0)
        for (const item of diagnostics) expect(item).toMatchObject({ data: { state: 'unresolved', reason: 'unknown' } })
        expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_|filedataid\//u)
      } finally { await session.dispose() }
    }
    expect(coerced).toBe(0)
  })

  it('does not admit per-item-only reasons as a batch refusal', async () => {
    const port: LogicalResourcePort = { ...resources(new Map()), async readBatch() {
      return { state: 'refused', reason: 'read-failed', message: 'PRIVATE_BATCH_TEXT', items: [], bytes: 0n } as never
    } }
    const session = await open(bundle.model, undefined, undefined, { logicalResources: port })
    try {
      const diagnostics = (await session.descriptor()).diagnostics.filter(d => d.code.startsWith('blizzard.wow-m2/resource-'))
      expect(diagnostics.length).toBeGreaterThan(0)
      for (const item of diagnostics) expect(item).toMatchObject({ data: { state: 'refused', reason: 'unknown' } })
      expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_|filedataid\//u)
    } finally { await session.dispose() }
  })

  it('reports a context refusal without a logical resource port', async () => {
    const session = await open(bundle.model, undefined)
    try {
      const diagnostics = (await session.descriptor()).diagnostics.filter(d => d.code.startsWith('blizzard.wow-m2/resource-'))
      expect(diagnostics.length).toBeGreaterThan(0)
      for (const item of diagnostics) expect(item).toMatchObject({
        data: { state: 'refused', reason: 'context-unavailable' } })
      expect(JSON.stringify(diagnostics)).not.toContain('filedataid/')
    } finally { await session.dispose() }
  })
})

describe('WoW shared skeletons', () => {
  it('inherits the SKS1 clock table for material tracks in a split M2', () => {
    const bundle = fixtureSharedSkeleton()
    const model = reader.readM2(bundle.model, { maxRecords: 1000 })
    const skeleton = reader.readSkeleton(bundle.skeleton, { maxRecords: 1000 })
    const combined = composeSkeleton({ ...model, globalLoops: [], textureTransforms: [{
      translation: { interpolation: 1, globalSequence: 0, missing: [],
        perSequence: [{ times: [0, 500], values: [[0, 0, 0], [1, 0, 0]] }] },
      rotation: { interpolation: 0, globalSequence: null, missing: [], perSequence: [] },
      scale: { interpolation: 0, globalSequence: null, missing: [], perSequence: [] },
    }] }, [skeleton])
    expect(combined.textureTransforms[0]!.translation.perSequence[1]).toMatchObject({ globalPeriodMilliseconds: 1000 })
  })
  it('decodes chunk-local skeleton offsets and separate AFSB and AFSA buffers', () => {
    const bundle = fixtureSharedSkeleton()
    expect(reader.animPayload(bundle.anim, 1000)).toBeUndefined()
    const descriptor = reader.skeletonDescriptor(bundle.skeleton, 1000)
    expect(descriptor.sequences?.map(sequence => sequence.id)).toEqual([0, 4])
    const skeleton = reader.readSkeleton(bundle.skeleton, { maxRecords: 1000,
      animBuffers: new Map([[1, reader.animPayload(bundle.anim, 1000, 'bones')!]]),
      attachmentAnimBuffers: new Map([[1, reader.animPayload(bundle.anim, 1000, 'attachments')!]]),
    })
    expect(skeleton.bones?.[1]?.translation.perSequence[1]?.values).toEqual([[0, 0, 0], [0, 2, 0]])
    expect(skeleton.attachments?.[0]?.enabled.perSequence[1]?.values).toEqual([1, 0])
    expect(() => reader.skeletonDescriptor(bundle.skeleton.subarray(0, 17), 1000)).toThrow()
  })

  it('opens shared-skeleton geometry and retains parent and child-only animations', async () => {
    const bundle = fixtureSharedSkeleton()
    const parent = fixtureSkeleton()
    const child = fixtureSkeleton({ parent: PARENT_SKELETON_FILE_ID, externalId: 9, animationFileId: ANIM_FILE_ID + 1 })
    const session = await open(bundle.model, new Map([
      [`filedataid/${String(SKIN_FILE_ID)}`, bundle.skin],
      [`filedataid/${String(SKELETON_FILE_ID)}`, child.skeleton],
      [`filedataid/${String(PARENT_SKELETON_FILE_ID)}`, parent.skeleton],
      [`filedataid/${String(ANIM_FILE_ID)}`, parent.anim],
      [`filedataid/${String(ANIM_FILE_ID + 1)}`, child.anim],
    ]))
    try {
      const source = await lease<ModelSceneSource>(session, 'common.view/model-scene-source')
      expect(await source.info()).toMatchObject({ geometryAccess: 'decoded', primitives: 1 })
      const animations = await lease<ModelAnimationSource>(session, 'common.view/model-animation-source')
      const clips = (await animations.clips({ limit: 10 })).items
      expect(clips.map(clip => clip.name)).toEqual(['Animation 0.0', 'Animation 4.0', 'Animation 9.0'])
      for (const clip of clips.slice(1)) {
        expect(clip.channels.find(channel => channel.kind === 'translation')?.samples?.at(-1)?.value).toEqual([0, 2, 1])
        expect(clip.channels.find(channel => channel.kind === 'rotation')).toMatchObject({ concurrent: true, wrapSeconds: 1 })
      }
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
      expect(result.state).toBe('ok')
    } finally { await session.dispose() }
  })

  it('refuses a cyclic declared skeleton chain rather than inventing a rig', async () => {
    const bundle = fixtureSharedSkeleton()
    const cyclic = fixtureSkeleton({ parent: SKELETON_FILE_ID })
    const session = await open(bundle.model, new Map([
      [`filedataid/${String(SKIN_FILE_ID)}`, bundle.skin],
      [`filedataid/${String(SKELETON_FILE_ID)}`, cyclic.skeleton],
    ]))
    try {
      await expect(session.dataSource('common.view/model-scene-source', 1)).rejects.toThrow(/cycle/iu)
    } finally { await session.dispose() }
  })
})

describe('WoW native animation policy', () => {
  it('reads every reachable AFID across bounded pages beyond 200 unique companions', async () => {
    const bundle = fixtureAnimationPages()
    const files = new Map([[`filedataid/${String(SKIN_FILE_ID)}`, bundle.skin]])
    for (let index = 0; index < 205; index += 1) files.set(`filedataid/${String(ANIM_FILE_ID + index)}`, bundle.anim)
    const asked: string[] = []
    const session = await open(bundle.model, files, asked)
    try {
      const result = await session.operations().invoke('inspect', null)
      if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('large AFID inspection failed')
      expect(result.output.value).toMatchObject({ sequences: 206, animFilesNamed: 205, animFilesRead: 205 })
      expect(asked).toContain(`filedataid/${String(ANIM_FILE_ID + 204)}`)
      expect(new Set(asked).size).toBe(206) // 205 ANIM plus one SKIN, no duplicate native reads.
    } finally { await session.dispose() }
  })
  const bundle = fixtureBundle()
  const model = reader.readM2(bundle.model, { maxRecords: 1000,
    animBuffers: new Map([[1, reader.animPayload(bundle.anim, 1000)!]]) })

  it('holds a zero-period global track and applies the native non-looping bit', () => {
    const scene = buildM2Scene({ ...model, globalLoops: [0],
      sequences: model.sequences.map(sequence => ({ ...sequence, flags: sequence.flags | 1 })) }, undefined)
    for (const clip of scene.clips) {
      expect(clip).toMatchObject({ loop: 'once', looping: false })
      const rotation = clip.channels.find(channel => channel.kind === 'rotation')!
      expect(rotation).toMatchObject({ interpolation: 'step' })
      expect(rotation.concurrent).toBeUndefined()
      expect(rotation.wrapSeconds).toBeUndefined()
      expect(rotation.samples).toHaveLength(1)
    }
  })

  it('does not sample keyed untransformed or kinematic bones as ordinary animation', () => {
    for (const flags of [8, 0x488]) {
      const scene = buildM2Scene({ ...model, bones: model.bones.map((bone, index) => index === 1 ? { ...bone, flags } : bone) }, undefined)
      expect(scene.clips.every(clip => clip.channels.length === 0)).toBe(true)
      if (flags === 0x488) expect(scene.notes.some(note => note.startsWith('kinematic-physics:'))).toBe(true)
    }
  })

  it('refuses invalid parents and alias cycles without fabricating roots or motion', () => {
    expect(() => buildM2Scene({ ...model, bones: model.bones.map((bone, index) => ({ ...bone, parent: index === 0 ? 1 : 0 })) }, undefined)).toThrow(/cycle/iu)
    expect(() => buildM2Scene({ ...model, bones: model.bones.map((bone, index) => ({ ...bone, parent: index === 0 ? 90 : bone.parent })) }, undefined)).toThrow(/parent/iu)
    expect(() => buildM2Scene({ ...model, sequences: model.sequences.map((sequence, index) => ({ ...sequence, flags: 0x40, aliasNext: 1 - index })) }, undefined)).toThrow(/alias cycle/iu)
  })

  it('does not convert an inherited global event into a sequence-local event', () => {
    const event = model.events[0]!
    const scene = buildM2Scene({ ...model, events: [{ ...event, times: { ...event.times, globalSequence: null,
      perSequence: event.times.perSequence.map(keys => ({ ...keys, globalPeriodMilliseconds: 1000 })) } }] }, undefined)
    expect(scene.clips.every(clip => clip.events === undefined)).toBe(true)
    expect(scene.notes.some(note => note.startsWith('event-global-clock:'))).toBe(true)
  })
})

describe('WoW native material projection', () => {
  it('preserves RGB, alpha and weight clocks in the common material program and UVM', async () => {
    const bundle = fixtureMaterialBundle()
    const model = reader.readM2(bundle.model, { maxRecords: 1000,
      animBuffers: new Map([[1, reader.animPayload(bundle.anim, 1000)!]]) })
    expect(model.textureTransforms[0]?.rotation.perSequence[0]?.values).toEqual([[0, 0, 0, 1]])
    const scene = buildM2Scene(model, reader.readSkin(bundle.skin, 1000))
    const material = scene.materials[0]!
    expect(material.shader?.id).toBe('modkit.render-material.v1')
    const budget = { maxBytes: 1_000_000, maxNodes: 100_000, maxDepth: 64 }
    const programs = createStandardMaterialPrograms(material.shader!.parameters, { budget })
    const sampled = createRenderMaterialSampler(material.shader!.parameters, budget)
      .sample({ time: 0.5, sequenceTime: 0.25, sequenceIndex: 0 })[0]!.material.layers
    expect(sampled.decal?.uvOffset?.value[0]).toBeCloseTo(-0.1, 6)
    expect(sampled.decal?.uvOffset?.value[1]).toBeCloseTo(-0.2, 6)
    expect(sampled.decal).toMatchObject({ wrapX: true, wrapY: true })
    const a = 0x4000 / 0x7fff
    for (const time of [0, 0.5, 0.75]) {
      // The UVM frame preparer supplies sceneLighting=true; the legacy viewer adds its ambient.
      const program = programs.sample({ time, sequenceTime: 0.25, sequenceIndex: 0 }, { sceneLighting: true })[0]!
      const rgba = program.shade({ texels: { decal: [0.2, 0.5, 0.8, 0.4], alpha1: [0.2, 0.5, 0.8, 0.4] } }).rgba
      expect(rgba[0]).toBeCloseTo(0.2 * (0.5 + time * 0.5), 6)
      expect(rgba[1]).toBeCloseTo(0.5 * (0.4 + time * 0.4), 6)
      expect(rgba[2]).toBeCloseTo(0.8 * (0.25 + time * 0.25), 6)
      expect(rgba[3]).toBeCloseTo(0.4 * (a + 0.25 * (1 - a)) * (a + time * (1 - a)), 6)
    }
    const session = await open(bundle.model, new Map([
      [`filedataid/${String(SKIN_FILE_ID)}`, bundle.skin], [`filedataid/${String(ANIM_FILE_ID)}`, bundle.anim],
    ]))
    try {
      const exported = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
      if (exported.state !== 'ok' || exported.output.kind !== 'bytes') throw new Error('material UVM export failed')
      const bytes = exported.output.value as Uint8Array
      const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)
      const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)))
      const targets = document.extensions.UV_game_animation_clips.materialTargets
      expect(targets[0].properties.map((item: { path: string }) => item.path)).toContain('/renderModel/standard/layers/diffuse/constantColor')
      expect(targets[0].properties.map((item: { path: string }) => item.path)).toContain('/renderModel/standard/layers/decal/uvOffset')
      const encodedMaterial = document.materials[0].extensions.UV_game_material
      expect(encodedMaterial.shader).toBe('modkit.render-material.v1')
      const reopened = createStandardMaterialPrograms(encodedMaterial.params, { budget })
      const actual = reopened.sample({ time: 0.5, sequenceTime: 0.25, sequenceIndex: 0 }, { sceneLighting: true })[0]!
        .shade({ texels: { decal: [0.2, 0.5, 0.8, 0.4], alpha1: [0.2, 0.5, 0.8, 0.4] } }).rgba
      expect(actual[0]).toBeCloseTo(0.15, 6)
      expect(actual[3]).toBeCloseTo(0.4 * (a + 0.25 * (1 - a)) * (a + 0.5 * (1 - a)), 6)
    } finally { await session.dispose() }
  })

  it('honours weight-suppression and refuses unsupported UV rotation profiles', () => {
    const bundle = fixtureMaterialBundle(0x40)
    const model = reader.readM2(bundle.model, { maxRecords: 1000, animBuffers: new Map([[1, reader.animPayload(bundle.anim, 1000)!]]) })
    const skin = reader.readSkin(bundle.skin, 1000)
    const material = buildM2Scene(model, skin).materials[0]!
    const programs = createStandardMaterialPrograms(material.shader!.parameters,
      { budget: { maxBytes: 1_000_000, maxNodes: 100_000, maxDepth: 64 } })
    const pixel = programs.sample({ time: 0.5, sequenceTime: 0, sequenceIndex: 0 }, { sceneLighting: true })[0]!.shade({
      texels: { decal: [1, 1, 1, 0.4], alpha1: [1, 1, 1, 0.4] },
    }).rgba
    expect(pixel[3]).toBeCloseTo(0.4 * (0x4000 / 0x7fff), 6)
    const rotated = { ...model, textureTransforms: model.textureTransforms.map(transform => ({ ...transform,
      rotation: { ...transform.rotation, perSequence: [{ times: [0], values: [[0, 0, 1, 0] as const] }] } })) }
    expect(buildM2Scene(rotated, skin).materials[0]?.shader?.id).toBe('blizzard.wow-m2.batch')
  })
})
