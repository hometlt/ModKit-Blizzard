/** Native evaluator/controller boundaries: random seek, cuts, enabled layers and bounded loops. */
import { describe, expect, it } from 'vitest'
import { decodeCutsceneText } from '../codecs/cutscene/src/decode.js'
import { encodeCutsceneText } from '../codecs/cutscene/src/encode.js'
import { compileCutscene } from '../codecs/cutscene/src/evaluate.js'
import { advanceCutscene } from '../codecs/cutscene/src/playback.js'

/** Compile a small authored document without filesystem, archives or renderer substitutes. */
function scene(body: string) {
  return compileCutscene(decodeCutsceneText(`<CutsceneState>${body}</CutsceneState>`))
}

const WIDE = '88887510210754684308'

it('publishes native animation release separately from authored occupancy and blend-in', () => {
  const compiled = scene(`<CCutsceneNodeActor guid="raynor"><CCutsceneElementObject duration="3000"/>
    <CCutsceneNodeAnimLayer><CCutsceneElementAnim guid="talk" start="677" duration="1056"
      anim="Talk 05" priority="4" blendTime="500" blendOutTime="450"/>
    </CCutsceneNodeAnimLayer></CCutsceneNodeActor>`)
  const timeline = JSON.stringify(compiled.timeline)
  expect(compiled.sceneAt(676).animationLayers).toEqual([])
  expect(compiled.sceneAt(700).animationLayers[0]).toMatchObject({ phase: 'active', elapsed: 23,
    commandWeight: 1, blendInTimeMs: 500, blendOutTimeMs: 450 })
  const beforeEnd = compiled.sceneAt(1489)
  expect(beforeEnd.animationLayers[0]).toMatchObject({ start: 677, end: 1733, elapsed: 812,
    authoredWeight: 1, releaseWeight: 1, commandWeight: 1 })
  expect(compiled.sceneAt(1733).activeClips.some(clip => clip.guid === 'talk')).toBe(false)
  expect(compiled.sceneAt(1733).animationLayers[0]).toMatchObject({ phase: 'release', commandWeight: 1 })
  expect(compiled.sceneAt(1958).animationLayers[0]).toMatchObject({ phase: 'release', elapsed: 1281,
    releaseWeight: 0.5, commandWeight: 0.5 })
  expect(compiled.sceneAt(2183).animationLayers).toEqual([])
  expect(JSON.stringify(compiled.timeline)).toBe(timeline)
  expect(compiled.sceneAt(1489)).toEqual(beforeEnd)
  expect(Object.isFrozen(beforeEnd.animationLayers)).toBe(true)
  expect(Object.isFrozen(beforeEnd.animationLayers[0])).toBe(true)
})

it('retains authored fractional command weights without normalizing them as pose samples', () => {
  const compiled = scene(`<CCutsceneNodeActor><CCutsceneNodeAnimLayer>
    <CCutsceneElementAnim guid="fractional" start="16385" duration="990" anim="Talk 03"
      weight="0.5" blendTime="1000" blendOutTime="200"/>
    <CCutsceneElementAnim guid="unbounded" duration="20000" weight="2"/>
    <CCutsceneElementAnim guid="zero" duration="20000" weight="0"/>
    </CCutsceneNodeAnimLayer></CCutsceneNodeActor>`)
  const layer = (time: number, guid: string) => compiled.sceneAt(time).animationLayers.find(item => item.guid === guid)
  expect(layer(17000, 'fractional')).toMatchObject({ authoredWeight: 0.5, commandWeight: 0.5, elapsed: 615 })
  expect(layer(17475, 'fractional')).toMatchObject({ releaseWeight: 0.5, commandWeight: 0.25 })
  expect(layer(17575, 'fractional')).toBeUndefined()
  expect(layer(17000, 'unbounded')?.commandWeight).toBe(2)
  expect(layer(17000, 'zero')?.commandWeight).toBe(0)
})

