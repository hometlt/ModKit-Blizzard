import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCodec as createCustomAiCodec } from '../modules/map/codecs/documents/custom-ai/src/codec.js'
import { createCodec as createMapInfoCodec } from '../modules/map/codecs/documents/map-info/src/codec.js'
import { createCodec as createPreloadCodec } from '../modules/map/codecs/documents/preload/src/codec.js'
import { createCodec as createPreloadAssetDbCodec } from '../modules/map/codecs/documents/preload-asset-db/src/codec.js'
import { createCodec as createRegionsCodec } from '../modules/map/codecs/documents/regions/src/codec.js'
import { createCodec as createTerrainXmlCodec } from '../modules/map/codecs/documents/terrain-xml/src/codec.js'
import { createCodec as createSyncHeightCodec } from '../modules/map/codecs/documents/sync-height-map/src/codec.js'
import { createCodec as createCliffLevelCodec } from '../modules/map/codecs/documents/cliff-level/src/codec.js'
import { createCodec as createCellFlagsCodec } from '../modules/map/codecs/documents/cell-flags/src/codec.js'
import { createCodec as createTextureInfoCodec } from '../modules/map/codecs/documents/texture-info/src/codec.js'
import { createCodec as createTextureMasksCodec } from '../modules/map/codecs/documents/texture-masks/src/codec.js'
import { createCodec as createWaterCodec } from '../modules/map/codecs/documents/water/src/codec.js'
import { createCodec as createFluffDoodadCodec } from '../modules/map/codecs/documents/fluff-doodad/src/codec.js'
import { createCodec as createHardTileCodec } from '../modules/map/codecs/documents/hard-tile/src/codec.js'
import { createCodec as createVertexColorCodec } from '../modules/map/codecs/documents/vertex-color/src/codec.js'
import { createCodec as createAttributesCodec } from '../modules/map/codecs/documents/attributes/src/codec.js'
import { createCodec as createPaintedPathingCodec } from '../modules/map/codecs/documents/painted-pathing/src/codec.js'
import { createCodec as createPaintedCreepCodec } from '../modules/map/codecs/documents/painted-creep/src/codec.js'

const budget = { maxInputBytes: 1_073_741_824n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 104_857_600, maxDiagnostics: 1_000 }
const corpusIt = process.env.MODKIT_TEST_INSTALLED_CORPUS === '1' ? it : it.skip
const paintedCreepPath = process.env.MODKIT_SC2_PAINTED_CREEP_PATH
const paintedCreepIt = process.env.MODKIT_TEST_INSTALLED_CORPUS === '1' && paintedCreepPath ? it : it.skip
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function input(bytes: Uint8Array, name: string) {
  const revision = `content-hash.sha256:installed-${name}`
  const ref = { id: name, uri: `file:///C:/Apps/StarCraft%20II/Maps/all-races-coop-maps/02-CradleOfDeath.SC2Map/${name}` }
  const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }
  return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } }
}

