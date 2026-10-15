import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  Codec,
  ModelAnimationClip,
  ModelBoneBinding,
  ModelMaterialRef,
  ModelMesh,
  ModelNode,
  ModelPrimitive,
} from '@modkit/sdk'
import { readUvmContainer, type UvmContainer } from '@modkit/uv/model/container'
import { authoredModelBytes, context, extension, input, open, source } from './war3-harness.js'
import { layeredModelBytes } from './war3-layered-model.js'

/**
 * Warcraft III -> StarCraft II through the one common document: the codec's UVM goes through the
 * M3 exporter, and the M3 comes back through the M3 codec. The models are z-up on both sides, so
 * every vertex and every attachment must land where the Warcraft III model had it — the rig
 * authoring in @modkit/scene bakes the source coordinate frame, the M3 exporter binds a socket
 * that is a joint to that joint's bone.
 */
const containerBudget = {
  maxInputBytes: 1_000_000_000,
  maxJsonBytes: 200_000_000,
  maxDepth: 128,
  maxNodes: 4_000_000,
}
const budget = {
  maxInputBytes: 1_000_000_000n,
  maxDepth: 128,
  maxNodes: 4_000_000,
  maxScalarBytes: 200_000_000,
  maxDiagnostics: 1000,
}
const models = join(extension, '..', 'models')
const { exportM3FromUvm } = (await import(
  pathToFileURL(join(models, 'dist', 'm3', 'uvm', 'converter.js')).href
)) as {
  exportM3FromUvm(container: UvmContainer, budget: typeof containerBudget): Promise<Uint8Array>
}
const m3 = (await import(pathToFileURL(join(models, 'src', 'm3', 'codec.js')).href)) as {
  createCodec(context: unknown): Codec
}
/** A real Warcraft III model: two attachment points and one collision sphere. */
const SMILEY = join(
  extension,
  '../../references/mdx-m3-viewer/clients/example/resources/SmileyGW_004.mdx',
)

type Document = {
  nodes: { name?: string; translation?: number[]; extensions?: Record<string, unknown> }[]
  meshes: { primitives: { attributes: { POSITION: number } }[] }[]
  accessors: { min: number[]; max: number[] }[]
}

async function exportUvm(session: Awaited<ReturnType<typeof open>>): Promise<Uint8Array> {
  const result = await session
    .operations()
    .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
  if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error('UVM export failed')
  return result.output.value as Uint8Array
}

/** Warcraft III bytes -> M3 bytes -> the M3 codec's own UVM of them. */
async function throughM3(mdx: Uint8Array) {
  const war3 = await open(mdx, budget)
  const uvm = await exportUvm(war3)
  await war3.dispose()
  const bytes = await exportM3FromUvm(readUvmContainer(uvm, containerBudget), containerBudget)
  const session = await m3.createCodec(context).open(input(source(bytes)), 'inspect', budget)
  try {
    return {
      bytes,
      document: readUvmContainer(await exportUvm(session), containerBudget).document as Document,
    }
  } finally {
    await session.dispose()
  }
}

const positions = (document: Document) =>
  document.accessors[document.meshes[0]!.primitives[0]!.attributes.POSITION]!

type Session = Awaited<ReturnType<typeof open>>
type Quaternion = readonly [number, number, number, number]
interface Camera {
  readonly rotation: Quaternion
  readonly position: readonly [number, number, number]
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const unit = (value: Quaternion): Quaternion => {
  const length = Math.hypot(...value)
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length]
}
const maxDifference = (left: readonly number[], right: readonly number[]) =>
  Math.max(...left.map((value, index) => Math.abs(value - (right[index] ?? Infinity))))
function expectClose(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length)
  expect(maxDifference(actual, expected)).toBeLessThan(1e-3)
}

async function items<T>(session: Session, contract: string, method: string): Promise<readonly T[]> {
  const lease = await session.dataSource(contract, 1)
  try {
    const value = lease.value as Record<string, (request: { limit: number }) => Promise<{ items: readonly T[] }>>
    return (await value[method]!({ limit: 256 })).items
  } finally {
    await lease.release()
  }
}

/** The first draw's vertices in world space: rest pose, turned toward `camera` by the shared sampler. */
async function drawnWorld(session: Session, camera: Camera): Promise<readonly number[]> {
  const nodes = await items<ModelNode>(session, 'common.view/model-scene-source', 'nodes')
  const meshes = await items<ModelMesh>(session, 'common.view/model-scene-source', 'meshes')
  const skeleton = await items<ModelBoneBinding>(session, 'common.view/model-skeleton-source', 'bindings')
  const lease = await session.dataSource('common.view/model-scene-source', 1)
  try {
    const scene = lease.value as {
      primitive(id: string, request: { maxBytes: number }): Promise<ModelPrimitive>
    }
    const primitives = await Promise.all(
      meshes.flatMap(mesh => mesh.primitiveIds).map(id => scene.primitive(id, { maxBytes: 1 << 20 })),
    )
    // The camera handed to each sample arrived with the scene sampler of core link mode.
    const { createModelSceneSampler } = (await import('@modkit/scene/model')) as unknown as {
      createModelSceneSampler(
        projection: unknown,
        options: { billboardCameraPerSample: boolean },
      ): {
        sample(
          time: number,
          signal: undefined,
          camera: Camera,
        ): { primitives: readonly { positions: ArrayLike<number>; transform?: ArrayLike<number> }[] }
      }
    }
    const drawn = createModelSceneSampler(
      { nodes, meshes, primitives, skeleton },
      { billboardCameraPerSample: true },
    ).sample(0, undefined, camera).primitives[0]!
    const frame = drawn.transform ?? IDENTITY
    const world: number[] = []
    for (let offset = 0; offset < drawn.positions.length; offset += 3) {
      const [x, y, z] = [0, 1, 2].map(axis => drawn.positions[offset + axis]!) as [number, number, number]
      for (let row = 0; row < 3; row++)
        world.push(frame[row]! * x + frame[4 + row]! * y + frame[8 + row]! * z + frame[12 + row]!)
    }
    return world
  } finally {
    await lease.release()
  }
}