it('keeps zero release half-open and respects disabled parents and actor lifetimes', () => {
  const compiled = scene(`<CCutsceneNodeActor guid="short"><CCutsceneElementObject duration="500"/>
    <CCutsceneNodeAnimLayer><CCutsceneElementAnim guid="limited" start="100" duration="200" blendOutTime="400"/>
    <CCutsceneElementAnim guid="instant-stop" start="100" duration="200"/>
    </CCutsceneNodeAnimLayer></CCutsceneNodeActor>
    <CCutsceneNodeActor enabled="0"><CCutsceneNodeAnimLayer>
    <CCutsceneElementAnim guid="disabled" duration="300" blendOutTime="400"/>
    </CCutsceneNodeAnimLayer></CCutsceneNodeActor>`)
  expect(compiled.sceneAt(299).animationLayers.map(layer => layer.guid)).toEqual(['limited', 'instant-stop'])
  expect(compiled.sceneAt(300).animationLayers.map(layer => layer.guid)).toEqual(['limited'])
  expect(compiled.sceneAt(400).animationLayers[0]?.commandWeight).toBe(0.75)
  expect(compiled.sceneAt(500).animationLayers).toEqual([])
  const point = scene('<CCutsceneNodeActor><CCutsceneElementAnim duration="0" blendOutTime="100"/></CCutsceneNodeActor>')
  expect(point.sceneAt(0).activeClips).toEqual([])
  expect(point.sceneAt(0).animationLayers[0]).toMatchObject({ phase: 'release', commandWeight: 1, blendInTimeMs: null })
  expect(point.sceneAt(50).animationLayers[0]?.commandWeight).toBe(0.5)
  expect(point.sceneAt(100).animationLayers).toEqual([])
})

it.each(['weight="NaN"', 'weight="1e100"', 'blendOutTime="-1"', 'blendOutTime="Infinity"',
  'blendOutTime="1e308"', 'blendOutTime="1e-100"', 'blendTime="NaN"',
  'blendOutTime="2147483648"', 'blendOutTime="100.5"', 'blendTime="2147483648"'])
('refuses an invalid transition without changing authored clips: %s', attributes => {
  const compiled = scene(`<CCutsceneNodeActor><CCutsceneElementAnim duration="100" ${attributes}/></CCutsceneNodeActor>`)
  const frame = compiled.sceneAt(10)
  expect(frame.activeClips).toHaveLength(1)
  expect(frame.animationLayers).toEqual([])
  expect(frame.diagnostics.some(diagnostic => diagnostic.code === 'unsupported-animation-transition')).toBe(true)
})

it.each([
  ['start="2147483640" duration="10"', 2147483641],
  ['duration="2147483648"', 1],
  ['start="-100" duration="2147483647" blendOutTime="100"', 1],
])('refuses signed native time addition/subtraction overflow: %s', (attributes, time) => {
  const compiled = scene(`<CCutsceneNodeActor><CCutsceneElementAnim ${attributes}/></CCutsceneNodeActor>`)
  const frame = compiled.sceneAt(Number(time))
  expect(frame.activeClips).toHaveLength(1)
  expect(frame.animationLayers).toEqual([])
  expect(frame.diagnostics.some(diagnostic => diagnostic.code === 'unsupported-animation-transition')).toBe(true)
})

it.each([10.5, 2147483648])('retains authored time when native command clock is not qualified: %s', time => {
  const compiled = scene('<CCutsceneNodeActor><CCutsceneElementAnim duration="100"/></CCutsceneNodeActor>')
  const frame = compiled.sceneAt(time)
  expect(frame.timeMs).toBe(time)
  expect(frame.animationLayers).toEqual([])
  expect(frame.diagnostics.some(diagnostic => diagnostic.code === 'unsupported-animation-command-clock')).toBe(true)
})

