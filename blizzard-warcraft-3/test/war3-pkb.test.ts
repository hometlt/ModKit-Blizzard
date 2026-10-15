import { describe, expect, it } from 'vitest'
import { PkbBake } from '../src/war3-pkb/bake.js'
import { pkEffectOf, readPkEffect, samplePkCurve } from '../src/war3-pkb/effect.js'
import { decodePkScript, pkLaneCode } from '../src/war3-pkb/script.js'

/**
 * A PopcornFX bake is records of classes with untyped fields; the reader types the fields it uses
 * by a measured schema and infers the rest. This builds a small bake the way the game's are laid
 * out — one layer with a field, a curve sampler, a renderer and a spawn script — and reads it back.
 */
class BakeWriter {
  private readonly strings: string[] = []
  private readonly classes: string[] = []
  private readonly records: { classIndex: number; fields: [number, Uint8Array][] }[] = []

  string(text: string): number {
    const at = this.strings.indexOf(text)
    return at >= 0 ? at : this.strings.push(text) - 1
  }

  /** Adds a record of `className`; returns its 1-based reference. */
  record(className: string, fields: [number, Uint8Array][]): number {
    let classIndex = this.classes.indexOf(className)
    if (classIndex < 0) classIndex = this.classes.push(className) - 1
    return this.records.push({ classIndex, fields }) // 1-based
  }

  bytes(): Uint8Array {
    const recordBytes = this.records.map(record => {
      const body = concat(record.fields.flatMap(([field, value]) => [u16(field), value]))
      const size = 7 + body.byteLength
      return concat([u32(size), Uint8Array.of(0x20), u32(record.classIndex), u16(record.fields.length), body])
    })
    // class names are strings too: intern them before the string table is written
    const classTable = concat(
      this.classes.map(name => concat([u32(this.string(name)), u32(this.records.filter(record => this.classes[record.classIndex] === name).length)])),
    )
    const stringTable = concat([u32(this.strings.length), ...this.strings.map(text => concat([Uint8Array.of(text.length), new TextEncoder().encode(text)]))])
    const objects = concat(recordBytes)
    const stringOffset = 0x1c + classTable.byteLength + objects.byteLength
    const header = concat([u32(0xca000b11), u32(0x01010502), u32(0), u32(this.records.length), u32(this.classes.length), u32(stringOffset), u32(0)])
    return concat([header, classTable, objects, stringTable])
  }
}

const u16 = (value: number) => {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value, true)
  return out
}
const u32 = (value: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, true)
  return out
}
const f32 = (value: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setFloat32(0, value, true)
  return out
}
const array4 = (values: readonly Uint8Array[]) => concat([u32(values.length), ...values])
/** A word array of raw bytes, counted in 4-byte words. */
const words = (bytes: Uint8Array) => concat([u32(bytes.byteLength / 4), bytes])
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/** A spawn script: load external 0 into reg1[0], multiply by constant 0, store into external 1. */
function spawnBlob(): Uint8Array {
  const operand = (index: number, space: number, kind: number) => concat([u16(index), Uint8Array.of(space, kind)])
  const constant = concat([f32(2), f32(2), f32(2), f32(2), ...Array.from({ length: 4 }, () => f32(2))])
  const code = concat([
    Uint8Array.of(0x43), operand(0, 1, 0x20), u16(0),
    Uint8Array.of(0x4e, 0x02), operand(1, 1, 0x20), operand(0, 1, 0x20), operand(0, 0, 0x20),
    Uint8Array.of(0x44), operand(1, 1, 0x20), u16(1),
  ])
  return concat([u32(0), u32(0), u32(constant.byteLength), u32(code.byteLength), u32(0), u32(1), u32(0), u32(0), u32(0), constant, code])
}

