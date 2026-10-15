import{describe,expect,it}from'vitest'
import{planSc2ComponentVersions}from'../codecs/document-metadata/core/component-list.js'
import{parseVersionFile,writeVersionFile}from'../codecs/document-metadata/core/version-file.js'
const utf8=new TextEncoder(),profile={buildNumber:98310,majorVersion:5,minorVersion:0,patchVersion:17}
const list='<Components><DataComponent Type="info">DocumentInfo</DataComponent><DataComponent Type="gada">GameData</DataComponent><DataComponent Type="text" Locale="enUS">GameText</DataComponent><DataComponent Type="text" Locale="ruRU">GameText</DataComponent><DataComponent Type="terr">t3Terrain.xml</DataComponent></Components>'
const files=()=>new Map([['ComponentList.SC2Components',utf8.encode(list)]])
describe('declared native component version planning',()=>{
 it('writes one root text sidecar for multiple locales and uses the canonical component tags',()=>{
  const input=files(),plan=planSc2ComponentVersions(input,profile)
  expect(plan.map(f=>f.path)).toEqual(['DocumentInfo.version','GameData.version','GameText.version','t3Terrain.version'])
  expect(plan.map(f=>parseVersionFile(f.bytes)?.typeTag)).toEqual(['ofni','adag','txet','rret'])
  expect(plan.every(f=>parseVersionFile(f.bytes)?.buildNumber===profile.buildNumber)).toBe(true)
  expect(input.size).toBe(1)
  expect(planSc2ComponentVersions(new Map([...input,...plan.map(f=>[f.path,f.bytes]as const)]),profile)).toEqual([])
 })
 it('preserves existing case-insensitive and empty native sidecars literally',()=>{
  const input=files(),original=writeVersionFile({...profile,fileType:'GameData',entryCount:27,timestamp:123})
  input.set('GAMEDATA.VERSION',original);input.set('GameText.version',new Uint8Array())
  const plan=planSc2ComponentVersions(input,profile)
  expect(plan.map(f=>f.path)).toEqual(['DocumentInfo.version','t3Terrain.version'])
  expect(input.get('GAMEDATA.VERSION')).toBe(original)
 })
 it('refuses malformed or mistyped existing sidecars and unsafe component declarations',()=>{
  const invalid=files();invalid.set('DocumentInfo.version',new Uint8Array([1]));expect(()=>planSc2ComponentVersions(invalid,profile)).toThrow(/version/)
  const mistyped=files();mistyped.set('DocumentInfo.version',writeVersionFile({...profile,fileType:'GameText'}));expect(()=>planSc2ComponentVersions(mistyped,profile)).toThrow(/mismatch/)
  for(const path of ['../GameText','C:/GameText','/GameText'])expect(()=>planSc2ComponentVersions(new Map([['ComponentList.SC2Components',utf8.encode(`<Components><DataComponent Type="text">${path}</DataComponent></Components>`)]]),profile)).toThrow(/Unsafe/)
  expect(()=>planSc2ComponentVersions(files(),{})).toThrow(/buildNumber/)
 })
})
