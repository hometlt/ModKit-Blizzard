/** Native speech binding regressions: exact catalog references, clocks, ambiguity and cancellation. */
import { expect, it } from 'vitest'
import type { InspectionContext } from '@modkit/codec-kit'
import { compileCutscene } from '../codecs/cutscene/src/evaluate.js'
import { decodeCutsceneText } from '../codecs/cutscene/src/decode.js'
import { createCutsceneWorldSource } from '../codecs/cutscene/src/world.js'

const scene = (extra = '') => compileCutscene(decodeCutsceneText(`<CutsceneState>
 <CCutsceneNodeActor guid="actor" modelLink="Nova" ${extra}>
  <CCutsceneElementObject start="0" duration="5000"/>
  <CCutsceneNodeFolder><CCutsceneNodeConversation>
   <CCutsceneElementConversation guid="line" start="1000" duration="2000" soundLink="Line007"
     facialGroup="AuthoredGroup" facialAnim="AuthoredAnim" durationOffset="400"/>
  </CCutsceneNodeConversation></CCutsceneNodeFolder>
 </CCutsceneNodeActor></CutsceneState>`))

const make = (compiled = scene(), assets: unknown = [{ index: '7', value: {
  File: 'LocalizedData/Sounds/Line007.ogg', FacialFile: 'LocalizedData/Sounds/Line007.fxe',
  FacialGroup: 'CatalogGroup', FacialAnim: 'CatalogAnim', Weight: 1,
} }]) => {
 const calls: unknown[] = []
 const context = { input: { revisions: { revision: 'facial' } }, primary: { source: { id: 'scene' } },
  catalog: { entities: async (refs: { namespace: string }[]) => {
   calls.push(refs)
   return refs[0]?.namespace === 'Model' ? [{ entityId: 'Nova', fields: { Model: 'Assets/Nova.m3',
    FacialController: 'LocalizedData/Facial/Nova.fxa' } }] : [{ entityId: 'Line007', fields: { AssetArray: assets } }]
  } },
 } as unknown as InspectionContext
 return { source: createCutsceneWorldSource(context, () => compiled), calls }
}

it('binds nested speech to its actor, catalog controller and exact indexed Sound assets', async () => {
 const { source, calls } = make()
 const result = await source.facialAt(1500)
 expect(result.lines).toHaveLength(1)
 expect(result.lines[0]).toMatchObject({ actorGuid: 'actor', soundLink: 'Line007', elapsedSeconds: .5,
  facialGroup: 'AuthoredGroup', facialAnimation: 'AuthoredAnim', authoredOffsets: { durationOffset: '400' },
  controller: { logicalId: 'base.sc2assets/LocalizedData/Facial/Nova.fxa', source: 'CModel.FacialController' },
  assets: [{ index: '7', facialFile: 'LocalizedData/Sounds/Line007.fxe', facialGroup: 'CatalogGroup' }] })
 expect(calls).toEqual([[{ namespace: 'Model', entityId: 'Nova' }], [{ namespace: 'Sound', entityId: 'Line007' }]])
 expect(result).toMatchObject({ graphEvaluated: false, bonePosesApplied: false, completeness: 'partial' })
 expect(result.lines[0]!.diagnostics.some(d => d.includes('offsets'))).toBe(true)
})

it('retains every sound variation, uses explicit FXA override and half-open speech intervals', async () => {
 const { source } = make(scene('fxaOverride="LocalizedData/Facial/Other.fxa"'),
  [{ FacialFile: 'a.fxe' }, { FacialFile: 'b.fxe', Weight: 4 }])
 expect((await source.facialAt(3000)).lines).toEqual([])
 const line = (await source.facialAt(2999)).lines[0]!
 expect(line.controller?.source).toBe('actor.fxaOverride')
 expect(line.assets.map(a => a.facialFile)).toEqual(['a.fxe', 'b.fxe'])
 expect(line.diagnostics.some(d => d.includes('ambiguous'))).toBe(true)
})

it('does not guess missing facial files and propagates cancellation and invalid time', async () => {
 const { source } = make(scene(), [{ File: 'sound.ogg' }])
 expect((await source.facialAt(1500)).lines[0]!.assets[0]!.facialFile).toBeNull()
 const controller = new AbortController(); controller.abort()
 await expect(source.facialAt(1500, controller.signal)).rejects.toThrow()
 await expect(source.facialAt(-1)).rejects.toThrow()
})
