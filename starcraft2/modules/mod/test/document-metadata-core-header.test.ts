import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  parseDocumentHeader,
  writeDocumentHeader,
  getDocumentInfo,
  getMapInfo,
  getLoadingScreenInfo,
  getEntriesByPattern,
} from '../../../dist/modules/mod/codecs/document-metadata/core/index.js'
import type { DocumentHeaderWriteInput } from '../../../dist/modules/mod/codecs/document-metadata/core/index.js'

// ---------------------------------------------------------------------------
// Test buffer builder
// ---------------------------------------------------------------------------

function buildBuffer(opts: {
  magic?: string
  flags?: number
  headerSize?: number
  timestamp1?: number
  hash1?: number
  hash2?: number
  unknown3?: number
  reserved?: Uint8Array
  deps?: string[]
  entries?: Array<{ key: string; type: string; value: string }>
}): Uint8Array {
  const input: DocumentHeaderWriteInput = {
    magic: opts.magic ?? 'H2CS',
    flags: opts.flags ?? 0x0501,
    headerSize: opts.headerSize ?? 0x0f00,
    timestamp1: opts.timestamp1 ?? 95000,
    timestamp2: opts.timestamp1 ?? 95000,
    hash1: opts.hash1 ?? 0,
    hash2: opts.hash2 ?? 0,
    unknown3: opts.unknown3 ?? 2,
    dependencies: opts.deps ?? [],
    entries: opts.entries ?? [],
    ...(opts.reserved === undefined ? {} : { reserved: opts.reserved }),
  }
  return writeDocumentHeader(input)
}

const SAMPLE_ENTRIES = [
  { key: 'DocInfo/Name', type: 'SUne', value: 'My Mod' },
  { key: 'DocInfo/Author', type: 'SUne', value: 'Vise' },
  { key: 'MapInfo/Players', type: 'SUne', value: '8' },
]

// ---------------------------------------------------------------------------
// 1. Round-trip
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('parse → write reproduces the original bytes exactly', () => {
    const buf = buildBuffer({
      deps: ['bnet:Liberty (Mod)/0.0/999,file:Mods/Liberty.SC2Mod', 'file:Mods\\ARC-ASSETS.SC2Mod'],
      entries: SAMPLE_ENTRIES,
    })

    const parsed = parseDocumentHeader(buf)
    const rewritten = writeDocumentHeader(parsed)

    expect(rewritten).toEqual(buf)
    expect(Array.from(rewritten)).toEqual(Array.from(buf))
  })

  it('preserves a nonzero reserved field (as seen in some map files)', () => {
    const reserved = new Uint8Array([0x0a, 0, 0, 0, 0, 0, 0, 0])
    const buf = buildBuffer({ reserved, deps: ['file:Mods\\X.SC2Mod'], entries: SAMPLE_ENTRIES })

    const parsed = parseDocumentHeader(buf)
    expect(Array.from(parsed.reserved)).toEqual([0x0a, 0, 0, 0, 0, 0, 0, 0])
    expect(writeDocumentHeader(parsed)).toEqual(buf)
  })
})

// ---------------------------------------------------------------------------
// 2-5. Accessors
// ---------------------------------------------------------------------------

