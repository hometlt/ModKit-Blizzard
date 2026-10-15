/**
 * The compact authoring index from catalog-engine (S3 of the one-resolver decision). The cases are
 * the ones that pinned the retired SDK `resolveDataAuthoringIndex` (Core packages/sdk/test/data.test.ts),
 * spelled as SC2 catalogs: parent-relative rows, structure defaults, removals, leaf origins, tokens,
 * and the output bounds.
 */
import { describe, expect, it } from 'vitest'
import { uint64 } from '@modkit/core'
import { revisionId } from '@modkit/sdk/codec'
import { dataAuthoringSource, type ResolvedDataAuthoringIndex } from '@modkit/sdk/data'
import {
  analyzeStarcraft2DataAuthoringIndex,
  analyzeStarcraft2ResolvedData,
} from '../services/catalog/provider.js'
import { buildStarcraft2AuthoringIndex } from '../services/catalog/authoring-index.js'

const document = (rootId: string, path: string, text: string) => ({ rootId, path, text })
const core = (text: string) => document('core', 'mods/core.sc2mod/base.sc2data/gamedata/abildata.xml', `<Catalog>${text}</Catalog>`)
const liberty = (text: string) => document('liberty', 'mods/liberty.sc2mod/base.sc2data/gamedata/abildata.xml', `<Catalog>${text}</Catalog>`)

function request(documents: readonly ReturnType<typeof document>[]) {
  return {
    workspaceId: 'workspace:authoring',
    gameId: 'blizzard/starcraft-2',
    documents,
    localizationDocuments: [],
    usageDocuments: [],
    locales: [],
    localizationKeys: [],
    queries: [],
    maxDocuments: 8,
    maxTextBytes: 1_048_576,
    maxEntities: 2_048,
    maxDepth: 64,
    maxOutputBytes: 16 * 1_048_576,
    plannedDocumentCount: documents.length,
    unresolvedRequirementIds: [],
  }
}

type Index = ResolvedDataAuthoringIndex
const sourcesOf = (index: Index) => index.sourceTable.map((_source, position) => dataAuthoringSource(index, position))
const rootOf = (index: Index, source: number) => dataAuthoringSource(index, source)?.rootId

