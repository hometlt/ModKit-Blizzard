import { describe, expect, it, vi } from 'vitest'
import { modCardFacts, modResourceTree, type ModCardInput } from '../services/resources/src/mod-card.js'
import { parseLayout } from '../../layout/shared/layout-engine/sc2-layout-core/simple-parse/index.js'

// Subject-card adapters are unrelated to the source-location tree exercised here. Production
// resolves this portable-build alias to entity-cards; no portable rebuild is needed for this test.
vi.mock('@modkitx/sc2-entity-subjects', () => ({
  entitySubjectId: (namespace: string, id: string) => `entity:${namespace}/${id}`,
  entitySubjects: vi.fn(),
}))

function tree(
  documents: readonly (readonly [string, string])[],
  entities: Readonly<
    Record<string, readonly { id?: string; class?: string; data?: Record<string, unknown> }[]>
  >,
  model: Partial<ModCardInput['mod']> = {},
  listedOnly: readonly string[] = [],
  layeredSources?: ModCardInput['layeredSources'],
) {
  const input: ModCardInput = {
    root: { id: 'fixture:Active.SC2Mod', uri: 'fixture:Active.SC2Mod' } as ModCardInput['root'],
    revision: 'test',
    files: new Map(documents.map(([path, text]) => [path, new TextEncoder().encode(text)])),
    entries: [...documents.map(([path]) => path), ...listedOnly].map(path => ({
      path,
      kind: 'file',
    })),
    dependencies: [],
    ...(layeredSources === undefined ? {} : { layeredSources }),
    namespaces: Object.entries(entities).map(([ns, items]) => ({
      ns,
      total: items.length,
      own: items.length,
    })),
    mod: {
      locales: new Map(),
      namespaces: () => Object.keys(entities),
      all: ns => entities[ns] ?? [],
      ...model,
    },
  }
  return modResourceTree(input)
}

