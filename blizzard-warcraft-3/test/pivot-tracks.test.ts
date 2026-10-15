import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelAnimationSource } from '@modkit/sdk'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { exportWar3FromUvm } from '../dist/war3-mdx/native-encoder.js'
import { authoredModelBytes, extension, open } from './war3-harness.js'

/**
 * An MDX translation key moves a node from its pivot (WhiteoutFlakes `mdx_animation.cpp`), while a
 * common translation channel replaces the node's rest translation — its pivot's offset from the
 * parent's. The keys are published with that offset added and written back with it taken off.
 * Without it a keyed bone jumped to its parent's pivot (the Archmage sank into his horse).
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): { Bones: Record<string, unknown>[]; PivotPoints: Float32Array[] }
  generateWar3Mdx(model: unknown): Uint8Array
}
const containerBudget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }
const pivot = [10, 20, 30] as const

async function pivotedModel(): Promise<Uint8Array> {
  const model = parseWar3Mdx((await authoredModelBytes()).mdx)
  const bone = model.Bones[0]!
  bone['PivotPoint'] = Float32Array.from(pivot)
  // The binary writer takes pivots from the model's PIVT list, not from the node.
  model.PivotPoints[bone['ObjectId'] as number] = Float32Array.from(pivot)
  bone['Translation'] = {
    LineType: 1,
    Keys: [
      { Frame: 0, Vector: Float32Array.from([0, 0, 0]) },
      { Frame: 1000, Vector: Float32Array.from([0, 0, 5]) },
    ],
  }
  return generateWar3Mdx(model)
}

const close = (actual: readonly number[] | undefined, expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((value, index) => expect(actual![index]).toBeCloseTo(value, 4))
}

describe('Warcraft III translation keys and pivots', () => {
  it('publishes each key as the node translation, pivot offset included', async () => {
    const session = await open(await pivotedModel())
    const lease = await session.dataSource('common.view/model-animation-source', 1)
    try {
      const clip = (await (lease.value as ModelAnimationSource).clips({ limit: 4 })).items[0]
      const samples = clip?.channels?.find(item => item.kind === 'translation')?.samples ?? []
      close(samples[0]?.value, [10, 20, 30])
      close(samples[1]?.value, [10, 20, 35])
    } finally {
      await lease.release()
      await session.dispose()
    }
  })

  it('is written back from the common clips as the keys it came from', async () => {
    const session = await open(await pivotedModel())
    let bytes: Uint8Array
    try {
      const result = await session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
      bytes = result.output.value as Uint8Array
    } finally {
      await session.dispose()
    }
    // Without our residual the writer builds the model from the common clips alone.
    const container = readUvmContainer(bytes, containerBudget)
    const document = { ...container.document }
    delete document['extras']
    const written = parseWar3Mdx(
      exportWar3FromUvm(writeUvmContainer({ ...container, document }, containerBudget), containerBudget),
    )
    type Key = { Frame: number; Vector: Float32Array }
    const translation = written.Bones.map(
      bone => bone['Translation'] as { Keys: Key[] } | undefined,
    ).find(value => value !== undefined)
    // The bone sits under the document's coordinate-frame node, so the keys come back turned by
    // the writer's axis change.
    const turned = ([x, y, z]: number[]) => [x!, -z!, y!]
    close([...translation!.Keys[0]!.Vector], turned([0, 0, 0]))
    close([...translation!.Keys[1]!.Vector], turned([0, 0, 5]))
  })
})
