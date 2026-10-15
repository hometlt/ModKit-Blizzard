/**
 * The Mod card and the entity cards a mod lends, on a loose `.SC2Mod` directory.
 *
 * Opened through the shipped portable bundle, the way a host loads it: the mod's own documents give
 * the identity, the component list and the counts; every entity is lent through the selector and
 * its card is resolved against the whole mod, with the mod's strings in each locale.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDirectoryArtifactSource } from '@modkit/host/node'
import { createCodec } from '../../../dist/modules/mod/codecs/mod/portable/directory-codec.mjs'

const budget = { maxInputBytes: 64_000_000n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 16_000_000, maxDiagnostics: 1_000 }
const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: { async resolve() { throw new Error('no service in this test') }, async resolveUnknown() { throw new Error('no service in this test') } },
}

const files: Record<string, string> = {
  'ComponentList.SC2Components': '<?xml version="1.0" encoding="utf-8"?>\n<Components>\n    <DataComponent Type="gada">GameData</DataComponent>\n    <DataComponent Type="text" Locale="enUS">GameText</DataComponent>\n    <DataComponent Type="text" Locale="ruRU">GameText</DataComponent>\n    <DataComponent Type="info">DocumentInfo</DataComponent>\n</Components>\n',
  DocumentInfo: '<?xml version="1.0" encoding="utf-8"?>\n<DocInfo>\n    <Icon>\n        <Value>logo-small.png</Value>\n    </Icon>\n    <Dependencies>\n        <Value>bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod</Value>\n    </Dependencies>\n</DocInfo>\n',
  'Base.SC2Data/GameData/UnitData.xml': '<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n    <CUnit id="Zealot">\n        <LifeMax value="100"/>\n        <ShieldsMax value="50"/>\n        <LifeArmor value="1"/>\n        <Speed value="3.15"/>\n        <Food value="-2"/>\n        <CostResource index="Minerals" value="100"/>\n        <WeaponArray Link="PsiBlades"/>\n    </CUnit>\n</Catalog>\n',
  'Base.SC2Data/GameData/WeaponData.xml': '<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n    <CWeaponLegacy id="PsiBlades">\n        <Range value="0.1"/>\n        <Period value="1.2"/>\n    </CWeaponLegacy>\n</Catalog>\n',
  'enUS.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/Zealot=Zealot\nWeapon/Name/PsiBlades=Psi Blades\n',
  'ruRU.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/Zealot=Фанатик\n',
}

let root = ''
beforeAll(() => {
  root = join(mkdtempSync(join(tmpdir(), 'sc2-mod-card-')), 'AllRaces2-Data.SC2Mod')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
})
afterAll(() => rmSync(dirname(root), { recursive: true, force: true }))

async function open() {
  const source = await openDirectoryArtifactSource(root)
  const input = {
    originKind: 'namespace',
    root: source.ref,
    bindings: [],
    revisions: { topology: 'namespace', revision: source.revision, namespaceRevision: source.revision, bindings: [], compositionFingerprint: source.ref.id },
    bindingsFor: () => [],
    async openBinding() { throw new Error('no bindings') },
    openNamespace: (signal?: AbortSignal) => source.openNamespace(signal),
  }
  return createCodec(context as never).open(input as never, 'full', budget as never)
}

async function all<T>(read: (page: { limit: number; cursor?: string }) => Promise<{ items: readonly T[]; nextCursor?: string }>) {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const page = await read({ limit: 64, ...(cursor === undefined ? {} : { cursor }) })
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return items
}

describe('SC2 mod card', () => {
  it('exports catalog entities and localized strings through both mod formats', async () => {
    const session = await open()
    try {
      const jsonMod = await session.operations().invoke('export-convert', { format: 'json-mod' })
      expect(jsonMod).toMatchObject({ state: 'ok', output: { kind: 'json', value: {
        manifest: { format: 'modkit-json-mod@1' },
        entries: { Unit: { Zealot: expect.any(Object) }, Weapon: { PsiBlades: expect.any(Object) } },
      } } })
      const components = await session.operations().invoke('export-convert', { format: 'sc2components' })
      expect(components).toMatchObject({ state: 'ok', output: { kind: 'json' } })
      const exported = (components as { output: { value: { files: { path: string; content: string }[] } } }).output.value.files
      expect(exported.find(file => /\/UnitData\.xml$/iu.test(file.path))?.content).toContain('id="Zealot"')
      expect(exported.find(file => file.path === 'ruru.sc2data/LocalizedData/GameStrings.txt')?.content)
        .toBe(files['ruRU.SC2Data/LocalizedData/GameStrings.txt'])
      expect(exported.find(file => file.path === 'ComponentList.SC2Components')?.content).toContain('<Components>')
    } finally {
      await session.dispose()
    }
  })

  it('publishes the legacy resource categories through the common lazy tree', async () => {
    const session = await open()
    try {
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      const tree = lease.value
      const rootNode = await tree.root()
      const categoryRefs = await all(page => tree.children(rootNode, page))
      const categories = await Promise.all(categoryRefs.map(ref => tree.facts(ref)))
      expect(categories.map(item => item.label)).toEqual([
        'GameData',
        'Strings',
        'Galaxy',
        'Layouts',
        'Asset aliases',
        'EditorCategories',
        'FontStyles',
        'Files',
        'Dependencies',
      ])
      expect(categories.find(item => item.label === 'GameData')?.preview).toBe('2')
      expect(categories.find(item => item.label === 'Strings')?.preview).toBe('2 locales · 3 keys')

      const gameData = categoryRefs[categories.findIndex(item => item.label === 'GameData')]!
      const namespaceRefs = await all(page => tree.children(gameData, page))
      const namespaceFacts = await Promise.all(namespaceRefs.map(ref => tree.facts(ref)))
      const units = namespaceRefs[namespaceFacts.findIndex(item => item.label === 'Unit')]!
      const entityRefs = await all(page => tree.children(units, page))
      const entityFacts = await Promise.all(entityRefs.map(ref => tree.facts(ref)))
      /*
       * An entity declared in this package addresses its declaration, not the logical data
       * subject: opening a resource is «go to where this is written». The logical subject remains
       * the address for an entity this package only inherits.
       */
      expect(entityFacts).toContainEqual(
        expect.objectContaining({
          label: 'Zealot',
          declaration: expect.objectContaining({
            subjectId: expect.stringContaining(
              `vfs-path=${encodeURIComponent('Base.SC2Data/GameData/UnitData.xml')}`,
            ),
          }),
        }),
      )

      const matches: any[] = []
      for await (const ref of tree.search({ pattern: 'Zealot' })) matches.push(await tree.facts(ref))
      expect(matches).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Zealot' })]))
      await lease.release()
    } finally {
      await session.dispose()
    }
  })

  it('groups the loaded files by type and lists the whole load chain from Core', async () => {
    const session = await open()
    try {
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      const tree = lease.value
      const rootNode = await tree.root()
      const categoryRefs = await all(page => tree.children(rootNode, page))
      const categories = await Promise.all(categoryRefs.map(ref => tree.facts(ref)))

      // Files carries the package's files by resource family, each family a folder tree whose
      // lone-folder chains read as one row (parity plan 5.29).
      const filesRef = categoryRefs[categories.findIndex(item => item.label === 'Files')]!
      const typeRefs = await all(page => tree.children(filesRef, page))
      const types = await Promise.all(typeRefs.map(ref => tree.facts(ref)))
      expect(types.map(item => item.label)).toEqual(['Catalogs', 'Strings', 'Documents'])
      const xmlRef = typeRefs[types.findIndex(item => item.label === 'Catalogs')]!
      const [folderRef, ...loose] = await all(page => tree.children(xmlRef, page))
      expect(loose).toEqual([])
      expect(await tree.facts(folderRef!)).toMatchObject({ kind: 'folder', label: 'Base.SC2Data/GameData', preview: '2' })
      const xmlFiles = await Promise.all(
        (await all(page => tree.children(folderRef!, page))).map(ref => tree.facts(ref)),
      )
      expect(xmlFiles.map(item => item.label)).toEqual(['UnitData.xml', 'WeaponData.xml'])
      // A file resource names its own entry, so opening it opens that file and not the package.
      expect(xmlFiles[0]?.subjectId).toContain(
        `vfs-path=${encodeURIComponent('Base.SC2Data/GameData/UnitData.xml')}`,
      )

      // Declaring VoidMulti alone still loads Core, Liberty, Swarm and Void underneath it.
      const dependencyRef = categoryRefs[categories.findIndex(item => item.label === 'Dependencies')]!
      const links = await Promise.all(
        (await all(page => tree.children(dependencyRef, page))).map(ref => tree.facts(ref)),
      )
      expect(links.map(item => item.preview)).toEqual([
        '1. Mods/Core.SC2Mod · engine-implicit',
        '2. Mods/Liberty.SC2Mod · engine-implicit',
        '3. Mods/Swarm.SC2Mod · engine-implicit',
        '4. Mods/Void.SC2Mod · engine-implicit',
        '5. Mods/VoidMulti.SC2Mod',
      ])
      expect(links.at(-1)?.subjectId).toContain(`vfs-path=${encodeURIComponent('DocumentInfo')}`)
      expect(links[0]?.subjectId).toBeUndefined()

      // Strings group by the leading segment of the key and open at the line that defines them.
      const strings = categoryRefs[categories.findIndex(item => item.label === 'Strings')]!
      const localeRefs = await all(page => tree.children(strings, page))
      const locales = await Promise.all(localeRefs.map(ref => tree.facts(ref)))
      const enUs = localeRefs[locales.findIndex(item => item.label === 'enUS')]!
      const catalogRefsOfLocale = await all(page => tree.children(enUs, page))
      const groupRefs = await all(page => tree.children(catalogRefsOfLocale[0]!, page))
      const groups = await Promise.all(groupRefs.map(ref => tree.facts(ref)))
      expect(groups.map(item => item.label)).toEqual(['Unit', 'Weapon'])
      const unitKeys = await Promise.all(
        (await all(page => tree.children(groupRefs[0]!, page))).map(ref => tree.facts(ref)),
      )
      expect(unitKeys[0]).toMatchObject({ label: 'Unit/Name/Zealot', preview: 'Zealot' })
      expect(unitKeys[0]?.subjectId).toContain(
        `vfs-path=${encodeURIComponent('enUS.SC2Data/LocalizedData/GameStrings.txt')}`,
      )
      expect(unitKeys[0]?.range).toMatchObject({ line: 0, column: 0 })

      // An entity opens its card; it is declared at a line of the document that declares it.
      const gameData = categoryRefs[categories.findIndex(item => item.label === 'GameData')]!
      const namespaceRefs = await all(page => tree.children(gameData, page))
      const namespaces = await Promise.all(namespaceRefs.map(ref => tree.facts(ref)))
      const units = namespaceRefs[namespaces.findIndex(item => item.label === 'Unit')]!
      const zealot = (await Promise.all(
        (await all(page => tree.children(units, page))).map(ref => tree.facts(ref)),
      )).find(item => item.label === 'Zealot')
      expect(zealot?.subjectId).toBe('modkit-subject://blizzard%2Fsc2-data/Unit/Zealot')
      expect(zealot?.declaration?.subjectId).toContain(
        `vfs-path=${encodeURIComponent('Base.SC2Data/GameData/UnitData.xml')}`,
      )
      expect(zealot?.declaration?.range).toMatchObject({ line: 2, column: 4 })
      await lease.release()
    } finally {
      await session.dispose()
    }
  })

  it('shows identity, dependencies, components, counts and links to the main documents', async () => {
    const session = await open()
    try {
      const lease = await session.dataSource('common.view/subject-facts-source', 1)
      const facts = lease.value
      const groups = await all(page => facts.groups(page))
      expect(groups.map(group => group.id)).toEqual(expect.arrayContaining(['overview', 'mod-dependencies', 'components', 'mod-contents']))
      expect(await all(page => facts.facts('overview', page))).toContainEqual(expect.objectContaining({ id: 'icon', value: 'logo-small.png' }))
      expect(await all(page => facts.facts('mod-dependencies', page))).toEqual([
        expect.objectContaining({ label: 'Void Multi (Mod)', value: { 'Battle.net id': '999', version: '0.0', file: 'Mods/VoidMulti.SC2Mod' } }),
      ])
      expect((await all(page => facts.facts('components', page))).map((item: any) => [item.label, item.value])).toEqual([
        ['gada', 'GameData'],
        ['text (enUS)', 'GameText'],
        ['text (ruRU)', 'GameText'],
        ['info', 'DocumentInfo'],
      ])
      const contents = await all(page => facts.facts('mod-contents', page))
      expect(contents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'own-entities', value: 2 }),
        expect.objectContaining({ id: 'files', value: 6 }),
      ]))
      // Read from the package alone: no chain was loaded, so nothing claims inherited entities.
      expect(contents.some((item: any) => item.id === 'entities')).toBe(false)
      const relations = await all(page => facts.relations(page))
      const documents = relations.filter((item: any) => item.role === 'Documents').map((item: any) => item.label)
      expect(documents).toEqual(expect.arrayContaining(['DocumentInfo', 'ComponentList.SC2Components', 'Base.SC2Data/GameData/UnitData.xml', 'enUS.SC2Data/LocalizedData/GameStrings.txt']))
      // A document link is the address the namespace opens that member under.
      expect(relations.find((item: any) => item.label === 'DocumentInfo')?.subjectId).toMatch(/\?vfs-path=DocumentInfo$/u)
      expect(relations).toContainEqual(expect.objectContaining({ role: 'Units', label: 'Zealot', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Zealot' }))
      await lease.release()
    } finally {
      await session.dispose()
    }
  })

  it('lends a unit card resolved against the whole mod, in each of its locales', async () => {
    const session = await open()
    try {
      const lease = await session.dataSource('common.view/subject-selector-source', 1)
      const selector = lease.value
      const units = await selector.subjects({ limit: 10, kind: 'Unit' })
      expect(units.items.map((item: any) => item.label)).toEqual(['Zealot'])
      const card = await selector.openFacts('modkit-subject://blizzard%2Fsc2-data/Unit/Zealot')
      const summary = await card.value.summary()
      expect(summary.identity).toMatchObject({ kind: 'Unit', label: 'Zealot', localizedLabels: { enUS: 'Zealot', ruRU: 'Фанатик' } })
      const stats = await all(page => card.value.facts('stats', page))
      expect(stats).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'life', value: 100 }),
        expect.objectContaining({ id: 'life-armor', value: 1 }),
        expect.objectContaining({ id: 'shields', value: 50 }),
        expect.objectContaining({ id: 'minerals', value: 100 }),
      ]))
      const overview = await all(page => card.value.facts('overview', page))
      expect(overview).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'name', value: 'Zealot', locale: 'enUS' }),
        expect.objectContaining({ id: 'name', value: 'Фанатик', locale: 'ruRU' }),
      ]))
      // The weapon lives in another file of the mod and is still a resolved, linked subject.
      const relations = await all(page => card.value.relations(page))
      expect(relations).toContainEqual(expect.objectContaining({ role: 'Weapons', label: 'Psi Blades', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Weapon/PsiBlades' }))
      const weapon = await selector.openFacts('modkit-subject://blizzard%2Fsc2-data/Weapon/PsiBlades')
      expect((await weapon.value.summary()).identity).toMatchObject({ kind: 'Weapon', label: 'Psi Blades' })
      await weapon.release()
      await card.release()
      await lease.release()
    } finally {
      await session.dispose()
    }
  })
  // Plan 5.3: an entity card of the mod panel writes a field into the mod file declaring it.
  it('writes an entity field of the mod into its declaring file through edit.field', async () => {
    const session = await open()
    try {
      const selector = (await session.dataSource('common.view/subject-selector-source', 1)).value
      const zealot = await selector.openFacts('modkit-subject://blizzard%2Fsc2-data/Unit/Zealot')
      const facts = await all((page: { limit: number; cursor?: string }) => zealot.value.facts('fields', page))
      const speed = facts.find((item: { label: string }) => item.label === 'Speed') as { editable?: { write?: unknown } } | undefined
      expect(speed?.editable?.write).toBeDefined()
      await zealot.release()
      const result = await session.operations().invoke('edit-field', { path: ['Unit', 'Zealot', 'Speed'], value: '4' })
      expect(result).toMatchObject({ state: 'ok', output: { kind: 'edit-plan' } })
      const plan = (result as { output: { plan: any } }).output.plan
      expect(plan.targets).toHaveLength(1)
      expect(plan.targets[0].subjectUri).toContain('UnitData.xml')
      const edit = plan.edits[0]
      expect(edit).toMatchObject({ operation: 'replace', targetId: plan.targets[0].targetId })
      const written = new TextDecoder().decode(edit.payload.bytes)
      expect(written).toBe(files['Base.SC2Data/GameData/UnitData.xml']!.replace('<Speed value="3.15"/>', '<Speed value="4"/>'))
      await expect(session.operations().invoke('edit-field', { path: ['Unit', 'Zealot', 'id'], value: 'X' })).rejects.toThrow('entity metadata')
    } finally {
      await session.dispose()
    }
  })
})
