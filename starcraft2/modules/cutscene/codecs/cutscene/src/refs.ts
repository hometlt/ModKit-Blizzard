/**
 * What a cutscene depends on outside itself.
 *
 * A cutscene is a node in the mod's dependency graph, not an isolated document: it names models,
 * external `.m3a` animations, sounds, conversation lines, facial animations, catalog entries and
 * — through `referenceFile` — other cutscenes. Until a codec publishes those names, "where is this
 * model used?" cannot see inside cutscenes at all, which is exactly where a campaign uses most of
 * its models.
 *
 * Every entry below is an attribute the corpus actually carries. Nothing is derived by pattern —
 * no path is assembled, no extension is appended, no catalog id is guessed from a model name. A
 * reference here is a string the document wrote down, and resolving it against an archive is the
 * host's job, not this file's.
 */
import { walk, type CutsceneDocument, type CutsceneElement } from './model.js'

/**
 * The kind of thing referred to, named after the codec or subsystem that owns it.
 *
 * These are the roles the specification's dependency table established, and they are deliberately
 * coarser than the attributes that produce them: four attributes name a GameData catalog entry, and
 * a consumer wanting "everything from GameData" should not have to enumerate them.
 */
export type CutsceneReferenceRole =
  | 'model'
  | 'model-animation'
  | 'catalog'
  | 'sound'
  | 'conversation'
  | 'facial-animation'
  | 'cutscene'
  | 'filter'
  | 'animation-name'

export interface CutsceneReference {
  readonly role: CutsceneReferenceRole
  /** The attribute that carried it, so a reader can see where the name came from. */
  readonly attribute: string
  /** The value exactly as the document spells it. */
  readonly value: string
  /** The element that made the reference. */
  readonly tag: string
  /** The referring element's own guid, when it has one. */
  readonly guid: string | undefined
  /** Which codec or subsystem resolves this kind of name. */
  readonly owner: string
}

interface ReferenceRule {
  readonly attribute: string
  readonly role: CutsceneReferenceRole
  readonly owner: string
  /** Restricts the rule to one tag, where the same attribute name means different things. */
  readonly tag?: string
}

/**
 * The dependency table, one row per attribute.
 *
 * `facialGroup`/`facialAnim` need the guard below rather than a row that trusts them: in 165 of
 * 1188 conversation elements they are degenerate and repeat the element's own numeric `duration`
 * instead of naming anything. Publishing those as facial animations would put 165 references that
 * cannot resolve into the graph, and a resolver would report them as missing assets forever.
 */
const RULES: readonly ReferenceRule[] = Object.freeze([
  { attribute: 'model', role: 'model', owner: 'blizzard/m3', tag: 'ActorNode' },
  { attribute: 'filePath', role: 'model-animation', owner: 'blizzard/m3a', tag: 'FileNode' },
  { attribute: 'facialfile', role: 'facial-animation', owner: 'oc3/facefx', tag: 'FacialNode' },
  { attribute: 'modelLink', role: 'catalog', owner: 'blizzard/sc2-data' },
  { attribute: 'debugModelLink', role: 'catalog', owner: 'blizzard/sc2-data' },
  { attribute: 'unitLink', role: 'catalog', owner: 'blizzard/sc2-data' },
  { attribute: 'actorAlias', role: 'catalog', owner: 'blizzard/sc2-data' },
  { attribute: 'speakerTag', role: 'catalog', owner: 'blizzard/sc2-data' },
  { attribute: 'finderTag', role: 'catalog', owner: 'blizzard/sc2-data' },
  { attribute: 'soundLink', role: 'sound', owner: 'blizzard/sc2-data' },
  { attribute: 'conversationLink', role: 'conversation', owner: 'blizzard/sc2-data' },
  { attribute: 'conversationLine', role: 'conversation', owner: 'blizzard/sc2-data' },
  { attribute: 'lineId', role: 'conversation', owner: 'blizzard/sc2-data' },
  { attribute: 'alternateLineId', role: 'conversation', owner: 'blizzard/sc2-data' },
  { attribute: 'modelPath', role: 'model', owner: 'blizzard/m3' },
  { attribute: 'filePath', role: 'model-animation', owner: 'blizzard/m3', tag: 'CCutsceneNodeM3A' },
  { attribute: 'anim', role: 'animation-name', owner: 'blizzard/m3' },
  { attribute: 'animId', role: 'animation-name', owner: 'blizzard/m3' },
  { attribute: 'facialGroup', role: 'facial-animation', owner: 'oc3/facefx' },
  { attribute: 'facialAnim', role: 'facial-animation', owner: 'oc3/facefx' },
  { attribute: 'fxaOverride', role: 'facial-animation', owner: 'oc3/facefx' },
  { attribute: 'referenceFile', role: 'cutscene', owner: 'blizzard/sc2-cutscene' },
  { attribute: 'filter', role: 'filter', owner: 'runtime' },
])

