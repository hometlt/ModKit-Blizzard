import { describe, expect, it } from 'vitest'
import { authorTerrainTexturePalette, type TerrainPaletteInput } from '../../shared/format/terrain-texture-authoring.js'
import { readEditorXml } from '../../shared/format/formats/editor-xml.js'

const fixture = (): TerrainPaletteInput => ({
  terrainXml: '<terrain version="115"><heightMap tileSet="Korhal" dim="17 9" scale="1 1 1"><vertData name="t3HeightMap"/><textureSetList num="8"><textureSet i="0" name="Korhal"/></textureSetList><textureList num="64"><texture i="0" name="Korhal6"/></textureList><blockTextureSetList num="2"/><cliffSetList num="1"><cliffSet i="0" name="AgriaCliff0"/></cliffSetList><rampList num="1"><ramp dir="5" hi="3" lo="2"/></rampList></heightMap><unknown keep="yes"/></terrain>',
  terrainDataXml: '<Catalog><CTerrain id="Imported"><Lighting value="UVWGeneratedLight"/><BlendTextures value="Korhal6"/></CTerrain><CTerrain id="Other"/></Catalog>',
  terrainId: 'Imported', textures: [{ id: 'ImportedGround', diffuse: 'Assets/Textures/a&b.dds', normal: 'Assets/Textures/n.dds' }], uvTiling: [1, 1, 0, 0],
})

