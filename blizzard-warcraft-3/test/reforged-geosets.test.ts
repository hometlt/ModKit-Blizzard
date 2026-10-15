import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelLodLevelRef, ModelPrimitive } from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'
import { layeredModelBytes } from './war3-layered-model.js'
import { budget as hostBudget, extension, open } from './war3-harness.js'

/**
 * Reforged geosets carry their own skin (SKIN: four bone indices, then four weights in 1/255),
 * authored tangents (TANG) and a level of detail. The game draws LOD 0 (and -1) only; the coarser
 * copies are levels a viewer switches to, never drawn on top of the full model.
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): Record<string, unknown>
  generateWar3Mdx(model: unknown): Uint8Array
}
const budget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }

async function reforgedModel(): Promise<Uint8Array> {
  const model = parseWar3Mdx(await layeredModelBytes())
  model['Version'] = 1100
  for (const material of model['Materials'] as { Layers: Record<string, unknown>[] }[])
    for (const layer of material.Layers) layer['ShaderTypeId'] = 0
  // A second bone for the weighted vertex.
  const bone = { Name: 'Bone_Arm', ObjectId: 1, Parent: 0, PivotPoint: Float32Array.from([1, 0, 0]), Flags: 0x100, GeosetId: 0, GeosetAnimId: -1 }
  ;(model['Bones'] as unknown[]).push(bone)
  ;(model['Nodes'] as unknown[]).push(bone)
  ;(model['PivotPoints'] as unknown[]).push(Float32Array.from([1, 0, 0]))
  const geosets = model['Geosets'] as Record<string, unknown>[]
  for (const geoset of geosets) {
    geoset['LevelOfDetail'] = 0
    geoset['Name'] = 'body'
  }
  const first = geosets[0]!
  // Vertex 0 hangs on bones 0 and 1 by 192 and 63; the others on bone 0 alone.
  first['SkinWeights'] = Uint8Array.from([0, 1, 0, 0, 192, 63, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0])
  first['Tangents'] = Float32Array.from([1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1])
  // A coarser copy of the first geoset.
  geosets.push({ ...first, LevelOfDetail: 1, Name: 'body_LOD1' })
  return generateWar3Mdx(model)
}

describe('Warcraft III Reforged geosets', () => {
  it('skin by SKIN weights, keep their tangents and publish their levels of detail', async () => {
    const session = await open(await reforgedModel(), { ...hostBudget, maxNodes: 100_000 })
    let bytes: Uint8Array
    try {
      const lods = await session.dataSource('common.view/model-lod-source', 1)
      try {
        const levels = (await (lods.value as { levels(r: { limit: number }): Promise<{ items: ModelLodLevelRef[] }> }).levels({ limit: 8 })).items
        expect(levels.map(level => [level.order, level.nodeIds])).toEqual([
          [0, ['war3-geoset-node-0', 'war3-geoset-node-1']],
          [1, ['war3-geoset-node-2']],
        ])
      } finally {
        await lods.release()
      }
      const scene = await session.dataSource('common.view/model-scene-source', 1)
      try {
        const primitive = await (scene.value as { primitive(id: string, r: { maxBytes: number }): Promise<ModelPrimitive> }).primitive(
          'war3-geoset-0-primitive',
          { maxBytes: 1 << 20 },
        )
        expect([...(primitive.boneIndices ?? [])].slice(0, 4)).toEqual([0, 1, 0, 0])
        expect([...(primitive.boneWeights ?? [])].slice(0, 2).map(weight => Number(weight.toFixed(4)))).toEqual([0.7529, 0.2471])
        expect([...(primitive.tangents ?? [])].slice(4, 8)).toEqual([1, 0, 0, -1])
      } finally {
        await scene.release()
      }
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
      bytes = result.output.value as Uint8Array
    } finally {
      await session.dispose()
    }
    // The UVM groups each level under one node; LOD 0 stays in the scene and names LOD 1 in MSFT_lod.
    const { document } = readUvmContainer(bytes, budget)
    const nodes = document['nodes'] as { name?: string; extensions?: Record<string, { ids: number[] }> }[]
    const top = nodes.find(node => node.name === 'uv:lod-0')!
    expect(top.extensions?.['MSFT_lod']?.ids.map(id => nodes[id]!.name)).toEqual(['uv:lod-1'])
    expect(document['extensionsUsed']).toContain('MSFT_lod')
  })
})
