import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { isProtectableMpq, protectMpqHeader } from '@modkit/blizzard-mpq/header-protection'

/** A header shaped like the one a published archive carries, with recognisable functional fields. */
const archive = (): Buffer => {
  const bytes = Buffer.alloc(0x200)
  bytes.write('MPQ\u001a', 0, 'binary')
  bytes.writeUInt32LE(0xd0, 4) // declared header size
  bytes.writeUInt32LE(0x1000, 8) // declared archive size
  bytes.writeUInt16LE(3, 12) // format version
  bytes.writeUInt16LE(9, 14) // sector size shift
  bytes.writeUInt32LE(0x200, 16) // hash table offset
  bytes.writeUInt32LE(0x280, 20) // block table offset
  bytes.writeUInt32LE(16, 24) // hash table entries
  bytes.writeUInt32LE(4, 28) // block table entries
  bytes.fill(0xab, 0xd0) // payload
  return bytes
}

describe('Locked By BadName header protection', () => {
  it('destroys only what StormLib validates and keeps what the game reads', () => {
    const source = archive()
    const guarded = Buffer.from(protectMpqHeader(new Uint8Array(source)))

    // Rejected by StormLib: the three fields it repairs are junk…
    expect(guarded.readUInt32LE(4)).not.toBe(0xd0)
    expect(guarded.readUInt32LE(8)).not.toBe(0x1000)
    expect(guarded.readUInt16LE(12)).not.toBe(3)
    // …and the header's own MD5 covers that junk, so repairing it can never match.
    expect(guarded.subarray(0xc0, 0xd0)).toEqual(
      createHash('md5').update(guarded.subarray(0, 0xc0)).digest(),
    )

    // Opened by the game: every field it actually uses is untouched.
    expect(guarded.subarray(0, 4).toString('binary')).toBe('MPQ\u001a')
    expect(guarded.readUInt16LE(14)).toBe(9)
    expect(guarded.readUInt32LE(16)).toBe(0x200)
    expect(guarded.readUInt32LE(20)).toBe(0x280)
    expect(guarded.readUInt32LE(24)).toBe(16)
    expect(guarded.readUInt32LE(28)).toBe(4)
    expect(guarded.subarray(0xd0)).toEqual(source.subarray(0xd0))

    // The author's own file is never the one that changes.
    expect(source).toEqual(archive())
  })

  it('refuses anything that is not an MPQ archive', () => {
    expect(isProtectableMpq(new Uint8Array(16))).toBe(false)
    expect(() => protectMpqHeader(new Uint8Array(16))).toThrow(/MPQ v4 archive/u)
  })
})
