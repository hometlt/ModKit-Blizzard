/** Adapter tests exercise native XML→catalog port→shared world, with no game data reader. */
import { expect, it } from 'vitest'
import type { InspectionContext } from '@modkit/codec-kit'
import { decodeCutsceneText } from '../codecs/cutscene/src/decode.js'
import { compileCutscene } from '../codecs/cutscene/src/evaluate.js'
import { createCutsceneWorldSource } from '../codecs/cutscene/src/world.js'
import { cutsceneFlagValue, flagOf } from '../codecs/cutscene/src/model.js'
it('distinguishes omitted catalog rotation from explicit zero without rotating raw actors', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeActor guid="omitted" modelLink="Communicator"/>
    <CCutsceneNodeActor guid="zero" modelLink="Portrait" rotation="0,0,0"/>
    <CCutsceneNodeActor guid="minus90" modelLink="Portrait" rotation="0,0,-90"/>
    <CCutsceneNodeActor guid="raynor" modelLink="Raynor" rotation="0,0,270"/>
    <CCutsceneNodeActor guid="raw" modelPath="Assets/Raw.m3" rotation="0,0,0"/>
    <CCutsceneNodeActor guid="empty" modelLink=" " rotation="0,0,0"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'native-default' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const before = compiled.sceneAt(0)
  const frame = await createCutsceneWorldSource(context, () => compiled).frame!(0)
  const expected = [[1, 0, 0], [0, 0, -1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]]
  expect(frame.objects).toHaveLength(expected.length)
  frame.objects.forEach((object, index) => {
    const [x, y, z, w] = object.uvwRotation!
    expect([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)])
      .toEqual(expected[index]!.map(value => expect.closeTo(value, 12)))
  })
  expect(compiled.sceneAt(0)).toEqual(before)
  expect(before.nodes.find(node => node.guid === 'omitted')!.attributes['rotation']).toBeUndefined()
  expect(before.nodes.find(node => node.guid === 'zero')!.attributes['rotation']).toBe('0,0,0')
})

it('applies native bearing after evaluated axis curves while missing axes retain schema defaults', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeActor guid="curve" modelLink="Portrait" rotation="0,0,270">
      <CCutsceneNodePropertyValue propertyName="rotationZ"><CCutsceneElementPropertyCurve time="0" value="0" curveOutValue="250,45" curveOutType="3"/><CCutsceneElementPropertyCurve time="1000" value="180" curveInValue="750,135" curveInType="3"/></CCutsceneNodePropertyValue>
    </CCutsceneNodeActor>
    <CCutsceneNodeActor guid="onlyX" modelLink="Portrait" rotationX="90"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'native-axis-curve' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const source = createCutsceneWorldSource(context, () => compiled)
  for (const [time, expected] of [[0, [0, 0, -1]], [500, [-1, 0, 0]], [1000, [0, 0, 1]]] as const) {
    const frame = await source.frame!(time)
    const [x, y, z, w] = frame.objects[0]!.uvwRotation!
    expect([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)])
      .toEqual(expected.map(value => expect.closeTo(value, 12)))
    const [a, b, c, d] = frame.objects[1]!.uvwRotation!
    expect([1 - 2 * (a * a + c * c), 2 * (b * c + a * d)])
      .toEqual([expect.closeTo(0, 12), expect.closeTo(1, 12)])
  }
})

