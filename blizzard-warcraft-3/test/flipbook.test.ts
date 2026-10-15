import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelAnimationClip, ModelMaterialRef } from '@modkit/sdk'
import { layeredModelBytes } from './war3-layered-model.js'
import { budget as hostBudget, extension, open } from './war3-harness.js'

/**
 * A texture-id track (KMTF: Reforged's water, fountains, coral) flips a layer through its textures.
 * The layer becomes one pass per texture, each shown only while the track names its texture — on a
 * global sequence, cycle after cycle from the sequence's start.
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): Record<string, unknown>
  generateWar3Mdx(model: unknown): Uint8Array
}

async function flipbookModel(): Promise<Uint8Array> {
  const model = parseWar3Mdx(await layeredModelBytes())
  model['GlobalSequences'] = [400]
  const textures = model['Textures'] as Record<string, unknown>[]
  const a = textures.push({ Image: 'Textures\\Water_0.blp', ReplaceableId: 0, Flags: 3 }) - 1
  const b = textures.push({ Image: 'Textures\\Water_1.blp', ReplaceableId: 0, Flags: 3 }) - 1
  const skin = (model['Materials'] as { Layers: Record<string, unknown>[] }[])[0]!.Layers[1]!
  skin['TextureID'] = {
    LineType: 0,
    GlobalSeqId: 0,
    Keys: [
      { Frame: 0, Vector: Int32Array.from([a]) },
      { Frame: 200, Vector: Int32Array.from([b]) },
    ],
  }
  return generateWar3Mdx(model)
}

describe('Warcraft III texture-id flipbooks', () => {
  it('draw one pass per texture, each shown while the track names it', async () => {
    const session = await open(await flipbookModel(), { ...hostBudget, maxNodes: 100_000 })
    try {
      const materialLease = await session.dataSource('common.view/model-material-source', 1)
      let materials: readonly ModelMaterialRef[]
      try {
        materials = (await (materialLease.value as { materials(r: { limit: number }): Promise<{ items: ModelMaterialRef[] }> }).materials({ limit: 64 })).items
      } finally {
        await materialLease.release()
      }
      const flips = materials.filter(material => material.id.startsWith('war3-material-0-layer-1'))
      expect(flips.map(material => material.id)).toEqual(['war3-material-0-layer-1-frame-3', 'war3-material-0-layer-1-frame-4'])
      const diffuse = (material: ModelMaterialRef) =>
        (material.shader?.parameters['renderModel'] as { standard: { layers: { diffuse: { texturePath: string } } } }).standard.layers.diffuse.texturePath
      expect(flips.map(diffuse)).toEqual(['Textures\\Water_0.blp', 'Textures\\Water_1.blp'])

      const clipLease = await session.dataSource('common.view/model-animation-source', 1)
      try {
        const clips = (await (clipLease.value as { clips(r: { limit: number }): Promise<{ items: ModelAnimationClip[] }> }).clips({ limit: 16 })).items
        // Stand runs 0-1000 ms: the 400 ms cycle shows frame 3 for 0-200, frame 4 for 200-400, again and again.
        const stand = clips.find(clip => clip.name === 'Stand')!
        const visible = (target: string) =>
          stand.channels
            .find(channel => channel.kind === 'visibility' && channel.target === target)
            ?.samples?.map(sample => [Math.round(sample.timeSeconds * 1000), sample.value[0]])
        expect(visible('war3-geoset-0-layer-1-frame-3-primitive')).toEqual([
          [0, 1], [200, 0], [400, 1], [600, 0], [800, 1], [1000, 0],
        ])
        expect(visible('war3-geoset-0-layer-1-frame-4-primitive')).toEqual([
          [0, 0], [200, 1], [400, 0], [600, 1], [800, 0], [1000, 1],
        ])
      } finally {
        await clipLease.release()
      }
    } finally {
      await session.dispose()
    }
  })
})
