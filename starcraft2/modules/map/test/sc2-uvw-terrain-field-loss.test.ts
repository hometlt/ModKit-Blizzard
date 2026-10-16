import {expect,it} from 'vitest'
import {serializeUvwProfile,type UvwProfileDocument,type UvwHeightfieldLayer,type UvwCliffsLayer} from '@modkit/uv/world'
import {encodeWar3Map} from '../../../../blizzard-warcraft-3/src/war3-map/encoder.js'
import {openMpqReader} from '@modkit/blizzard-mpq/reader'
const input=(height=0,level?:number):UvwProfileDocument=>({uv:{format:'UVW',version:'1.0',status:'profile'},connections:[],spaces:[{
 id:'main',topology:'heightfield',basis:{handedness:'right',upAxis:'y',forwardAxis:'+z',unit:'source-unit',sourceUnit:'warcraft3-world-unit',unitsPerCell:128},
 bounds:{min:[0,Math.min(0,height),0],max:[128,Math.max(0,height),128]},layers:[
 {id:'ground',kind:'heightfield',columns:2,rows:2,cellSize:128,origin:[0,0,0],samples:[[height,height],[height,height]]},
 ...(level===undefined?[]:[{schemaVersion:1 as const,id:'cliffs',kind:'cliffs' as const,columns:2,rows:2,cellSize:128,origin:[0,0,0] as const,levels:[[level,level],[level,level]],authored:[[true,true],[true,true]]}]),
 ]}]})
const changeGround=(document:UvwProfileDocument,fields:Partial<UvwHeightfieldLayer>):UvwProfileDocument=>({...document,spaces:document.spaces.map(space=>({...space,layers:space.layers.map(layer=>layer.kind==='heightfield'?{...layer,...fields}:layer)}))})
const changeCliffs=(document:UvwProfileDocument,fields:Partial<UvwCliffsLayer>):UvwProfileDocument=>({...document,spaces:document.spaces.map(space=>({...space,layers:space.layers.map(layer=>layer.kind==='cliffs'?{...layer,...fields}:layer)}))})

