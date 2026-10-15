import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import { createCandidateWorldSceneLease, createSubjectEditing } from '@modkit/host'
import { createFileEditingBackend, openFileArtifactSource } from '@modkit/host/node'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { readNativeMpqSnapshot } from '@modkit/blizzard-mpq/native-preserving'
import { createCodec as createMpqCodec } from '../../mpq/src/mpq/codec.js'
import {
  analyzeStarcraft2MapWorkspace,
  openStarcraft2Map,
} from '../modules/map/providers/semantic/runtime.js'
import { createCodec } from '../modules/map/codecs/package/src/codec.js'
import { applyStarcraft2MapWorldEdits } from '../modules/map/codecs/package/src/world-writer.js'
import { buildStarcraft2MapWorldArchive } from './support/sc2-map-archive-world-writer.js'
import { createNamespaceInput } from './support/namespace-input.js'

const text = new TextEncoder()
const utf8 = new TextDecoder()
const revision = 'content-hash.sha256:sc2-map-world-writer-fixture'

const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))

function packReplacements(plan: {
  targets: readonly {
    targetId: string
    ownerSource: { uri: string }
    expectedRevision: { bindings: Readonly<Record<string, string>> }
  }[]
  edits: readonly {
    operation: string
    targetId: string
    payload: { kind: string; bytes?: Uint8Array }
  }[]
}) {
  const targets = new Map(plan.targets.map(target => [target.targetId, target]))
  return plan.edits.map(edit => {
    const target = required(targets.get(edit.targetId), `semantic target ${edit.targetId}`)
    if (edit.operation !== 'replace' || edit.payload.kind !== 'inline' || edit.payload.bytes === undefined) {
      throw new TypeError('semantic map plan must contain full-file inline replacements')
    }
    const entryId = new URL(target.ownerSource.uri).searchParams.get('entry')
    if (entryId === null) throw new TypeError('semantic map target has no namespace entry id')
    const expectedRevision = Object.values(target.expectedRevision.bindings)[0]
    if (expectedRevision === undefined) throw new TypeError('semantic map target has no revision')
    return { entryId, expectedRevision, bytesBase64: base64(edit.payload.bytes) }
  })
}
const installedMap =
  process.env.MODKITX_SC2_MAP_CORPUS?.trim() ||
  'C:\\Apps\\StarCraft II\\Maps\\uedfl\\UEDFL_EP01M22_Deliverance.SC2Map'
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 8_388_608,
  maxDiagnostics: 1_000,
}
const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('SC2 map codec has no service dependency')
    },
    async resolveUnknown() {
      throw new Error('SC2 map codec has no foreign service dependency')
    },
  },
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is unavailable`)
  return value
}

function hmap() {
  const bytes = new Uint8Array(32 + 4 * 6 + 3)
  bytes.set(text.encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  for (let index = 0; index < 4; index += 1) {
    view.setUint16(32 + index * 6, 100 + index, true)
    view.setUint16(34 + index * 6, 10 + index, true)
    view.setUint16(36 + index * 6, 1, true)
  }
  bytes.set([0xaa, 0xbb, 0xcc], bytes.byteLength - 3)
  return bytes
}

function pathing() {
  const bytes = new Uint8Array(32 + 4 * 2 + 2)
  bytes.set(text.encode('PATH'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 1, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  for (let index = 0; index < 4; index += 1) view.setUint16(32 + index * 2, index, true)
  bytes.set([0xdd, 0xee], bytes.byteLength - 2)
  return bytes
}

const objects = text.encode(`<?xml version="1.0" encoding="utf-8"?>
<PlacedObjects Version="26" UnknownRoot="keep">
    <!-- unknown comment remains -->
    <ObjectUnit Id="1" Variation="0" Position="1,2,3" Scale="1,1,1" UnitType="Marine" Player="1" Custom="keep"><Texture TexSlot="0" TexProps="" TexLink="MarineDiffuse" Unknown="keep"/></ObjectUnit>
    <ObjectDoodad Id="2" Variation="0" Position="4,5,6" Scale="1,1,1" Type="Rock"/>
