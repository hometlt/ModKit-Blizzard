import { expect,it } from 'vitest'
import { serializeUvwProfile,type UvwProfileDocument,type UvwObjectInstance } from '@modkit/uv/world'
import { convertUvwToStarcraft2Map } from '../codecs/package/src/uvw-map-converter.js'
import { encodeWar3Map } from '../../../../blizzard-warcraft-3/src/war3-map/encoder.js'
const instance=(extra:Partial<UvwObjectInstance>={}):UvwObjectInstance=>({id:'instance-3',objectKind:'unit',typeId:'hfoo',player:0,variation:0,position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],resourceIds:[],...extra})
const input=(object=instance()):UvwProfileDocument=>({uv:{format:'UVW',version:'1.0',status:'profile'},connections:[],spaces:[{id:'main',topology:'heightfield',basis:{handedness:'right',upAxis:'y',forwardAxis:'+z',unit:'source-unit',sourceUnit:'sc2-game-unit',unitsPerCell:1},bounds:{min:[0,0,0],max:[1,0,1]},layers:[
 {kind:'heightfield',id:'ground',columns:2,rows:2,cellSize:1,origin:[0,0,0],samples:[[0,0],[0,0]]},
 {schemaVersion:1,kind:'objects',id:'objects-a',instances:[object]},
]}]})
const fields=['presentationRotation','presentationTint','presentationAnimation','presentationTeamColor','presentationTeamRamp','presentationTeamColorIntensity','latticeCoverage','name']
const presented=()=>instance({name:'source actor',presentationRotation:[0,1,0,0],presentationTint:[0,1,0],
 presentationAnimation:{name:'Stand',groups:['Stand'],loop:false,speed:0},presentationTeamColor:[0,0,0],
 presentationTeamRamp:[[0,0,0],[0.25,0.5,1]],presentationTeamColorIntensity:0,latticeCoverage:{roles:[],blocked:[]}})
