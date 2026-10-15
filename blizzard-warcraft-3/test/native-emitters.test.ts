import { describe, expect, it } from 'vitest'
import { writeUvmContainer } from '@modkit/uv/model/container'
import { exportWar3FromUvm } from '../dist/war3-mdx/native-encoder.js'

const budget = {
  maxInputBytes: 10 ** 9,
  maxJsonBytes: 2 * 10 ** 8,
  maxDepth: 128,
  maxNodes: 1_000_000,
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * A triangle with whatever emitters the caller hands it.
 *
 * The emitters are written in the vocabulary `UV_game_effects` uses, which is what a StarCraft II
 * or Warcraft III codec publishes; the point of the test is that the writer reads that vocabulary
 * rather than only its own format residual.
 */
function uvmWithEffects(effects?: Record<string, unknown>): Uint8Array {
  const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0)
  const uvs = Float32Array.of(0, 0, 1, 0, 0, 1)
  const indices = Uint32Array.of(0, 1, 2)
  const parts = [positions, uvs, indices]
  const binary = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = []
  let offset = 0
  for (const part of parts) {
    binary.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset)
    views.push({ buffer: 0, byteOffset: offset, byteLength: part.byteLength })
    offset += part.byteLength
  }
  return writeUvmContainer({
    format: 'glb',
    extraChunks: [],
    binary,
    document: {
      asset: {
        version: '2.0',
        generator: 'modkit/uvm-materializer/1.0.0',
        extras: { uv: { format: 'UVM', version: '1.0', profile: 'core' } },
      },
      extensionsUsed: ['UV_asset', 'UV_units', ...(effects === undefined ? [] : ['UV_game_effects'])],
      extensions: {
        UV_asset: { id: 'emitter-fixture', class: 'prop', coreRenderable: true },
        UV_units: { sourceUnit: 'metre', metersPerSourceUnit: 1 },
        ...(effects === undefined ? {} : { UV_game_effects: effects }),
      },
      scene: 0,
      scenes: [{ nodes: [1] }],
      nodes: [
        { name: 'Body', mesh: 0 },
        { name: 'Source coordinate frame', matrix: identity, children: [0] },
      ],
      meshes: [
        { name: 'Body', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] },
      ],
      materials: [
        {
          pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 },
          extras: {
            modkit: {
              material: {
                version: 1,
                fields: { blendMode: 'opaque', layers: [], type: 'standard' },
              },
            },
          },
        },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
        { bufferView: 2, componentType: 5125, count: 3, type: 'SCALAR' },
      ],
      bufferViews: views,
      buffers: [{ byteLength: binary.byteLength }],
    },
  })
}

/** How many times a chunk tag appears in the encoded model. */
const chunks = (mdx: Uint8Array, tag: string): number =>
  Buffer.from(mdx).toString('latin1').split(tag).length - 1

describe('writing emitters a foreign document states', () => {
  it('carries particles and ribbons into the native model', () => {
    const mdx = exportWar3FromUvm(
      uvmWithEffects({
        profile: 'm3',
        trackTimeUnit: 'seconds',
        spaceNode: 1,
        particles: [
          {
            name: 'Sparks',
            node: 0,
            material: 0,
            texturePath: 'Assets/Textures/spark.dds',
            width: 1.5,
            length: 2.5,
            speed: 5.5,
            gravity: 9.8,
            lifeSpan: 0.3,
            emissionRate: 40,
            squirt: true,
            head: true,
            tail: false,
          },
        ],
        ribbons: [
          { name: 'Trail', node: 0, material: 0, heightAbove: 1, heightBelow: 0.5, lifeSpan: 2 },
        ],
        forces: [],
        warps: [],
        projectors: [],
      }),
      budget,
    )
    expect(chunks(mdx, 'PRE2')).toBe(1)
    expect(chunks(mdx, 'RIBB')).toBe(1)
    // The emitter's texture reaches the model's own texture table rather than being dropped with
    // the path, which is the only way a Warcraft III emitter can name one.
    expect(Buffer.from(mdx).toString('latin1')).toContain('spark.dds')
    expect(Buffer.from(mdx).toString('latin1')).toContain('Sparks')
  })

  it('writes no emitter chunks for a document that declares none', () => {
    const mdx = exportWar3FromUvm(uvmWithEffects(), budget)
    expect(chunks(mdx, 'PRE2')).toBe(0)
    expect(chunks(mdx, 'RIBB')).toBe(0)
  })

  it('reports the animated tracks it could not carry', () => {
    const notes: string[] = []
    exportWar3FromUvm(
      uvmWithEffects({
        profile: 'm3',
        trackTimeUnit: 'seconds',
        spaceNode: 1,
        particles: [
          {
            name: 'Pulse',
            node: 0,
            material: 0,
            emissionRate: 10,
            animation: { emissionRate: { keys: [{ frame: 0, value: 1 }] } },
          },
        ],
        ribbons: [],
        forces: [],
        warps: [],
        projectors: [],
      }),
      budget,
      {},
      undefined,
      notes,
    )
    expect(notes).toHaveLength(1)
    // A whole-timeline track names no sequence, so there is no slot to put it in.
    expect(notes[0]).toMatch(/1 emitter\(s\) carry whole-timeline `animation` tracks/u)
  })
})