it('keeps the same native bearing for geometry and hidden embedded-camera owners in mixed axes', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeDirector><CCutsceneElementActiveCamera objectGuid="camera"/></CCutsceneNodeDirector>
    <CCutsceneNodeActor guid="actor" modelLink="Portrait" rotation="90,0,0"/>
    <CCutsceneNodeActor guid="camera" modelLink="Camera" visible="0" rotation="90,0,0"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'native-bearing-camera' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const frame = await createCutsceneWorldSource(context, () => compiled).frame!(0)
  expect(frame.objects).toHaveLength(2)
  expect(frame.objects[0]!.uvwRotation).toEqual(frame.objects[1]!.uvwRotation)
  const [x, y, z, w] = frame.objects[0]!.uvwRotation!
  // Native Rz(90) then Rx(90) maps +X to +Z, which is UVW +Y.
  expect([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)])
    .toEqual([expect.closeTo(0, 12), expect.closeTo(1, 12), expect.closeTo(0, 12)])
  expect(frame.modelCamera?.objectId).toBe(frame.objects[1]!.objectId)
})
it('shares native and evaluated visibility flags while preserving unknown and negative-one states', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeActor guid="false" visible="false"/>
    <CCutsceneNodeActor guid="true" visible="true"/>
    <CCutsceneNodeActor guid="decimal-zero" visible="0.000000"/>
    <CCutsceneNodeActor guid="negative" visible="-1"/>
    <CCutsceneNodeActor guid="unknown" visible="invalid"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'flags' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  expect((await createCutsceneWorldSource(context, () => compiled).frame!(0)).objects.map(object => object.sourceKey))
    .toEqual(['true', 'negative', 'unknown'])
  for (const [value, state] of [[0, 'off'], [1, 'on'], [-1, 'negative-one'], [4294967295, 'negative-one'], [0.5, 'unknown']] as const)
    expect(cutsceneFlagValue(value)).toBe(state)
  for (const value of ['0', '1', 'false', 'true', '-1', '4294967295', '', 'invalid']) {
    const actor = decodeCutsceneText(`<CutsceneState><CCutsceneNodeActor visible="${value}"/></CutsceneState>`).root.children[0]!
    expect(flagOf(actor, 'visible')).toBe(cutsceneFlagValue(value))
  }
})
it('retains invisible gaze dependencies in native state and reports model aiming instead of rotating the actor', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeActor guid="speaker" rotation="0,0,-265"><CCutsceneNodeLookAt>
      <CCutsceneElementLookAt duration="100" lookAtGUID="guide" lookAtType="InstantStanding" lookAtAttachId="Origin"/>
    </CCutsceneNodeLookAt></CCutsceneNodeActor>
    <CCutsceneNodeActor guid="guide" visible="0" position="1,2,3"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'gaze' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const source = createCutsceneWorldSource(context, () => compiled)
  const frame = await source.frame!(50)
  expect(frame.objects.map(object => object.sourceKey)).toEqual(['speaker'])
  expect(compiled.sceneAt(50).lookAts[0]).toMatchObject({ state: 'resolved-target', targetProperties: { position: '1,2,3', visible: '0' } })
  expect(frame.diagnostics.some(diagnostic => diagnostic.code.endsWith('look-at-pose-required'))).toBe(true)
  expect((await source.frame!(100)).diagnostics.some(diagnostic => diagnostic.code.endsWith('look-at-pose-required'))).toBe(false)
  expect((await source.frame!(100)).objects[0]!.uvwRotation).toEqual(frame.objects[0]!.uvwRotation)
})
it('uses authored actor tint through the shared contract and reports missing opacity/HDR without clamping', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeActor guid="glare" tintColorRed="0" tintColorGreen="0.588235" opacity="0.1"/>
    <CCutsceneNodeActor guid="hdr" tintColorRed="1.960784"/>
    <CCutsceneNodeActor guid="plain"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'tint' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const frame = await createCutsceneWorldSource(context, () => compiled).frame!(0)
  expect(frame.objects[0]?.presentationTint).toEqual([0, 0.588235, 1])
  expect(frame.objects[1]?.presentationTint).toBeUndefined()
  expect(frame.objects[2]?.presentationTint).toBeUndefined()
  expect(frame.diagnostics.some(d => d.code.endsWith('actor-opacity-required'))).toBe(true)
  expect(frame.diagnostics.some(d => d.code.endsWith('actor-tint-unsupported'))).toBe(true)
})
it('selects actor shots while retaining authored resources and a model-camera pose carrier', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeDirector><CCutsceneElementActiveCamera objectGuid="a"/></CCutsceneNodeDirector>
    <CCutsceneNodeActor guid="a" visible="0"><CCutsceneNodeActiveShot cameraGUID="other"/></CCutsceneNodeActor>
    <CCutsceneNodeActor guid="unassigned"/>
    <CCutsceneNodeActor guid="match"><CCutsceneNodeActiveShot cameraGUID="a"/></CCutsceneNodeActor>
    <CCutsceneNodeActor guid="wrong"><CCutsceneNodeActiveShot cameraGUID="a" cameraIndex="1"/></CCutsceneNodeActor>
    <CCutsceneNodeFolder><CCutsceneNodeActiveShot cameraGUID="other"/><CCutsceneNodeActor guid="nested"/></CCutsceneNodeFolder>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'shots' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const source = createCutsceneWorldSource(context, () => compiled)
  expect((await source.frame!(0)).objects.map(node => node.sourceKey)).toEqual(['a', 'unassigned', 'match'])
  expect((await source.page({ facet: 'resources', limit: 20 })).items).toHaveLength(5)
  expect(compiled.sceneAt(0).nodes.filter(node => node.kind === 'Actor')).toHaveLength(5)
})

