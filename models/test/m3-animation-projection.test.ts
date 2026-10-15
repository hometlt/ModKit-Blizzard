import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'
import { projectM3Animations } from '../dist/m3/animation-projection.js'

const fixtures = new URL('./fixtures/m3/', import.meta.url)
const schema = new URL('../src/m3/native/structures.xml', import.meta.url)
const budget = { maxDepth: 128, maxNodes: 1_000_000, maxScalarBytes: 256 * 1024 * 1024 }
installM3PlatformAdapters({ DOMParser })

describe('full M3 sequence extraction through the typed MK3 boundary', () => {
  for (const file of [
    'model.m3',
    'corpus/portrait.m3',
    'corpus/Harbinger.m3',
    'corpus/analysisterminal.m3',
    'corpus/aiur_cliffrocks_00.m3',
    'cybros-cover.m3a.b64',
  ]) {
    it(`projects every sequence within its budget for ${file}`, async () => {
      const stored = await readFile(new URL(file, fixtures))
      const bytes = file.endsWith('.b64')
        ? new Uint8Array(Buffer.from(stored.toString().trim(), 'base64'))
        : new Uint8Array(stored)
      const xml = await readFile(schema, 'utf8')
      const sections = await M3SectionList.load(bytes.buffer, xml)
      const result = projectM3Animations(sections, budget)
      expect(result.invalidBounds).toBe(0)
      expect(() => projectM3Animations(sections, { ...budget, maxNodes: 1 })).toThrow(/maxNodes/)
      expect(() => projectM3Animations(sections, { ...budget, maxScalarBytes: 1 })).toThrow(
        /maxBytes/,
      )
      expect(() => projectM3Animations(sections, budget, AbortSignal.abort())).toThrow(/cancelled/)
    })
  }
})

describe('clip playback and events (plan П16, П18)', () => {
  it('gives each clip its events in time, its blend-in and the priority its STCs agree on', async () => {
    const bytes = new Uint8Array(await readFile(new URL('model.m3', fixtures)))
    const sections = await M3SectionList.load(bytes.buffer, await readFile(schema, 'utf8'))
    const result = projectM3Animations(sections, budget)
    const withEvents = result.clips.filter(clip => (clip.events?.length ?? 0) > 0)
    expect(withEvents.length).toBeGreaterThan(0)
    for (const clip of withEvents) {
      const times = clip.events!.map(event => event.timeSeconds)
      expect(times).toEqual([...times].sort((left, right) => left - right))
      for (const event of clip.events!) {
        expect(event.timeSeconds).toBeGreaterThanOrEqual(0)
        expect(event.timeSeconds).toBeLessThanOrEqual((clip.durationSeconds ?? 0) + 1e-9)
        expect(event.name).not.toBe('')
        if (event.nodeId !== undefined) expect(event.nodeId).toMatch(/^bone\/\d+$/u)
        expect(event.payload).toEqual(expect.objectContaining({ id: expect.any(Number), flags: expect.any(Number) }))
      }
    }
    // Every M3 sequence ends on Evt_SeqEnd, at its last moment.
    const ended = withEvents.find(clip => clip.events!.some(event => event.name === 'Evt_SeqEnd'))
    expect(ended).toBeDefined()
    // The events are the residual tracks the round trip keeps, key for key.
    expect(result.clips.reduce((sum, clip) => sum + (clip.events?.length ?? 0), 0)).toBe(
      result.animationEvents.reduce((sum, track) => sum + track.frames.length, 0),
    )
    for (const clip of result.clips) {
      expect(clip.blendInSeconds).toEqual(expect.any(Number))
      if (clip.priority !== undefined) expect(Number.isInteger(clip.priority)).toBe(true)
    }
  })
})

