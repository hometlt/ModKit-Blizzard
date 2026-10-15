import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const extension = join(import.meta.dirname, '..')
const { diablo3Materials } = (await import(pathToFileURL(join(extension, 'dist', 'diablo3-app', 'scene.js')).href)) as {
  diablo3Materials: (model: unknown) => any[]
}

const pass = (effect: string) => ({
  shader: 'actor2_opaque_bump_gloss_skin',
  effect,
  pixelEntry: 'main',
  cull: 1,
  depthWrite: true,
  alphaTest: false,
  alphaFunc: 0,
  alphaRef: 0,
  blend: false,
  blendSource: 2,
  blendDestination: 1,
  stages: [1, 25, 3, 8, 5, 4],
})
const model = (effect: string) => ({
  meshes: [],
  skeleton: { bones: [] },
  materials: [
    {
      name: 'armor',
      layers: (
        [
          ['diffuse', 1],
          ['normal', 3],
          ['environment', 4],
          ['specular', 5],
        ] as const
      ).map(([label, slot]) => ({ label, path: `Textures/${String(slot)}.tex`, metadata: { slot } })),
      metadata: { renderPass: pass(effect) },
    },
  ],
})

describe('Diablo III material program', () => {
  it('states the ActorIrrad normal, gloss and environment as the compiled ps_3_0 reads them', () => {
    const standard = diablo3Materials(model('ActorIrrad.fx'))[0].shader.parameters.renderModel.standard
    expect(standard.layers.normal).toMatchObject({ texturePath: 'Textures/3.tex', uvSource: 0 })
    // a 2D environment map indexed by the reflection, added under the gloss map
    expect(standard.layers.envi).toMatchObject({ texturePath: 'Textures/4.tex', uvSource: 3, channels: 0, op: 2 })
    expect(standard.layers.enviMask).toMatchObject({ texturePath: 'Textures/5.tex', channels: 0 })
    expect(standard).toMatchObject({ normalMapFormat: 'rgb8', environmentMultipliers: [0.5, 0, 0.5], specularity: 0 })
  })

  it('leaves them out of programs whose formula is not the actor one', () => {
    const standard = diablo3Materials(model('Scene.fx'))[0].shader.parameters.renderModel.standard
    expect(Object.keys(standard.layers)).toEqual(['diffuse'])
    expect(standard.normalMapFormat).toBeUndefined()
  })
})