describe('SC2 standalone map document installed corpus', () => {
  corpusIt('opens real documents through their individual codecs and exports exact authored bytes', async () => {
    const root = 'C:/Apps/StarCraft II/Maps/all-races-coop-maps/02-CradleOfDeath.SC2Map'
    const cases = [
      ['CustomAI', createCustomAiCodec],
      ['MapInfo', createMapInfoCodec],
      ['Preload.xml', createPreloadCodec],
      ['PreloadAssetDB.txt', createPreloadAssetDbCodec],
      ['Regions', createRegionsCodec],
      ['t3Terrain.xml', createTerrainXmlCodec],
      ['t3SyncHeightMap', createSyncHeightCodec],
      ['t3SyncCliffLevel', createCliffLevelCodec],
      ['t3CellFlags', createCellFlagsCodec],
      ['t3SyncTextureInfo', createTextureInfoCodec],
      ['t3TextureMasks', createTextureMasksCodec],
      ['t3Water', createWaterCodec],
      ['t3FluffDoodad', createFluffDoodadCodec],
      ['t3HardTile', createHardTileCodec],
      ['t3VertCol', createVertexColorCodec],
    ] as const
    for (const [name, factory] of cases) {
      const bytes = new Uint8Array(readFileSync(`${root}/${name}`))
      const session = await factory().open(input(bytes, name) as never, 'full', budget)
      try {
        const inspected = await session.operations().invoke('inspect', {})
        expect(inspected.state, name).toBe('ok')
        const raw = await session.operations().invoke('export-raw', {})
        expect(raw.state, name).toBe('ok')
        const output = raw.state === 'ok' && raw.output.kind === 'bytes' ? raw.output.value : undefined
        expect(output?.byteLength, name).toBe(bytes.byteLength)
        expect(output === undefined ? undefined : sha256(output), name).toBe(sha256(bytes))
      } finally { await session.dispose() }
    }
  })

  corpusIt('opens and exports a real Attributes document', async () => {
    const path = 'C:/Apps/StarCraft II/Maps/all-races-coop-maps/03-DeadOfNight.SC2Map/Attributes'
    const bytes = new Uint8Array(readFileSync(path)); const session = await createAttributesCodec().open(input(bytes, 'Attributes') as never, 'full', budget)
    try { const inspected = await session.operations().invoke('inspect', {}); expect(inspected).toMatchObject({ state: 'ok', output: { kind: 'json', value: { rootTag: 'Attributes' } } }); const raw = await session.operations().invoke('export-raw', {}); const output = raw.state === 'ok' && raw.output.kind === 'bytes' ? raw.output.value : undefined; expect(output === undefined ? undefined : sha256(output)).toBe(sha256(bytes)) } finally { await session.dispose() }
  })

  corpusIt('opens and inspects a real PaintedPathingLayer', async () => {
    const path = 'C:/Apps/StarCraft II/Maps/traynor01.SC2Map/PaintedPathingLayer'; const bytes = new Uint8Array(readFileSync(path)); const session = await createPaintedPathingCodec().open(input(bytes, 'PaintedPathingLayer') as never, 'full', budget)
    try { expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { structured: true, width: 512, height: 512 } } }); const cell = await session.operations().invoke('inspect-cell', { x: 0, y: 0 }); expect(cell).toMatchObject({ state: 'ok', output: { kind: 'json' } }); const raw = await session.operations().invoke('export-raw', {}); const output = raw.state === 'ok' && raw.output.kind === 'bytes' ? raw.output.value : undefined; expect(output === undefined ? undefined : sha256(output)).toBe(sha256(bytes)) } finally { await session.dispose() }
  })

  corpusIt('opens all real MapInfo role variants with one binary codec', async () => {
    const root = 'C:/FILES/SC2Files/Mods/Alevice-StarBattle/Maps/SBC/sb-main.SC2Map'
    const hashes = new Map<string, string>()
    for (const name of ['MapInfo', 'MapInfo_ls', 'MapInfo_nols']) {
      const bytes = new Uint8Array(readFileSync(`${root}/${name}`)); hashes.set(name, sha256(bytes))
      const session = await createMapInfoCodec().open(input(bytes, name) as never, 'full', budget)
      try { expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { version: 39, width: 184, height: 184 } } }); const raw = await session.operations().invoke('export-raw', {}); const output = raw.state === 'ok' && raw.output.kind === 'bytes' ? raw.output.value : undefined; expect(output === undefined ? undefined : sha256(output)).toBe(sha256(bytes)) } finally { await session.dispose() }
    }
    expect(hashes.get('MapInfo_nols')).toBe(hashes.get('MapInfo'))
    expect(hashes.get('MapInfo_ls')).not.toBe(hashes.get('MapInfo'))
  })

  paintedCreepIt('opens a CASC-extracted real PaintedCreepLayer without assigning channel semantics', async () => {
    const bytes = new Uint8Array(readFileSync(paintedCreepPath!)); const session = await createPaintedCreepCodec().open(input(bytes, 'PaintedCreepLayer') as never, 'full', budget)
    try { expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { structured: true, width: 512, height: 512, semantics: 'raw-paint-channels' } } }); const cell = await session.operations().invoke('inspect-cell', { x: 0, y: 0 }); expect(cell).toMatchObject({ state: 'ok', output: { kind: 'json', value: { semantics: 'raw-paint-channels' } } }); const raw = await session.operations().invoke('export-raw', {}); const output = raw.state === 'ok' && raw.output.kind === 'bytes' ? raw.output.value : undefined; expect(output === undefined ? undefined : sha256(output)).toBe(sha256(bytes)) } finally { await session.dispose() }
  })
})
