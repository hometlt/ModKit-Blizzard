import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveModWorkspaceGraph } from '@modkit/sdk'
import { describe, expect, it } from 'vitest'
import {
  analyzeStarcraft2ResolvedData,
  planStarcraft2DataWorkspace,
  STARCRAFT2_DATA_SCHEMAS,
  STARCRAFT2_DATA_SCHEMA_COVERAGE,
  STARCRAFT2_DATA_SCHEMA_PROVENANCE,
  STARCRAFT2_TYPE_NAMESPACES,
} from '../modules/data/services/catalog/provider.js'
import { resolveStarcraft2SchemaFields } from '../modules/data/services/schema/full-data-schema.js'
import {
  openStarcraft2DataSource,
  openStarcraft2SubjectFactsSource,
} from '../modules/data/services/projections/data-sources.js'

interface ExpectedType {
  readonly namespace: string
  readonly parentTypeId: string
  readonly links?: readonly string[]
  readonly assets?: readonly string[]
}

interface SchemaFieldShape {
  readonly fieldId: string
  readonly valueKind?: string
  readonly linkNamespace?: string
  readonly assetKind?: string
  readonly fields?: readonly SchemaFieldShape[]
}

interface SemanticSchemaField {
  readonly path: string
  readonly valueKind: string
  readonly linkNamespace?: string
  readonly assetKind?: string
}

interface SemanticNamespaceParity {
  readonly typeId: string
  readonly sections: Readonly<Record<string, readonly string[]>>
  readonly schemaFields: readonly SemanticSchemaField[]
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'full-schema-parity.json'), 'utf8'),
) as {
  readonly legacyRepositoryCommit: string
  readonly legacySchemaCommit: string
  readonly digest: string
  readonly coverage: Readonly<Record<string, number>>
  readonly types: Readonly<Record<string, ExpectedType>>
}
const asset = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      'modules',
      'data',
      'services',
      'schema',
      'generated',
      'sc2-data-schema.json',
    ),
    'utf8',
  ),
)
const semanticParityFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'semantic-card-graph-parity.json'), 'utf8'),
) as {
  readonly schemaVersion: number
  readonly verdict: string
  readonly legacy: {
    readonly repositoryCommit: string
    readonly cardsPath: string
    readonly cardsBlob: string
    readonly graphPath: string
    readonly graphBlob: string
  }
  readonly semanticSurfaces: readonly string[]
  readonly namespaces: Readonly<Record<string, SemanticNamespaceParity>>
  readonly graphScenario: {
    readonly root: string
    readonly directions: readonly string[]
    readonly multiHopPaths: readonly (readonly string[])[]
    readonly requiredNamespaces: readonly string[]
    readonly requiresEdgeProvenance: boolean
    readonly requiresDeadTarget: boolean
  }
  readonly namedRemainder: readonly string[]
}

function fieldPaths(
  fields: readonly SchemaFieldShape[],
  property: 'linkNamespace' | 'assetKind',
  path: string[] = [],
) {
  const values: string[] = []
  for (const field of fields) {
    const next = [...path, field.fieldId]
    if (field[property] !== undefined && field[property] !== '') {
      values.push(`${next.join('.')}:${field[property]}`)
    }
    values.push(...fieldPaths(field.fields ?? [], property, next))
  }
  return values.sort()
}

const request = (catalog: string, path = 'Base.SC2Data/GameData/FullSchemaData.xml') => ({
  workspaceId: 'workspace:full-schema',
  gameId: 'blizzard/starcraft-2',
  documents: [
    {
      rootId: 'fixture',
      path,
      text: catalog,
      revision: 'sha256:full-schema-fixture',
    },
  ],
  localizationDocuments: [],
  locales: [],
  localizationKeys: [],
  queries: [],
  maxDocuments: 4,
  maxTextBytes: 1_048_576,
  maxEntities: 2_048,
  maxDepth: 64,
  plannedDocumentCount: 1,
  unresolvedRequirementIds: [],
})

function schemaFieldAtPath(fields: readonly SchemaFieldShape[], path: string) {
  let current = fields
  let found: SchemaFieldShape | undefined
  for (const part of path.split('.')) {
    found = current.find(field => field.fieldId === part)
    if (found === undefined) return undefined
    current = found.fields ?? []
  }
  return found
}

