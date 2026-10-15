import { describe, expect, it } from 'vitest'
import type { ModelAnimationClip, ModelMaterialRef, ModelPrimitive } from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'
import { open } from './war3-harness.js'
import { layeredModelBytes } from './war3-layered-model.js'

type Session = Awaited<ReturnType<typeof open>>

async function page<T>(session: Session, contract: string, method: string): Promise<readonly T[]> {
  const lease = await session.dataSource(contract, 1)
  try {
    const source = lease.value as Record<string, (request: { limit: number }) => Promise<{ items: readonly T[] }>>
    return (await source[method]!({ limit: 256 })).items
  } finally {
    await lease.release()
  }
}

interface StandardLayer {
  readonly texturePath: string | null
  readonly constantColor?: { readonly value: readonly number[] }
  readonly teamColorMode: number
  readonly wrapX: boolean
  readonly wrapY: boolean
  readonly alphaFactor?: { readonly value: number }
}
interface Standard {
  readonly layers: { readonly diffuse: StandardLayer }
  readonly blendMode: number
  readonly alphaTestThreshold: number
  readonly twoSided: boolean
  readonly unshaded: boolean
  readonly priority: number
}
const standardOf = (material: ModelMaterialRef): Standard =>
  (material.shader?.parameters['renderModel'] as { standard: Standard }).standard