it('SC2 names every unwritten object presentation field once and keeps actual placement attributes',async()=>{
 const result=await convertUvwToStarcraft2Map(input(presented()),{maxOutputBytes:1<<20})
 expect(result.state,JSON.stringify(result.refusals)).toBe('converted')
 if(result.state!=='converted')return
 for(const field of fields)expect(result.losses.filter((loss:{readonly feature:string})=>loss.feature===`objects.instances[0].${field}`),field).toHaveLength(1)
 for(const field of ['id','typeId','player','variation','position','scale','rotation','resourceIds'])expect(result.losses.some((loss:{readonly feature:string})=>loss.feature===`objects.instances[0].${field}`),field).toBe(false)
 const xml=new TextDecoder().decode(result.documents.find((document:{readonly path:string;readonly bytes:Uint8Array})=>document.path==='Objects')!.bytes)
 expect(xml).toContain('Id="3"');expect(xml).toContain('Player="0"');expect(xml).toContain('Rotation="0"')
 expect(xml).not.toContain('source actor');expect(xml).not.toContain('presentation')
})
it('Warcraft III reports presentation and source identity omitted from its native placement records',()=>{
 const result=encodeWar3Map(serializeUvwProfile(input(presented())))
 for(const field of [...fields,'id'])expect(result.diagnostics.filter(d=>d.code==='blizzard.war3/map-object-field-dropped'&&d.message.includes(`instance-3.${field} `)),field).toHaveLength(1)
 expect(result.diagnostics.some(d=>d.code==='blizzard.war3/map-object-field-dropped'&&d.message.includes('.player '))).toBe(false)
})
it('both native writers report explicit roster/start tables, including empty authoritative tables',async()=>{
 const {player:_player,...unowned}=instance()
 const document=input(unowned);const space=document.spaces[0]!
 const tables={players:[],startPositions:[]}
 const withTables={...document,spaces:[{...space,...tables}]}
 const sc2=await convertUvwToStarcraft2Map(withTables,{maxOutputBytes:1<<20})
 expect(sc2.state).toBe('converted')
 for(const field of ['players','startPositions'])expect(sc2.losses.filter((loss:{readonly feature:string})=>loss.feature===`spaces[0].${field}`)).toHaveLength(1)
 const war3=encodeWar3Map(serializeUvwProfile(withTables))
 for(const field of ['players','startPositions'])expect(war3.diagnostics.filter(d=>d.code==='blizzard.war3/map-field-dropped'&&d.message.includes(`spaces[0].${field} `))).toHaveLength(1)
})
it('SC2 reports only the unselected extra object layer while Warcraft III writes both object layers',async()=>{
 const document=input();const space=document.spaces[0]!
 const multiple={...document,spaces:[{...space,layers:[...space.layers,{schemaVersion:1 as const,id:'objects-b',kind:'objects' as const,instances:[instance({id:'instance-4'})]}]}]}
 const sc2=await convertUvwToStarcraft2Map(multiple,{maxOutputBytes:1<<20})
 expect(sc2.state,JSON.stringify(sc2.refusals)).toBe('converted')
 expect(sc2.losses.filter((loss:{readonly feature:string})=>loss.feature==='layers.objects-b')).toHaveLength(1)
 expect(sc2.losses.some((loss:{readonly feature:string})=>loss.feature==='layers.objects-a')).toBe(false)
 const war3=encodeWar3Map(serializeUvwProfile(multiple))
 expect(war3.diagnostics.some(d=>d.code==='blizzard.war3/map-layer-dropped'&&/objects-[ab]/.test(d.message))).toBe(false)
})
it('resource payloads and nonempty object references are reported without inventing embedded native assets',async()=>{
 const document=input(instance({resourceIds:['footman']}));const space=document.spaces[0]!
 const resource={schemaVersion:1 as const,kind:'resources' as const,id:'resources',resources:[{id:'footman',kind:'uvm' as const,uri:'models/footman.uvm'}]}
 const source={...document,spaces:[{...space,layers:[...space.layers,resource]}]}
 const sc2=await convertUvwToStarcraft2Map(source,{maxOutputBytes:1<<20})
 expect(sc2.state).toBe('converted')
 expect(sc2.losses.filter((loss:{readonly feature:string})=>loss.feature==='objects.instances[0].resourceIds')).toHaveLength(1)
 expect(sc2.losses.filter((loss:{readonly feature:string})=>loss.feature==='layers.resources')).toHaveLength(1)
 const war3=encodeWar3Map(serializeUvwProfile(source))
 expect(war3.diagnostics.filter(d=>d.code==='blizzard.war3/map-object-field-dropped'&&d.message.includes('.resourceIds '))).toHaveLength(1)
 expect(war3.diagnostics.filter(d=>d.code==='blizzard.war3/map-layer-dropped'&&d.message.includes('layer resources '))).toHaveLength(1)
})

it('both native doodad writers report a present zero owner that their doodad records do not store',async()=>{
 const document=input(instance({objectKind:'doodad',typeId:'LTlt',player:0}))
 const sc2=await convertUvwToStarcraft2Map(document,{maxOutputBytes:1<<20})
 expect(sc2.state).toBe('converted')
 expect(sc2.losses.filter((loss:{readonly feature:string})=>loss.feature==='objects.instances[0].player')).toHaveLength(1)
 const war3=encodeWar3Map(serializeUvwProfile(document))
 expect(war3.diagnostics.filter(d=>d.code==='blizzard.war3/map-object-field-dropped'&&d.message.includes('.player '))).toHaveLength(1)
})

it('reports an omitted space label while recognizing the Warcraft III label actually selected for its header',async()=>{
 const document=input();const labeled={...document,spaces:document.spaces.map(space=>({...space,label:'source-label'}))}
 const sc2=await convertUvwToStarcraft2Map(labeled,{maxOutputBytes:1<<20})
 expect(sc2.state).toBe('converted')
 expect(sc2.losses.filter((loss:{readonly feature:string})=>loss.feature==='spaces[0].label')).toHaveLength(1)
 const bytes=serializeUvwProfile(labeled)
 const kept=encodeWar3Map(bytes),overridden=encodeWar3Map(bytes,{name:'target-label'})
 expect(kept.diagnostics.some(d=>d.code==='blizzard.war3/map-field-dropped'&&d.message.includes('spaces[0].label '))).toBe(false)
 expect(overridden.diagnostics.filter(d=>d.code==='blizzard.war3/map-field-dropped'&&d.message.includes('spaces[0].label '))).toHaveLength(1)
 expect(new TextDecoder().decode(kept.bytes.subarray(0,256))).toContain('source-label')
 expect(new TextDecoder().decode(overridden.bytes.subarray(0,256))).toContain('target-label')
})
