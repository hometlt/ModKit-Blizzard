/**
 * A loaded chain's Data on its server (`chain-data.ts`).
 *
 * The game loads the standard catalog files of every package and, beyond them, only the files the
 * package includes by path in `Base.SC2Data/GameData.xml`; a map with a custom `GameData/*.xml`
 * places units it defines there, and its world asks the server for them. The chain is parsed once:
 * a refresh after an edit re-reads the documents and re-parses only the one that changed.
 */
import { describe, expect, it, vi } from 'vitest'

const parses = vi.hoisted(() => ({ paths: [] as string[] }))
const serializations = vi.hoisted(() => ({ count: 0, failNext: false }))
vi.mock('node:v8', async original => {
  const v8 = await original<typeof import('node:v8')>()
  return { ...v8, serialize: (value: unknown) => {
    serializations.count++
    if (serializations.failNext) { serializations.failNext = false; throw new Error('test serialization failed') }
    return v8.serialize(value)
  } }
})
vi.mock('../../../data/services/catalog/catalog-analysis.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../data/services/catalog/catalog-analysis.js')>()
  return {
    ...original,
    parseCatalogDocument: (...args: Parameters<typeof original.parseCatalogDocument>) => {
      parses.paths.push(args[0].path)
      return original.parseCatalogDocument(...args)
    },
  }
})

const { chainCatalogDocuments, createChainData } = await import('../../shared/workspace/chain-data.js')