describe('Warcraft III to M3', () => {
  it('keeps every vertex of a skinned model where Warcraft III had it', async () => {
    const { document } = await throughM3((await authoredModelBytes()).mdx)
    // The authored triangle, in the native z-up axes both formats share.
    expect(positions(document).min).toEqual([0, 0, 0])
    expect(positions(document).max).toEqual([1, 1, 0])
  })

  it.skipIf(!existsSync(SMILEY))(
    'keeps the attachments on their bones and writes the collision sphere as a hit test',
    async () => {
      const { bytes, document } = await throughM3(new Uint8Array(readFileSync(SMILEY)))
      expect(positions(document).min).toEqual([-48, -48, 0])
      expect(positions(document).max).toEqual([48, 48, 96])
      const sockets = document.nodes
        .filter(node => node.extensions?.['UV_game_socket'] !== undefined)
        .map(node => node.name)
      expect(sockets.sort()).toEqual(['Origin Ref', 'Overhead Ref'])
      // The attachment is a bone: its native translation is the point Warcraft III declared.
      const overhead = document.nodes.find(
        node => node.name === 'Overhead Ref' && node.translation !== undefined,
      )
      expect(overhead?.translation).toEqual([0, 0, 150])
      // M3 stores chunk tags reversed; SSGS is the hit-test volume list.
      expect(Buffer.from(bytes).toString('latin1')).toContain('SGSS')
      // And it reads back as the same volume: the sphere Warcraft III declared, 96 wide, 48 up.
      const hits = document.nodes.flatMap(node => {
        const collision = node.extensions?.['UV_game_collision'] as
          | { role: string; shapes: { kind: string; radius?: number; matrix?: number[] }[] }
          | undefined
        return collision?.role === 'hit' ? collision.shapes : []
      })
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ kind: 'sphere', radius: 96 })
      expect(hits[0]!.matrix?.slice(12, 15)).toEqual([0, 0, 48])
    },
  )

  it(
    'writes blended and additive layers, toggles by a bone the geoset its animation hides, and keeps the billboard facing',
    async () => {
      const mdx = await layeredModelBytes()
      const { bytes } = await throughM3(mdx)
      // The hidden geoset is the third draw: its bone is named after it, as Blizzard names Batch_ bones.
      expect(Buffer.from(bytes).toString('latin1')).toContain('Batch_Visibility_2')
      const war3 = await open(mdx, budget)
      const session = await m3.createCodec(context).open(input(source(bytes)), 'inspect', budget)
      try {
        const clips = await items<ModelAnimationClip>(session, 'common.view/model-animation-source', 'clips')
        const visibility = (name: string) =>
          clips
            .find(clip => clip.name === name)
            ?.channels.filter(channel => channel.kind === 'visibility')
            .map(channel => [channel.target, [...new Set(channel.samples.map(sample => sample.value[0]))]])
        // Hidden through Stand, shown in Death, as the geoset animation keys it.
        expect(visibility('Stand')).toEqual([['mesh-0-primitive-2', [0]]])
        expect(visibility('Death')).toEqual([['mesh-0-primitive-2', [1]]])
        const materials = await items<ModelMaterialRef>(session, 'common.view/model-material-source', 'materials')
        expect(materials.map(material => material.blendMode)).toEqual(['opaque', 'blend', 'add-alpha'])

        // The whole model hangs on one billboarded bone. Seen by the same camera, the M3 draws where
        // Warcraft III drew: StarCraft II's basis differs, and the bone's own rotation takes the
        // difference.
        const cameras = [
          { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const, position: [5, 0, 0] as const },
          { rotation: unit([0.2, 0.5, -0.1, 0.84]), position: [3, 2, 5] as const },
        ]
        const drawn = await Promise.all(
          cameras.map(async camera => [await drawnWorld(war3, camera), await drawnWorld(session, camera)] as const),
        )
        for (const [expected, actual] of drawn) expectClose(actual, expected)
        // Not a still model: the two cameras turn it differently.
        expect(maxDifference(drawn[0]![0], drawn[1]![0])).toBeGreaterThan(0.1)
      } finally {
        await session.dispose()
        await war3.dispose()
      }
    },
  )
})
