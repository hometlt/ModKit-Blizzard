import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TableDataSource, TreeDataSource } from '@modkit/sdk'
import { createSubjectEditing } from '@modkit/host'
import { createFileEditingBackend, createModkit } from '@modkit/host/node'
import { authoredMap, authoredScenario, concat, section, strings, u16s, ascii } from './sc1-fixtures.js'
import { openMpqReader } from '@modkit/blizzard-mpq/reader'
import { MAP_LAYERS_OPERATION, MAP_LAYER_READ_OPERATION, MAP_LAYER_WRITE_OPERATION } from '@modkit/sdk/maps'

const extension = join(import.meta.dirname, '..')
const { sc1TextDecoder } = (await import(pathToFileURL(join(extension, 'dist', 'text.js')).href)) as typeof import('../dist/text.js')
const { eraOfPrefix, readScenario, readSections, writeScenarioTiles } = (await import(
  pathToFileURL(join(extension, 'dist', 'chk', 'scenario.js')).href
)) as typeof import('../dist/chk/scenario.js')

describe('StarCraft scenario', () => {
  it('reads the sections the game reads', () => {
    const scenario = readScenario(authoredScenario())
    expect(scenario.diagnostics).toEqual([])
    expect([scenario.version, scenario.tileset, scenario.width, scenario.height]).toEqual([205, 4, 4, 2])
    expect([...scenario.tiles]).toEqual([16, 17, 18, 19, 32, 33, 34, 35])
    expect(scenario.name).toBe('Lantern Isle')
    // A valid UTF-8 string reads as UTF-8, as Remastered reads it.
    expect(scenario.description).toBe('Остров')
    expect(scenario.players.slice(0, 2).map(player => [player.owner, player.race])).toEqual([[6, 1], [5, 0]])
    expect(scenario.units).toEqual([expect.objectContaining({ instance: 7, x: 48, y: 80, unitId: 0, owner: 0, hitPoints: 100 })])
    expect(scenario.locations).toEqual([expect.objectContaining({ index: 0, right: 64, bottom: 32, name: 'Home' })])
    // The era is found from the first bytes alone, before the scenario is opened.
    expect(eraOfPrefix(authoredScenario().subarray(0, 64))).toBe(4)
    expect(eraOfPrefix(authoredScenario().subarray(0, 16))).toBeUndefined()
  })

  it('lets a later section replace an earlier one, keeps a truncated one and follows a jump back', () => {
    const base = authoredScenario()
    const later = concat(base, section('DIM ', u16s(2, 1)), section('MTXM', u16s(5, 6)))
    const scenario = readScenario(later)
    expect([scenario.width, scenario.height, ...scenario.tiles]).toEqual([2, 1, 5, 6])

    // A short last MTXM fills what it has; the game leaves the rest at tile 0.
    expect([...readScenario(concat(base, section('MTXM', u16s(9, 9, 9)))).tiles]).toEqual([9, 9, 9, 0, 0, 0, 0, 0])

    // A section declaring more bytes than the file has keeps the bytes there.
    const truncated = readScenario(concat(base, section('MTXM', u16s(1, 2), 16)))
    expect([...truncated.tiles].slice(0, 3)).toEqual([1, 2, 0])
    expect(truncated.diagnostics.map(item => item.code)).toEqual(['chk/section-truncated'])

    // A negative size moves the reader back: here onto a TYPE section once more, then on.
    const jump = concat(base, section('JUMP', [], -(base.length + 8)))
    const read = readSections(jump)
    expect(read.diagnostics.map(item => item.code)).toEqual(['chk/section-loop'])
    expect(read.sections.at(-1)?.name).toBe('STR ')
  })

  it('reads a string that is not UTF-8 in the code page the user names', () => {
    const scenario = concat(authoredScenario(), section('STR ', strings(Uint8Array.of(0x43, 0x61, 0x66, 0xe9))))
    expect(readScenario(scenario).name).toBe('Café')
    expect(readScenario(scenario, sc1TextDecoder('windows-1251')).name).toBe('Cafй')
  })

  it('writes tiles into MTXM and TILE and keeps every other byte', () => {
    const chk = authoredScenario()
    const tiles = Uint16Array.of(1, 2, 3, 4, 5, 6, 7, 8)
    const written = writeScenarioTiles(chk, tiles)
    expect(written.length).toBe(chk.length)
    const after = readScenario(written)
    expect([...after.tiles]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...after.sections.find(item => item.name === 'TILE')!.bytes]).toEqual([...u16s(1, 2, 3, 4, 5, 6, 7, 8)])
    const changed = [...written].flatMap((byte, index) => (byte === chk[index] ? [] : [index]))
    const mtxm = readSections(chk).sections.filter(item => item.name === 'MTXM' || item.name === 'TILE')
    expect(changed.every(index => mtxm.some(item => index >= item.offset && index < item.offset + item.bytes.length))).toBe(true)

    // Growing a short MTXM moves the sections after it: refused when a jump section depends on them.
    const short = concat(authoredScenario(), section('MTXM', u16s(1)), section('JUMP', [], -8))
    expect(() => writeScenarioTiles(short, tiles)).toThrow(/jump sections/u)
  })

  it('opens a .scm over the MPQ container: tree, players and the tile layer north row first', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-sc1-map-'))
    const path = join(scratch, 'Test.scm')
    await writeFile(path, await authoredMap())
    const host = await createModkit({ extensions: [join(extension, '..', 'mpq'), extension], roots: [scratch] })
    const map = await host.open(path)
    if (map.snapshot.state !== 'opened') throw new Error(`map did not open: ${JSON.stringify(map.snapshot)}`)
    const opened = { ...map.snapshot, session: map.session! }
    try {
      expect(opened.selected.contributionId).toBe('blizzard/starcraft1-map')
      // No installation behind a map in a scratch folder: its tileset is not bound, and it says so.
      expect(opened.descriptor.diagnostics.map(item => [item.code, item.severity])).toEqual([['blizzard/starcraft1-tileset', 'information']])
      const invoke = async (id: string, input: unknown) => {
        const handler = opened.descriptor.operations.find(item => item.id === id)?.handlerId
        const result = await opened.session.operations().invoke(handler!, input as never)
        if (result.state !== 'ok') throw new Error(`${id} failed: ${JSON.stringify(result)}`)
        return (result.output as { value: unknown }).value
      }
      const listed = (await invoke(MAP_LAYERS_OPERATION, {})) as { layers: { id: string; width: number; height: number }[] }
      expect(listed.layers.map(layer => [layer.id, layer.width, layer.height])).toEqual([['tiles', 4, 2]])
      expect(await invoke(MAP_LAYER_READ_OPERATION, { layer: 'tiles', x: 1, y: 1, width: 2, height: 1 })).toMatchObject({ values: [33, 34] })

      const tree = await opened.session.dataSource('common.view/tree-data-source', 1)
      try {
        const source = tree.value as TreeDataSource
        const root = await source.root()
        expect((await source.facts(root)).label).toBe('Lantern Isle')
        const sections = await source.children(root, { limit: 20 })
        const facts = await Promise.all(sections.items.map(item => source.facts(item)))
        expect(facts.map(item => item.label)).toEqual([
          'Information', 'Players', 'Forces', 'Units', 'Doodads and sprites', 'Locations', 'Triggers', 'Mission briefings', 'Sections',
        ])
      } finally {
        await tree.release()
      }
      const table = await opened.session.dataSource('common.view/table-data-source', 1)
      const rows = await (table.value as TableDataSource).rows({ kind: 'range', from: 0, count: 2 }).finally(() => table.release())
      expect(rows.items.map(row => row.cells)).toEqual([
        ['Player 1', 'human', 'Terran', 'Force 1'],
        ['Player 2', 'computer', 'Zerg', 'Force 1'],
      ])
    } finally {
      await map.close()
      await host.close()
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('writes a tile window into the map, keeping every other byte, and undoes it', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-sc1-map-write-'))
    const path = join(scratch, 'Write.scm')
    const original = await authoredMap()
    await writeFile(path, original)
    const scenarioOf = async (bytes: Uint8Array) => {
      const reader = await openMpqReader(bytes, { maxArchiveBytes: 1 << 24, maxEntries: 64, maxEntryBytes: 1 << 20 })
      try {
        return await reader.read(reader.find('staredit/scenario.chk')!.id)
      } finally {
        reader.dispose()
      }
    }
    const before = await scenarioOf(original)
    const m = await createModkit({ extensions: [join(extension, '..', 'mpq'), extension], roots: [scratch], writableRoots: [scratch] })
    // As the Warcraft III map test: the facade does not yet commit a container-alias subject's plan,
    // so the packed plan is committed on the archive opened as itself, citing the declared evidence.
    const archive = await createModkit({ extensions: [join(extension, '..', 'mpq')], roots: [scratch] })
    const opened = await m.open(path)
    const carrier = await archive.open(path)
    try {
      if (opened.snapshot.state !== 'opened' || carrier.snapshot.state !== 'opened') throw new Error('map did not open')
      const descriptor = opened.snapshot.descriptor
      const handler = (id: string) => descriptor.operations.find(item => item.id === id)!.handlerId
      const manifest = JSON.parse(await readFile(join(extension, 'contributions', 'codec-starcraft1-map.json'), 'utf8')) as {
        spec: { fidelityEvidence: readonly [Record<string, unknown> & { claim: { roundTrip: string; preservesUnknownData: boolean } }] }
      }
      const declared = manifest.spec.fidelityEvidence[0]
      const backend = createFileEditingBackend({ roots: [scratch] })
      const editing = createSubjectEditing({
        opened: { descriptor: carrier.snapshot.descriptor } as never,
        grant: { id: 'starcraft1-map-layer-write', classes: ['read-source', 'write-source'] },
        backendFor: () => backend,
        evidenceFor: () => ({
          roundTrip: declared.claim.roundTrip,
          preservesUnknownData: declared.claim.preservesUnknownData,
          evidenceId: declared['evidenceId'],
          corpusId: declared['corpusId'],
          corpusDigest: declared['corpusDigest'],
          conformanceProfile: declared['conformanceProfile'],
          writer: { providerId: 'blizzard/starcraft1-map', providerVersion: '0.1.0', artifactDigest: 'x3:blizzard/starcraft1-map@layer-write-proof', formatId: 'starcraft1-map', representationId: 'map-layers' },
          optionsFingerprint: declared['optionsFingerprint'],
          inputClass: declared['inputClass'],
          provenAt: declared['provenAt'],
        }) as never,
      })
      const written = await opened.session.operations().invoke(handler(MAP_LAYER_WRITE_OPERATION), {
        layer: 'tiles', x: 1, y: 1, width: 2, height: 1, values: [99, 100],
      } as never)
      if (written.state !== 'ok') throw new Error(JSON.stringify(written))
      const plan = editing.planFromOperation(written.output)
      const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      if (prepared.state !== 'ready') throw new Error(JSON.stringify(prepared))
      const committed = await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })
      if (committed.state !== 'committed') throw new Error(JSON.stringify(committed))

      const after = await scenarioOf(new Uint8Array(await readFile(path)))
      // Only the two written tiles of MTXM and of TILE changed: eight bytes.
      const changed = [...after].flatMap((byte, index) => (byte === before[index] ? [] : [index]))
      const at = (name: string) => readSections(before).sections.find(item => item.name === name)!.offset + 2 * 5
      expect(changed).toEqual([at('MTXM'), at('MTXM') + 2, at('TILE'), at('TILE') + 2])
      expect([...readScenario(after).tiles]).toEqual([16, 17, 18, 19, 32, 99, 100, 35])

      const reopened = await m.open(path)
      try {
        if (reopened.snapshot.state !== 'opened') throw new Error('map did not reopen')
        const read = await reopened.session.operations().invoke(
          reopened.snapshot.descriptor.operations.find(item => item.id === MAP_LAYER_READ_OPERATION)!.handlerId,
          { layer: 'tiles' } as never,
        )
        expect(read).toMatchObject({ state: 'ok', output: { value: { values: [16, 17, 18, 19, 32, 99, 100, 35] } } })
      } finally {
        await reopened.close()
      }

      const undone = await editing.coordinator.undo(committed.receipt.transactionId, { grant: editing.grantSnapshot })
      expect(undone.state).toBe('committed')
      expect(new Uint8Array(await readFile(path))).toEqual(original)
    } finally {
      await opened.close()
      await carrier.close()
      await rm(scratch, { recursive: true, force: true })
    }
  })

})
