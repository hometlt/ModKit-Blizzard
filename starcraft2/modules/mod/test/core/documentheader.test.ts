import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsReader, VirtualFileSystem } from '../../shared/workspace/vfs.js'
import { SC2ModReader } from '../../shared/core/reader.js'
import { writeDocumentHeader, parseDocumentHeader, writeVersionFile } from '../../shared/core/index.js'

function makeVfs(): VirtualFileSystem {
  const vfs = new VirtualFileSystem()
  vfs.register('file:', new FsReader())
  return vfs
}

describe('SC2ModReader — DocumentHeader integration', () => {
  let dir: string
  let original: Uint8Array

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-mod-'))
    original = writeDocumentHeader({
      flags: 0x0501,
      headerSize: 0x0f00,
      timestamp1: 95000,
      timestamp2: 95000,
      hash1: 0x1234abcd,
      hash2: 0x1234abcd,
      unknown3: 2,
      dependencies: ['file:Mods\\Liberty.SC2Mod'],
      entries: [
        { key: 'DocInfo/Name', type: 'SUne', value: 'Temp Mod' },
        { key: 'DocInfo/Author', type: 'SUne', value: 'Vise' },
        { key: 'MapInfo/Players', type: 'SUne', value: '8' },
      ],
    })
    writeFileSync(join(dir, 'DocumentHeader'), original)
    writeFileSync(
      join(dir, 'Triggers.version'),
      writeVersionFile({
        versionPath: 'Triggers.version',
        buildNumber: 95000,
        majorVersion: 5,
        minorVersion: 0,
        patchVersion: 15,
        buildNumber2: 96000,
        entryCount: 7,
        timestamp: 0x65ff1280,
      }),
    )
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reader parses the DocumentHeader into mod.documentHeader', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    const mod = await reader.read(`file:${dir.replace(/\\/g, '/')}`)
    expect(mod.documentHeader).toBeDefined()
    expect(mod.documentHeader!.dependencies).toEqual(['file:Mods\\Liberty.SC2Mod'])
    const info = Object.fromEntries(mod.documentHeader!.entries.map(e => [e.key, e.value]))
    expect(info['DocInfo/Name']).toBe('Temp Mod')
    expect(info['MapInfo/Players']).toBe('8')
  })

  it('the raw bytes are still kept verbatim in opaqueFiles', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    const mod = await reader.read(`file:${dir.replace(/\\/g, '/')}`)
    const raw = [...mod.opaqueFiles].find(([p]) => p.toLowerCase() === 'documentheader')?.[1]
    expect(raw).toBeDefined()
    expect(Array.from(raw!)).toEqual(Array.from(original))
  })

  it('re-serializing mod.documentHeader reproduces the original bytes', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    const mod = await reader.read(`file:${dir.replace(/\\/g, '/')}`)
    const rewritten = writeDocumentHeader(mod.documentHeader!)
    expect(Array.from(rewritten)).toEqual(Array.from(original))
    // and it round-trips through parse again
    expect(parseDocumentHeader(rewritten).entries).toHaveLength(3)
  })

  it('reader parses .version sidecars into mod.versionFiles', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    const mod = await reader.read(`file:${dir.replace(/\\/g, '/')}`)
    const triggersVersion = mod.versionFiles.get('Triggers')
    expect(triggersVersion).toBeDefined()
    expect(triggersVersion?.typeTag).toBe('girt')
    expect(triggersVersion?.patchVersion).toBe(15)
    expect(triggersVersion?.buildNumber2).toBe(96000)
    expect(triggersVersion?.entryCount).toBe(7)
  })
})
