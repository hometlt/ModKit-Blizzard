import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelMaterialRef, ModelPrimitive } from '@modkit/sdk'
import { extension, open } from './war3-harness.js'
import { layeredModelBytes } from './war3-layered-model.js'

/**
 * A geoset animation's colour (GEOA) tints every pass of its geoset: the Infernal's grey fire is
 * green only by it. A fixed colour is stored red first, a track's keys blue first (mdx-m3-viewer
 * `GeosetAnimation`, WhiteoutFlakes `mdx_model_adapter.cpp`); the geoset's primitive carries the
 * colour as vertex colour, which the pass materials multiply in.
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): { GeosetAnims: Record<string, unknown>[] }
  generateWar3Mdx(model: unknown): Uint8Array
}

async function tinted(color: Float32Array | Record<string, unknown>): Promise<Uint8Array> {
  const model = parseWar3Mdx(await layeredModelBytes())
  model.GeosetAnims[0]!['Color'] = color
  return generateWar3Mdx(model)
}

async function drawn(bytes: Uint8Array) {
  const session = await open(bytes)
  try {
    const materials = await session.dataSource('common.view/model-material-source', 1)
    const scene = await session.dataSource('common.view/model-scene-source', 1)
    try {
      const refs = (
        await (materials.value as { materials(request: { limit: number }): Promise<{ items: ModelMaterialRef[] }> }).materials({
          limit: 64,
        })
      ).items
      const source = scene.value as { primitive(id: string, request: { maxBytes: number }): Promise<ModelPrimitive> }
      return {
        usesVertexColor: refs.map(
          ref => (ref.shader?.parameters['renderModel'] as { standard: { usesVertexColor: boolean } }).standard.usesVertexColor,
        ),
        plain: await source.primitive('war3-geoset-0-primitive', { maxBytes: 1 << 20 }),
        tinted: await source.primitive('war3-geoset-1-primitive', { maxBytes: 1 << 20 }),
      }
    } finally {
      await materials.release()
      await scene.release()
    }
  } finally {
    await session.dispose()
  }
}

const firstColor = (primitive: ModelPrimitive) => Array.from(primitive.colors ?? []).slice(0, 4)

describe('Warcraft III geoset colour', () => {
  it('tints the geoset by its fixed colour, red first as stored', async () => {
    const { usesVertexColor, plain, tinted: green } = await drawn(await tinted(Float32Array.from([0.5, 1, 0])))
    expect(usesVertexColor.every(Boolean)).toBe(true)
    expect(firstColor(green)).toEqual([0.5, 1, 0, 1])
    // An untinted geoset states no colour and reads white.
    expect(plain.colors).toBeUndefined()
  })

  it("tints it by an animated colour's first key, stored blue first", async () => {
    const { tinted: green } = await drawn(
      await tinted({
        LineType: 0,
        GlobalSeqId: null,
        Keys: [{ Frame: 0, Vector: Float32Array.from([0, 1, 0.5]) }],
      }),
    )
    expect(firstColor(green)).toEqual([0.5, 1, 0, 1])
  })
})
