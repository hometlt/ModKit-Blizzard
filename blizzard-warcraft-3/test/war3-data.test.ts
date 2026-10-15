import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Lease, TableDataSource } from '@modkit/sdk'
import type { DataCatalogDocument, ResolvedDataWorkspace } from '@modkit/sdk/data'
import War3MapW3d from '../src/lib/mdx-m3-viewer/parsers/w3x/w3d/file.js'
import War3MapW3u from '../src/lib/mdx-m3-viewer/parsers/w3x/w3u/file.js'
import { changedObject, objectChange } from './war3-fixtures.js'
import { extension } from './war3-harness.js'
import { war3DataPatches } from '../dist/war3-data/tables.js'
import { TRUSTED_IN_PROCESS_EXECUTION_BACKEND, buildInventory, createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry, createHostContributionContractRegistry, createHostServiceResolver,
  registerServiceDefinitionsOrThrow, serviceDefinitionSurfaces } from '@modkit/host'
import { createNodeWorkerBackend, loadExtensionDirectory } from '@modkit/host/node'

/**
 * Unit data written for the test the way Warcraft III keeps it: two sheets keyed by unit id in
 * their first column, a profile with comments, a stray line and a key the metadata spells, and a
 * map that imports its own UnitBalance.slk over the game's.
 */
const { createProvider } = (await import(pathToFileURL(join(extension, 'providers', 'war3-data', 'runtime.js')).href)) as {
  createProvider(selection: { contract: string }): Lease<ResolvedDataWorkspace>
}

const sheet = (rows: string[][]) =>
  [
    'ID;PWXL;N;E',
    ...rows.flatMap((row, y) => row.map((value, x) => `C;X${String(x + 1)}${x === 0 ? `;Y${String(y + 1)}` : ''};K${/^-?\d+(\.\d+)?$/u.test(value) ? value : `"${value}"`}`)),
    'E',
    '',
  ].join('\r\n')

const game = (path: string, text: string): DataCatalogDocument => ({ rootId: 'game', path, text })
const DOCUMENTS: DataCatalogDocument[] = [
  game(
    'Units/UnitMetaData.slk',
    sheet([
      ['ID', 'field', 'slk', 'index', 'type'],
      ['ubpx', 'Buttonpos', 'Profile', '0', 'int'],
      ['unam', 'Name', 'Profile', '-1', 'string'],
      ['uabi', 'abilList', 'UnitAbilities', '-1', 'abilityList'],
    ]),
  ),
  game('Units/UnitData.slk', sheet([['unitID', 'race', 'movetp'], ['hfoo', 'human', 'foot'], ['hpea', 'human', 'foot']])),
  game('Units/UnitBalance.slk', sheet([['unitBalanceID', 'HP', 'goldcost'], ['hfoo', '420', '135'], ['hpea', '220', '75']])),
  // The footman's abilities: one the tables define, one they do not.
  game('Units/UnitAbilities.slk', sheet([['unitAbilID', 'abilList'], ['hfoo', 'AHbz,Adef']])),
  game('Units/HumanUnitFunc.txt', '[hfoo]\r\n// Footman\r\nbuttonpos=0,0\r\nPurchase Medusa Pebble\r\n'),
  game('Units/HumanUnitStrings.txt', '[hfoo]\r\nName=Footman\r\nTip="Train; then fight"\r\n'),
  game('Units/AbilityData.slk', sheet([['alias', 'code', 'levels'], ['AHbz', 'AHbz', '3']])),
  game('Units/AbilityBuffData.slk', sheet([['alias', 'code'], ['BHbd', 'BHbd']])),
  // Abilities and buffs share profiles but not their semantic namespace.
  game('Units/HumanAbilityStrings.txt', '[AHbz]\r\nName=Blizzard\r\n\r\n[BHbd]\r\nBufftip=Blizzard\r\n'),
  { rootId: 'map', path: 'Units\\UnitBalance.slk', text: sheet([['unitBalanceID', 'HP'], ['hfoo', '999']]) },
]

async function analyzed(documents: readonly DataCatalogDocument[] = DOCUMENTS, maxTextBytes = 1_000_000) {
  const workspace = createProvider({ contract: 'common.data/resolved-workspace' }).value
  const snapshot = await workspace.analyze({
    workspaceId: 'test',
    gameId: 'blizzard/warcraft-3',
    documents,
    queries: [{ namespace: 'unit', entityId: 'hfoo' }],
    maxDocuments: 64,
    maxTextBytes,
    maxEntities: 1000,
    maxDepth: 16,
    plannedDocumentCount: documents.length,
    unresolvedRequirementIds: [],
  })
  return { workspace, snapshot }
}

/**
 * The map's object-editor changes, as the World Editor saves them: the footman's button moved, a
 * custom militia made from the peasant with Blizzard, Blizzard's level-2 damage, and a change
 * whose id no metadata names.
 */
function mapChanges(): DataCatalogDocument[] {
  const units = new War3MapW3u()
  units.version = 2
  units.originalTable.objects.push(changedObject('hfoo', '\0\0\0\0', [objectChange('ubpx', 0, 2)]))
  units.customTable.objects.push(changedObject('hpea', 'h000', [objectChange('unam', 3, 'Militia'), objectChange('uabi', 3, 'AHbz')]))
  const abilities = new War3MapW3d()
  abilities.version = 2
  abilities.originalTable.objects.push(changedObject('AHbz', '\0\0\0\0', [objectChange('Hbz2', 2, 1.5, 2, 2), objectChange('xxxx', 0, 1)]))
  return [
    game('Units/AbilityMetaData.slk', sheet([['ID', 'field', 'slk', 'index', 'repeat', 'data'], ['Hbz2', 'Data', 'AbilityData', '-1', '4', '2']])),
    ...DOCUMENTS,
    { rootId: 'map', path: 'war3map.w3u', text: '', bytes: units.save() },
    { rootId: 'map', path: 'war3map.w3a', text: '', bytes: abilities.save() },
  ]
}

