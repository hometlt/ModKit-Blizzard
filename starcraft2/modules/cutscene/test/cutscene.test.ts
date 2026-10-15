/**
 * The cutscene module: what it keeps, what it refuses, and what it declines to guess.
 *
 * The tests here are the ones that would have caught a real defect. Three of them did, during
 * development: the writer collapsed a double space between two attributes, dropped a byte order
 * mark, and re-indented a hand-edited Heroes file — each a handful of bytes, each invisible to any
 * check short of comparing the whole file, and each caught by the round trip.
 *
 * The corpus itself is exercised separately, in `sc2-cutscene-corpus.test.ts`, so this file stays
 * runnable without an installed game.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'

import { createCodec } from '../codecs/cutscene/src/codec.js'
import { curveChannelsOf, curveSummary, sampleChannel, tangentModeOf } from '../codecs/cutscene/src/curves.js'
import { CutsceneParseError, decodeCutsceneText, looksLikeCutscene } from '../codecs/cutscene/src/decode.js'
import { encodeCutsceneText } from '../codecs/cutscene/src/encode.js'
import { flagOf, walk } from '../codecs/cutscene/src/model.js'
import { includedCutscenes, referenceGroups } from '../codecs/cutscene/src/refs.js'
import { roleOf, tagsOnlyIn } from '../codecs/cutscene/src/registry.js'
import { resolveTimeline } from '../codecs/cutscene/src/timeline.js'
import { findingsOf, validateCutscene } from '../codecs/cutscene/src/validate.js'

const NL = '\n'
const encoder = new TextEncoder()

/*
 * A miniature scene with the shape of a real one: a director track with a master sound and a
 * bookmark, an actor with an animation layer and an animated property, and one anchored clip.
 * The identifiers are the two that matter — one ordinary, one wider than `uint64`.
 */
const WIDE_GUID = '88887510210754684308'
const SCENE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<CutsceneState cutsceneVersion="1.300000">',
  '    <CCutsceneNodeDirector guid="12196358481196792412" name="Director" sortIndex="0">',
  '        <CCutsceneNodeMasterSound guid="12975843368374286940" name="Master" soundLink="Zerg01_ME" assetDuration="0">',
  '            <CCutsceneElementObject guid="6553291072281164380" start="0" duration="8000"/>',
  '        </CCutsceneNodeMasterSound>',
  '        <CCutsceneNodeBookmark guid="1111111111111111111" name="Bookmarks" sortIndex="1">',
  '            <CCutsceneElementBookmark guid="2222222222222222222" start="4000" bookmarkName="Midpoint" pauseWhenHit="1"/>',
  '        </CCutsceneNodeBookmark>',
  '    </CCutsceneNodeDirector>',
  `    <CCutsceneNodeActor guid="${WIDE_GUID}" name="Kerrigan" modelLink="KerriganPrimal" modelPath="Assets\\Units\\Zerg\\Kerrigan">`,
  '        <CCutsceneElementObject guid="3333333333333333333" start="0" duration="8000" lockedToEnd="1"/>',
  '        <CCutsceneNodeAnimLayer guid="4444444444444444444" name="Animation Layer" sortIndex="0">',
  '            <CCutsceneElementAnim guid="5555555555555555555" start="1000" duration="2000" anim="Zerg01_005"/>',
  '        </CCutsceneNodeAnimLayer>',
  '        <CCutsceneNodeConversation guid="6666666666666666666" name="Speech">',
  '            <CCutsceneElementConversation guid="7777777777777777777" start="0" duration="1200" enabled="-1" soundLink="zBriefing_MiraHan_002" facialGroup="zBriefing_MiraHan_002" facialAnim="1200"/>',
  '        </CCutsceneNodeConversation>',
  '        <CCutsceneNodePropertyValue guid="8888888888888888888" name="positionX" propertyName="positionX">',
  '            <CCutsceneElementPropertyCurve guid="9999999999999999999" start="0" value="0.000000" time="0" curveInValue="-1.000000,0.000000" curveOutValue="106.666672,0.000000" curveOutType="3" curveInType="3" />',
  '            <CCutsceneElementPropertyCurve guid="1010101010101010101" start="2000" value="4.000000" time="2000" curveInValue="380.637390,4.000000" curveOutValue="1029.334106,4.000000" curveOutType="7" curveInType="7" />',
  '        </CCutsceneNodePropertyValue>',
  '        <CCutsceneNodeLookAt guid="1212121212121212121" name="Look At">',
  '            <CCutsceneElementLookAt guid="1313131313131313131" startLinkGuid="5555555555555555555" startLinkAttachToPoint="2" startLinkDistance="500" duration="300" lookAtGUID="6666666666666666666"/>',
  '        </CCutsceneNodeLookAt>',
  '    </CCutsceneNodeActor>',
  '    <CCutsceneNodeFolder guid="1414141414141414141" name="Shared cameras" referenceFile="Cutscenes/Conversations_Cameras.SC2Cutscene" referenceGuid="1515151515151515151"/>',
  '</CutsceneState>',
].join(NL)

