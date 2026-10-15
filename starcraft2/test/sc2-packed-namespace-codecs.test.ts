import { describe, expect, it } from 'vitest'
import { createCodec as createMapCodec } from '../modules/map/codecs/package/src/codec.js'
import { createCodec as createReplayCodec } from '../modules/replay/codecs/replay/runtime.js'
import { createCodec as createLooseMapCodec } from '../modules/map/codecs/package-directory/runtime.js'
import { createNamespaceInput } from './support/namespace-input.js'
import { createSc2NamespaceEntrySource } from '../shared/package-namespace/runtime.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const revision = 'content-hash.sha256:sc2-packed-namespace-fixture'
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 10_000,
  maxScalarBytes: 8_388_608,
  maxDiagnostics: 100,
}

function heightGrid() {
  const bytes = new Uint8Array(32 + 4 * 6)
  bytes.set(encoder.encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  for (let index = 0; index < 4; index += 1) view.setUint16(32 + index * 6, 100 + index, true)
  return bytes
}

describe('packed SC2 namespace semantics', () => {
  it('lists a prefix and what is under it, not siblings whose name starts with it', async () => {
    const entry = (path: string, kind: 'file' | 'directory') => ({
      id: path,
      path,
      name: path.split('/').pop()!,
      kind,
      revision,
    })
    const source = createSc2NamespaceEntrySource(
      [
        entry('Base.SC2Data', 'directory'),
        entry('Base.SC2Data/GameData', 'directory'),
        entry('Base.SC2Data/GameData/UnitData.xml', 'file'),
        entry('Base.SC2Data/GameData.xml', 'file'),
      ],
      undefined,
      { id: 'root', uri: 'memory://sc2/Prefix.SC2Map' },
    )
    const page = await source.list('Base.SC2Data/GameData', { limit: 16 })
    expect(page.items.map((item: { path: string }) => item.path)).toEqual([
      'Base.SC2Data/GameData',
      'Base.SC2Data/GameData/UnitData.xml',
    ])
  })

  it('keeps the normalized loose and packed map projections equal', async () => {
    const input = createNamespaceInput(
      {
        MapInfo: encoder.encode('<MapInfo/>'),
        Objects: encoder.encode('<PlacedObjects/>'),
        Regions: encoder.encode('<Regions/>'),
        t3HeightMap: heightGrid(),
        'Base.SC2Data/GameData/UnitData.xml': encoder.encode('<Catalog/>'),
        'enUS.SC2Data/LocalizedData/GameStrings.txt': encoder.encode('Name=Fixture'),
      },
      { revision },
    )
    const packed = await (await createMapCodec()).open(input, 'full', budget)
    const loose = await (await createLooseMapCodec()).open(input, 'full', budget)
    try {
      const [packedResult, looseResult] = await Promise.all([
        packed.operations().invoke('inspect', {}),
        loose.operations().invoke('inspect', {}),
      ])
      expect(packedResult.state).toBe('ok')
      expect(looseResult.state).toBe('ok')
      if (
        packedResult.state !== 'ok' ||
        packedResult.output.kind !== 'json' ||
        looseResult.state !== 'ok' ||
        looseResult.output.kind !== 'json'
      ) {
        throw new Error('SC2 map projection comparison did not return JSON')
      }
      const normalized = value => ({
        packageKind: value.packageKind,
        entries: value.entries,
        files: value.files,
        directories: value.directories,
        componentLists: value.componentLists,
        scripts: value.scripts,
        localizedData: value.localizedData,
        gameData: value.gameData,
        banks: value.banks,
        bankLists: value.bankLists,
        mapDocuments: value.mapDocuments,
        dependencies: value.dependencies,
      })
      expect(normalized(packedResult.output.value)).toEqual(normalized(looseResult.output.value))
      expect(packedResult.output.value).toMatchObject({
        format: 'sc2-map',
        topology: 'mpq-namespace',
      })
      expect(looseResult.output.value).toMatchObject({
        format: 'sc2-map-directory',
        topology: 'mounted-directory',
      })
    } finally {
      await Promise.all([packed.dispose(), loose.dispose()])
    }
  })

  // «Entity card…» on an open map, as on a mod: the map lends its own entities, and any entity of
  // its mod context through the catalog port (a map without the selector sent cards to map navigation).
  it('lends its own entities and those of its context as cards', async () => {
    const input = createNamespaceInput(
      {
        MapInfo: encoder.encode('<MapInfo/>'),
        Objects: encoder.encode('<PlacedObjects/>'),
        Regions: encoder.encode('<Regions/>'),
        t3HeightMap: heightGrid(),
        'Base.SC2Data/GameData/UnitData.xml': encoder.encode('<Catalog><CUnit id="Probe2"><LifeMax value="20"/></CUnit></Catalog>'),
        'enUS.SC2Data/LocalizedData/GameStrings.txt': encoder.encode('Unit/Name/Probe2=Second Probe'),
      },
      { revision },
    )
    const asked: string[] = []
    const catalog = {
      async entities(refs: readonly { namespace: string; entityId: string }[]) {
        asked.push(...refs.map(ref => `${ref.namespace}/${ref.entityId}`))
        return refs
          .filter(ref => ref.namespace === 'Unit' && ref.entityId === 'SCV')
          .map(ref => ({ ...ref, typeId: 'CUnit', fields: { LifeMax: 45 }, sources: [], inheritanceChain: [] }))
      },
    }
    const session = await (await createMapCodec({ catalog } as never)).open(input, 'full', budget)
    try {
      const selector = (await session.dataSource('common.view/subject-selector-source', 1)).value as any
      const units = await selector.subjects({ limit: 10, kind: 'Unit' })
      expect(units.items.map((item: any) => item.label)).toEqual(['Second Probe'])
      const scv = await selector.openFacts('modkit-subject://blizzard%2Fsc2-data/Unit/SCV')
      const stats = (await scv.value.facts('stats', { limit: 10 })).items
      expect(stats).toContainEqual(expect.objectContaining({ id: 'life', value: 45 }))
      expect(asked).toContain('Unit/SCV')
      await scv.release()
    } finally {
      await session.dispose()
    }
  })

  it('previews and edits a map through namespace entries only', async () => {
    const input = createNamespaceInput({
      MapInfo: encoder.encode('<MapInfo/>'),
      Objects: encoder.encode('<PlacedObjects/>'),
      Regions: encoder.encode('<Regions/>'),
      t3HeightMap: heightGrid(),
    }, { revision })
    const session = await (await createMapCodec()).open(input, 'full', budget)
    try {
      const descriptor = await session.descriptor()
      expect(descriptor.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'view.thumbnail' }),
          expect.objectContaining({ id: 'blizzard/sc2-map.edit-world', mutatesSource: true }),
          expect.objectContaining({ id: 'export.raw' }),
        ]),
      )
      const preview = await session.operations().invoke('thumbnail', { layer: 'height' })
      expect(preview.state).toBe('ok')
      if (preview.state !== 'ok' || preview.output.kind !== 'bytes') {
        throw new Error('map namespace preview did not return bytes')
      }
      expect([...preview.output.value.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10,
      ])

      const edited = await session.operations().invoke('edit-world', {
        expectedSourceRevision: revision,
        edits: [{ kind: 'terrain.cell.set', x: 1, y: 0, heightBase: 444 }],
      })
      expect(edited.state).toBe('ok')
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') {
        throw new Error('map namespace edit did not return an edit plan')
      }
      expect(edited.output.plan.edits).toHaveLength(1)
      expect(edited.output.plan.edits[0]).not.toHaveProperty('range')
      const target = edited.output.plan.targets[0]
      expect(target.ownerSource.uri).toContain('entry=t3HeightMap')
      expect(Object.values(target.expectedRevision.bindings)).toContain(revision)
    } finally {
      await session.dispose()
    }
  })

  it('opens and extracts known replay streams from the namespace', async () => {
    const details = encoder.encode('details-payload')
    const input = createNamespaceInput({
      'replay.details': details,
      'replay.initData': encoder.encode('init-payload'),
      'replay.game.events': encoder.encode('events-payload'),
    }, { revision, uri: 'memory://packed.SC2Replay' })
    const session = await (await createReplayCodec()).open(input, 'full', budget)
    try {
      const inspected = await session.operations().invoke('inspect', {})
      expect(inspected.state).toBe('ok')
      if (inspected.state !== 'ok' || inspected.output.kind !== 'json') {
        throw new Error('replay namespace inspect did not return JSON')
      }
      expect(inspected.output.value).toMatchObject({
        format: 'sc2-replay',
        entries: 3,
        knownStreams: 3,
        streamNames: ['replay.details', 'replay.game.events', 'replay.initData'],
      })
      const extracted = await session.operations().invoke('extract-entry', {
        entryId: 'replay.details',
      })
      expect(extracted.state).toBe('ok')
      if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
        throw new Error('replay namespace extract did not return bytes')
      }
      expect(decoder.decode(extracted.output.value)).toBe('details-payload')
    } finally {
      await session.dispose()
    }
  })
})
