import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import type {
  AssetSession,
  JsonObject,
  ModelAnimationClip,
  ModelAnimationSource,
  ModelSceneSource,
  ModelSkeletonSource,
  ResourceBudget,
  RevisionId,
} from '@modkit/sdk'
import { drainModelProjection } from '@modkit/testkit'
import { readUvmContainer } from '@modkit/uv/model/container'
import { createModelSceneSampler } from '@modkit/scene/model'
import { openUvmDocument } from '@modkit/scene/uvm'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { renderConversionProof } from './uvm-conversion-render.js'

const frame = [2, 0, 0, 0, 0, 0, -2, 0, 0, 2, 0, 0, 0, 0, 0, 1]
const times = [0, 1, 53.633]
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('retail M3A session proof value is absent')
  return value
}
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('retail M3A session proof object is absent')
  return value as JsonObject
}
function list(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError('retail M3A session proof array is absent')
  return value.map(object)
}
export async function m3aSessionEvidence(name: string, bytes: Uint8Array | string) {
  const directory = process.env['MODKIT_M3A_UVM_SESSION_EVIDENCE_DIR']
  if (directory === undefined) return
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `m3-uvm-m3a-session-${name}`), bytes, { flag: 'wx' })
}

/** Drain the ordinary session facets; no fixture resolver or companion admission shortcut. */
export async function drainM3aSession(session: AssetSession, budget: ResourceBudget) {
  const sceneLease = await session.dataSource('common.view/model-scene-source', 1)
  try {
    const skeletonLease = await session.dataSource('common.view/model-skeleton-source', 1)
    try {
      const animationLease = await session.dataSource('common.view/model-animation-source', 1)
      try {
        return await drainModelProjection(sceneLease.value as ModelSceneSource, {
          maxBytes: budget.maxScalarBytes,
          skeletonSource: skeletonLease.value as ModelSkeletonSource,
          animationSource: animationLease.value as ModelAnimationSource,
        })
      } finally {
        await animationLease.release()
      }
    } finally {
      await skeletonLease.release()
    }
  } finally {
    await sceneLease.release()
  }
}

// The reference starts from the native facet, whose full tracks are checked against frozen MK2
// in the caller. Only glTF's declared float32 representation is applied to these independent keys.
function gltfPrecision(clip: ModelAnimationClip): ModelAnimationClip {
  return {
    ...clip,
    channels: clip.channels.map(channel => ({
      ...channel,
      ...(channel.samples === undefined
        ? {}
        : {
            samples: channel.samples.map(sample => ({
              ...sample,
              ...(sample.timeSeconds === undefined
                ? {}
                : { timeSeconds: Math.fround(sample.timeSeconds) }),
              value: sample.value.map(Math.fround),
            })),
          }),
    })),
  }
}

