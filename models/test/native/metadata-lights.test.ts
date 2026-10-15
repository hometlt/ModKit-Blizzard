import { describe, expect, it } from 'vitest'
import type { M3Reference, M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'
import { buildLights } from '../../dist/m3/native/builder/metadata.js'

describe('M3 LITE metadata', () => {
  it('keeps distance decay separate from the scalar attenuation end distance', () => {
    const lightRef = reference(1)
    const source = structure({ lights: lightRef })
    const light = structure({
      shape: 1,
      bone: 7,
      flags: 0x1f,
      color: anim({ x: 0.25, y: 0.5, z: 0.75 }),
      intensity: anim(2),
      spec_color: anim({ x: 1, y: 0.5, z: 0.25 }),
      spec_intensity: anim(3),
      decay: anim(2.5),
      attenuation_far: 64,
      attenuation_near: anim(8),
      hotspot: anim(0.75),
      falloff: anim(1.25),
    })

    expect(buildLights(source, resolver(new Map([[lightRef, [light]]])))).toEqual([
      {
        index: 0,
        name: 'Light_0',
        type: 1,
        shape: 'Point',
        boneIndex: 7,
        flags: 0x1f,
        color: [0.25, 0.5, 0.75],
        intensity: 2,
        specularColor: [1, 0.5, 0.25],
        specularIntensity: 3,
        decay: 2.5,
        attenuationNear: 8,
        attenuationFar: 64,
        hotspot: 0.75,
        falloff: 1.25,
      },
    ])
  })
})

function reference(index: number): M3Reference {
  return { entries: 1, index, flags: 0 } as M3Reference
}

function structure(values: Record<string, unknown>): M3StructureData {
  return values as unknown as M3StructureData
}

function anim(value: number | Record<string, number>): M3StructureData {
  return structure({ default: typeof value === 'number' ? value : structure(value) })
}

function resolver(contents: Map<M3Reference, unknown[]>): SectionResolver {
  return {
    getSectionByReference: ref => {
      if (!ref) return null
      const content = contents.get(ref)
      return content ? ({ content } as never) : null
    },
  }
}