it('resolves active gaze against evaluated invisible guides without replacing actor placement', () => {
  const compiled = scene(`<CCutsceneNodeActor guid="actor" rotationZ="-265">
    <CCutsceneNodeLookAt><CCutsceneElementLookAt start="100" duration="200"
      lookAtGUID="${WIDE}" lookAtType="InstantStanding" lookAtAttachId="Origin" ignoreEyes="1"/>
    </CCutsceneNodeLookAt></CCutsceneNodeActor>
    <CCutsceneNodeActor guid="${WIDE}" visible="0" positionX="1">
      <CCutsceneNodePropertyValue propertyName="positionX"><CCutsceneElementPropertyValue start="120" value="7"/></CCutsceneNodePropertyValue>
    </CCutsceneNodeActor>`)
  expect(compiled.sceneAt(99).lookAts).toEqual([])
  const request = compiled.sceneAt(150).lookAts[0]!
  expect(request).toMatchObject({ ownerStart: compiled.sceneAt(150).nodes[0]!.sourceStart,
    targetGuid: WIDE, type: 'InstantStanding', attachmentId: 'Origin', ignoreEyes: '1',
    state: 'resolved-target', elapsed: 50, targetProperties: { positionX: '7', visible: '0' } })
  expect(compiled.sceneAt(150).nodes[0]!.properties['rotationZ']).toBe('-265')
  expect(compiled.sceneAt(300).lookAts).toEqual([])
  expect(compiled.sceneAt(110).lookAts[0]!.targetProperties!['positionX']).toBe('1')
  expect(compiled.sceneAt(150).lookAts[0]).toEqual(request)
  expect(() => { (request.targetProperties as Record<string, string>)['positionX'] = '99' }).toThrow()
})

it('keeps gaze identity failures explicit and does not resolve disabled or duplicate targets', () => {
  const compiled = scene(`<CCutsceneNodeActor guid="actor"><CCutsceneNodeLookAt>
    <CCutsceneElementLookAt duration="10" lookAtGUID="missing"/>
    <CCutsceneElementLookAt duration="10" lookAtGUID="duplicate"/>
    <CCutsceneElementLookAt duration="10" lookAtGUID="disabled"/>
    <CCutsceneElementLookAt duration="10" lookAtGUID="late"/>
    <CCutsceneElementLookAt enabled="0" duration="10" lookAtGUID="missing"/>
    </CCutsceneNodeLookAt></CCutsceneNodeActor>
    <CCutsceneNodeActor guid="duplicate"/><CCutsceneNodeActor guid="duplicate"/>
    <CCutsceneNodeActor guid="disabled" enabled="0"/>
    <CCutsceneNodeActor guid="late"><CCutsceneElementObject start="20" duration="10"/></CCutsceneNodeActor>
    <CCutsceneNodeLookAt><CCutsceneElementLookAt duration="10" lookAtGUID="duplicate"/></CCutsceneNodeLookAt>`)
  const frame = compiled.sceneAt(1)
  expect(frame.lookAts.map(request => request.state)).toEqual(['unresolved-target', 'ambiguous-target', 'inactive-target', 'inactive-target', 'unresolved-owner'])
  expect(frame.lookAts[1]!.targetStart).toBeNull()
  expect(frame.diagnostics.some(diagnostic => diagnostic.code === 'look-at-ambiguous-target')).toBe(true)
  const bounded = compileCutscene(decodeCutsceneText('<CutsceneState><CCutsceneNodeLookAt><CCutsceneElementLookAt duration="10"/></CCutsceneNodeLookAt></CutsceneState>'), 100, 1).sceneAt(1)
  expect(bounded.diagnostics).toHaveLength(1)
  expect(bounded.omittedDiagnostics).toBeGreaterThan(0)
})
it('holds zero-duration values by resolved time and retains temporary interval overrides', () => {
  const compiled = scene(`<CCutsceneNodeActor guid="actor" visible="0">
    <CCutsceneNodePropertyValue propertyName="visible">
      <CCutsceneElementPropertyValue start="238928" value="1"/>
      <CCutsceneElementPropertyValue start="207668" value="0"/>
      <CCutsceneElementPropertyValue start="300000" duration="100" value="0"/>
    </CCutsceneNodePropertyValue></CCutsceneNodeActor>`)
  const value = (time: number) => compiled.sceneAt(time).nodes[0]!.properties['visible']
  expect(value(207667)).toBe('0')
  expect(value(238927)).toBe('0')
  expect(value(238928)).toBe('1')
  expect(value(300000)).toBe('0')
  expect(value(300100)).toBe('1')
  expect(value(315000)).toBe('1')
  expect(value(238927)).toBe('0')
})