export async function verifyRetailM3aUvmSession(options: {
  readonly session: AssetSession
  readonly native: Awaited<ReturnType<typeof drainM3aSession>>
  readonly baseBytes: Uint8Array
  readonly sidecar: {
    readonly logicalId: string
    readonly revision: RevisionId
    readonly bytes: Uint8Array
    readonly clipId: string
  }
  readonly budget: ResourceBudget
}) {
  const { session, native, baseBytes, sidecar, budget } = options
  const sourceHashes = { base: sha256(baseBytes), sidecar: sha256(sidecar.bytes) }
  const containerBudget = {
    ...budget,
    maxInputBytes: Number(budget.maxInputBytes),
    maxJsonBytes: budget.maxScalarBytes,
  }
  const output = await session.operations().invoke('model-export-uvm', {
    schemaVersion: 1,
    metersPerSourceUnit: 2,
  })
  if (output.state !== 'ok' || output.output.kind !== 'bytes')
    throw new Error(`ordinary retail session produced no UVM: ${JSON.stringify(output)}`)
  await m3aSessionEvidence('zeratul.uvm.glb', output.output.value)
  const document = openUvmDocument(output.output.value, { budget: containerBudget })
  try {
    const serialized = document.serialize(0)
    const container = readUvmContainer(serialized, containerBudget)
    const envelope = object(object(container.document['extras'])['BlizzardM3'])
    const mapping = object(envelope['mapping'])
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      format: 'm3',
      profile: 'portable-scene-v1',
    })
    expect(envelope['source']).toBeUndefined()
    expect(envelope['metadata']).toBeUndefined()
    expect(mapping['animationSidecars']).toBeUndefined()
    const extensions = object(container.document['extensions'])
    expect(extensions['UV_source_blob']).toBeUndefined()
    expect(container.document['extensionsUsed']).not.toContain('UV_source_blob')
    const directClips = (native.animations ?? []).filter(clip => clip.provenance === 'direct')
    const animations =
      container.document['animations'] === undefined ? [] : list(container.document['animations'])
    expect(animations).toHaveLength(directClips.length)
    // The materializer's frame nodes carry it; the residual names only the units.
    expect(object(mapping['frame'])).toEqual({ metersPerSourceUnit: 2, dataCoordinates: 'm3-native' })
    const { scene, rig } = readUvmModel(container.document, container.binary, budget)
    expect(rig.clips).toHaveLength(directClips.length)
    const before = createModelSceneSampler(
      {
        ...native,
        nodes: native.nodes ?? [],
        meshes: native.meshes ?? [],
        primitives: native.primitives ?? [],
      },
      { maxBytes: budget.maxScalarBytes },
    )
    const after = createModelSceneSampler(
      { ...scene, skeleton: rig.bindings },
      { maxBytes: budget.maxScalarBytes },
    )
    const skeleton = required(native.skeleton)
    expect(skeleton).toHaveLength(134)
    const reference = before.sample(0),
      actual = after.sample(0)
      expect(actual.primitives.length).toBeGreaterThan(0)
      expect(actual.primitives).toHaveLength(reference.primitives.length)
      expect(actual.diagnostics.map(item => item.code)).not.toContain(
        'common.model/skin-unavailable',
      )
      expect(actual.diagnostics.map(item => item.code)).not.toContain(
        'common.model/pose-unavailable',
      )
      for (const bone of skeleton) {
        const nodeId = required(bone.nodeId)
        const expectedMatrix = required(reference.nodeTransforms.get(nodeId))
        const convertedNodeId = required(
          rig.bindings.find(binding => binding.boneIndex === bone.boneIndex)?.nodeId,
        )
        const actualMatrix = required(actual.nodeTransforms.get(convertedNodeId))
        for (let column = 0; column < 4; column++) {
          const offset = column * 4
          // Analytic C × native world, allowing only the immaterial sign of zero to differ.
          expect(actualMatrix[offset]).toBeCloseTo(2 * required(expectedMatrix[offset]), 5)
          expect(actualMatrix[offset + 1]).toBeCloseTo(
            2 * required(expectedMatrix[offset + 2]),
            5,
          )
          expect(actualMatrix[offset + 2]).toBeCloseTo(
            -2 * required(expectedMatrix[offset + 1]),
            5,
          )
          expect(actualMatrix[offset + 3]).toBeCloseTo(required(expectedMatrix[offset + 3]), 5)
        }
      }
      const positionsHash = createHash('sha256')
      for (const [primitiveIndex, primitive] of actual.primitives.entries()) {
        expect(primitive.positions).toEqual(
          required(reference.primitives[primitiveIndex]).positions,
        )
        // The +z-up turn is a rotation node: its quaternion leaves float dust where the axes swap.
        frame.forEach((value, index) => expect(primitive.transform?.[index]).toBeCloseTo(value, 9))
        positionsHash.update(
          new Uint8Array(
            primitive.positions.buffer,
            primitive.positions.byteOffset,
            primitive.positions.byteLength,
          ),
        )
      }
      const rendered = await renderConversionProof(reference.primitives, actual.primitives, frame)
      await m3aSessionEvidence('zeratul-static.png', rendered.png)
      const frameProof = {
        time: 0,
        bones: skeleton.length,
        primitives: actual.primitives.length,
        positionsSha256: positionsHash.digest('hex'),
        rgbaSha256: sha256(rendered.frame.rgba),
        statistics: rendered.frame.statistics,
        exactNativeFloat32Deformation: true,
        exactBasisMappedWorldBones: true,
        exactNeutralPixels: true,
      }
    expect(sha256(baseBytes)).toBe(sourceHashes.base)
    expect(sha256(sidecar.bytes)).toBe(sourceHashes.sidecar)
    await m3aSessionEvidence(
      'zeratul-proof.json',
      JSON.stringify(
        {
          scope:
            'ordinary retail M3 open, admitted M3A, UVM reopen and shared scene playback; neutral untextured geometry proof',
          sourceHashes,
          uvmSha256: sha256(output.output.value),
          serializedSha256: sha256(serialized),
          companionKeptSeparate: {
            logicalId: sidecar.logicalId,
            revision: sidecar.revision,
            sha256: sourceHashes.sidecar,
          },
          baseClips: (native.animations ?? [])
            .filter(clip => clip.provenance === 'direct')
            .map(clip => ({
              id: clip.id,
              name: clip.name,
              kind: clip.kind,
              channels: clip.channels.length,
            })),
          frame,
          frameProof,
          sourceFree: true,
          companionEmbedded: false,
        },
        null,
        2,
      ),
    )
  } finally {
    document.dispose()
  }
}

