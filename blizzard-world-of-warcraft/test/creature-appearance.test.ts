import { describe, expect, it } from 'vitest'
import { resolveCreatureAppearance, WowAppearanceError, type WowDataContext, type WowTypedTable } from '../src/appearance/creature.js'
import { animPayload, readM2, readSkin } from '../src/m2/reader.js'
import { buildM2Scene, m2Projection } from '../src/m2/scene.js'
import { fixtureBundle, fixtureMaterialBundle, TEXTURE_FILE_ID } from './m2-fixtures.js'
import { materializeUvmCore } from '@modkit/uv/model/materializer'
import { readUvmContainer } from '@modkit/uv/model/container'
import { revisionId } from '@modkit/sdk'
import { animationSnapshotBudget } from '@modkit/codec-kit/model/animation'

const context: WowDataContext = { sourceId: 'local:wow', product: 'wow', build: '12.1.0.69933', buildRevision: 'fixture-build', locale: 2 }
function table(name: string, values: Readonly<Record<number, Record<string, number | readonly number[]>>>): WowTypedTable {
  return { table: name, context, revision: `fixture-${name}`, layoutHash: 0x123456ab,
    decoded: { rows: new Map(Object.entries(values).map(([id, row]) => [Number(id), { id: Number(id), section: 0, values: row }])), unavailable: [] } }
}
const display = table('CreatureDisplayInfo', {
  101: { ModelID: 7, CreatureModelScale: 0.5, TextureVariationFileDataID: [1001, 1002, 0], CreatureGeosetData: 0 },
  102: { ModelID: 7, CreatureModelScale: 0.75, TextureVariationFileDataID: [1003, 0, 1004], ParticleColorID: 9 },
})
const model = table('CreatureModelData', { 7: { FileDataID: 123288, ModelScale: 1.2 } })
describe('WoW native creature appearance', () => {
  it('binds an explicitly resolved native slot to material layers and UVM resource closure', () => {
    const bundle = fixtureBundle()
    const original = readM2(bundle.model, { maxRecords: 1000 })
    const native = { ...original, textures: original.textures.map((texture, index) =>
      index === 1 ? { ...texture, type: 11 } : texture) }
    const skin = readSkin(bundle.skin, 1000)
    const appearanceA = resolveCreatureAppearance(context, 101, display, model)
    const appearanceB = resolveCreatureAppearance(context, 102, display, model)
    const a = buildM2Scene(native, skin, appearanceA)
    const b = buildM2Scene(native, skin, appearanceB)
    expect(a.materials[0]!.layers?.[1]?.resourceId).toBe('filedataid/1001')
    expect(b.materials[0]!.layers?.[1]?.resourceId).toBe('filedataid/1003')
    expect(a.textures.map(texture => texture.id)).toEqual([`filedataid/${String(TEXTURE_FILE_ID)}`, 'filedataid/1001'])
    expect(m2Projection(b).resourceClosure?.entries).toEqual([
      { role: 'texture', logicalId: `filedataid/${String(TEXTURE_FILE_ID)}` }, { role: 'texture', logicalId: 'filedataid/1003' },
    ])
    expect(a.notes.some(note => note.startsWith('texture-appearance:'))).toBe(false)
    expect(buildM2Scene(native, skin).notes.some(note => note.startsWith('texture-appearance:'))).toBe(true)
    expect(b.primitives).toEqual(a.primitives)
    expect(b.nodes).toEqual(a.nodes)
    expect(native.textures[1]!.type).toBe(11)
    expect(original.textures[1]!.type).toBe(1)
    const shaderBundle = fixtureMaterialBundle()
    const shaderNative = readM2(shaderBundle.model, { maxRecords: 1000,
      animBuffers: new Map([[1, animPayload(shaderBundle.anim, 1000)!]]) })
    const shaderScene = buildM2Scene({ ...shaderNative, textures: shaderNative.textures.map((texture, index) =>
      index === 0 ? { ...texture, type: 11 } : texture) }, readSkin(shaderBundle.skin, 1000), appearanceB)
    expect(shaderScene.materials[0]!.shader).toMatchObject({ id: 'modkit.render-material.v1',
      parameters: { renderModel: { standard: { layers: {
        decal: { texturePath: 'filedataid/1003' }, alpha1: { texturePath: 'filedataid/1003' },
      } } } } })
    for (const replacements of [new Map([[0, 'filedataid/1001']]), new Map([[11, 'filedataid/4294967296']]),
      new Map([[11, 'filedataid/0']]), new Map([[11, 'wrong-source']])])
      expect(() => buildM2Scene(native, skin, { replaceableTextures: replacements })).toThrow(/native/iu)
  })

  it('resolves two explicit displays of one model with different textures and field provenance', () => {
    const a = resolveCreatureAppearance(context, 101, display, model)
    const b = resolveCreatureAppearance(context, 102, display, model)
    expect(a.modelFileDataId).toBe(123288)
    expect(b.modelFileDataId).toBe(a.modelFileDataId)
    expect(a.displayScale).toBe(0.5)
    expect(a.modelScale).toBe(1.2)
    expect([...a.replaceableTextures]).toEqual([[11, 'filedataid/1001'], [12, 'filedataid/1002']])
    expect([...b.replaceableTextures]).toEqual([[11, 'filedataid/1003'], [13, 'filedataid/1004']])
    expect(a.provenance).toContainEqual(expect.objectContaining({ table: 'CreatureModelData', rowId: 7, field: 'FileDataID', value: 123288, revision: 'fixture-CreatureModelData' }))
    expect(b.unresolved).toEqual([{ field: 'CreatureDisplayInfo.ParticleColorID', value: 9, reason: 'particle-colour-table' }])
  })
  it('retains each selected texture in actual UVM image and material records', () => {
    const bundle = fixtureMaterialBundle()
    const original = readM2(bundle.model, { maxRecords: 1000,
      animBuffers: new Map([[1, animPayload(bundle.anim, 1000)!]]) })
    const native = { ...original, textures: original.textures.map((texture, index) =>
      index === 0 ? { ...texture, type: 11 } : texture) }
    for (const [displayId, textureId] of [[101, 1001], [102, 1003]] as const) {
      const selected = resolveCreatureAppearance(context, displayId, display, model)
      const scene = buildM2Scene(native, readSkin(bundle.skin, 1000), { replaceableTextures: selected.replaceableTextures })
      const exported = materializeUvmCore(m2Projection(scene), {
        scope: { scopeId: 'model-interchange-v1', version: '1.0.0' }, profile: 'UVM/core@1.0',
        subjectRevision: revisionId('content-hash.sha256:appearance-fixture'),
        options: { assetId: 'appearance-fixture', sourceFormat: 'wow-m2',
          units: { metersPerSourceUnit: 0.9144, sourceUnit: 'wow-yard' } },
      }, { materialBudget: { maxBytes: 10_000_000, maxNodes: 100_000, maxDepth: 64 },
        animationBudget: animationSnapshotBudget(scene.clips) })
      const { document } = readUvmContainer(exported.bytes)
      const decoded = document as unknown as {
        images: { uri: string }[];
        materials: { extensions: { UV_game_material: { params: { renderModel: { standard: {
          layers: { decal: { texturePath: string }; alpha1: { texturePath: string } };
        } } } } } }[];
        meshes: unknown[]; animations: unknown[];
      }
      expect(decoded.images).toHaveLength(1)
      expect(decoded.images[0]!.uri).toContain(`filedataid/${String(textureId)}`)
      const layers = decoded.materials[0]!.extensions.UV_game_material.params.renderModel.standard.layers
      expect(layers.decal.texturePath).toBe(`filedataid/${String(textureId)}`)
      expect(layers.alpha1.texturePath).toBe(`filedataid/${String(textureId)}`)
      expect(decoded.meshes).toHaveLength(1)
      expect(decoded.animations).toHaveLength(2)
    }
  })

  it('refuses context mismatches, missing foreign keys and malformed texture arrays', () => {
    expect(() => resolveCreatureAppearance({ ...context, product: 'wow_classic' }, 101, display, model)).toThrow(/context/u)
    expect(() => resolveCreatureAppearance(context, 101, display, table('CreatureModelData', {}))).toThrow(/missing/u)
    expect(() => resolveCreatureAppearance(context, 101, table('CreatureDisplayInfo', {
      101: { ModelID: 7, CreatureModelScale: 1, TextureVariationFileDataID: [1001] },
    }), model)).toThrow(/three/u)
    const unavailable = { ...display, decoded: { rows: new Map(), unavailable: [{ section: 1, reason: 'encrypted' as const, ids: [101] }] } }
    try { resolveCreatureAppearance(context, 101, unavailable, model); throw new Error('expected refusal') }
    catch (error) { expect(error).toBeInstanceOf(WowAppearanceError); expect((error as WowAppearanceError).reason).toBe('encrypted-row') }
  })
})
