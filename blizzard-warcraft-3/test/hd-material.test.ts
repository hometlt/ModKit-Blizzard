import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelMaterialRef } from '@modkit/sdk'
import { layeredModelBytes } from './war3-layered-model.js'
import { extension, open } from './war3-harness.js'

/**
 * A Reforged HD layer (shader 1) samples an ORM map — occlusion, roughness, metallic, and the team
 * colour mask in its alpha — a BC5 normal map and an emissive map added by the layer's gain. It
 * crosses as the common PBR material: the ORM's channels feed ao, roughness and metalness, and its
 * alpha mixes the player's colour into the base before light (`teamColorMaskMix`).
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): Record<string, unknown>
  generateWar3Mdx(model: unknown): Uint8Array
}

type Layer = Record<string, unknown>
async function hdModel(emissiveGain: number, shading = 0x400): Promise<Uint8Array> {
  const model = parseWar3Mdx(await layeredModelBytes())
  model['Version'] = 1100
  const textures = model['Textures'] as Record<string, unknown>[]
  const add = (image: string) => textures.push({ Image: image, ReplaceableId: 0, Flags: 3 }) - 1
  const normal = add('Units/Test/Test_Normal.tif')
  const orm = add('Units/Test/Test_ORM.tif')
  const emissive = add('Units/Test/Test_Emissive.tif')
  for (const material of model['Materials'] as { Layers: Layer[] }[])
    for (const layer of material.Layers) layer['ShaderTypeId'] = 0
  const skin = (model['Materials'] as { Layers: Layer[] }[])[0]!.Layers[1]!
  Object.assign(skin, { Shading: shading, ShaderTypeId: 1, NormalTextureID: normal, ORMTextureID: orm, EmissiveTextureID: emissive, EmissiveGain: emissiveGain })
  for (const geoset of model['Geosets'] as { TVertices: Float32Array[] }[])
    geoset.TVertices.push(Float32Array.from([0.25, 0.25, 0.75, 0.25, 0.25, 0.75]))
  return generateWar3Mdx(model)
}

async function materials(bytes: Uint8Array): Promise<readonly ModelMaterialRef[]> {
  const session = await open(bytes)
  try {
    const lease = await session.dataSource('common.view/model-material-source', 1)
    try {
      return (await (lease.value as { materials(r: { limit: number }): Promise<{ items: ModelMaterialRef[] }> }).materials({ limit: 64 })).items
    } finally {
      await lease.release()
    }
  } finally {
    await session.dispose()
  }
}

type Standard = Record<string, unknown> & { layers: Record<string, Record<string, unknown>> }
const standardOf = (material: ModelMaterialRef) =>
  (material.shader?.parameters['renderModel'] as { standard: Standard }).standard

describe('Warcraft III Reforged HD materials', () => {
  it.each(['numeric', 'named'])('refuses %s Crystal rather than substituting ordinary HD', async kind => {
    const model = parseWar3Mdx(await hdModel(1))
    const material = (model['Materials'] as { Shader?: string; Layers: Layer[] }[])[0]!
    if (kind === 'numeric') material.Layers[1]!['ShaderTypeId'] = 24
    else {
      model['Version'] = 1000
      material.Shader = 'Shader_HD_Crystal'
    }
    await expect(open(generateWar3Mdx(model))).rejects.toThrow('Crystal shader (24/Shader_HD_Crystal)')
  })
  it('cross as the PBR material with the ORM channels and the team mask in its alpha', async () => {
    const found = await materials(await hdModel(0.5))
    const hd = standardOf(found.find(material => material.id === 'war3-material-0-layer-1')!)
    expect(hd).toMatchObject({
      lightingModel: 'pbr-metallic-roughness',
      metallicFactor: 1,
      roughnessFactor: 1,
      colorPipeline: 'linear-srgb',
      normalMapFormat: 'bc5',
      teamColorMaskMix: true,
      environmentTintByBase: true,
      emisMult: 0.5,
    })
    const orm = 'Units/Test/Test_ORM.tif'
    expect(hd.layers['normal']).toMatchObject({ texturePath: 'Units/Test/Test_Normal.tif', channels: 1 })
    expect(hd.layers['ao']).toMatchObject({ texturePath: orm, channels: 3, uvSource: 1 })
    expect(hd.layers['roughness']).toMatchObject({ texturePath: orm, channels: 4 })
    expect(hd.layers['metalness']).toMatchObject({ texturePath: orm, channels: 5 })
    expect(hd.layers['teamColorMask']).toMatchObject({ texturePath: orm, channels: 2 })
    expect(hd.layers['emissive1']).toMatchObject({ texturePath: 'Units/Test/Test_Emissive.tif', op: 6 })
    // Metal reflects the game's sky (the specular element of its day probe), where the ORM is metallic.
    expect(hd.layers['envi']).toMatchObject({
      texturePath: 'Environment/EnvironmentMap/LordaeronSummer/Day_IBL.dds#layer=1&mip=3&faces=0,5,2,3,4,1',
      uvSource: 2,
      op: 2,
    })
    expect(hd.layers['enviMask']).toMatchObject({ texturePath: orm, channels: 5 })
    // The classic layers of the same model keep the fixed-function material.
    const classic = standardOf(found.find(material => material.id === 'war3-material-0')!)
    expect(classic['lightingModel']).toBeUndefined()
    expect(Object.keys(classic.layers)).toEqual(['diffuse'])
  })

  it('leaves the emissive map out when the layer’s gain is a static 0', async () => {
    const hd = standardOf((await materials(await hdModel(0))).find(material => material.id === 'war3-material-0-layer-1')!)
    expect(hd.layers['emissive1']).toBeUndefined()
    expect(hd['emisMult']).toBe(0)
  })

  it('does not apply baked AO when the native AmbientOcclusion flag is absent', async () => {
    const hd = standardOf((await materials(await hdModel(1, 0))).find(material => material.id === 'war3-material-0-layer-1')!)
    expect(hd.layers['ao']).toBeUndefined()
  })
})
