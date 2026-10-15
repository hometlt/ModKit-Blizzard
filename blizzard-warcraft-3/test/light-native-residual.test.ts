/** Native light RGB typed-array restoration through UVM, not common lighting/playback qualification. */
import { describe, expect, it } from 'vitest'
import { layeredModelBytes } from './war3-layered-model.js'
import { open } from './war3-harness.js'
import { generateWar3Mdx, parseWar3Mdx, parseWar3Mdl } from '../dist/war3-mdx/render-model.js'
import { exportWar3FromUvm } from '../dist/war3-mdx/native-encoder.js'
import type { JsonObject } from '@modkit/sdk'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { attachUvmFormatResidual, readUvmFormatResidual } from '@modkit/uv/model/format-residual'
const budget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }

describe('WC3 native light residual colours', () => {
  it.each(['Color', 'AmbColor'].flatMap(field => ['mdx', 'mdl'].flatMap(encoding =>
    [[], [0, 1], [0, 1, 2, 3], ['oops', 0, 1], [null, 0, 1], [true, 0, 1], [1e40, 0, 1]]
      .map(value => ({ field, encoding: encoding as 'mdx' | 'mdl', value })))))
  ('refuses malformed static $field $value before $encoding bytes', async ({ field, encoding, value }) => {
    const native = parseWar3Mdx(await layeredModelBytes())
    native.Lights = [{ Name: 'Light', ObjectId: 1, Parent: 0, Flags: 0x200, PivotPoint: Float32Array.of(0, 0, 0),
      LightType: 0, Color: Float32Array.of(0, 0.25, 2), Intensity: 0,
      AmbColor: Float32Array.of(0.125, 0, 0.5), AmbIntensity: 0.5 }]
    native.Nodes.push(...native.Lights)
    native.PivotPoints.push(Float32Array.of(0, 0, 0))
    const session = await open(generateWar3Mdx(native))
    try {
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(JSON.stringify(result))
      const container = readUvmContainer(result.output.value as Uint8Array, budget)
      const envelope = readUvmFormatResidual(container, 'BlizzardMDX')
      const residual = structuredClone(envelope.residual)
      const lights = residual['lights'] as Record<string, unknown>[]
      lights[0]![field] = value
      const extras = { ...(container.document['extras'] as JsonObject) }
      delete extras['BlizzardMDX']
      const malformed = writeUvmContainer(attachUvmFormatResidual({ ...container,
        document: { ...container.document, extras } }, { ...envelope, namespace: 'BlizzardMDX', residual }, budget), budget)
      expect(() => exportWar3FromUvm(malformed, budget, { encoding }))
        .toThrow(`Warcraft III native light ${field} requires exactly three finite float32-range numbers`)
    } finally { await session.dispose() }
  })

  it.each(['mdx', 'mdl'] as const)('restores static RGB beside animated colours when writing %s', async encoding => {
    const native = parseWar3Mdx(await layeredModelBytes())
    const track = { LineType: 1, GlobalSeqId: undefined,
      Keys: [{ Frame: 0, Vector: Float32Array.of(0, 0.5, 1) }, { Frame: 1000, Vector: Float32Array.of(1, 0.25, 0) }] }
    native.Lights = [false, true].map((animated, index) => ({
      Name: `Light_${index}`, ObjectId: index + 1, Parent: 0, Flags: 0x200, PivotPoint: Float32Array.of(index, 0, 0),
      LightType: 0, AttenuationStart: 0, AttenuationEnd: 500,
      Color: animated ? track : Float32Array.of(0, 0.25, 2), Intensity: 0,
      AmbColor: animated ? Float32Array.of(0.125, 0, 0.5) : track, AmbIntensity: 0.5,
    }))
    native.Nodes.push(...native.Lights)
    native.PivotPoints.push(Float32Array.of(0, 0, 0), Float32Array.of(1, 2, 3))
    const bytes = generateWar3Mdx(native)
    const source = bytes.slice()
    const expected = parseWar3Mdx(bytes).Lights
    const session = await open(bytes)
    try {
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(JSON.stringify(result))
      const output = exportWar3FromUvm(result.output.value as Uint8Array, budget, { encoding })
      const actual = (encoding === 'mdx' ? parseWar3Mdx(output) : parseWar3Mdl(new TextDecoder().decode(output))).Lights
      expect(actual).toHaveLength(2)
      for (let index = 0; index < 2; index++) {
        expect(actual[index]!.Color).toEqual(expected[index]!.Color)
        expect(actual[index]!.AmbColor).toEqual(expected[index]!.AmbColor)
        expect(actual[index]!.Intensity).toBe(0)
        expect(actual[index]!.AmbIntensity).toBe(0.5)
      }
      expect(bytes).toEqual(source)
    } finally { await session.dispose() }
  })
})