const RULES_BY_ATTRIBUTE: ReadonlyMap<string, readonly ReferenceRule[]> = (() => {
  const grouped = new Map<string, ReferenceRule[]>()
  for (const rule of RULES) {
    const bucket = grouped.get(rule.attribute)
    if (bucket === undefined) grouped.set(rule.attribute, [rule])
    else bucket.push(rule)
  }
  return grouped
})()

/** A value that is only digits names nothing; see the note on the rules table. */
function namesSomething(role: CutsceneReferenceRole, value: string): boolean {
  if (value === '') return false
  if (role === 'facial-animation' && /^-?\d+$/u.test(value)) return false
  return true
}

/** Every external name this element writes down. */
export function elementReferences(element: CutsceneElement): CutsceneReference[] {
  const guid = element.attributes.find(item => item.name === 'guid')?.value
  const found: CutsceneReference[] = []
  for (const attribute of element.attributes) {
    for (const rule of RULES_BY_ATTRIBUTE.get(attribute.name) ?? []) {
      if (rule.tag !== undefined && rule.tag !== element.tag) continue
      if (!namesSomething(rule.role, attribute.value)) continue
      found.push(
        Object.freeze({
          role: rule.role,
          attribute: attribute.name,
          value: attribute.value,
          tag: element.tag,
          guid,
          owner: rule.owner,
        }),
      )
    }
  }
  return found
}

/** Every external name the document writes down, in document order, duplicates included. */
export function externalReferencesOf(document: CutsceneDocument): CutsceneReference[] {
  const found: CutsceneReference[] = []
  for (const element of walk(document.root)) found.push(...elementReferences(element))
  return found
}

export interface CutsceneReferenceGroup {
  readonly role: CutsceneReferenceRole
  readonly owner: string
  /** Distinct values, sorted, with how many elements referred to each. */
  readonly values: readonly { readonly value: string; readonly uses: number }[]
}

/** The same references, folded to distinct values per role — what a dependency view shows. */
export function referenceGroups(document: CutsceneDocument): CutsceneReferenceGroup[] {
  const byRole = new Map<CutsceneReferenceRole, { owner: string; uses: Map<string, number> }>()
  for (const reference of externalReferencesOf(document)) {
    const bucket = byRole.get(reference.role) ?? { owner: reference.owner, uses: new Map() }
    bucket.uses.set(reference.value, (bucket.uses.get(reference.value) ?? 0) + 1)
    byRole.set(reference.role, bucket)
  }
  return [...byRole.entries()]
    .map(([role, bucket]) => ({
      role,
      owner: bucket.owner,
      values: [...bucket.uses.entries()]
        .map(([value, uses]) => ({ value, uses }))
        .sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0)),
    }))
    .sort((left, right) => (left.role < right.role ? -1 : left.role > right.role ? 1 : 0))
}

/**
 * The cutscenes this one includes, as `referenceFile` spells them.
 *
 * These are companion candidates rather than resolved paths. The value is a mod-relative path such
 * as `Cutscenes/Conversations_Cameras.SC2Cutscene`, and which mount it resolves against depends on
 * the workspace the host opened — a fact the codec does not have and must not invent.
 */
export function includedCutscenes(document: CutsceneDocument): readonly string[] {
  const paths = new Set<string>()
  for (const reference of externalReferencesOf(document)) {
    if (reference.role === 'cutscene') paths.add(reference.value)
  }
  return [...paths].sort()
}
