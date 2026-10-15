import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { JsonObject } from '@modkit/sdk'
import {
  DEFAULT_UVM_CONTAINER_BUDGET,
  readUvmContainer,
  writeUvmContainer,
  type UvmContainer,
} from '@modkit/uv/model/container'
import { materializeUvmCore } from '@modkit/uv/model/materializer'
import { projectM3Effects, type M3EffectsSource } from '../dist/m3/uvm/effects.js'
import { decodeM3Effects } from '../src/m3/runtime/effects.js'
import { projectM3EffectsFromUvm } from '../src/m3/runtime/fresh-export.js'

const budget = { ...DEFAULT_UVM_CONTAINER_BUDGET, maxScalarBytes: 268_435_456 }
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const boneIds = Array.from({ length: 64 }, (_, index) => `bone/${index}`)
const materialIds = Array.from({ length: 32 }, (_, index) => `material-${index}`)
const sequences = Array.from({ length: 16 }, (_, index) => ({
  source: 'base' as const,
  nativeSequenceIndex: index,
  combinedSequenceIndex: index + 16,
  clipId: `clip-${index}`,
}))
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('effects test object absent')
  return value as JsonObject
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('effects test array absent')
  return value
}
/** The effects through the materializer, on a model of 64 bones under a root and 32 materials. */
function published(input: M3EffectsSource) {
  const effects = projectM3Effects(input, new Set(boneIds), new Set(materialIds), sequences, budget)
  if (effects === undefined) throw new TypeError('effects test has no emitters')
  const materialized = materializeUvmCore(
    {
      info: {
        scenes: 1,
        nodes: 65,
        meshes: 0,
        primitives: 0,
        materials: materialIds.length,
        textures: 0,
        animations: 0,
        geometryAccess: 'metadata-only',
      },
      nodes: [
        { id: 'root', childIds: boneIds, meshIds: [], transform: identity },
        ...boneIds.map(id => ({ id, childIds: [], meshIds: [], transform: identity })),
        ...(effects.unboundNode === undefined ? [] : [effects.unboundNode]),
      ],
      materials: materialIds.map(id => ({ id })),
      effects: effects.effects,
    },
    {
      scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
      profile: 'UVM/core@1.0',
      subjectRevision: 'content-hash.sha256:effects' as never,
      options: { assetId: 'effects', sourceFormat: 'm3' },
    },
  )
  const container = readUvmContainer(materialized.bytes, budget)
  return {
    ...effects,
    container,
    nodes: materialized.bindings.nodes,
    materials: materialized.bindings.materials,
    // The document's node index of each bone, as the M3 writer reads them back.
    boneOf: Object.fromEntries(boneIds.map((id, bone) => [materialized.bindings.nodes[id], bone])),
  }
}
function mapped(container: UvmContainer): JsonObject {
  return object(object(container.document['extensions'])['UV_game_effects'])
}
describe('M3 rich native effects projection to UVM', () => {
  it('preserves retail Harbinger PAR_ and PARC fields and explicit sequence identity', async () => {
    const bytes = Uint8Array.from(
      await readFile(new URL('./fixtures/m3/corpus/Harbinger.m3', import.meta.url)),
    )
    const decoded = await decodeM3Effects(bytes, budget)
    const result = published(decoded)
    const output = mapped(readUvmContainer(writeUvmContainer(result.container, budget), budget))
    const particles = array(output['particles']),
      original = array(decoded.effects['particles'])
    expect(particles).toHaveLength(10)
    expect(output).toMatchObject({ profile: 'm3', trackTimeUnit: 'seconds' })
    expect(object(particles[4])).toMatchObject({ node: result.nodes['bone/15'], emissionRate: 0, emitCount: 0 })
    expect(object(particles[8])).toMatchObject({ node: result.nodes['bone/21'], emissionRate: 20 })
    const native = object(original[0]),
      particle = object(particles[0])
    for (const key of Object.keys(native)) {
      if (['boneIndex', 'materialIndex', 'sequenceAnimation', 'emitShapeMeshes'].includes(key))
        continue
      expect(particle[key], key).toEqual(native[key])
    }
    expect(object(particle['sequenceAnimation'])['emissionRate']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequenceIndex: 20, concurrent: true, wrapSeconds: 2 }),
      ]),
    )
    expect(result.mapping?.['diagnostics']).toEqual(decoded.diagnostics)
    expect(result.mapping?.['animationMetadata']).toEqual(decoded.animationMetadata)
  })

  it('stores emission meshes in UVM accessors and remaps nested spline anchors without trimming rich fields', () => {
    const input: M3EffectsSource = {
      effects: {
        particles: [
          {
            name: 'Mesh emitter',
            boneIndex: 2,
            materialIndex: 0,
            emitShape: 'mesh',
            emitShapeMeshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }],
            collisionEmitter: 7,
            trailEmitter: 9,
            randomizeColor: true,
          },
        ],
        ribbons: [
          {
            name: 'Ribbon',
            boneIndex: 0,
            materialIndex: 1,
            ribbonType: 'star',
            sides: 7,
            splineEndpoints: [
              {
                boneIndex: 3,
                sequenceAnimation: {
                  yaw: [
                    {
                      sequenceIndex: 2,
                      track: {
                        lineType: 1,
                        globalSeqId: null,
                        keys: [
                          { frame: 0, vector: [0] },
                          { frame: 1, vector: [1] },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
        forces: [{ name: 'Wind', boneIndex: -1, type: 'wind', strength: 5, channels: 7 }],
      },
      diagnostics: [
        { code: 'native-preview', message: 'Special modes remain preserved', severity: 'warning' },
      ],
      animationMetadata: null,
    }
    const result = published(input)
    const output = mapped(readUvmContainer(writeUvmContainer(result.container, budget), budget))
    expect(object(array(output['particles'])[0])).toMatchObject({
      node: result.nodes['bone/2'],
      material: result.materials['material-0'],
      collisionEmitter: 7,
      trailEmitter: 9,
      randomizeColor: true,
      emitShapeMeshes: [{ positions: 0, indices: 1 }],
    })
    expect(array(result.container.document['accessors'])).toHaveLength(2)
    expect(result.container.binary.length).toBeGreaterThanOrEqual(48)
    expect(object(array(output['ribbons'])[0])).toMatchObject({
      node: result.nodes['bone/0'],
      material: result.materials['material-1'],
      ribbonType: 'star',
      sides: 7,
      splineEndpoints: [
        { node: result.nodes['bone/3'], sequenceAnimation: { yaw: [{ sequenceIndex: 18 }] } },
      ],
    })
    // An emitter on no bone rides on a root node of its own.
    expect(object(array(output['forces'])[0])['node']).toBe(result.nodes['m3/unbound-effects'])
    expect(array(result.container.document['nodes'])).toHaveLength(66)
    expect(result.warnings).toEqual(['native-preview: Special modes remain preserved'])
    const restored = projectM3EffectsFromUvm(result.container, result.boneOf, budget)
    const inputParticle = object(array(input.effects['particles'])[0])
    const inputRibbon = object(array(input.effects['ribbons'])[0])
    const inputEndpoint = object(array(inputRibbon['splineEndpoints'])[0])
    const inputYaw = object(array(object(inputEndpoint['sequenceAnimation'])['yaw'])[0])
    expect(restored).toEqual({
      particles: [inputParticle],
      ribbons: [
        {
          ...inputRibbon,
          splineEndpoints: [
            {
              ...inputEndpoint,
              sequenceAnimation: {
                yaw: [
                  {
                    sequenceIndex: 18,
                    track: inputYaw['track'],
                  },
                ],
              },
            },
          ],
        },
      ],
      forces: [object(array(input.effects['forces'])[0])],
      warps: [],
      projectors: [],
    })
  })

  it('keeps a dormant authored bounce-ribbon link editable through source-free UVM', () => {
    const input: M3EffectsSource = {
      effects: {
        particles: [
          {
            name: 'Dormant bounce emitter',
            boneIndex: 0,
            materialIndex: 0,
            bounceRibbonEmitterIndex: 0,
            bounceRibbonChance: 0,
          },
        ],
        ribbons: [{ name: 'Dormant target', boneIndex: 1, materialIndex: 1 }],
      },
      diagnostics: [],
      animationMetadata: null,
    }
    const result = published(input)
    const reopened = readUvmContainer(writeUvmContainer(result.container, budget), budget)
    const extension = mapped(reopened)
    const particle = object(array(extension['particles'])[0])
    expect(particle).toMatchObject({ bounceRibbonEmitterIndex: 0, bounceRibbonChance: 0 })

    // A user edit may reactivate this link without reconstructing native-only information.
    const extensions = object(reopened.document['extensions'])
    const edited: UvmContainer = {
      ...reopened,
      document: {
        ...reopened.document,
        extensions: {
          ...extensions,
          UV_game_effects: {
            ...extension,
            particles: array(extension['particles']).map((value, index) =>
              index === 0 ? { ...object(value), bounceRibbonChance: 1 } : value,
            ),
          },
        },
      },
    }
    const editedReopened = readUvmContainer(writeUvmContainer(edited, budget), budget)
    const restored = projectM3EffectsFromUvm(editedReopened, result.boneOf, budget)
    expect(restored.particles[0]).toMatchObject({
      bounceRibbonEmitterIndex: 0,
      bounceRibbonChance: 1,
    })
  })

  it('rejects missing native node/material/sequence binding instead of guessing indices', () => {
    const effect = {
      name: 'Emitter',
      boneIndex: 3,
      materialIndex: 0,
      sequenceAnimation: { emissionRate: [{ sequenceIndex: 2, track: { lineType: 1, keys: [] } }] },
    }
    const input: M3EffectsSource = {
      effects: { particles: [effect] },
      diagnostics: [],
      animationMetadata: null,
    }
    const project = (
      nodes: ReadonlySet<string>,
      materials: ReadonlySet<string>,
      bindings: typeof sequences,
      limits = budget,
      signal?: AbortSignal,
    ) => projectM3Effects(input, nodes, materials, bindings, limits, signal)
    const bones = new Set(boneIds), materials = new Set(materialIds)
    expect(() => project(new Set(), materials, sequences)).toThrow(/no UVM node/)
    expect(() => project(bones, new Set(), sequences)).toThrow(/no UVM material/)
    expect(() => project(bones, materials, [])).toThrow(/no explicit clip binding/)
    expect(() => project(bones, materials, sequences, { ...budget, maxNodes: 2 })).toThrow(/maxNodes/)
    const controller = new AbortController()
    controller.abort()
    expect(() => project(bones, materials, sequences, budget, controller.signal)).toThrow()
  })
})
