/**
 * Extra package sources from the user's settings (parity plan 8.9, MK2 `modkit.sources`): the
 * merge rules, and the one mod loader finding packages through them.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Sc2DesktopContentSources,
  localOptions,
  modSourceChain,
} from '../battlenet/content-sources/local-content-sources.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const MODS = join(import.meta.dirname, '..', '..', 'mod', 'test', 'core', 'fixtures', 'Sc2Root', 'Mods')
const root = (name: string) => join(FIXTURES, name)

describe('mod source settings', () => {
  it('drops tombstoned and relative entries, orders by priority and puts casc last', () => {
    const chain = modSourceChain([
      { type: 'casc', path: root('game'), priority: -5 },
      { type: 'mods', path: root('b'), priority: 2 },
      { type: 'mods', path: root('a') },
      { type: 'json', path: root('gone') },
      { type: 'json', path: root('GONE'), disabled: true },
      { type: 'mods', path: 'relative/to/nothing' },
    ])
    expect(chain.map(source => [source.type, source.path])).toEqual([
      ['mods', root('a')],
      ['mods', root('b')],
      ['casc', root('game')],
    ])
  })

  it('takes the first casc source as the installation and refuses a malformed entry', () => {
    expect(localOptions({ installationDirectory: root('picked'), sources: [{ type: 'casc', path: root('game') }] })
      .installationDirectory).toBe(root('game'))
    expect(() => localOptions({ sources: [{ type: 'ftp', path: root('x') }] })).toThrow('sources[0]')
    expect(() => localOptions({ sources: [{ type: 'mods', path: root('x'), priority: 'high' }] })).toThrow('sources[0]')
  })
})

describe('mod sources through the loader', () => {
  const sources = () =>
    new Sc2DesktopContentSources(localOptions({
      documentsDirectory: FIXTURES,
      battleNetCacheDirectory: FIXTURES,
      sc2MapsCacheDirectory: FIXTURES,
      sources: [
        { type: 'mods', path: MODS },
        { type: 'json', path: root('json-mods') },
        { type: 'zip', path: root('zip-mods') },
      ],
    }))

  it('shows a mods folder as a source and resolves dependencies in it by name', async () => {
    const content = sources()
    try {
      expect((await content.snapshot()).roots.map(item => item.id)).toContain('local:mods:0')
      // Leaf declares `Mods/all-races-mods/builtin/Void.SC2Mod`; the folder holds `void.sc2mod`.
      const context = await content.openModContext({ schemaVersion: 1, target: join(MODS, 'Leaf.SC2Mod') })
      try {
        const void_ = context.layers.find(layer => /void\.sc2mod$/iu.test(layer.sourcePath))
        expect(void_?.sourceId).toBe('local:mods:0')
      } finally {
        await context.dispose()
      }
    } finally {
      await content.dispose()
    }
  })

  it('finds a mod folder inside a zip of a zip folder by name and reads it by ranges', async () => {
    const content = sources()
    try {
      // `Pack.zip` holds `Stuff/Zipped.SC2Mod`; the loader asks for it under `Mods`.
      const context = await content.openModContext({
        schemaVersion: 1,
        target: { sourceId: 'local:zip:2', path: 'Mods/Zipped.SC2Mod' },
      })
      try {
        const primary = context.layers.at(-1)!
        expect([primary.sourceId, primary.sourcePath]).toEqual(['local:zip:2', 'Mods/Zipped.SC2Mod'])
        const files = (await context.files(primary.id, { limit: 100 })).items
        expect(files).toEqual(expect.arrayContaining(['DocumentInfo', 'Base.SC2Data/GameData/UnitData.xml']))
        const xml = new TextDecoder().decode(await context.read(primary.id, 'Base.SC2Data/GameData/UnitData.xml', 1 << 20))
        expect(xml).toContain('ZippedUnit')
      } finally {
        await context.dispose()
      }
    } finally {
      await content.dispose()
    }
  })

  it('opens a JSON mod of a json folder as a package', async () => {
    const content = sources()
    try {
      const context = await content.openModContext({
        schemaVersion: 1,
        target: { sourceId: 'local:json:1', path: 'Mods/Extra.SC2Mod' },
      })
      try {
        const primary = context.layers.at(-1)
        expect([primary?.sourceId, primary?.sourcePath]).toEqual(['local:json:1', 'Mods/Extra.SC2Mod'])
      } finally {
        await context.dispose()
      }
    } finally {
      await content.dispose()
    }
  })
})