</PlacedObjects>
`)
const regions = text.encode(`<?xml version="1.0" encoding="utf-8"?>
<Regions>
    <region id="1"><name value="Alpha"/><unknown value="keep"/><shape type="circle"><center value="1,2"/><radius value="3"/></shape></region>
    <region id="2"><name value="Remove"/><shape type="rect"><min value="0,0"/><max value="1,1"/></shape></region>
</Regions>
`)
const preload = text.encode(
  '<?xml version="1.0"?><Preload><Unit id="Marine" UserTag="keep"/><Model id="MarineModel"/></Preload>',
)
const unknown = new Uint8Array([9, 8, 7, 6, 5])

function documents() {
  return [
    { path: 'Objects', bytes: objects },
    { path: 'Regions', bytes: regions },
    { path: 't3HeightMap', bytes: hmap() },
    { path: 't3SyncPathingInfo', bytes: pathing() },
    { path: 'Preload', bytes: preload },
  ]
}

const edits = [
  { kind: 'object.update', objectId: 1, patch: { position: [10, 20, 30], player: 2 } },
  { kind: 'object.remove', objectId: 2 },
  {
    kind: 'object.add',
    object: {
      kind: 'point',
      objectId: 3,
      position: { x: 7, y: 8, z: 9 },
      scale: [1, 1, 1],
      typeId: 'Normal',
      name: 'Spawn',
    },
  },
  {
    kind: 'region.update',
    regionId: 1,
    patch: {
      name: 'Bravo',
      shapes: [{ type: 'rect', parameters: { min: '1,1', max: '9,9' } }],
    },
  },
  { kind: 'region.remove', regionId: 2 },
  {
    kind: 'region.add',
    region: {
      regionId: 3,
      name: 'Charlie',
      color: '255,0,0',
      shapes: [{ type: 'circle', parameters: { center: '4,5', radius: '6' } }],
    },
  },
  { kind: 'terrain.cell.set', x: 1, y: 0, heightBase: 777, heightAdjustment: 33, mask: 9 },
  { kind: 'pathing.cell.set', x: 0, y: 1, flags: 0x1234 },
  { kind: 'reference.rename', namespace: 'Unit', from: 'Marine', to: 'Marauder' },
] as const

function inputFor(bytes: Uint8Array) {
  const uri = 'memory://sc2/WorldWriter.SC2Map'
  const source = {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  const binding = {
    sourceKind: 'candidate' as const,
    bindingId: 'content',
    role: 'content',
    ownership: 'owned' as const,
    source: source.ref,
    revision,
  }
  return {
    originKind: 'single' as const,
    bindings: [binding],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: 'sc2-map-world-writer-fixture',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

function inputForSource(source: Awaited<ReturnType<typeof openFileArtifactSource>>) {
  const binding = {
    sourceKind: 'candidate' as const,
    bindingId: 'content',
    role: 'content',
    ownership: 'owned' as const,
    source: source.ref,
    revision: source.revision,
  }
  return {
    originKind: 'single' as const,
    bindings: [binding],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision: source.revision,
      bindings: [{ bindingId: 'content', revision: source.revision }],
      compositionFingerprint: 'sc2-map-world-writer-file',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

function analyzerRequest(nativeDocuments: readonly { path: string; bytes: Uint8Array }[]) {
  return {
    schemaVersion: 1,
    workspaceId: 'writer-proof',
    gameId: 'blizzard/starcraft-2',
    mapId: 'WorldWriter.SC2Map',
    documents: nativeDocuments,
    maxDocuments: 16,
    maxDocumentBytes: 8_388_608,
    maxTotalBytes: 16_777_216,
    maxObjects: 100,
    maxRegions: 100,
    maxTerrainCells: 1_024,
    maxTerrainSamples: 1_024,
    maxDepth: 64,
  }
}

async function inspectWorldDocuments(
  nativeDocuments: readonly { path: string; bytes: Uint8Array }[],
  snapshotId: string,
) {
  const resolved = await analyzeStarcraft2MapWorkspace({
    ...analyzerRequest(nativeDocuments),
    snapshotId,
    unresolvedRequirementIds: [],
    requiredRequirementIds: [],
    maxDiagnostics: 100,
  })
  const lease = createCandidateWorldSceneLease(resolved, [], 1_024)
  try {
    // Every item of every advertised layer, paged the way any world consumer reads the source.
    const source = lease.value
    const catalog = await source.page({ facet: 'layers', limit: 16 })
    const layers = []
    for (const layer of catalog.items) {
      if (layer.facet !== 'layers') throw new TypeError('world layers page holds a non-layer item')
      const items = []
      // The exact level of detail when the layer offers it, as a viewer reading a small map would.
      const lod = layer.lods.includes('exact') ? 'exact' : layer.lods[0]
      let cursor: string | undefined
      do {
        const page = await source.page({
          facet: layer.kind,
          layerId: layer.layerId,
          ...(lod === undefined ? {} : { lod }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: 1_024,
        } as never)
        items.push(...page.items)
        cursor = page.nextCursor
      } while (cursor !== undefined && items.length < 1_024)
      layers.push({ layer, page: { items } })
    }
    return { layers }
  } finally {
    await lease.release()
  }
}

describe('Product GA SC2 semantic map/world writer', () => {
  it('edits terrain/pathing, add/update/remove objects and regions, and reference links', async () => {
    const result = await applyStarcraft2MapWorldEdits({
      sourceRevision: revision,
      expectedSourceRevision: revision,
      documents: documents(),
      edits,
    })
    expect(result.editsApplied).toBe(edits.length)
    expect(result.referencePatches).toBe(2)
    expect(result.replacements.map(item => item.path)).toEqual([
      'Objects',
      'Preload',
      'Regions',
      't3HeightMap',
      't3SyncPathingInfo',
    ])
    const byPath = new Map(result.replacements.map(item => [item.path, item.bytes]))
    const nextObjects = utf8.decode(byPath.get('Objects'))
    expect(nextObjects).toContain('UnknownRoot="keep"')
    expect(nextObjects).toContain('Custom="keep"')
    expect(nextObjects).toContain('Unknown="keep"')
    expect(nextObjects).toContain('UnitType="Marauder"')
    expect(nextObjects).toContain('Position="10,20,30"')
    expect(nextObjects).not.toContain('Id="2"')
    expect(nextObjects).toContain('Id="3"')
    expect(utf8.decode(byPath.get('Preload'))).toContain('Unit id="Marauder" UserTag="keep"')
    expect(utf8.decode(byPath.get('Regions'))).toContain('<unknown value="keep"/>')
    expect(utf8.decode(byPath.get('Regions'))).toContain('name value="Bravo"')
    expect(utf8.decode(byPath.get('Regions'))).toContain('region id="3"')
    const heightBytes = required(byPath.get('t3HeightMap'), 'edited t3HeightMap')
    const pathingBytes = required(byPath.get('t3SyncPathingInfo'), 'edited t3SyncPathingInfo')
    expect(
      new DataView(heightBytes.buffer, heightBytes.byteOffset, heightBytes.byteLength).getUint16(
        38,
        true,
      ),
    ).toBe(777)
    expect(
      new DataView(pathingBytes.buffer, pathingBytes.byteOffset, pathingBytes.byteLength).getUint16(
        36,
        true,
      ),
    ).toBe(0x1234)
    expect(result.provenance.legacyReferenceRevision).toBe(
      '1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
    )
    expect(result.namedRemainder).toContain(
      'map bounds and resize because MapInfo is not in the proven semantic decoder',
    )
  })

  it('preserves a validated semantic no-op as an empty replacement set', async () => {
    const result = await applyStarcraft2MapWorldEdits({
      sourceRevision: revision,
      expectedSourceRevision: revision,
      documents: documents(),
      edits: [
        {
          kind: 'reference.rename',
          namespace: 'Unit',
          from: '__MISSING_UNIT__',
          to: '__STILL_MISSING__',
        },
      ],
    })
    expect(result).toMatchObject({
      editsApplied: 1,
      referencePatches: 0,
      replacements: [],
    })
    expect(result.fidelity.losses).toContain(
      'reference.rename Unit/__MISSING_UNIT__ was a no-op',
    )
  })

  it('deterministically rebuilds only a complete named archive and reopens semantic equality', async () => {
    const archive = encodeFreshMpq([...documents(), { path: 'Opaque/Keep.bin', bytes: unknown }])
    const options = {
      sourceBytes: archive,
      sourceRevision: revision,
      expectedSourceRevision: revision,
      archiveMode: 'deterministic-rebuild' as const,
      edits,
    }
    const first = await buildStarcraft2MapWorldArchive(options)
    const second = await buildStarcraft2MapWorldArchive(options)
    expect([...first.bytes]).toEqual([...second.bytes])
    expect(first.archiveReceipt).toMatchObject({
      kind: 'sc2-map-deterministic-rebuild-receipt-v1',
      unknownEntryPayloads: 'preserved-byte-identical',
    })
    const reopened = await readNativeMpqSnapshot({ sourceBytes: first.bytes })
    const byPath = new Map(reopened.entries.map(item => [item.path, item.bytes]))
    expect([...required(byPath.get('Opaque/Keep.bin'), 'opaque rebuilt entry')]).toEqual([
      ...unknown,
    ])
    const semantic = await openStarcraft2Map(
      analyzerRequest(
        reopened.entries.filter(item =>
          ['objects', 'regions', 't3heightmap', 't3syncpathinginfo'].includes(
            item.path.toLowerCase(),
          ),
        ),
      ),
    )
    expect(semantic.objects.map(item => item.objectId)).toEqual([1, 3])
    expect(semantic.objects[0]).toMatchObject({
      kind: 'unit',
      typeId: 'Marauder',
      player: 2,
      position: { x: 10, y: 20, z: 30 },
    })
    expect(semantic.regions.map(item => item.regionId)).toEqual([1, 3])
    expect(semantic.regions[0]).toMatchObject({ name: 'Bravo' })
    expect(semantic.terrain?.samples[1]).toMatchObject({
      x: 1,
      y: 0,
      heightBase: 777,
      heightAdjustment: 33,
      mask: 9,
    })
  })

  it('uses the native fixed-slot MPQ writer for an in-place semantic save', async () => {
    const archive = encodeFreshMpq([...documents(), { path: 'Opaque/Keep.bin', bytes: unknown }])
    const source = await readNativeMpqSnapshot({ sourceBytes: archive })
    const result = await buildStarcraft2MapWorldArchive({
      sourceBytes: archive,
      sourceRevision: revision,
      expectedSourceRevision: revision,
      expectedSourceArchiveDigest: source.sourceArchiveDigest,
      archiveMode: 'native-preserving',
      edits: [{ kind: 'terrain.cell.set', x: 0, y: 0, heightBase: 555 }],
    })
    expect(result.archiveReceipt).toMatchObject({
      kind: 'mpq-native-export-receipt-v1',
      strategy: 'whole-archive-save-as-fixed-slots',
      unchanged: { guarantee: 'raw-payload-flags-and-method-byte-identical' },
    })
    expect(result.bytes.byteLength).toBe(archive.byteLength)
    const reopened = await readNativeMpqSnapshot({ sourceBytes: result.bytes })
    expect([
      ...required(
        reopened.entries.find(item => item.path === 'Opaque/Keep.bin'),
        'opaque native entry',
      ).bytes,
    ]).toEqual([...unknown])
    const reopenedTerrain = required(
      reopened.entries.find(item => item.path === 't3HeightMap'),
      'native t3HeightMap',
    )
    expect(
      new DataView(
        reopenedTerrain.bytes.buffer,
        reopenedTerrain.bytes.byteOffset,
        reopenedTerrain.bytes.byteLength,
      ).getUint16(32, true),
    ).toBe(555)
    await expect(
      buildStarcraft2MapWorldArchive({
        sourceBytes: archive,
        sourceRevision: revision,
        expectedSourceRevision: revision,
        expectedSourceArchiveDigest: 'sha256:stale',
        archiveMode: 'native-preserving',
        edits: [{ kind: 'terrain.cell.set', x: 0, y: 0, heightBase: 555 }],
      }),
    ).rejects.toThrow(/stale/u)
  })

  it('exposes a normal host edit-plan operation and reopens the resulting archive', async () => {
    const sourceEntries = [...documents(), { path: 'Opaque/Keep.bin', bytes: unknown }]
    const archive = encodeFreshMpq(sourceEntries)
    const session = await (
      await createCodec(context)
    ).open(
      createNamespaceInput(Object.fromEntries(sourceEntries.map(item => [item.path, item.bytes])), {
        revision,
      }) as never,
      'full',
      budget,
    )
    const container = await (await createMpqCodec()).open(inputFor(archive), 'full', budget)
    try {
      const descriptor = await session.descriptor()
      expect(descriptor.constraints.readOnly).toBe(false)
      expect(descriptor.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'blizzard/sc2-map.edit-world',
            handlerId: 'edit-world',
            mutatesSource: true,
          }),
        ]),
      )
      const edited = await session.operations().invoke('edit-world', {
        expectedSourceRevision: revision,
        archiveMode: 'deterministic-rebuild',
        edits: [{ kind: 'terrain.cell.set', x: 1, y: 0, heightBase: 444 }],
      })
      expect(edited.state).toBe('ok')
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') {
        throw new Error('edit.world did not return an edit plan')
      }
      expect(edited.output.plan.edits.every(edit => edit.operation === 'replace' && edit.range === undefined)).toBe(true)
      const packed = await container.operations().invoke('pack-container', {
        schemaVersion: 1,
        expectedContainerRevision: revision,
        replacements: packReplacements(edited.output.plan as never),
        intent: {
          operation: 'blizzard/sc2-map.edit-world',
          input: { archiveMode: 'deterministic-rebuild' },
          semanticPlanId: edited.output.plan.planId,
        },
      })
      expect(packed.state).toBe('ok')
      if (packed.state !== 'ok' || packed.output.kind !== 'edit-plan') {
        throw new Error('container.pack did not return an outer edit plan')
      }
      const edit = packed.output.plan.edits[0]
      if (edit.operation !== 'replace' || edit.payload.kind !== 'inline') {
        throw new Error('container.pack outer plan did not contain bytes')
      }
      const reopened = await readNativeMpqSnapshot({ sourceBytes: edit.payload.bytes })
      const terrain = required(
        reopened.entries.find(item => item.path === 't3HeightMap'),
        'operation t3HeightMap',
      )
      expect(
        new DataView(
          terrain.bytes.buffer,
          terrain.bytes.byteOffset,
          terrain.bytes.byteLength,
        ).getUint16(38, true),
      ).toBe(444)
      expect(edited.output.plan.fidelity).toMatchObject({
        roundTrip: 'semantic',
        preservesUnknownData: true,
      })
      expect(Object.keys(edited.output.plan.fidelity).sort()).toEqual([
        'notes',
        'preservesUnknownData',
        'roundTrip',
      ])
    } finally {
      await container.dispose()
      await session.dispose()
    }
  })

  it('commits the codec edit plan atomically through the ordinary host editor and reopens it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'x3-sc2-map-world-'))
    const path = join(directory, 'Atomic.SC2Map')
    const archive = encodeFreshMpq([...documents(), { path: 'Opaque/Keep.bin', bytes: unknown }])
    writeFileSync(path, archive)
    const backend = createFileEditingBackend({ roots: [directory] })
    let session
    let containerSession
    try {
      const source = await openFileArtifactSource(path)
      const containerInput = inputForSource(source)
      session = await (
        await createCodec(context)
      ).open(
        createNamespaceInput(
          Object.fromEntries(
            [...documents(), { path: 'Opaque/Keep.bin', bytes: unknown }].map(item => [
              item.path,
              item.bytes,
            ]),
          ),
          { revision: String(source.revision) },
        ) as never,
        'full',
        budget,
      )
      const semanticEdit = await session.operations().invoke('edit-world', {
        expectedSourceRevision: String(source.revision),
        archiveMode: 'deterministic-rebuild',
        edits: [
          { kind: 'object.update', objectId: 1, patch: { position: [9, 8, 7] } },
          { kind: 'terrain.cell.set', x: 0, y: 1, heightBase: 999 },
        ],
      })
      expect(semanticEdit.state).toBe('ok')
      if (semanticEdit.state !== 'ok' || semanticEdit.output.kind !== 'edit-plan') {
        throw new Error('edit.world did not return an entry edit plan')
      }
      containerSession = await (await createMpqCodec()).open(containerInput, 'full', budget)
      const descriptor = await containerSession.descriptor()
      const invoked = await containerSession.operations().invoke('pack-container', {
        schemaVersion: 1,
        expectedContainerRevision: String(source.revision),
        replacements: packReplacements(semanticEdit.output.plan as never),
        intent: {
          operation: 'blizzard/sc2-map.edit-world',
          input: { archiveMode: 'deterministic-rebuild' },
          semanticPlanId: semanticEdit.output.plan.planId,
        },
      })
      expect(invoked.state).toBe('ok')
      if (invoked.state !== 'ok' || invoked.output.kind !== 'edit-plan') {
        throw new Error('container.pack did not return an outer edit plan')
      }
      const editing = createSubjectEditing({
        opened: { descriptor } as never,
        grant: { id: 'sc2-map-world-write', classes: ['read-source', 'write-source'] },
        backendFor: () => backend,
        evidenceFor: () => ({
          roundTrip: 'semantic',
          preservesUnknownData: true,
          evidenceId: 'sc2-map-world-writer-v1',
          corpusId: 'modkit-blizzard/starcraft2/test/sc2-map-world-writer',
          corpusDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
          conformanceProfile: 'modkit/codec-contribution-v1' as never,
          writer: {
            providerId: 'blizzard/sc2-map',
            providerVersion: '1.0.0',
            artifactDigest: 'x3:blizzard/sc2-map@product-ga-proof',
            formatId: 'sc2-map',
            representationId: 'archive-namespace',
          },
          optionsFingerprint: 'semantic-world-deterministic-rebuild-v1',
          inputClass: 'complete-named-mpq-v0-map',
          provenAt: '2026-08-29T00:00:00Z',
        }),
      })
      const plan = editing.planFromOperation(invoked.output)
      const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      expect(prepared.state).toBe('ready')
      if (prepared.state !== 'ready') return
      const committed = await editing.coordinator.commit(prepared.prepared, {
        grant: editing.grantSnapshot,
      })
      expect(committed.state).toBe('committed')
      if (committed.state !== 'committed') return
      expect(committed.receipt).toMatchObject({
        mutationMode: 'mutate',
        commitGuarantee: 'atomic',
      })
      await session.dispose()
      session = undefined
      await containerSession.dispose()
      containerSession = undefined

      const after = new Uint8Array(readFileSync(path))
      const reopened = await readNativeMpqSnapshot({ sourceBytes: after })
      const semantic = await openStarcraft2Map(
        analyzerRequest(
          reopened.entries.filter(item =>
            ['objects', 'regions', 't3heightmap'].includes(item.path.toLowerCase()),
          ),
        ),
      )
      expect(semantic.objects[0]).toMatchObject({ position: { x: 9, y: 8, z: 7 } })
      expect(semantic.terrain?.samples[2]).toMatchObject({ x: 0, y: 1, heightBase: 999 })
      const world = await inspectWorldDocuments(
        reopened.entries.filter(item =>
          ['objects', 'regions', 't3heightmap'].includes(item.path.toLowerCase()),
        ),
        'committed-world-snapshot',
      )
      expect(
        world.layers
          .flatMap(layer => layer.page.items)
          .find(item => item.facet === 'objects' && item.objectId === 1),
      ).toMatchObject({ position: { x: 9, y: 8, z: 7 } })
      expect(
        world.layers
          .flatMap(layer => layer.page.items)
          .find(item => item.facet === 'terrain' && item.x === 0 && item.y === 1),
      ).toMatchObject({ heightBase: 999 })
      expect([
        ...required(
          reopened.entries.find(item => item.path === 'Opaque/Keep.bin'),
          'host opaque entry',
        ).bytes,
      ]).toEqual([...unknown])

      const stale = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      expect(stale.state).toBe('conflict')

      const undone = await editing.coordinator.undo(committed.receipt.transactionId, {
        grant: editing.grantSnapshot,
      })
      expect(undone.state).toBe('committed')
      expect(new Uint8Array(readFileSync(path))).toEqual(archive)

      const redone = await editing.coordinator.redo(committed.receipt.transactionId, {
        grant: editing.grantSnapshot,
      })
      expect(redone.state).toBe('committed')
      const redoneSnapshot = await readNativeMpqSnapshot({
        sourceBytes: new Uint8Array(readFileSync(path)),
      })
      const redoneSemantic = await openStarcraft2Map(
        analyzerRequest(
          redoneSnapshot.entries.filter(item =>
            ['objects', 'regions', 't3heightmap'].includes(item.path.toLowerCase()),
          ),
        ),
      )
      expect(redoneSemantic.objects[0]).toMatchObject({ position: { x: 9, y: 8, z: 7 } })
      expect(redoneSemantic.terrain?.samples[2]).toMatchObject({
        x: 0,
        y: 1,
        heightBase: 999,
      })
      const redoneWorld = await inspectWorldDocuments(
        redoneSnapshot.entries.filter(item =>
          ['objects', 'regions', 't3heightmap'].includes(item.path.toLowerCase()),
        ),
        'redone-world-snapshot',
      )
      expect(
        redoneWorld.layers
          .flatMap(layer => layer.page.items)
          .find(item => item.facet === 'objects' && item.objectId === 1),
      ).toMatchObject({ position: { x: 9, y: 8, z: 7 } })
    } finally {
      await session?.dispose()
      await containerSession?.dispose()
      await backend.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!existsSync(installedMap))(
    'edits and reopens a writable copy of an installed SC2Map without touching the installation',
    async () => {
      const before = statSync(installedMap)
      const sourceBytes = new Uint8Array(readFileSync(installedMap))
      const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
      const snapshot = await readNativeMpqSnapshot({
        sourceBytes,
        includeBasenames: ['t3heightmap', 'mapheightmap'],
        maxArchiveBytes: 268_435_456,
        maxBlocks: 100_000,
        maxEntries: 8,
        maxEntryBytes: 67_108_864,
        maxTotalBytes: 67_108_864,
      })
      const terrain = snapshot.entries.find(item =>
        ['t3heightmap', 'mapheightmap'].includes(item.path.toLowerCase()),
      )
      expect(terrain).toBeDefined()
      if (terrain === undefined) return
      const terrainView = new DataView(
        terrain.bytes.buffer,
        terrain.bytes.byteOffset,
        terrain.bytes.byteLength,
      )
      const originalHeight = terrainView.getUint16(32, true)
      const nextHeight = originalHeight === 0 ? 1 : originalHeight - 1
      const output = await buildStarcraft2MapWorldArchive({
        sourceBytes,
        sourceRevision: snapshot.sourceArchiveDigest,
        expectedSourceRevision: snapshot.sourceArchiveDigest,
        expectedSourceArchiveDigest: snapshot.sourceArchiveDigest,
        archiveMode: 'native-preserving',
        edits: [{ kind: 'terrain.cell.set', x: 0, y: 0, heightBase: nextHeight }],
        maxArchiveBytes: 268_435_456,
        maxBlocks: 100_000,
        maxDocumentBytes: 67_108_864,
        maxTotalBytes: 67_108_864,
      })
      const scratch = mkdtempSync(join(tmpdir(), 'x3-sc2-installed-map-copy-'))
      try {
        const copy = join(scratch, 'InstalledProof.SC2Map')
        writeFileSync(copy, output.bytes)
        const reopened = await readNativeMpqSnapshot({
          sourceBytes: new Uint8Array(readFileSync(copy)),
          includeBasenames: ['t3heightmap', 'mapheightmap'],
          maxArchiveBytes: 268_435_456,
          maxBlocks: 100_000,
          maxEntries: 8,
          maxEntryBytes: 67_108_864,
          maxTotalBytes: 67_108_864,
        })
        const reopenedTerrain = reopened.entries.find(item => item.path === terrain.path)
        expect(reopenedTerrain).toBeDefined()
        if (reopenedTerrain !== undefined) {
          expect(
            new DataView(
              reopenedTerrain.bytes.buffer,
              reopenedTerrain.bytes.byteOffset,
              reopenedTerrain.bytes.byteLength,
            ).getUint16(32, true),
          ).toBe(nextHeight)
        }
        expect(output.archiveReceipt).toMatchObject({
          sourceArchiveDigest: snapshot.sourceArchiveDigest,
          unchanged: { guarantee: 'raw-payload-flags-and-method-byte-identical' },
        })
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
      const after = statSync(installedMap)
      expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({
        size: before.size,
        mtimeMs: before.mtimeMs,
      })
      expect(createHash('sha256').update(readFileSync(installedMap)).digest('hex')).toBe(sourceHash)
    },
    120_000,
  )

  it('refuses stale revisions, traversal paths, cancellation and unsafe rebuild evidence', async () => {
    await expect(
      applyStarcraft2MapWorldEdits({
        sourceRevision: revision,
        expectedSourceRevision: 'stale',
        documents: documents(),
        edits: [{ kind: 'terrain.cell.set', x: 0, y: 0, heightBase: 1 }],
      }),
    ).rejects.toThrow(/stale/u)
    await expect(
      applyStarcraft2MapWorldEdits({
        sourceRevision: revision,
        expectedSourceRevision: revision,
        documents: [{ path: '../Objects', bytes: objects }],
        edits: [{ kind: 'object.remove', objectId: 1 }],
      }),
    ).rejects.toThrow(/portable/u)
    await expect(
      applyStarcraft2MapWorldEdits({
        sourceRevision: revision,
        expectedSourceRevision: revision,
        documents: [
          { path: 'Objects', bytes: objects },
          { path: 'Base.SC2Data/Objects', bytes: objects },
        ],
        edits: [{ kind: 'object.remove', objectId: 1 }],
      }),
    ).rejects.toThrow(/ambiguous/u)
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      applyStarcraft2MapWorldEdits({
        sourceRevision: revision,
        expectedSourceRevision: revision,
        documents: documents(),
        edits: [{ kind: 'object.remove', objectId: 1 }],
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps the mutating codec manifest schema-valid', async () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '..', 'modules', 'map', 'codecs', 'package', 'codec.json'),
        'utf8',
      ),
    )
    const validation = await validateContributionManifest(
      manifest,
      createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
    )
    expect(validation.specState, JSON.stringify(validation.diagnostics)).toBe('validated')
    expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })
})