/** Snapshot-local numeric declarations never convert raw values or authorize a write. */
describe('WC3 snapshot-local numeric metadata', () => {
  /** A supplied projection, not evidence that every native game/map document was loaded. */
  const numericDocuments = (type = 'int', values = ['00420']): DataCatalogDocument[] => [
    game('Units/UnitMetaData.slk', sheet([
      ['ID', 'field', 'slk', 'index', 'repeat', 'data', 'type', 'minVal', 'maxVal'],
      ['uhpm', 'HP', 'UnitBalance', '-1', '0', '0', type, '1', '10'],
    ])),
    game('Units/UnitBalance.slk', sheet([
      ['unitID', 'HP'], ...values.map((value, index) => [index === 0 ? 'hfoo' : 'hpea', value]),
    ])),
  ]
  /** Read one field declaration without depending on schema sorting or unrelated namespaces. */
  const numericType = (snapshot: Awaited<ReturnType<typeof analyzed>>['snapshot']) =>
    snapshot.schemas?.find(schema => schema.typeId === 'unit')?.fields.find(field => field.fieldId === 'UnitBalance.HP')?.type

  it.each(['real', 'unreal'].flatMap(native => ['1e-1000', '-1e-1000'].map(raw => ({ native, raw }))))
  ('review V2 refuses $native nonzero coefficient $raw after Number itself underflows, in both row orders', async ({ native, raw }) => {
    for (const values of [['1.5', raw], [raw, '1.5']])
      expect(numericType((await analyzed(numericDocuments(native, values))).snapshot)).toBeUndefined()
  })

  it.each(['real', 'unreal'].flatMap(native => ['0e-1000', '-0.0e-1000'].map(raw => ({ native, raw }))))
  ('review V2 preserves lexical $native zero $raw rather than rejecting its exponent', async ({ native, raw }) => {
    const { snapshot } = await analyzed(numericDocuments(native, [raw]))
    expect(numericType(snapshot)).toEqual({ kind: 'number' })
    expect(snapshot.definitions[0]?.fields['UnitBalance.HP']).toBe(raw)
  })

  it('review V2 counts the actually parsed text even when optional bytes is empty', async () => {
    const documents = numericDocuments('real', ['1.5']).map(document => ({ ...document, bytes: new Uint8Array() }))
    const { snapshot } = await analyzed(documents, 1)
    expect(numericType(snapshot)).toBeUndefined()
    expect(snapshot.definitions[0]?.fields['UnitBalance.HP']).toBe('1.5')
  })

  it('review V2 still admits bounded parsed text with empty optional bytes', async () => {
    const documents = numericDocuments('real', ['1.5']).map(document => ({ ...document, bytes: new Uint8Array() }))
    expect(numericType((await analyzed(documents, 100_000)).snapshot)).toEqual({ kind: 'number' })
  })

  it('review V2 also counts supplied binary bytes larger than the parsed text', async () => {
    const documents = numericDocuments('real', ['1.5']).map(document => ({ ...document, bytes: new Uint8Array(100_001) }))
    expect(numericType((await analyzed(documents, 100_000)).snapshot)).toBeUndefined()
  })

  it.each(['trusted-node', 'portable'] as const)('keeps snapshot-local raw strings readonly through actual Host %s', async variant => {
    const inventory = await buildInventory([{ ...(await loadExtensionDirectory(extension)),
      execution: { origin: 'bundled', allowTrustedInProcess: variant === 'trusted-node' },
    }], createHostContributionContractRegistry())
    const definitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, definitions)
    const resolver = createHostServiceResolver({ inventory, definitions,
      target: { environment: variant === 'trusted-node' ? 'node' : 'node-worker', operatingSystem: 'windows', architecture: 'x64' },
      executionBackends: createExecutionBackendRegistry([variant === 'trusted-node' ? TRUSTED_IN_PROCESS_EXECUTION_BACKEND :
        createNodeWorkerBackend({ foreignSurfaces: () => serviceDefinitionSurfaces(definitions) })]),
      grant: { id: 'wc3-readonly-numeric', classes: [] },
      budgets: { maxInputBytes: 4_000_000n, maxScalarBytes: 4_000_000, maxDepth: 64, maxNodes: 100_000, maxDiagnostics: 100 },
    })
    try {
      const lease = await resolver.port.resolve({ contract: 'common.data/resolved-workspace', major: 1, facet: { gameId: 'blizzard/warcraft-3' } })
      try {
        const documents = numericDocuments()
        const snapshot = await lease.value.analyze({ workspaceId: 'host-numeric', gameId: 'blizzard/warcraft-3', documents,
          queries: [], maxDocuments: 16, maxTextBytes: 1_000_000, maxEntities: 100, maxDepth: 16,
          plannedDocumentCount: documents.length, unresolvedRequirementIds: [] })
        expect(numericType(snapshot)).toEqual({ kind: 'number', integer: true })
        expect(snapshot.definitions[0]?.fields['UnitBalance.HP']).toBe('00420')
        expect(lease.value.planEdit).toBeUndefined()
        const table = await lease.value.openDefinitionTable({ snapshotId: snapshot.snapshotId, maxPageSize: 8 })
        try {
          const shape = await table.value.shape()
          const rows = await table.value.rows({ kind: 'range', from: 0, count: 8 })
          expect(rows.items[0]?.cells[shape.header!.indexOf('UnitBalance.HP')]).toBe('00420')
        } finally { await table.release() }
        expect(resolver.activationFacts).toContainEqual(expect.objectContaining({ providerId: 'blizzard/war3-resolved-data',
          runtimeVariant: variant, executionProfile: variant === 'trusted-node' ? 'trusted-in-process' : 'worker-brokered' }))
      } finally { await lease.release() }
    } finally { await resolver.release() }
  })

  it.each([
    { native: 'int', raw: '00420', type: { kind: 'number', integer: true } },
    { native: 'real', raw: '-1.25e2', type: { kind: 'number' } },
    { native: 'unreal', raw: '0.25', type: { kind: 'number' } },
  ])('annotates supplied $native values without conversion, invented bounds or write methods', async ({ native, raw, type }) => {
    const documents = numericDocuments(native, [raw])
    const before = JSON.stringify(documents)
    const { snapshot, workspace } = await analyzed(documents)
    expect(numericType(snapshot)).toEqual(type)
    expect(snapshot.definitions[0]?.fields['UnitBalance.HP']).toBe(raw)
    expect(JSON.stringify(documents)).toBe(before)
    expect(snapshot.projectionReceipt.confidence).toBe('partial')
    expect('planEdit' in workspace).toBe(false)
    expect('prepareEdit' in workspace).toBe(false)
    const lease = await workspace.openDefinitionTable({ snapshotId: snapshot.snapshotId, maxPageSize: 8 })
    try {
      const shape = await lease.value.shape()
      const rows = await lease.value.rows({ kind: 'range', from: 0, count: 8 })
      expect(rows.items[0]?.cells[shape.header!.indexOf('UnitBalance.HP')]).toBe(raw)
      expect('write' in lease.value).toBe(false)
      expect('editable' in lease.value).toBe(false)
    } finally { await lease.release() }
  })

  it.each(['', '_', '-', ' - ', 'NaN', 'Infinity', '1,2', '1x', '0x10', '1.5', '2147483648', '-2147483649'])
  ('keeps int domain containing %j untyped in either supplied row order', async invalid => {
    for (const values of [['00420', invalid], [invalid, '00420']]) {
      const { snapshot } = await analyzed(numericDocuments('int', values))
      expect(numericType(snapshot)).toBeUndefined()
      expect(snapshot.definitions.map(entity => entity.fields['UnitBalance.HP'])).toEqual(values)
    }
  })

  it.each(['1e40', '-1e40', '1e-100', 'NaN', 'Infinity', '1,2', ' - ', ''])
  ('keeps a real domain containing %j untyped', async invalid => {
    const { snapshot } = await analyzed(numericDocuments('real', ['1.5', invalid]))
    expect(numericType(snapshot)).toBeUndefined()
  })

  it.each(['useSpecific', 'notSpecific', 'index', 'repeat', 'data', 'type'])
  ('never promotes conflicting/conditional/addressed metadata %s in either row order', async field => {
    for (const reversed of [false, true]) {
      const columns = ['ID', 'field', 'slk', 'index', 'repeat', 'data', 'type', 'useSpecific', 'notSpecific']
      const good = ['uhpm', 'HP', 'UnitBalance', '-1', '0', '0', 'int', '', '']
      const bad = [...good]
      bad[columns.indexOf(field)] = field === 'type' ? 'real' : field === 'index' ? '0' : field.endsWith('Specific') ? 'AHbz' : '1'
      const documents = numericDocuments()
      documents[0] = game('Units/UnitMetaData.slk', sheet([columns, ...(reversed ? [bad, good] : [good, bad])]))
      expect(numericType((await analyzed(documents)).snapshot)).toBeUndefined()
    }
  })

  it('does not resurrect a numeric annotation after an invalid supplied override', async () => {
    const documents = numericDocuments()
    documents[0] = game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['uhpm', 'HP', 'Profile', 'int']]))
    documents[1] = game('Units/HumanUnitFunc.txt', '[hfoo]\nHP=00420\n')
    documents.push(game('Units/OrcUnitFunc.txt', '[hfoo]\nHP= - \n'), game('Units/NeutralUnitFunc.txt', '[hfoo]\nHP=500\n'))
    const { snapshot } = await analyzed(documents)
    expect(snapshot.schemas?.find(schema => schema.typeId === 'unit')?.fields.find(field => field.fieldId === 'Profile.HP')?.type).toBeUndefined()
    expect(snapshot.definitions[0]?.fields['Profile.HP']).toBe('500')
  })

  it('refuses typing when a supplied document is unreadable', async () => {
    const documents = [...numericDocuments(), game('Units/UnitData.slk', 'not SYLK')]
    expect(numericType((await analyzed(documents)).snapshot)).toBeUndefined()
  })

  it('retains sparse entities without inventing numeric defaults', async () => {
    const documents = numericDocuments()
    documents.push(game('Units/HumanUnitStrings.txt', '[hfoo]\nName=Footman\n[hpea]\nName=Peasant\n'))
    const { snapshot } = await analyzed(documents)
    expect(numericType(snapshot)).toEqual({ kind: 'number', integer: true })
    expect(snapshot.definitions.find(entity => entity.entityId === 'hpea')?.fields['UnitBalance.HP']).toBeUndefined()
  })

  it.each(['bad', '', '1.5', '9007199254740992'])('does not use malformed native addressing %j as evidence of a scalar', async raw => {
    const documents = numericDocuments()
    documents[0] = game('Units/UnitMetaData.slk', sheet([
      ['ID', 'field', 'slk', 'index', 'type'], ['uhpm', 'HP', 'UnitBalance', raw, 'int'],
    ]))
    expect(numericType((await analyzed(documents)).snapshot)).toBeUndefined()
  })

  it('does not certify a metadata document with duplicate cells', async () => {
    const documents = numericDocuments()
    documents[0] = { ...documents[0]!, text: documents[0]!.text.replace('E\r\n', 'C;X7;Y2;K"int"\r\nE\r\n') }
    expect(numericType((await analyzed(documents)).snapshot)).toBeUndefined()
  })

  it('does not type a byte-budget overflow that a direct caller bypassed the Host with', async () => {
    const { snapshot } = await analyzed(numericDocuments(), 1)
    expect(numericType(snapshot)).toBeUndefined()
    expect(snapshot.definitions[0]?.fields['UnitBalance.HP']).toBe('00420')
  })

  it('does not treat an uncertified direct tables call as a complete provided domain', () => {
    expect(war3DataPatches(numericDocuments()).schemas.find(schema => schema.typeId === 'unit')?.fields[0]?.type).toBeUndefined()
  })

  it('refuses numeric typing for actual input-budget overflow, without claiming native completeness from counts', async () => {
    const workspace = createProvider({ contract: 'common.data/resolved-workspace' }).value
    const documents = numericDocuments()
    const snapshot = await workspace.analyze({ workspaceId: 'partial', gameId: 'blizzard/warcraft-3', documents,
      queries: [], maxDocuments: 1, maxTextBytes: 1_000_000, maxEntities: 100, maxDepth: 16,
      plannedDocumentCount: documents.length, unresolvedRequirementIds: [] })
    expect(numericType(snapshot)).toBeUndefined()
  })
})