/** Standalone M3A uses a source-free animation-only UVM document. */
export async function verifyRetailStandaloneM3aUvm(options: {
  readonly session: AssetSession
  readonly sourceBytes: Uint8Array
  readonly budget: ResourceBudget
}) {
  const { session, sourceBytes, budget } = options
  const sourceHash = sha256(sourceBytes)
  const native = await drainM3aSession(session, budget)
  expect(native.info).toMatchObject({ meshes: 0, primitives: 0, materials: 0, textures: 0 })
  expect(native.meshes).toEqual([])
  expect(native.primitives ?? []).toEqual([])
  expect(native.nodes?.every(node => node.meshIds.length === 0)).toBe(true)
  const nativeClip = required(native.animations?.[0])
  expect(native.animations).toHaveLength(1)
  expect(nativeClip.channels).toHaveLength(528)
  expect(nativeClip.unsupportedChannels ?? 0).toBe(0)
  const containerBudget = {
    ...budget,
    maxInputBytes: Number(budget.maxInputBytes),
    maxJsonBytes: budget.maxScalarBytes,
  }
  const output = await session.operations().invoke('model-export-uvm', {
    schemaVersion: 1,
    metersPerSourceUnit: 2,
  })
  if (output.state !== 'ok' || output.output.kind !== 'bytes')
    throw new Error(`standalone retail M3A produced no UVM: ${JSON.stringify(output)}`)
  await m3aSessionEvidence('standalone-zeratul.uvm.glb', output.output.value)
  const document = openUvmDocument(output.output.value, { budget: containerBudget })
  try {
    const serialized = document.serialize(0),
      container = readUvmContainer(serialized, containerBudget)
    const envelope = object(object(container.document['extras'])['BlizzardM3'])
    const mapping = object(envelope['mapping'])
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      format: 'm3a',
      profile: 'portable-animation-v1',
    })
    expect(mapping['animationSidecars']).toBeUndefined()
    expect(envelope['source']).toBeUndefined()
    expect(envelope['metadata']).toBeUndefined()
    const residual = object(envelope['residual'])
    const animationEvents = list(residual['animationEvents'])
    expect(animationEvents).toHaveLength(1)
    const eventValues = animationEvents.flatMap(event => list(event['events']))
    expect(eventValues).toHaveLength(8)
    expect(
      eventValues.every(event => event['version'] === 1 && event['dataParam1'] === 0),
    ).toBe(true)
    const extensions = object(container.document['extensions'])
    const provenance = object(extensions['UV_provenance'])
    expect(object(provenance['source'])['format']).toBe('m3a')
    expect(extensions['UV_source_blob']).toBeUndefined()
    expect(container.document['extensionsUsed']).not.toContain('UV_source_blob')
    for (const key of ['meshes', 'materials', 'textures', 'images'])
      expect(container.document[key] ?? []).toEqual([])
    const { scene, rig } = readUvmModel(container.document, container.binary, budget)
    expect(scene.meshes).toEqual([])
    expect(scene.primitives).toEqual([])
    expect(rig.clips).toHaveLength(1)
    const convertedClip = required(rig.clips[0])
    expect(convertedClip.channels).toHaveLength(528)
    const before = createModelSceneSampler(
      {
        ...native,
        nodes: native.nodes ?? [],
        meshes: [],
        primitives: [],
      },
      { maxBytes: budget.maxScalarBytes, clip: gltfPrecision(nativeClip) },
    )
    const after = createModelSceneSampler(
      { ...scene, skeleton: rig.bindings },
      {
        maxBytes: budget.maxScalarBytes,
        clip: convertedClip,
      },
    )
    const skeleton = required(native.skeleton)
    expect(skeleton).toHaveLength(134)
    const poses = []
    for (const time of times) {
      const reference = before.sample(time),
        actual = after.sample(time)
      expect(actual.primitives).toEqual([])
      const worlds = []
      for (const bone of skeleton) {
        const nodeId = required(bone.nodeId)
        const expectedMatrix = required(reference.nodeTransforms.get(nodeId))
        const convertedNodeId = required(
          rig.bindings.find(binding => binding.boneIndex === bone.boneIndex)?.nodeId,
        )
        const actualMatrix = required(actual.nodeTransforms.get(convertedNodeId))
        for (let column = 0; column < 4; column++) {
          const offset = column * 4
          expect(actualMatrix[offset]).toBeCloseTo(2 * required(expectedMatrix[offset]), 5)
          expect(actualMatrix[offset + 1]).toBeCloseTo(
            2 * required(expectedMatrix[offset + 2]),
            5,
          )
          expect(actualMatrix[offset + 2]).toBeCloseTo(
            -2 * required(expectedMatrix[offset + 1]),
            5,
          )
          expect(actualMatrix[offset + 3]).toBeCloseTo(required(expectedMatrix[offset + 3]), 5)
        }
        worlds.push(Array.from(actualMatrix))
      }
      poses.push({
        time,
        bones: worlds.length,
        worldsSha256: sha256(new TextEncoder().encode(JSON.stringify(worlds))),
      })
    }
    expect(new Set(poses.map(pose => pose.worldsSha256)).size).toBe(times.length)
    expect(sha256(sourceBytes)).toBe(sourceHash)
    await m3aSessionEvidence(
      'standalone-zeratul-proof.json',
      JSON.stringify(
        {
          scope:
            'ordinary standalone M3A through product CASC, source-free UVM and shared scene bone playback',
          sourceHash,
          uvmSha256: sha256(output.output.value),
          serializedSha256: sha256(serialized),
          assetKind: 'm3a-animation-bundle',
          channels: convertedClip.channels.length,
          unsupportedChannels: nativeClip.unsupportedChannels,
          poses,
          eventTracks: animationEvents.length,
          events: eventValues.length,
          sourceFree: true,
          activeGeometryAndMaterialsAbsent: true,
          exactBasisMappedWorldBones: true,
        },
        null,
        2,
      ),
    )
  } finally {
    document.dispose()
  }
}
