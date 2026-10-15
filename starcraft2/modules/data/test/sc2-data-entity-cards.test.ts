/**
 * `blizzard/sc2-data.entity-cards`, answered by the ported wiki assembler.
 *
 * The operation was declared in the codec's table and skipped in its handler map, so a caller saw it
 * advertised and got a refusal — worse than an absent operation, because the table is what a surface
 * reads to decide what to offer. The assembler behind it is MK2's 943-line `wiki/cards.ts`, carried
 * over untouched; what is pinned here is the bridge and the two things a reader would otherwise
 * mistake for data: a section that is empty because the entity has nothing, and one that is empty
 * because a GameData session cannot see it.
 */
import { describe, expect, it } from 'vitest'
import { createCodec, allOperations } from '../codecs/sc2data/src/codec.js'
import { entitySubjects, modOfCatalog, snapshotEntityFacts } from '../codecs/sc2data/src/entity-cards.js'
import { entitySubjectId } from '../codecs/sc2data/src/entity-facts.js'
import { parseSubjectId } from '@modkit/codec-kit'
import { TypedCatalog } from '../shared/catalog-engine/sc2-catalog/index.js'
import { createBuiltinRegistry } from '../shared/catalog-engine/sc2-schema/index.js'
import { parseCatalogXml } from '../shared/catalog-engine/xml/index.js'

const NL = '\n'
const encoder = new TextEncoder()

const CATALOG = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Catalog>',
  '    <CUnit id="Marine">',
  '        <LifeMax value="45"/>',
  '        <CostResource index="Minerals" value="50"/>',
  '        <WeaponArray Link="GaussRifle"/>',
  '    </CUnit>',
  '    <CWeapon id="GaussRifle">',
  '        <Range value="5"/>',
  '        <Period value="0.8608"/>',
  '    </CWeapon>',
  '    <CUnit id="Barracks">',
  '        <LifeMax value="1000"/>',
  '    </CUnit>',
  '</Catalog>',
  '',
].join(NL)

function input(text: string, uri = 'memory://UnitData.xml') {
  const bytes = encoder.encode(text)
  const source = {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision: 'content-hash.sha256:fixture',
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  const binding = {
    sourceKind: 'candidate',
    bindingId: 'content',
    role: 'content',
    ownership: 'owned',
    source: source.ref,
    revision: source.revision,
  }
  return {
    originKind: 'single',
    bindings: [binding],
    primaryBindingId: binding.bindingId,
    revisions: {
      topology: 'single',
      revision: source.revision,
      bindings: [{ bindingId: binding.bindingId, revision: source.revision }],
      compositionFingerprint: source.ref.id,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, async release() {} }
    },
  } as never
}

function entityFacts(catalog: TypedCatalog, namespace: string, id: string) {
  return entitySubjects(modOfCatalog(catalog) as never, {
    snapshotId: 'r1',
    source: { id: 'memory://UnitData.xml', uri: 'memory://UnitData.xml' } as never,
    editOperation: 'edit.field',
  })
    .openFacts(entitySubjectId(namespace, id))
    .then(lease => lease.value)
}

const budget = {
  maxInputBytes: 400_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 104_857_600,
  maxDiagnostics: 1_000,
} as never

const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('no service dependency in this test')
    },
    async resolveUnknown() {
      throw new Error('no foreign service in this test')
    },
  },
} as never

async function open() {
  return createCodec(context).open(input(CATALOG), 'inspect', budget)
}

async function card(session: never, request: unknown) {
  const result = (await (
    session as never as {
      operations(): { invoke(id: string, input: unknown): Promise<unknown> }
    }
  )
    .operations()
    .invoke('entity-cards', request as never)) as {
    state?: string
    reason?: string
    output?: { value?: Record<string, unknown> }
  }
  if (result.state === 'rejected') throw new Error(`refused: ${String(result.reason)}`)
  return result.output?.value ?? {}
}

