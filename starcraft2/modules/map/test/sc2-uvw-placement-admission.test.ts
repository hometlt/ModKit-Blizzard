import { expect,it } from 'vitest'
import { serializeUvwProfile,type UvwProfileDocument,type UvwObjectInstance } from '@modkit/uv/world'
import { convertUvwToStarcraft2Map } from 'C:/MODDING/modkit-extensions-blizzard/starcraft2/modules/map/codecs/package/src/uvw-map-converter.js'
import { encodeWar3Map } from 'C:/MODDING/modkit-extensions-blizzard/blizzard-warcraft-3/src/war3-map/encoder.ts'
const instance=(extra:Partial<UvwObjectInstance>={}):UvwObjectInstance=>({id:'instance-3',objectKind:'unit',typeId:'hfoo',player:0,variation:0,position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],resourceIds:[],...extra})
const input=(object=instance()):UvwProfileDocument=>({uv:{format:'UVW',version:'1.0',status:'profile'},connections:[],spaces:[{id:'main',topology:'heightfield',basis:{handedness:'right',upAxis:'y',forwardAxis:'+z',unit:'source-unit',sourceUnit:'sc2-game-unit',unitsPerCell:1},bounds:{min:[0,0,0],max:[1,0,1]},layers:[
 {kind:'heightfield',id:'ground',columns:2,rows:2,cellSize:1,origin:[0,0,0],samples:[[0,0],[0,0]]},
 {schemaVersion:1,kind:'objects',id:'objects-a',instances:[object]},
]}]})

import { pureYawQuaternion } from '@modkit/codec-kit/model-math/transform'
for(const objectKind of ['unit','doodad'] as const){
 it(`Warcraft III refuses ${objectKind} variation overflow rather than writing zero`,()=>{
  expect(()=>encodeWar3Map(serializeUvwProfile(input(instance({objectKind,variation:2**40}))))).toThrow(/variation.*int32/)
  expect(()=>encodeWar3Map(serializeUvwProfile(input(instance({objectKind,variation:0x7fffffff}))))).not.toThrow()
 })
 it(`Warcraft III refuses ${objectKind} tilt rather than writing identity`,()=>{
  expect(()=>encodeWar3Map(serializeUvwProfile(input(instance({objectKind,rotation:[Math.SQRT1_2,0,0,Math.SQRT1_2]}))))).toThrow(/canonical yaw/)
 })
}
for(const scale of [1e100,1e-100])it(`Warcraft III refuses destructive float32 scale ${scale}`,()=>{
 expect(()=>encodeWar3Map(serializeUvwProfile(input(instance({scale:[scale,1,1]}))))).toThrow(/float32/)
})
it('Warcraft III refuses overflow during native position scaling',()=>{
 expect(()=>encodeWar3Map(serializeUvwProfile(input(instance({position:[1e100,0,0]}))))).toThrow(/float32/)
})
it('Warcraft III reports ordinary float32 rounding per written source channel',()=>{
 const result=encodeWar3Map(serializeUvwProfile(input(instance({scale:[0.1,1,1]}))))
 const losses=result.diagnostics.filter(d=>d.code==='blizzard.war3/map-object-value-quantized')
 expect(losses).toHaveLength(1);expect(losses[0]!.message).toContain('scale.x')
})
it('exactly represented Warcraft III placements add no float32 rounding loss',()=>{
 const result=encodeWar3Map(serializeUvwProfile(input()))
 expect(result.diagnostics.some(d=>d.code==='blizzard.war3/map-object-value-quantized')).toBe(false)
})
it('the common pure-yaw owner rejects tilt, holes, nonunit and nonfinite quaternions',()=>{
 for(const q of [[1,0,0,0],[0,0,0,0],[0,0,0,2],[0,Infinity,0,1],new Array(4),[0,0,1]])
  expect(pureYawQuaternion(q)).toBeUndefined()
 for(const angle of [-Math.PI,-1,0,1,Math.PI])
  expect(pureYawQuaternion([0,Math.sin(angle/2),0,Math.cos(angle/2)])).toBeCloseTo(angle,14)
})
it('SC2 retains its explicit tilted-placement refusal through the common owner',async()=>{
 const result=await convertUvwToStarcraft2Map(input(instance({rotation:[Math.SQRT1_2,0,0,Math.SQRT1_2]})),{maxOutputBytes:1<<20})
 expect(result.state).toBe('refused');expect(result.refusalCodes).toContain('object-rotation-unrepresentable')
})

import {openMpqReader} from '@modkit/blizzard-mpq/reader'
it('the native placement bytes retain maximum signed variation and the rounded source scale',async()=>{
 for(const objectKind of ['unit','doodad'] as const){
  const result=encodeWar3Map(serializeUvwProfile(input(instance({objectKind,variation:0x7fffffff,scale:[0.1,1,1]}))))
  const archive=await openMpqReader(result.bytes,{maxArchiveBytes:1<<24,maxEntries:64,maxEntryBytes:1<<20})
  try{
   const entry=archive.find(objectKind==='doodad'?'war3map.doo':'war3mapUnits.doo')!
   const raw=await archive.read(entry.id),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength)
   // W3do + version + subversion + count, then id + variation + position + angle + scale.
   expect(view.getInt32(20,true)).toBe(0x7fffffff)
   expect(view.getFloat32(40,true)).toBe(Math.fround(0.1))
  }finally{archive.dispose()}
 }
})