describe('sc2-cutscene reader and writer', () => {
  it('rewrites a document byte for byte', () => {
    expect(encodeCutsceneText(decodeCutsceneText(SCENE))).toBe(SCENE)
  })

  /*
   * The three defects the corpus found, as unit cases. Each is a few bytes, and each survived a
   * "looks the same" reading of the output.
   */
  it('keeps a byte order mark, a doubled attribute space and irregular indentation', () => {
    const withBom = `﻿${SCENE}`
    expect(encodeCutsceneText(decodeCutsceneText(withBom))).toBe(withBom)

    const doubled = SCENE.replace('name="Director" sortIndex', 'name="Director"  sortIndex')
    expect(encodeCutsceneText(decodeCutsceneText(doubled))).toBe(doubled)

    const misindented = SCENE.replace(
      '    <CCutsceneNodeFolder guid="1414',
      '\t\t<CCutsceneNodeFolder guid="1414',
    )
    expect(encodeCutsceneText(decodeCutsceneText(misindented))).toBe(misindented)
  })

  it('keeps a trailing newline, and its absence', () => {
    expect(encodeCutsceneText(decodeCutsceneText(`${SCENE}${NL}`))).toBe(`${SCENE}${NL}`)
    expect(encodeCutsceneText(decodeCutsceneText(SCENE)).endsWith('>')).toBe(true)
  })

  it('keeps an entity exactly as written while reporting what it means', () => {
    const quoted = SCENE.replace('bookmarkName="Midpoint"', 'bookmarkName="&quot;Midpoint&quot;"')
    const document = decodeCutsceneText(quoted)
    const bookmark = [...walk(document.root)].find(
      element => element.tag === 'CCutsceneElementBookmark',
    )
    const attribute = bookmark?.attributes.find(item => item.name === 'bookmarkName')
    expect(attribute?.value).toBe('"Midpoint"')
    expect(attribute?.raw).toBe('&quot;Midpoint&quot;')
    expect(encodeCutsceneText(document)).toBe(quoted)
  })

  /*
   * The identifier rule, stated as an assertion rather than a comment. 3 % of shipped identifiers
   * are past `uint64` and all of them are past `2^53`, so a reader that produced a number here
   * would corrupt every reference to this actor while looking entirely healthy.
   */
  it('carries an identifier no integer type can hold, unchanged', () => {
    const document = decodeCutsceneText(SCENE)
    const actor = [...walk(document.root)].find(element => element.tag === 'CCutsceneNodeActor')
    const guid = actor?.attributes.find(item => item.name === 'guid')?.value
    expect(guid).toBe(WIDE_GUID)
    expect(typeof guid).toBe('string')
    expect(BigInt(guid as string) > 18446744073709551615n).toBe(true)
    // What a `Number` would have cost: this identifier and a different one collapse onto the same
    // double, so every reference to one would have silently become a reference to the other.
    expect(Number(WIDE_GUID)).toBe(Number(`${WIDE_GUID.slice(0, -1)}9`))
  })

  it('refuses what it cannot write back, naming where', () => {
    expect(() => decodeCutsceneText(SCENE.replace('<CutsceneState', '<!-- note -->\n<CutsceneState')))
      .toThrow(CutsceneParseError)
    expect(() => decodeCutsceneText('<?xml version="1.0"?>\n<StyleFile/>')).toThrow(/root element/u)
    expect(() =>
      decodeCutsceneText(SCENE.replace('</CutsceneState>', 'stray text</CutsceneState>')),
    ).toThrow(/text content/u)
  })

  it('reads a document with no version, which five shipped files are', () => {
    const document = decodeCutsceneText(SCENE.replace(' cutsceneVersion="1.300000"', ''))
    expect(document.version).toBeUndefined()
    expect(findingsOf(validateCutscene(document)).map(item => item.code)).toContain('version-absent')
  })

  it('reads the three-state flag the format actually uses', () => {
    const document = decodeCutsceneText(SCENE)
    const line = [...walk(document.root)].find(
      element => element.tag === 'CCutsceneElementConversation',
    )
    expect(flagOf(line as never, 'enabled')).toBe('negative-one')
    expect(flagOf(line as never, 'missing')).toBe('unknown')
  })
})