describe('accessors', () => {
  const buf = buildBuffer({
    deps: ['file:Mods\\X.SC2Mod'],
    entries: [
      { key: 'DocInfo/Name', type: 'SUne', value: 'Title' },
      { key: 'DocInfo/Author', type: 'SUne', value: 'Vise' },
      { key: 'MapInfo/Players', type: 'SUne', value: '4' },
      { key: 'MapInfo/Tileset', type: 'SUne', value: 'Bel' },
      { key: 'LoadingScreen/Image', type: 'SUne', value: 'screen.tga' },
      { key: 'LoadingScreen/Tip', type: 'URur', value: 'Hint!' },
    ],
  })
  const data = parseDocumentHeader(buf)

  it('getDocumentInfo extracts DocInfo/* entries', () => {
    expect(getDocumentInfo(data)).toEqual({ Name: 'Title', Author: 'Vise' })
  })

  it('getMapInfo extracts MapInfo/* entries', () => {
    expect(getMapInfo(data)).toEqual({ Players: '4', Tileset: 'Bel' })
  })

  it('getLoadingScreenInfo extracts LoadingScreen/* entries', () => {
    expect(getLoadingScreenInfo(data)).toEqual({ Image: 'screen.tga', Tip: 'Hint!' })
  })

  it('getEntriesByPattern filters by regex', () => {
    const mapEntries = getEntriesByPattern(data, /^MapInfo\//)
    expect(mapEntries.map(e => e.key)).toEqual(['MapInfo/Players', 'MapInfo/Tileset'])

    const tips = getEntriesByPattern(data, 'Tip')
    expect(tips).toHaveLength(1)
    expect(tips[0]!.value).toBe('Hint!')
  })
})

// ---------------------------------------------------------------------------
// 6-7. Errors
// ---------------------------------------------------------------------------

describe('errors', () => {
  it('throws when the file is smaller than the fixed header', () => {
    expect(() => parseDocumentHeader(new Uint8Array(10))).toThrow(/too small/i)
  })

  it('throws on a wrong magic, including the actual bytes in the message', () => {
    const buf = buildBuffer({ entries: SAMPLE_ENTRIES })
    buf.set([0x42, 0x41, 0x44, 0x21], 0) // "BAD!"
    expect(() => parseDocumentHeader(buf)).toThrow(/BAD!/)
  })
})

// ---------------------------------------------------------------------------
// 8-10. Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('parses a large entry count (200 entries)', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      key: `DocInfo/Key${i}`,
      type: 'SUne',
      value: `value-${i}`,
    }))
    const buf = buildBuffer({ deps: ['file:Mods\\X.SC2Mod'], entries })

    const data = parseDocumentHeader(buf)
    expect(data.entries).toHaveLength(200)
    expect(data.entries[199]).toEqual({ key: 'DocInfo/Key199', type: 'SUne', value: 'value-199' })
  })

  it('parses a file with zero dependencies', () => {
    const buf = buildBuffer({ deps: [], entries: SAMPLE_ENTRIES })
    const data = parseDocumentHeader(buf)
    expect(data.dependencies).toEqual([])
    expect(data.entries).toHaveLength(3)
  })

  it('preserves an entry with an empty value string', () => {
    const buf = buildBuffer({
      deps: ['file:Mods\\X.SC2Mod'],
      entries: [
        { key: 'DocInfo/Name', type: 'SUne', value: '' },
        { key: 'DocInfo/Author', type: 'SUne', value: 'Vise' },
      ],
    })
    const data = parseDocumentHeader(buf)
    expect(data.entries[0]).toEqual({ key: 'DocInfo/Name', type: 'SUne', value: '' })
    expect(data.entries[1]!.value).toBe('Vise')
  })
})

// ---------------------------------------------------------------------------
// 11. Robustness — the R4 failure modes must not crash the parser
// ---------------------------------------------------------------------------

describe('robustness (R4 regression guards)', () => {
  it('does not throw "Invalid array length" on a garbage entry-count', () => {
    const buf = buildBuffer({ deps: ['file:Mods\\X.SC2Mod'], entries: SAMPLE_ENTRIES })
    // Corrupt the entry-count uint32 that follows the (single) dependency.
    // Dep section: 0x30 + len + 1 null, then the 4-byte count.
    const depLen = 'file:Mods\\X.SC2Mod'.length
    const countOffset = 0x30 + depLen + 1
    const view = new DataView(buf.buffer)
    view.setUint32(countOffset, 0xfffffff0, true) // absurd count
    expect(() => parseDocumentHeader(buf)).not.toThrow()
  })

  it('does not throw on a tiny truncated file (header only)', () => {
    const buf = buildBuffer({ deps: [], entries: [] }).slice(0, 52)
    expect(() => parseDocumentHeader(buf)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 12. Verification — byte-exact round-trip over real DocumentHeader files
//     (skipped automatically when the extracted assets are not present)
// ---------------------------------------------------------------------------

function findRealHeaders(): string[] {
  const root = resolve(__dirname, '../../../assets/sc2-data-triggers')
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'DocumentHeader') out.push(p)
    }
  }
  walk(root)
  return out
}

describe('real-file verification', () => {
  const files = findRealHeaders()
  const run = files.length ? it : it.skip

  run('round-trips every extracted DocumentHeader byte-for-byte', () => {
    for (const f of files) {
      const buf = new Uint8Array(readFileSync(f))
      const parsed = parseDocumentHeader(buf)
      const rewritten = writeDocumentHeader(parsed)
      expect(Array.from(rewritten), `round-trip mismatch: ${f}`).toEqual(Array.from(buf))
    }
  })
})