it('publishes authored actor team RGB through the existing world material contract', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeActor guid="actor" teamColorDiffuse="0.1,0.2,0.3,1"/>
    <CCutsceneNodeActor guid="plain"/>
    <CCutsceneNodeActor guid="invalid" teamColorDiffuse="NaN,0,1,1"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'colors' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const frame = await createCutsceneWorldSource(context, () => compiled).frame!(0)
  expect(frame.objects).toHaveLength(3)
  expect(frame.objects[0]?.presentationTeamColor).toEqual([0.1, 0.2, 0.3])
  expect(frame.objects[1]?.presentationTeamColor).toBeUndefined()
  expect(frame.objects[2]?.presentationTeamColor).toBeUndefined()
})

it('loads resolved required animations and explicit M3A through one model acquisition', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeActor guid="actor" modelLink="Character">
      <CCutsceneNodeM3A filePath="Assets/Body.m3a"/>
      <CCutsceneNodeM3A filePath="Assets/Extra.m3a"/>
    </CCutsceneNodeActor></CutsceneState>`))
  let request: unknown
  const context = { input: { revisions: { revision: 'animations' } }, primary: { source: { id: 'scene' } },
    catalog: { entities: async () => [{ entityId: 'Character', fields: {
      Model: 'Assets/Character.m3', FacialController: 'LocalizedData\\Facial\\Character.fxa',
      RequiredAnims: [{ index: '0', value: 'Assets\\Body.m3a' }, { index: '1', value: 'Assets/Face.m3a' }],
    } }] },
    modelResources: { acquire: async (value: unknown) => { request = value; throw new Error('captured model request') } },
  } as unknown as InspectionContext
  const source = createCutsceneWorldSource(context, () => compiled)
  const page = await source.page({ facet: 'resources', limit: 10 })
  expect((await source.facialResources())[0]).toMatchObject({ namespace: 'FaceFX', kind: 'media',
    uri: 'LocalizedData/Facial/Character.fxa', resolved: false })
  await expect(source.model!(page.items[0]!.id, { maxBytes: 67108864, maxMeshes: 256,
    maxPrimitives: 512, maxPrimitiveBytes: 67108864 })).rejects.toThrow('captured model request')
  expect(request).toMatchObject({ animationResources: [
    { logicalId: 'base.sc2assets/Assets/Body.m3a' },
    { logicalId: 'base.sc2assets/Assets/Face.m3a' },
    { logicalId: 'base.sc2assets/Assets/Extra.m3a' },
  ] })
})

it('omits explicitly hidden actors using evaluated visibility, but keeps model-camera pose', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeDirector><CCutsceneElementActiveCamera start="0" objectGuid="camera"/></CCutsceneNodeDirector>
    <CCutsceneNodeActor guid="camera" visible="0"><CCutsceneNodeAnimLayer><CCutsceneElementAnim duration="1000" anim="Stand"/></CCutsceneNodeAnimLayer></CCutsceneNodeActor>
    <CCutsceneNodeActor guid="hidden" visible="0"/>
    <CCutsceneNodeActor guid="zero" opacity="0"/>
    <CCutsceneNodeActor guid="partial" opacity="0.5"/>
    <CCutsceneNodeActor guid="default"/>
    <CCutsceneNodeActor guid="empty" opacity=" "/>
    <CCutsceneNodeActor guid="invalid" opacity="invalid"/>
    <CCutsceneNodeActor guid="dynamic"><CCutsceneNodePropertyValue propertyName="visible">
      <CCutsceneElementPropertyValue start="100" duration="200" value="0"/>
    </CCutsceneNodePropertyValue></CCutsceneNodeActor>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'visibility' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const source = createCutsceneWorldSource(context, () => compiled)
  expect((await source.frame!(0)).objects.map(o => o.sourceKey)).toEqual(['camera', 'partial', 'default', 'empty', 'invalid', 'dynamic'])
  const frame = await source.frame!(150)
  expect(frame.objects.map(o => o.sourceKey)).toEqual(['camera', 'partial', 'default', 'empty', 'invalid'])
  expect(frame.animationTimes).toHaveLength(1)
  expect(frame.modelCamera?.objectId).toBe(frame.objects[0]!.objectId)
  expect(frame.diagnostics.some(d => d.code.endsWith('hidden-camera-carrier'))).toBe(true)
  expect(compiled.sceneAt(150).nodes.filter(n => n.kind === 'Actor')).toHaveLength(8)
})

it('samples independent frames and shares catalog naming with map models', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeDirector><CCutsceneElementActiveCamera start="0" objectGuid="cam"/></CCutsceneNodeDirector>
    <CCutsceneNodeTargetCamera guid="cam" eyePositionX="1" eyePositionY="2" eyePositionZ="3"
      targetPositionX="4" targetPositionY="5" targetPositionZ="6" roll="90" fov="60" verticalFOV="1" nearClip="0.01" farClip="100"/>
    <CCutsceneNodeActor guid="88887510210754684308" modelLink="Ship" position="2,3,4" scale="1,2,3" variation="9">
      <CCutsceneElementObject start="100" duration="900"/>
      <CCutsceneNodeAnimLayer><CCutsceneElementAnim start="100" duration="900" anim="Walk" looping="1"/></CCutsceneNodeAnimLayer>
    </CCutsceneNodeActor></CutsceneState>`))
  let requests = 0
  const context = { input: { revisions: { revision: 'r1' } }, primary: { source: { id: 'scene' } },
    catalog: { entities: async (refs: unknown) => { requests++; expect(refs).toEqual([{ namespace: 'Model', entityId: 'Ship' }]);
      return [{ namespace: 'Model', entityId: 'Ship', fields: { Model: 'Assets\\Ship.m3', VariationCount: 3 } }] } },
  } as unknown as InspectionContext
  const source = createCutsceneWorldSource(context, () => compiled)
  const [a, b] = await Promise.all([source.frame!(550), source.frame!(1000)])
  expect(a.objects).toHaveLength(1)
  expect(b.objects).toHaveLength(0)
  expect(a.objects[0]).toMatchObject({ uvwPosition: { x: 2, y: 4, z: -3 }, uvwScale: { x: 1, y: 3, z: 2 } })
  expect(a.animationTimes?.[0]?.seconds).toBe(0)
  expect(a.objects[0]!.presentationAnimation?.layers?.[0]?.timeSeconds).toBe(0.45)
  expect(a.camera).toMatchObject({ eye: [1, 3, -2], target: [4, 6, -5], up: [0, 1, 0],
    verticalFieldOfView: Math.PI / 3, roll: Math.PI / 2, near: 0.01, far: 100 })
  expect(requests).toBe(0) // Sampling never waits for catalog/model I/O.
  expect(await source.frame!(550)).toEqual(a)
  const page = await source.page({ facet: 'resources', limit: 10 })
  expect(page.items[0]).toMatchObject({ modelResource: { logicalId: 'base.sc2assets/Assets/Ship_02.m3' } })
  expect(requests).toBe(1)
  await expect(source.frame!(-1)).rejects.toThrow()
})

