import { describe, expect, it } from 'vitest'
import * as production from '../src/mpq/obfuscation.js'

const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255, 65, 66])
const key = 'S2-🔒'
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')

describe('SC2 payload obfuscation parity', () => {
  it('matches frozen MK2 byte vectors in both directions', () => {
    expect(hex(production.obfuscate(bytes, key))).toBe('53332f8f1f6a6d1270')
    expect(hex(production.obfuscateMulti(bytes, ['alpha', 'βeta', 'third']))).toBe(
      'dbb77e11e425493d2c',
    )
    expect(hex(production.rotateBytes(bytes, -17))).toBe('eff0f16e6fedee3031')
    expect(hex(production.obfuscateCombined(bytes, key, 37))).toBe('785854b4448f923795')

    expect(production.deobfuscate(production.obfuscate(bytes, key), key)).toEqual(bytes)
    expect(
      production.deobfuscateMulti(
        production.obfuscateMulti(bytes, ['alpha', 'βeta', 'third']),
        ['alpha', 'βeta', 'third'],
      ),
    ).toEqual(bytes)
    expect(
      production.deobfuscateCombined(production.obfuscateCombined(bytes, key, 37), key, 37),
    ).toEqual(bytes)
  })

  it('keeps the pinned header format and rejects invalid inputs', () => {
    const headed = production.addObfuscationHeader(bytes, key)
    expect(hex(headed)).toBe('3c2a9e1fc30ec40453332f8f1f6a6d1270')
    expect(production.hasObfuscationHeader(headed)).toBe(true)
    expect(production.removeObfuscationHeader(headed, key)).toEqual(bytes)
    expect(production.hasObfuscationHeader(bytes)).toBe(false)
    expect(() => production.removeObfuscationHeader(headed, 'wrong')).toThrow(/key mismatch/iu)
    expect(() => production.removeObfuscationHeader(bytes.slice(0, 7), key)).toThrow(/too short/u)
    expect(() => production.obfuscate(bytes, '')).toThrow(/key is required/u)
    expect(() => production.obfuscateMulti(bytes, [])).toThrow(/at least one key/iu)
  })
})