describe('mod resource declarations (source)', () => {
  it('publishes scalar constant values, including empty values, through the shared tree facts', async () => {
    const source = tree([], {
      Const: [
        { id: 'Life', data: { path: 'CUnit.LifeMax', value: '45' } },
        { id: 'Empty', data: { path: 'CUnit.Name', value: '' } },
        { id: 'Missing', data: { path: 'CUnit.Name' } },
      ],
    }, { fontStyles: {
      styles: new Map(), fontGroups: new Map(),
      constants: new Map([['Height', '14'], ['Alias', '#Height'], ['Empty', '']]),
    } })
    expect(await source.facts({ id: 'constant/Unit/Life' })).toMatchObject({ value: '45', preview: 'CUnit.LifeMax = 45' })
    expect(await source.facts({ id: 'constant/Unit/Empty' })).toHaveProperty('value', '')
    expect(await source.facts({ id: 'constant/Unit/Missing' })).not.toHaveProperty('value')
    expect(await source.facts({ id: 'style-item/constants/Alias' })).toMatchObject({ value: '14', preview: '14' })
    expect(await source.facts({ id: 'style-item/constants/Empty' })).toHaveProperty('value', '')
  })

  it('uses Galaxy-owned declarations for variable previews and preserves function navigation', async () => {
    const path = 'Base.SC2Data/TriggerLibs/Values.galaxy'
    const text = '// 😀 source offsets\nconst int limit = 2 + 3;\nint current;\nvoid Main(int player) {}'
    const source = tree([[path, text]], {})
    const variables = await source.children({ id: 'galaxy-kind/variable' }, { limit: 100 })
    const facts = await Promise.all(variables.items.map(node => source.facts(node)))
    const limit = facts.find(item => item.label === 'limit')!
    expect(limit.preview).toBe('const int limit = 2 + 3')
    expect(limit).not.toHaveProperty('value')
    expect(limit.range).toMatchObject({ utf16Offset: text.indexOf('limit'), line: 1, column: 10 })
    expect(limit.subjectId).toContain(encodeURIComponent(path))
    expect(facts.find(item => item.label === 'current')?.preview).toBe('int current')
    const functions = await source.children({ id: 'galaxy-kind/function' }, { limit: 100 })
    expect(await source.facts(functions.items[0]!)).toMatchObject({
      label: 'Main', preview: 'void Main(int player)',
      range: { utf16Offset: text.indexOf('Main'), line: 3, column: 5 },
    })
  })

  it('opens each style, editor value and asset alias in the package that contributed it', async () => {
    const stylePath = 'Base.SC2Data/UI/FontStyles.SC2Style'
    const editorPath = 'Base.SC2Data/EditorData/EditorCategories.xml'
    const aliasPath = 'Base.SC2Data/GameData/Assets.txt'
    const layered = [
      ['fixture:Core', stylePath, '<Styles><Style name="CoreOnly" height="12"/><Style name="Shared" height="13"/></Styles>'],
      ['fixture:Core', editorPath, '<EditorCategories><category name="Race"><value>Terr</value></category></EditorCategories>'],
      ['fixture:Core', aliasPath, 'CoreArt=Assets/Core.dds\nSharedArt=Assets/Old.dds'],
      ['fixture:Active', stylePath, '<Styles><Style name="Shared" height="14"/></Styles>'],
      ['fixture:Active', editorPath, '<EditorCategories><category name="Race"><value>Zerg</value></category></EditorCategories>'],
      ['fixture:Active', aliasPath, 'SharedArt=Assets/New.dds'],
    ] as const
    const sources = layered.map(([root, path, text]) => ({
      path, bytes: new TextEncoder().encode(text), root: { id: root, uri: root },
    }))
    const source = tree([], {}, {
      fontStyles: {
        constants: new Map(), fontGroups: new Map(),
        styles: new Map([
          ['CoreOnly', { name: 'CoreOnly', attrs: { height: '12' } }],
          ['Shared', { name: 'Shared', attrs: { height: '14' } }],
        ]),
      },
      editorCategories: { categories: new Map([['Race', ['Terr', 'Zerg']]]), objectUsage: new Map() },
      assetAliases: new Map([['CoreArt', 'Assets/Core.dds'], ['SharedArt', 'Assets/New.dds']]),
    }, [], sources)
    for (const [id, root] of [
      ['style-item/styles/CoreOnly', 'fixture:Core'],
      ['style-item/styles/Shared', 'fixture:Active'],
      ['editor-value/Race/0', 'fixture:Core'],
      ['editor-value/Race/1', 'fixture:Active'],
      ['asset-alias/CoreArt', 'fixture:Core'],
      ['asset-alias/SharedArt', 'fixture:Active'],
    ]) {
      expect((await source.facts({ id })).subjectId, id).toContain(root)
    }
  })

  it('shows inherited Layout template properties through the Layout owner', async () => {
    const templatePath = 'Base.SC2Data/UI/Layout/Tpl.SC2Layout'
    const instancePath = 'Base.SC2Data/UI/Layout/Main.SC2Layout'
    const template = '<Desc><Constant name="Size" val="120"/><Frame type="Frame" name="Base"><Width val="#Size"/></Frame></Desc>'
    const instance = '<Desc><Include path="Tpl.SC2Layout"/><Frame type="Frame" name="Instance" template="Tpl/Base"><Height val="60"/></Frame></Desc>'
    const source = tree([[templatePath, template], [instancePath, instance]], {}, {
      layouts: new Map([
        [templatePath, parseLayout(template)],
        [instancePath, parseLayout(instance)],
      ]),
    })
    const frame = { id: `layout-frame/${encodeURIComponent(instancePath)}/0`, hasChildren: true }
    const children = await source.children(frame, { limit: 100 })
    const properties = await Promise.all(children.items.map(item => source.facts(item)))
    expect(properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'layout-property', label: 'Width', preview: '120' }),
      expect.objectContaining({ kind: 'layout-property', label: 'Height', preview: '60' }),
    ]))
  })

  it('searches a layout file only when the term is in it, and skips layouts for a Data term', async () => {
    const templatePath = 'Base.SC2Data/UI/Layout/Tpl.SC2Layout'
    const instancePath = 'Base.SC2Data/UI/Layout/Main.SC2Layout'
    const template = '<Desc><Frame type="Frame" name="Base"><Texture val="Assets/Textures/minimapframe.dds"/></Frame></Desc>'
    const instance = '<Desc><Include path="Tpl.SC2Layout"/><Frame type="Frame" name="Instance" template="Tpl/Base"><Height val="60"/></Frame></Desc>'
    const layouts = new Map([[templatePath, parseLayout(template)], [instancePath, parseLayout(instance)]])
    const source = tree(
      [[templatePath, template], [instancePath, instance], ['Base.SC2Data/GameData/ModelData.xml', '<Catalog/>']],
      { Model: [{ id: 'Marine', class: 'CModel', data: { Model: 'Assets/Units/Terran/Marine/Marine.m3' } }] },
      { layouts, getResolved: (_ns, id) => (id === 'Marine' ? { Model: 'Assets/Units/Terran/Marine/Marine.m3' } : undefined) },
    )
    const found = async (pattern: string) => {
      const ids: string[] = []
      for await (const node of source.search({ pattern })) ids.push(node.id)
      return ids
    }
    // Found where the template writes it; the frame that inherits it is not walked again.
    expect((await found('minimapframe')).filter(id => id.startsWith('layout-'))).toEqual([
      `layout-property/${encodeURIComponent(templatePath)}/0/texture`,
    ])
    // A model path only Data names: the walk never resolves a layout frame.
    const parse = vi.spyOn(layouts, 'get')
    expect(await found('marine.m3')).toContain('field/Model/Marine/Model')
    expect(parse).not.toHaveBeenCalled()
  })

  it('uses catalog classes in custom/include filenames, ignoring comments and nested tags', async () => {
    const path = 'Includes/Mixed.xml'
    const text = [
      '<?xml version="1.0"?>',
      '<Catalog>',
      '  <!-- <CUnit id="Same"/> -->',
      '  <CUnit id="Container"><CUnit id="Same"/></CUnit>',
      '  <![CDATA[<CUnit id="Same"/>]]>',
      '  <!-- 😀 --> <CUnit id=\'Same\' parent="A > B"/>',
      "  <CWeaponLegacy id='Same'/>",
      "  <CUnit id='A&amp;B'/>",
      '</Catalog>',
    ].join('\r\n')
    const source = tree([[path, text]], {
      Unit: [{ id: 'Same' }, { id: 'A&B' }, { id: 'NestedOnly' }],
      Weapon: [{ id: 'Same' }],
    })
    for (const [namespace, id, tag] of [
      ['Unit', 'Same', '<CUnit id=\'Same\' parent="A > B"/>'],
      ['Weapon', 'Same', "<CWeaponLegacy id='Same'/>"],
      ['Unit', 'A&B', "<CUnit id='A&amp;B'/>"],
    ]) {
      const facts = await source.facts({
        id: `entity/${namespace}/${encodeURIComponent(id!)}`,
        hasChildren: false,
      })
      const offset = text.indexOf(tag!)
      // A click opens the card; the declaration is where "Go to declaration" goes (parity plan 5.29).
      expect(facts.subjectId).toMatch(new RegExp(`^modkit-subject://blizzard%2Fsc2-data/${namespace}/`, 'u'))
      expect(facts.declaration?.subjectId).toContain(`vfs-path=${encodeURIComponent(path)}`)
      expect(facts.declaration?.range).toEqual({
        utf16Offset: offset,
        utf16Length: tag!.length,
        line: text.slice(0, offset).split('\n').length - 1,
        column: offset - text.lastIndexOf('\n', offset) - 1,
      })
    }
    const nested = tree(
      [[path, '<Catalog><CUnit id="Outer"><CUnit id="NestedOnly"/></CUnit></Catalog>']],
      {
        Unit: [{ id: 'NestedOnly' }],
      },
    )
    expect((await nested.facts({ id: 'entity/Unit/NestedOnly' })).declaration).toBeUndefined()
    const comment = tree([[path, '<Catalog><!-- <CUnit id="Ghost"/> --></Catalog>']], {
      Unit: [{ id: 'Ghost' }],
    })
    expect((await comment.facts({ id: 'entity/Unit/Ghost' })).declaration).toBeUndefined()
  })

  it('uses the last declaration in loaded Map order, not sorted filenames or first match', async () => {
    const first = 'Z/Custom.xml'
    const last = 'A/Override.xml'
    const text = '<Catalog><CUnit id="Same"/>\n<CUnit id=\'Same\' parent="Winner"/></Catalog>'
    const source = tree(
      [
        [first, '<Catalog><CUnit id="Same"/></Catalog>'],
        [last, text],
        ['NotCatalog.xml', '<Other><CUnit id="Same"/></Other>'],
      ],
      { Unit: [{ id: 'Same' }] },
    )
    const facts = await source.facts({ id: 'entity/Unit/Same' })
    expect(facts.declaration?.subjectId).toContain(`vfs-path=${encodeURIComponent(last)}`)
    expect(facts.declaration?.range).toMatchObject({
      utf16Offset: text.indexOf("<CUnit id='Same'"),
      line: 1,
      column: 0,
    })
  })

  it('keys defaults by class across differently ordered layers and keeps Preload only in Files', async () => {
    const documents = [
      ['Z/Initial.xml', '<Catalog><CUnit default="1"/></Catalog>'],
      ['A/Override.xml', "<Catalog>\n<CUnit default='1'/></Catalog>"],
      ['Preload.xml', '<Preload/>'],
    ] as const
    const first = tree(documents, { Unit: [{ id: 'A' }, { id: '', class: 'CUnit' }] })
    const second = tree(documents, { Unit: [{ class: 'CUnit' }, { id: 'B' }, { class: 'CUnit' }] })
    const defaults = { id: 'defaults/Unit', hasChildren: true }
    const a = await first.children(defaults, { limit: 100 })
    const b = await second.children(defaults, { limit: 100 })
    expect(a.items).toEqual([{ id: 'default/Unit/CUnit', hasChildren: false }])
    expect(b.items).toEqual(a.items)
    expect(await second.facts(defaults)).toMatchObject({ value: 1, preview: '1' })
    expect(await second.facts(b.items[0]!)).toMatchObject({
      label: 'CUnit',
      preview: 'A/Override.xml',
      range: { line: 1, column: 0 },
    })
    const categories = await first.children(await first.root(), { limit: 100 })
    expect(categories.items.map(item => item.id)).not.toContain('category/preload')
    const files = await first.children({ id: 'filetype/Documents' }, { limit: 100 })
    expect(files.items.map(item => item.id)).toContain('file/Preload.xml')
    expect(await first.facts({ id: 'file/Preload.xml' })).toMatchObject({ label: 'Preload.xml' })
    const resolved = tree([['UnitData.xml', '<Catalog><CUnit default="1"/></Catalog>']], {
      Unit: [{ id: '', class: 'CUnit', data: { LifeMax: '10' } }],
    }, { getResolved: (namespace, id) => namespace === 'Unit' && id === ''
      ? { LifeMax: '20', Nested: { Speed: '2' } } : undefined })
    const fields = await resolved.children({ id: 'default/Unit/CUnit', hasChildren: true }, { limit: 100 })
    expect((await resolved.facts(fields.items.find(item => item.id.endsWith('/LifeMax'))!)).value).toBe('20')
    const nested = fields.items.find(item => item.id.endsWith('/Nested'))!
    expect((await resolved.children(nested, { limit: 100 })).items).toHaveLength(1)
  })

  // Parity plan 5.29: Preload entries as MK2's tree listed them, each opening its element.
  it('lists Preload entries, each opening the file at its element', async () => {
    const text = '<Preload>\n    <Unit id="Marine" Variations="0"/>\n    <Asset path="Assets/Marine.dds" Type="Image"/>\n</Preload>'
    const source = tree([['Preload.xml', text]], { Unit: [{ id: 'Marine' }] })
    const categories = await source.children(await source.root(), { limit: 100 })
    expect(categories.items).toContainEqual({ id: 'category/preload', hasChildren: true })
    const entries = await source.children({ id: 'category/preload', hasChildren: true }, { limit: 100 })
    const facts = await Promise.all(entries.items.map(item => source.facts(item)))
    expect(facts.map(item => [item.label, item.preview, item.range?.line, item.range?.column])).toEqual([
      ['Unit', 'Marine', 1, 4],
      ['Asset', 'Assets/Marine.dds', 2, 4],
    ])
    expect(facts[0]!.subjectId).toContain('vfs-path=Preload.xml')
    expect(facts[0]!.range?.utf16Offset).toBe(text.indexOf('<Unit'))
  })

  // Parity plan 5.29: Files as MK2 had them — every family, assets too, as folders, and what the
  // loaded dependencies bring under «From dependencies», each opening in its own package.
  it('lists every file by family as folders, with the dependencies\' files beside', async () => {
    const core = { id: 'fixture:Core', uri: 'fixture:Core' }
    const source = modResourceTree({
      root: { id: 'fixture:Active', uri: 'fixture:Active' } as ModCardInput['root'],
      revision: 'test',
      files: new Map(),
      entries: [],
      dependencies: [],
      layerFiles: [
        { path: 'mods/core.sc2mod', root: core as never, paths: ['Base.SC2Data/UI/Icons/a.dds', 'Base.SC2Data/UI/Icons/b.dds'] },
        { path: 'mods/active.sc2mod', root: { id: 'fixture:Active', uri: 'fixture:Active' } as never,
          paths: ['Assets/Textures/Hero.dds', 'Assets/Textures/Sub/Hero_Normal.dds', 'Assets/Units/Hero.m3', 'DocumentInfo'] },
      ],
      namespaces: [],
      mod: { locales: new Map(), namespaces: () => [], all: () => [] },
    })
    const labels = async (node: { id: string; hasChildren?: boolean }) => Promise.all(
      (await source.children(node as never, { limit: 100 })).items.map(async item => {
        const facts = await source.facts(item)
        return `${facts.label} (${facts.preview})`
      }))
    expect(await labels({ id: 'category/files' })).toEqual(['Images (4)', 'Models (1)', 'Documents (1)'])
    expect(await labels({ id: 'filetype/Images' })).toEqual(['Assets/Textures (2)', 'From dependencies (2)'])
    const textures = (await source.children({ id: 'filetype/Images', hasChildren: true }, { limit: 100 })).items[0]!
    expect(await labels(textures)).toEqual(['Sub (1)', 'Hero.dds (Assets/Textures/Hero.dds)'])
    const [core1] = (await source.children({ id: 'filedeps/Images', hasChildren: true }, { limit: 100 })).items
    expect(await source.facts(core1!)).toMatchObject({ kind: 'file-source', label: 'core.sc2mod', preview: '2' })
    const [icons] = (await source.children(core1!, { limit: 100 })).items
    expect(await source.facts(icons!)).toMatchObject({ label: 'Base.SC2Data/UI/Icons', preview: '2' })
    const [icon] = (await source.children(icons!, { limit: 100 })).items
    expect(await source.facts(icon!)).toMatchObject({ label: 'a.dds', preview: 'Base.SC2Data/UI/Icons/a.dds · core.sc2mod' })
    expect((await source.facts(icon!)).subjectId).toMatch(/^fixture:Core\?vfs-path=/u)
  })

  // Parity plan 5.28: the grouping MK2's mod card offered, by resolved EditorCategories.
  it('groups a namespace by resolved editor categories, uncategorized last', async () => {
    const categories: Record<string, string> = {
      Marine: 'ObjectType:Unit,ObjectFamily:Melee',
      Hydralisk: 'ObjectType:Unit,ObjectFamily:Melee',
      Beacon: 'ObjectType:Doodad',
    }
    const source = tree([], {
      Unit: [
        { id: 'Marine', data: { EditorCategories: categories['Marine']! } },
        { id: 'Hydralisk' },
        { id: 'Beacon' },
        { id: 'Probe' },
      ],
      Weapon: [{ id: 'GaussRifle' }],
    }, { getResolved: (namespace, id) =>
      namespace === 'Unit' && categories[id] !== undefined ? { EditorCategories: categories[id] } : {} })
    const unit = await source.children({ id: 'namespace/Unit', hasChildren: true }, { limit: 100 })
    expect(unit.items.map(item => item.id)).toEqual([
      'editor-groups/Unit', 'entity/Unit/Marine', 'entity/Unit/Hydralisk', 'entity/Unit/Beacon', 'entity/Unit/Probe',
    ])
    expect((await source.children({ id: 'namespace/Weapon', hasChildren: true }, { limit: 100 })).items
      .map(item => item.id)).not.toContain('editor-groups/Weapon')
    const groups = (await source.children(unit.items[0]!, { limit: 100 })).items
    expect(await Promise.all(groups.map(async group => {
      const facts = await source.facts(group)
      const members = (await source.children(group, { limit: 100 })).items.map(item => item.id.split('/').at(-1))
      return `${facts.label} (${facts.preview}): ${members.join(', ')}`
    }))).toEqual([
      'ObjectType:Doodad (1): Beacon',
      'ObjectType:Unit · ObjectFamily:Melee (2): Marine, Hydralisk',
      'Uncategorized (1): Probe',
    ])
    const found: string[] = []
    for await (const node of source.search({ pattern: 'Hydralisk' })) found.push(node.id)
    expect(found.filter(id => id === 'entity/Unit/Hydralisk')).toHaveLength(1)
  })

  // A reader caps the hits (200 per mod): an entity named by the term comes before the
  // tree-order matches, which for «SCV» filled up on Abil and Actor first.
  it('finds the entity the term names first, then the ones it starts, then the rest', async () => {
    const source = tree([], {
      Abil: [{ id: 'BuildSCVArmor' }, { id: 'SCVHarvest' }],
      Actor: [{ id: 'SCVActor' }],
      Unit: [{ id: 'Marine' }, { id: 'SCV' }],
    })
    const found: string[] = []
    for await (const node of source.search({ pattern: 'scv' })) found.push(node.id)
    expect(found.slice(0, 3)).toEqual(['entity/Unit/SCV', 'entity/Abil/SCVHarvest', 'entity/Actor/SCVActor'])
    expect(found.filter(id => id.startsWith('entity/'))).toEqual([
      'entity/Unit/SCV', 'entity/Abil/SCVHarvest', 'entity/Actor/SCVActor', 'entity/Abil/BuildSCVArmor',
    ])
  })

  // Parity plan 5.29: a loaded dependency opens as its package, implicit ones included.
  it('opens a loaded dependency as its own package', async () => {
    const source = modResourceTree({
      root: { id: 'fixture:Active', uri: 'fixture:Active' } as ModCardInput['root'],
      revision: 'test',
      files: new Map(),
      entries: [],
      dependencies: [],
      dependencyChain: [
        { path: 'mods/core.sc2mod', required: true, basis: 'engine-implicit', subjectId: 'content-source://local:casc/mods/core.sc2mod' },
        { path: 'mods/other.sc2mod', required: true, basis: 'engine-implicit' },
      ],
      namespaces: [],
      mod: { locales: new Map(), namespaces: () => [], all: () => [] },
    })
    expect((await source.facts({ id: 'dependency/0', hasChildren: false })).subjectId)
      .toBe('content-source://local:casc/mods/core.sc2mod')
    expect((await source.facts({ id: 'dependency/1', hasChildren: false })).subjectId).toBeUndefined()
  })

  // Parity plan 5.28: MK2's build and flags chips, and the assets by family.
  it('puts the build, the header flags and assets by family on the mod card', () => {
    const card = modCardFacts({
      root: { id: 'fixture:Active', uri: 'fixture:Active' } as ModCardInput['root'],
      revision: 'test',
      files: new Map(),
      entries: ['Assets/a.dds', 'Assets/b.tga', 'Assets/Units/Hero.m3', 'Sounds/Hit.ogg', 'DocumentInfo']
        .map(path => ({ path, kind: 'file' })),
      dependencies: [],
      namespaces: [],
      mod: { locales: new Map(), namespaces: () => [], all: () => [],
        documentHeader: { entries: [], timestamp1: 81102, flags: 0x201 } },
    })
    const facts = card.factGroups.flatMap(group => group.facts)
    const value = (id: string) => facts.find(fact => fact.id === id)?.value
    expect([value('build'), value('flags')]).toEqual([81102, '0x201'])
    expect([value('assets-images'), value('assets-models'), value('assets-audio'), value('assets-fonts')])
      .toEqual([2, 1, 1, undefined])
  })

  // Parity plan 5.29: an entity shows its name beside its id, `↑` when a dependency declares it.
  it('names entities beside their ids and finds them by name', async () => {
    const strings = new Map([['enus', new Map([['GameStrings', new Map([
      ['Unit/Name/Marine', 'Space <c val="ff0000">Marine</c>'],
      ['Unit/Name/Zergling', 'Zergling'],
    ])]])]])
    const source = tree([], {
      Unit: [
        { id: 'Marine', source: { mod: 'mods/active.sc2mod', file: 'UnitData.xml' } },
        { id: 'Zergling', source: { mod: 'mods/core.sc2mod', file: 'UnitData.xml' } },
      ] as never,
    }, { locales: strings, loadOrder: ['mods/core.sc2mod', 'mods/active.sc2mod'] })
    expect((await source.facts({ id: 'entity/Unit/Marine', hasChildren: false })).preview).toBe('Space Marine')
    expect((await source.facts({ id: 'entity/Unit/Zergling', hasChildren: false })).preview).toBe('↑ Zergling')
    const found: string[] = []
    for await (const node of source.search({ pattern: 'space marine' })) found.push(node.id)
    expect(found).toContain('entity/Unit/Marine')

    // In the context's locale, as the game shows it to its player (VS Code `modkit.locale`).
    strings.set('ruru', new Map([['GameStrings', new Map([['Unit/Name/Marine', 'Космопехотинец']])]]))
    const russian = modResourceTree({
      root: { id: 'fixture:Active', uri: 'fixture:Active' } as ModCardInput['root'],
      revision: 'test',
      locale: 'ruRU',
      files: new Map(),
      entries: [],
      dependencies: [],
      namespaces: [{ ns: 'Unit', own: 1, total: 1 }],
      mod: { locales: strings, namespaces: () => ['Unit'], all: ns => (ns === 'Unit' ? [{ id: 'Marine' }] : []) },
    })
    expect((await russian.facts({ id: 'entity/Unit/Marine', hasChildren: false })).preview).toBe('Космопехотинец')
  })

  it('shows constants in their Data spaces and parsed Galaxy, layout, editor and style resources', async () => {
    const source = tree(
      [
        [
          'Base.SC2Data/GameData/UnitData.xml',
          '<Catalog><const id="Life" path="CUnit.LifeMax" value="45"/></Catalog>',
        ],
        ['Base.SC2Data/UI/Layout/Custom/Main.SC2Layout', '<Desc/>'],
        ['Base.SC2Data/TriggerLibs/Test.galaxy', 'int count;\nvoid Init() {}'],
      ],
      {
        Unit: [{ id: 'Marine' }],
        Const: [{ id: 'Life', class: 'const', data: { path: 'CUnit.LifeMax', value: '45' } }],
      },
      {
        getResolved: (namespace, id) => namespace === 'Unit' && id === 'Marine'
          ? { LifeMax: '45', Stats: { Speed: '2.25' } } : undefined,
        structureDefaults: namespace => namespace === 'Unit'
          ? new Map([['SCost', { Minerals: '50' }]]) : new Map(),
        layouts: new Map([
          [
            'Base.SC2Data/UI/Layout/Custom/Main.SC2Layout',
            {
              frames: [
                {
                  name: 'MainFrame',
                  type: 'Frame',
                  anchors: [],
                  properties: [],
                  animations: [],
                  children: [
                    {
                      name: 'Child',
                      type: 'Button',
                      anchors: [],
                      properties: [],
                      animations: [],
                      children: [],
                    },
                  ],
                },
              ],
              constants: [{ name: 'Scale', val: '2' }],
              includes: [],
              animations: [],
              templates: [],
              references: [],
            },
          ],
        ]),
        editorCategories: {
          categories: new Map([['Race', ['Terr', 'Zerg']]]),
          objectUsage: new Map(),
        },
        fontStyles: {
          styles: new Map([['Title', { name: 'Title', attrs: { font: 'Default' } }]]),
          constants: new Map([['TextSize', '14']]),
          fontGroups: new Map(),
        },
      },
    )

    const dataSpaces = await source.children({ id: 'category/gamedata' }, { limit: 100 })
    expect(dataSpaces.items.map(item => item.id)).toContain('namespace/Unit')
    expect(dataSpaces.items.map(item => item.id)).not.toContain('namespace/Const')
    const unit = await source.children({ id: 'namespace/Unit' }, { limit: 100 })
    expect(unit.items.map(item => item.id)).toContain('constants/Unit')
    expect(unit.items.map(item => item.id)).toContain('defaults/Unit')
    const defaults = await source.children({ id: 'defaults/Unit' }, { limit: 100 })
    const cost = defaults.items.find(item => item.id === 'structure-default/Unit/SCost')!
    const costFields = await source.children(cost, { limit: 100 })
    expect((await source.facts(costFields.items[0]!)).value).toBe('50')
    const marine = unit.items.find(item => item.id === 'entity/Unit/Marine')!
    expect(marine.hasChildren).toBe(true)
    const fields = await source.children(marine, { limit: 100 })
    expect((await source.facts(fields.items.find(item => item.id.endsWith('/LifeMax'))!)).value).toBe('45')
    const stats = fields.items.find(item => item.id.endsWith('/Stats'))!
    const nestedFields = await source.children(stats, { limit: 100 })
    expect((await source.facts(nestedFields.items[0]!)).preview).toBe('2.25')
    const constants = await source.children({ id: 'constants/Unit' }, { limit: 100 })
    expect((await source.facts(constants.items[0]!)).subjectId).toContain('UnitData.xml')
    const withUnknown = tree([], {
      Unit: [{ id: 'Marine' }],
      Const: [
        { id: 'Life', data: { path: 'CUnit.LifeMax' } },
        { id: 'Unknown', data: {} },
      ],
    })
    expect((await withUnknown.facts({ id: 'namespace/Const' })).value).toBe(1)

    const galaxy = await source.children({ id: 'category/galaxy' }, { limit: 100 })
    expect(galaxy.items.map(item => item.id)).toContain('galaxy-kind/function')
    expect(galaxy.items.map(item => item.id)).toContain('galaxy-kind/variable')
    const functions = await source.children({ id: 'galaxy-kind/function' }, { limit: 100 })
    expect((await source.facts(functions.items[0]!)).label).toBe('Init')

    const layout = await source.children({ id: 'category/layouts' }, { limit: 100 })
    const sections = await source.children(layout.items[0]!, { limit: 100 })
    expect(sections.items.map(item => item.id)).toContain(
      'layout-section/Base.SC2Data%2FUI%2FLayout%2FCustom%2FMain.SC2Layout/frames',
    )
    const frames = await source.children(sections.items[0]!, { limit: 100 })
    const nested = await source.children(frames.items[0]!, { limit: 100 })
    expect((await source.facts(nested.items[0]!)).label).toBe('Child')
    const editor = await source.children({ id: 'category/editor-categories' }, { limit: 100 })
    expect((await source.facts(editor.items[0]!)).label).toBe('Race')
    const styles = await source.children({ id: 'category/font-styles' }, { limit: 100 })
    expect(styles.items.map(item => item.id)).toEqual([
      'style-section/styles',
      'style-section/constants',
    ])
    expect((await source.facts({ id: 'category/font-styles' })).preview).toBe('1 styles')
    const style = await source.children({ id: 'style-section/styles' }, { limit: 100 })
    const attributes = await source.children(style.items[0]!, { limit: 100 })
    expect(await source.facts(attributes.items[0]!)).toMatchObject({ label: 'font', value: 'Default' })
    const files = await source.children({ id: 'category/files' }, { limit: 100 })
    expect(files.items.map(item => item.id)).toEqual([
      'filetype/Galaxy',
      'filetype/Layouts',
      'filetype/Catalogs',
    ])
  })

  it('lists document entries without reading binary triggers into the mod model', async () => {
    const source = tree([], {}, {}, ['Triggers', 'DocumentHeader'])
    expect(
      (await source.children({ id: 'filetype/Galaxy' }, { limit: 100 })).items.map(item => item.id),
    ).toEqual(['file/Triggers'])
    expect(
      (await source.children({ id: 'filetype/Documents' }, { limit: 100 })).items.map(
        item => item.id,
      ),
    ).toEqual(['file/DocumentHeader'])
    expect((await source.facts({ id: 'file/Triggers' })).subjectId).toContain('Triggers')
  })
})
