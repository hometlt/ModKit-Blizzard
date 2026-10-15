import { describe, it, expect } from 'vitest'
import { parseColor, toCssRgba } from '../../../../shared/format/rendering/model/color.js'

describe('parseColor', () => {
  it('parses r,g,b byte lists', () => {
    expect(parseColor('255,128,0')).toEqual({ r: 255, g: 128, b: 0, a: 1 })
  })

  it('parses a,r,g,b with alpha leading (fraction or byte)', () => {
    expect(parseColor('0.5,255,0,0')).toEqual({ a: 0.5, r: 255, g: 0, b: 0 })
    expect(parseColor('128,255,0,0')).toEqual({ a: 128 / 255, r: 255, g: 0, b: 0 })
  })

  it('parses hex RRGGBB and AARRGGBB, with or without #', () => {
    expect(parseColor('ff8000')).toEqual({ r: 255, g: 128, b: 0, a: 1 })
    expect(parseColor('#00ff00')).toEqual({ r: 0, g: 255, b: 0, a: 1 })
    expect(parseColor('80ff0000')).toEqual({ a: 128 / 255, r: 255, g: 0, b: 0 })
  })

  it('clamps out-of-range channels and rejects garbage', () => {
    expect(parseColor('300,-5,0')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('nope')).toBeUndefined()
    expect(parseColor('')).toBeUndefined()
    expect(parseColor(undefined)).toBeUndefined()
  })

  it('renders CSS rgba', () => {
    expect(toCssRgba({ r: 10, g: 20, b: 30, a: 0.5 })).toBe('rgba(10, 20, 30, 0.5)')
  })
})