describe('sc2-cutscene analysis', () => {
  it('reports a reference that names nothing here as a warning, not a refusal', () => {
    const orphan = SCENE.replace('startLinkGuid="5555555555555555555"', 'startLinkGuid="404404404404404404"')
    const report = validateCutscene(decodeCutsceneText(orphan))
    expect(report.danglingReferences.map(item => item.attribute)).toEqual(['startLinkGuid'])
    const findings = findingsOf(report)
    expect(findings.find(item => item.code === 'unresolved-reference')?.severity).toBe('warning')
    expect(findings.every(item => item.severity !== 'error')).toBe(true)
  })

  it('counts a repeated identifier instead of losing one of the two elements', () => {
    const twice = SCENE.replace('guid="4444444444444444444"', 'guid="3333333333333333333"')
    const report = validateCutscene(decodeCutsceneText(twice))
    expect(report.duplicateGuids).toHaveLength(1)
    expect(report.duplicateGuids[0]?.occurrences).toBe(2)
    expect(report.index.get('3333333333333333333')).toBe(2)
  })

  it('keeps an unrecognised tag, reports it as information, and writes it back', () => {
    const future = SCENE.replace(
      '    </CCutsceneNodeActor>',
      '        <CCutsceneNodeVolumetric guid="1616161616161616161" name="Fog volume"/>\n    </CCutsceneNodeActor>',
    )
    const document = decodeCutsceneText(future)
    const report = validateCutscene(document)
    expect(report.unknownTags.get('CCutsceneNodeVolumetric')).toBe(1)
    expect(findingsOf(report).find(item => item.code === 'unknown-tag')?.severity).toBe('info')
    // The prefix still places it correctly in the tree even though the table has never seen it.
    expect(roleOf('CCutsceneNodeVolumetric')).toBe('node')
    expect(encodeCutsceneText(document)).toBe(future)
  })

  it('anchors to the target start for 1, its end for 2, and marks any other point approximate', () => {
    const lookAtStart = (text: string) => {
      const timeline = resolveTimeline(decodeCutsceneText(text))
      const clip = timeline.clips.find(item => item.tag === 'CCutsceneElementLookAt')
      return { start: clip?.start, approximate: clip?.approximate, total: timeline.approximateClips }
    }
    // The anchor target is the 1000 + 2000 animation clip, and the distance is 500.
    expect(lookAtStart(SCENE)).toEqual({ start: 3500, approximate: false, total: 0 })
    expect(lookAtStart(SCENE.replace('startLinkAttachToPoint="2"', 'startLinkAttachToPoint="1"'))).toEqual({ start: 1500, approximate: false, total: 0 })
    expect(lookAtStart(SCENE.replace('startLinkAttachToPoint="2"', 'startLinkAttachToPoint="3"'))).toEqual({ start: 1500, approximate: true, total: 1 })
    expect(resolveTimeline(decodeCutsceneText(SCENE)).timeUnit).toBe('milliseconds-probable')
  })

  it('publishes the names the document writes down, and no path it assembled', () => {
    const groups = referenceGroups(decodeCutsceneText(SCENE))
    const byRole = new Map(groups.map(group => [group.role, group.values.map(item => item.value)]))
    expect(byRole.get('model')).toEqual(['Assets\\Units\\Zerg\\Kerrigan'])
    expect(byRole.get('catalog')).toEqual(['KerriganPrimal'])
    expect(byRole.get('animation-name')).toEqual(['Zerg01_005'])
    expect(byRole.get('sound')).toEqual(['Zerg01_ME', 'zBriefing_MiraHan_002'])
    expect(byRole.get('cutscene')).toEqual(['Cutscenes/Conversations_Cameras.SC2Cutscene'])
    expect(includedCutscenes(decodeCutsceneText(SCENE))).toEqual([
      'Cutscenes/Conversations_Cameras.SC2Cutscene',
    ])
    /*
     * `facialAnim="1200"` repeats the element's own duration; 165 of 1188 shipped conversation
     * elements are like it. Publishing that as a facial animation would put a reference into the
     * graph that no resolver can ever satisfy.
     */
    expect(byRole.get('facial-animation')).toEqual(['zBriefing_MiraHan_002'])
    expect(groups.find(group => group.role === 'facial-animation')?.owner).toBe('oc3/facefx')
  })

  it('holds curve keys as arrays of Bézier control points', () => {
    const channels = curveChannelsOf(decodeCutsceneText(SCENE))
    expect(channels).toHaveLength(1)
    const channel = channels[0]
    expect(channel?.property).toBe('positionX')
    expect(channel?.ownerName).toBe('Kerrigan')
    expect(channel?.time).toBeInstanceOf(Float64Array)
    expect([...(channel?.time ?? [])]).toEqual([0, 2000])
    expect([...(channel?.value ?? [])]).toEqual([0, 4])
    expect([...(channel?.controlOutTime ?? [])]).toEqual([106.666672, 1029.334106])
    expect([...(channel?.controlOutValue ?? [])]).toEqual([0, 4])
    const summary = curveSummary(channels)
    expect(summary.keys).toBe(2)
    expect(summary.properties).toEqual(['positionX'])
    expect([...summary.tangentTypes.entries()].sort()).toEqual([
      [3, 1],
      [7, 1],
    ])
  })

  it('names the measured tangent modes and samples a segment through its control points', () => {
    expect([0, 2, 3, 4, 5, 6, 7].map(tangentModeOf)).toEqual([undefined, undefined, 'linear', 'flat', 'smooth', 'custom', 'auto'])
    const scene = (inControl: string, outControl: string, type: number) => decodeCutsceneText([
      '<CutsceneState>',
      '<CCutsceneNodePropertyValue propertyName="fov">',
      `<CCutsceneElementPropertyCurve time="0" value="0" curveInValue="-1,0" curveOutValue="${outControl}" curveInType="${type}" curveOutType="${type}"/>`,
      `<CCutsceneElementPropertyCurve time="1000" value="4" curveInValue="${inControl}" curveOutValue="1001,4" curveInType="${type}" curveOutType="${type}"/>`,
      '</CCutsceneNodePropertyValue>',
      '</CutsceneState>',
    ].join(''))
    const sample = (document: ReturnType<typeof decodeCutsceneText>, time: number) => sampleChannel(curveChannelsOf(document)[0]!, time)
    const linear = scene('666.666667,2.666667', '333.333333,1.333333', 3)
    expect(sample(linear, 250)?.value).toBeCloseTo(1, 5)
    expect(sample(linear, -5)).toEqual({ value: 0, approximate: false })
    // Flat control points ease in and out: 4 · (3u² − 2u³) at u = 0.25.
    const flat = scene('666.666667,4', '333.333333,0', 4)
    expect(sample(flat, 250)?.value).toBeCloseTo(0.625, 5)
    expect(sample(scene('666.666667,4', '333.333333,0', 0), 250)?.approximate).toBe(true)
  })

  it('records which of the two games ships each tag', () => {
    expect(tagsOnlyIn('storm')).toEqual(['CCutsceneElementModelMaterial'])
    expect(tagsOnlyIn('sc2')).toEqual([
      'CCutsceneNodeEnvironmentLight',
      'CCutsceneNodeMasterSound',
      'CCutsceneNodeRTTChannel',
      'CCutsceneNodeSoundGroup',
      'CCutsceneElementRTTChannel',
    ])
  })
})

