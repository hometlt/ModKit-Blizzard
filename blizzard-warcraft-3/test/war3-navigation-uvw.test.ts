import { expect, it } from 'vitest'
import { createCandidateWorldSceneLease } from '@modkit/host'
import { materializeWorldToUvw, serializeUvwProfile } from '@modkit/uv/world'
import { openMpqReader } from '@modkit/blizzard-mpq/reader'
import { authoredMapDocuments } from './war3-fixtures.js'
import { analyzeWar3MapWorkspace } from '../src/war3-map-world/world.js'
import { encodeWar3Map } from '../src/war3-map/encoder.js'
import { WAR3_PATHING_FLAG_ENCODING } from '../src/war3-map/map.js'
import { convertUvwToStarcraft2Map } from '../../starcraft2/modules/map/codecs/package/src/uvw-map-converter.js'
import type { UvwProfileDocument } from '@modkit/uv/world'

async function analyze(maxSamples = 1000, trailing = false) {
  const documents = authoredMapDocuments().map(document => !trailing || document.path !== 'war3map.wpm' ? document
    : { ...document, bytes: Uint8Array.from([...document.bytes, 255]) })
  return { documents, snapshot: await analyzeWar3MapWorkspace({
    workspaceId: 'native-navigation', gameId: 'blizzard/warcraft-3', mapId: 'fixture', documents,
    maxDocuments: 32, maxDocumentBytes: 1 << 20, maxTotalBytes: 1 << 22, maxObjects: 100,
    maxRegions: 10, maxTerrainCells: 1000, maxTerrainSamples: maxSamples, maxDepth: 16,
    snapshotId: 'navigation-roundtrip', unresolvedRequirementIds: [], requiredRequirementIds: [], maxDiagnostics: 100,
  }) }
}

it('round-trips complete Warcraft III WPM bytes through the common native world and UVW owners', async () => {
  const { documents, snapshot } = await analyze()
  expect(snapshot.navigation).toMatchObject({ exact: true, flagEncoding: WAR3_PATHING_FLAG_ENCODING })
  const lease = createCandidateWorldSceneLease(snapshot, [], 64)
  try {
    const result = await materializeWorldToUvw(lease.value, { maxPageItems: 64, maxTerrainItems: 32, maxFacetItems: 256, maxOutputBytes: 1 << 20 })
    if (result.state !== 'materialized') throw new Error(JSON.stringify(result.refusals))
    const navigation = result.document.spaces[0]!.layers.find(layer => layer.kind === 'navigation')
    expect(navigation).toMatchObject({ columns: 8, rows: 4, cellSize: 32, flagEncoding: WAR3_PATHING_FLAG_ENCODING,
      samples: [Array(8).fill(3), Array(8).fill(2), Array(8).fill(1), Array(8).fill(0)] })
    const encoded = encodeWar3Map(result.bytes)
    const archive = await openMpqReader(encoded.bytes, { maxArchiveBytes: 1 << 24, maxEntries: 64, maxEntryBytes: 1 << 20 })
    try {
      const entry = archive.find('war3map.wpm')
      if (entry === undefined) throw new Error('native WPM not written')
      expect(await archive.read(entry.id)).toEqual(documents.find(document => document.path === 'war3map.wpm')!.bytes)
    } finally { archive.dispose() }
    expect(encoded.diagnostics.some(diagnostic => /pathing|navigation/.test(diagnostic.message))).toBe(false)
    const wrongVocabulary = { ...result.document, spaces: result.document.spaces.map(space => ({ ...space,
      layers: space.layers.map(layer => layer.kind === 'navigation' ? { ...layer, flagEncoding: 'other/navigation@1' } : layer),
    })) }
    expect(() => encodeWar3Map(serializeUvwProfile(wrongVocabulary))).toThrow(/foreign or unknown/)
    const tooWide = { ...result.document, spaces: result.document.spaces.map(space => ({ ...space,
      layers: space.layers.map(layer => layer.kind === 'navigation' ? { ...layer, samples: layer.samples.map(row => row.map(() => 256)) } : layer),
    })) }
    expect(() => encodeWar3Map(serializeUvwProfile(tooWide))).toThrow(/uint8/)
  } finally { await lease.release() }
})

it('does not call bounded samples or unretained WPM trailing bytes exact navigation', async () => {
  expect((await analyze(4)).snapshot.navigation?.exact).toBe(false)
  const trailing = (await analyze(1000, true)).snapshot.navigation
  expect(trailing).toMatchObject({ exact: false, trailingBytes: 1 })
})

it('SC2 refuses a foreign vocabulary even when the numeric flags and grid fit its writer', async () => {
  const document: UvwProfileDocument = { uv: { format: 'UVW', version: '1.0', status: 'profile' }, connections: [],
    spaces: [{ id: 'main', topology: 'heightfield',
      basis: { handedness: 'right', upAxis: 'y', forwardAxis: '+z', unit: 'source-unit', sourceUnit: 'sc2-game-unit', unitsPerCell: 1 },
      bounds: { min: [0, 0, 0], max: [1, 0, 1] }, layers: [
        { id: 'ground', kind: 'heightfield', columns: 2, rows: 2, cellSize: 1, origin: [0, 0, 0], samples: [[0, 0], [0, 0]] },
        { id: 'materials', kind: 'terrain-materials', schemaVersion: 1, columns: 2, rows: 2, cellSize: 1, origin: [0, 0, 0],
          materials: [{ id: 'soil', sourceIndex: 0, label: 'BelShirDirt' }],
          samples: Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => ({ weights: [{ materialId: 'soil', weight: 1 }] }))) },
        { id: 'navigation', kind: 'navigation', schemaVersion: 1, columns: 2, rows: 2, cellSize: 1, origin: [0, 0, 0],
          flagEncoding: WAR3_PATHING_FLAG_ENCODING, samples: [[0, 1], [2, 3]] },
      ] }],
  }
  const refused = await convertUvwToStarcraft2Map(document, { maxOutputBytes: 1 << 20 })
  expect(refused.state).toBe('refused')
  expect(refused.refusalCodes).toContain('navigation-flag-encoding-unrepresentable')
  const native = { ...document, spaces: document.spaces.map(space => ({ ...space,
    layers: space.layers.map(layer => layer.kind === 'navigation' ? { ...layer, flagEncoding: 'blizzard/sc2-sync-pathing@1' } : layer),
  })) }
  const accepted = await convertUvwToStarcraft2Map(native, { maxOutputBytes: 1 << 20 })
  expect(accepted.state, JSON.stringify(accepted.refusals)).toBe('converted')
  const unscoped = { ...native, spaces: native.spaces.map(space => ({ ...space,
    layers: space.layers.map(layer => {
      if (layer.kind !== 'navigation') return layer
      const { flagEncoding: _encoding, ...unknown } = layer
      return unknown
    }),
  })) }
  expect((await convertUvwToStarcraft2Map(unscoped, { maxOutputBytes: 1 << 20 })).state).toBe('converted')
  const crossGame = { ...unscoped, spaces: unscoped.spaces.map(space => ({ ...space,
    basis: { ...space.basis, sourceUnit: 'other-world-unit' },
  })) }
  const unknown = await convertUvwToStarcraft2Map(crossGame, { maxOutputBytes: 1 << 20,
    coordinateMapping: { sourceUnit: 'other-world-unit', targetUnit: 'sc2-game-unit', scale: 1 },
    materialMappings: { soil: { sourceIndex: 0, label: 'BelShirDirt' } },
  })
  expect(unknown.refusalCodes).toContain('navigation-flag-encoding-unrepresentable')
})
