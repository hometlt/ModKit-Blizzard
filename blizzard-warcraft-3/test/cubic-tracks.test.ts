import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelAnimationSource } from '@modkit/sdk'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { exportWar3FromUvm } from '../dist/war3-mdx/native-encoder.js'
import { authoredModelBytes, extension, open } from './war3-harness.js'

/**
 * Almost every shipped Warcraft III model moves its bones with Hermite or Bezier tracks. They are
 * published as `cubic-spline`, the one curve glTF has: each key carries the derivative per second
 * arriving and leaving, converted from the MDX tangent (Hermite: over the key interval) or control
 * point (Bezier: 3·(control − value) leaving, 3·(value − control) arriving).
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): { Bones: Record<string, unknown>[] }
  generateWar3Mdx(model: unknown): Uint8Array
}
const vector = (...values: number[]) => Float32Array.from(values)
const containerBudget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }

/**
 * The authored model, its bone moved by a Hermite translation, turned by a Bezier rotation and grown
 * by a linear scaling.
 */
async function curvedModel(): Promise<Uint8Array> {
  const model = parseWar3Mdx((await authoredModelBytes()).mdx)
  const bone = model.Bones[0]!
  bone['Translation'] = {
    LineType: 2,
    Keys: [
      { Frame: 0, Vector: vector(0, 0, 0), InTan: vector(0, 0, 0), OutTan: vector(0, 0, 30) },
      { Frame: 500, Vector: vector(0, 0, 64), InTan: vector(0, 0, 10), OutTan: vector(0, 0, 20) },
      { Frame: 1000, Vector: vector(0, 0, 32), InTan: vector(0, 0, -5), OutTan: vector(0, 0, 0) },
    ],
  }
  bone['Rotation'] = {
    LineType: 3,
    Keys: [
      { Frame: 0, Vector: vector(0, 0, 0, 1), InTan: vector(0, 0, 0, 1), OutTan: vector(0, 0, 0.25, 1) },
      { Frame: 1000, Vector: vector(0, 0, 0.6, 0.8), InTan: vector(0, 0, 0.35, 0.9), OutTan: vector(0, 0, 0.6, 0.8) },
    ],
  }
  bone['Scaling'] = {
    LineType: 1,
    Keys: [
      { Frame: 0, Vector: vector(1, 1, 1) },
      { Frame: 1000, Vector: vector(2, 2, 2) },
    ],
  }
  return generateWar3Mdx(model)
}

async function curvedUvm(): Promise<Uint8Array> {
  const session = await open(await curvedModel())
  try {
    const result = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    if (result.state !== 'ok' || result.output.kind !== 'bytes')
      throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
    return result.output.value as Uint8Array
  } finally {
    await session.dispose()
  }
}

const close = (actual: readonly number[] | undefined, expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((value, index) => expect(actual![index]).toBeCloseTo(value, 5))
}

describe('Warcraft III cubic tracks', () => {
  it('publishes Hermite and Bezier keys with their derivatives per second', async () => {
    const session = await open(await curvedModel())
    const lease = await session.dataSource('common.view/model-animation-source', 1)
    try {
      const clip = (await (lease.value as ModelAnimationSource).clips({ limit: 4 })).items[0]
      const channel = (kind: string) => clip?.channels?.find(item => item.kind === kind)

      const translation = channel('translation')
      expect(translation?.interpolation).toBe('cubic-spline')
      // Keys half a second apart: a Hermite tangent over the interval is twice as much per second.
      const [first, middle, last] = translation?.samples ?? []
      close(first?.inTangent, [0, 0, 0])
      close(first?.outTangent, [0, 0, 60])
      close(middle?.inTangent, [0, 0, 20])
      close(middle?.outTangent, [0, 0, 40])
      close(last?.inTangent, [0, 0, -10])
      close(last?.outTangent, [0, 0, 0])

      const rotation = channel('rotation')
      expect(rotation?.interpolation).toBe('cubic-spline')
      const [start, end] = rotation?.samples ?? []
      // One second apart: three times the distance from the key to its control point.
      close(start?.outTangent, [0, 0, 0.75, 0])
      close(end?.inTangent, [0, 0, 0.75, -0.3])
    } finally {
      await lease.release()
      await session.dispose()
    }
  })

  it('reaches UVM as glTF CUBICSPLINE instead of being dropped, and the scaling with it', async () => {
    const document = readUvmContainer(await curvedUvm(), containerBudget).document as {
      animations?: {
        channels: { sampler: number; target: { path: string } }[]
        samplers: { interpolation?: string }[]
      }[]
    }
    expect(document.animations).toHaveLength(1)
    const animation = document.animations![0]!
    // The rig names the channel `scale`; published as MDX's `scaling` it was lost.
    expect(
      animation.channels.map(channel => [channel.target.path, animation.samplers[channel.sampler]?.interpolation]).sort(),
    ).toEqual([
      ['rotation', 'CUBICSPLINE'],
      ['scale', 'LINEAR'],
      ['translation', 'CUBICSPLINE'],
    ])
  })

  it('is written back as Hermite with the tangents it came from', async () => {
    // Without our residual the writer builds the model from the common clips alone, the path a
    // cubic curve from another game takes.
    const container = readUvmContainer(await curvedUvm(), containerBudget)
    const document = { ...container.document }
    delete document['extras']
    const written = parseWar3Mdx(
      exportWar3FromUvm(writeUvmContainer({ ...container, document }, containerBudget), containerBudget),
    )
    type Key = { Frame: number; Vector: Float32Array; InTan?: Float32Array; OutTan?: Float32Array }
    const track = (name: string) =>
      written.Bones.map(bone => bone[name] as { LineType: number; Keys: Key[] } | undefined).find(
        value => value !== undefined,
      )
    // This path keeps the bone under the document's coordinate-frame node, so its keys are the
    // native ones turned by the writer's axis change; a tangent must turn exactly as its value.
    const turned = ([x, y, z, ...w]: number[]) => [x!, -z!, y!, ...w]
    const translation = track('Translation')
    expect(translation?.LineType).toBe(2)
    close([...translation!.Keys[1]!.Vector], turned([0, 0, 64]))
    close([...translation!.Keys[0]!.OutTan!], turned([0, 0, 30]))
    close([...translation!.Keys[1]!.InTan!], turned([0, 0, 10]))
    close([...translation!.Keys[1]!.OutTan!], turned([0, 0, 20]))
    close([...translation!.Keys[2]!.InTan!], turned([0, 0, -5]))
    const rotation = track('Rotation')
    expect(rotation?.LineType).toBe(2)
    // The Bezier control points come back as the equivalent Hermite tangents: 3·(control − value).
    close([...rotation!.Keys[1]!.Vector], turned([0, 0, 0.6, 0.8]))
    close([...rotation!.Keys[0]!.OutTan!], turned([0, 0, 0.75, 0]))
    close([...rotation!.Keys[1]!.InTan!], turned([0, 0, 0.75, -0.3]))
  })
})