describe('sc2-cutscene codec', () => {
  it('keeps its codec manifest schema-valid', async () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '..', 'codecs', 'cutscene', 'codec.json'),
        'utf8',
      ),
    )
    const validation = await validateContributionManifest(
      manifest,
      createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
    )
    expect(validation.specState, JSON.stringify(validation.diagnostics, null, 2)).toBe('validated')
    expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  /*
   * `.SC2Cutscene` and `.SC2Layout` open with the same XML declaration, so the root element is the
   * only evidence that separates them. Recognition has to survive a BOM and a declaration-less file
   * without being fooled by either neighbour.
   */
  it('recognises a cutscene by its root element, not by its extension', () => {
    expect(looksLikeCutscene(SCENE)).toBe(true)
    expect(looksLikeCutscene(`﻿${SCENE}`)).toBe(true)
    expect(looksLikeCutscene('<CutsceneState/>')).toBe(true)
    expect(looksLikeCutscene('<?xml version="1.0" encoding="utf-8"?>\n<Desc>\n</Desc>')).toBe(false)
    expect(looksLikeCutscene('<?xml version="1.0"?>\n<StyleFile/>')).toBe(false)
  })

  it('opens a scene, refuses to edit it, and says why', async () => {
    const session = await openScene(SCENE)
    try {
      const descriptor = session.descriptor as {
        operations?: readonly { id: string; state: string; reason?: string }[]
      }
      const edit = descriptor.operations?.find(item => item.id === 'edit.structure')
      expect(edit?.state).toBe('dependency-required')
      expect(edit?.reason).toMatch(/SC2 Editor verification/u)

      const timeline = (await session.invoke('timeline', {})) as {
        output?: { value?: { approximateClips?: number; length?: number } }
      }
      expect(timeline.output?.value?.approximateClips).toBe(0)
      expect(timeline.output?.value?.length).toBe(8000)

      const references = (await session.invoke('references', {})) as {
        output?: { value?: { includedCutscenes?: readonly string[] } }
      }
      expect(references.output?.value?.includedCutscenes).toEqual([
        'Cutscenes/Conversations_Cameras.SC2Cutscene',
      ])

      const frame = (await session.invoke('scene-at', { timeMs: 1500 })) as {
        output?: { value?: { timeMs: number; completeness: string; revision: string; nodes: { guid: string }[] } }
      }
      expect(frame.output?.value?.timeMs).toBe(1500)
      expect(frame.output?.value?.completeness).toBe('partial')
      expect(frame.output?.value?.revision).toBe('content-hash.sha256:fixture')
      expect(frame.output?.value?.nodes.some(node => node.guid === WIDE_GUID)).toBe(true)
      await expect(session.invoke('scene-at', { timeMs: '1500' })).rejects.toMatchObject({
        message: expect.stringContaining('finite non-negative'),
      })

      const raw = (await session.invoke('export-raw', {})) as {
        output?: { value?: Uint8Array | Record<string, number> }
      }
      const bytes = raw.output?.value
      const asArray = ArrayBuffer.isView(bytes)
        ? (bytes as Uint8Array)
        : Uint8Array.from(Object.values((bytes ?? {}) as Record<string, number>))
      expect(new TextDecoder().decode(asArray)).toBe(SCENE)

      /*
       * The host refuses the call itself, on the strength of the descriptor state, and hands back
       * the reason rather than an opaque failure. That is the behaviour worth pinning: a caller
       * that asks for the edit is told what is missing, not merely that it did not happen.
       */
      const refused = (await session.invoke('edit-structure', {})) as {
        state?: string
        reason?: string
        diagnostics?: readonly { message: string }[]
      }
      expect(refused.state).toBe('rejected')
      expect(refused.reason).toBe('dependency-required')
      expect(refused.diagnostics?.[0]?.message).toMatch(/SC2 Editor verification/u)
    } finally {
      await session.dispose()
    }
  })
})

