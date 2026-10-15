import { describe, expect, it } from 'vitest'
import { isStarcraft1TextRoot, Starcraft1NameDb } from '../../src/casc/starcraft1-root.js'

const KEY_A = '00112233445566778899aabbccddeeff'
const KEY_B = 'ffeeddccbbaa99887766554433221100'

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('StarCraft 1 CASC text root', () => {
  it('detects pipe-delimited text roots with content keys', () => {
    expect(isStarcraft1TextRoot(bytes(`Anim\\main.anim|${KEY_A}\r\n`))).toBe(true)
    expect(isStarcraft1TextRoot(bytes('not a root'))).toBe(false)
  })

  it('parses BOM, CRLF, mixed slashes, and 2/3-column rows', () => {
    const db = Starcraft1NameDb.parse(
      bytes(`\uFEFFAnim\\Main.anim|${KEY_A}\r\nHD2/unit.dds.grp|${KEY_B}|enUS\r\n`),
    )

    expect(db.size).toBe(2)
    expect(db.getByPath('anim/main.anim')).toMatchObject({
      path: 'Anim/Main.anim',
      contentKey: KEY_A,
      row: 1,
    })
    expect(db.getByPath('HD2\\UNIT.DDS.GRP')?.contentKey).toBe(KEY_B)
    expect(db.hasPrefix('hd2')).toBe(true)
    expect(db.listPaths()).toEqual(['Anim/Main.anim', 'HD2/unit.dds.grp'])
    expect(db.listPaths('anim')).toEqual(['Main.anim'])
  })

  it('resolves duplicate paths deterministically to the later row', () => {
    const db = Starcraft1NameDb.parse(bytes(`Anim/Main.anim|${KEY_A}\nanim\\main.anim|${KEY_B}\n`))

    expect(db.size).toBe(1)
    expect(db.getByPath('ANIM/MAIN.ANIM')).toMatchObject({ contentKey: KEY_B, row: 2 })
  })

  it('rejects malformed keys and unsafe paths', () => {
    expect(() => Starcraft1NameDb.parse(bytes('Anim/Main.anim|not-a-key\n'))).toThrow(
      /missing 32-hex content key/,
    )
    expect(() => Starcraft1NameDb.parse(bytes(`../Main.anim|${KEY_A}\n`))).toThrow(/unsafe path/)
  })
})
