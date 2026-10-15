/**
 * The type table: which tags exist, what each is, and which game shipped it.
 *
 * The format is the Blizzard engine's, not StarCraft II's — the same way `.SC2Layout` and
 * `.StormLayout` are one format. Measured across 336 SC2 and 1897 Heroes of the Storm cutscenes,
 * 42 of the 47 tags are common; five are SC2-only and one is Storm-only. That is far too much
 * overlap to justify two codecs, and far too little difference to pretend the split does not
 * exist — so it is recorded here, on each entry, rather than in two parallel readers.
 *
 * The table is *not* a schema and does not gate reading. Version 1.4 will arrive with tags nothing
 * here knows, and a reader that refused them would fail on files the editor opens. An unknown tag
 * is preserved, reported as information, and counted; it is never dropped and never an error.
 */

/** Which of the two shipping games was measured to contain the tag. */
export type CutsceneOrigin = 'both' | 'sc2' | 'storm'

/**
 * What the tag is in the node/element duality the format is built on.
 *
 * A `CCutsceneNode*` is a track — an actor, a light, a camera, a folder, or a channel for one
 * property. A `CCutsceneElement*` is a clip on a track: it has a `start`, usually a `duration`, and
 * lives only inside its own node. The pairing is nearly one-to-one by name, which is why a bare
 * `kind` is carried on both halves of a pair.
 */
export type CutsceneTagRole = 'root' | 'node' | 'element'

export interface CutsceneTagEntry {
  readonly tag: string
  readonly role: CutsceneTagRole
  /** The bare name shared by a node/element pair, e.g. `Fade` for both forms. */
  readonly kind: string
  readonly origin: CutsceneOrigin
  /** Occurrences in the 336-file SC2 corpus, as measured. Absent for Storm-only tags. */
  readonly sc2Occurrences?: number
  readonly summary: string
}

const NODE_PREFIX = 'CCutsceneNode'
const ELEMENT_PREFIX = 'CCutsceneElement'

function entryFor(
  prefix: string,
  role: 'node' | 'element',
  kind: string,
  origin: CutsceneOrigin,
  sc2Occurrences: number | undefined,
  summary: string,
): CutsceneTagEntry {
  const base = { tag: `${prefix}${kind}`, role, kind, origin, summary } as const
  return Object.freeze(sc2Occurrences === undefined ? base : { ...base, sc2Occurrences })
}

const node = (
  kind: string,
  origin: CutsceneOrigin,
  sc2Occurrences: number | undefined,
  summary: string,
): CutsceneTagEntry => entryFor(NODE_PREFIX, 'node', kind, origin, sc2Occurrences, summary)

const element = (
  kind: string,
  origin: CutsceneOrigin,
  sc2Occurrences: number | undefined,
  summary: string,
): CutsceneTagEntry => entryFor(ELEMENT_PREFIX, 'element', kind, origin, sc2Occurrences, summary)

export const CUTSCENE_ROOT_TAG = 'CutsceneState'