/** Open the scene through the real codec session, the way a host would. */
async function openScene(text: string) {
  const bytes = encoder.encode(text)
  const uri = 'memory://Test.SC2Cutscene'
  const source = {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision: 'content-hash.sha256:fixture',
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  const binding = {
    sourceKind: 'candidate',
    bindingId: 'content',
    role: 'content',
    ownership: 'owned',
    source: source.ref,
    revision: source.revision,
  }
  const input = {
    originKind: 'single',
    bindings: [binding],
    primaryBindingId: binding.bindingId,
    revisions: {
      topology: 'single',
      revision: source.revision,
      bindings: [{ bindingId: binding.bindingId, revision: source.revision }],
      compositionFingerprint: source.ref.id,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, async release() {} }
    },
  } as never
  const budget = {
    maxInputBytes: 400_000_000n,
    maxDepth: 64,
    maxNodes: 1_000_000,
    maxScalarBytes: 104_857_600,
    maxDiagnostics: 1_000,
  } as never
  const context = {
    budgets: budget,
    diagnostics: { report: () => undefined },
    contracts: {
      async resolve() {
        throw new Error('no service dependency in this test')
      },
      async resolveUnknown() {
        throw new Error('no foreign service in this test')
      },
    },
  } as never

  const session = (await createCodec(context).open(input, 'inspect', budget)) as never as {
    descriptor(): Promise<unknown>
    operations(): { invoke(id: string, input: unknown): Promise<unknown> }
    dispose(): Promise<void>
  }
  return {
    descriptor: await session.descriptor(),
    invoke: (id: string, payload: unknown) => session.operations().invoke(id, payload),
    dispose: () => session.dispose(),
  }
}
