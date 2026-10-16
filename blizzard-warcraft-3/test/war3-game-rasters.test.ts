import {expect,it} from 'vitest'
import {authoredMapDocuments} from './war3-fixtures.js'
import {readWar3Map,readWar3MapLayer,writeWar3MapLayer,war3MapLayers} from '../src/war3-map/map.js'
import {analyzeWar3MapWorkspace} from '../src/war3-map-world/world.js'
import {createCandidateWorldSceneLease} from '@modkit/host'
import {materializeWorldToUvw,materializeWorldToUvpMap,openUvpMapBundle} from '@modkit/uv/world'
const options={maxPageItems:4,maxTerrainItems:32,maxFacetItems:256,maxOutputBytes:1<<20,packageId:'test/war3-native-fields',packageVersion:'1.0.0',maxTextureBytes:1<<20,maxMediaBytes:1<<20}
const documents=(trailing=false)=>authoredMapDocuments().map(document=>{
 if(document.path!=='war3map.w3e')return document
 const bytes=new Uint8Array(document.bytes.length+(trailing?1:0));bytes.set(document.bytes)
 for(let i=0;i<6;i++){
  const at=45+i*7
  bytes[at+4]=(i%16)|((i%16)<<4)
  bytes[at+5]=((i%8)<<5)|((i*7)%32)
  bytes[at+6]=((i%16)<<4)|(bytes[at+6]!&15)
 }
 if(trailing)bytes[bytes.length-1]=255
 return {...document,bytes}
})
const analyze=async(maxTerrainSamples=1000,trailing=false)=>analyzeWar3MapWorkspace({workspaceId:'native-game-fields',gameId:'blizzard/warcraft-3',mapId:'fixture',documents:documents(trailing),
 maxDocuments:32,maxDocumentBytes:1<<20,maxTotalBytes:1<<22,maxObjects:100,maxRegions:10,maxTerrainCells:1000,maxTerrainSamples,maxDepth:16,snapshotId:'native-game-fields',unresolvedRequirementIds:[],requiredRequirementIds:[],maxDiagnostics:100})