it('does not fabricate model cameras or machine-local model paths', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeDirector><CCutsceneElementActiveCamera start="0" objectGuid="actor"/></CCutsceneNodeDirector>
    <CCutsceneNodeActor guid="actor" modelLink="Missing" modelPath="C:\\artist\\model.m3"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'r2' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const source = createCutsceneWorldSource(context, () => compiled)
  const frame = await source.frame!(0)
  expect(frame.camera).toBeUndefined()
  expect(frame.complete).toBe(false)
  expect((await source.page({ facet: 'resources', limit: 10 })).items[0]).toMatchObject({ resolved: false })
  expect(frame.diagnostics.some(item => item.code.endsWith('model-camera-required'))).toBe(true)
})


it('preserves authored lens axis and conjugates native rotation without a facing offset', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeDirector><CCutsceneElementActiveCamera start="0" objectGuid="cam"/></CCutsceneNodeDirector>
    <CCutsceneNodeTargetCamera guid="cam" eyePosition="0,-2,1" targetPosition="0,0,0"
      fov="60" nearClip="0.01" farClip="100"/>
    <CCutsceneNodeActor guid="east" rotation="0,0,0"/>
    <CCutsceneNodeActor guid="north" rotation="0,0,90"/>
    <CCutsceneNodeActor guid="default"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'r3' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const frame = await createCutsceneWorldSource(context, () => compiled).frame!(0)
  expect(frame.camera?.horizontalFieldOfView).toBeCloseTo(Math.PI / 3)
  expect(frame.camera?.verticalFieldOfView).toBeUndefined()
  // Native +Z rotation becomes UVW +Y rotation: +X turns towards -Z.
  const [x, y, z, w] = frame.objects[1]!.uvwRotation!
  expect([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)])
    .toEqual([expect.closeTo(0, 12), expect.closeTo(0, 12), expect.closeTo(-1, 12)])
  expect(frame.objects[0]!.uvwRotation).toEqual([0, 0, -0, 1])
  expect(frame.objects[2]!.uvwRotation).toEqual(frame.objects[0]!.uvwRotation)
})


