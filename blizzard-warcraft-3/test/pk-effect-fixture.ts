import type { PkEffect, PkLayer } from '../src/war3-pkb/effect.js'
import type { PkInstruction, PkOperand, PkScript } from '../src/war3-pkb/script.js'

/**
 * The PopcornFX VM runs a layer's compiled scripts over its particles. This effect is one layer
 * whose spawn script gives its particle a life of 0.5 s and a size from a constant, and whose evolve
 * script moves it by a velocity times `scene.dt` — enough to see load/store, arithmetic, the life
 * ratio's advance and death, and the sprites read off the renderer's inputs.
 */
export const operand = (index: number, space: number, kind = 0x20): PkOperand => ({ index, space, kind })
const constant = (...lanes: number[]) => Uint32Array.from(new Uint32Array(Float32Array.from([...lanes, 0, 0, 0, 0].slice(0, 4)).buffer))
const base = { sub: 0, slot: 0, self: 0xffff, swizzle: 0 }
export const load = (dst: PkOperand, slot: number): PkInstruction => ({ ...base, op: 0x43, dst, slot })
const store = (src: PkOperand, slot: number): PkInstruction => ({ ...base, op: 0x44, dst: src, slot })
const binary = (sub: number, dst: PkOperand, a: PkOperand, b: PkOperand): PkInstruction => ({ ...base, op: 0x4e, sub, dst, a, b })

const fields = ['self.lifeRatio', 'self.invLife', 'n1__Position', 'n1__Size', 'n1__Color'].map(name => ({ name, kind: 0x20 }))
const externals = fields.map(field => ({ name: field.name, type: 'float' }))

export function script(kind: number | null, constants: Uint32Array[], code: PkInstruction[], extra: { name: string; type: string }[] = []): PkScript {
  return { record: 0, kind, constants, code, externals: [...externals, ...extra], functions: [], registers: [4, 0, 0] }
}

// spawn: invLife = 2 (life 0.5 s), Size = 0.5, Color = (1, 0.5, 0, 1)
export const spawn = script(
  null,
  [constant(2), constant(0.5), constant(1, 0.5, 0, 1)],
  [store(operand(0, 0), 1), store(operand(1, 0), 3), store(operand(2, 0, 0x23), 4)],
)
// evolve: Position += (0, 0, 10) × dt.xxx (the compiler broadcasts a scalar by a swizzle first)
const evolve = script(
  4,
  [constant(0, 0, 10)],
  [
    load(operand(0, 1, 0x22), 2),
    load(operand(1, 1), 5),
    { ...base, op: 0x4d, swizzle: 0, dst: operand(1, 1, 0x22), a: operand(1, 1) },
    binary(0x02, operand(2, 1, 0x22), operand(0, 0, 0x22), operand(1, 1, 0x22)),
    binary(0x00, operand(3, 1, 0x22), operand(0, 1, 0x22), operand(2, 1, 0x22)),
    store(operand(3, 1, 0x22), 2),
  ],
  [{ name: 'scene.dt', type: 'float' }],
)
export const layer: PkLayer = {
  record: 0,
  name: 'n1',
  fields,
  spawn,
  evolve,
  samplers: [],
  renderers: [
    {
      kind: 'billboard',
      material: 'Default_Billboard.pkma',
      texture: 'Flare.tif',
      billboard: 'screen-aligned',
      blend: 'additive',
      atlas: [1, 1],
      size2d: false,
      flipUvs: false,
      inputs: { Position: 2, Size: 3, Color: 4 },
    },
  ],
  outputPayloads: {},
  inputPayloads: [],
  spatialLayers: [],
  warnings: [],
}
export const effect: PkEffect = { version: 1, layers: [layer], slots: [{ layer: 0, inputEvents: [], outputEvents: [] }], events: [], classes: [], warnings: [] }