describe('Warcraft III layers as draw passes', () => {
  it('publishes each layer as its own material with the blend, culling and team colour the game draws', async () => {
    const session = await open(await layeredModelBytes())
    try {
      const materials = await page<ModelMaterialRef>(session, 'common.view/model-material-source', 'materials')
      expect(materials.map(material => material.id)).toEqual([
        'war3-material-0',
        'war3-material-0-layer-1',
        'war3-material-1',
      ])
      expect(materials.every(material => material.shader?.id === 'modkit.render-material.v1')).toBe(true)
      const [teamColor, skin, glow] = materials.map(standardOf) as [Standard, Standard, Standard]
      // Layer 0: the player's colour itself, opaque and unlit.
      expect(teamColor.layers.diffuse).toMatchObject({ texturePath: null, teamColorMode: 1, constantColor: { value: [1, 1, 1, 0] } })
      expect(teamColor).toMatchObject({ blendMode: 0, alphaTestThreshold: 0, unshaded: true, twoSided: false })
      // Layer 1: the skin over it by its alpha — SRC_ALPHA, ONE_MINUS_SRC_ALPHA.
      expect(skin.layers.diffuse).toMatchObject({ texturePath: 'Textures\\Skin.blp', teamColorMode: 0 })
      expect(skin).toMatchObject({ blendMode: 1, unshaded: false })
      expect(materials[1]).toMatchObject({ alphaMode: 'blend', blendMode: 'alpha-blend' })
      // Additive is SRC_ALPHA, ONE (common add-alpha), two-sided and unshaded, faded by its alpha,
      // on its priority plane; its texture wraps U and clamps V.
      expect(glow).toMatchObject({ blendMode: 3, twoSided: true, unshaded: true, priority: -2 })
      expect(glow.layers.diffuse).toMatchObject({ wrapX: true, wrapY: false, alphaFactor: { value: 0.75 } })
      expect(materials[2]).toMatchObject({ alphaMode: 'blend', blendMode: 'additive', priority: -2 })

      // The team-coloured geoset draws twice over the same triangles, first layer first.
      const meshes = await page<{ id: string; primitiveIds: readonly string[] }>(session, 'common.view/model-scene-source', 'meshes')
      expect(meshes.map(mesh => mesh.primitiveIds)).toEqual([
        ['war3-geoset-0-primitive', 'war3-geoset-0-layer-1-primitive'],
        ['war3-geoset-1-primitive'],
      ])
      const lease = await session.dataSource('common.view/model-scene-source', 1)
      try {
        const scene = lease.value as {
          primitive(id: string, request: { maxBytes: number }): Promise<ModelPrimitive>
        }
        const drawn = await Promise.all(
          meshes.flatMap(mesh => mesh.primitiveIds).map(id => scene.primitive(id, { maxBytes: 1 << 20 })),
        )
        expect(drawn.map(primitive => primitive.materialId)).toEqual([
          'war3-material-0',
          'war3-material-0-layer-1',
          'war3-material-1',
        ])
        // Both passes read the geoset's own triangles.
        expect(Array.from(drawn[1]!.indices ?? [])).toEqual(Array.from(drawn[0]!.indices ?? []))
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it("draws an additive team glow as the player's colour weighted by TeamGlow00's red", async () => {
    const session = await open(await layeredModelBytes(0x8, true))
    try {
      const materials = await page<ModelMaterialRef>(session, 'common.view/model-material-source', 'materials')
      const glow = standardOf(materials[2]!) as Standard & { layers: { alpha1?: Record<string, unknown> } }
      expect(glow.layers.diffuse).toMatchObject({ texturePath: null, teamColorMode: 1, constantColor: { value: [1, 1, 1, 0] }, alphaFactor: { value: 0.75 } })
      expect(glow.layers.alpha1).toMatchObject({ channels: 3, teamColorMode: 0, wrapX: true, wrapY: false })
      expect(String(glow.layers.alpha1?.['texturePath'])).toMatch(/TeamGlow00/u)
      expect(glow).toMatchObject({ blendMode: 3 })
    } finally {
      await session.dispose()
    }
  })

  it('hides a geoset through the sequences its geoset animation keys it at zero', async () => {
    const session = await open(await layeredModelBytes())
    try {
      const clips = await page<ModelAnimationClip>(session, 'common.view/model-animation-source', 'clips')
      const visibility = (name: string) =>
        clips
          .find(clip => clip.name === name)
          ?.channels.filter(channel => channel.kind === 'visibility')
          .map(channel => [channel.target, channel.samples.map(sample => sample.value[0])])
      // Stand keys the glow geoset at zero; Death at one, so it gets no channel at all.
      expect(visibility('Stand')).toEqual([['war3-geoset-1-primitive', [0, 0]]])
      expect(visibility('Death')).toEqual([])
    } finally {
      await session.dispose()
    }
  })

  it('exports passes, visibility and the billboarded node to UVM', async () => {
    const session = await open(await layeredModelBytes(), {
      maxInputBytes: 10n ** 8n,
      maxDepth: 128,
      maxNodes: 1_000_000,
      maxScalarBytes: 64 << 20,
      maxDiagnostics: 200,
    })
    try {
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error(`model.export-uvm failed: ${JSON.stringify(result).slice(0, 400)}`)
      const { document } = readUvmContainer(result.output.value as Uint8Array, {
        maxInputBytes: 64 << 20,
        maxJsonBytes: 64 << 20,
        maxDepth: 128,
        maxNodes: 1_000_000,
      }) as unknown as {
        document: {
          meshes: { primitives: { material: number }[] }[]
          materials: { alphaMode?: string; extensions?: { UV_game_material?: { shader: string; blendMode?: string } } }[]
          nodes: { name?: string; extensions?: { UV_node_billboard?: { mode: string; basisRotations: number[][] } } }[]
          extensions: { UV_game_variants?: { visibility: unknown[] } }
          extensionsUsed: string[]
        }
      }
      // Three passes over two geosets.
      expect(document.meshes.map(mesh => mesh.primitives.length).sort()).toEqual([1, 2])
      expect(document.materials.map(material => material.extensions?.UV_game_material?.shader)).toContain(
        'modkit.render-material.v1',
      )
      expect(document.materials.map(material => material.alphaMode ?? 'OPAQUE').sort()).toEqual(['BLEND', 'BLEND', 'OPAQUE'])
      expect(document.extensions.UV_game_variants?.visibility).toHaveLength(1)
      expect(document.extensionsUsed).toEqual(expect.arrayContaining(['KHR_animation_pointer', 'UV_node_billboard']))
      const s = Math.SQRT1_2
      const billboarded = document.nodes.filter(node => node.extensions?.UV_node_billboard !== undefined)
      expect(billboarded.map(node => node.name)).toEqual(['Bone_Glow'])
      // mdx-m3-viewer's MDX basis: rotateY(-π/2), then rotateX(-π/2).
      const basis = billboarded[0]!.extensions!.UV_node_billboard!.basisRotations
      expect(basis.map(rotation => rotation.map(value => Math.round(value * 1e6) / 1e6))).toEqual(
        [
          [0, -s, 0, s],
          [-s, 0, 0, s],
        ].map(rotation => rotation.map(value => Math.round(value * 1e6) / 1e6)),
      )
    } finally {
      await session.dispose()
    }
  })

  it('exports an axis-locked billboard as an aim about its kept axis, the other turned to the viewer', async () => {
    const session = await open(await layeredModelBytes(0x40), {
      maxInputBytes: 10n ** 8n,
      maxDepth: 128,
      maxNodes: 1_000_000,
      maxScalarBytes: 64 << 20,
      maxDiagnostics: 200,
    })
    try {
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error(`model.export-uvm failed: ${JSON.stringify(result).slice(0, 400)}`)
      const { document } = readUvmContainer(result.output.value as Uint8Array, {
        maxInputBytes: 64 << 20,
        maxJsonBytes: 64 << 20,
        maxDepth: 128,
        maxNodes: 1_000_000,
      }) as unknown as { document: { nodes: { name?: string; extensions?: { UV_node_billboard?: Record<string, unknown> } }[] } }
      const glow = document.nodes.find(node => node.extensions?.UV_node_billboard !== undefined)
      expect(glow?.name).toBe('Bone_Glow')
      // Lock Z: the frame's Z kept, its X (Y turned by −90° about Z) toward the viewer.
      expect(glow?.extensions?.UV_node_billboard).toMatchObject({ mode: 'aim', aim: 'view', lock: 'frame-z' })
    } finally {
      await session.dispose()
    }
  })
})
