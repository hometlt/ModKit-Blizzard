/**
 * M3 plays a bone track stepped or linear. A cubic-spline track (MDX Hermite/Bezier, glTF
 * CUBICSPLINE) reached the encoder with line type 4: the BONE header took an interpolation M3 does
 * not have and the keys were written as if linear, so the curve between keys was lost.
 */
import { describe, expect, it } from 'vitest'
import { prepareFreshM3RigModel } from '../src/m3/runtime/fresh-rig.js'

const cubic = {
  lineType: 4,
  keys: [
    { frame: 0, vector: [0, 0, 0], inTan: [0, 0, 0], outTan: [3, 0, 0] },
    { frame: 1, vector: [1, 0, 0], inTan: [0, 0, 0], outTan: [0, 0, 0] },
  ],
}

function prepared(track: object) {
  const model = {
    skeleton: { bones: [{}] },
    meshes: [],
    animations: [{ name: 'Stand', durationSeconds: 1, nodeTracks: [{ boneIndex: 0, translation: track }] }],
  }
  return prepareFreshM3RigModel(model, [{}], 1, true) as {
    model: { animations: { nodeTracks: { translation: { lineType: number; keys: { frame: number; vector: number[] }[] } }[] }[] }
    interpolations: Map<string, number>
  }
}

describe('cubic tracks written to M3', () => {
  it('become the linear track the shared sampler draws, keys kept exactly', () => {
    const { model, interpolations } = prepared(cubic)
    const track = model.animations[0]!.nodeTracks[0]!.translation
    expect(track.lineType).toBe(1)
    expect(interpolations.get('0/translation')).toBe(1)
    // 30 frames per second over one second, both authored keys included.
    expect(track.keys).toHaveLength(31)
    expect(track.keys[0]).toEqual({ frame: 0, vector: [0, 0, 0] })
    expect(track.keys.at(-1)).toEqual({ frame: 1, vector: [1, 0, 0] })
    // Hermite at t = 0.5 with an out-tangent of 3: 0.125 * 3 + 0.5 * 1 = 0.875, not the linear 0.5.
    const middle = track.keys.find(key => key.frame === 0.5)
    expect(middle?.vector[0]).toBeCloseTo(0.875, 6)
    expect(track.keys.every(key => !('inTan' in key) && !('outTan' in key))).toBe(true)
  })

  it('leaves linear tracks as they are', () => {
    const linear = { lineType: 1, keys: [{ frame: 0, vector: [0, 0, 0] }, { frame: 1, vector: [1, 0, 0] }] }
    expect(prepared(linear).model.animations[0]!.nodeTracks[0]!.translation.keys).toHaveLength(2)
  })
})
