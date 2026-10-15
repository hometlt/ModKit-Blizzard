/** HD native facts must survive UVM residual reconstruction even before their render projection. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extension, open } from './war3-harness.js'
import { layeredModelBytes } from './war3-layered-model.js'

const { parseWar3Mdx, generateWar3Mdx } = await import(
  pathToFileURL(join(extension, 'dist/war3-mdx/render-model.js')).href,
) as typeof import('../dist/war3-mdx/render-model.js')
const { exportWar3FromUvm } = await import(
  pathToFileURL(join(extension, 'dist/war3-mdx/native-encoder.js')).href,
) as typeof import('../dist/war3-mdx/native-encoder.js')
const budget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }
const { exportWar3Uvm } = await import(pathToFileURL(join(extension, 'dist/war3-mdx/uvm.js')).href) as typeof import('../dist/war3-mdx/uvm.js')
const { war3ModelToRenderModel } = await import(pathToFileURL(join(extension, 'dist/war3-mdx/render-model.js')).href) as typeof import('../dist/war3-mdx/render-model.js')
const { revisionId } = await import('@modkit/sdk')

/** Export through the public codec operation, then reopen the native encoder's result. */
async function roundTrip(bytes: Uint8Array) {
  const session = await open(bytes)
  try {
    const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(JSON.stringify(result))
    return parseWar3Mdx(exportWar3FromUvm(result.output.value as Uint8Array, budget))
  } finally { await session.dispose() }
}

describe('Warcraft III HD native material preservation', () => {
  it('reports residual-only KMTE/Fresnel instead of implying executable common playback', async () => {
    const native = parseWar3Mdx(await layeredModelBytes())
    native.Version = 1100
    const layer = native.Materials[0]!.Layers[1]!
    Object.assign(layer, { ShaderTypeId: 1, EmissiveGain: { LineType: 1, GlobalSeqId: null,
      Keys: [{ Frame: 0, Vector: Float32Array.of(0) }, { Frame: 1000, Vector: Float32Array.of(2) }] },
      FresnelColor: Float32Array.of(0.25, 0.5, 0.75), FresnelOpacity: 0, FresnelTeamColor: 0 })
    const result = exportWar3Uvm(war3ModelToRenderModel(native, 'mdx'), native as unknown as Readonly<Record<string, unknown>>,
      'mdx', { assetId: 'kmte-remainder', subjectRevision: revisionId('content-hash.sha256:kmte-remainder'), budget })
    expect(result.notes).toContainEqual(expect.stringContaining('material 0 layer 1 animated EmissiveGain (KMTE)'))
    expect(result.notes).toContainEqual(expect.stringContaining('material 0 layer 1 FresnelColor/FresnelOpacity/FresnelTeamColor'))
    const session = await open(generateWar3Mdx(native))
    try {
      const exported = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      expect(exported.state).toBe('ok')
      expect(exported.diagnostics).toContainEqual(expect.objectContaining({
        code: 'blizzard.war3-mdx/conversion-remainder', severity: 'warning',
        message: expect.stringContaining('material 0 layer 1 animated EmissiveGain (KMTE)'),
      }))
    } finally { await session.dispose() }
    const written = parseWar3Mdx(exportWar3FromUvm(result.bytes, budget)).Materials[0]!.Layers[1]!
    expect(written.EmissiveGain).toEqual(layer.EmissiveGain)
    expect(written.FresnelColor).toEqual(layer.FresnelColor)
    expect(written).toMatchObject({ FresnelOpacity: 0, FresnelTeamColor: 0 })
    layer.EmissiveGain = 0
    const staticResult = exportWar3Uvm(war3ModelToRenderModel(native, 'mdx'), native as unknown as Readonly<Record<string, unknown>>,
      'mdx', { assetId: 'static-remainder', subjectRevision: revisionId('content-hash.sha256:static-remainder'), budget })
    expect(staticResult.notes.some(note => note.includes('EmissiveGain (KMTE)'))).toBe(false)
  })

  it('keeps static Fresnel RGB and zero gain/opacity/team colour', async () => {
    const model = parseWar3Mdx(await layeredModelBytes())
    model.Version = 1100
    const layer = model.Materials[0]!.Layers[1]!
    Object.assign(layer, {
      ShaderTypeId: 1, EmissiveGain: 0,
      FresnelColor: Float32Array.of(0.25, 0.5, 0.75), FresnelOpacity: 0, FresnelTeamColor: 0,
    })
    const written = (await roundTrip(generateWar3Mdx(model))).Materials[0]!.Layers[1]!
    expect(written.FresnelColor).toEqual(layer.FresnelColor)
    expect(written).toMatchObject({ EmissiveGain: 0, FresnelOpacity: 0, FresnelTeamColor: 0 })
  })

  it.each([0, 1, 2, 3].flatMap(lineType => [
    { lineType, globalSeqId: null }, { lineType, globalSeqId: 0 },
  ]))('keeps KMTE/KFC3/KFCA/KFTC interpolation $lineType and globalSeqId $globalSeqId', async ({ lineType, globalSeqId }) => {
    const model = parseWar3Mdx(await layeredModelBytes())
    model.Version = 1100
    model.GlobalSequences = [1000]
    const layer = model.Materials[0]!.Layers[1]!
    layer.ShaderTypeId = 1
    const expectedFields: Record<string, unknown> = {}
    for (const field of ['EmissiveGain', 'FresnelColor', 'FresnelOpacity', 'FresnelTeamColor'] as const) {
      const width = field === 'FresnelColor' ? 3 : 1
      const track = {
        LineType: lineType, GlobalSeqId: globalSeqId ?? undefined,
        Keys: [0, 500, 1000].map((Frame, index) => ({
          Frame, Vector: Float32Array.from({ length: width }, (_, channel) => index + channel / 4),
          ...(lineType < 2 ? {} : {
            InTan: Float32Array.from({ length: width }, () => 0.25),
            OutTan: Float32Array.from({ length: width }, () => 0.75),
          }),
        })),
      }
      layer[field] = track
      // The writer accepts an absent global sequence; the native parser normalizes NONE to null.
      expectedFields[field] = { ...track, GlobalSeqId: globalSeqId }
    }
    const written = (await roundTrip(generateWar3Mdx(model))).Materials[0]!.Layers[1]!
    for (const field of ['EmissiveGain', 'FresnelColor', 'FresnelOpacity', 'FresnelTeamColor'] as const)
      expect(written[field]).toEqual(expectedFields[field])
  })
})