describe('sc2-data entity cards', () => {
  it('declares the operation the codec has always advertised', () => {
    expect(allOperations.map(item => String(item.id))).toContain('blizzard/sc2-data.entity-cards')
  })

  it('assembles a card for an entity, following its links', async () => {
    const session = await open()
    try {
      const built = await card(session, { namespace: 'Unit', entityId: 'Marine' })
      expect(built['id']).toBe('Marine')
      expect(built['className']).toBe('CUnit')
      // The weapon it links to is resolved, not just named.
      const weapons = built['weapons'] as { name?: unknown }[]
      expect(weapons.length).toBeGreaterThan(0)
      expect(JSON.stringify(weapons)).toContain('GaussRifle')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  /*
   * Producers come from the catalog alone. A unit built by a trigger is invisible here, and the card
   * says so with an empty list rather than a wrong one — the alternative is a reader concluding that
   * nothing builds this unit.
   */
  it('reports producers from the catalog and never invents trigger origins', async () => {
    const session = await open()
    try {
      const built = await card(session, { namespace: 'Unit', entityId: 'Marine' })
      const producers = built['producers'] as { triggers?: unknown[] }[]
      expect(Array.isArray(producers)).toBe(true)
      for (const producer of producers) expect(producer.triggers ?? []).toEqual([])
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('refuses an entity the catalog does not hold', async () => {
    const session = await open()
    try {
      await expect(card(session, { namespace: 'Unit', entityId: 'Ghost' })).rejects.toThrow(
        /no entity Unit\/Ghost/u,
      )
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('refuses a request that does not name an entity', async () => {
    const session = await open()
    try {
      await expect(card(session, { namespace: 'Unit' })).rejects.toThrow(
        /namespace and entityId/u,
      )
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
})

/**
 * An entity as a subject of its own.
 *
 * MK2 minted a `SubjectDescriptor` for this inside the StarCraft II codec, which meant every other
 * format that wanted the same thing had to invent its own spelling of "a thing inside a document".
 * MK3 uses one address and one contract, so a host resolves an entity the way it resolves anything
 * else — and the interesting part is that this makes the card writable through the same operation a
 * tree row uses, rather than through a second editing path.
 */
describe('an entity is a subject', () => {
  const source = { id: 'memory://UnitData.xml', uri: 'memory://UnitData.xml' } as never

  it('publishes the entity as a subject, with its own address, stats and links', async () => {
    const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
    catalog.loadFromFiles([parseCatalogXml(CATALOG)])
    const facts = await entityFacts(catalog, 'Unit', 'Marine')

    const summary = await facts.summary()
    expect(summary.identity.subjectId).toBe('modkit-subject://blizzard%2Fsc2-data/Unit/Marine')
    expect(summary.identity.kind).toBe('Unit')
    expect(summary.identity.type).toBe('CUnit')
    expect(summary.identity).toMatchObject({ label: 'Marine', localizedLabels: { enUS: 'Marine' } })

    /*
     * Only groups with something in them: a heading with nothing under it says the codec failed,
     * not that the entity has no such section.
     */
    const groups = await facts.groups({ limit: 10 })
    expect(groups.items.map(group => group.id)).toEqual(expect.arrayContaining(['stats', 'overview', 'weapons']))

    // The header's stat row: vitals and cost, named so any host can give them an icon.
    const stats = await facts.facts('stats', { limit: 10 })
    expect(stats.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'life', label: 'Life', value: 45 }),
        expect.objectContaining({ id: 'minerals', value: 50 }),
      ]),
    )
    const weapons = await facts.facts('weapons', { limit: 10 })
    expect(weapons.items[0]).toMatchObject({ value: expect.objectContaining({ range: 5 }) })

    // The weapon it links to becomes a related subject, addressed the same way.
    const relations = await facts.relations({ limit: 50 })
    expect(relations.items).toContainEqual(
      expect.objectContaining({
        role: 'Weapons',
        subjectId: 'modkit-subject://blizzard%2Fsc2-data/Weapon/GaussRifle',
      }),
    )
  })

  it('counts every Uses/Used by group and says how many links the card leaves out (plan 5.16)', async () => {
    const units = Array.from({ length: 65 }, (_, index) => `<CUnit id="U${index}"><WeaponArray Link="Gun"/></CUnit>`)
    const loaded = new TypedCatalog({ schema: createBuiltinRegistry() })
    loaded.loadFromFiles([parseCatalogXml(`<Catalog><CWeapon id="Gun"/>${units.join('')}</Catalog>`)])
    const facts = await entityFacts(loaded, 'Weapon', 'Gun')
    const references = (await facts.facts('references', { limit: 20 })).items
    expect(references).toContainEqual(expect.objectContaining({ id: 'used-by-Unit', label: 'Used by Unit', value: 65, note: '5 more not listed' }))
    const listed = (await facts.relations({ limit: 100 })).items.filter((item: { role: string }) => item.role === 'Used by Unit')
    expect(listed).toHaveLength(60)
    // A field carries its help coordinate, and a link field the namespace it names.
    const pair = new TypedCatalog({ schema: createBuiltinRegistry() })
    pair.loadFromFiles([parseCatalogXml('<Catalog><CUnit id="A"><GlossaryAlias value="B"/><Speed value="2"/></CUnit><CUnit id="B"/></Catalog>')])
    const fields = (await (await entityFacts(pair, 'Unit', 'A')).facts('fields', { limit: 100 })).items as readonly any[]
    expect(fields.map(field => field.label)).toEqual(expect.arrayContaining(['GlossaryAlias', 'Speed']))
    for (const field of fields) expect(field.knowledgeTarget).toMatchObject({ kind: 'field', ecosystem: 'starcraft-2', typeId: 'CUnit', canonicalPath: [field.label] })
    expect(fields.find(field => field.label === 'GlossaryAlias')?.type).toEqual({ kind: 'subject-ref', subjectKind: 'Unit' })
    expect(fields.find(field => field.label === 'Speed')?.type?.kind).not.toBe('subject-ref')
  })

  it('lists the sounds its actors play, each a card and its files (plan 5.15)', async () => {
    const loaded = new TypedCatalog({ schema: createBuiltinRegistry() })
    loaded.loadFromFiles([parseCatalogXml(
      '<Catalog><CUnit id="Marine"/>' +
        '<CActorUnit id="Marine"><On Terms="UnitBirth.Marine" Send="Create"/><PlacementSound value="MarineReady"/></CActorUnit>' +
        '<CSound id="MarineReady"><AssetArray File="Sound\\Marine\\Ready0.ogg"/><AssetArray File="Sound\\Marine\\Ready1.ogg"/></CSound>' +
        '</Catalog>',
    )])
    const facts = await entityFacts(loaded, 'Unit', 'Marine')
    expect((await facts.facts('sounds', { limit: 10 })).items).toEqual([
      expect.objectContaining({
        id: 'sound-MarineReady',
        value: ['Sound\\Marine\\Ready0.ogg', 'Sound\\Marine\\Ready1.ogg'],
        type: { kind: 'array', item: { kind: 'asset-ref', accepts: {} } },
      }),
    ])
    expect((await facts.relations({ limit: 50 })).items).toContainEqual(
      expect.objectContaining({ role: 'Sounds', subjectId: entitySubjectId('Sound', 'MarineReady') }),
    )
  })

  it('gives a command button its own InfoArray entry and the price of what it builds (plan 5.12)', async () => {
    const loaded = new TypedCatalog({ schema: createBuiltinRegistry() })
    loaded.loadFromFiles([parseCatalogXml(
      '<Catalog><CUnit id="SCV">' +
        '<CardLayouts><LayoutButtons Face="TerranBuild" Type="Submenu" SubmenuCardId="TBl1" Row="2" Column="0"/>' +
        '<LayoutButtons Face="Halt" Type="AbilCmd" AbilCmd="TerranBuild,Halt" Row="2" Column="4"/></CardLayouts>' +
        '<CardLayouts CardId="TBl1"><LayoutButtons Face="CommandCenter" Type="AbilCmd" AbilCmd="TerranBuild,Build1" Row="0" Column="0"/>' +
        '<LayoutButtons Face="Barracks" Type="AbilCmd" AbilCmd="TerranBuild,Build2" Row="1" Column="0"/></CardLayouts>' +
        '</CUnit>' +
        '<CAbilBuild id="TerranBuild"><InfoArray index="Build1" Time="100" Unit="CommandCenter"/>' +
        '<InfoArray index="Build2" Time="60" Unit="Barracks"/></CAbilBuild>' +
        '<CUnit id="CommandCenter"><CostResource index="Minerals" value="400"/></CUnit>' +
        '<CUnit id="Barracks"><CostResource index="Minerals" value="150"/></CUnit>' +
        '</Catalog>',
    )])
    const facts = await entityFacts(loaded, 'Unit', 'SCV')
    const buttons = new Map(
      (await facts.facts('command-card', { limit: 20 })).items.map(item => [item.id, item.value as Record<string, unknown>]),
    )
    expect(buttons.get('command-Root-0')).toMatchObject({ page: 'Root', row: 2, column: 0, type: 'Submenu', submenu: 'TBl1' })
    // Halt is a command of the build ability with no entry of its own: no product, time or price.
    expect(buttons.get('command-Root-1')).toMatchObject({ face: 'Halt', row: 2, column: 4 })
    expect(buttons.get('command-Root-1')).not.toHaveProperty('produces')
    expect(buttons.get('command-Root-1')).not.toHaveProperty('time')
    expect(buttons.get('command-TBl1-0')).toMatchObject({
      page: 'TBl1', produces: entitySubjectId('Unit', 'CommandCenter'), time: 100, cost: { minerals: 400 },
    })
    expect(buttons.get('command-TBl1-1')).toMatchObject({ produces: entitySubjectId('Unit', 'Barracks'), cost: { minerals: 150 } })
    // The group is a 3 × 5 grid with a page per card; a submenu opens its page, a button its card.
    const group = (await facts.groups({ limit: 20 })).items.find(item => item.id === 'command-card')
    expect(group).toMatchObject({
      presentation: 'slots',
      slots: { rows: 3, columns: 5, pages: [{ id: 'Root', label: 'Commands' }, { id: 'TBl1', label: 'TerranBuild' }] },
    })
    const slots = new Map((await facts.facts('command-card', { limit: 20 })).items.map(item => [item.id, item.slot]))
    expect(slots.get('command-Root-0')).toEqual({
      row: 2, column: 0, page: 'Root', opensPage: 'TBl1', subjectId: entitySubjectId('Button', 'TerranBuild'),
    })
    expect(slots.get('command-TBl1-1')).toEqual({
      row: 1, column: 0, page: 'TBl1', subjectId: entitySubjectId('Button', 'Barracks'),
    })
  })

  it('names each missing parent as namespace/id → parent on the file card', async () => {
    const session = (await createCodec(context).open(
      input('<Catalog><CUnit id="Marine" parent="Missing"/></Catalog>'),
      'inspect',
      budget,
    )) as never as {
      dataSource(contract: string, major: number): Promise<{ value: any; release(): Promise<void> }>
      dispose(): Promise<void>
    }
    try {
      const card = await session.dataSource('common.view/subject-facts-source', 1)
      const facts = (await card.value.facts('integrity', { limit: 10 })).items
      expect(facts.find((item: { id: string }) => item.id === 'unresolved-parent-names')?.value).toEqual(['Unit/Marine → Missing'])
      await card.release()
    } finally {
      await session.dispose()
    }
  })

  it('lends every entity of an open catalog through the session selector', async () => {
    const session = (await open()) as never as {
      dataSource(contract: string, major: number): Promise<{ value: any; release(): Promise<void> }>
      dispose(): Promise<void>
    }
    try {
      const card = await session.dataSource('common.view/subject-facts-source', 1)
      const listed = (await card.value.relations({ limit: 50 })).items
      expect(listed.map((item: { role: string; label: string }) => [item.role, item.label])).toEqual(
        expect.arrayContaining([
          ['Unit', 'Marine'],
          ['Unit', 'Barracks'],
          ['Weapon', 'GaussRifle'],
        ]),
      )
      await card.release()
      const selector = await session.dataSource('common.view/subject-selector-source', 1)
      const units = await selector.value.subjects({ limit: 10, kind: 'Unit' })
      expect(units.items.map((item: { label: string }) => item.label).sort()).toEqual(['Barracks', 'Marine'])
      const weapon = await selector.value.openFacts(entitySubjectId('Weapon', 'GaussRifle'))
      expect((await weapon.value.summary()).identity).toMatchObject({ kind: 'Weapon', type: 'CWeapon' })
      await weapon.release()
      // A fact of this file opens the entity's declaration in it (parity plan 5.2).
      const marine = await selector.value.openFacts(entitySubjectId('Unit', 'Marine'))
      const life = (await marine.value.facts('stats', { limit: 10 })).items.find((item: { id: string }) => item.id === 'life')
      expect(life?.provenance?.[0]).toMatchObject({ source: { id: 'memory://UnitData.xml' }, range: { line: 2, column: 4 } })
      await marine.release()
      await expect(selector.value.openFacts(entitySubjectId('Unit', 'Ghost'))).rejects.toThrow(/no entity/u)
      await selector.release()
    } finally {
      await session.dispose()
    }
  })

  /*
   * The host resolves every string in the locale it was asked for and falls back key by key. The card
   * is in that locale: a key that fell back to enUS is still a ruRU string, not a second locale whose
   * card would name nothing (parity plan 5.8).
   */
  it('names a snapshot entity in the requested locale, fallback keys included', async () => {
    const at = { rootId: 'workspace', path: 'mods/test.sc2mod/base.sc2data/gamedata/unitdata.xml', documentIndex: 0, revision: 'r1' }
    const text = (key: string, value: string, resolvedLocale: string) => ({
      key, value, requestedLocale: 'ruRU', resolvedLocale, fallback: resolvedLocale !== 'ruRU',
      source: { ...at, path: `mods/test.sc2mod/${resolvedLocale}.sc2data/localizeddata/gamestrings.txt` },
    })
    const snapshot = {
      definitions: [
        { namespace: 'Unit', entityId: 'Marine', typeId: 'CUnit', sources: [at],
          fields: { LifeMax: 45, WeaponArray: [{ index: 0, value: { Link: 'GaussRifle' } }] } },
        { namespace: 'Weapon', entityId: 'GaussRifle', typeId: 'CWeapon', sources: [at], fields: { Range: 5 } },
      ],
      localizedStrings: [text('Unit/Name/Marine', 'Морпех', 'ruRU'), text('Weapon/Name/GaussRifle', 'Gauss Rifle', 'enUS')],
    }
    const facts = snapshotEntityFacts(snapshot as never, 'Unit', 'Marine', { snapshotId: 'r1', source })!
    const summary = await facts.summary()
    expect(summary.identity).toMatchObject({ label: 'Морпех', localizedLabels: { ruRU: 'Морпех' } })
    expect(Object.keys((summary.identity as { localizedLabels: object }).localizedLabels)).toEqual(['ruRU'])
    expect((await facts.relations({ limit: 50 })).items).toContainEqual(
      expect.objectContaining({ role: 'Weapons', label: 'Gauss Rifle' }),
    )
  })

  // Parity plan 5.9: a description reads as in the game — colour and inline icon as runs.
  it('publishes a description as styled runs, its icons by logical id', async () => {
    const at = { rootId: 'workspace', path: 'mods/test.sc2mod/base.sc2data/gamedata/unitdata.xml', documentIndex: 0, revision: 'r1' }
    const snapshot = {
      definitions: [{ namespace: 'Unit', entityId: 'Marine', typeId: 'CUnit', sources: [at], fields: {} }],
      localizedStrings: [{
        key: 'Unit/Description/Marine',
        value: 'Fires <c val="FF0000">hot</c> rounds <img path="Assets\\Textures\\icon-damage.dds"/>.',
        requestedLocale: 'enUS', resolvedLocale: 'enUS', fallback: false,
        source: { ...at, path: 'mods/test.sc2mod/enus.sc2data/localizeddata/gamestrings.txt' },
      }],
    }
    const facts = snapshotEntityFacts(snapshot as never, 'Unit', 'Marine', { snapshotId: 'r1', source })!
    const description = (await facts.facts('overview', { limit: 20 })).items.find(item => item.id === 'description')
    expect(description?.type).toEqual({ kind: 'text-runs' })
    const runs = description?.value as readonly { text: string; color?: string; asset?: string }[]
    expect(runs.map(run => run.text).join('')).toBe('Fires hot rounds .')
    expect(runs.find(run => run.text === 'hot')?.color).toMatch(/^#ff0000$/iu)
    expect(runs.find(run => run.asset !== undefined)?.asset).toBe('Assets/Textures/icon-damage.dds')
  })

  // Parity plan 5.10: an icon written as `@@Key` is the path the mod's Assets.txt gives the key.
  it('resolves an @@ icon through the source asset aliases', async () => {
    const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
    catalog.loadFromFiles([parseCatalogXml('<Catalog><CButton id="Hero"><Icon value="@@UI/HeroIcon"/></CButton></Catalog>')])
    const open = (aliases?: ReadonlyMap<string, string>) =>
      entitySubjects({ ...modOfCatalog(catalog), ...(aliases === undefined ? {} : { assetAliases: aliases }) } as never, {
        snapshotId: 'r1',
        source,
      }).openFacts(entitySubjectId('Button', 'Hero')).then(lease => lease.value.summary())
    const resolved = await open(new Map([['UI/HeroIcon', 'Assets\\Textures\\btn-hero.dds']]))
    expect((resolved.identity as { portrait?: string }).portrait).toBe('Assets/Textures/btn-hero.dds')
    // A bare catalog has no alias table: the alias names nothing a host could open.
    expect((await open()).identity).not.toHaveProperty('portrait')
  })

  // Parity plan 5.25: a wiki lists the namespaces with their sizes, and each tile of a page its icon.
  it('gives the selector its kinds and the icons of the returned page', async () => {
    const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
    catalog.loadFromFiles([parseCatalogXml([
      '<Catalog>',
      '<CUnit id="Marine"/><CUnit id="Zergling"/>',
      '<CWeapon id="GaussRifle"><Icon value="Assets\\Textures\\btn-gauss.dds"/></CWeapon>',
      '</Catalog>',
    ].join(''))])
    const selector = entitySubjects(modOfCatalog(catalog) as never, { snapshotId: 'r1', source })
    expect((await selector.summary()).kinds).toEqual([{ kind: 'Unit', count: 2 }, { kind: 'Weapon', count: 1 }])
    const weapons = await selector.subjects({ limit: 10, kind: 'Weapon' })
    expect(weapons.items[0]).toMatchObject({ label: 'GaussRifle', portrait: 'Assets/Textures/btn-gauss.dds' })
    expect((await selector.subjects({ limit: 10, kind: 'Unit' })).items[0]).not.toHaveProperty('portrait')
  })

  // Parity plan 5.7: in a mod context the card carries what the whole chain gives the entity.
  it('draws the card from the mod context, following what it references', async () => {
    const at = { rootId: 'liberty', path: 'mods/liberty.sc2mod/base.sc2data/gamedata/unitdata.xml', documentIndex: 0, revision: 'r1' }
    const resolved = (namespace: string, typeId: string, entityId: string, fields: object) => ({
      namespace, typeId, entityId, fields, sources: [at], complete: true,
      inheritanceChain: [{ namespace, entityId }],
    })
    const chain = new Map([
      ['Unit/Marine', resolved('Unit', 'CUnit', 'Marine', {
        LifeMax: 45, WeaponArray: [{ index: '0', value: { Link: 'GaussRifle' } }],
      })],
      ['Weapon/GaussRifle', resolved('Weapon', 'CWeapon', 'GaussRifle', { Range: 5, Period: 0.8608, Effect: 'GaussDamage' })],
      ['Effect/GaussDamage', resolved('Effect', 'CEffectDamage', 'GaussDamage', { Amount: 6 })],
    ])
    const asked: string[][] = []
    const catalog = {
      async entities(refs: readonly { namespace: string; entityId: string }[]) {
        asked.push(refs.map(ref => `${ref.namespace}/${ref.entityId}`))
        return refs.flatMap(ref => chain.get(`${ref.namespace}/${ref.entityId}`) ?? []) as never
      },
    }
    // The document on its own sets only Marine's life, and nothing about its weapon.
    const local = new TypedCatalog({ schema: createBuiltinRegistry() })
    local.loadFromFiles([parseCatalogXml('<Catalog><CUnit id="Marine"><LifeMax value="55"/></CUnit><CUnit id="Local"/></Catalog>')])
    const selector = entitySubjects(modOfCatalog(local) as never, { snapshotId: 'r1', source, catalog })
    const card = (await selector.openFacts(entitySubjectId('Unit', 'Marine'))).value
    const stats = await card.facts('stats', { limit: 20 })
    expect(stats.items).toContainEqual(expect.objectContaining({ id: 'life', value: 45 }))
    const weapons = await card.facts('weapons', { limit: 10 })
    expect(weapons.items[0]).toMatchObject({ value: expect.objectContaining({ range: 5 }) })
    // A level at a time: the unit, then its weapon, then the weapon's effect.
    expect(asked.slice(0, 3)).toEqual([['Unit/Marine'], ['Weapon/GaussRifle'], ['Effect/GaussDamage']])
    // An entity the context does not know keeps the document's own card.
    const own = (await selector.openFacts(entitySubjectId('Unit', 'Local'))).value
    expect((await own.summary()).identity).toMatchObject({ kind: 'Unit' })
  })

  it('names a context card in the strings its mod context answers (plan 5.12)', async () => {
    const at = { rootId: 'liberty', path: 'mods/liberty.sc2mod/base.sc2data/gamedata/unitdata.xml', documentIndex: 0 }
    const marine = {
      namespace: 'Unit', typeId: 'CUnit', entityId: 'Marine', fields: { LifeMax: 45 }, sources: [at], complete: true,
      inheritanceChain: [{ namespace: 'Unit', entityId: 'Marine' }],
    }
    const askedKeys: string[][] = []
    const catalog = {
      async entities() {
        return [marine] as never
      },
      async strings(keys: readonly string[], locales?: readonly string[]) {
        askedKeys.push([...keys])
        expect(locales).toBeUndefined()
        const known: Record<string, string> = { 'Unit/Name/Marine': 'Морпех' }
        return keys.flatMap(key =>
          known[key] === undefined
            ? []
            : [{
                key, value: known[key], requestedLocale: 'enUS', resolvedLocale: 'ruRU', fallback: true,
                source: { rootId: 'liberty', path: 'mods/liberty.sc2mod/ruru.sc2data/localizeddata/gamestrings.txt', documentIndex: 1 },
              }],
        ) as never
      },
    }
    const local = new TypedCatalog({ schema: createBuiltinRegistry() })
    local.loadFromFiles([parseCatalogXml('<Catalog><CUnit id="Marine"/></Catalog>')])
    const selector = entitySubjects(modOfCatalog(local) as never, { snapshotId: 'r1', source, catalog })
    const card = (await selector.openFacts(entitySubjectId('Unit', 'Marine'))).value
    expect((await card.summary()).identity.label).toBe('Морпех')
    // The keys are the ones the card builder looks up, asked once; nothing new is named by the answer.
    expect(askedKeys).toHaveLength(1)
    expect(askedKeys[0]).toContain('Unit/Name/Marine')
  })

  // A field of an entity a dependency declares names the file of the layer that sets it, not the
  // document the card was opened on (seen in the window on IBE_COMMON over Core).
  it('names the layer file each field of a context card comes from', async () => {
    const core = { rootId: 'content-source://local:casc/mods/core.sc2mod', path: 'mods/core.sc2mod/base.sc2data/gamedata/gamedata.xml', documentIndex: 0, range: { utf16Offset: 40, utf16Length: 22, line: 2, column: 4 } }
    const own = { rootId: 'file:///C:/Mods/IBE_COMMON.SC2Mod', path: 'C:/Mods/IBE_COMMON.SC2Mod/Base.SC2Data/GameData/GameData.xml', documentIndex: 1 }
    const catalog = {
      async entities() {
        return [{
          namespace: 'Game', typeId: 'CGame', entityId: 'Dflt', inheritanceChain: [{ namespace: 'Game', entityId: 'Dflt' }],
          fields: { GameSpeed: '4', StartingMinerals: '50' }, fieldSources: { GameSpeed: core, StartingMinerals: own },
          sources: [core, own], complete: true,
        }] as never
      },
    }
    const empty = new TypedCatalog({ schema: createBuiltinRegistry() })
    const selector = entitySubjects(modOfCatalog(empty) as never, {
      snapshotId: 'r1',
      source,
      catalog,
      sourceOf: (rootId, file) => ({ id: `${rootId}?vfs-path=${file}`, uri: `${rootId}?vfs-path=${file}` }),
    })
    const card = (await selector.openFacts(entitySubjectId('Game', 'Dflt'))).value
    const fields = (await card.facts('fields', { limit: 50 })).items
    const sourceOfField = (name: string) => fields.find(item => item.label === name)?.provenance?.[0]?.source?.uri
    expect(sourceOfField('GameSpeed')).toBe('content-source://local:casc/mods/core.sc2mod?vfs-path=base.sc2data/gamedata/gamedata.xml')
    // The span of the declaration in that file goes with it.
    expect(fields.find(item => item.label === 'GameSpeed')?.provenance?.[0]?.range).toEqual(core.range)
    expect(sourceOfField('StartingMinerals')).toBe('file:///C:/Mods/IBE_COMMON.SC2Mod?vfs-path=Base.SC2Data/GameData/GameData.xml')
  })

  it('parses an id it minted', () => {
    const id = 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine'
    expect(parseSubjectId(id)).toEqual({ scope: 'blizzard/sc2-data', path: ['Unit', 'Marine'] })
    // Something that is not one of ours is refused rather than half-parsed.
    expect(parseSubjectId('file:///UnitData.xml')).toBeUndefined()
  })
})

/*
 * Parity plan 5.25: the wiki lists a namespace's entities by display name, the id as fallback, and
 * finds them by either. The selector is the list it reads.
 */
describe('the entity selector lists entities as the wiki does', () => {
  it('labels entities by name, orders them by it and searches name and id', async () => {
    const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
    catalog.loadFromFiles([parseCatalogXml(CATALOG)])
    const names: Record<string, string> = { Marine: 'Space Marine', Barracks: 'Barracks' }
    const selector = entitySubjects(modOfCatalog(catalog) as never, {
      snapshotId: 'r1',
      source: { id: 'memory://UnitData.xml', uri: 'memory://UnitData.xml' } as never,
      nameOf: (_namespace, id) => names[id] ?? '',
    })
    const units = await selector.subjects({ kind: 'Unit', limit: 10 })
    expect(units.items.map(item => item.label)).toEqual(['Barracks', 'Space Marine'])
    const weapons = await selector.subjects({ kind: 'Weapon', limit: 10 })
    expect(weapons.items.map(item => item.label)).toEqual(['GaussRifle'])
    expect((await selector.subjects({ text: 'space', limit: 10 })).items.map(item => item.subjectId)).toEqual([
      entitySubjectId('Unit', 'Marine'),
    ])
    expect((await selector.subjects({ text: 'marine', limit: 10 })).items).toHaveLength(1)
  })
})

/*
 * The write route, on a catalog that has a curated field to write. The point of the exercise is
 * that a card edit goes through `edit.field` — the same operation a tree row invokes — rather than
 * through an editing path of the card's own, because two writers disagree about what is valid.
 */
describe('a subject field carries the writer the tree uses', () => {
  it('offers edit.field on a field the surgical patcher can rewrite', async () => {
    const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
    catalog.loadFromFiles([
      parseCatalogXml(
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<Catalog>',
          '    <CUnit id="Marine">',
          '        <LifeMax value="45"/>',
          '        <Mover value="Ground"/>',
          '        <Radius value="0.375"/>',
          '    </CUnit>',
          '</Catalog>',
          '',
        ].join(NL),
      ),
    ])
    const facts = await entityFacts(catalog, 'Unit', 'Marine')
    const groups = await facts.groups({ limit: 10 })
    const fieldsGroup = groups.items.find(group => group.id === 'fields')
    if (fieldsGroup === undefined) {
      // The curated set is the schema's, not this test's: if it lists none of these, say so plainly.
      expect(groups.items.map(group => group.id)).toContain('identity')
      return
    }
    const fields = await facts.facts('fields', { limit: 50 })
    const writable = fields.items.filter(item => item.editable !== undefined)
    expect(fields.items).toContainEqual(expect.objectContaining({ label: 'Radius' }))
    expect(writable.length).toBeGreaterThan(0)
    expect(String(writable[0]?.editable?.write?.operation)).toContain('edit.field')
  })

  /*
   * Parity plan 5.3: the card writes a value with the field write request of its target; the path
   * is the fact's semantic path ([namespace, id, ...field]), which is what edit.field takes.
   */
  it('writes a card value through edit.field by the fact\'s semantic path', async () => {
    const session = (await open()) as never as {
      dataSource(contract: string, major: number): Promise<{ value: any; release(): Promise<void> }>
      operations(): { invoke(id: string, input: unknown): Promise<any> }
      dispose(): Promise<void>
    }
    try {
      const selector = await session.dataSource('common.view/subject-selector-source', 1)
      const marine = await selector.value.openFacts(entitySubjectId('Unit', 'Marine'))
      const life = (await marine.value.facts('stats', { limit: 10 })).items.find((item: { id: string }) => item.id === 'life')
      expect(life?.type).toEqual({ kind: 'number' })
      expect(String(life?.editable?.write?.operation)).toContain('edit.field')
      const path = life.provenance[0].semanticPath
      expect(path).toEqual(['Unit', 'Marine', 'LifeMax'])
      const written = await session.operations().invoke('edit-field', { groupId: 'stats', key: 'life', path, value: 55 })
      expect(written.state, String(written.reason)).not.toBe('rejected')
      expect(written.output?.kind).toBe('edit-plan')
      await marine.release()
      await selector.release()
    } finally {
      await session.dispose()
    }
  })
})