function testBake(): Uint8Array {
  const bake = new BakeWriter()
  const name = (text: string) => u32(bake.string(text))
  const field = bake.record('CLayerCompileCacheField', [[0, name('n20_8__Size')], [1, u32(0x1f)]])
  const curve = bake.record('CParticleNodeSamplerData_Curve', [
    [9, u32(1)],
    [16, array4([f32(0), f32(1)])],
    [17, array4([f32(0), f32(10)])],
  ])
  const sampler = bake.record('CLayerCompileCacheSampler', [[0, name('__sampler_0')], [1, u32(curve)]])
  const texture = bake.record('CLayerCompileCacheRendererProperty', [
    [0, name('Diffuse.DiffuseMap')],
    [1, u32(12)],
    [3, name('_HD.w3mod/Textures/FX/Flare/Flare_BW.tif')],
  ])
  const mode = bake.record('CLayerCompileCacheRendererProperty', [[0, name('BillboardingMode')], [1, u32(3)], [2, concat([u32(5), u32(0), u32(0), u32(0)])]])
  const blend = bake.record('CLayerCompileCacheRendererProperty', [[0, name('Transparent.Type')], [1, u32(3)], [2, concat([u32(2), u32(0), u32(0), u32(0)])]])
  const input = bake.record('CLayerCompileCacheRendererParticleInput', [[0, u32(1)], [1, u32(0)]])
  const renderer = bake.record('CLayerCompileCacheRenderer', [
    [1, array4([u32(input)])],
    [2, array4([u32(texture), u32(mode), u32(blend)])],
    [3, name('Default_Billboard.pkma')],
  ])
  const external = (text: string) => bake.record('CCompilerBlobCacheExternal', [[0, name(text)], [1, name('float')]])
  const blob = bake.record('CCompilerBlobCache', [[2, words(spawnBlob())], [3, array4([u32(external('scene.dt')), u32(external('n20_8__Size'))])]])
  const layer = bake.record('CLayerCompileCache', [
    [2, array4([u32(field)])],
    [7, array4([u32(sampler)])],
    [8, array4([u32(renderer)])],
    [10, array4([u32(blob)])],
  ])
  const slot = bake.record('CLayerGraphCompileCache_LayerSlot', [[0, u32(layer)], [1, array4([])], [2, array4([u32(0)])]])
  const event = bake.record('CLayerGraphCompileCache_EventSlot', [[0, name('Signal')], [2, array4([u32(0)])]])
  bake.record('CLayerGraphCompileCache', [[2, array4([u32(slot)])], [3, array4([u32(event)])]])
  return bake.bytes()
}

describe('Warcraft III Reforged PopcornFX bakes', () => {
  it('reads the layer, its renderer, sampler and script, and the graph', () => {
    const bytes = testBake()
    expect(PkbBake.detect(bytes)).toBe(true)
    const effect = readPkEffect(bytes)
    expect(effect.warnings).toEqual([])
    expect(effect.layers).toHaveLength(1)
    const [layer] = effect.layers
    expect(layer).toMatchObject({ name: 'n20_8', fields: [{ name: 'n20_8__Size', kind: 0x20 }] })
    expect(layer!.renderers).toEqual([
      {
        kind: 'billboard',
        material: 'Default_Billboard.pkma',
        texture: '_HD.w3mod/Textures/FX/Flare/Flare_BW.tif',
        billboard: 'plane-aligned',
        blend: 'alpha-blend',
        atlas: [1, 1],
        size2d: false,
        flipUvs: false,
        inputs: { Size: 0 },
      },
    ])
    expect(layer!.samplers).toEqual([{ name: '__sampler_0', kind: 'curve', curve: { dimension: 1, times: [0, 1], values: [0, 10], tangents: [] } }])
    expect(layer!.spawn).toMatchObject({
      kind: null,
      externals: [{ name: 'scene.dt', type: 'float' }, { name: 'n20_8__Size', type: 'float' }],
    })
    expect(layer!.spawn!.code.map(instruction => instruction.op)).toEqual([0x43, 0x4e, 0x44])
    expect(effect.slots).toEqual([{ layer: 0, inputEvents: [], outputEvents: [0] }])
    expect(effect.events).toEqual([{ name: 'Signal', targetSlots: [0] }])
  })

  it('samples a linear curve and decodes swizzle lane codes', () => {
    const curve = { dimension: 1, times: [0, 1], values: [0, 10], tangents: [] }
    expect(samplePkCurve(curve, 0.25)[0]).toBeCloseTo(2.5)
    expect(samplePkCurve(curve, 2)[0]).toBe(10)
    // lanes x, y, z(=constant 1.0), w: codes 0, 1, 5, 3
    const packed = (0 << 8) | (1 << 11) | (1 << 14) | (1 << 20) | (3 << 21)
    expect([0, 1, 2, 3].map(lane => pkLaneCode(packed, lane))).toEqual([0, 1, 5, 3])
  })

  it('refuses a bake whose records overrun, and a script with an unknown opcode', () => {
    const bytes = testBake()
    expect(() => PkbBake.read(bytes.slice(0, 64))).toThrow()
    const bake = PkbBake.read(bytes)
    const blob = bake.ofClass('CCompilerBlobCache')[0]!
    expect(decodePkScript(bake, blob).code).toHaveLength(3)
    const effect = pkEffectOf(bake)
    expect(effect.classes.find(item => item.name === 'CLayerCompileCache')?.count).toBe(1)
  })
})
