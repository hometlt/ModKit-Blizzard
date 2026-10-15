import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'

import { decodeM3Animations } from '../src/m3/animation.node.js'
import { decodeM3Geometry } from '../src/m3/geometry.node.js'
import { decodeM3Materials } from '../src/m3/material.node.js'
import { decodeM3Skeleton } from '../src/m3/skeleton.node.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { encodeM3RenderModel, rememberM3SourceBytes } from '../dist/m3/native/encoder.js'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'
import { createProvider, encodeM3SemanticModel, snapshotM3SemanticEdit } from '../src/m3/writer.js'
import { findModkitCoreWorkspace } from './workspace-root.js'

installM3PlatformAdapters({ DOMParser })

const workspaceRoot = findModkitCoreWorkspace(import.meta.dirname)
const trianglePath = join(
  workspaceRoot,
  'packages',
  'testkit',
  'test',
  'fixtures',
  'models',
  'triangle.m3',
)
const m3aPath = join(
  workspaceRoot,
  'packages',
  'testkit',
  'test',
  'fixtures',
  'm3',
  'cybros-cover.m3a.b64',
)
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 16_777_216,
  maxDiagnostics: 100,
}

const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const bufferOf = (bytes: Uint8Array) => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function target() {
  return Object.freeze({
    targetId: 'content',
    subjectUri: 'file:///C:/bounded/model.m3',
    ownerSource: Object.freeze({
      id: 'file:///C:/bounded/model.m3',
      uri: 'file:///C:/bounded/model.m3',
    }),
    semanticPath: Object.freeze([]),
    expectedRevision: Object.freeze({ sourceRevision: 'content-hash.sha256:writer-fixture' }),
  })
}

function writer() {
  return createProvider(
    { contract: 'common.edit/writer', major: 1, offerId: 'm3-native-source' },
    {
      budgets: budget,
      providerIdentity: {
        providerId: 'blizzard/m3-preserving-writer',
        providerVersion: '1.0.0',
        artifactDigest: 'test:m3-writer',
      },
    },
  ).value
}

function track(a: readonly number[], b: readonly number[]) {
  return {
    lineType: 1,
    globalSeqId: null,
    keys: [
      { frame: 0, vector: a },
      { frame: 1, vector: b },
    ],
  }
}

function animatedTriangle() {
  return {
    format: 'gltf',
    meshes: [
      {
        name: 'Triangle',
        materialIndex: 0,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        indices: new Uint16Array([0, 1, 2]),
        boneIndices: new Uint16Array(12),
        boneWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      },
    ],
    skeleton: {
      bones: [
        {
          index: 0,
          name: 'Root',
          parentIndex: -1,
          inverseBindMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        },
      ],
    },
    materials: [
      {
        name: 'Hull',
        layers: [{ label: 'diffuse', path: 'Assets/Hull.dds' }],
        standard: {
          layers: {
            diffuse: {
              slot: 'diffuse',
              texturePath: 'Assets/Hull.dds',
              uvSource: 0,
              channels: 1,
              op: 0,
              teamColorMode: 0,
              invert: false,
              clampResult: false,
              wrapX: true,
              wrapY: true,
            },
          },
          blendMode: 0,
          priority: 0,
          specularity: 16,
          specMult: 1,
          emisMult: 1,
          specMode: 0,
          alphaTestThreshold: 0,
          twoSided: false,
          unshaded: false,
          doubleLambert: false,
          clampOutput: false,
          usesVertexColor: false,
          usesVertexAlpha: false,
        },
      },
    ],
    animations: [
      {
        name: 'Walk',
        durationSeconds: 1,
        looping: true,
        nodeTracks: [
          {
            boneIndex: 0,
            translation: track([0, 0, 0], [1, 0, 0]),
            rotation: track([0, 0, 0, 1], [0, 0, 0.7071068, 0.7071068]),
            scale: track([1, 1, 1], [2, 2, 2]),
          },
        ],
      },
    ],
    bounds: null,
    effects: { particles: [], ribbons: [] },
    metadata: { coordinateSystem: 'Y_UP', m3ModelFlags: 0x80d53 },
  }
}

