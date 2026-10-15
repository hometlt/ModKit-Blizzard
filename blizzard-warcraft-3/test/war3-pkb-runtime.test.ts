import { describe, expect, it } from 'vitest'
import { PkEffectInstance, PkLayerState, createPkEnvironment, samplePkShape } from '../src/war3-pkb/runtime.js'
import { collectPkSprites, type PkSpriteBatch } from '../src/war3-pkb/sprites.js'
import type { PkLayer } from '../src/war3-pkb/effect.js'
import { effect } from './pk-effect-fixture.js'

describe('the PopcornFX VM', () => {
  it('spawns, moves, ages and kills a particle, and reads its sprite', () => {
    const fx = new PkEffectInstance(effect, createPkEnvironment(), 1)
    fx.update(0.1) // spawn, then one evolve step is skipped for the newborn
    fx.update(0.1)
    const batches = new Map<string, PkSpriteBatch>()
    collectPkSprites(fx, batches)
    const [sprite] = [...batches.values()][0]!.sprites
    expect(sprite!.position[2]).toBeCloseTo(1, 5)
    expect(sprite!.halfSize).toEqual([0.5, 0.5])
    expect(sprite!.color).toEqual([1, 0.5, 0, 1])
    expect(fx.slots[0]!.floatField(0, 0)).toBeCloseTo(0.2, 5) // life ratio after one 0.1 s step at 2/s
    for (let step = 0; step < 5; step++) fx.update(0.1)
    expect(fx.slots[0]!.count).toBe(0)
    expect(fx.alive).toBe(false)
    expect([...fx.unsupported]).toEqual([])
  })

  it('samples shapes in the effect’s Z-up frame and repeats a seed exactly', () => {
    const random = () => 0.5
    // a cylinder of height 2 sampled at the middle: its axis (Y up in the shape) becomes Z
    expect(samplePkShape({ type: 3, radius: 1, innerRadius: 0, height: 2, offset: [0, 1, 0], eulerDegrees: [0, 0, 0] }, random)[2]).toBeCloseTo(1)
    const run = () => {
      const fx = new PkEffectInstance(effect, createPkEnvironment(), 42)
      fx.update(0.05)
      fx.update(0.05)
      return fx.slots[0]!.fields.map(field => [...field.subarray(0, 4)])
    }
    expect(run()).toEqual(run())
  })
})

describe('PopcornFX ribbons', () => {
  it('give each ribbon its points in SelfID order as one strip, by ParentID', () => {
    const fields = ['SelfID', 'ParentID', 'Position', 'Size', 'Color'].map(name => ({ name, kind: 0x20 }))
    const layer: PkLayer = {
      record: 0,
      name: 'trail',
      fields,
      samplers: [],
      renderers: [
        {
          kind: 'ribbon',
          material: 'Default_Ribbon.pkma',
          texture: 'Beam.tif',
          billboard: 'screen-aligned',
          blend: 'additive',
          atlas: [1, 1],
          size2d: false,
          flipUvs: false,
          inputs: { SelfID: 0, ParentID: 1, Position: 2, Size: 3, Color: 4 },
        },
      ],
      outputPayloads: {},
      inputPayloads: [],
      spatialLayers: [],
      warnings: [],
    }
    const state = new PkLayerState(layer, 0)
    // ribbon 7: ids 2, 0, 1 at x 2, 0, 1 (out of order); ribbon 9: a lone particle
    for (const [self, parent, x] of [[2, 7, 2], [0, 7, 0], [1, 7, 1], [0, 9, 5]] as const) {
      const particle = state.allocate()
      state.writeIdentity(particle, 0)
      // the VM numbers particles by birth: SelfID 0..3, ParentID as given
      state.fields[0]![particle * 4] = self
      state.fields[1]![particle * 4] = parent
      state.floats[2]![particle * 4] = x
      state.floats[3]![particle * 4] = 0.25
      state.floats[4]!.set([1, 1, 1, 1], particle * 4)
    }
    const batches = new Map<string, PkSpriteBatch>()
    collectPkSprites({ slots: [state], effect: { layers: [layer] } } as unknown as PkEffectInstance, batches)
    const sprites = [...batches.values()][0]!.sprites
    // ribbon 7 in order as strip 0; ribbon 9's lone point makes no strip
    expect(sprites.map(sprite => [sprite.position[0], sprite.axis[0], sprite.halfSize[0], sprite.halfSize[1]])).toEqual([
      [0, 0, 0.25, 0],
      [1, 0, 0.25, 0],
      [2, 0, 0.25, 0],
    ])
  })
})

describe('PopcornFX identities', () => {
  it('number particles by birth, keep the number when earlier ones die, and pass the parent', () => {
    const state = new PkLayerState({ ...effect.layers[0]!, fields: [{ name: 'SelfID', kind: 0x20 }, { name: 'ParentID', kind: 0x20 }] }, 2)
    for (let index = 0; index < 3; index++) state.writeIdentity(state.allocate(), 5)
    state.killed[0] = true
    state.compact()
    expect([state.floatField(0, 0), state.floatField(0, 1)]).toEqual([1, 2])
    expect(state.floatField(1, 0)).toBe(5)
    expect(state.identity(1)).toBe(3 * 65536 + 2)
  })
})
