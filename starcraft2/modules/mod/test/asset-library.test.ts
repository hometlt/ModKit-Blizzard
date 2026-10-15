import { describe, expect, it } from 'vitest'
import { planSc2AssetLibraryImport, sc2TerrainTextureId, SC2_ASSET_LIBRARY_INDEX, type Sc2AssetLibraryImport } from '../shared/asset-library.js'
import { parseVersionFile } from '../codecs/document-metadata/core/version-file.js'
import { parseComponentListEntries } from '../codecs/document-metadata/core/component-list.js'

const asset = { kind: 'texture' as const, extension: 'dds' as const, sourceKey: 'portable:ground', bytes: new Uint8Array([1, 2, 3, 4]) }
const request = (): Sc2AssetLibraryImport => ({ sourceGameId: 'publisher/game', libraryName: 'GameAssets', dependencies: ['Liberty.SC2Mod'], assets: [asset],
  definitions: [{ namespace: 'TerrainTex', id: 'Imported', entity: { Texture: 'Assets/Example.dds' } }] })
const apply = (files: ReadonlyMap<string, Uint8Array>, plan: Awaited<ReturnType<typeof planSc2AssetLibraryImport>>) => new Map([...files, ...plan.files.map(file => [file.path, file.bytes] as const)])

describe('accumulating source-game SC2 asset library', () => {
  it('initializes and repairs missing component versions only with an explicit target profile', async () => {
    const versionProfile = { buildNumber: 98310, majorVersion: 5, minorVersion: 0, patchVersion: 17 }
    const first = await planSc2AssetLibraryImport(new Map(), { ...request(), versionProfile })
    const files = apply(new Map(), first)
    expect(parseVersionFile(files.get('GameData.version')!)?.typeTag).toBe('adag')
    expect(parseVersionFile(files.get('DocumentInfo.version')!)?.typeTag).toBe('ofni')
    expect((await planSc2AssetLibraryImport(files, { ...request(), versionProfile })).files).toEqual([])
    files.delete('DocumentInfo.version')
    const repair = await planSc2AssetLibraryImport(files, { ...request(), versionProfile })
    expect(repair.files.map(file => file.path)).toEqual(['DocumentInfo.version'])
    expect(files.has('DocumentInfo.version')).toBe(false)
  })

  it('opts road templates into compact paths without relocating legacy records', async () => {
    const road = { ...asset, kind: 'road-model' as const, extension: 'm3' as const }
    const first = await planSc2AssetLibraryImport(new Map(), { ...request(), assets: [road] })
    const oldFiles = apply(new Map(), first), oldIndex = JSON.parse(new TextDecoder().decode(oldFiles.get(SC2_ASSET_LIBRARY_INDEX)))
    const compact = { ...road, pathProfile: 'compact-road' as const }
    const plan = await planSc2AssetLibraryImport(oldFiles, { ...request(), assets: [compact] })
    expect(plan.bindings[0]!.path).toMatch(/^Assets\/R[a-f0-9]{16}\.m3$/)
    expect(plan.bindings[0]!.hash).toBe(first.bindings[0]!.hash)
    const files = apply(oldFiles, plan), index = JSON.parse(new TextDecoder().decode(files.get(SC2_ASSET_LIBRARY_INDEX)))
    expect(index.assets['road-model:' + first.bindings[0]!.hash]).toEqual(oldIndex.assets['road-model:' + first.bindings[0]!.hash])
    expect(plan.files.some(f => f.path === first.bindings[0]!.path)).toBe(false)
    expect((await planSc2AssetLibraryImport(files, { ...request(), assets: [road, compact] })).files).toEqual([])
    expect(road).not.toHaveProperty('pathProfile')
    const aliases = await planSc2AssetLibraryImport(files, { ...request(), assets: [{ ...compact, sourceKey: 'portable:next-map' }] })
    expect(aliases.bindings[0]!.sourceKeys).toEqual(['portable:ground', 'portable:next-map'])
    expect(aliases.files.filter(f => f.path.startsWith('Assets/'))).toEqual([])
    const collision = new Map(oldFiles); collision.set(plan.bindings[0]!.path, new Uint8Array([99]))
    await expect(planSc2AssetLibraryImport(collision, { ...request(), assets: [compact] })).rejects.toThrow(/collision/)
    files.set(plan.bindings[0]!.path, new Uint8Array([99]))
    await expect(planSc2AssetLibraryImport(files, { ...request(), assets: [compact] })).rejects.toThrow(/bytes changed/)
    await expect(planSc2AssetLibraryImport(new Map(), { ...request(), assets: [{ ...asset, pathProfile: 'compact-road' }] })).rejects.toThrow(/road-model/)
    await expect(planSc2AssetLibraryImport(new Map(), { ...request(), assets: [{ ...road, pathProfile: 'invalid' as never }] })).rejects.toThrow(/profile/)
  })
  it('uses a compact deterministic terrain identity and rejects malformed digests', () => {
    const hash = 'b6d71cf4d424b9325eb22fe356e172cc208d14839dbe6548cb0e538a048f4d9f'
    expect(sc2TerrainTextureId(hash)).toBe('T_b6d71cf4d424b9325eb22fe3')
    expect(() => sc2TerrainTextureId('../invalid')).toThrow(/SHA256/)
  })
  it('creates one components library and reuses identical imports on the next map', async () => {
    const first = await planSc2AssetLibraryImport(new Map(), request()), files = apply(new Map(), first)
    expect(first.dependency).toBe('file:Mods\\GameAssets.SC2Mod')
    expect(parseComponentListEntries(new TextDecoder().decode(files.get('ComponentList.SC2Components'))).map(c => c.type)).toEqual(['gada', 'info'])
    expect(new TextDecoder().decode(files.get('DocumentInfo'))).toContain('Liberty.SC2Mod')
    expect(first.bindings[0]!.path).toMatch(/^Assets\/Modkit\/texture\/[a-f0-9]{64}\.dds$/)
    expect((await planSc2AssetLibraryImport(files, request())).files).toEqual([])
    expect(files.has(SC2_ASSET_LIBRARY_INDEX)).toBe(true)
  })

  it('deduplicates content while retaining aliases and existing foreign data', async () => {
    const initial = await planSc2AssetLibraryImport(new Map(), { ...request(), assets: [asset, { ...asset, sourceKey: 'portable:another-map' }] })
    expect(initial.files.filter(f => f.path.startsWith('Assets/'))).toHaveLength(1)
    expect(initial.bindings[1]!.sourceKeys).toEqual(['portable:another-map', 'portable:ground'])
    const files = apply(new Map(), initial), catalog = initial.files.find(f => f.path.toLowerCase().endsWith('terraintexdata.xml'))!
    const text = new TextDecoder().decode(catalog.bytes).replace('</Catalog>', '<CTerrainTex id="UserTexture"><Texture value="User.dds"/></CTerrainTex><!--keep--></Catalog>')
    files.set(catalog.path, new TextEncoder().encode(text)); files.set('User.bin', new Uint8Array([9]))
    const added = await planSc2AssetLibraryImport(files, { ...request(), assets: [{ ...asset, bytes: new Uint8Array([5]) }], definitions: [{ namespace: 'TerrainTex', id: 'Another', entity: { Texture: 'Another.dds' } }] })
    expect(new TextDecoder().decode(added.files.find(f => f.path === catalog.path)!.bytes)).toContain('<CTerrainTex id="UserTexture"><Texture value="User.dds"/></CTerrainTex><!--keep-->')
    expect(added.files.some(f => f.path === 'User.bin')).toBe(false)
    expect(JSON.parse(new TextDecoder().decode(added.files.find(f => f.path === SC2_ASSET_LIBRARY_INDEX)!.bytes)).assets).toHaveProperty(initial.bindings[0]!.kind + ':' + initial.bindings[0]!.hash)
  })

  it('refuses foreign games, collisions, tampered media and budgets', async () => {
    const plan = await planSc2AssetLibraryImport(new Map(), request()), files = apply(new Map(), plan)
    await expect(planSc2AssetLibraryImport(files, { ...request(), sourceGameId: 'publisher/other' })).rejects.toThrow(/identity/)
    await expect(planSc2AssetLibraryImport(files, { ...request(), definitions: [{ namespace: 'TerrainTex', id: 'Imported', entity: { Texture: 'changed.dds' } }] })).rejects.toThrow(/conflicts/)
    files.set(plan.bindings[0]!.path, new Uint8Array([99]))
    await expect(planSc2AssetLibraryImport(files, request())).rejects.toThrow(/bytes changed/)
    await expect(planSc2AssetLibraryImport(new Map(), { ...request(), maxBytes: 2 })).rejects.toThrow(/budget/)
    await expect(planSc2AssetLibraryImport(new Map(), { ...request(), libraryName: '../Escape' })).rejects.toThrow(/library name/)
  })
})