const ids=['ground-texture','ground-variation','cliff-texture','cliff-variation','corner-flags','water']
it('publishes actual authored corner scalars independently of approximate material rendering',async()=>{
 const snapshot=await analyze()
 expect(snapshot.terrainMaterials?.exact).toBe(false)
 expect(snapshot.gameRasters).toHaveLength(6)
 const order=[3,4,5,0,1,2]
 const expected:Record<string,number[]>={'ground-texture':order,'ground-variation':order.map(i=>(i*7)%32),'cliff-texture':order,'cliff-variation':order,'corner-flags':order.map(i=>(i%16)|(i===0?16:0)),'water':order.map(()=>8000)}
 for(const raster of snapshot.gameRasters!){
  const id=raster.descriptor.id
  expect(ids).toContain(id);expect(raster.metadata).toEqual({valueMeaning:`blizzard/war3-w3e-${id}@1`,valueType:id==='water'?'u16':'u8'})
  expect(raster.exact).toBe(true);expect(raster.values.values).toEqual(expected[id]);expect(raster.trailingBytes).toBe(0)
  expect(raster.grid).toEqual({coordinateSpaceId:'map-native',origin:{x:-128,y:64,z:0},columnStep:{x:128,y:0,z:0},rowStep:{x:0,y:-128,z:0}})
 }
 const ground=snapshot.gameRasters!.find(r=>r.descriptor.id==='ground-texture')!
 expect(ground.descriptor.categories).toEqual([{value:0,label:'Ldrt'}])
 expect(ground.values.values).toContain(5) // Undeclared index stays a native number; no invented tileset.
 expect(snapshot.gameRasters!.find(r=>r.descriptor.id==='cliff-texture')!.descriptor.categories).toEqual([{value:0,label:'CLdi'}])
})
it('preserves all six fields and native tileset spellings through Host, UVW, UVP and detached reopen',async()=>{
 const snapshot=await analyze(),lease=createCandidateWorldSceneLease(snapshot,[],4)
 try{
  const packed=await materializeWorldToUvpMap(lease.value,options)
  if(packed.state!=='materialized')throw new Error(JSON.stringify(packed.refusals))
  const fields=packed.document.spaces[0]!.layers.filter(layer=>layer.kind==='game-raster')
  expect(fields).toHaveLength(6)
  for(const raster of snapshot.gameRasters!){
   const field=fields.find(layer=>layer.valueMeaning===raster.metadata.valueMeaning)!
   expect(field.samples.flat()).toEqual(raster.values.values)
   expect(field.columns).toBe(3);expect(field.rows).toBe(2);expect(field.cellSize).toBe(128);expect(field.origin).toEqual([-128,0,-64])
   expect(field.categories).toEqual(raster.descriptor.categories)
  }
  const opened=await openUvpMapBundle(new Map([...packed.entries].map(([path,bytes])=>[path,bytes.slice()])),{snapshotId:'detached-war3-fields'})
  const again=await materializeWorldToUvw(opened.source,options)
  if(again.state!=='materialized')throw new Error(JSON.stringify(again.refusals))
  expect(again.document).toEqual(packed.document)
  const repacked=await materializeWorldToUvpMap(opened.source,options)
  if(repacked.state!=='materialized')throw new Error(JSON.stringify(repacked.refusals))
  expect(repacked.entries).toEqual(packed.entries)
 }finally{await lease.release()}
})
it('keeps bounded source windows partial without filling missing corners',async()=>{
 const snapshot=await analyze(4)
 expect(snapshot.gameRasters).toHaveLength(6)
 for(const raster of snapshot.gameRasters!){expect(raster.exact).toBe(false);expect(raster.values.width).toBe(3);expect(raster.values.height).toBe(1);expect(raster.values.values).toHaveLength(3)}
})
it('does not declare unretained native byte tails exact',async()=>{
 const snapshot=await analyze(1000,true)
 for(const raster of snapshot.gameRasters!){expect(raster.exact).toBe(false);expect(raster.trailingBytes).toBe(1)}
})
for(const [id,maximum,offset,mask,shift] of [['ground-variation',31,5,0x1f,0],['cliff-variation',7,5,0xe0,5],['cliff-texture',15,6,0xf0,4]] as const)
 it(`map.layer-write ${id} changes only its owned native bits`,async()=>{
  const docs=documents(),read=async(path:string)=>docs.find(document=>document.path===path)?.bytes
  const map=await readWar3Map(read),original=docs.find(document=>document.path==='war3map.w3e')!.bytes
  expect(war3MapLayers(map).get(id)?.descriptor.maximum).toBe(maximum)
  const written=writeWar3MapLayer(map,original,{layer:id,x:0,y:0,width:1,height:1,values:[maximum]})
  const expected=original.slice(),at=45+3*7+offset
  expected[at]=(expected[at]!&~mask)|(maximum<<shift)
  expect(written.bytes).toEqual(expected)
  const reopened=await readWar3Map(async(path:string)=>path==='war3map.w3e'?written.bytes:read(path))
  expect(readWar3MapLayer(reopened,{layer:id,x:0,y:0,width:1,height:1}).values).toEqual([maximum])
  expect(()=>writeWar3MapLayer(map,original,{layer:id,x:0,y:0,width:1,height:1,values:[maximum+1]})).toThrow()
 })