it('selects shot lights, persistent catalog lighting and bounded RTT intervals on random seek', () => {
  const compiled = scene(`<CCutsceneNodeDirector>
    <CCutsceneElementActiveCamera objectGuid="a" cameraIndex="1"/>
    <CCutsceneElementActiveCamera start="500" objectGuid="b"/>
    <CCutsceneNodeActiveLight><CCutsceneElementActiveLight lightID="Exterior"/>
      <CCutsceneElementActiveLight start="300" lightID="Interior" blendTime="0"/>
    </CCutsceneNodeActiveLight></CCutsceneNodeDirector>
    <CCutsceneNodeTargetCamera guid="a"/><CCutsceneNodeTargetCamera guid="b"/>
    <CCutsceneNodeLight guid="shared"/>
    <CCutsceneNodeLight guid="shot"><CCutsceneNodeActiveShot cameraGUID="a" cameraIndex="1"/></CCutsceneNodeLight>
    <CCutsceneNodeLight guid="other-index"><CCutsceneNodeActiveShot cameraGUID="a" cameraIndex="0"/></CCutsceneNodeLight>
    <CCutsceneNodeLight guid="disabled" enabled="0"/>
    <CCutsceneNodeRTTChannel RTTChannel="0"><CCutsceneElementRTTChannel start="100" duration="200" objectGUID="a" cameraIndex="1"/></CCutsceneNodeRTTChannel>
    <CCutsceneNodeRTTChannel RTTChannel="1"><CCutsceneElementRTTChannel start="100" duration="200" objectGUID="missing"/></CCutsceneNodeRTTChannel>`)
  const early = compiled.sceneAt(150)
  expect(early.lights.map(node => node.guid)).toEqual(['shared', 'shot'])
  expect(early.activeLight?.attributes['lightID']).toBe('Exterior')
  expect(early.renderTextures).toHaveLength(2)
  expect(early.renderTextures[0]).toMatchObject({ channel: '0', objectStart: expect.any(Number), attributes: { cameraIndex: '1' } })
  expect(early.renderTextures[1]?.objectStart).toBeNull()
  expect(compiled.sceneAt(300).renderTextures).toHaveLength(0)
  expect(compiled.sceneAt(800).lights.map(node => node.guid)).toEqual(['shared'])
  expect(compiled.sceneAt(800).activeLight?.attributes['lightID']).toBe('Interior')
  expect(compiled.sceneAt(150)).toEqual(early)
})

const ACTOR = `<CCutsceneNodeActor guid="${WIDE}" name="actor" positionX="7">
  <CCutsceneElementObject guid="life" start="100" duration="900"/>
  <CCutsceneNodePropertyValue propertyName="positionX">
    <CCutsceneElementPropertyCurve guid="k0" start="100" time="100" value="10" curveOutValue="400,40" curveOutType="3"/>
    <CCutsceneElementPropertyCurve guid="k1" start="1000" time="1000" value="100" curveInValue="700,70" curveInType="3"/>
    <CCutsceneElementPropertyValue start="600" duration="100" value="99"/>
  </CCutsceneNodePropertyValue>
  <CCutsceneNodeAnimLayer enabled="0"><CCutsceneElementAnim start="100" duration="900" anim="disabled"/></CCutsceneNodeAnimLayer>
</CCutsceneNodeActor>`