it('composes SC2Cutscene mixed axes in native order for actors and hidden model-camera carriers', async () => {
  const compiled = compileCutscene(decodeCutsceneText(`<CutsceneState>
    <CCutsceneNodeDirector><CCutsceneElementActiveCamera objectGuid="camera"/></CCutsceneNodeDirector>
    <CCutsceneNodeActor guid="actor" rotation="90,0,90"/>
    <CCutsceneNodeActor guid="camera" visible="0" rotationX="90" rotationZ="90"/>
    </CutsceneState>`))
  const context = { input: { revisions: { revision: 'mixed-axes' } }, primary: { source: { id: 'scene' } } } as unknown as InspectionContext
  const frame = await createCutsceneWorldSource(context, () => compiled).frame!(0)
  for (const object of frame.objects) {
    const [x, y, z, w] = object.uvwRotation!
    // Z then X in native space cycles UVW +X→+Y, +Y→+Z, +Z→+X.
    expect([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)])
      .toEqual([expect.closeTo(0, 12), expect.closeTo(1, 12), expect.closeTo(0, 12)])
    expect([2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)])
      .toEqual([expect.closeTo(0, 12), expect.closeTo(0, 12), expect.closeTo(1, 12)])
    expect([2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)])
      .toEqual([expect.closeTo(1, 12), expect.closeTo(0, 12), expect.closeTo(0, 12)])
  }
  expect(frame.objects).toHaveLength(2)
  expect(frame.diagnostics.some(diagnostic => diagnostic.code.endsWith('hidden-camera-carrier'))).toBe(true)
  expect(frame.modelCamera?.objectId).toBe(frame.objects[1]!.objectId)
})

it('opens legacy ActorState through the same owner and keeps explicit models and camera identity', async () => {
  const compiled=compileCutscene(decodeCutsceneText(`<ActorState><ActorNode name="Cam_Export" model="Assets/Camera.m3" enabled="true" position="64,64,0" facing="0">
    <AnimLayerNode><AnimBlock anim="Dialogue 04" time="1000" duration="2000"/></AnimLayerNode></ActorNode>
    <ActorNode name="Disabled" model="Assets/Other.m3" enabled="false"/></ActorState>`))
  const context={input:{revisions:{revision:'legacy'}},primary:{source:{id:'legacy'}}} as unknown as InspectionContext
  const source=createCutsceneWorldSource(context,()=>compiled)
  const frame=await source.frame!(1500)
  expect(frame.objects).toHaveLength(1)
  expect(frame.objects[0]).toMatchObject({name:'Cam_Export',uvwPosition:{x:64,y:0,z:-64}})
  expect(frame.objects[0]!.uvwRotation).toEqual([0, 0, -0, 1])
  expect(frame.animationTimes?.[0]?.seconds).toBe(0)
  expect(frame.objects[0]!.presentationAnimation?.layers?.[0]?.timeSeconds).toBe(0.5)
  expect(frame.modelCamera).toMatchObject({objectId:frame.objects[0]!.objectId,cameraIndex:0})
  expect((await source.page({facet:'resources',limit:10})).items[0]).toMatchObject({modelResource:{logicalId:'base.sc2assets/Assets/Camera.m3'}})
})

it('publishes independent scaled clip clocks and omits unsupported weighted clips',async()=>{
 const compiled=compileCutscene(decodeCutsceneText(`<CutsceneState><CCutsceneNodeActor guid="actor"><CCutsceneNodeAnimLayer>
 <CCutsceneElementAnim start="100" duration="1000" anim="Body" timeScale="2" startOffset="50" priority="3" looping="1" weight="1"/>
 <CCutsceneElementAnim start="0" duration="1000" anim="Face" timeScale="0.5" startOffset="100" priority="8"/>
 <CCutsceneElementAnim start="0" duration="1000" anim="Weighted" weight="0.5"/>
 </CCutsceneNodeAnimLayer></CCutsceneNodeActor></CutsceneState>`))
 const context={input:{revisions:{revision:'layer-clocks'}},primary:{source:{id:'scene'}}} as unknown as InspectionContext
 const frame=await createCutsceneWorldSource(context,()=>compiled).frame!(300)
 expect(frame.objects[0]!.presentationAnimation?.layers).toEqual([
 {name:'Body',groups:[],timeSeconds:.45,priority:3,loop:true},
 {name:'Face',groups:[],timeSeconds:.25,priority:8,loop:false}])
 expect(frame.diagnostics.some(d=>d.code.endsWith('animation-weight-unsupported'))).toBe(true)
})


