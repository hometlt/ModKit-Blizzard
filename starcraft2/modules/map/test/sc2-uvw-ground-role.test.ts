import {expect,it} from 'vitest'
import {serializeUvwProfile,type UvwProfileDocument} from '@modkit/uv/world'
import {convertUvwToStarcraft2Map} from '../codecs/package/src/uvw-map-converter.js'
import {encodeWar3Map} from '../../../../blizzard-warcraft-3/src/war3-map/encoder.js'
const input=(ground=true):UvwProfileDocument=>({uv:{format:'UVW',version:'1.0',status:'profile'},connections:[],spaces:[{
 id:'main',topology:ground?'heightfield':'mesh',basis:{handedness:'right',upAxis:'y',forwardAxis:'+z',unit:'source-unit',sourceUnit:'sc2-game-unit',unitsPerCell:1},
 bounds:{min:[0,0,0],max:[1,10,1]},layers:[
 ...(ground?[{id:'ground',kind:'heightfield' as const,columns:2,rows:2,cellSize:1,origin:[0,0,0] as const,samples:[[0,0],[0,0]]}]:[]),
 {id:'objects',schemaVersion:1,kind:'objects',instances:[{id:'instance-1',objectKind:'unit',typeId:'hfoo',position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],resourceIds:[]}]},
 ]}]})
const withQuery=(ground=true,size=2):UvwProfileDocument=>{
 const document=input(ground)
 return {...document,spaces:document.spaces.map(space=>({...space,layers:[{id:'a-query',kind:'heightfield' as const,role:'query' as const,columns:size,rows:size,cellSize:1,origin:[0,0,0] as const,samples:Array.from({length:size},()=>Array(size).fill(7))},...space.layers]}))}
}
for (const size of [1,2]) {
 it(`SC2 refuses a ${size}x${size} query-only mesh instead of inventing rendered ground`,async()=>{
  const result=await convertUvwToStarcraft2Map(withQuery(false,size),{maxOutputBytes:1<<20})
  expect(result.state).toBe('refused');expect(result.refusalCodes).toContain('terrain-layer-invalid')
 })
 it(`Warcraft III refuses a ${size}x${size} query-only mesh instead of writing it as W3E terrain`,()=>{
  expect(()=>encodeWar3Map(serializeUvwProfile(withQuery(false,size)))).toThrow(/rendered ground heightfield/)
 })
}
it('SC2 selects the actual ground despite an earlier query layer and reports the unencoded query exactly once',async()=>{
 const base=await convertUvwToStarcraft2Map(input(),{maxOutputBytes:1<<20})
 const extra=await convertUvwToStarcraft2Map(withQuery(),{maxOutputBytes:1<<20})
 expect(base.state).toBe('converted');expect(extra.state,JSON.stringify(extra.refusals)).toBe('converted')
 expect(extra.bytes).toEqual(base.bytes)
 expect(extra.losses.filter((loss:{feature:string})=>loss.feature==='layers.a-query')).toHaveLength(1)
 expect(extra.losses.some((loss:{feature:string})=>loss.feature==='layers.ground')).toBe(false)
})
it('Warcraft III selects the actual ground and reports a query grid without altering the native map bytes',()=>{
 const base=encodeWar3Map(serializeUvwProfile(input()))
 const extra=encodeWar3Map(serializeUvwProfile(withQuery()))
 expect(extra.bytes).toEqual(base.bytes)
 expect(extra.diagnostics.filter(d=>d.code==='blizzard.war3/map-layer-dropped'&&d.message.includes('layer a-query '))).toHaveLength(1)
 expect(extra.diagnostics.some(d=>d.code==='blizzard.war3/map-layer-dropped'&&d.message.includes('layer ground '))).toBe(false)
})

it('keeps explicit ground and legacy omitted-role terrain equivalent for both native formats',async()=>{
 const document=input()
 const explicit={...document,spaces:document.spaces.map(space=>({...space,layers:space.layers.map(layer=>layer.kind==='heightfield'?{...layer,role:'ground' as const}:layer)}))}
 const before=await convertUvwToStarcraft2Map(document,{maxOutputBytes:1<<20})
 const after=await convertUvwToStarcraft2Map(explicit,{maxOutputBytes:1<<20})
 expect(before.state).toBe('converted');expect(after.state).toBe('converted')
 expect(after.bytes).toEqual(before.bytes)
 expect(encodeWar3Map(serializeUvwProfile(explicit)).bytes).toEqual(encodeWar3Map(serializeUvwProfile(document)).bytes)
})
