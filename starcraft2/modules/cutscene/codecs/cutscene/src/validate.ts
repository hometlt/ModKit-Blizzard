/**
 * What is wrong with a cutscene — and, just as importantly, what is not.
 *
 * The rules here were written against the shipped corpus, and two of them exist because the first
 * version got them backwards.
 *
 * Dangling references are normal. 327 of 112 845 identifier references in Blizzard's own files
 * resolve to nothing inside their own document — `startLinkGuid` most of all, at 268. A validator
 * that refused to open those files, or that called them errors, would be reporting the format's
 * ordinary state as a defect, and a reader would learn to ignore it. They are reported as warnings
 * with the count, so a human can see the tail without being blocked by it.
 *
 * Duplicate identifiers are also normal, in 5 files out of 336. Nothing here builds an index that
 * assumes uniqueness; the index maps a guid to *how many* elements carry it.
 *
 * An unknown tag or attribute is information, never an error. The format is live — versions 1.2 and
 * 1.3 both ship today — and the reader preserves what it does not recognise precisely so that a 1.4
 * file opens rather than stalls.
 */
import {
  guidOf,
  walk,
  walkWithParent,
  type CutsceneDocument,
  type CutsceneElement,
  type CutsceneGuid,
} from './model.js'
import { isKnownTag, roleOf } from './registry.js'

/** Attributes whose value is an identifier pointing at another element in the same document. */
export const REFERENCE_ATTRIBUTES: readonly string[] = Object.freeze([
  'startLinkGuid',
  'endLinkGuid',
  'linkGuid',
  'cameraGUID',
  'objectGuid',
  // `CCutsceneElementRTTChannel` spells it with capitals: 88 references in the corpus.
  'objectGUID',
  'lightGUID',
  'lookAtGUID',
  'pathGuid',
  'attachGuid',
  'referenceGuid',
])

export interface CutsceneDanglingReference {
  readonly attribute: string
  readonly value: CutsceneGuid
  readonly tag: string
  readonly guid: CutsceneGuid | undefined
  /** Offset of the referring element in `document.text`. */
  readonly start: number
}

export interface CutsceneDuplicateGuid {
  readonly guid: CutsceneGuid
  readonly occurrences: number
  readonly tags: readonly string[]
  /** Offsets of every element carrying the identifier, in document order. */
  readonly starts: readonly number[]
}

export interface CutsceneValidationReport {
  readonly root: string
  readonly version: string | undefined
  readonly elements: number
  readonly depth: number
  /** guid → how many elements carry it. Never assumes one. */
  readonly index: ReadonlyMap<CutsceneGuid, number>
  readonly duplicateGuids: readonly CutsceneDuplicateGuid[]
  readonly danglingReferences: readonly CutsceneDanglingReference[]
  /** How many references each attribute made, resolved or not. */
  readonly referenceTotals: ReadonlyMap<string, number>
  readonly unknownTags: ReadonlyMap<string, number>
  /** Offset of the first occurrence of each unknown tag. */
  readonly unknownTagStarts: ReadonlyMap<string, number>
  /**
   * A `CCutsceneElement*` whose parent is not a node, or a node under an element. The measured
   * containment graph has no such edge in 2233 files, so one is worth saying out loud.
   */
  readonly misplacedElements: readonly { readonly tag: string; readonly parent: string; readonly start: number }[]
  /** Identifiers too wide for `uint64`. Not a defect — the reason guids are strings. */
  readonly widerThanUint64: number
  /** Cross-document `referenceFile` targets; these cannot be checked from one file. */
  readonly externalCutscenes: readonly string[]
  /** Offset of the first element naming each external cutscene. */
  readonly externalCutsceneStarts: ReadonlyMap<string, number>
}

const UINT64_MAX = 18446744073709551615n

function isDecimal(value: string): boolean {
  return value !== '' && /^\d+$/u.test(value)
}

