import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'
import { expect, it } from 'vitest'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'
import { projectM3Animations } from '../src/m3/animation-projection.js'
import { decodeM3Animations } from '../src/m3/runtime/animation.js'
import { M3AnimationEvaluator, parseAnimationReference } from '../src/m3/native/animation/evaluator.js'
import { M3AnimationReferenceTrackExtractor } from '../src/m3/native/animation/tracks.js'
installM3PlatformAdapters({ DOMParser })
const budget = { maxDepth: 128, maxNodes: 1_000_000, maxScalarBytes: 256 * 1024 * 1024 }
it('refuses binding inputs before parsing when their aggregate bytes exceed the caller budget', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/m3/corpus/portrait.m3', import.meta.url)))
  const result = await decodeM3Animations(bytes, { ...budget, maxInputBytes: BigInt(bytes.length * 2 - 1) }, undefined, bytes)
  expect(result.fatal).toBe(true)
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'x3.m3/animation-budget-exceeded' }))
})

it('checks the additional base container before the binding parse', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/m3/corpus/portrait.m3', import.meta.url)))
  const result = await decodeM3Animations(bytes, { ...budget, maxInputBytes: 536870912n }, undefined, new Uint8Array(24))
  expect(result.fatal).toBe(true)
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'x3.m3/animation-container-invalid' }))
})
async function fixture() {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/m3/corpus/portrait.m3', import.meta.url)))
  return M3SectionList.load(bytes.buffer, await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8'))
}
function base(sections: Awaited<ReturnType<typeof fixture>>, bones: any[]) {
  const reference = sections.model['bones'] as any
  const original = sections.getSectionByReference(reference)!
  return { model: sections.model, getSectionByReference(ref: any) {
    return ref === reference ? { ...original, content: bones } : sections.getSectionByReference(ref)
  } }
}
it.each([['location', 'translation'], ['rotation', 'rotation']] as const)('preserves native %s samples at 0 and 1 ms when presenting a leading duplicate-time discontinuity', async (field, kind) => {
  const sections = await fixture()
  const bones = sections.getSectionByReference(sections.model['bones'] as any)!.content as any[]
  const evaluator = new M3AnimationEvaluator(sections.model, sections)
  const candidate = bones.map((bone, index) => {
    const parsed = parseAnimationReference(bone[field])
    const resolved = parsed === null ? null : evaluator.resolveAnimRef(0, parsed.animId)
    const frames = resolved === null ? undefined : sections.getSectionByReference(resolved.sd.frames as any)?.content as number[] | undefined
    return { index, parsed, resolved, frames }
  }).find(item => item.resolved && !item.resolved.concurrent && item.frames && item.frames.length >= 3 && item.frames[0] === 0 && item.frames[1]! > 1)
  expect(candidate).toBeDefined()
  candidate!.frames![1] = 0
  const nativeZero = evaluator.sampleSd(candidate!.resolved!, candidate!.parsed!.interpolationType, 0, [])!
  const nativeOne = evaluator.sampleSd(candidate!.resolved!, candidate!.parsed!.interpolationType, 1, [])!
  const channel = (result: ReturnType<typeof projectM3Animations>) => result.clips[0]!.channels
    .find(item => item.target === `bone/${candidate!.index}` && item.kind === kind)!
  const raw = projectM3Animations(sections, budget)
  expect(channel(raw).samples.slice(0, 2).map(sample => sample.timeSeconds)).toEqual([0, 0])
  const presented = projectM3Animations(sections, budget, undefined, base(sections, bones))
  expect(presented.boundaryResampledChannels).toBeGreaterThan(0)
  expect(channel(presented).samples.slice(0, 2).map(sample => sample.timeSeconds)).toEqual([0, 0.001])
  expect(channel(presented).samples[0]!.value).toEqual(nativeZero)
  expect(channel(presented).samples[1]!.value).toEqual(nativeOne)
  const values = (samples: ReturnType<typeof channel>['samples']) => samples.map(({ frame: _ordinal, ...sample }) => sample)
  expect(values(channel(presented).samples.slice(2))).toEqual(values(channel(raw).samples.filter(sample => sample.timeSeconds! > 0.001)))
  const sequence = sections.getSectionByReference(sections.model['sequences'] as any)!.content[0] as any
  sequence.anim_ms_start = 0
  sequence.anim_ms_end = 1
  const guarded = new M3AnimationReferenceTrackExtractor(sections.model, sections, new Set([0]), true)
  expect(guarded.extract(bones[candidate!.index][field])[0]!.track.keys.slice(0, 2).map(key => key.frame)).toEqual([0, 0])
  expect(guarded.boundaryResampledChannels).toBe(0)
})
it('binds native animation ids to reordered base bones rather than companion ordinals', async () => {
  const sections = await fixture()
  const bones = sections.getSectionByReference(sections.model['bones'] as any)!.content as any[]
  expect(bones.length).toBeGreaterThan(1)
  const before = projectM3Animations(sections, budget, undefined, base(sections, bones))
  const after = projectM3Animations(sections, budget, undefined, base(sections, [...bones].reverse()))
  const channels = (result: typeof before) => result.clips.flatMap((clip, index) => clip.channels
    .filter(channel => /^bone\//u.test(channel.target) && ['translation','rotation','scale'].includes(channel.kind))
    .map(channel => ({ clip:index, ...channel })))
  expect(channels(before).length).toBeGreaterThan(0)
  const expected = channels(before).map(channel => ({ ...channel,
    target:`bone/${bones.length - 1 - Number(channel.target.slice(5))}` }))
  const ordered = (items: any[]) => items.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  expect(ordered(channels(after))).toEqual(ordered(expected))
})
it('refuses an animation id bound to a base field of the wrong native type', async () => {
  const sections = await fixture()
  const bones = sections.getSectionByReference(sections.model['bones'] as any)!.content as any[]
  const projected = projectM3Animations(sections, budget)
  const channel = projected.clips.flatMap(clip => clip.channels).find(item => item.kind === 'translation')!
  expect(channel).toBeDefined()
  const index = Number(channel.target.slice(5))
  const changed = bones.map((bone,i) => i === index ? { ...bone, rotation:bone.location } : bone)
  expect(() => projectM3Animations(sections,budget,undefined,base(sections,changed))).toThrow(/incompatible rotation data type/)
})

it('does not fabricate TRS targets when explicit base references match no sidecar animation ids', async () => {
  const sections = await fixture()
  const bones = sections.getSectionByReference(sections.model['bones'] as any)!.content as any[]
  const unbound = bones.map(bone => ({ ...bone, ...Object.fromEntries(['location','rotation','scale'].map(field => [field,{ ...bone[field], header:{ ...bone[field].header, id:0xffffffff } }])) }))
  const result = projectM3Animations(sections,budget,undefined,base(sections,unbound))
  expect(result.clips.flatMap(clip => clip.channels).filter(channel => ['translation','rotation','scale'].includes(channel.kind))).toEqual([])
})

it('refuses duplicate base targets for a resolved native animation id', async () => {
  const sections = await fixture()
  const bones = sections.getSectionByReference(sections.model['bones'] as any)!.content as any[]
  const channel = projectM3Animations(sections,budget).clips.flatMap(clip => clip.channels).find(item => item.kind === 'translation')!
  expect(channel).toBeDefined()
  const index = Number(channel.target.slice(5)), other = (index + 1) % bones.length
  const changed = bones.map((bone,i) => i === other ? { ...bone, location:bones[index].location } : bone)
  expect(() => projectM3Animations(sections,budget,undefined,base(sections,changed))).toThrow(/ambiguous base targets/)
})