describe('full StarCraft II catalog schema', () => {
  it('plans all 109 catalog files including the official bootstrap when bounded capacity is available', async () => {
    const root = {
      rootId: 'workspace:test.sc2mod',
      sourceId: 'fixture',
      sourcePath: 'mods/test.sc2mod',
      displayName: 'Test.SC2Mod',
      kind: 'mod',
      declaredDependencies: [],
    }
    const workspace = {
      schemaVersion: 1,
      workspaceId: 'workspace:full-plan',
      gameId: 'blizzard/starcraft-2',
      activeRootId: root.rootId,
      sources: [],
      roots: [root],
      loadOrder: [root],
      logicalRoots: [root],
      diagnostics: [],
      complete: true,
    }
    const full = await planStarcraft2DataWorkspace({
      workspace,
      locales: ['enUS'],
      maxRequirements: 256,
    })
    expect(full).toMatchObject({ complete: true })
    // 109 GameData catalogs and the root's EditorCategories.xml.
    expect(full.requirements.filter(item => item.kind === 'catalog')).toHaveLength(110)
    expect(full.requirements.every(item => item.required === false)).toBe(true)
    expect(full.requirements.map(item => item.path)).toEqual(
      expect.arrayContaining([
        'mods/test.sc2mod/base.sc2data/gamedata/sc2data.xml',
        'mods/test.sc2mod/base.sc2data/gamedata/modeldata.xml',
        'mods/test.sc2mod/base.sc2data/gamedata/sounddata.xml',
      ]),
    )
    expect(full.diagnostics).toEqual([])

    const priority = await planStarcraft2DataWorkspace({
      workspace,
      locales: ['enUS'],
      maxRequirements: 64,
    })
    expect(priority).toMatchObject({ complete: true })
    // The 20 render catalogs (units, actors, models, footprints, lighting, terrain, water, cliffs)
    // and EditorCategories.xml.
    expect(priority.requirements.filter(item => item.kind === 'catalog')).toHaveLength(21)
    expect(priority.requirements.map(item => item.path)).toEqual(
      expect.arrayContaining([
        'mods/test.sc2mod/base.sc2data/gamedata/sc2data.xml',
        'mods/test.sc2mod/base.sc2data/gamedata/weapondata.xml',
        'mods/test.sc2mod/base.sc2data/gamedata/modeldata.xml',
        'mods/test.sc2mod/base.sc2data/gamedata/terraintexdata.xml',
        'mods/test.sc2mod/base.sc2data/gamedata/waterdata.xml',
      ]),
    )
    expect(priority.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'blizzard.starcraft2/data-plan-full-catalog-budget-unavailable',
      }),
    )
    // A budget that cannot hold the full list does not ask for listings either.
    expect(priority.listingQueries).toBeUndefined()

    /*
     * The fixed list misses catalogs the game loads: Liberty's GameData.xml declares CollectionSkin,
     * SC2Events and two WarChest seasons, a custom mod may declare a catalog of any name or folder.
     * The plan asks for each root's GameData folder; a second plan over the listing names the standard
     * catalogs the root holds, in their order, then every other `*.xml` there as a candidate and the
     * GameData.xml that decides which candidates the game loads — and nothing the root does not hold.
     */
    expect(full.listingQueries).toEqual([{ rootId: root.rootId, prefix: 'base.sc2data/gamedata' }])
    const listed = await planStarcraft2DataWorkspace({
      workspace,
      locales: ['enUS'],
      maxRequirements: 256,
      listings: [{
        rootId: root.rootId,
        prefix: 'base.sc2data/gamedata',
        paths: [
          'Base.SC2Data/GameData/CollectionSkin.xml',
          'Base.SC2Data/GameData/UnitData.xml',
          'Base.SC2Data/GameData/Heroes/Nested.xml',
          'Base.SC2Data/GameData/Readme.txt',
        ],
        complete: true,
      }],
    } as never)
    expect(listed.requirements.filter(item => item.kind === 'catalog').map(item => item.path)).toEqual([
      'mods/test.sc2mod/base.sc2data/gamedata.xml',
      'mods/test.sc2mod/base.sc2data/gamedata/unitdata.xml',
      'mods/test.sc2mod/base.sc2data/gamedata/collectionskin.xml',
      'mods/test.sc2mod/base.sc2data/gamedata/heroes/nested.xml',
      'mods/test.sc2mod/base.sc2data/editordata/editorcategories.xml',
    ])
    expect(listed.listingQueries).toBeUndefined()
    // A listing the host could not finish leaves the fixed list in place.
    const partial = await planStarcraft2DataWorkspace({
      workspace,
      locales: ['enUS'],
      maxRequirements: 256,
      listings: [{ rootId: root.rootId, prefix: 'base.sc2data/gamedata', paths: [], complete: false }],
    } as never)
    expect(partial.requirements.filter(item => item.kind === 'catalog')).toHaveLength(110)

    // Analysis loads a candidate only when GameData.xml declares it, after the standard catalogs
    // and in declared order; an undeclared one is not a catalog of the game.
    const catalog = (id: string) => `<Catalog><CUnit id="${id}"><LifeMax value="1"/></CUnit></Catalog>`
    const at = (path: string) => `mods/test.sc2mod/base.sc2data/${path}`
    const snapshot = await analyzeStarcraft2ResolvedData({
      workspaceId: 'workspace:includes',
      gameId: 'blizzard/starcraft-2',
      documents: [
        { rootId: root.rootId, path: at('gamedata.xml'), text: '<Includes><Catalog path="GameData\\Heroes\\Nested.xml"/><Catalog path="GameData/CollectionSkin.xml"/></Includes>' },
        { rootId: root.rootId, path: at('gamedata/unitdata.xml'), text: catalog('Standard') },
        { rootId: root.rootId, path: at('gamedata/collectionskin.xml'), text: '<Catalog><CUnit id="Declared"><LifeMax value="2"/></CUnit><CUnit id="Nested"><LifeMax value="3"/></CUnit></Catalog>' },
        { rootId: root.rootId, path: at('gamedata/heroes/nested.xml'), text: '<Catalog><CUnit id="Nested"><LifeMax value="4"/></CUnit></Catalog>' },
        { rootId: root.rootId, path: at('gamedata/undeclared.xml'), text: catalog('Undeclared') },
      ],
      localizationDocuments: [],
      usageDocuments: [],
      locales: [],
      localizationKeys: [],
      queries: [],
      maxDocuments: 8,
      maxTextBytes: 1_048_576,
      maxEntities: 2_048,
      maxDepth: 64,
      plannedDocumentCount: 5,
      unresolvedRequirementIds: [],
    } as never) as { definitions: { namespace: string; entityId: string; fields: Record<string, unknown> }[] }
    const units = snapshot.definitions.filter(item => item.namespace === 'Unit')
    expect(units.map(item => item.entityId).sort()).toEqual(['Declared', 'Nested', 'Standard'])
    // Heroes/Nested.xml is declared first, so CollectionSkin's later Nested wins.
    expect(units.find(item => item.entityId === 'Nested')?.fields['LifeMax']).toBe(3)
  })

  it('keeps the priority render catalog complete for six dependency roots at the product budget', async () => {
    const roots = Array.from({ length: 6 }, (_, index) => ({
      rootId: `root-${index}`,
      sourceId: `source-${index}`,
      sourcePath: `mods/root-${index}.sc2mod`,
      displayName: `Root ${index}`,
      kind: 'mod',
      declaredDependencies: [],
    }))
    const workspace = {
      schemaVersion: 1,
      workspaceId: 'workspace:six-root-plan',
      gameId: 'blizzard/starcraft-2',
      activeRootId: roots.at(-1)?.rootId,
      sources: [],
      roots,
      loadOrder: roots,
      logicalRoots: [...roots].reverse(),
      diagnostics: [],
      complete: true,
    }

    const oldBudget = await planStarcraft2DataWorkspace({
      workspace,
      locales: ['enUS'],
      maxRequirements: 64,
    })
    expect(oldBudget).toMatchObject({ complete: false })
    expect(oldBudget.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'blizzard.starcraft2/data-plan-truncated' }),
    )

    const productBudget = await planStarcraft2DataWorkspace({
      workspace,
      locales: ['enUS'],
      maxRequirements: 512,
    })
    expect(productBudget).toMatchObject({ complete: true })
    expect(productBudget.requirements).toHaveLength(6 * 21 + 6)
    expect(productBudget.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'blizzard.starcraft2/data-plan-truncated' }),
    )
  })

  it('refuses an incomplete workspace lock produced for a dependency cycle', async () => {
    const source = (sourceId: string) => ({
      sourceId,
      kind: 'directory' as const,
      location: `${sourceId}.SC2Mod`,
    })
    const dependency = (targetRootId: string) => ({
      targetRootId,
      ref: targetRootId,
      required: true,
      provenance: 'declared' as const,
    })
    const workspace = resolveModWorkspaceGraph({
      schemaVersion: 1,
      workspaceId: 'workspace:cycle',
      gameId: 'blizzard/starcraft-2',
      activeRootId: 'B',
      sources: [source('source-A'), source('source-B')],
      roots: [
        {
          rootId: 'A',
          sourceId: 'source-A',
          sourcePath: 'A.SC2Mod',
          displayName: 'A',
          kind: 'mod',
          dependencies: [dependency('B')],
        },
        {
          rootId: 'B',
          sourceId: 'source-B',
          sourcePath: 'B.SC2Mod',
          displayName: 'B',
          kind: 'mod',
          dependencies: [dependency('A')],
        },
      ],
      maxRoots: 16,
      maxDepth: 16,
    })

    expect(workspace.complete).toBe(false)
    expect(workspace.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'common.mod/dependency-cycle' }),
    )
    await expect(
      planStarcraft2DataWorkspace({
        workspace,
        locales: ['enUS'],
        maxRequirements: 256,
      }),
    ).rejects.toThrow(/complete ModWorkspaceLock/u)
  })

  // "MK2 without bugs": the fixture pins the corrected schema generated from the in-repo copy
  // (`generate-full-data-schema.ts --in-repo`); provenance keeps the legacy commits it came from.
  it('matches the pinned corrected schema fixture and its deterministic digest', () => {
    const digestInput = {
      schemaVersion: asset.schemaVersion,
      namespaces: asset.namespaces,
      catalogFiles: asset.catalogFiles,
      types: asset.types,
      structures: asset.structures,
      valueTypes: asset.valueTypes,
      coverage: asset.coverage,
    }
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(digestInput)).digest('hex')}`
    expect(STARCRAFT2_DATA_SCHEMA_PROVENANCE).toMatchObject({
      legacyRepositoryCommit: fixture.legacyRepositoryCommit,
      legacySchemaCommit: fixture.legacySchemaCommit,
      correctedIn: 'modules/data/shared/catalog-engine/sc2-schema/structure-types',
      digest: fixture.digest,
    })
    expect(digest).toBe(fixture.digest)
    expect(STARCRAFT2_DATA_SCHEMA_COVERAGE).toEqual(fixture.coverage)
    expect(STARCRAFT2_DATA_SCHEMAS).toHaveLength(fixture.coverage.typeCount)
    expect(new Set(Object.values(STARCRAFT2_TYPE_NAMESPACES)).size).toBe(
      fixture.coverage.namespaceCount,
    )

    for (const [typeId, expected] of Object.entries(fixture.types)) {
      const schema = STARCRAFT2_DATA_SCHEMAS.find(candidate => candidate.typeId === typeId)
      expect(schema).toMatchObject({ typeId, parentTypeId: expected.parentTypeId })
      expect(STARCRAFT2_TYPE_NAMESPACES[typeId]).toBe(expected.namespace)
      const fields = resolveStarcraft2SchemaFields(typeId)
      if (expected.links !== undefined) {
        expect(fieldPaths(fields, 'linkNamespace')).toEqual(expect.arrayContaining(expected.links))
      }
      if (expected.assets !== undefined) {
        expect(fieldPaths(fields, 'assetKind')).toEqual(expect.arrayContaining(expected.assets))
      }
    }
  })

  it('preserves enum, flags, numeric and instruction semantics for language tooling', () => {
    const unitFields = new Map(
      resolveStarcraft2SchemaFields('CUnit').map(field => [field.fieldId, field]),
    )
    expect(unitFields.get('ArmorType')).toMatchObject({
      valueKind: 'enum',
      enumMembers: expect.arrayContaining(['Small', 'Medium', 'Large']),
    })
    expect(unitFields.get('Attributes')).toMatchObject({
      valueKind: 'flags',
      enumMembers: expect.arrayContaining(['Light', 'Armored', 'Mechanical']),
    })
    expect(unitFields.get('LifeMax')).toMatchObject({
      valueKind: 'number',
      numberFloat: true,
    })
    const actorFields = resolveStarcraft2SchemaFields('CActor')
    expect(actorFields.some(field => field.valueKind === 'instructions')).toBe(true)
  })

  it('pins the real schema fields behind the legacy card fixture', () => {
    expect(semanticParityFixture).toMatchObject({ schemaVersion: 1, verdict: 'parity' })
    expect(semanticParityFixture.legacy).toMatchObject({
      repositoryCommit: fixture.legacyRepositoryCommit,
      cardsPath: 'extensions/blizzard/starcraft-2/codecs/sc2-data/src/wiki/cards.ts',
      graphPath: 'extensions/blizzard/starcraft-2/codecs/sc2-data/src/graph-view.ts',
    })
    expect(semanticParityFixture.legacy.cardsBlob).toMatch(/^[a-f0-9]{40}$/u)
    expect(semanticParityFixture.legacy.graphBlob).toMatch(/^[a-f0-9]{40}$/u)
    expect(semanticParityFixture.semanticSurfaces).toEqual(
      expect.arrayContaining([
        'curated-and-complete-fields',
        'command-cards-abilities-behaviors-and-weapons',
        'incoming-and-outgoing-relations',
        'bounded-multi-hop-relations',
        'declaration-and-edge-provenance',
        'unresolved-relation-targets',
      ]),
    )

    for (const [namespace, expected] of Object.entries(semanticParityFixture.namespaces)) {
      expect(STARCRAFT2_TYPE_NAMESPACES[expected.typeId]).toBe(namespace)
      const schemaFields = resolveStarcraft2SchemaFields(expected.typeId)
      for (const expectedField of expected.schemaFields) {
        const actual = schemaFieldAtPath(schemaFields, expectedField.path)
        expect(actual, `${expected.typeId}.${expectedField.path}`).toMatchObject({
          valueKind: expectedField.valueKind,
          ...(expectedField.linkNamespace === undefined
            ? {}
            : { linkNamespace: expectedField.linkNamespace }),
          ...(expectedField.assetKind === undefined ? {} : { assetKind: expectedField.assetKind }),
        })
      }
    }
  })

  it('parses at least one inherited field for every legacy catalog class without a schema skip', async () => {
    const entries = STARCRAFT2_DATA_SCHEMAS.filter(schema => schema.typeId !== 'CBase').map(
      schema => {
        const field = resolveStarcraft2SchemaFields(schema.typeId).find(
          candidate =>
            !['class', 'default', 'id', 'parent', 'token', 'tokens'].includes(candidate.fieldId),
        )
        return field === undefined
          ? `<${schema.typeId} id="${schema.typeId}"/>`
          : `<${schema.typeId} id="${schema.typeId}"><${field.fieldId} value="fixture-${schema.typeId}"/></${schema.typeId}>`
      },
    )
    const snapshot = await analyzeStarcraft2ResolvedData(
      request(`<Catalog>${entries.join('')}</Catalog>`),
    )
    expect(snapshot.definitions).toHaveLength(fixture.coverage.generatedTypeCount)
    expect(snapshot.typeIds).toHaveLength(fixture.coverage.typeCount)
    expect(snapshot.namespaces).toHaveLength(fixture.coverage.namespaceCount)
    expect(snapshot.diagnostics.map(item => item.code)).not.toEqual(
      expect.arrayContaining([
        'common.data/schema-type-unsupported',
        'common.data/schema-field-unsupported',
        'blizzard.starcraft2/data-schema-slice-partial',
      ]),
    )
    for (const definition of snapshot.definitions) {
      const sourceField = resolveStarcraft2SchemaFields(definition.typeId).find(
        candidate =>
          !['class', 'default', 'id', 'parent', 'token', 'tokens'].includes(candidate.fieldId),
      )
      if (sourceField !== undefined) expect(definition.fields).toHaveProperty(sourceField.fieldId)
    }
  })

  it('parses entity attributes as schema fields and preserves their winning root provenance', async () => {
    const base = request('<Catalog/>')
    const snapshot = await analyzeStarcraft2ResolvedData({
      ...base,
      documents: [
        {
          rootId: 'core',
          path: 'mods/core.sc2mod/base.sc2data/gamedata/waterdata.xml',
          text: '<Catalog><CWater id="BaseWater" TextureKey="Assets/Textures/CoreWater.dds" TilingFreq="0.125,0.25,0.5,1"/></Catalog>',
        },
        {
          rootId: 'map',
          path: 'maps/fixture.sc2map/base.sc2data/gamedata/waterdata.xml',
          text: '<Catalog><CWater id="BaseWater"><State index="0" Height="9.25"/></CWater><CWater id="ChildWater" parent="BaseWater"/></Catalog>',
        },
      ],
      plannedDocumentCount: 2,
    })
    const baseWater = snapshot.definitions?.find(entity => entity.entityId === 'BaseWater')
    const childWater = snapshot.definitions?.find(entity => entity.entityId === 'ChildWater')

    expect(baseWater).toMatchObject({
      fields: {
        TextureKey: 'Assets/Textures/CoreWater.dds',
        TilingFreq: '0.125,0.25,0.5,1',
        // Positional list: the slot index is kept so a child's State[0] merges into this slot.
        State: [{ index: '0', value: { Height: 9.25 } }],
      },
      fieldSources: {
        TextureKey: { rootId: 'core', documentIndex: 0 },
        TilingFreq: { rootId: 'core', documentIndex: 0 },
        State: { rootId: 'map', documentIndex: 1 },
      },
    })
    expect(childWater).toMatchObject({
      fields: { TextureKey: 'Assets/Textures/CoreWater.dds' },
      fieldSources: { TextureKey: { rootId: 'core', documentIndex: 0 } },
    })
  })

  it('builds exact typed relations for production, buttons, effects and visual resources', async () => {
    const catalog = `<Catalog>
      <CUnit id="Barracks"><AbilArray><Link value="Training"/></AbilArray></CUnit>
      <CAbilTrain id="Training"><InfoArray index="0"><Unit value="Marine"/><Effect value="Damage"/><Button DefaultButtonFace="TrainMarine"/></InfoArray></CAbilTrain>
      <CAbilBuild id="Build"><BuildMorphAbil value="Training"/></CAbilBuild>
      <CActorAction id="MarineAction"><ContainerModel value="MarineActor"/><ContainerAssets Model="MarineModel" Sound="MarineSound"/></CActorAction>
      <CActorMissile id="MissileActor"><CustomUnitStatusFrame value="GameUI/UIContainer/ConsoleUIContainer"/></CActorMissile>
      <CUnit id="Marine"/><CButton id="TrainMarine"/><CEffectDamage id="Damage"><Amount value="6"/></CEffectDamage>
      <CActorModel id="MarineActor"/><CModel id="MarineModel"><Model value="Assets/Units/Terran/Marine/Marine.m3"/></CModel><CSound id="MarineSound"/>
    </Catalog>`
    const snapshot = await analyzeStarcraft2ResolvedData(request(catalog))
    const edges = snapshot.relations.map(
      edge =>
        `${edge.from.namespace}/${edge.from.entityId}:${edge.role}->${edge.to.namespace}/${edge.to.entityId}`,
    )
    expect(edges).toEqual(
      expect.arrayContaining([
        'Unit/Barracks:AbilArray.0.Link->Abil/Training',
        'Abil/Training:InfoArray.0.Button.DefaultButtonFace->Button/TrainMarine',
        'Abil/Training:InfoArray.0.Unit.0->Unit/Marine',
        'Abil/Training:InfoArray.0.Effect->Effect/Damage',
        'Abil/Build:BuildMorphAbil->Abil/Training',
        'Actor/MarineAction:ContainerModel->Actor/MarineActor',
        'Actor/MarineAction:ContainerAssets.Model->Model/MarineModel',
        'Actor/MarineAction:ContainerAssets.Sound->Sound/MarineSound',
        'Actor/MissileActor:CustomUnitStatusFrame->Layout/GameUI/UIContainer/ConsoleUIContainer',
      ]),
    )
    expect(
      snapshot.definitions.find(item => item.entityId === 'MarineModel')?.fields,
    ).toMatchObject({
      Model: 'Assets/Units/Terran/Marine/Marine.m3',
    })
    const lease = openStarcraft2SubjectFactsSource(snapshot, {
      snapshotId: snapshot.snapshotId,
      subject: { namespace: 'Model', entityId: 'MarineModel' },
      maxPageSize: 16,
      maxEntities: 2_048,
      maxRelations: 4_096,
      maxCalculations: 16,
    })
    try {
      expect((await lease.value.groups({ limit: 16 })).items.map(group => group.id)).toContain(
        'visual-assets',
      )
      expect((await lease.value.facts('visual-assets', { limit: 16 })).items).toEqual([
        expect.objectContaining({
          label: 'Model asset',
          value: {
            reference: 'Assets/Units/Terran/Marine/Marine.m3',
            assetKind: 'File',
            valueType: 'CModelFile',
          },
          knowledgeTarget: expect.objectContaining({
            typeId: 'CModel',
            canonicalPath: ['Model'],
          }),
        }),
      ])
    } finally {
      await lease.release()
    }
  })

  it('proves incoming, outgoing and bounded multi-hop graph parity with Behavior and Upgrade', async () => {
    const catalog = `<Catalog>
      <CUnit id="Factory"><Name value="Unit/Name/Factory"/><LifeMax value="1500"/><Speed value="0"/><CostResource index="Minerals" value="400"/><Food value="0"/><AbilArray><Link value="TrainWorker"/></AbilArray><BehaviorArray><Link value="FactoryAura"/></BehaviorArray><WeaponArray><Link value="FactoryGun"/></WeaponArray></CUnit>
      <CUnit id="Worker"/>
      <CWeapon id="FactoryGun"><Range value="6"/><Period value="1.5"/><Effect value="FactoryDamage"/></CWeapon>
      <CEffectDamage id="FactoryDamage"><Amount value="15"/></CEffectDamage>
      <CAbilTrain id="TrainWorker"><InfoArray index="0"><Unit value="Worker"/><Effect value="TrainImpact"/><Button DefaultButtonFace="TrainWorkerButton"/></InfoArray></CAbilTrain>
      <CEffectDamage id="TrainImpact"><Amount value="0"/></CEffectDamage><CButton id="TrainWorkerButton"/>
      <CBehaviorBuff id="FactoryAura"><Duration value="10"/><PeriodicEffect value="AuraPulse"/><ExpireEffect value="MissingExpire"/><Modification MoveSpeedMultiplier="1.1"/></CBehaviorBuff>
      <CEffectDamage id="AuraPulse"><Amount value="1"/></CEffectDamage>
      <CUpgrade id="FactoryUpgrade"><MaxLevel value="3"/><AffectedUnitArray value="Factory"/><EffectArray><Reference value="Unit,Factory,LifeMax"/><Value value="100"/></EffectArray><BonusResourcePerLevel index="Minerals" value="50"/></CUpgrade>
      <CActorUnit id="FactoryActor"><Model value="FactoryModel"/></CActorUnit><CModel id="FactoryModel"><Model value="Assets/Factory.m3"/></CModel>
    </Catalog>`
    const snapshot = await analyzeStarcraft2ResolvedData(
      request(catalog, 'Base.SC2Data/GameData/MixedGraphData.xml'),
    )
    const graphLease = openStarcraft2DataSource(snapshot, 'relations', 64)
    const openFacts = (namespace: string, entityId: string) =>
      openStarcraft2SubjectFactsSource(snapshot, {
        snapshotId: snapshot.snapshotId,
        subject: { namespace, entityId },
        maxPageSize: 64,
        maxEntities: 2_048,
        maxRelations: 4_096,
        maxCalculations: 16,
      })
    const unitLease = openFacts('Unit', 'Factory')
    const behaviorLease = openFacts('Behavior', 'FactoryAura')
    const upgradeLease = openFacts('Upgrade', 'FactoryUpgrade')
    try {
      const summary = await graphLease.value.summary()
      expect(summary).toMatchObject({
        snapshotId: snapshot.snapshotId,
        completeness: 'partial',
      })
      const nodes = (await graphLease.value.nodes({ limit: 64 })).items
      const edges = (await graphLease.value.edges({ limit: 64 })).items
      expect([...new Set(nodes.map(node => node.type))]).toEqual(
        expect.arrayContaining(semanticParityFixture.graphScenario.requiredNamespaces),
      )
      expect(edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'Upgrade/FactoryUpgrade',
            to: 'Unit/Factory',
            role: 'AffectedUnitArray.0',
          }),
          expect.objectContaining({
            from: 'Unit/Factory',
            to: 'Behavior/FactoryAura',
            role: 'BehaviorArray.0.Link',
          }),
          expect.objectContaining({
            from: 'Behavior/FactoryAura',
            to: 'Effect/MissingExpire',
            role: 'ExpireEffect',
            dead: true,
          }),
        ]),
      )
      if (semanticParityFixture.graphScenario.requiresEdgeProvenance) {
        for (const edge of edges) {
          expect(edge.provenance).toEqual([
            expect.objectContaining({
              label: expect.stringContaining('MixedGraphData.xml@sha256:full-schema-fixture'),
              semanticPath: expect.arrayContaining([edge.role]),
            }),
          ])
        }
      }
      if (semanticParityFixture.graphScenario.requiresDeadTarget) {
        expect(edges.some(edge => edge.dead === true)).toBe(true)
        expect(nodes).toContainEqual(
          expect.objectContaining({
            id: 'Effect/MissingExpire',
            type: 'missing-Effect',
          }),
        )
      }
      for (const path of semanticParityFixture.graphScenario.multiHopPaths) {
        for (let index = 0; index + 1 < path.length; index += 1) {
          expect(edges).toContainEqual(
            expect.objectContaining({ from: path[index], to: path[index + 1] }),
          )
        }
      }

      const unitRelations = (await unitLease.value.relations({ limit: 64 })).items
      expect(unitRelations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'incoming',
            subjectId: 'Upgrade/FactoryUpgrade',
            edgeRole: 'AffectedUnitArray.0',
          }),
          expect.objectContaining({
            direction: 'outgoing',
            subjectId: 'Behavior/FactoryAura',
            edgeRole: 'BehaviorArray.0.Link',
          }),
        ]),
      )
      // The snapshot's edges carry their declaration; the card's own roles name linked entities.
      expect(
        unitRelations
          .filter(relation => relation.direction !== undefined)
          .every(relation => relation.provenance?.length === 1),
      ).toBe(true)

      const behaviorGroups = (await behaviorLease.value.groups({ limit: 64 })).items.map(
        group => group.id,
      )
      expect(behaviorGroups).toEqual(expect.arrayContaining(['overview', 'resolved-fields']))
      expect(await behaviorLease.value.summary()).toMatchObject({
        completeness: { state: 'partial', relations: 'incomplete' },
      })
      expect((await behaviorLease.value.relations({ limit: 64 })).items).toContainEqual(
        expect.objectContaining({
          direction: 'outgoing',
          subjectId: 'Effect/MissingExpire',
          dead: true,
          provenance: [
            expect.objectContaining({ label: expect.stringContaining('MixedGraphData.xml') }),
          ],
        }),
      )

      const upgradeGroups = (await upgradeLease.value.groups({ limit: 64 })).items.map(
        group => group.id,
      )
      expect(upgradeGroups).toEqual(expect.arrayContaining(['overview', 'resolved-fields']))
      expect((await upgradeLease.value.relations({ limit: 64 })).items).toContainEqual(
        expect.objectContaining({
          direction: 'outgoing',
          subjectId: 'Unit/Factory',
          edgeRole: 'AffectedUnitArray.0',
        }),
      )
    } finally {
      await Promise.all([
        graphLease.release(),
        unitLease.release(),
        behaviorLease.release(),
        upgradeLease.release(),
      ])
    }
  })

  it('preserves installed schema additions and anonymous defaults with explicit diagnostics', async () => {
    const snapshot = await analyzeStarcraft2ResolvedData(
      request(`<Catalog>
        <CUnit id="FutureMarine"><FutureField value="42"><Nested value="kept"/></FutureField></CUnit>
        <CUnitFutureExperimental id="FutureUnit"><FutureLink value="FutureMarine"/></CUnitFutureExperimental>
        <CModel default="1"><Model value="Assets/Default.m3"/></CModel>
        <FutureMetadata value="explicitly unsupported"/>
      </Catalog>`),
    )
    expect(
      snapshot.definitions.find(item => item.entityId === 'FutureMarine')?.fields,
    ).toMatchObject({
      FutureField: { value: 42, Nested: 'kept' },
    })
    expect(
      snapshot.definitions.find(item => item.typeId === 'CUnitFutureExperimental'),
    ).toMatchObject({
      namespace: 'Unit',
      fields: { FutureLink: 'FutureMarine' },
    })
    expect(
      snapshot.definitions.find(item => item.entityId.startsWith('@default:CModel:')),
    ).toMatchObject({
      namespace: 'Model',
      fields: { Model: 'Assets/Default.m3' },
    })
    expect(snapshot.diagnostics.map(item => item.code)).toEqual(
      expect.arrayContaining([
        'blizzard.starcraft2/data-schema-type-unverified',
        'blizzard.starcraft2/data-schema-field-unverified',
        'blizzard.starcraft2/data-catalog-element-unsupported',
        'blizzard.starcraft2/data-default-definitions-preserved',
      ]),
    )
  })

  it('resolves anonymous actor class defaults without leaking sibling-class fields', async () => {
    const snapshot = await analyzeStarcraft2ResolvedData(request(`<Catalog>
      <const id="$Idle" value="AnimPlay Stand00 Stand"/>
      <CActorModel default="1"><Model value="##id##"/></CActorModel>
      <CActorDoodad default="1"><On Terms="ActorCreation" Send="$Idle PlayForever"/></CActorDoodad>
      <CActorLight default="1"><Model value="WrongLight"/></CActorLight>
      <CActorDoodad id="Palm"/>
      <CActorDoodad id="Parent"><Model value="Authored"/></CActorDoodad>
      <CActorDoodad id="Child" parent="Parent"/>
    </Catalog>`))
    const palm = snapshot.definitions.find(item => item.entityId === 'Palm')
    expect(palm.fields.Model).toBe('Palm')
    expect(palm.fields.On[0].value.Send).toBe('AnimPlay Stand00 Stand PlayForever')
    expect(snapshot.definitions.find(item => item.entityId === 'Child').fields.Model).toBe('Authored')
  })

  it('enforces nested-schema bounds and observes cancellation before parsing', async () => {
    const deeplyNested = request(
      '<Catalog><CUnit id="Deep"><Future><A><B><C value="too-deep"/></B></A></Future></CUnit></Catalog>',
    )
    // One document past the bound is reported, not fatal: the rest of the workspace still resolves.
    const bounded = await analyzeStarcraft2ResolvedData({ ...deeplyNested, maxDepth: 2 })
    expect(bounded.complete).toBe(false)
    expect(bounded.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'blizzard.starcraft2/data-document-invalid',
        message: expect.stringContaining('depth 2'),
      }),
    )

    const controller = new AbortController()
    controller.abort(new Error('full SC2 data analysis cancelled'))
    await expect(
      analyzeStarcraft2ResolvedData({ ...request('<Catalog/>'), signal: controller.signal }),
    ).rejects.toThrow('full SC2 data analysis cancelled')
  })
})