describe('SC2 authoring index from catalog-engine', () => {
  it('builds parent-relative rows with structure defaults, sources and removals', async () => {
    const index = await analyzeStarcraft2DataAuthoringIndex(request([
      core(`<SCost><Charge Link="Abil/##id##"/></SCost>
        <CAbilEffectTarget id="Base">
          <EditorCategories value="AbilityorEffectType:Units"/>
          <Flags index="Transient" value="1"/>
          <InterruptCost><Cooldown TimeUse="5"/></InterruptCost>
        </CAbilEffectTarget>`),
      liberty('<CAbilEffectTarget id="Child" parent="Base"><Flags index="Transient" removed="1"/></CAbilEffectTarget>'),
    ])) as Index
    const child = index.entities.find(entity => entity.entityId === 'Child')!
    expect(child).toMatchObject({ parentEntityId: 'Base', complete: true })
    expect(rootOf(index, child.source)).toBe('liberty')
    const fields = new Map(child.fields?.map(field => [field.fieldId, field]))
    expect(fields.get('Flags')).toMatchObject({ value: [], originEntityId: 'Child' })
    const cost = fields.get('InterruptCost')!
    expect(cost).toMatchObject({ value: { Charge: { Link: 'Abil/Child' }, Cooldown: { TimeUse: 5 } }, originEntityId: 'Base' })
    expect(cost.origins?.map(origin => [origin.path.join('/'), rootOf(index, origin.source), origin.originEntityId])).toEqual([
      ['Charge/Link', 'core', 'Child'],
      ['Cooldown/TimeUse', 'core', 'Base'],
    ])
    // Inherited values stay on the ancestor's row.
    expect(fields.has('EditorCategories')).toBe(false)
    expect(child.tombstones?.map(tombstone => [tombstone.path.join('/'), rootOf(index, tombstone.source)])).toEqual([
      ['Flags/Transient', 'liberty'],
    ])
    expect(index.valuesComplete).toBe(true)
  })

  it('tracks leaf origins and inherited tokens consistently with the full snapshot', async () => {
    const documents = [
      core(`<CAbilEffectTarget id="Base" default="1">
          <?token id="Tone" value="blue"?><?token id="Unit" type="CUnitLink" value="Marine"?>
          <InterruptCost><Charge Link="Base"/><Cooldown Link="Old"/></InterruptCost>
          <CmdButtonArray index="Execute" DefaultButtonFace="Keep" Requirements="Old"/>
        </CAbilEffectTarget>`),
      liberty(`<CAbilEffectTarget id="Base"><?token id="Tone" value="red"?><InterruptCost><Cooldown Link="New"/></InterruptCost></CAbilEffectTarget>
        <CAbilEffectTarget id="Child" parent="Base">
          <?token id="Local" value="yes"?><?token id="Unit" type="CUnitLink" value="Marauder"?>
          <InterruptCost><Cooldown TimeUse="3"/></InterruptCost>
          <CmdButtonArray index="Execute" Requirements="Child"/>
        </CAbilEffectTarget>`),
    ]
    const index = await analyzeStarcraft2DataAuthoringIndex(request(documents)) as Index
    const child = index.entities.find(entity => entity.entityId === 'Child')!
    const origins = (fieldId: string) => child.fields?.find(field => field.fieldId === fieldId)?.origins
      ?.map(origin => [origin.path.join('/'), rootOf(index, origin.source), origin.originEntityId])
    expect(origins('InterruptCost')).toEqual([
      ['Charge/Link', 'core', 'Base'],
      ['Cooldown/Link', 'liberty', 'Base'],
      ['Cooldown/TimeUse', 'liberty', 'Child'],
    ])
    expect(origins('CmdButtonArray')).toEqual([
      ['Execute/DefaultButtonFace', 'core', 'Base'],
      ['Execute/Requirements', 'liberty', 'Child'],
    ])
    expect(child.tokens).toEqual([
      { id: 'Local', value: 'yes' },
      { id: 'Tone', value: 'red' },
      { id: 'Unit', type: 'CUnitLink', value: 'Marauder' },
    ])
    expect(child.defaultTemplate).toBeUndefined()
    expect(index.entities.find(entity => entity.entityId === 'Base')?.defaultTemplate).toBe(true)
    const snapshot = await analyzeStarcraft2ResolvedData(request(documents))
    expect(snapshot.definitions.find((entity: { entityId: string }) => entity.entityId === 'Child')?.tokens).toEqual(child.tokens)
    expect(snapshot.definitions.find((entity: { entityId: string }) => entity.entityId === 'Base')?.defaultTemplate).toBe(true)
  })
})