describe('M3/M3A native writer', () => {
  it('ports the complete legacy semantic encoder without a Modkit runtime dependency', async () => {
    const encoded = await encodeM3SemanticModel(
      animatedTriangle(),
      { fileName: 'Triangle.m3', includeTextures: false },
      budget,
    )
    expect(new TextDecoder('ascii').decode(encoded.bytes.subarray(0, 4))).toBe('43DM')
    expect(
      encoded.issues.filter((item: { severity: string }) => item.severity === 'error'),
    ).toEqual([])

    const [geometry, skeleton, animation, material] = await Promise.all([
      decodeM3Geometry(encoded.bytes, budget),
      decodeM3Skeleton(encoded.bytes, budget),
      decodeM3Animations(encoded.bytes, budget),
      decodeM3Materials(encoded.bytes, budget, undefined, ['Assets/Hull.dds']),
    ])
    const primitive = geometry.primitives[0]
    if (primitive === undefined) throw new TypeError('encoded M3 has no primitive')
    expect([...primitive.indices]).toEqual([0, 1, 2])
    expect(skeleton.bindings[0]).toMatchObject({ boneName: 'Root' })
    expect(animation.clips[0]).toMatchObject({ name: 'Walk' })
    expect(material.materials[0]).toMatchObject({ name: 'Hull' })
    expect(material.linkedLayers).toBe(1)
  })

  it('retains the legacy scene, effects, collision and physics authoring families', async () => {
    const source = animatedTriangle()
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    source.effects = {
      particles: [
        {
          name: 'Dust',
          boneIndex: 0,
          materialIndex: 0,
          emissionRate: 12,
          lifeSpan: 2,
          speed: 3,
          gravity: -1,
          maxParticles: 64,
          emitShape: 'sphere',
          emitShapeRadius: 2,
          emitShapeSize: [2, 2, 2],
          orientationMode: 'billboard',
        },
      ],
      ribbons: [
        {
          name: 'Trail',
          boneIndex: 0,
          materialIndex: 0,
          lifeSpan: 1,
          speed: 1,
          widths: [1, 0.5, 0],
          ribbonType: 'billboard',
        },
      ],
      forces: [
        {
          name: 'Wind',
          boneIndex: 0,
          type: 'wind',
          shape: 'box',
          channels: 1,
          strength: 2,
          width: 3,
          height: 4,
          length: 5,
        },
      ],
      warps: [
        {
          name: 'Warp',
          boneIndex: 0,
          warpType: 0,
          radius: 4,
          height: 2,
          strength: 1,
          angular: 0.5,
          axial: 0.25,
          radial: 0.75,
        },
      ],
      projectors: [
        {
          name: 'Projector',
          boneIndex: 0,
          materialIndex: 0,
          projectionType: 'perspective',
          offset: [0, 0, 1],
          pitch: 0,
          yaw: 0,
          roll: 0,
          fieldOfView: 0.7,
          aspectRatio: 1,
          near: 0.1,
          far: 25,
          boxOffsetZBottom: -1,
          boxOffsetZTop: 1,
          boxOffsetXLeft: -1,
          boxOffsetXRight: 1,
          boxOffsetYFront: 1,
          boxOffsetYBack: -1,
          falloff: 1,
          alphaInit: 0,
          alphaMid: 1,
          alphaEnd: 0,
          attenuationDistance: 20,
          active: 1,
          layer: 0,
          flags: 0,
        },
      ],
    }
    source.collisionShapes = [{ kind: 'box', boneIndex: 0, matrix: identity, size: [2, 3, 4] }]
    source.metadata = {
      ...source.metadata,
      m3AttachmentPoints: [{ name: 'Ref_Target', boneIndex: 0 }],
      m3Lights: [
        {
          name: 'Light',
          type: 1,
          boneIndex: 0,
          flags: 1,
          color: [1, 0.8, 0.6],
          intensity: 2,
          specularColor: [1, 1, 1],
          specularIntensity: 1,
          decay: 2,
          attenuationNear: 1,
          attenuationFar: 20,
          hotspot: 0.2,
          falloff: 0.5,
        },
      ],
      m3Cameras: [
        {
          name: 'Portrait',
          boneIndex: 0,
          fieldOfView: 0.6,
          farClip: 100,
          nearClip: 0.1,
          shadowClipDistance: 10,
          focusDistance: 2,
          farFocusRange: 1,
          nearFocusRange: 1,
          depthOfField: 0.5,
          useVerticalFov: true,
        },
      ],
      m3HitVolumes: {
        hittests: [{ shape: 0, boneIndex: 0, matrix4: identity, size0: 1, size1: 2, size2: 3 }],
        attachmentVolumes: [
          { shape: 0, boneIndex: 0, matrix4: identity, size0: 1, size1: 2, size2: 3 },
        ],
      },
      m3Billboards: [{ boneIndex: 0, type: 'full' }],
      m3Shadowboxes: [{ matrix4: identity }],
      m3PhysicsConstraints: [
        { dependentIndices: [0], rigidBodyIndex0: 0, rigidBodyIndex1: 0, flags: 0 },
      ],
      m3PhysicsJoints: [{ type: 'hinge', boneIndex0: 0, boneIndex1: 0 }],
      m3PhysicsCloths: [{ boneIndices: [0], stiffness: 0.5 }],
      m3Ik: [{ boneIndex: 0, targetBoneIndex: 0, enabled: true }],
      m3Turrets: [{ name: 'Turret', parts: [{ boneIndex: 0 }] }],
    }
    const encoded = await encodeM3SemanticModel(
      source,
      { fileName: 'Features.m3', includeTextures: false },
      budget,
    )
    const xml = await readFile(
      join(import.meta.dirname, '..', 'src', 'm3', 'native', 'structures.xml'),
      'utf8',
    )
    const sections = await M3SectionList.load(bufferOf(encoded.bytes), xml)
    const tags = new Set(sections.map(item => item.desc.history.name))
    for (const tag of [
      'ATT_',
      'LITE',
      'CAM_',
      'SSGS',
      'ATVL',
      'PAR_',
      'RIB_',
      'PROJ',
      'FOR_',
      'WRP_',
      'BBSC',
      'SHBX',
      'PHRB',
      'PHSH',
      'PHCT',
      'PHYJ',
      'PHCL',
      'IKJT',
      'TRGD',
      'PATU',
    ]) {
      expect(tags, `missing authored section ${tag}`).toContain(tag)
    }
  })

  it('publishes SSGS hit tests to the collision facet and the common scene', async () => {
    const source = animatedTriangle()
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    source.metadata = {
      ...source.metadata,
      m3HitVolumes: {
        hittests: [{ shape: 1, boneIndex: 0, matrix4: identity, size0: 2, size1: 1, size2: 1 }],
        attachmentVolumes: [],
      },
    }
    const encoded = await encodeM3SemanticModel(source, { fileName: 'Hit.m3', includeTextures: false }, budget)
    const { decodeM3Attachments } = await import('../src/m3/runtime/attachments.js')
    const facet = await decodeM3Attachments(encoded.bytes, budget)
    expect(facet.volumes).toContainEqual(expect.objectContaining({ id: 'm3-hittest-0', kind: 'm3-shape-1', types: ['hit'] }))
    const { decodeM3UvmSource } = await import('../src/m3/runtime/geometry.js')
    const decoded = await decodeM3UvmSource(encoded.bytes, budget)
    const { mapM3HitTests } = await import('../dist/m3/uvm/volumes.js')
    expect(mapM3HitTests(decoded.hittests, new Set(['bone/0']))).toEqual([
      {
        id: 'm3-hittest-0',
        kind: 'm3-shape-1',
        origin: 'declared-volume',
        nodeId: 'bone/0',
        role: 'hit',
        shape: { kind: 'sphere', radius: 2, matrix: identity },
      },
    ])
  })

  it('is deterministic, byte-identical for no-op, and reopens scale/sequence/texture edits', async () => {
    const source = await encodeM3SemanticModel(
      animatedTriangle(),
      { fileName: 'Triangle.m3', includeTextures: false },
      budget,
    )
    const provider = writer()
    const noOp = await snapshotM3SemanticEdit({
      sourceBytes: source.bytes,
      target: target(),
      edits: [],
      budget,
    })
    const noOpPlan = await provider.plan(noOp)
    expect(noOpPlan.edits[0].payload.bytes).toEqual(source.bytes)

    const change = await snapshotM3SemanticEdit({
      sourceBytes: source.bytes,
      target: target(),
      edits: [
        { kind: 'scale-model-v1', factor: 2 },
        { kind: 'rename-sequence-v1', index: 0, name: 'Run' },
        {
          kind: 'rename-texture-v1',
          oldPath: 'Assets/Hull.dds',
          newPath: 'Assets/Textures/Hull_Diffuse_Long.dds',
        },
      ],
      budget,
    })
    expect(await provider.validate(change)).toEqual({ valid: true, diagnostics: [] })
    const [first, second] = await Promise.all([provider.plan(change), provider.plan(change)])
    expect(first.edits[0].payload.bytes).toEqual(second.edits[0].payload.bytes)
    const bytes = first.edits[0].payload.bytes
    const [geometry, animation, material] = await Promise.all([
      decodeM3Geometry(bytes, budget),
      decodeM3Animations(bytes, budget),
      decodeM3Materials(bytes, budget, undefined, ['Assets/Textures/Hull_Diffuse_Long.dds']),
    ])
    const primitive = geometry.primitives[0]
    if (primitive === undefined) throw new TypeError('edited M3 has no primitive')
    expect([...primitive.positions].map(value => Math.abs(value))).toEqual([
      0, 0, 0, 2, 0, 0, 0, 0, 2,
    ])
    expect(animation.clips[0]).toMatchObject({ name: 'Run' })
    expect(material.linkedLayers).toBe(1)
    expect(first.fidelity).toMatchObject({ roundTrip: 'semantic', preservesUnknownData: true })
  })

  it('preserves all original M3A sections and reopens a sequence rename', async () => {
    const source = Buffer.from(await readFile(m3aPath, 'utf8'), 'base64')
    expect(digest(source)).toBe(
      'sha256:07a632fb165b98e60b0e6803451e92c7d94ec527cae8252ca6ed2a3a0661b9e5',
    )
    const xml = await readFile(
      join(import.meta.dirname, '..', 'src', 'm3', 'native', 'structures.xml'),
      'utf8',
    )
    const before = await M3SectionList.load(bufferOf(source), xml)
    const decoded = await decodeM3Animations(source, budget)
    expect(decoded.clips.length).toBeGreaterThan(0)
    const change = await snapshotM3SemanticEdit({
      sourceBytes: source,
      target: target(),
      edits: [{ kind: 'rename-sequence-v1', index: 0, name: 'GA M3A' }],
      budget,
    })
    const plan = await writer().plan(change)
    const bytes = plan.edits[0].payload.bytes
    const after = await M3SectionList.load(bufferOf(bytes), xml)
    expect(after.slice(0, before.length).map(item => item.desc.history.name)).toEqual(
      before.map(item => item.desc.history.name),
    )
    expect((await decodeM3Animations(bytes, budget)).clips[0]).toMatchObject({ name: 'GA M3A' })
  })

  it('retains the old preserving API and fails closed on bounds, paths and cancellation', async () => {
    const triangle = new Uint8Array(await readFile(trianglePath))
    expect(digest(triangle)).toBe(
      'sha256:d34480c1b726c37bfeea9dd75fc71a13ca7e47d6ff15b2d66487c6a4b3369de7',
    )
    const model = { materials: [] }
    rememberM3SourceBytes(model, triangle)
    const noOp = await encodeM3RenderModel(
      model,
      { includeTextures: false },
      {
        structuresXml: await readFile(
          join(import.meta.dirname, '..', 'src', 'm3', 'native', 'structures.xml'),
          'utf8',
        ),
      },
    )
    expect(noOp.bytes).toEqual(triangle)

    await expect(
      snapshotM3SemanticEdit({
        sourceBytes: triangle,
        target: target(),
        edits: [{ kind: 'rename-texture-v1', oldPath: 'Assets/a.dds', newPath: '../escape.dds' }],
        budget,
      }),
    ).rejects.toThrow(/relative asset path|normalized/u)
    await expect(
      snapshotM3SemanticEdit({
        sourceBytes: triangle,
        target: target(),
        edits: [],
        budget: { ...budget, maxInputBytes: 1n },
      }),
    ).rejects.toThrow(/maxInputBytes/u)
    const controller = new AbortController()
    controller.abort()
    await expect(
      snapshotM3SemanticEdit({
        sourceBytes: triangle,
        target: target(),
        edits: [],
        budget,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