export function validateCutscene(document: CutsceneDocument): CutsceneValidationReport {
  const index = new Map<CutsceneGuid, number>()
  const carriers = new Map<CutsceneGuid, { tags: string[]; starts: number[] }>()
  let elements = 0
  let widerThanUint64 = 0

  for (const element of walk(document.root)) {
    elements += 1
    const guid = guidOf(element)
    if (guid === undefined) continue
    index.set(guid, (index.get(guid) ?? 0) + 1)
    const carrier = carriers.get(guid)
    if (carrier === undefined) carriers.set(guid, { tags: [element.tag], starts: [element.start] })
    else {
      carrier.tags.push(element.tag)
      carrier.starts.push(element.start)
    }
  }

  const danglingReferences: CutsceneDanglingReference[] = []
  const referenceTotals = new Map<string, number>()
  const unknownTags = new Map<string, number>()
  const unknownTagStarts = new Map<string, number>()
  const misplacedElements: { tag: string; parent: string; start: number }[] = []
  const externalCutsceneStarts = new Map<string, number>()

  for (const { element, parent } of walkWithParent(document.root)) {
    if (!isKnownTag(element.tag)) {
      unknownTags.set(element.tag, (unknownTags.get(element.tag) ?? 0) + 1)
      if (!unknownTagStarts.has(element.tag)) unknownTagStarts.set(element.tag, element.start)
    }
    const role = roleOf(element.tag)
    const parentRole = parent === undefined ? undefined : roleOf(parent.tag)
    if (parent !== undefined && role === 'element' && parentRole === 'element') {
      misplacedElements.push({ tag: element.tag, parent: parent.tag, start: element.start })
    }

    /*
     * `referenceGuid` names an element in *another* cutscene when the same element carries a
     * `referenceFile`, and one in this document otherwise. Checking the cross-file form against the
     * local index would report every include as broken — which is the majority of what folders with
     * a `referenceFile` do.
     */
    const referencesAnotherFile = element.attributes.some(
      item => item.name === 'referenceFile' && item.value !== '',
    )

    for (const attribute of element.attributes) {
      if (attribute.name === 'referenceFile' && attribute.value !== '' && !externalCutsceneStarts.has(attribute.value)) {
        externalCutsceneStarts.set(attribute.value, element.start)
      }
      if (isDecimal(attribute.value) && BigInt(attribute.value) > UINT64_MAX) widerThanUint64 += 1
      if (attribute.name === 'referenceGuid' && referencesAnotherFile) continue
      if (!REFERENCE_ATTRIBUTES.includes(attribute.name)) continue
      if (!isDecimal(attribute.value) || attribute.value === '0') continue
      referenceTotals.set(attribute.name, (referenceTotals.get(attribute.name) ?? 0) + 1)
      if (index.has(attribute.value)) continue
      danglingReferences.push({
        attribute: attribute.name,
        value: attribute.value,
        tag: element.tag,
        guid: guidOf(element),
        start: element.start,
      })
    }
  }

  const duplicateGuids: CutsceneDuplicateGuid[] = []
  for (const [guid, occurrences] of index) {
    if (occurrences < 2) continue
    const carrier = carriers.get(guid)
    duplicateGuids.push({ guid, occurrences, tags: carrier?.tags ?? [], starts: carrier?.starts ?? [] })
  }

  return Object.freeze({
    root: document.root.tag,
    version: document.version,
    elements,
    depth: depthOf(document.root),
    index,
    duplicateGuids,
    danglingReferences,
    referenceTotals,
    unknownTags,
    unknownTagStarts,
    misplacedElements,
    widerThanUint64,
    externalCutscenes: [...externalCutsceneStarts.keys()].sort(),
    externalCutsceneStarts,
  })
}

function depthOf(element: CutsceneElement): number {
  let deepest = 0
  for (const child of element.children) deepest = Math.max(deepest, depthOf(child))
  return deepest + 1
}

export interface CutsceneFinding {
  readonly code: string
  readonly severity: 'error' | 'warning' | 'info'
  readonly message: string
  /**
   * Where the finding points: the offset of an element in `document.text` and, when one attribute
   * is the subject, its name. Absent for findings about the document as a whole.
   */
  readonly location?: { readonly start: number; readonly attribute?: string }
}

/**
 * The report as diagnostics, folded so a file with 268 dangling anchors produces one finding rather
 * than 268. A reader who wants the list has the report; a reader looking at a descriptor wants to
 * know that the tail exists and how long it is.
 */
export function findingsOf(report: CutsceneValidationReport): CutsceneFinding[] {
  const findings: CutsceneFinding[] = []

  const byAttribute = new Map<string, { count: number; start: number }>()
  for (const dangling of report.danglingReferences) {
    const seen = byAttribute.get(dangling.attribute)
    if (seen === undefined) byAttribute.set(dangling.attribute, { count: 1, start: dangling.start })
    else seen.count += 1
  }
  for (const [attribute, { count, start }] of [...byAttribute].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    findings.push({
      code: 'unresolved-reference',
      severity: 'warning',
      message: `${count} ${attribute} reference${count === 1 ? '' : 's'} name no element in this cutscene; Blizzard's own files carry such references, so this is reported rather than refused`,
      location: { start, attribute },
    })
  }

  if (report.duplicateGuids.length > 0) {
    const extra = report.duplicateGuids.reduce((sum, item) => sum + item.occurrences - 1, 0)
    // Point at the first repeat rather than the original: that is the element that made it ambiguous.
    const repeat = report.duplicateGuids[0]?.starts[1]
    findings.push({
      code: 'duplicate-guid',
      severity: 'warning',
      message: `${report.duplicateGuids.length} identifier${report.duplicateGuids.length === 1 ? '' : 's'} appear on more than one element (${extra} extra occurrence${extra === 1 ? '' : 's'}); references to them are ambiguous`,
      ...(repeat === undefined ? {} : { location: { start: repeat, attribute: 'guid' } }),
    })
  }

  for (const [tag, count] of [...report.unknownTags].sort()) {
    const start = report.unknownTagStarts.get(tag)
    findings.push({
      code: 'unknown-tag',
      severity: 'info',
      message: `<${tag}> is not in the measured type table (${count} occurrence${count === 1 ? '' : 's'}); it is preserved exactly and written back unchanged`,
      ...(start === undefined ? {} : { location: { start } }),
    })
  }

  for (const misplaced of report.misplacedElements) {
    findings.push({
      code: 'misplaced-element',
      severity: 'warning',
      message: `<${misplaced.tag}> sits inside <${misplaced.parent}>; in the measured corpus a clip always sits directly inside its track`,
      location: { start: misplaced.start },
    })
  }

  if (report.version === undefined) {
    findings.push({
      code: 'version-absent',
      severity: 'info',
      message:
        'no cutsceneVersion attribute; 5 of 336 shipped files are the same and open normally',
    })
  }

  for (const path of report.externalCutscenes) {
    const start = report.externalCutsceneStarts.get(path)
    findings.push({
      code: 'external-cutscene',
      severity: 'info',
      message: `includes ${path}; whether it resolves depends on the mounts of the workspace this was opened in`,
      ...(start === undefined ? {} : { location: { start, attribute: 'referenceFile' } }),
    })
  }

  return findings
}
