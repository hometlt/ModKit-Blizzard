import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelAnimationClip } from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'
import { layeredModelBytes } from './war3-layered-model.js'
import { budget as hostBudget, extension, open } from './war3-harness.js'

/**
 * Event objects (EVTS) fire at the frames of their track: a sound, a spawned model, a splat. Each
 * key inside a sequence is an event of that clip at the object's node, its kind and table row in
 * the payload; a track on a global sequence fires every cycle. The writer keeps the global sequence.
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): Record<string, unknown>
  generateWar3Mdx(model: unknown): Uint8Array
}
const budget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }

async function eventModel(): Promise<Uint8Array> {
  const model = parseWar3Mdx(await layeredModelBytes())
  model['GlobalSequences'] = [600]
  const event = (Name: string, ObjectId: number, frames: number[], GlobalSeqId?: number) => ({
    Name,
    ObjectId,
    Parent: 0,
    PivotPoint: Float32Array.from([0, 0, 0]),
    Flags: 0x400,
    EventTrack: Uint32Array.from(frames),
    ...(GlobalSeqId === undefined ? {} : { GlobalSeqId }),
  })
  const sound = event('SNDxFTDA', 1, [250, 2500])
  const splat = event('UBRaDHLB', 2, [100], 0)
  for (const item of [sound, splat]) {
    ;(model['EventObjects'] as unknown[]).push(item)
    ;(model['Nodes'] as unknown[]).push(item)
    ;(model['PivotPoints'] as unknown[]).push(Float32Array.from([0, 0, 0]))
  }
  return generateWar3Mdx(model)
}

describe('Warcraft III event objects', () => {
  it('fire as clip events with their kind and table row, and survive the writer', async () => {
    const bytes = await eventModel()
    expect((parseWar3Mdx(bytes)['EventObjects'] as { GlobalSeqId?: number }[]).map(item => item.GlobalSeqId)).toEqual([undefined, 0])
    const session = await open(bytes, { ...hostBudget, maxNodes: 100_000 })
    let uvm: Uint8Array
    try {
      const lease = await session.dataSource('common.view/model-animation-source', 1)
      try {
        const clips = (await (lease.value as { clips(r: { limit: number }): Promise<{ items: ModelAnimationClip[] }> }).clips({ limit: 8 })).items
        const eventsOf = (name: string) =>
          clips.find(clip => clip.name === name)!.events?.map(event => [event.timeSeconds, event.name, event.payload])
        // Stand 0-1000: the sound at 250, the uber splat at 100 every 600 ms cycle.
        expect(eventsOf('Stand')).toEqual([
          [0.1, 'UBRaDHLB', { kind: 'UBR', code: 'DHLB' }],
          [0.25, 'SNDxFTDA', { kind: 'SND', code: 'FTDA' }],
          [0.7, 'UBRaDHLB', { kind: 'UBR', code: 'DHLB' }],
        ])
        // Death 2000-3000: the sound at 2500.
        expect(eventsOf('Death')?.filter(([, name]) => name === 'SNDxFTDA')).toEqual([[0.5, 'SNDxFTDA', { kind: 'SND', code: 'FTDA' }]])
      } finally {
        await lease.release()
      }
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
      uvm = result.output.value as Uint8Array
    } finally {
      await session.dispose()
    }
    const { document } = readUvmContainer(uvm, budget)
    const stand = (document['animations'] as { name: string; extensions?: Record<string, { events: { name: string }[] }> }[]).find(
      animation => animation.name === 'Stand',
    )
    expect(stand?.extensions?.['UV_game_animation_events']?.events.map(event => event.name)).toEqual(['UBRaDHLB', 'SNDxFTDA', 'UBRaDHLB'])
  })
})
