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
for(const height of [-10240.25,6144,1e100])it(`refuses height ${height} before signed int16 clipping`,()=>{
 expect(()=>encodeWar3Map(serializeUvwProfile(input(height)))).toThrow(/height.*int16/)
})
it('refuses a cliff level that would otherwise wrap into the low nibble',()=>{
 expect(()=>encodeWar3Map(serializeUvwProfile(input(0,16)))).toThrow(/cliff level.*4-bit/)
})
it('refuses NoData instead of creating ground at the sentinel height',()=>{
 expect(()=>encodeWar3Map(serializeUvwProfile(changeGround(input(-999),{noDataValue:-999})))).toThrow(/NoData/)
})
it('reports height rounding once with the actual number of written corners',()=>{
 const result=encodeWar3Map(serializeUvwProfile(input(0.1)))
 const losses=result.diagnostics.filter(d=>d.code==='blizzard.war3/map-terrain-height-quantized')
 expect(losses).toHaveLength(1);expect(losses[0]!.message).toContain('4 terrain corner(s)')
})
it('refuses inconsistent native cell size instead of silently expanding the map',()=>{
 expect(()=>encodeWar3Map(serializeUvwProfile(changeGround(input(),{cellSize:64})))).toThrow(/128-unit cells/)
})
for(const fields of [{cellSize:64},{origin:[128,0,0] as const}])it('refuses a cliff grid detached from the rendered ground footprint',()=>{
 const source=input(0,2)
 const document={...source,spaces:source.spaces.map(space=>({...space,bounds:{min:[0,0,0] as const,max:[256,0,256] as const}}))}
 expect(()=>encodeWar3Map(serializeUvwProfile(changeCliffs(document,fields)))).toThrow(/same horizontal grid/)
})
for(const origin of [[1e100,0,0],[1e-100,0,0]] as const)it('refuses destructive native float32 terrain coordinates',()=>{
 expect(()=>encodeWar3Map(serializeUvwProfile(changeGround(input(),{origin})))).toThrow(/float32/)
})
it('reports ordinary float32 terrain origin rounding',()=>{
 const result=encodeWar3Map(serializeUvwProfile(changeGround(input(),{origin:[0.1,0,0]})))
 expect(result.diagnostics.filter(d=>d.code==='blizzard.war3/map-terrain-coordinate-quantized')).toHaveLength(1)
})
it('retains signed height endpoints, cliff nibble and ordinary rounded native bytes',async()=>{
 for(const [height,level,stored] of [[-10240,2,-32768],[6143.75,2,32767],[0,15,1536],[0.1,2,8192]] as const){
  const result=encodeWar3Map(serializeUvwProfile(input(height,level)))
  const archive=await openMpqReader(result.bytes,{maxArchiveBytes:1<<24,maxEntries:64,maxEntryBytes:1<<20})
  try{
   const raw=await archive.read(archive.find('war3map.w3e')!.id),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength)
   // One ground tile and one cliff set: 45 header bytes, then four 7-byte corners.
   for(let i=0;i<4;i++){expect(view.getInt16(45+i*7,true)).toBe(stored);expect(raw[51+i*7]!&15).toBe(level)}
  }finally{archive.dispose()}
  expect(result.diagnostics.some(d=>d.code==='blizzard.war3/map-terrain-height-quantized')).toBe(height===0.1)
 }
})