describe('compiled SC2 native state', () => {
  it('supports arbitrary seek order, preserves native bytes and wide identity, and expires intervals', () => {
    const document = decodeCutsceneText(`<CutsceneState>${ACTOR}</CutsceneState>`)
    const compiled = compileCutscene(document)
    const before = encodeCutsceneText(document)
    const middle = compiled.sceneAt(550)
    const actor = middle.nodes.find(node => node.guid === WIDE)!
    expect(actor.properties['positionX']).toBeCloseTo(55, 9)
    expect(actor.active).toBe(true)
    expect(compiled.sceneAt(99).nodes[0]!.active).toBe(false)
    expect(compiled.sceneAt(1000).nodes[0]!.active).toBe(false)
    expect(compiled.sceneAt(550)).toEqual(middle)
    expect(middle.activeClips.some(clip => clip.attributes['anim'] === 'disabled')).toBe(false)
    expect(encodeCutsceneText(document)).toBe(before)
    expect(middle.completeness).toBe('partial')
  })

  it('applies a step only within its resolved interval and reports its provisional semantics', () => {
    const compiled = scene(ACTOR)
    expect(compiled.sceneAt(600).nodes[0]!.properties['positionX']).toBe('99')
    expect(compiled.sceneAt(700).nodes[0]!.properties['positionX']).toBeCloseTo(70, 9)
    expect(compiled.sceneAt(600).diagnostics.some(item => item.code === 'step-intervals-provisional')).toBe(true)
  })

  it('resolves anchored intervals through the existing timeline owner', () => {
    const compiled = scene(`<CCutsceneNodeActor><CCutsceneElementObject guid="base" start="100" duration="200"/></CCutsceneNodeActor><CCutsceneNodeActor>
      <CCutsceneNodeAnimLayer><CCutsceneElementAnim startLinkGuid="base" startLinkAttachToPoint="2" startLinkDistance="50" duration="25"/></CCutsceneNodeAnimLayer>
      </CCutsceneNodeActor>`)
    expect(compiled.sceneAt(350).activeClips.find(clip => clip.kind === 'Anim')).toMatchObject({ start: 350, end: 375, elapsed: 0 })
    expect(compiled.sceneAt(375).activeClips.some(clip => clip.kind === 'Anim')).toBe(false)
  })

  it('clips inherited actor/layer activity to the owning object lifetime', () => {
    const compiled = scene(ACTOR.replace('enabled="0"', 'enabled="1"').replace('duration="900" anim="disabled"', 'duration="1900" anim="disabled"'))
    expect(compiled.sceneAt(999).activeClips.some(clip => clip.kind === 'Anim')).toBe(true)
    expect(compiled.sceneAt(1000).activeClips.some(clip => clip.kind === 'Anim')).toBe(false)
    expect(compiled.sceneAt(1000).nodes.find(node => node.kind === 'AnimLayer')?.active).toBe(false)
  })

  it('holds the selected camera until the next cut, including model-camera requests', () => {
    const compiled = scene(`${ACTOR}<CCutsceneNodeTargetCamera guid="camera" fov="45" roll="30"/>
      <CCutsceneNodeDirector><CCutsceneNodeActiveCamera>
        <CCutsceneElementActiveCamera start="100" objectGuid="camera"/>
        <CCutsceneElementActiveCamera start="500" objectGuid="${WIDE}" cameraIndex="2"/>
      </CCutsceneNodeActiveCamera></CCutsceneNodeDirector>`)
    expect(compiled.sceneAt(99).camera).toBeNull()
    expect(compiled.sceneAt(499).camera).toMatchObject({ state: 'native-camera', properties: { fov: '45', roll: '30' } })
    expect(compiled.sceneAt(500).camera).toMatchObject({ state: 'model-camera-required', objectGuid: WIDE, cameraIndex: '2' })
    expect(compiled.sceneAt(499).camera?.objectGuid).toBe('camera')
  })

  it('does not remove a disabled camera or collapse duplicate GUID identities', () => {
    const compiled = scene(`<CCutsceneNodeTargetCamera guid="camera" enabled="0"/>
      <CCutsceneNodeActor guid="duplicate"/><CCutsceneNodeActor guid="duplicate"/>
      <CCutsceneNodeActiveCamera><CCutsceneElementActiveCamera objectGuid="camera"/>
      <CCutsceneElementActiveCamera start="1" objectGuid="duplicate"/></CCutsceneNodeActiveCamera>`)
    expect(compiled.sceneAt(0).camera?.state).toBe('native-camera')
    expect(compiled.sceneAt(1).camera?.state).toBe('unresolved')
    const nodes = compiled.sceneAt(0).nodes.filter(node => node.guid === 'duplicate')
    expect(nodes).toHaveLength(2)
    expect(nodes[0]!.sourceStart).not.toBe(nodes[1]!.sourceStart)
  })

  it('refuses to fabricate sampling for retimed curve keys', () => {
    const compiled = scene(ACTOR.replace('guid="k0" start="100"', 'guid="k0" start="100" startLinkGuid="life" startLinkAttachToPoint="2"'))
    expect(compiled.sceneAt(550).nodes[0]!.properties['positionX']).toBe('7')
    expect(compiled.sceneAt(550).diagnostics.some(item => item.code === 'unsupported-curve-time')).toBe(true)
  })

  it('does not let authored property names modify the result prototype', () => {
    const compiled = scene(ACTOR.replace('propertyName="positionX"', 'propertyName="__proto__"'))
    const properties = compiled.sceneAt(600).nodes[0]!.properties
    expect(Object.getPrototypeOf(properties)).toBeNull()
    expect(properties['__proto__']).toBe('99')
    expect(JSON.parse(JSON.stringify(properties))['__proto__']).toBe('99')
  })

  it('enforces explicit time and compilation/diagnostic budgets', () => {
    const compiled = scene(ACTOR)
    for (const value of [-1, NaN, Infinity, '1', null]) expect(() => compiled.sceneAt(value as number)).toThrow(RangeError)
    const document = decodeCutsceneText(`<CutsceneState>${ACTOR}</CutsceneState>`)
    expect(() => compileCutscene(document, 2)).toThrow(/maxNodes/)
    const bounded = compileCutscene(document, 100, 1).sceneAt(600)
    expect(bounded.diagnostics).toHaveLength(1)
    expect(bounded.omittedDiagnostics).toBeGreaterThan(0)
    expect(() => scene('<CCutsceneNodeActor><CCutsceneElementObject start="1e308" duration="1e308"/></CCutsceneNodeActor>')).toThrow(/finite numeric range/)
  })
})

