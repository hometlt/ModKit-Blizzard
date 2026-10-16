import { expect,it } from 'vitest'
import { serializeUvwProfile,type UvwProfileDocument } from '@modkit/uv/world'
import { convertUvwToStarcraft2Map } from '../codecs/package/src/uvw-map-converter.js'
import { encodeWar3Map } from '../../../../blizzard-warcraft-3/src/war3-map/encoder.js'
function input(directional=true):UvwProfileDocument {
 return {uv:{format:'UVW',version:'1.0',status:'profile'},connections:[],spaces:[{id:'main',topology:'heightfield',basis:{handedness:'right',upAxis:'y',forwardAxis:'+z',unit:'source-unit',sourceUnit:'sc2-game-unit',unitsPerCell:1},bounds:{min:[0,0,0],max:[1,0,1]},layers:[
  {kind:'heightfield',id:'ground',columns:2,rows:2,cellSize:1,origin:[0,0,0],samples:[[0,0],[0,0]]},
  {schemaVersion:1,kind:'lighting',id:'lighting',model:'unlit',unlitColor:[2,0.5,0],ambientColor:[0.2,0.3,0.4],ambientIntensity:0.3,toneMapping:{operator:'linear',exposure:1,whitePoint:1,contrast:1},terrain:{specularExponent:10,diffuseMultiplier:1,specularMultiplier:0},directional:directional?[{id:'sun',direction:[0,-1,0],color:[1,1,1],intensity:0.8,specularColor:[0.5,0.5,0.5],specularIntensity:0,useAmbientOcclusion:false}]:[]},
 ]}]}
}
it('SC2 names each lighting field its CLight writer does not encode, including inactive authored data',async()=>{
 const result=await convertUvwToStarcraft2Map(input(),{maxOutputBytes:1<<20})
 expect(result.state,JSON.stringify(result.refusals)).toBe('converted')
 for(const field of ['model','unlitColor','toneMapping','terrain','directional[0].specularColor','directional[0].specularIntensity','directional[0].useAmbientOcclusion'])
  expect(result.losses.filter(loss=>loss.feature===`layers.lighting.${field}`)).toHaveLength(1)
})
it('SC2 reports one whole-layer loss without a Key light instead of pretending it can encode unlit',async()=>{
 const result=await convertUvwToStarcraft2Map(input(false),{maxOutputBytes:1<<20})
 expect(result.state,JSON.stringify(result.refusals)).toBe('converted')
 expect(result.losses.filter(loss=>loss.feature==='layers.lighting')).toHaveLength(1)
 expect(result.losses.some(loss=>loss.feature==='layers.lighting.model')).toBe(false)
})
it('Warcraft III reports its omitted whole lighting environment instead of allowing an unwritten layer',()=>{
 const result=encodeWar3Map(serializeUvwProfile(input()))
 expect(result.diagnostics.filter(item=>item.code==='blizzard.war3/map-layer-dropped'&&item.message.includes('lighting'))).toHaveLength(1)
})
