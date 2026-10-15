import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelAnimationClip } from '@modkit/sdk'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { exportWar3FromUvm } from '../dist/war3-mdx/native-encoder.js'
import { layeredModelBytes } from './war3-layered-model.js'
import { extension, open } from './war3-harness.js'

/**
 * A node track on a global sequence (the flies around an Abomination, flags, rotors) runs in every
 * sequence on its own clock. It crosses as a concurrent channel of each clip wrapping at the global
 * sequence's length, timed from that cycle's start, and the writer turns it back into one track on a
 * global sequence. It used to cross timed from each sequence's start under a name the sdk does not
 * know, so the node stood still.
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): Record<string, unknown>
  generateWar3Mdx(model: unknown): Uint8Array
}
const containerBudget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }
type Track = { GlobalSeqId: number | null; Keys: { Frame: number; Vector: Float32Array }[] }

async function flyModel(): Promise<Uint8Array> {
  const model = parseWar3Mdx(await layeredModelBytes())
  model['GlobalSequences'] = [1233]
  const bone = (model['Bones'] as Record<string, unknown>[]).find(item => item['Name'] === 'Bone_Glow')!
  bone['Translation'] = {
    LineType: 1,
    GlobalSeqId: 0,
    Keys: [
      { Frame: 0, Vector: Float32Array.from([0, 0, 0]) },
      { Frame: 600, Vector: Float32Array.from([10, 0, 0]) },
      { Frame: 1233, Vector: Float32Array.from([0, 0, 0]) },
    ],
  }
  return generateWar3Mdx(model)
}

describe('Warcraft III node tracks on a global sequence', () => {
  it('cross as concurrent channels of every clip and come back as one track on a global sequence', async () => {
    const session = await open(await flyModel())
    let bytes: Uint8Array
    try {
      const lease = await session.dataSource('common.view/model-animation-source', 1)
      try {
        const clips = await (lease.value as { clips(r: { limit: number }): Promise<{ items: ModelAnimationClip[] }> }).clips({ limit: 16 })
        expect(clips.items.length).toBe(2)
        for (const clip of clips.items) {
          const channel = clip.channels.find(item => item.kind === 'translation' && item.concurrent === true)
          expect(channel).toMatchObject({ concurrent: true, wrapSeconds: 1.233 })
          expect(channel?.samples?.map(sample => sample.timeSeconds)).toEqual([0, 0.6, 1.233])
        }
      } finally {
        await lease.release()
      }
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
      bytes = result.output.value as Uint8Array
    } finally {
      await session.dispose()
    }
    // Without our residual the writer builds the nodes from the common vocabulary alone.
    const container = readUvmContainer(bytes, containerBudget)
    const document = { ...container.document }
    delete document['extras']
    const written = parseWar3Mdx(exportWar3FromUvm(writeUvmContainer({ ...container, document }, containerBudget), containerBudget))
    expect(written['GlobalSequences']).toContain(1233)
    const tracks = (written['Nodes'] as Record<string, unknown>[])
      .map(node => node['Translation'] as Track | undefined)
      .filter((track): track is Track => track?.GlobalSeqId !== null && track?.GlobalSeqId !== undefined)
    expect(tracks).toHaveLength(1)
    expect((written['GlobalSequences'] as number[])[tracks[0]!.GlobalSeqId!]).toBe(1233)
    expect(tracks[0]!.Keys.map(key => key.Frame)).toEqual([0, 600, 1233])
  })
})