/** Marker fixture also declares an extent so end-of-document differs from EndScene. */
function marked(markers: string) {
  return scene(`<CCutsceneNodeActor><CCutsceneElementObject duration="1000"/></CCutsceneNodeActor>
    <CCutsceneNodeDirector><CCutsceneNodeBookmark>${markers}</CCutsceneNodeBookmark></CCutsceneNodeDirector>`)
}

describe('SC2 interval traversal without a clock', () => {
  it('does not execute jumps on seek, but preserves elapsed remainder when playing across one', () => {
    const compiled = marked(`<CCutsceneElementBookmark start="1" bookmarkName="from" jumpToBookmarkWhenHit="to"/>
      <CCutsceneElementBookmark start="600" bookmarkName="to"/>
      <CCutsceneElementEndScene start="900"/>`)
    expect(compiled.sceneAt(10).timeMs).toBe(10)
    expect(advanceCutscene(compiled, 0, 100)).toMatchObject({ positionMs: 699, state: 'playing', unconsumedMs: 0 })
    expect(advanceCutscene(compiled, 0, 500)).toMatchObject({ positionMs: 900, state: 'ended', reason: 'end-scene-marker', unconsumedMs: 199 })
  })

  it('handles pause/resume and delivers each ordinary boundary marker once', () => {
    const compiled = marked('<CCutsceneElementBookmark start="100" pauseWhenHit="1"/>')
    expect(advanceCutscene(compiled, 0, 200)).toMatchObject({ positionMs: 100, state: 'paused', unconsumedMs: 100 })
    expect(advanceCutscene(compiled, 100, 50)).toMatchObject({ positionMs: 150, state: 'playing', events: [] })
  })

  it('bounds zero-time and backwards jump loops', () => {
    const self = marked('<CCutsceneElementBookmark bookmarkName="self" jumpToBookmarkWhenHit="self"/>')
    const stopped = advanceCutscene(self, 0, 10, { includeStart: true, maxTransitions: 4 })
    expect(stopped).toMatchObject({ state: 'blocked', reason: 'marker-transition-budget', positionMs: 0 })
    expect(stopped.events).toHaveLength(4)
    const loop = marked('<CCutsceneElementBookmark bookmarkName="start"/><CCutsceneElementBookmark start="10" jumpToBookmarkWhenHit="start"/>')
    expect(advanceCutscene(loop, 0, 100, { maxTransitions: 3 }).state).toBe('blocked')
  })

  it('reports ambiguous controls and missing jump targets rather than guessing', () => {
    const missing = marked('<CCutsceneElementBookmark start="5" jumpToBookmarkWhenHit="absent"/>')
    expect(advanceCutscene(missing, 0, 10).reason).toBe('missing-bookmark')
    const ambiguous = marked('<CCutsceneElementBookmark start="5" pauseWhenHit="1"/><CCutsceneElementEndScene start="5"/>')
    expect(advanceCutscene(ambiguous, 0, 10).reason).toBe('simultaneous-control-markers')
    const unresolved = marked('<CCutsceneElementBookmark start="5" startLinkGuid="missing" pauseWhenHit="1"/>')
    expect(advanceCutscene(unresolved, 0, 10).reason).toBe('unresolved-timeline')
  })
})