describe('SC2 authoring index bounds', () => {
  const source = { rootId: 'root-0', path: 'UnitData-0.xml', documentIndex: 0 }
  const entity = (entityId: string, value: string) => {
    const origin = { source, originEntityId: entityId }
    return {
      namespace: 'Unit', typeId: 'CUnit', entityId, source, complete: true,
      fields: { Blob: value }, rowFields: new Set(['Blob']), fallback: origin,
      fieldOrigin: () => origin, leafOrigin: () => origin, tombstones: [],
    }
  }
  const input = {
    workspaceId: 'bounded', gameId: 'blizzard/starcraft-2', analyzerId: 'blizzard/starcraft-2', snapshotId: 'bounded:1',
    schemas: [{ typeId: 'CUnit', fields: [{ fieldId: 'Blob', cardinality: 'scalar' as const }] }],
    patchCount: 1, diagnostics: [], complete: true,
  }

  it('drops all values on overflow while preserving every identity and winning source', () => {
    const index = buildStarcraft2AuthoringIndex({ ...input, entities: [entity('Large', 'x'.repeat(10_000))], maxOutputBytes: 2_048 })
    expect(index.valuesComplete).toBe(false)
    expect(index.entities).toEqual([expect.objectContaining({ identity: 'Unit\u0000Large', source: 0 })])
    expect(index.entities[0]).not.toHaveProperty('fields')
    expect(sourcesOf(index)).toEqual([expect.objectContaining({ rootId: 'root-0', path: 'UnitData-0.xml' })])
    expect(new TextEncoder().encode(JSON.stringify(index)).byteLength).toBeLessThanOrEqual(2_048)
  })

  it('retains all values within the transfer limit by eliding only uniform leaf provenance', () => {
    const uniform = entity('Marine', '')
    const value = Object.fromEntries(Array.from({ length: 100 }, (_, item) => [String(item), item]))
    const index = buildStarcraft2AuthoringIndex({
      ...input,
      entities: [{
        ...uniform,
        fields: { Blob: value },
      }],
      maxOutputBytes: 2_048,
    })
    expect(index.valuesComplete).toBe(true)
    const field = index.entities[0]?.fields?.[0]
    expect(field).toMatchObject({ source: 0, originEntityId: 'Marine', value })
    expect(field?.origins).toBeUndefined()
    expect(dataAuthoringSource(index, 0)).toEqual(source)
    expect(new TextEncoder().encode(JSON.stringify(index)).byteLength).toBeLessThanOrEqual(2_048)
  })

  it('retains every leaf of mixed provenance in canonical path order', () => {
    const child = entity('Marine', '')
    const inherited = { rootId: 'parent', path: 'UnitData.xml', documentIndex: 1 }
    const value = { '2': { Life: 45 }, '10': { Speed: 2 } }
    const index = buildStarcraft2AuthoringIndex({
      ...input,
      entities: [{
        ...child,
        fields: { Blob: value },
        leafOrigin: (_field: string, path: readonly string[]) => path[0] === '10'
          ? { source: inherited, originEntityId: 'Parent' }
          : child.fallback,
      }],
      maxOutputBytes: 2_048,
    })
    expect(index.complete).toBe(true)
    expect(index.valuesComplete).toBe(true)
    expect(sourcesOf(index)).toEqual([source, inherited])
    expect(index.entities[0]?.fields?.[0]).toEqual({
      fieldId: 'Blob', value, source: 0, originEntityId: 'Marine',
      origins: [
        { path: ['10', 'Speed'], source: 1, originEntityId: 'Parent' },
        { path: ['2', 'Life'], source: 0, originEntityId: 'Marine' },
      ],
    })
    expect(Object.isFrozen(index.entities[0]?.fields?.[0]?.value)).toBe(true)
  })

  it('keeps distinct declaration locations in the same native document', () => {
    const parentSource = { ...source, range: { utf16Offset: 10, utf16Length: 20, line: 1, column: 2 } }
    const ownSource = { ...source, range: { utf16Offset: 100, utf16Length: 30, line: 5, column: 2 } }
    const parent = { source: parentSource, originEntityId: 'Base' }
    const own = { source: ownSource, originEntityId: 'Marine' }
    const index = buildStarcraft2AuthoringIndex({
      ...input,
      entities: [
        { ...entity('Base', '1'), source: parentSource, fallback: parent,
          fieldOrigin: () => parent, leafOrigin: () => parent },
        { ...entity('Marine', ''), source: ownSource, fallback: own,
          fields: { Blob: { inherited: 1, own: 2 } }, fieldOrigin: () => own,
          leafOrigin: (_field: string, path: readonly string[]) => path[0] === 'inherited' ? parent : own,
          tombstones: [{ path: ['Blob', 'removed'], source: ownSource }] },
      ],
      maxOutputBytes: 4_096,
    })
    expect(sourcesOf(index)).toEqual([parentSource, ownSource])
    expect(index.entities[0]?.source).toBe(0)
    expect(index.entities[1]?.source).toBe(1)
    expect(index.entities[1]?.fields?.[0]).toMatchObject({
      source: 1, origins: [
        { path: ['inherited'], source: 0, originEntityId: 'Base' },
        { path: ['own'], source: 1, originEntityId: 'Marine' },
      ],
    })
    expect(index.entities[1]?.tombstones).toEqual([{ path: ['Blob', 'removed'], source: 1 }])
  })

  it('retains all values and distinct spans within a bound without repeating a long document path', () => {
    const count = 600
    const path = `GameData/${'long'.repeat(500)}/UnitData.xml`
    const entities = Array.from({ length: count }, (_, position) => {
      const source = { rootId: 'mod', path, documentIndex: 0, revision: revisionId('provider-token:v1'),
        range: { utf16Offset: position * 100, utf16Length: 20, line: position, column: 4 } }
      const origin = { source, originEntityId: `Unit${position}` }
      return { ...entity(origin.originEntityId, String(position)), source, fallback: origin,
        fieldOrigin: () => origin, leafOrigin: () => origin }
    })
    const index = buildStarcraft2AuthoringIndex({
      ...input, entities, patchCount: count, maxOutputBytes: 256 * 1_024,
    })
    expect(index.schemaVersion).toBe(2)
    expect(index.valuesComplete).toBe(true)
    expect(index.entityCount).toBe(count)
    expect(index.sourceTable).toHaveLength(count)
    if (index.schemaVersion === 2) expect(index.sourceDocuments).toHaveLength(1)
    for (const row of index.entities) {
      const position = Number(row.entityId.slice(4))
      expect(row.fields?.[0]?.value).toBe(String(position))
      expect(dataAuthoringSource(index, row.source)).toEqual(entities[position]?.source)
      expect(dataAuthoringSource(index, row.fields![0]!.source)).toEqual(entities[position]?.source)
      expect(row.tombstones).toBeUndefined()
    }
    expect(new TextEncoder().encode(JSON.stringify(index)).byteLength).toBeLessThanOrEqual(256 * 1_024)
  })

  it('keeps distinct byte and combined source spans in the same document', () => {
    const ranges = [
      { byteOffset: uint64('18446744073709551614'), byteLength: uint64('1') },
      { byteOffset: uint64('10'), byteLength: uint64('20') },
      { byteOffset: uint64('10'), byteLength: uint64('20'), utf16Offset: 5, utf16Length: 10, line: 1, column: 2 },
    ]
    const entities = ranges.map((range, position) => {
      const origin = { source: { ...source, range }, originEntityId: `Unit${position}` }
      return { ...entity(origin.originEntityId, String(position)), source: origin.source,
        fallback: origin, fieldOrigin: () => origin, leafOrigin: () => origin }
    })
    const index = buildStarcraft2AuthoringIndex({ ...input, entities, maxOutputBytes: 4_096 })
    expect(index.valuesComplete).toBe(true)
    expect(index.sourceTable).toHaveLength(3)
    expect(sourcesOf(index)).toEqual(entities.map(entity => entity.source))
    expect(index.entities.map(row => dataAuthoringSource(index, row.fields![0]!.source)?.range)).toEqual(ranges)
  })

  it('bounds diagnostic evidence while retaining exact severity totals', () => {
    const index = buildStarcraft2AuthoringIndex({
      ...input,
      entities: [entity('Marine', '')],
      diagnostics: Array.from({ length: 80 }, (_, item) => ({
        severity: item % 2 === 0 ? ('warning' as const) : ('information' as const),
        code: `example/${'c'.repeat(300)}`,
        message: `diagnostic${String.fromCharCode(0)}${'m'.repeat(3_000)}`,
      })),
      maxOutputBytes: 1_048_576,
    })
    expect(index.diagnostics).toMatchObject({ errorCount: 0, warningCount: 40, informationCount: 40, truncated: true })
    expect(index.diagnostics.items).toHaveLength(64)
    expect(index.diagnostics.items[0]?.code).toHaveLength(256)
    expect(index.diagnostics.items[0]?.message).toHaveLength(2_048)
    expect(index.diagnostics.items[0]?.message).not.toContain(String.fromCharCode(0))
  })

  it('keeps a many-entity identity/source index inside a fixed transfer budget', () => {
    const count = 5_000
    const index = buildStarcraft2AuthoringIndex({
      ...input,
      entities: Array.from({ length: count }, (_, item) => entity(`Unit${item}`, 'x'.repeat(2_048))),
      patchCount: count,
      maxOutputBytes: 4 * 1_048_576,
    })
    expect(index.entityCount).toBe(count)
    expect(index.entities).toHaveLength(count)
    expect(index.sourceTable).toHaveLength(1)
    expect(index.valuesComplete).toBe(false)
    expect(new TextEncoder().encode(JSON.stringify(index)).byteLength).toBeLessThanOrEqual(4 * 1_048_576)
  })
})