import type {UvwTerrainMaterial,UvwTerrainMaterialSample,UvwTerrainMaterialsLayer} from '@modkit/uv/world'
const materialInput=(sample:UvwTerrainMaterialSample={weights:[{materialId:'tile-ldrt',weight:1}]},materials:readonly UvwTerrainMaterial[]=[{id:'tile-ldrt'}]):UvwProfileDocument=>{
 const document=input(0,2)
 return {...document,spaces:document.spaces.map(space=>({...space,bounds:{min:[0,0,0],max:[256,0,256]},layers:[...space.layers,
  {schemaVersion:1,kind:'terrain-materials',id:'materials',columns:2,rows:2,cellSize:128,origin:[0,0,0],materials,samples:[[sample,sample],[sample,sample]]},
  {schemaVersion:1,kind:'resources',id:'resources',resources:[{id:'albedo',kind:'media',uri:'terrain/albedo.png'}]},
 ]}))}
}
const encode=(d:UvwProfileDocument)=>encodeWar3Map(serializeUvwProfile(d))
const matching=(d:ReturnType<typeof encode>,code:string)=>d.diagnostics.filter(item=>item.code===`blizzard.war3/${code}`)
it('reports dominant-material reduction once with the number of changed samples',()=>{
 const d=encode(materialInput({weights:[{materialId:'tile-ldrt',weight:0.25},{materialId:'tile-lgrs',weight:0.75}]},[{id:'tile-ldrt'},{id:'tile-lgrs'}]))
 expect(matching(d,'map-material-weights-reduced')).toHaveLength(1)
 expect(matching(d,'map-material-weights-reduced')[0]!.message).toContain('4 terrain sample(s)')
})
it('does not report a loss for one native tile of unit weight',()=>{
 const d=encode(materialInput())
 expect(matching(d,'map-material-weights-reduced')).toHaveLength(0)
 expect(matching(d,'map-material-defaulted')).toHaveLength(0)
 expect(matching(d,'map-terrain-field-dropped').some(item=>item.message.includes('materials.tile-ldrt.id'))).toBe(false)
})
it('reports default replacement for a foreign material id',()=>{
 const d=encode(materialInput({weights:[{materialId:'foreign-rock',weight:1}]},[{id:'foreign-rock'}]))
 expect(matching(d,'map-material-defaulted')).toHaveLength(1)
 expect(matching(d,'map-material-defaulted')[0]!.message).toContain('4 terrain sample(s)')
 expect(matching(d,'map-terrain-field-dropped').filter(item=>item.message.includes('foreign-rock.id'))).toHaveLength(1)
})
it('reports native material definition fields that are not written, including zero sourceIndex',()=>{
 const material:UvwTerrainMaterial={id:'tile-ldrt',label:'authored',classification:'rock',sourceIndex:0,atlas:{rows:2},baseColorFactor:[0.1,0.2,0.3,1],baseColorResourceId:'albedo',normalResourceId:'albedo',normalEncoding:'rgb-inverted-y',specularResourceId:'albedo',specularEncoding:'gloss',uvTransform:{offset:[1,0],scale:[1,1],rotation:0}}
 const d=encode(materialInput(undefined,[material]))
 for(const field of Object.keys(material).filter(key=>key!=='id'))
  expect(matching(d,'map-terrain-field-dropped').filter(item=>item.message.includes(`materials.tile-ldrt.${field} `)),field).toHaveLength(1)
})
it('reports ordered layers, corner UV and transform omissions in bounded per-field summaries',()=>{
 const d=encode(materialInput({weights:[{materialId:'tile-ldrt',weight:1}],layers:[{materialId:'tile-ldrt',tile:{column:1,row:0},cornerAlpha:[0,1,1,0]}],uvTransform:{offset:[1,0],scale:[1,1],rotation:0},cornerUv:[[0,0],[1,0],[0,1],[1,1]]},[{id:'tile-ldrt',atlas:{rows:2}}]))
 const losses=matching(d,'map-material-sample-field-dropped')
 expect(losses).toHaveLength(3)
 for(const field of ['layers','uvTransform','cornerUv'])expect(losses.filter(item=>item.message.includes(`samples[].${field} `)&&item.message.startsWith('4 terrain sample(s)'))).toHaveLength(1)
})
const withoutSamples=(layer:UvwTerrainMaterialsLayer):Omit<UvwTerrainMaterialsLayer,'samples'>=>{const {samples,...rest}=layer;return rest}
it('reports a samples-free weight raster instead of implying that its exact weights became native tiles',()=>{
 const source=materialInput(),document={...source,spaces:source.spaces.map(space=>({...space,layers:space.layers.map(layer=>layer.kind==='terrain-materials'?{...withoutSamples(layer),weightRasters:[{resourceId:'albedo',width:2,height:2,materialIds:['tile-ldrt'],encoding:'rgba8-unorm' as const,normalization:'sum' as const}]}:layer)}))}
 const d=encode(document)
 expect(matching(d,'map-terrain-field-dropped').filter(item=>item.message.includes('layers.materials.weightRasters '))).toHaveLength(1)
 expect(matching(d,'map-material-defaulted')[0]!.message).toContain('4 terrain sample(s)')
})
for(const fields of [{cellSize:64},{origin:[128,0,0] as const}])it('refuses a detached material grid rather than using samples from matching array dimensions',()=>{
 const source=materialInput(),document={...source,spaces:source.spaces.map(space=>({...space,layers:space.layers.map(layer=>layer.kind==='terrain-materials'?{...layer,...fields}:layer)}))}
 expect(()=>encode(document)).toThrow(/materials.*same horizontal grid/)
})
it('reports cliff authored and label independently of written levels',()=>{
 const d=encode(changeCliffs(input(0,2),{label:'authored cliffs',authored:[[false,false],[false,false]]}))
 for(const field of ['authored','label'])expect(matching(d,'map-terrain-field-dropped').filter(item=>item.message.includes(`layers.cliffs.${field} `))).toHaveLength(1)
 expect(matching(d,'map-terrain-field-dropped').some(item=>item.message.includes('cliffs.levels '))).toBe(false)
})
it('reports ground annotations without claiming a second terrain layer was dropped',()=>{
 const d=encode(changeGround(input(),{label:'ground label',noDataValue:999,cliffFaces:[]}))
 for(const field of ['label','noDataValue','cliffFaces'])expect(matching(d,'map-terrain-field-dropped').filter(item=>item.message.includes(`layers.ground.${field} `))).toHaveLength(1)
 expect(matching(d,'map-layer-dropped')).toHaveLength(0)
})
it('retains blight material identity in the native flag while reporting missing underlying ground',()=>{
 const d=encode(materialInput({weights:[{materialId:'tile-blight',weight:1}]},[{id:'tile-blight'}]))
 expect(matching(d,'map-terrain-field-dropped').some(item=>item.message.includes('tile-blight.id '))).toBe(false)
 expect(matching(d,'map-blight-ground')).toHaveLength(1)
 expect(matching(d,'map-material-defaulted')).toHaveLength(0)
})

it('writes explicit case-sensitive native tileset mappings without guessing from canonical identifiers',async()=>{
 const document=materialInput({weights:[{materialId:'tile-ldrt',weight:1}]})
 const result=encodeWar3Map(serializeUvwProfile(document),{materialMappings:{'tile-ldrt':'Ldrt'}})
 const archive=await openMpqReader(result.bytes,{maxArchiveBytes:1<<24,maxEntries:64,maxEntryBytes:1<<20})
 try{
  const raw=await archive.read(archive.find('war3map.w3e')!.id)
  expect(new TextDecoder().decode(raw.subarray(17,21))).toBe('Ldrt')
 }finally{archive.dispose()}
 expect(matching(result,'map-material-defaulted')).toHaveLength(0)
})
it('explicit mappings can select the blight flag independently of source material naming',()=>{
 const source=materialInput({weights:[{materialId:'foreign-rock',weight:1}]},[{id:'foreign-rock'}])
 const d=encodeWar3Map(serializeUvwProfile(source),{materialMappings:{'foreign-rock':'blight'}})
 expect(matching(d,'map-blight-ground')).toHaveLength(1)
 expect(matching(d,'map-material-defaulted')).toHaveLength(0)
 expect(matching(d,'map-terrain-field-dropped').some(item=>item.message.includes('foreign-rock.id '))).toBe(false)
})
for(const materialMappings of [null,[],{'invalid ID':'Ldrt'},{'tile-ldrt':'too-long'},{'tile-ldrt':1}])it('refuses malformed explicit native material mappings',()=>{
 expect(()=>encodeWar3Map(serializeUvwProfile(input()),{materialMappings})).toThrow(/materialMappings/)
})