it('keeps exact keys and good segments when another interval has stale controls', () => {
  const body = '<CCutsceneNodeActor positionX="7"><CCutsceneNodePropertyValue propertyName="positionX">'
    + '<CCutsceneElementPropertyCurve time="0" value="10" curveOutValue="-1,40"/>'
    + '<CCutsceneElementPropertyCurve time="100" value="20" curveInValue="70,15" curveOutValue="133.333333,30"/>'
    + '<CCutsceneElementPropertyCurve time="200" value="50" curveInValue="166.666667,40"/>'
    + '</CCutsceneNodePropertyValue></CCutsceneNodeActor>'
  const compiled = scene(body)
  const at = (t: number) => compiled.sceneAt(t).nodes[0]!.properties['positionX']
  expect(at(50)).toBe('7')
  expect(at(100)).toBe(20)
  expect(at(150)).toBeCloseTo(35, 7)
  expect(at(0)).toBe(10)
  expect(at(200)).toBe(50)
  expect(at(300)).toBe(50)
  expect(at(50)).toBe('7')
  expect(compiled.sceneAt(300).diagnostics.some(d => d.code === 'unsupported-curve-time')).toBe(true)
})

it('still refuses duplicate, unordered and malformed keys even at endpoints', () => {
  for (const key of ['time="0" value="30"', 'time="-1" value="30"', 'time="bad" value="30"', 'time="1" value="bad"']) {
    const compiled = scene('<CCutsceneNodeActor positionX="7"><CCutsceneNodePropertyValue propertyName="positionX">'
      + '<CCutsceneElementPropertyCurve time="0" value="10"/>'
      + '<CCutsceneElementPropertyCurve ' + key + '/></CCutsceneNodePropertyValue></CCutsceneNodeActor>')
    expect(compiled.sceneAt(1000).nodes[0]!.properties['positionX']).toBe('7')
  }
})