import {encodeWar3Map} from '../src/war3-map/encoder.js'
import {openMpqReader} from '@modkit/blizzard-mpq/reader'
import {serializeUvwProfile,type UvwProfileDocument,type UvwGameRasterLayer} from '@modkit/uv/world'
let nativePromise:Promise<UvwProfileDocument>|undefined
const nativeDocument=()=>nativePromise??=(async()=>{
 const lease=createCandidateWorldSceneLease(await analyze(),[],4)
 try{
  const result=await materializeWorldToUvw(lease.value,options)
  if(result.state!=='materialized')throw new Error(JSON.stringify(result.refusals))
  expect(result.document.spaces[0]!.layers.filter(layer=>layer.kind==='game-raster')).toHaveLength(6)
  return result.document
 }finally{await lease.release()}
})()
const changeRaster=(document:UvwProfileDocument,change:(layer:UvwGameRasterLayer)=>UvwGameRasterLayer):UvwProfileDocument=>({...document,spaces:document.spaces.map(space=>({...space,layers:space.layers.map(layer=>layer.kind==='game-raster'&&layer.valueMeaning==='blizzard/war3-w3e-ground-texture@1'?change(layer):layer)}))})
it('restores all six authored fields and native catalogues through the actual W3 encoder and MPQ reader',async()=>{
 const document=await nativeDocument(),encoded=encodeWar3Map(serializeUvwProfile(document))
 const archive=await openMpqReader(encoded.bytes,{maxArchiveBytes:1<<24,maxEntries:64,maxEntryBytes:1<<20})
 try{
  const restored=await readWar3Map(async(path:string)=>{const entry=archive.find(path);return entry===undefined?undefined:archive.read(entry.id)})
  const original=await readWar3Map(async(path:string)=>documents().find(document=>document.path===path)?.bytes)
  for(const id of ids)expect(readWar3MapLayer(restored,{layer:id})).toEqual(readWar3MapLayer(original,{layer:id}))
  expect(restored.terrain!.groundTilesets).toEqual(original.terrain!.groundTilesets)
  expect(restored.terrain!.cliffTilesets).toEqual(original.terrain!.cliffTilesets)
  for(const id of ['height','cliff-level','pathing'])expect(readWar3MapLayer(restored,{layer:id})).toEqual(readWar3MapLayer(original,{layer:id}))
 }finally{archive.dispose()}
 expect(encoded.diagnostics.some(d=>d.code==='blizzard.war3/map-layer-dropped'&&/game-raster/.test(d.message))).toBe(false)
})
for(const patch of [{valueType:'u16' as const},{unit:'foreign-unit'},{valueScale:2}])it('refuses reinterpreted native raster scalar metadata',async()=>{
 const document=changeRaster(await nativeDocument(),layer=>({...layer,...patch}))
 expect(()=>encodeWar3Map(serializeUvwProfile(document))).toThrow(/native vertex vocabulary/)
})
for(const categories of [[{value:0,label:'bad'}],[{value:1,label:'Ldrt'}],[{value:0,label:'Ldrt',color:'#123456'}]])it('refuses guessed or nonconsecutive native tileset catalogues',async()=>{
 const document=changeRaster(await nativeDocument(),layer=>({...layer,categories}))
 expect(()=>encodeWar3Map(serializeUvwProfile(document))).toThrow(/native categories/)
})
it('refuses a native raster detached from the ground footprint',async()=>{
 const document=changeRaster(await nativeDocument(),layer=>({...layer,columns:2,samples:layer.samples.map(row=>row.slice(0,2))}))
 expect(()=>encodeWar3Map(serializeUvwProfile(document))).toThrow(/same horizontal grid/)
})
it('refuses duplicate native raster vocabularies instead of choosing layer order',async()=>{
 const source=await nativeDocument(),document={...source,spaces:source.spaces.map(space=>{const field=space.layers.find(layer=>layer.kind==='game-raster')!;return {...space,layers:[...space.layers,{...field,id:field.id+'-duplicate'}]}})}
 expect(()=>encodeWar3Map(serializeUvwProfile(document))).toThrow(/duplicate W3E/)
})
it('does not reinterpret a future vocabulary major with identical numeric values',async()=>{
 const document=changeRaster(await nativeDocument(),layer=>({...layer,valueMeaning:'blizzard/war3-w3e-ground-texture@2'}))
 const result=encodeWar3Map(serializeUvwProfile(document))
 expect(result.diagnostics.filter(d=>d.code==='blizzard.war3/map-layer-dropped'&&/game-raster/.test(d.message))).toHaveLength(1)
})

it('requires an explicit policy for native W3E rasters in a foreign unit frame',async()=>{
 const source=await nativeDocument(),document={...source,spaces:source.spaces.map(space=>({...space,basis:{...space.basis,unit:'source-unit' as const,sourceUnit:'foreign-unit'}}))}
 expect(()=>encodeWar3Map(serializeUvwProfile(document))).toThrow(/Warcraft III source-unit frame/)
})
it('reports a portable material layer superseded by authored native tile data',async()=>{
 const source=await nativeDocument(),document={...source,spaces:source.spaces.map(space=>({...space,layers:[...space.layers,
  {schemaVersion:1 as const,id:'portable-materials',kind:'terrain-materials' as const,columns:3,rows:2,cellSize:128,origin:[-128,0,-64] as const,materials:[{id:'tile-ldrt'}],samples:Array.from({length:2},()=>Array.from({length:3},()=>({weights:[{materialId:'tile-ldrt',weight:1}]})))},
 ]}))}
 const result=encodeWar3Map(serializeUvwProfile(document))
 expect(result.diagnostics.filter(d=>d.code==='blizzard.war3/map-material-native-overridden'&&d.message.includes('portable-materials'))).toHaveLength(1)
})

