/**
 * `data.strings`: the localized strings of a mod context, asked by key.
 *
 * A card drawn from the context's catalog names a button, its tooltip and its hotkey by key; the
 * context answers them from every layer's GameStrings.txt and GameHotkeys.txt in load order, the
 * opened mod over the stock chain, and falls back to the next locale it was asked for, saying so.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'
import type { ContentSourceStorage } from '../../shared/workspace/content-source-provider.js'
import { Sc2FolderSource } from '../../../game/battlenet/content-sources/local-files.js'
import { contextStrings } from '../../shared/workspace/context-strings.js'

function memorySource(id: string, files: Record<string, string>): ContentSourceStorage {
  const table = new Map(Object.entries(files).map(([file, text]) => [file, new TextEncoder().encode(text)]))
  return {
    id,
    async list(folder) {
      const prefix = folder === '' ? '' : `${folder.toLowerCase()}/`
      const children = new Map<string, { name: string; directory: boolean }>()
      for (const file of table.keys()) {
        if (!file.toLowerCase().startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        const name = rest.split('/')[0] as string
        children.set(name.toLowerCase(), { name, directory: rest.includes('/') })
      }
      if (children.size === 0 && prefix !== '') throw new Error(`${folder} does not exist`)
      return [...children.values()]
    },
    async read(file, maxBytes) {
      const hit = [...table].find(([key]) => key.toLowerCase() === file.toLowerCase())
      if (hit === undefined) throw new Error(`${file} does not exist`)
      if (hit[1].byteLength > maxBytes) throw new Error('too large')
      return hit[1]
    },
  }
}

const casc = memorySource('local:casc', {
  'Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml': '<Catalog/>',
  'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml': '<Catalog><CUnit id="SCV"/></Catalog>',
  'Mods/Liberty.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt':
    'Button/Name/MoveHoldPosition=Hold Position\nButton/Tooltip/Repair=Repairs mechanical units.\nUnit/Name/SCV=SCV\n',
  'Mods/Liberty.SC2Mod/enUS.SC2Data/LocalizedData/GameHotkeys.txt': 'Button/Hotkey/MoveHoldPosition=H\n',
  'Mods/Liberty.SC2Mod/ruRU.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/SCV=КСМ\nButton/Name/Only=Только\n',
  'Mods/Liberty.SC2Mod/enUS.SC2Data/LocalizedData/TriggerStrings.txt': 'Unit/Name/SCV=not a data string\n',
})

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sc2-mod-context-strings-'))
afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

async function write(relative: string, text: string): Promise<string> {
  const file = path.join(scratch, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  return file
}

function contexts() {
  return createSc2ModContexts({
    sources: () => new Map([[casc.id, casc]]),
    hostFolder: directory => {
      const folder = new Sc2FolderSource(directory, 'host', 'host')
      return { id: 'host', list: p => folder.list(p), read: (p, max) => folder.read(p, max), dispose: () => folder.dispose() }
    },
  })
}

describe('data.strings of a mod context', () => {
  it('bounds concurrent locale reads and folds successful files in declaration order', async () => {
    const strings = 'enUS.SC2Data/LocalizedData/GameStrings.txt'
    const hotkeys = 'enUS.SC2Data/LocalizedData/GameHotkeys.txt'
    const french = 'frFR.SC2Data/LocalizedData/GameStrings.txt'
    const requested: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let active = 0, peak = 0
    const held = contextStrings({
      layers: ['base', 'dependency', 'mod'].map(id => ({ id, rootId: id, sourcePath: `${id}.SC2Mod` })),
      files: async () => [strings, hotkeys, french],
      async read(layer, file) {
        requested.push(`${layer}/${file}`)
        active++
        peak = Math.max(peak, active)
        entered()
        try {
          await gate
          if (layer === 'base' && file === hotkeys) throw new Error('not installed')
          if (layer === 'base') await new Promise<void>(resolve => setImmediate(resolve))
          const text = file === hotkeys ? `Hotkey=${layer}\n`
            : `Name=${layer}\n${layer === 'mod' ? '' : `WithinBatch=${layer}\n`}`
          return new TextEncoder().encode(text)
        } finally { active-- }
      },
    })
    const pending = held.answer({ keys: ['Name', 'Hotkey', 'WithinBatch'], locales: ['enUS'] }, [])
    try {
      await started
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(requested).toHaveLength(4)
      expect(peak).toBe(4)
    } finally { release(); await pending }
    const result = await pending
    expect(result).toMatchObject([
      { key: 'Name', value: 'mod', source: { rootId: 'mod', documentIndex: 3 } },
      { key: 'Hotkey', value: 'mod', source: { rootId: 'mod', documentIndex: 4 } },
      { key: 'WithinBatch', value: 'dependency', source: { rootId: 'dependency', documentIndex: 1 } },
    ])
    expect(requested).toHaveLength(6)
    expect(requested.every(file => !file.includes('frFR'))).toBe(true)
    expect(peak).toBeLessThanOrEqual(4)
    expect(await held.answer({ keys: ['Name'], locales: ['enUS'] }, [])).toEqual([result[0]])
    expect(requested).toHaveLength(6)
  })

  it('discovers each layer once across locale fallback, retaining values and source positions', async () => {
    const en = 'enUS.SC2Data/LocalizedData/GameStrings.txt'
    const ru = 'ruRU.SC2Data/LocalizedData/GameStrings.txt'
    const keys = 'enUS.SC2Data/LocalizedData/GameHotkeys.txt'
    const de = 'deDE.SC2Data/LocalizedData/TriggerStrings.txt'
    const values: Record<string, string> = {
      [`base/${en}`]: 'Name=Base\nHotkeyName=Base\n',
      [`mod/${en}`]: 'Name=Override\n',
      [`base/${keys}`]: 'Hotkey=H\n',
      [`mod/${ru}`]: 'RussianOnly=Russian\n',
    }
    const files = vi.fn(async (layer: string) => layer === 'base'
      ? [...Array.from({ length: 4096 }, (_, index) => `Assets/${index}.dds`), en, keys, de]
      : [en, ru])
    const reads = vi.fn(async (layer: string, file: string) => {
      const value = values[`${layer}/${file}`]
      if (value === undefined) throw new Error('Locale not installed')
      return new TextEncoder().encode(value)
    })
    const held = contextStrings({
      layers: ['base', 'mod'].map(id => ({ id, sourcePath: `${id}.SC2Mod`, rootId: id })),
      files, read: reads,
    })
    expect(await held.answer({ keys: ['Name', 'RussianOnly', 'Hotkey', 'Missing'], locales: ['deDE'] }, []))
      .toMatchObject([
        { key: 'Name', value: 'Override', requestedLocale: 'deDE', resolvedLocale: 'enUS',
          source: { rootId: 'mod', path: `mod.SC2Mod/${en}`, documentIndex: 2 } },
        { key: 'RussianOnly', value: 'Russian', resolvedLocale: 'ruRU', fallback: true },
        { key: 'Hotkey', value: 'H', source: { rootId: 'base', path: `base.SC2Mod/${keys}`, documentIndex: 1 } },
      ])
    await held.answer({ keys: ['Missing'], locales: ['ruRU'] }, [])
    expect(files.mock.calls).toEqual([['base'], ['mod']])
    expect(reads.mock.calls.some(([, file]) => file === de)).toBe(false)
    expect(reads.mock.calls).toHaveLength(4)
  })

  it('does not enumerate or read a chain for an empty, valid string question', async () => {
    const files = vi.fn(async () => [] as string[])
    const read = vi.fn(async () => new Uint8Array())
    const held = contextStrings({ layers: [{ id: 'mod', sourcePath: 'mod', rootId: 'mod' }], files, read })
    expect(await held.answer({ keys: [] }, [])).toEqual([])
    await expect(held.answer({ keys: [], locales: ['invalid'] }, [])).rejects.toThrow(/locales/)
    expect(files).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('retains other locales and discovers new localized overlays without losing fallback or hotkeys', async () => {
    const en = 'enUS.SC2Data/LocalizedData/GameStrings.txt'
    const ru = 'ruRU.SC2Data/LocalizedData/GameStrings.txt'
    const files: Record<string, string> = { [en]: 'Name=English\n', [ru]: 'Name=Russian\n' }
    const reads: string[] = []
    const held = contextStrings({
      layers: [{ id: 'mod', sourcePath: 'Mine.SC2Mod', rootId: 'mod' }],
      files: async () => Object.keys(files),
      read: async (_layer, path) => { reads.push(path); return new TextEncoder().encode(files[path]) },
    })
    const answer = (keys: string[], locale: string) => held.answer({ keys, locales: [locale] }, [])
    await answer(['Name'], 'enUS')
    await answer(['Name'], 'ruRU')
    files[en] = 'Name=Updated\n'
    held.invalidate([en])
    expect(await answer(['Name'], 'ruRU')).toMatchObject([{ value: 'Russian' }])
    expect(reads.filter(path => path === ru)).toHaveLength(1)
    expect(await answer(['Name'], 'enUS')).toMatchObject([{ value: 'Updated' }])
    const fr = 'frFR.SC2Data/LocalizedData/GameStrings.txt'
    files[fr] = 'FrenchOnly=French\n'
    held.invalidate([fr])
    expect(await answer(['FrenchOnly'], 'enUS')).toMatchObject([{ value: 'French', resolvedLocale: 'frFR', fallback: true }])
    const hotkeys = 'enUS.SC2Data/LocalizedData/GameHotkeys.txt'
    files[hotkeys] = 'Hotkey=H\n'
    held.invalidate([hotkeys])
    expect(await answer(['Hotkey'], 'enUS')).toMatchObject([{ value: 'H' }])
  })

  it('retries discovery after a transient source failure', async () => {
    const file = 'enUS.SC2Data/LocalizedData/GameStrings.txt'
    const files = vi.fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('source unavailable')).mockResolvedValue([file])
    const held = contextStrings({
      layers: [{ id: 'mod', sourcePath: 'mod', rootId: 'mod' }], files,
      read: async () => new TextEncoder().encode('Name=Ready\n'),
    })
    await expect(held.answer({ keys: ['Name'] }, [])).rejects.toThrow('source unavailable')
    expect(await held.answer({ keys: ['Name'] }, [])).toMatchObject([{ value: 'Ready' }])
    expect(files).toHaveBeenCalledTimes(2)
  })

  it('does not discard a replacement input index when invalidated discovery fails later', async () => {
    const file = 'enUS.SC2Data/LocalizedData/GameStrings.txt'
    let rejectOld!: (error: Error) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<string[]>((_resolve, reject) => { rejectOld = reject })
    let listings = 0, reads = 0
    const held = contextStrings({
      layers: [{ id: 'mod', sourcePath: 'Mine.SC2Mod', rootId: 'mod' }],
      files: async () => { if (++listings === 1) { entered(); return blocked } return [file] },
      read: async () => { reads++; return new TextEncoder().encode('Name=Name\n') },
    })
    const answer = () => held.answer({ keys: ['Name'], locales: ['enUS'] }, [])
    const old = answer().catch(error => error)
    await started
    held.invalidate([file])
    const replacement = await answer()
    rejectOld(new Error('old listing failed'))
    expect(await old).toBeInstanceOf(Error)
    expect(await answer()).toEqual(replacement)
    expect(reads).toBe(1)
  })

  it('answers keys from every layer in load order, the opened mod winning', async () => {
    const modRoot = path.join(scratch, 'Mine.SC2Mod')
    await write(
      'Mine.SC2Mod/DocumentInfo',
      '<DocInfo><Dependencies><Value>bnet:Liberty (Mod)/0.0/999,file:Mods/Liberty.SC2Mod</Value></Dependencies></DocInfo>',
    )
    await write('Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml', '<Catalog/>')
    await write('Mine.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt', 'Unit/Name/SCV=Builder\n')
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: modRoot })
    const answer = (await context.query({
      kind: 'data.strings',
      keys: ['Unit/Name/SCV', 'Button/Name/MoveHoldPosition', 'Button/Hotkey/MoveHoldPosition', 'Button/Name/Missing'],
    })) as { strings: { key: string; value: string; source: { path: string }; fallback: boolean }[] }
    expect(answer.strings.map(item => [item.key, item.value, item.fallback])).toEqual([
      ['Unit/Name/SCV', 'Builder', false],
      ['Button/Name/MoveHoldPosition', 'Hold Position', false],
      ['Button/Hotkey/MoveHoldPosition', 'H', false],
    ])
    expect(answer.strings[0]?.source.path).toBe(
      `${modRoot.replace(/\\/g, '/')}/enUS.SC2Data/LocalizedData/GameStrings.txt`,
    )
    await loader.dispose()
  })

  it('falls back to the next locale asked for and says so', async () => {
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod' } })
    const answer = (await context.query({
      kind: 'data.strings',
      keys: ['Unit/Name/SCV', 'Button/Tooltip/Repair'],
      locales: ['ruRU', 'enUS'],
    })) as { strings: { key: string; value: string; requestedLocale: string; resolvedLocale: string; fallback: boolean }[] }
    expect(answer.strings).toEqual([
      expect.objectContaining({ key: 'Unit/Name/SCV', value: 'КСМ', resolvedLocale: 'ruRU', fallback: false }),
      expect.objectContaining({
        key: 'Button/Tooltip/Repair', value: 'Repairs mechanical units.', requestedLocale: 'ruRU', resolvedLocale: 'enUS', fallback: true,
      }),
    ])
    // Not asked for, ruRU still answers a key enUS lacks: an installation may hold only its own locale.
    const unasked = (await context.query({ kind: 'data.strings', keys: ['Button/Name/Only'] })) as typeof answer
    expect(unasked.strings).toEqual([
      expect.objectContaining({ value: 'Только', requestedLocale: 'enUS', resolvedLocale: 'ruRU', fallback: true }),
    ])
    await expect(context.query({ kind: 'data.strings', keys: [''] })).rejects.toThrow(/non-empty keys/u)
    await expect(context.query({ kind: 'data.strings', keys: ['a'], locales: ['english'] })).rejects.toThrow(/locales/u)
    await loader.dispose()
  })
})