describe('native terrain texture palette', () => {
  it('keeps each block slot bound to its own set and retains geometry/catalog lighting', () => {
    const input=fixture();input.textures=[{id:'A'},{id:'B'},{id:'C'}]
    input.blockPalettes={sets:[{id:'Imported',textureIds:['A','B']},{id:'Second',textureIds:['A','','C']}],assignments:[1,0]}
    const result=authorTerrainTexturePalette(input),hm=readEditorXml(result.terrainXml,'terrain','test').children[0]!
    const list=hm.children.find(c=>c.name==='textureList')!.children
    expect(list[0]!.attributes.name).toBe('A');expect(list[8]!.attributes.name).toBe('A');expect(list[9]!.attributes.name).toBe('');expect(list[10]!.attributes.name).toBe('C')
    expect(hm.children.find(c=>c.name==='blockTextureSetList')!.children.map(c=>c.attributes.tileSet)).toEqual(['1','0'])
    expect(result.terrainDataXml).toContain('UVWGeneratedLight');expect(result.terrainXml).toContain('ramp dir="5"')
    expect(()=>authorTerrainTexturePalette({...input,blockPalettes:{...input.blockPalettes!,assignments:[2,0]}})).toThrow(/assignment/)
    expect(()=>authorTerrainTexturePalette({...input,blockPalettes:{sets:[{id:'Imported',textureIds:['Missing']}],assignments:[0,0]}})).toThrow(/declared/)
    expect(()=>authorTerrainTexturePalette({...input,blockPalettes:{sets:[{id:'Imported',textureIds:['A','B']},{id:'Second',textureIds:['C','A']}],assignments:[1,0]}})).toThrow(/different channels/)
  })
  it('binds every palette link and registers imported materials in their own catalog', () => {
    const input = fixture(), result = authorTerrainTexturePalette(input)
    const terrain = readEditorXml(result.terrainXml, 'terrain', 'test'), hm = terrain.children[0]!
    expect(hm.attributes).toMatchObject({ tileSet: 'Imported', uvtiling: '1 1 0 0', dim: '17 9', scale: '1 1 1' })
    expect(hm.children.find(c => c.name === 'textureSetList')!.children[0]!.attributes.name).toBe('Imported')
    expect(hm.children.find(c => c.name === 'textureList')!.children.map(c => c.attributes.name)).toEqual(['ImportedGround', ...Array(63).fill('')])
    expect(hm.children.find(c => c.name === 'blockTextureSetList')!.children.map(c => c.attributes)).toEqual([{ i: '0', tileSet: '0' }, { i: '1', tileSet: '0' }])
    const old = readEditorXml(input.terrainXml, 'terrain', 'test').children[0]!
    for (const name of ['vertData', 'cliffSetList', 'rampList']) expect(hm.children.find(c => c.name === name)).toEqual(old.children.find(c => c.name === name))
    expect(terrain.children[1]!.attributes).toEqual({ keep: 'yes' })
    const catalog = readEditorXml(result.terrainDataXml, 'Catalog', 'test')
    expect(catalog.children[0]!.children[0]!.attributes).toEqual({ value: 'UVWGeneratedLight' })
    expect(catalog.children[1]!.attributes.id).toBe('Other')
    expect(catalog.children[0]!.children.filter(c => c.name === 'BlendTextures').map(c => c.attributes)).toEqual(Array.from({length: 8}, (_, i) => ({ index: String(i), value: i === 0 ? 'ImportedGround' : '' })))
    expect(result.terrainDataXml).not.toContain('<CTerrainTex')
    const tex = readEditorXml(result.terrainTexDataXml, 'Catalog', 'test').children[0]!
    expect(tex.name).toBe('CTerrainTex')
    expect(tex.children[0]!.attributes.value).toBe('Assets/Textures/a&b.dds')
    expect(result.terrainTexDataXml).toContain('a&amp;b.dds')
    expect(authorTerrainTexturePalette({ ...input, ...result })).toEqual(result)
  })

  it('uses stock texture IDs in the caller-selected MASK order without redefining them', () => {
    const input = fixture(); input.textures = [{ id: 'AgriaDirt' }, { id: 'AgriaGrassGreen' }, { id: 'AgriaRock' }]
    const result = authorTerrainTexturePalette(input)
    expect(readEditorXml(result.terrainTexDataXml, 'Catalog', 'test').children).toHaveLength(0)
    expect(readEditorXml(result.terrainXml, 'terrain', 'test').children[0]!.children.find(c => c.name === 'textureList')!.children.slice(0, 3).map(c => c.attributes.name)).toEqual(input.textures.map(t => t.id))
  })

  it('refuses ambiguous or unsupported palettes instead of falling back to the old set', () => {
    const base = fixture()
    for (const textures of [[], Array.from({length: 9}, (_, i) => ({id: `T${i}`})), [{id: 'A'}, {id: 'A'}], [{id:'A',normal:'n.dds'}], [{id:'A',diffuse:'a.dds'}], [{id:'bad\0id'}]])
      expect(() => authorTerrainTexturePalette({...base,textures})).toThrow()
    for (const uvTiling of [[NaN,1,0,0], [1,0,0,0], [1,1,Infinity,0]])
      expect(() => authorTerrainTexturePalette({...base,uvTiling: uvTiling as [number,number,number,number]})).toThrow()
    expect(() => authorTerrainTexturePalette({...base,terrainXml:base.terrainXml.replace('17 9','18 9')})).toThrow(/lattice/)
    expect(() => authorTerrainTexturePalette({...base,terrainXml:base.terrainXml.replace('version="115"','version="1"')})).toThrow(/version/)
    expect(() => authorTerrainTexturePalette({...base,terrainDataXml:'<Catalog><CTerrainTex id="bad"/></Catalog>'})).toThrow(/TerrainTexData/)
    const stock = { ...base, textures: [{ id: 'AgriaDirt' }] }
    for (const terrainTexDataXml of ['<Catalog><CTerrainTex id="AgriaDirt"/></Catalog>', '<Catalog><CTerrainTex id="AgriaDirt"/><CTerrainTex id="AgriaDirt"/></Catalog>'])
      expect(() => authorTerrainTexturePalette({ ...stock, terrainTexDataXml })).toThrow(/overridden locally/)
    expect(() => authorTerrainTexturePalette({ ...base, terrainTexDataXml: '<Catalog><CTerrainTex id="ImportedGround"/><CTerrainTex id="ImportedGround"/></Catalog>' })).toThrow(/Duplicate catalog/)
    expect(() => authorTerrainTexturePalette({ ...base, terrainDataXml: '<Catalog><CTerrain id="Imported"/><CTerrain id="Imported"/></Catalog>' })).toThrow(/Duplicate catalog/)
  })
})