it('budgets expanded animation JSON separately while retaining native traversal and scalar refusals', async () => {
  const bytes=new Uint8Array(await readFile(new URL('corpus/Harbinger.m3',fixtures)))
  const sections=await M3SectionList.load(bytes.buffer,await readFile(schema,'utf8'))
  if(sections.model===null)throw new TypeError('native fixture has no model')
  // Repeat decoded native sequence/STG declarations while sharing their genuine STC/SD tracks.
  // This models the expansion boundary without introducing another parser or copying key data.
  const duplicated=new Map<unknown,unknown>()
  const model={...sections.model} as any
  for(const field of ['sequences','sequence_transformation_groups']) {
    const originalRef=sections.model[field] as any
    const section=sections.getSectionByReference(originalRef)!
    const content=Array.from({length:16},()=>section.content).flat()
    const reference={...originalRef,entries:content.length}
    model[field]=reference;duplicated.set(reference,{...section,content})
  }
  const expanded={model,getSectionByReference:(ref:any)=>(duplicated.get(ref)??sections.getSectionByReference(ref)) as any}
  const {snapshotModelAnimations}=await import('@modkit/codec-kit/model/animation')
  let admitted:ReturnType<typeof projectM3Animations>|undefined
  let nativeNodes=0
  for(const maxNodes of [100,300,1000,3000,10000,30000,100000,300000]) {
    try {admitted=projectM3Animations(expanded,{...budget,maxNodes});nativeNodes=maxNodes;break}
    catch(error){if(!(error instanceof RangeError)||!error.message.includes('maxNodes'))throw error}
  }
  expect(admitted).toBeDefined()
  expect(admitted!.clips.some(clip=>clip.channels.length>0)).toBe(true)
  expect(admitted!.declaredSequences).toBe((sections.getSectionByReference(sections.model['sequences'] as any)!.content.length)*16)
  expect(()=>snapshotModelAnimations(admitted!.clips,{maxDepth:budget.maxDepth,maxNodes:nativeNodes,maxBytes:budget.maxScalarBytes})).toThrow(/maxNodes/)
  expect(()=>projectM3Animations(expanded,{...budget,maxNodes:1})).toThrow(/maxNodes/)
  expect(()=>projectM3Animations(expanded,budget,AbortSignal.abort())).toThrow(/cancelled/)
  expect(()=>projectM3Animations(expanded,{...budget,maxScalarBytes:1})).toThrow(/maxBytes/)
})






it('projects only requested native animation properties while keeping default extraction and refusals',async()=>{
 const bytes=new Uint8Array(await readFile(new URL('corpus/Harbinger.m3',fixtures)))
 const sections=await M3SectionList.load(bytes.buffer,await readFile(schema,'utf8'))
 if(sections.model===null)throw Error('fixture model missing')
 const source={model:sections.model,getSectionByReference:sections.getSectionByReference.bind(sections)}
 const all=projectM3Animations(source,budget)
 const name=all.clips.find(clip=>clip.channels.length>0)!.name!
 const {modelAnimationNameMatches}=await import('@modkit/codec-kit/model/animation')
 const selected=projectM3Animations(source,budget,undefined,undefined,[name])
 expect(selected.clips).toEqual(all.clips.filter(clip=>modelAnimationNameMatches(clip.name??'',name)))
 expect(selected.clips.length).toBeGreaterThan(0)
 expect(selected.nativeSequenceIndices).toEqual(all.clips.flatMap((clip,index)=>modelAnimationNameMatches(clip.name??'',name)?[all.nativeSequenceIndices[index]!]:[]))
 const {buildRenderSequences}=await import('../src/m3/native/animation/tracks.js')
 const nativeDefault=buildRenderSequences(source.model,source)
 const nativeSelected=buildRenderSequences(source.model,source,new Set(selected.nativeSequenceIndices))
 expect(nativeSelected.sequences).toHaveLength(nativeDefault.sequences.length)
 for(const [index,sequence] of nativeSelected.sequences.entries()) {
   if(selected.nativeSequenceIndices.includes(index))expect(sequence).toEqual(nativeDefault.sequences[index])
   else {expect(sequence.name).toBe(nativeDefault.sequences[index]!.name);expect(sequence.nodeTracks).toEqual([])}
 }
 expect(nativeSelected.sequences.reduce((sum,s)=>sum+s.nodeTracks.length,0)).toBeLessThan(nativeDefault.sequences.reduce((sum,s)=>sum+s.nodeTracks.length,0))
 expect(selected.timelineContainers).toHaveLength(all.timelineContainers.length)
 expect(selected.timelineContainers.some((container,index)=>container.frames===0&&all.timelineContainers[index]!.frames>0)).toBe(true)
 expect(projectM3Animations(source,budget,undefined,undefined,['Unknown Selection']).clips).toEqual([])
 expect(projectM3Animations(source,budget).clips).toEqual(all.clips)
 expect(()=>projectM3Animations(source,{...budget,maxNodes:1},undefined,undefined,[name])).toThrow(/maxNodes/)
 expect(()=>projectM3Animations(source,{...budget,maxScalarBytes:1},undefined,undefined,[name])).toThrow(/maxBytes/)
 expect(()=>projectM3Animations(source,budget,AbortSignal.abort(),undefined,[name])).toThrow(/cancelled/)
})
