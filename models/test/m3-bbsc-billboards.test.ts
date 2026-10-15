import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * StarCraft II billboards come from BBSC records, not BONE flags (WhiteoutFlakes: no bone of the
 * 51 469 files of the SC2 and HotS corpora sets 0x10 or 0x40). Each record becomes the bone's
 * `aim` camera rule, in the engine's own terms (CBBSolver::ApplyBillboard, as WhiteoutFlakes
 * reads it).
 */
type Quaternion = readonly [number, number, number, number]
const { m3AimBillboard } = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'dist', 'm3', 'skeleton-projection.js')).href
)) as {
  m3AimBillboard(record: {
    bone: number
    type: number
    cameraLookAt: boolean
    up?: Quaternion
    forward?: Quaternion
  }): unknown
}
const s = Math.SQRT1_2
const turn: Quaternion = [0, 0, s, s]
const identity32: Quaternion = [0, 0, 0, 0.9999998807907104]

describe('BBSC records as camera rules', () => {
  it('locks world X, Y and Z by types 0, 1 and 2 and composes their up correction on every bone', () => {
    expect(m3AimBillboard({ bone: 0, type: 2, cameraLookAt: true, up: turn, forward: identity32 })).toEqual({
      mode: 'aim',
      aim: 'eye',
      lock: 'frame-z',
      correction: turn,
      rootCorrection: turn,
    })
    expect(m3AimBillboard({ bone: 0, type: 0, cameraLookAt: false })).toEqual({
      mode: 'aim',
      aim: 'view',
      lock: 'frame-x',
    })
    expect(m3AimBillboard({ bone: 0, type: 1, cameraLookAt: false })).toMatchObject({ lock: 'frame-y' })
  })

  it('composes the free type forward correction only under a bone parent', () => {
    expect(m3AimBillboard({ bone: 0, type: 6, cameraLookAt: true, up: turn, forward: turn })).toEqual({
      mode: 'aim',
      aim: 'eye',
      lock: 'free',
      correction: turn,
    })
  })

  it('locks the bone own X and Y by types 3 and 5, with no correction', () => {
    expect(m3AimBillboard({ bone: 0, type: 3, cameraLookAt: true, up: turn, forward: turn })).toEqual({
      mode: 'aim',
      aim: 'eye',
      lock: 'own-x',
    })
    expect(m3AimBillboard({ bone: 0, type: 5, cameraLookAt: true })).toMatchObject({ lock: 'own-y' })
  })

  it('leaves type 4, which the engine never applies, and unknown types alone', () => {
    expect(m3AimBillboard({ bone: 0, type: 4, cameraLookAt: true })).toBeUndefined()
    expect(m3AimBillboard({ bone: 0, type: 9, cameraLookAt: true })).toBeUndefined()
  })

  it('reads a float32 identity correction as none', () => {
    expect(m3AimBillboard({ bone: 0, type: 2, cameraLookAt: true, up: identity32 })).toEqual({
      mode: 'aim',
      aim: 'eye',
      lock: 'frame-z',
    })
  })
})
