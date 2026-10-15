/** KRCO uses the native reader/writer and existing UVM colour sequence tracks, not a new simulator. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { extension, open } from './war3-harness.js'
import { layeredModelBytes } from './war3-layered-model.js'

const { parseWar3Mdx, generateWar3Mdx, parseWar3Mdl, generateWar3Mdl } = await import(
  pathToFileURL(join(extension, 'dist/war3-mdx/render-model.js')).href,
) as typeof import('../dist/war3-mdx/render-model.js')
const { exportWar3FromUvm } = await import(
  pathToFileURL(join(extension, 'dist/war3-mdx/native-encoder.js')).href,
) as typeof import('../dist/war3-mdx/native-encoder.js')
const budget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }

describe('Warcraft III ribbon colour', () => {
  it('reads an authored MDL colour block and converts its BGR channels rather than relying on its own writer', () => {
    const model = parseWar3Mdl('Version { FormatVersion 800, } Model "KRCO probe" { BlendTime 150, } RibbonEmitter "ribbon" { ObjectId 0, static HeightAbove 1, static HeightBelow 1, static Alpha 1, Color 2 { Linear, 0: { 1, 0.5, 0.25 }, 1000: { 0.25, 0.5, 1 }, } LifeSpan 2, static TextureSlot 0, EmissionRate 10, Rows 1, Columns 1, MaterialID 0, Gravity 0, } PivotPoints 1 { { 0, 0, 0 }, }')
    const color = model.RibbonEmitters[0]!.Color as { Keys: { Vector: Float32Array }[] }
    expect(color.Keys.map(key => [...key.Vector])).toEqual([[0.25, 0.5, 1], [1, 0.5, 0.25]])
  })
  it.each([0, 1, 2, 3].flatMap(lineType => [
    { lineType, globalSeqId: null }, { lineType, globalSeqId: 0 },
  ]))('preserves KRCO interpolation $lineType and clock $globalSeqId across MDX, MDL and UVM', async ({ lineType, globalSeqId }) => {
    const model = parseWar3Mdx(await layeredModelBytes())
    model.GlobalSequences = [1000]
    const color = {
      LineType: lineType, GlobalSeqId: globalSeqId,
      Keys: [0, 500, 1000].map((Frame, ordinal) => ({
        Frame, Vector: Float32Array.of(ordinal / 4, 0.5, 1 - ordinal / 4),
        ...(lineType < 2 ? {} : { InTan: Float32Array.of(0.25, 0.5, 0.75), OutTan: Float32Array.of(0.75, 0.5, 0.25) }),
      })),
    }
    model.RibbonEmitters.push({
      Name: 'Colour ribbon', ObjectId: model.PivotPoints.length, Parent: 0, Flags: 16384,
      HeightAbove: 1, HeightBelow: 1, Alpha: 1, Color: color, ColorFallback: Float32Array.of(0.25, 0.5, 0.75), LifeSpan: 2,
      TextureSlot: 0, EmissionRate: 10, Rows: 1, Columns: 1, MaterialID: 0, Gravity: 3,
    })
    model.PivotPoints.push(Float32Array.of(0, 0, 0))
    const mdl = generateWar3Mdl(model)
    expect(parseWar3Mdl(mdl).RibbonEmitters[0]!.Color).toEqual(color)
    expect(parseWar3Mdl(mdl).RibbonEmitters[0]!.ColorFallback).toEqual(Float32Array.of(0.25, 0.5, 0.75))
    const mdx = generateWar3Mdx(model)
    expect(new TextDecoder().decode(mdx)).toContain('KRCO')
    expect(parseWar3Mdx(mdx).RibbonEmitters[0]!.Color).toEqual(color)
    expect(parseWar3Mdx(mdx).RibbonEmitters[0]!.ColorFallback).toEqual(Float32Array.of(0.25, 0.5, 0.75))
    const session = await open(mdx)
    try {
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(JSON.stringify(result))
      const bytes = result.output.value as Uint8Array
      const container = readUvmContainer(bytes, budget)
      const { document } = container
      const effect = (document['extensions'] as Record<string, unknown>)['UV_game_effects'] as {
        ribbons: { sequenceAnimation: { color: { sequenceIndex: number; track: { keys: { vector: number[] }[] }; concurrent?: boolean; wrapSeconds?: number }[] } }[]
      }
      const entries = effect.ribbons[0]!.sequenceAnimation.color
      expect(entries[0]!.track.keys.map(key => key.vector)).toEqual(color.Keys.map(key => [...key.Vector]))
      if (globalSeqId === 0) expect(entries[0]).toMatchObject({ concurrent: true, wrapSeconds: 1 })
      const written = parseWar3Mdx(exportWar3FromUvm(bytes, budget)).RibbonEmitters[0]!
      expect(written.Color).toEqual(color)
      expect(written.ColorFallback).toEqual(Float32Array.of(0.25, 0.5, 0.75))
      expect(written.Gravity).toBe(3)
      const common = { ...document }
      delete common['extras']
      const fresh = parseWar3Mdx(exportWar3FromUvm(writeUvmContainer({ ...container, document: common }, budget), budget))
      expect(fresh.RibbonEmitters[0]!.Color).toEqual(color)
      expect(fresh.RibbonEmitters[0]!.ColorFallback).toEqual(Float32Array.of(0.25, 0.5, 0.75))
    } finally { await session.dispose() }
  })
})