const unit = (id: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n  <CUnit id="${id}"/>\n</Catalog>\n`

const mapFiles: Record<string, string> = {
  'Base.SC2Data/GameData.xml':
    '<?xml version="1.0" encoding="us-ascii"?>\n<Includes>\n' +
    '    <Catalog path="GameData/Custom/MapUnits.xml"/>\n' +
    '    <Catalog path="GameData\\LaterUnits.xml"/>\n' +
    '    <Catalog path="GameData/Missing.xml"/>\n' +
    '    <Catalog path="GameData/UnitData.xml"/>\n' +
    '</Includes>\n',
  'Base.SC2Data/GameData/UnitData.xml': unit('Stock'),
  'Base.SC2Data/GameData/Custom/MapUnits.xml': unit('MapUnit'),
  'Base.SC2Data/GameData/LaterUnits.xml': unit('LaterUnit'),
  'Base.SC2Data/GameData/NotIncluded.xml': unit('Stray'),
  'Base.SC2Data/EditorData/EditorCategories.xml': '<EditorCategories/>',
}

const reader = (files: Record<string, string>, reads: string[] = []) => ({
  files: async () => Object.keys(files),
  read: async (_layer: string, path: string) => {
    reads.push(path)
    return new TextEncoder().encode(files[path])
  },
})

describe('chain Data on the mod server', () => {
  it('ignores unrelated edits but refreshes missing include targets regardless of their extension', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Mine.SC2Mod' }]
    const files: Record<string, string> = {
      'Base.SC2Data/GameData.xml': '<Includes><Catalog path="GameData/Later.txt"/></Includes>',
      'Base.SC2Data/GameData/UnitData.xml': unit('Marine'),
    }
    const reads: string[] = []
    const data = createChainData('dependencies', { layers, reader: reader(files, reads), incomplete: false })
    expect((await data.session()).ids('Unit')).toEqual(['Marine'])
    const initialReads = reads.length
    data.refresh([{ layerId: 'mod', path: 'Base.SC2Data/MapScript.galaxy' }])
    expect((await data.session()).ids('Unit')).toEqual(['Marine'])
    expect(reads).toHaveLength(initialReads)
    files['Base.SC2Data/GameData/Later.txt'] = unit('Ghost')
    data.refresh([{ layerId: 'mod', path: 'base.sc2data/gamedata/later.txt' }])
    expect((await data.session()).ids('Unit')).toEqual(['Ghost', 'Marine'])
    expect(reads.length).toBeGreaterThan(initialReads)
    delete files['Base.SC2Data/GameData.xml']
    files['Base.SC2Data/GameData/Extra.xml'] = unit('Extra')
    data.refresh([{ layerId: 'mod', path: 'Base.SC2Data/GameData.xml' }])
    expect((await data.session()).ids('Unit')).toEqual(['Extra', 'Marine'])
    files['Base.SC2Data/GameData/New.xml'] = unit('New')
    data.refresh([{ layerId: 'mod', path: 'Base.SC2Data/GameData/New.xml' }])
    expect((await data.session()).ids('Unit')).toEqual(['Extra', 'Marine', 'New'])
  })

  it('forks a clean saved chain without rereading it and keeps overlay views independent', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Mine.SC2Mod' }]
    const files = { 'Base.SC2Data/GameData/UnitData.xml': unit('Marine') }
    const savedReads: string[] = []
    const viewReads: string[] = []
    const base = createChainData('saved', { layers, reader: reader(files, savedReads), incomplete: false })
    const clean = createChainData('clean', {
      layers, reader: reader(files, viewReads), incomplete: false, base, hasOverlays: () => false,
    })
    const first = await clean.session()
    expect(first.ids('Unit')).toEqual(['Marine'])
    expect(savedReads).toEqual(['Base.SC2Data/GameData/UnitData.xml'])
    expect(viewReads).toEqual([])
    clean.refresh([{ layerId: 'mod', path: 'enUS.SC2Data/LocalizedData/GameStrings.txt' }])
    expect(await clean.session()).toBe(first)
    expect(viewReads).toEqual([])
    const edited = createChainData('edited', {
      layers, reader: reader({ ...files, 'Base.SC2Data/GameData/UnitData.xml': unit('Ghost') }, viewReads),
      incomplete: false, base, hasOverlays: () => true,
    })
    expect((await edited.session()).ids('Unit')).toEqual(['Ghost'])
    expect(first.ids('Unit')).toEqual(['Marine'])
    expect((await base.session()).ids('Unit')).toEqual(['Marine'])
    expect(savedReads).toHaveLength(1)
    expect(viewReads).toHaveLength(1)
  })

  it('uses the saved generation for equal overlays on initial load, refresh and overlay removal', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Mine.SC2Mod' }]
    const files = { 'Base.SC2Data/GameData/UnitData.xml': unit('Marine') }
    let text = files['Base.SC2Data/GameData/UnitData.xml']
    const reads: string[] = []
    const base = createChainData('saved-equality', { layers, reader: reader(files), incomplete: false })
    const view = createChainData('editor-equality', { layers,
      reader: { files: async () => Object.keys(files), read: async (_layer, path) => {
        reads.push(path)
        return new TextEncoder().encode(text)
      } }, incomplete: false, base,
      hasOverlays: async saved => saved[0]!.text !== text,
    })
    const session = await view.session()
    expect(session.ids('Unit')).toEqual(['Marine'])
    view.refresh([{ layerId: 'mod', path: 'Base.SC2Data/GameData/UnitData.xml' }])
    expect(await view.session()).toBe(session)
    expect(reads).toEqual([])
    text = unit('Ghost')
    view.refresh([{ layerId: 'mod', path: 'Base.SC2Data/GameData/UnitData.xml' }])
    expect((await view.session()).ids('Unit')).toEqual(['Ghost'])
    expect(reads).toHaveLength(1)
    text = unit('Marine')
    view.refresh([{ layerId: 'mod', path: 'Base.SC2Data/GameData/UnitData.xml' }])
    expect((await view.session()).ids('Unit')).toEqual(['Marine'])
    expect(reads).toHaveLength(1)
    files['Base.SC2Data/GameData/UnitData.xml'] = unit('SCV')
    base.refresh(); view.refresh()
    expect((await view.session()).ids('Unit')).toEqual(['Marine'])
    expect((await base.session()).ids('Unit')).toEqual(['SCV'])
    expect(reads).toHaveLength(2)
  })

  it('does not publish a clean view when cancelled during asynchronous overlay proof', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Mine.SC2Mod' }]
    const files = { 'Base.SC2Data/GameData/UnitData.xml': unit('Marine') }
    const base = createChainData('saved-cancel', { layers, reader: reader(files), incomplete: false })
    let enter!: () => void, release!: (value: boolean) => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const proof = new Promise<boolean>(resolve => { release = resolve })
    const view = createChainData('cancel-proof', { layers, reader: reader(files), incomplete: false, base,
      hasOverlays: () => { enter(); return proof } })
    const controller = new AbortController()
    const pending = view.session(controller.signal)
    await entered
    controller.abort(); release(false)
    await expect(pending).rejects.toThrow(/abort/u)
    expect((await view.session()).ids('Unit')).toEqual(['Marine'])
  })

  it('rechecks the saved generation when invalidated during asynchronous overlay proof', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Mine.SC2Mod' }]
    const files = { 'Base.SC2Data/GameData/UnitData.xml': unit('Marine') }
    const base = createChainData('saved-invalidate-proof', { layers, reader: reader(files), incomplete: false })
    let enter!: () => void, release!: (value: boolean) => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const proof = new Promise<boolean>(resolve => { release = resolve })
    const view = createChainData('invalidate-proof', { layers, reader: reader(files), incomplete: false, base,
      hasOverlays: () => { enter(); return proof } })
    const pending = view.session()
    await entered
    files['Base.SC2Data/GameData/UnitData.xml'] = unit('SCV')
    base.refresh(); view.refresh()
    release(false)
    expect((await pending).ids('Unit')).toEqual(['SCV'])
    expect((await view.session()).ids('Unit')).toEqual(['SCV'])
  })

  it('keeps a private editor repair usable when the native refresh cannot be read', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Mine.SC2Mod' }]
    const files = { 'Base.SC2Data/GameData/UnitData.xml': unit('Marine') }
    const native = reader(files)
    let broken = false
    const base = createChainData('native-repair', { layers, incomplete: false,
      reader: { ...native, read: (...args: Parameters<typeof native.read>) => {
        if (broken) throw new Error('native file temporarily unreadable')
        return native.read(...args)
      } } })
    const view = createChainData('editor-repair', { layers, incomplete: false, base,
      reader: reader({ 'Base.SC2Data/GameData/UnitData.xml': unit('EditorRepair') }), hasOverlays: async () => true })
    expect((await view.session()).ids('Unit')).toEqual(['EditorRepair'])
    broken = true
    base.refresh(); view.refresh()
    expect((await view.session()).ids('Unit')).toEqual(['EditorRepair'])
  })

  it('refreshes standard catalogs and editor categories created after a manifest was loaded', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Mine.SC2Mod' }]
    const files: Record<string, string> = { 'Base.SC2Data/GameData.xml': '<Includes/>' }
    const data = createChainData('new-inputs', { layers, reader: reader(files), incomplete: false })
    expect((await data.session()).ids('Unit')).toEqual([])
    files['Base.SC2Data/GameData/UnitData.xml'] = unit('Marine')
    data.refresh([{ layerId: 'mod', path: '\\Base.SC2Data\\GameData\\UnitData.xml' }])
    expect((await data.session()).ids('Unit')).toEqual(['Marine'])
    files['Base.SC2Data/EditorData/EditorCategories.xml'] = '<EditorCategories/>'
    data.refresh([{ layerId: 'mod', path: 'Base.SC2Data/EditorData/EditorCategories.xml' }])
    expect((await data.session()).documents.some(document => document.path.endsWith('EditorCategories.xml'))).toBe(true)
  })

  it('reads the catalogs a package includes in GameData.xml, and only those', async () => {
    const reads: string[] = []
    const layers = [{ id: 'map', rootId: 'map', sourcePath: 'Maps/Custom.SC2Map' }]
    const documents = await chainCatalogDocuments(layers, reader(mapFiles, reads))
    // The declaration first, then each catalog once: the standard file, then the included files in
    // declared order; a named file the package does not hold is not asked for. EditorCategories last.
    expect(reads).toEqual([
      'Base.SC2Data/GameData.xml',
      'Base.SC2Data/GameData/UnitData.xml',
      'Base.SC2Data/GameData/Custom/MapUnits.xml',
      'Base.SC2Data/GameData/LaterUnits.xml',
      'Base.SC2Data/EditorData/EditorCategories.xml',
    ])
    expect(documents.map(document => document.path)).toEqual([
      'Maps/Custom.SC2Map/Base.SC2Data/GameData/UnitData.xml',
      'Maps/Custom.SC2Map/Base.SC2Data/GameData/Custom/MapUnits.xml',
      'Maps/Custom.SC2Map/Base.SC2Data/GameData/LaterUnits.xml',
      'Maps/Custom.SC2Map/Base.SC2Data/EditorData/EditorCategories.xml',
    ])
    const session = await createChainData('includes', { layers, reader: reader(mapFiles), incomplete: false }).session()
    expect(session.ids('Unit')).toEqual(['LaterUnit', 'MapUnit', 'Stock'])
  })

  it('reads every GameData catalog of a package without GameData.xml, standard first, as the Data plan does', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Plain.SC2Mod' }]
    const files = {
      'Base.SC2Data/GameData/Zeta.xml': unit('Zeta'),
      'Base.SC2Data/GameData/UnitData.xml': unit('Stock'),
      'Base.SC2Data/GameData/Custom/Alpha.xml': unit('Alpha'),
    }
    const documents = await chainCatalogDocuments(layers, reader(files))
    expect(documents.map(document => document.path)).toEqual([
      'Mods/Plain.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
      'Mods/Plain.SC2Mod/Base.SC2Data/GameData/Custom/Alpha.xml',
      'Mods/Plain.SC2Mod/Base.SC2Data/GameData/Zeta.xml',
    ])
    const session = await createChainData('standard', { layers, reader: reader(files), incomplete: false }).session()
    expect(session.ids('Unit')).toEqual(['Alpha', 'Stock', 'Zeta'])
  })

  it('parses the chain once and, after a refresh, only the document that changed', async () => {
    const layers = [{ id: 'mod', rootId: 'mod', sourcePath: 'Mods/Mine.SC2Mod' }]
    const files: Record<string, string> = {
      'Base.SC2Data/GameData/UnitData.xml': unit('Marine'),
      'Base.SC2Data/GameData/WeaponData.xml': '<Catalog><CWeaponLegacy id="GuassRifle"/></Catalog>',
    }
    const data = createChainData('refresh', { layers, reader: reader(files), incomplete: false })
    parses.paths.length = 0
    const session = await data.session()
    expect(session.ids('Unit')).toEqual(['Marine'])
    expect(parses.paths).toHaveLength(2)
    const preparedCatalog = session.catalog().entries
    // A refresh without a change parses nothing again; the same session answers.
    data.refresh()
    expect(await data.session()).toBe(session)
    expect(session.ids('Unit')).toEqual(['Marine'])
    expect(parses.paths).toHaveLength(2)

    expect(session.catalog().entries).toBe(preparedCatalog)

    files['Base.SC2Data/GameData/UnitData.xml'] = unit('Ghost')
    data.refresh()
    expect(await data.session()).toBe(session)
    expect(session.ids('Unit')).toEqual(['Ghost'])
    expect(parses.paths).toEqual([
      'Mods/Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
      'Mods/Mine.SC2Mod/Base.SC2Data/GameData/WeaponData.xml',
      'Mods/Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
    ])
    data.rebind(layers, reader(files), true)
    expect((await data.session()).complete()).toBe(false)
    data.rebind(layers, reader(files), false)
    expect((await data.session()).complete()).toBe(true)
  })

  describe('kept parses of the leading stock layers (owner decision 10.10)', () => {
    const stock = (id: string, fingerprint: string | undefined, sourcePath: string) =>
      ({ id, rootId: `root:${id}`, sourcePath, ...(fingerprint === undefined ? {} : { fingerprint }) })
    const layerFiles: Record<string, Record<string, string>> = {
      core: { 'Base.SC2Data/GameData/UnitData.xml': '<Catalog><CUnit id="Base" default="1"/><CUnit id="Probe" parent="Base"/></Catalog>' },
      void: {
        'Base.SC2Data/GameData/UnitData.xml': '<Catalog><CUnit id="Marine" parent="Base"><LifeMax value="45"/></CUnit></Catalog>',
        'Base.SC2Data/EditorData/EditorCategories.xml': '<EditorCategories/>',
      },
      mine: { 'Base.SC2Data/GameData/UnitData.xml': '<Catalog><CUnit id="Marine"><LifeMax value="60"/></CUnit><CUnit id="Hero" parent="Marine"/></Catalog>' },
    }
    const layers = [
      stock('core', 'build:1', 'mods/core.sc2mod'),
      stock('void', 'build:1', 'mods/void.sc2mod'),
      stock('mine', undefined, 'C:/Mods/Mine.SC2Mod'),
    ]
    const chainReader = (reads: string[], files = layerFiles) => ({
      files: async (layerId: string) => Object.keys(files[layerId]!),
      read: async (layerId: string, path: string) => {
        reads.push(`${layerId}:${path}`)
        return new TextEncoder().encode(files[layerId]![path])
      },
    })
    const answers = (session: Awaited<ReturnType<ReturnType<typeof createChainData>['session']>>) => ({
      ids: session.ids('Unit'),
      definitions: session.definitions(session.ids('Unit').map(entityId => ({ namespace: 'Unit', entityId }))),
      complete: session.complete(),
      metadata: session.metadata(),
    })
    const memoryCache = () => {
      const records = new Map<string, unknown>()
      const saves = vi.fn()
      const cache = {
        prefixOf: (chain: readonly { readonly sourcePath: string; readonly fingerprint?: string }[]) => {
          const last = chain.findIndex(layer => layer.sourcePath === 'mods/void.sc2mod')
          return last < 0 || chain.slice(0, last + 1).some(layer => layer.fingerprint === undefined)
            ? undefined : { count: last + 1, key: 'void@build:1' }
        },
        load: async (key: string) => records.get(key) as never,
        save: async (key: string, record: unknown) => {
          saves(key)
          records.set(key, structuredClone(record))
        },
      }
      return { cache, saves, records }
    }

    it.each(['extend', 'shrink'] as const)('reuses native parses from an active %s chain without a disk cache or warming cold chains', async direction => {
      const sourceLayers = direction === 'extend' ? layers.slice(0, 1) : layers
      const targetLayers = direction === 'extend' ? layers : layers.slice(0, 1)
      const source = createChainData('active-native', { layers: sourceLayers, reader: chainReader([]), incomplete: false })
      const native = await source.session()
      const nativeAnswers = answers(native)
      const coldReads: string[] = []
      const cold = createChainData('unused', { layers, reader: chainReader(coldReads), incomplete: false })
      const expected = answers(await createChainData('plain-target', { layers: targetLayers, reader: chainReader([]), incomplete: false }).session())
      parses.paths.length = 0
      const target = createChainData('reuse-target', { layers: targetLayers, reader: chainReader([]), incomplete: false,
        reusableParses: function* () {
          for (const holder of [cold, source]) {
            const kept = holder.cachedParses()
            if (kept !== undefined) yield kept
          }
        },
      })
      const reused = await target.session()
      expect(answers(reused)).toEqual(expected)
      expect(parses.paths).toEqual(direction === 'shrink' ? [] : [
        'mods/void.sc2mod/Base.SC2Data/GameData/UnitData.xml', 'C:/Mods/Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
      ])
      expect(coldReads).toEqual([])
      expect(answers(native)).toEqual(nativeAnswers)
      reused.update(reused.documents.map(document => ({ ...document, text: document.text.replace('id="Probe"', 'id="Changed"') })))
      expect(reused.ids('Unit')).toContain('Changed')
      expect(answers(native)).toEqual(nativeAnswers)
    })

    it.each([false, true])('extends a shorter kept prefix without reloading it unless its fingerprint changed (%s)', async changed => {
      const files = Object.fromEntries(Object.entries(layerFiles).map(([id, entries]) => [id, { ...entries }]))
      files['core']!['Base.SC2Data/GameData.xml'] = '<Includes><Catalog path="GameData/Missing.xml"/></Includes>'
      files['core']!['Base.SC2Data/EditorData/EditorCategories.xml'] = '<EditorCategories/>'
      const { cache } = memoryCache()
      cache.prefixOf = chain => {
        const last = chain.findLastIndex(layer => ['mods/core.sc2mod', 'mods/void.sc2mod'].includes(layer.sourcePath))
        return last < 0 || chain.slice(0, last + 1).some(layer => layer.fingerprint === undefined) ? undefined
          : { count: last + 1, key: JSON.stringify(chain.slice(0, last + 1).map(layer => [layer.sourcePath, layer.fingerprint])) }
      }
      const parent = await createChainData('parent', { layers: layers.slice(0, 1), reader: chainReader([], files), incomplete: false, cache }).session()
      const parentAnswers = answers(parent)
      const extendedLayers = changed ? [{ ...layers[0]!, fingerprint: 'build:2' }, ...layers.slice(1)] : layers
      if (changed) files['core']!['Base.SC2Data/GameData/UnitData.xml'] = files['core']!['Base.SC2Data/GameData/UnitData.xml']!.replace('Probe', 'Ghost')
      const expected = answers(await createChainData('plain-extended', { layers: extendedLayers, reader: chainReader([], files), incomplete: false }).session())
      const reads: string[] = []
      parses.paths.length = 0
      const holder = createChainData('extended', { layers: extendedLayers, reader: chainReader(reads, files), incomplete: false, cache })
      const extended = await holder.session()
      expect(answers(extended)).toEqual(expected)
      expect(reads.some(path => path.startsWith('core:'))).toBe(changed)
      expect(parses.paths.includes('mods/core.sc2mod/Base.SC2Data/GameData/UnitData.xml')).toBe(changed)
      expect(holder.dependsOn('core', 'Base.SC2Data/GameData/Missing.xml')).toBe(true)
      expect(answers(parent)).toEqual(parentAnswers)
      files['core']!['Base.SC2Data/GameData/Missing.xml'] = unit('NowPresent')
      holder.refresh([{ layerId: 'core', path: 'Base.SC2Data/GameData/Missing.xml' }])
      expect((await holder.session()).ids('Unit')).toContain('NowPresent')
      expect(answers(parent)).toEqual(parentAnswers)
    })

    it.each(['documents', 'bytes'] as const)('accounts the retained shorter prefix against the %s limit before extending it', async limit => {
      const { cache, records } = memoryCache()
      cache.prefixOf = chain => {
        const last = chain.findLastIndex(layer => ['mods/core.sc2mod', 'mods/void.sc2mod'].includes(layer.sourcePath))
        return last < 0 ? undefined : { count: last + 1, key: String(last) }
      }
      await createChainData('bounded-parent', { layers: layers.slice(0, 1), reader: chainReader([]), incomplete: false, cache }).session()
      const saved = records.get('0') as { catalogs: readonly { rootId: string; path: string; text: string }[]; bytes: number }
      // A cache port reports admitted raw bytes/documents; extending it must charge those first.
      records.set('0', limit === 'bytes' ? { ...saved, bytes: 256 * 1024 * 1024 } : {
        ...saved, catalogs: Array.from({ length: 4096 }, (_, at) => ({ rootId: 'root:core', path: `mods/core.sc2mod/Base.SC2Data/GameData/Cached${at}.xml`, text: '<Catalog/>' })),
      })
      const reads: string[] = []
      const holder = createChainData('bounded-extension', { layers, reader: chainReader(reads), incomplete: false, cache })
      await expect(holder.session()).rejects.toThrow(limit === 'documents' ? '4096 catalog documents' : 'catalog bytes')
      expect(reads.filter(path => path.startsWith('core:'))).toEqual([])
      expect(reads).toHaveLength(limit === 'documents' ? 0 : 1)
      records.set('0', saved)
      expect((await holder.session()).ids('Unit')).toEqual(['Base', 'Hero', 'Marine', 'Probe'])
    })

    it('reads and parses only the layers after a kept prefix, with the same answers', async () => {
      const plain = answers(await createChainData('plain', { layers, reader: chainReader([]), incomplete: false }).session())
      const { cache, saves, records } = memoryCache()
      const firstReads: string[] = []
      const first = await createChainData('first', { layers, reader: chainReader(firstReads), incomplete: false, cache }).session()
      expect(answers(first)).toEqual(plain)
      await vi.waitFor(() => expect(saves).toHaveBeenCalledWith('void@build:1'))
      expect(firstReads.some(read => read.startsWith('core:'))).toBe(true)

      const reads: string[] = []
      parses.paths.length = 0
      const holder = createChainData('kept', { layers, reader: chainReader(reads), incomplete: false, cache })
      const kept = await holder.session()
      expect(answers(kept)).toEqual(plain)
      // Only the user's layer is read and parsed; the prefix came from the cache.
      expect(reads).toEqual(['mine:Base.SC2Data/GameData/UnitData.xml'])
      expect(parses.paths).toEqual(['C:/Mods/Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml'])
      holder.refresh([{ layerId: 'core', path: 'Base.SC2Data/MapScript.galaxy' }])
      expect(answers(await holder.session())).toEqual(plain)
      expect(reads).toEqual(['mine:Base.SC2Data/GameData/UnitData.xml'])
      // Older records without an input footprint remain conservative.
      delete (records.get('void@build:1') as { inputs?: unknown }).inputs
      const legacyReads: string[] = []
      const legacy = createChainData('legacy', { layers, reader: chainReader(legacyReads), incomplete: false, cache })
      await legacy.session()
      legacy.refresh([{ layerId: 'core', path: 'Base.SC2Data/Unknown.txt' }])
      expect(answers(await legacy.session())).toEqual(plain)
      expect(legacyReads.some(read => read.startsWith('core:'))).toBe(true)
    })

    it('refreshes a missing include restored from prefix metadata when its non-XML target appears', async () => {
      const files = structuredClone(layerFiles)
      files['core']!['Base.SC2Data/GameData.xml'] = '<Includes><Catalog path="GameData/Later.txt"/></Includes>'
      const { cache, saves } = memoryCache()
      await createChainData('seed', { layers, reader: chainReader([], files), incomplete: false, cache }).session()
      await vi.waitFor(() => expect(saves).toHaveBeenCalled())
      const reads: string[] = []
      const data = createChainData('restored', { layers, reader: chainReader(reads, files), incomplete: false, cache })
      expect((await data.session()).ids('Unit')).not.toContain('Ghost')
      expect(reads.some(file => file.startsWith('core:'))).toBe(false)
      files['core']!['Base.SC2Data/GameData/Later.txt'] = unit('Ghost')
      data.refresh([{ layerId: 'core', path: 'base.sc2data/gamedata/later.txt' }])
      expect((await data.session()).ids('Unit')).toContain('Ghost')
      expect(reads).toContain('core:Base.SC2Data/GameData/Later.txt')
    })

    it('shares a cold prefix parse across concurrent chains while keeping their models independent', async () => {
      const { createSc2DataCache } = await import('../../shared/workspace/data-cache-node.js')
      const { mkdtemp, readdir, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const directory = await mkdtemp(join(tmpdir(), 'sc2-cold-prefix-'))
      try {
        const cache = createSc2DataCache({ directory, mods: ['Void'] })!
        const reads: string[] = []
        const rightLayers = [...layers.slice(0, -1), { ...layers.at(-1)!, sourcePath: 'C:/Mods/Other.SC2Mod' }]
        const rightReader = (reads: string[]) => {
          const saved = chainReader(reads)
          return { ...saved, read: async (layerId: string, path: string) => {
            const bytes = await saved.read(layerId, path)
            return layerId === 'mine' ? new TextEncoder().encode(new TextDecoder().decode(bytes).replace('value="60"', 'value="80"')) : bytes
          } }
        }
        const expectedRight = answers(await createChainData('plain-right', {
          layers: rightLayers, reader: rightReader([]), incomplete: false,
        }).session())
        parses.paths.length = 0
        const [left, right] = await Promise.all([
          createChainData('left', { layers, reader: chainReader(reads), incomplete: false, cache }).session(),
          createChainData('right', { layers: rightLayers, reader: rightReader(reads), incomplete: false, cache }).session(),
        ])
        expect(answers(right)).toEqual(expectedRight)
        expect(answers(left)).not.toEqual(answers(right))
        expect(parses.paths.filter(file => file === 'mods/core.sc2mod/Base.SC2Data/GameData/UnitData.xml')).toHaveLength(1)
        expect(parses.paths.filter(file => file === 'mods/void.sc2mod/Base.SC2Data/GameData/UnitData.xml')).toHaveLength(1)
        expect(reads.filter(file => file.startsWith('core:'))).toHaveLength(1)
        expect(reads.filter(file => file.startsWith('mine:'))).toHaveLength(2)
        const before = answers(right)
        left.update(left.documents.map(document => document.rootId === layers.at(-1)!.rootId
          ? { ...document, text: document.text.replace('value="60"', 'value="70"') } : document))
        expect(answers(left)).not.toEqual(before)
        expect(answers(right)).toEqual(before)
        await vi.waitFor(async () => expect((await readdir(join(directory, 'sc2-data'))).some(file => file.endsWith('.v8'))).toBe(true))
      } finally { await rm(directory, { recursive: true, force: true }) }
    })

    it('keeps nothing when a leading layer has no content fingerprint', async () => {
      const { cache, saves } = memoryCache()
      const unfingerprinted = [stock('core', undefined, 'mods/core.sc2mod'), ...layers.slice(1)]
      const session = await createChainData('none', { layers: unfingerprinted, reader: chainReader([]), incomplete: false, cache }).session()
      expect(session.ids('Unit')).toEqual(['Base', 'Hero', 'Marine', 'Probe'])
      expect(saves).not.toHaveBeenCalled()
    })

    it('keeps records on disk with v8 serialization and answers the same from them', async () => {
      const { createSc2DataCache } = await import('../../shared/workspace/data-cache-node.js')
      const { mkdtemp, rm, readdir } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const directory = await mkdtemp(join(tmpdir(), 'sc2-data-cache-'))
      try {
        const cache = createSc2DataCache({ directory, mods: ['Void'] })!
        expect(cache.prefixOf(layers)?.count).toBe(2)
        expect(createSc2DataCache({ directory, mods: [] })).toBeUndefined()
        const plain = answers(await createChainData('disk-plain', { layers, reader: chainReader([]), incomplete: false }).session())
        await createChainData('disk-first', { layers, reader: chainReader([]), incomplete: false, cache }).session()
        await vi.waitFor(async () => expect((await readdir(join(directory, 'sc2-data'))).some(name => name.endsWith('.v8'))).toBe(true))
        const prefixKey = cache.prefixOf(layers)!.key
        const [firstRead, concurrentRead] = await Promise.all([cache.load(prefixKey), cache.load(prefixKey)])
        expect(firstRead).toBeDefined()
        serializations.count = 0
        await cache.save(prefixKey, firstRead!)
        const oneWrite = serializations.count
        expect(oneWrite).toBeGreaterThan(0)
        serializations.count = 0
        await expect(Promise.all([cache.save(prefixKey, firstRead!), cache.save(prefixKey, firstRead!)])).resolves.toHaveLength(2)
        expect(serializations.count).toBe(oneWrite)
        const otherCache = createSc2DataCache({ directory, mods: ['Void'] })!
        await expect(Promise.all([cache.save(prefixKey, firstRead!), otherCache.save(prefixKey, firstRead!)])).resolves.toHaveLength(2)
        const retryKey = `${prefixKey}:producer-retry`
        const failedProducer = vi.fn(async () => { throw new Error('test producer failed') })
        const failures = await Promise.allSettled([cache.load(retryKey, failedProducer), otherCache.load(retryKey, failedProducer)])
        expect(failedProducer).toHaveBeenCalledTimes(1)
        expect(failures.map(result => result.status)).toEqual(['rejected', 'rejected'])
        const replacement = vi.fn(async () => firstRead)
        expect(await cache.load(retryKey, replacement)).toBe(firstRead)
        expect(replacement).toHaveBeenCalledTimes(1)
        serializations.failNext = true
        await expect(cache.save(prefixKey, firstRead!)).rejects.toThrow('test serialization failed')
        expect(await cache.load(prefixKey)).toEqual(firstRead)
        await expect(cache.save(prefixKey, firstRead!)).resolves.toBeUndefined()
        expect((await readdir(join(directory, 'sc2-data'))).filter(name => name.endsWith('.tmp'))).toEqual([])
        expect(firstRead).toBeDefined()
        expect(concurrentRead).toBe(firstRead)
        const reads: string[] = []
        const kept = await createChainData('disk-kept', { layers, reader: chainReader(reads), incomplete: false, cache }).session()
        expect(answers(kept)).toEqual(plain)
        expect(reads).toEqual(['mine:Base.SC2Data/GameData/UnitData.xml'])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })
})

