/** Native MDX UV sets survive the public geometry facet, UVM and the native encoder. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelPrimitive } from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'
import { layeredModelBytes } from './war3-layered-model.js'
import { extension, open } from './war3-harness.js'

const { parseWar3Mdx, generateWar3Mdx, war3ModelToRenderModel } = await import(
  pathToFileURL(join(extension, 'dist/war3-mdx/render-model.js')).href,
) as typeof import('../dist/war3-mdx/render-model.js')
const { exportWar3FromUvm } = await import(
  pathToFileURL(join(extension, 'dist/war3-mdx/native-encoder.js')).href,
) as typeof import('../dist/war3-mdx/native-encoder.js')
const containerBudget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }

describe('Warcraft III authored UV sets', () => {
  it('keeps four different sets and selects CoordId without confusing UV2 with reflection', async () => {
    const model = parseWar3Mdx(await layeredModelBytes())
    const sets = Array.from({ length: 4 }, (_, set) => Float32Array.from([set / 4, 0, 1, set / 4, 0, 1]))
    for (const geoset of model.Geosets) geoset.TVertices = sets
    model.Materials[0]!.Layers[1]!.CoordId = 2
    const session = await open(generateWar3Mdx(model))
    let uvm: Uint8Array
    try {
      const scene = await session.dataSource('common.view/model-scene-source', 1)
      try {
        const primitive = await (scene.value as { primitive(id: string, request: { maxBytes: number }): Promise<ModelPrimitive> })
          .primitive('war3-geoset-0-layer-1-primitive', { maxBytes: 1 << 20 })
        expect(primitive.textureCoordinateSets?.map(channel => [...channel.coordinates])).toEqual(sets.map(set => [...set]))
      } finally { await scene.release() }
      const material = await session.dataSource('common.view/model-material-source', 1)
      try {
        const found = (await (material.value as import('@modkit/sdk').ModelMaterialSource).materials({ limit: 64 }))
          .items.find(item => item.id === 'war3-material-0-layer-1')!
        const render = found.shader!.parameters['renderModel'] as { standard: { layers: { diffuse: { uvSource: number } } } }
        expect(render.standard.layers.diffuse.uvSource).toBe(9)
        expect(found.layers?.find(layer => layer.slot === 'base-color')?.uvSource ?? found.layers?.[0]?.uvSource).toBe(2)
      } finally { await material.release() }
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(JSON.stringify(result))
      uvm = result.output.value as Uint8Array
    } finally { await session.dispose() }
    const { document } = readUvmContainer(uvm!, containerBudget)
    const meshes = document['meshes'] as { primitives: { attributes: Record<string, number> }[] }[]
    expect(Object.keys(meshes[0]!.primitives[0]!.attributes)).toEqual(expect.arrayContaining(['TEXCOORD_0', 'TEXCOORD_1', 'TEXCOORD_2', 'TEXCOORD_3']))
    const written = parseWar3Mdx(exportWar3FromUvm(uvm!, containerBudget))
    expect(written.Geosets[0]!.TVertices.map(set => [...set])).toEqual(sets.map(set => [...set]))
    expect(written.Materials[0]!.Layers[1]!.CoordId).toBe(2)
  })

  it('refuses malformed and unsupported UV sets instead of silently deleting them', async () => {
    const model = parseWar3Mdx(await layeredModelBytes())
    model.Geosets[0]!.TVertices.push(new Float32Array(2))
    expect(() => war3ModelToRenderModel(model, 'mdx')).toThrow('does not match its vertex count')
    model.Geosets[0]!.TVertices = Array.from({ length: 5 }, () => new Float32Array(6))
    expect(() => war3ModelToRenderModel(model, 'mdx')).toThrow('four supported UV sets')
  })
})