describe('Warcraft III resolved data', () => {
  it('retains empty legacy analysis with a zero text allowance when no enum is expanded', async () => {
    const { snapshot } = await analyzed([], 0)
    expect(snapshot.definitions).toEqual([])
  })
  it('bounds expanded enum schema bytes before the common resolver clones shared members', async () => {
    const members = Array.from({ length: 100 }, (_, index) => `native-race-${index}-${'x'.repeat(40)}`)
    const fields = Array.from({ length: 20 }, (_, index) => `race${index}`)
    const documents = [
      game('UI/UnitEditorData.txt', `[unitRace]\nNumValues=100\n${members.map((id, index) => `${String(index).padStart(2, '0')}=${id},Label`).join('\n')}\n`),
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ...fields.map((field, index) => [`r${String(index).padStart(3, '0')}`, field, 'UnitData', 'unitRace'])])),
      game('Units/UnitData.slk', sheet([['unitID', ...fields], ['hfoo', ...fields.map(() => members[0]!)]])),
    ]
    expect(documents.reduce((total, document) => total + new TextEncoder().encode(document.text).length, 0)).toBeLessThan(20_000)
    await expect(analyzed(documents, 20_000)).rejects.toThrow('JSON snapshot exceeds maxBytes')
  })
  it('publishes native scalar enum IDs without changing strings or inventing localized labels', async () => {
    const { snapshot } = await analyzed([
      game('UI/UnitEditorData.txt', '[unitRace]\nSort=1\nNumValues=2\n00=human,WESTRING_HUMAN\n01=orc,WESTRING_ORC,1\n'),
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'index', 'type'], ['urac', 'race', 'UnitData', '-1', 'unitRace']])),
      game('Units/UnitData.slk', sheet([['unitID', 'race'], ['hfoo', 'human'], ['hpea', 'orc']])),
    ])
    expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields.find(item => item.fieldId === 'UnitData.race')?.type)
      .toEqual({ kind: 'enum', members: [{ id: 'human' }, { id: 'orc' }] })
    expect(snapshot.entities.find(item => item.entityId === 'hfoo')?.fields['UnitData.race']).toBe('human')
  })

  it('replaces the whole editor enum document with the strongest root, including prefixed UI paths', async () => {
    const { snapshot } = await analyzed([
      game('UI/UnitEditorData.txt', '[unitRace]\nNumValues=1\n00=human,Human\n'),
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['urac', 'race', 'UnitData', 'unitRace']])),
      game('Units/UnitData.slk', sheet([['unitID', 'race'], ['hfoo', 'naga']])),
      { rootId: 'map', path: 'context-layers/1/UI/UnitEditorData.txt', text: '[unitRace]\nNumValues=1\n00=naga,Naga,1\n' },
    ])
    expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields[0]?.type)
      .toEqual({ kind: 'enum', members: [{ id: 'naga' }] })
  })

  it('keeps enum types separate for two object kinds sharing a profile field name', async () => {
    const { snapshot } = await analyzed([
      game('UI/UnitEditorData.txt', '[unitRace]\nNumValues=1\n00=human,Human\n[moveType]\nNumValues=1\n00=foot,Foot\n'),
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['urac', 'Race', 'Profile', 'unitRace']])),
      game('Units/AbilityMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['arac', 'Race', 'Profile', 'moveType']])),
      game('Units/HumanUnitFunc.txt', '[hfoo]\nRace=human\n'),
      game('Units/HumanAbilityFunc.txt', '[AHbz]\nRace=foot\n'),
    ])
    expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields[0]?.type)
      .toEqual({ kind: 'enum', members: [{ id: 'human' }] })
    expect(snapshot.schemas?.find(item => item.typeId === 'ability')?.fields[0]?.type)
      .toEqual({ kind: 'enum', members: [{ id: 'foot' }] })
  })

  it('does not infer scalar semantics for an unqualified editor domain from its current values', async () => {
    const { snapshot } = await analyzed([
      game('UI/UnitEditorData.txt', '[unitClass]\nNumValues=2\n00=peon,Worker\n01=mechanical,Mechanical\n'),
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['utyp', 'type', 'UnitBalance', 'unitClass']])),
      game('Units/UnitBalance.slk', sheet([['unitID', 'type'], ['hfoo', 'peon']])),
    ])
    expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields[0]?.type).toBeUndefined()
    expect(snapshot.entities[0]?.fields['UnitBalance.type']).toBe('peon')
  })

  it.each([
    '[unitRace]\nNumValues=2\n00=human,Human\n',
    '[unitRace]\nNumValues=4294967295\n00=human,Human\n',
    '[unitRace]\nNumValues=2\n00=human,Human\n01=human,Duplicate\n',
    '[unitRace]\nNumValues=1\nNumValues=1\n00=human,Human\n',
    '[unitRace]\nNumValues=1\n00=orc,Orc\n00=human,Human\n',
    '[unitRace]\nNumValues=1\n00=human,Human\n[unitRace]\nSort=1\n',
  ])('does not resurrect older enum members when an override is unqualified', async text => {
    const { snapshot } = await analyzed([
      game('UI/UnitEditorData.txt', '[unitRace]\nNumValues=1\n00=human,Human\n'),
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['urac', 'race', 'UnitData', 'unitRace']])),
      game('Units/UnitData.slk', sheet([['unitID', 'race'], ['hfoo', 'human']])),
      { rootId: 'map', path: 'UI/UnitEditorData.txt', text },
    ])
    expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields[0]?.type).toBeUndefined()
    expect(snapshot.entities[0]?.fields['UnitData.race']).toBe('human')
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'blizzard.warcraft3/data-enum-unqualified', source: expect.objectContaining({ rootId: 'map' }) }))
  })

  it.each(['human,orc', 'customRace'])('retains an unqualified scalar/list value %s without falsely typing it as an enum', async value => {
    const { snapshot } = await analyzed([
      game('UI/UnitEditorData.txt', '[unitRace]\nNumValues=2\n00=human,Human\n01=orc,Orc\n'),
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['urac', 'race', 'UnitData', 'unitRace']])),
      game('Units/UnitData.slk', sheet([['unitID', 'race'], ['hfoo', value]])),
    ])
    expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields[0]?.type).toBeUndefined()
    expect(snapshot.entities[0]?.fields['UnitData.race']).toBe(value)
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'blizzard.warcraft3/data-enum-value-unqualified', fieldId: 'UnitData.race' }))
  })

  it.each(['', '_', '-'])('keeps the native unset value %j through the existing enum unknown marker', async value => {
    const { snapshot } = await analyzed([
      game('UI/UnitEditorData.txt', '[moveType]\nNumValues=1\n00=foot,Foot\n'),
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['umvt', 'movetp', 'UnitData', 'moveType']])),
      game('Units/UnitData.slk', sheet([['unitID', 'movetp'], ['hfoo', value]])),
    ])
    expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields[0]?.type)
      .toEqual({ kind: 'enum', members: [{ id: 'foot' }], unknown: 'Native unset value' })
    expect(snapshot.entities[0]?.fields['UnitData.movetp']).toBe(value)
  })

  it.each([
    ['0', '0', '', 'unitRace'], ['-1', '1', '', 'unitRace'],
    ['-1', '0', 'hfoo', 'unitRace'], ['-1', '0', '', 'int'],
  ])('does not turn indexed, repeated, conditional or conflicting rows into a universal enum', async (index, repeat, useSpecific, type) => {
    const rows = [
      ['urac', 'race', 'UnitData', '-1', '0', '', 'unitRace'],
      ['uoth', 'race', 'UnitData', index, repeat, useSpecific, type],
    ]
    for (const ordered of [rows, [...rows].reverse()]) {
      const { snapshot } = await analyzed([
        game('UI/UnitEditorData.txt', '[unitRace]\nNumValues=1\n00=human,Human\n'),
        game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'index', 'repeat', 'useSpecific', 'type'], ...ordered])),
        game('Units/UnitData.slk', sheet([['unitID', 'race'], ['hfoo', 'human']])),
      ])
      expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields[0]?.type).toBeUndefined()
    }
  })

  it.each([
    ['bogus', '0', '0'], ['-1', 'bogus', '0'], ['-1', '0', 'bogus'],
    ['-0.5', '0', '0'], ['-1', '0.5', '0'], ['-1', '0', '0.5'],
    ['-9007199254740992', '0', '0'], ['-2', '0', '0'],
    ['-1', '', '0'], ['-1', '0', ''], ['-1', '0x0', '0'],
  ])('does not infer scalar enum from malformed addressing metadata (%s,%s,%s)', async (index, repeat, data) => {
    const rows = [
      ['urac', 'race', 'UnitData', '-1', '0', '0', 'unitRace'],
      ['uoth', 'race', 'UnitData', index, repeat, data, 'unitRace'],
    ]
    for (const ordered of [rows, [...rows].reverse()]) {
      const { snapshot } = await analyzed([
        game('UI/UnitEditorData.txt', '[unitRace]\nNumValues=1\n00=human,Human\n'),
        game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'index', 'repeat', 'data', 'type'], ...ordered])),
        game('Units/UnitData.slk', sheet([['unitID', 'race'], ['hfoo', 'human']])),
      ])
      expect(snapshot.schemas?.find(item => item.typeId === 'unit')?.fields[0]?.type).toBeUndefined()
      expect(snapshot.entities[0]?.fields['UnitData.race']).toBe('human')
    }
  })

  it.each(['useSpecific', 'notSpecific'])('does not turn %s restrictions into universal types or links in either row order', async condition => {
    const rows = [
      ['arac', 'race', 'AbilityData', 'unitRace', ''], ['atgt', 'Target', 'AbilityData', 'unitList', ''],
      ['brac', 'race', 'AbilityData', 'unitRace', 'Adef'], ['btgt', 'Target', 'AbilityData', 'unitList', 'Adef'],
    ]
    for (const ordered of [rows, [...rows].reverse()]) {
      const { snapshot } = await analyzed([
        game('UI/UnitEditorData.txt', '[unitRace]\nNumValues=1\n00=human,Human\n'),
        game('Units/AbilityMetaData.slk', sheet([['ID', 'field', 'slk', 'type', condition], ...ordered])),
        game('Units/AbilityData.slk', sheet([['alias', 'race', 'Target'], ['AHbz', 'human', 'hfoo'], ['Adef', 'human', 'AHbz']])),
        game('Units/UnitData.slk', sheet([['unitID'], ['hfoo']])),
      ])
      const fields = snapshot.schemas?.find(item => item.typeId === 'ability')?.fields
      expect(fields?.find(field => field.fieldId === 'AbilityData.race')?.type).toBeUndefined()
      expect(fields?.find(field => field.fieldId === 'AbilityData.Target')?.linkNamespace).toBeUndefined()
      expect(snapshot.relations.filter(edge => edge.role === 'AbilityData.Target')).toEqual([])
      expect(snapshot.definitions.find(entity => entity.namespace === 'ability' && entity.entityId === 'Adef')?.fields)
        .toMatchObject({ 'AbilityData.race': 'human', 'AbilityData.Target': 'AHbz' })
    }
  })

  it.each(['', '   '])('keeps an unconditional scalar enum when notSpecific is %j', async notSpecific => {
    const { snapshot } = await analyzed([
      game('UI/UnitEditorData.txt', '[unitRace]\nNumValues=1\n00=human,Human\n'),
      game('Units/AbilityMetaData.slk', sheet([['ID', 'field', 'slk', 'type', 'notSpecific'], ['arac', 'race', 'AbilityData', 'unitRace', notSpecific]])),
      game('Units/AbilityData.slk', sheet([['alias', 'race'], ['AHbz', 'human']])),
    ])
    expect(snapshot.schemas?.find(item => item.typeId === 'ability')?.fields.find(field => field.fieldId === 'AbilityData.race')?.type)
      .toEqual({ kind: 'enum', members: [{ id: 'human' }] })
  })

  it.each([{ unknownInts: [] }, { unknownInts: [0] }, { unknownInts: [1] }, { unknownInts: [0, 1] }])('projects only qualified v3 headers $unknownInts', async ({ unknownInts }) => {
    const file = new War3MapW3u()
    file.version = 3
    const changed = changedObject('hfoo', '\0\0\0\0', [objectChange('unam', 3, 'V3 Guard')])
    changed.unknownInts = unknownInts
    file.originalTable.objects.push(changed)
    const { snapshot } = await analyzed([...DOCUMENTS, { rootId: 'map', path: 'war3map.w3u', text: '', bytes: file.save() }])
    const admitted = unknownInts.length === 0 || (unknownInts.length === 1 && unknownInts[0] === 0)
    expect(snapshot.definitions.find(entity => entity.namespace === 'unit' && entity.entityId === 'hfoo')?.fields['Profile.Name'])
      .toBe(admitted ? 'V3 Guard' : 'Footman')
    expect(snapshot.diagnostics.filter(item => item.code === 'blizzard.warcraft3/object-mods-unreadable'))
      .toHaveLength(admitted ? 0 : 1)
    if (!admitted) expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('unknown header semantics'), source: expect.objectContaining({ path: 'war3map.w3u' }),
    }))
  })

  it('plans every object table and profile of every root', async () => {
    const workspace = createProvider({ contract: 'common.data/resolved-workspace' }).value
    const plan = await workspace.plan({
      workspace: { workspaceId: 'w', gameId: 'blizzard/warcraft-3', loadOrder: [{ rootId: 'game', sourcePath: 'context-layers/0' }, { rootId: 'map', sourcePath: 'context-layers/1' }] } as never,
      locales: [],
      maxRequirements: 512,
    })
    expect(plan.complete).toBe(true)
    // Under the root's logical path, as the host confines every requirement.
    expect(plan.requirements.filter(item => item.rootId === 'map').map(item => item.path)).toEqual(
      expect.arrayContaining(['context-layers/1/Units/UnitData.slk', 'context-layers/1/Units/HumanUnitFunc.txt', 'context-layers/1/Units/UnitMetaData.slk']),
    )
    expect(plan.requirements.every(item => item.kind === 'catalog' && item.required === false)).toBe(true)
  })

  it('joins a unit across its sheets and profiles, the map sheet replacing the game one', async () => {
    const { snapshot } = await analyzed()
    const footman = snapshot.entities.find(entity => entity.entityId === 'hfoo')
    expect(footman?.fields).toEqual({
      'UnitData.race': 'human',
      'UnitData.movetp': 'foot',
      // The map's UnitBalance.slk is the one the game reads: its HP, and no goldcost column.
      'UnitBalance.HP': '999',
      'Profile.Buttonpos': '0,0',
      'Profile.Name': 'Footman',
      'Profile.Tip': 'Train; then fight',
      // A list the metadata types as abilities is a list of ids.
      'UnitAbilities.abilList': ['AHbz', 'Adef'],
    })
    expect(footman?.fieldSources?.['UnitBalance.HP']).toMatchObject({ rootId: 'map' })
    expect(snapshot.diagnostics.map(item => item.code)).toContain('blizzard.warcraft3/data-file-replaced')
    // The peasant is in the game's balance sheet only, which the map's replaced.
    expect(snapshot.definitions.find(entity => entity.entityId === 'hpea')?.fields['UnitBalance.HP']).toBeUndefined()
  })

  it('reads each kind from its own sheets and profiles', async () => {
    const { snapshot } = await analyzed()
    const of = (namespace: string, id: string) => snapshot.definitions.find(entity => entity.namespace === namespace && entity.entityId === id)
    expect(of('ability', 'AHbz')?.fields).toEqual({ 'AbilityData.code': 'AHbz', 'AbilityData.levels': '3', 'Profile.Name': 'Blizzard' })
    expect(of('buff', 'BHbd')?.fields).toEqual({ 'AbilityBuffData.code': 'BHbd', 'Profile.Bufftip': 'Blizzard' })
    expect(of('ability', 'BHbd')).toBeUndefined()
    expect(of('unit', 'AHbz')).toBeUndefined()
    expect((snapshot.schemas ?? []).map(schema => schema.typeId)).toEqual(['unit', 'item', 'ability', 'buff', 'upgrade', 'destructable', 'doodad'])
  })

  it('applies w3h changes to buffs, inherits custom buffs and links ability buff lists', async () => {
    const buffs = new War3MapW3u()
    buffs.version = 2
    buffs.originalTable.objects.push(changedObject('BHbd', '\0\0\0\0', [objectChange('ftip', 3, 'Changed buff')]))
    buffs.customTable.objects.push(changedObject('BHbd', 'B001', [objectChange('ftip', 3, 'Custom buff')]))
    const { snapshot } = await analyzed([
      ...DOCUMENTS,
      game('Units/AbilityBuffMetaData.slk', sheet([['ID', 'field', 'slk', 'index', 'type'], ['ftip', 'Bufftip', 'Profile', '-1', 'string']])),
      game('Units/AbilityMetaData.slk', sheet([['ID', 'field', 'slk', 'index', 'type'], ['abuf', 'BuffID', 'AbilityData', '-1', 'buffList']])),
      game('Units/AbilityData.slk', sheet([['alias', 'code', 'BuffID'], ['AHbz', 'AHbz', 'BHbd,B001']])),
      game('Units/HumanAbilityFunc.txt', '[B001]\r\nArt=Textures/CustomBuff.blp\r\n'),
      { rootId: 'map', path: 'war3map.w3h', text: '', bytes: buffs.save() },
    ])
    const of = (id: string) => snapshot.definitions.find(entity => entity.namespace === 'buff' && entity.entityId === id)
    expect(of('BHbd')?.fields['Profile.Bufftip']).toBe('Changed buff')
    expect(of('B001')?.fields).toMatchObject({ 'AbilityBuffData.code': 'BHbd', 'Profile.Bufftip': 'Custom buff', 'Profile.Art': 'Textures/CustomBuff.blp' })
    expect(of('B001')?.inheritanceChain.map(parent => parent.entityId)).toContain('BHbd')
    expect(snapshot.definitions.some(entity => entity.namespace === 'ability' && entity.entityId === 'B001')).toBe(false)
    expect(snapshot.relations.filter(edge => edge.role === 'AbilityData.BuffID').map(edge => [edge.to.namespace, edge.to.entityId, edge.dead]).sort())
      .toEqual([['buff', 'B001', false], ['buff', 'BHbd', false]])
  })

  it('routes shared profiles by declared IDs regardless of document order and diagnoses ambiguous IDs', async () => {
    const buffTable = DOCUMENTS.find(document => document.path === 'Units/AbilityBuffData.slk')!
    const reordered = [...DOCUMENTS.filter(document => document !== buffTable), buffTable]
    const { snapshot } = await analyzed(reordered)
    expect(snapshot.definitions.find(entity => entity.namespace === 'buff' && entity.entityId === 'BHbd')?.fields['Profile.Bufftip']).toBe('Blizzard')
    const ambiguous = await analyzed([...reordered,
      game('Units/AbilityData.slk', sheet([['alias', 'code'], ['BHbd', 'BHbd']])),
    ])
    expect(ambiguous.snapshot.diagnostics.some(item => item.code === 'blizzard.warcraft3/data-profile-kind-ambiguous')).toBe(true)
    expect(ambiguous.snapshot.definitions.filter(entity => entity.entityId === 'BHbd').every(entity => entity.fields['Profile.Bufftip'] === undefined)).toBe(true)
  })

  it('recognizes native buff tooltip declarations without an editor sheet, never a rawcode prefix alone', async () => {
    const { snapshot } = await analyzed([
      ...DOCUMENTS.filter(document => document.path !== 'Units/AbilityBuffData.slk'),
      game('Units/CommonAbilityFunc.txt', '[Bxxx]\r\nArt=Textures/Ability.blp\r\n[notB]\r\nBuffubertip=Native buff\r\n'),
    ])
    expect(snapshot.definitions.find(entity => entity.namespace === 'buff' && entity.entityId === 'BHbd')?.fields['Profile.Bufftip']).toBe('Blizzard')
    expect(snapshot.definitions.find(entity => entity.namespace === 'buff' && entity.entityId === 'notB')?.fields['Profile.Buffubertip']).toBe('Native buff')
    expect(snapshot.definitions.find(entity => entity.namespace === 'ability' && entity.entityId === 'Bxxx')?.fields['Profile.Art']).toBe('Textures/Ability.blp')
    expect(snapshot.definitions.some(entity => entity.namespace === 'buff' && entity.entityId === 'Bxxx')).toBe(false)
  })

  it('scopes identical profile-field link names to their object kind', async () => {
    const { snapshot } = await analyzed([...DOCUMENTS,
      game('Units/UnitMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['utgt', 'Targets', 'Profile', 'unitList']])),
      game('Units/AbilityMetaData.slk', sheet([['ID', 'field', 'slk', 'type'], ['atgt', 'Targets', 'Profile', 'abilityList']])),
      game('Units/HumanUnitFunc.txt', '[hfoo]\r\nTargets=hpea\r\n'),
      game('Units/HumanAbilityFunc.txt', '[AHbz]\r\nTargets=AHbz\r\n'),
    ])
    expect(snapshot.relations.filter(edge => edge.role === 'Profile.Targets').map(edge => [edge.from.namespace, edge.to.namespace, edge.to.entityId, edge.dead]).sort())
      .toEqual([['ability', 'ability', 'AHbz', false], ['unit', 'unit', 'hpea', false]])
  })

  it.each([false, true])('does not publish conditional useSpecific/conflicting row types as universal links (reverse=%s)', async reverse => {
    const rows = [
      ['Hbz1', 'Target', 'AbilityData', 'unitList', 'AHbz'],
      ['Adef', 'Target', 'AbilityData', 'int', 'Adef'],
      ['auni', 'Mixed', 'Profile', 'unitList', ''],
      ['aabi', 'Mixed', 'Profile', 'abilityList', ''],
    ]
    const { snapshot } = await analyzed([...DOCUMENTS,
      game('Units/AbilityMetaData.slk', sheet([['ID', 'field', 'slk', 'type', 'useSpecific'], ...(reverse ? rows.reverse() : rows)])),
      game('Units/AbilityData.slk', sheet([['alias', 'Target'], ['AHbz', 'hfoo'], ['Adef', '3']])),
      game('Units/HumanAbilityFunc.txt', '[AHbz]\r\nMixed=hfoo,AHbz\r\n'),
    ])
    expect(snapshot.relations.filter(edge => ['AbilityData.Target', 'Profile.Mixed'].includes(edge.role))).toEqual([])
    expect(snapshot.definitions.find(entity => entity.namespace === 'ability' && entity.entityId === 'Adef')?.fields['AbilityData.Target']).toBe('3')
    const fields = snapshot.schemas?.find(schema => schema.typeId === 'ability')?.fields
    expect(fields?.find(field => field.fieldId === 'AbilityData.Target')?.linkNamespace).toBeUndefined()
    expect(fields?.find(field => field.fieldId === 'Profile.Mixed')?.linkNamespace).toBeUndefined()
  })

  it('links a unit to the abilities its list names, a missing one as a dead link', async () => {
    const { workspace, snapshot } = await analyzed()
    expect(snapshot.relations.map(relation => [relation.from.entityId, relation.to.namespace, relation.to.entityId, relation.role, relation.dead]).sort()).toEqual([
      ['hfoo', 'ability', 'AHbz', 'UnitAbilities.abilList', false],
      ['hfoo', 'ability', 'Adef', 'UnitAbilities.abilList', true],
    ].sort())
    const graph = (await workspace.openRelations({ snapshotId: snapshot.snapshotId, maxPageSize: 100 })).value
    const edges = (await graph.edges({ limit: 10 })).items
    expect(edges).toHaveLength(2)
    expect(edges).toEqual(expect.arrayContaining([
      { from: 'unit/hfoo', to: 'ability/AHbz', role: 'UnitAbilities.abilList' },
      { from: 'unit/hfoo', to: 'ability/Adef', role: 'UnitAbilities.abilList', dead: true },
    ]))
    expect((await graph.nodes({ limit: 100 })).items).toContainEqual({ id: 'ability/Adef', label: 'Adef', type: 'missing-ability' })
  })

  it("applies the map's object-editor changes over the tables, a custom object inheriting its base", async () => {
    const { snapshot } = await analyzed(mapChanges())
    const of = (namespace: string, id: string) => snapshot.definitions.find(entity => entity.namespace === namespace && entity.entityId === id)
    // The first element of the button position, the rest of the list kept.
    expect(of('unit', 'hfoo')?.fields['Profile.Buttonpos']).toBe('2,0')
    // The militia reads as the peasant, with its own name and abilities, and links to Blizzard.
    expect(of('unit', 'h000')?.fields).toMatchObject({ 'UnitData.race': 'human', 'Profile.Name': 'Militia', 'UnitAbilities.abilList': ['AHbz'] })
    expect(snapshot.relations).toContainEqual(expect.objectContaining({ from: expect.objectContaining({ entityId: 'h000' }), to: expect.objectContaining({ entityId: 'AHbz' }), dead: false }))
    // Blizzard's second data column at level 2.
    expect(of('ability', 'AHbz')?.fields['AbilityData.DataB2']).toBe('1.5')
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'blizzard.warcraft3/object-change-unmapped', message: expect.stringContaining('xxxx') }))
  })

  it('plans the object-editor files of every root as binary documents', async () => {
    const workspace = createProvider({ contract: 'common.data/resolved-workspace' }).value
    const plan = await workspace.plan({
      workspace: { workspaceId: 'w', gameId: 'blizzard/warcraft-3', loadOrder: [{ rootId: 'map', sourcePath: 'context-layers/1' }] } as never,
      locales: [],
      maxRequirements: 200,
    })
    expect(plan.requirements.filter(item => item.encoding === 'binary').map(item => item.path)).toEqual(
      ['war3map', 'war3mapSkin', 'war3campaign'].flatMap(stem =>
        ['w3u', 'w3t', 'w3b', 'w3h', 'w3d', 'w3a', 'w3q'].map(extension => `context-layers/1/${stem}.${extension}`)),
    )
    expect(plan.requirements.map(item => item.path)).toEqual(expect.arrayContaining([
      'context-layers/1/war3map.wts', 'context-layers/1/war3campaign.wts',
      'context-layers/1/Units/AbilitySkin.txt', 'context-layers/1/Units/UnitWeaponsSkin.txt',
    ]))
  })

  it('applies same-root map, skin and campaign overrides in native order, with scoped WTS', async () => {
    const changes = (path: string, value: string): DataCatalogDocument => {
      const file = new War3MapW3u()
      file.version = 2
      file.originalTable.objects.push(changedObject('hfoo', '\0\0\0\0', [objectChange('unam', 3, value)]))
      return { rootId: 'map', path, text: '', bytes: file.save() }
    }
    const map = changes('nested/war3map.w3u', 'ordinary')
    const skin = changes('nested/war3mapSkin.w3u', 'TRIGSTR_0001')
    const campaign = changes('nested/war3campaign.w3u', 'TRIGSTR_0001')
    const strings: DataCatalogDocument[] = [
      { rootId: 'map', path: 'nested/war3map.wts', text: 'STRING 1\n{\nMap skin name\n}\n' },
      { rootId: 'map', path: 'nested/war3campaign.wts', text: 'STRING 1\n{\nCampaign name\n}\n' },
    ]
    const value = async (extra: DataCatalogDocument[]) => {
      const { snapshot } = await analyzed([...DOCUMENTS, ...strings, ...extra])
      return snapshot.definitions.find(entity => entity.namespace === 'unit' && entity.entityId === 'hfoo')
    }
    expect((await value([skin, map]))?.fields['Profile.Name']).toBe('Map skin name')
    const final = await value([campaign, skin, map])
    expect(final?.fields['Profile.Name']).toBe('Campaign name')
    expect(final?.fieldSources?.['Profile.Name']).toMatchObject({ path: 'nested/war3campaign.w3u' })
  })

  it('retains a missing TRIGSTR instead of replacing it with an unrelated or invented string', async () => {
    const file = new War3MapW3u()
    file.version = 2
    file.originalTable.objects.push(changedObject('hfoo', '\0\0\0\0', [objectChange('unam', 3, 'TRIGSTR_17')]))
    const { snapshot } = await analyzed([...DOCUMENTS,
      { rootId: 'map', path: 'war3map.w3u', text: '', bytes: file.save() },
      { rootId: 'later', path: 'war3map.wts', text: 'STRING 17\n{\nWrong map\n}\n' },
    ])
    expect(snapshot.definitions.find(entity => entity.namespace === 'unit' && entity.entityId === 'hfoo')?.fields['Profile.Name']).toBe('TRIGSTR_17')
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'blizzard.warcraft3/object-string-unresolved' }))
  })

  it('shows the definitions as one row a unit, one column a field', async () => {
    const { workspace, snapshot } = await analyzed()
    const table = (await workspace.openDefinitionTable({ snapshotId: snapshot.snapshotId, maxPageSize: 100 })).value as TableDataSource
    const shape = await table.shape()
    expect(shape.header?.slice(0, 2)).toEqual(['namespace', 'id'])
    const rows = await table.rows({ kind: 'range', from: 0, count: 10 })
    const footman = rows.items.find(row => row.cells[1] === 'hfoo')
    expect(footman?.cells[shape.header!.indexOf('Profile.Name')]).toBe('Footman')
  })
})