it('retains native 14-bit water height endpoints and edge flags without creating a portable water surface',async()=>{
 const values=[0,1,8192,16382,16383,1024],docs=documents().map(document=>{
  if(document.path!=='war3map.w3e')return document
  const bytes=document.bytes.slice(),view=new DataView(bytes.buffer)
  for(let i=0;i<6;i++){const at=45+i*7+2;view.setUint16(at,(view.getUint16(at,true)&0xc000)|values[i]!,true)}
  return {...document,bytes}
 })
 const snapshot=await analyzeWar3MapWorkspace({workspaceId:'water-endpoints',gameId:'blizzard/warcraft-3',mapId:'fixture',documents:docs,
  maxDocuments:32,maxDocumentBytes:1<<20,maxTotalBytes:1<<22,maxObjects:100,maxRegions:10,maxTerrainCells:1000,maxTerrainSamples:1000,maxDepth:16,snapshotId:'water-endpoints',unresolvedRequirementIds:[],requiredRequirementIds:[],maxDiagnostics:100})
 const raster=snapshot.gameRasters!.find(r=>r.descriptor.id==='water')!
 expect(raster.metadata).toEqual({valueMeaning:'blizzard/war3-w3e-water@1',valueType:'u16'})
 expect(raster.descriptor).toMatchObject({minimum:0,maximum:16383,sampling:'vertex',unit:'war3-world-unit',valueScale:0.25,valueOffset:-2048})
 expect(raster.values.values).toEqual([16382,16383,1024,0,1,8192])
 const lease=createCandidateWorldSceneLease(snapshot,[],4)
 try{
  const packed=await materializeWorldToUvpMap(lease.value,options)
  if(packed.state!=='materialized')throw new Error(JSON.stringify(packed.refusals))
  const field=packed.document.spaces[0]!.layers.find(layer=>layer.kind==='game-raster'&&layer.valueMeaning==='blizzard/war3-w3e-water@1')!
  expect(field.kind).toBe('game-raster')
  if(field.kind!=='game-raster')throw new Error('native water field was not retained as scalar data')
  expect(field.samples.flat()).toEqual(raster.values.values)
  expect(field).toMatchObject({valueType:'u16',unit:'war3-world-unit',valueScale:0.25,valueOffset:-2048})
  const reopened=await openUvpMapBundle(new Map([...packed.entries].map(([name,bytes])=>[name,bytes.slice()])),{snapshotId:'detached-water-endpoints'})
  const again=await materializeWorldToUvw(reopened.source,options)
  if(again.state!=='materialized')throw new Error(JSON.stringify(again.refusals))
  expect(again.document).toEqual(packed.document)
  const encoded=encodeWar3Map(again.bytes),archive=await openMpqReader(encoded.bytes,{maxArchiveBytes:1<<24,maxEntries:64,maxEntryBytes:1<<20})
  try{
   const original=await readWar3Map(async(path:string)=>docs.find(document=>document.path===path)?.bytes)
   const restored=await readWar3Map(async(path:string)=>{const entry=archive.find(path);return entry===undefined?undefined:archive.read(entry.id)})
   for(const id of [...ids,'height','cliff-level','pathing'])expect(readWar3MapLayer(restored,{layer:id})).toEqual(readWar3MapLayer(original,{layer:id}))
  }finally{archive.dispose()}
 }finally{await lease.release()}
})
for(const patch of [{unit:'m'},{valueScale:1},{valueOffset:0}])it('refuses water metadata that changes the declared native height interpretation',async()=>{
 const source=await nativeDocument(),document={...source,spaces:source.spaces.map(space=>({...space,layers:space.layers.map(layer=>layer.kind==='game-raster'&&layer.valueMeaning==='blizzard/war3-w3e-water@1'?{...layer,...patch}:layer)}))}
 expect(()=>encodeWar3Map(serializeUvwProfile(document))).toThrow(/native vertex vocabulary/)
})