/** Every tag measured in either corpus, with the game it was measured in. */
export const CUTSCENE_TAGS: readonly CutsceneTagEntry[] = Object.freeze([
  Object.freeze({
    tag: CUTSCENE_ROOT_TAG,
    role: 'root' as const,
    kind: 'CutsceneState',
    origin: 'both' as const,
    sc2Occurrences: 336,
    summary: 'the scene itself; carries cutsceneVersion',
  }),

  node('ActiveShot', 'both', 46562, 'which shot an object belongs to: cameraGUID, cameraIndex'),
  node('PropertyValue', 'both', 31401, 'one animated property channel, named by propertyName'),
  node('Light', 'both', 26776, 'a light: type, colour, specular, hotspot/falloff, shadows'),
  node('Actor', 'both', 16173, 'a scene actor: model, transform, tint, team colour, speech'),
  node('AnimLayer', 'both', 11409, 'one animation layer of an actor'),
  node('Folder', 'both', 7072, 'grouping; may include another cutscene via referenceFile'),
  node('Sound', 'both', 3658, 'a sound: soundLink, per-speaker mix, pitch, volume'),
  node('TargetCamera', 'both', 1866, 'eye-and-target camera: fov, clips, depth of field, roll'),
  node('PathMarker', 'both', 1635, 'one point on a path'),
  node('LookAt', 'both', 1438, 'gaze direction'),
  node('Path', 'both', 558, 'a path built from markers'),
  node('FollowPath', 'both', 536, 'motion along a path'),
  node('Conversation', 'both', 506, 'binding to a conversation line'),
  node('Fog', 'both', 415, 'fog'),
  node('M3A', 'both', 403, 'external M3A animation: filePath, name'),
  node('ActiveLight', 'both', 399, 'which light is active over time'),
  node('Bookmark', 'both', 375, 'timeline bookmarks; also trigger event points'),
  node('EnvironmentLight', 'sc2', 367, 'environment light'),
  node('Director', 'both', 346, 'the scene-wide service track'),
  node('ActiveCamera', 'both', 321, 'which camera is active over time'),
  node('Camera', 'both', 309, 'a plain camera'),
  node('Attachment', 'both', 278, 'attachment to a model attach point'),
  node('EndScene', 'both', 185, 'end of scene; also a trigger event point'),
  node('Fade', 'both', 131, 'screen fade'),
  node('ConversationDriver', 'both', 100, 'the conversation that drives the scene'),
  node('MasterSound', 'sc2', 70, 'the scene master sound'),
  node('RTTChannel', 'sc2', 59, 'render-to-texture channel'),
  node('SoundGroup', 'sc2', 15, 'a group of sounds'),
  node('Text', 'both', 14, 'a text label in the scene'),
  node('ModelMaterial', 'both', 9, 'a model material override'),
  node('HaloController', 'both', 1, 'halo controller; one occurrence in the whole SC2 corpus'),

  element('PropertyCurve', 'both', 142276, 'one curve key: time, value, tangents and their types'),
  element('Object', 'both', 50943, 'the clip a node occupies: start, duration, anchors'),
  element('Anim', 'both', 23719, 'an animation clip: anim, priority, blending, weight, timeScale'),
  element('PropertyValue', 'both', 8887, 'a stepped property value instead of a curve'),
  element('Bookmark', 'both', 4341, 'a bookmark: name, jump-on-hit, pause-on-hit'),
  element('LookAt', 'both', 2186, 'a gaze target: lookAtGUID, attach id, look-at type'),
  element('ActiveCamera', 'both', 2090, 'camera activation: objectGuid, cameraIndex, cameraName'),
  element('Conversation', 'both', 1188, 'a spoken line, its sound, and its facial animation'),
  element('ConversationDriver', 'both', 1025, 'a driven line: lineId, alternateLineId, overlap'),
  element('ActiveLight', 'both', 934, 'light activation: lightGUID, lightID, lightIndex, blend'),
  element('FollowPath', 'both', 602, 'path following: pathGuid, rotation offset, alwaysPointUp'),
  element('Fade', 'both', 426, 'a fade: colour, amount, unfaded amount, direction'),
  element('Attachment', 'both', 421, 'an attachment: attachGuid, attachName, offset, rotation'),
  element('EndScene', 'both', 236, 'the end marker'),
  element('RTTChannel', 'sc2', 88, 'render-to-texture: objectGUID, cameraIndex, aspectRatio'),
  element('ModelMaterial', 'storm', undefined, 'a material override clip; Heroes of the Storm only'),
])

/** Legacy ActorState dialect; kept separate from measured CCutscene corpus counts. */
export const SCENE_ROOT_TAG = 'ActorState'
export const SCENE_TAGS: readonly CutsceneTagEntry[] = Object.freeze([
  ['ActorState', 'root', 'ActorState'], ['ActorNode', 'node', 'Actor'],
  ['AnimLayerNode', 'node', 'AnimLayer'], ['AnimBlock', 'element', 'Anim'],
  ['FileNode', 'node', 'M3A'], ['FacialNode', 'node', 'Facial'],
  ['Global', 'node', 'Global'],
].map(([tag, role, kind]) => Object.freeze({ tag: tag!, role: role as CutsceneTagRole,
  kind: kind!, origin: 'sc2' as const, summary: 'legacy SC2Scene authored record' })))

const BY_TAG: ReadonlyMap<string, CutsceneTagEntry> = new Map(
  [...CUTSCENE_TAGS, ...SCENE_TAGS].map(item => [item.tag, item]),
)

export function tagEntry(tag: string): CutsceneTagEntry | undefined {
  return BY_TAG.get(tag)
}

export function isKnownTag(tag: string): boolean {
  return BY_TAG.has(tag)
}

/**
 * The role a tag plays, inferred from its prefix when the table does not know it.
 *
 * A tag the table has never seen still says what it is: the format names every track
 * `CCutsceneNode*` and every clip `CCutsceneElement*`, without exception across 2233 files. So an
 * unknown `CCutsceneNodeVolumetric` still lands in the right place in the tree instead of being
 * shown as an untyped blob — which is the difference between surviving a new format version and
 * stalling on it.
 */
export function roleOf(tag: string): CutsceneTagRole | undefined {
  const known = BY_TAG.get(tag)
  if (known !== undefined) return known.role
  if (tag === CUTSCENE_ROOT_TAG) return 'root'
  if (tag.startsWith(ELEMENT_PREFIX)) return 'element'
  if (tag.startsWith(NODE_PREFIX)) return 'node'
  return undefined
}

/** The bare kind name, with the node/element prefix removed. */
export function kindOf(tag: string): string {
  const known = BY_TAG.get(tag)
  if (known !== undefined) return known.kind
  if (tag.startsWith(ELEMENT_PREFIX)) return tag.slice(ELEMENT_PREFIX.length)
  if (tag.startsWith(NODE_PREFIX)) return tag.slice(NODE_PREFIX.length)
  return tag
}

/** Tags one game ships and the other does not, as measured. */
export function tagsOnlyIn(origin: 'sc2' | 'storm'): readonly string[] {
  return CUTSCENE_TAGS.filter(item => item.origin === origin).map(item => item.tag)
}
