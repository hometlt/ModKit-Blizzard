/**
 * The document model for `.SC2Cutscene` / `.StormCutscene`.
 *
 * Three properties of the format decide the shape of everything here, and each was measured on the
 * 336 shipped SC2 and 1897 Heroes of the Storm cutscenes rather than taken from documentation
 * (there is none):
 *
 * Identifiers are decimal integers 14–20 digits long, and 3.0 % of them — 15 486 of 508 891 — do
 * not fit in `uint64`; the largest is `88887510210754684308`, about 4.8 times `uint64_max`. So a
 * guid is an opaque decimal *string*. Not a `number`, which loses everything past 2^53; not a
 * `bigint` either, because the codec never has cause to do arithmetic on one and a `bigint` that
 * round-trips through `toString` has simply spent the conversion for nothing.
 *
 * Attribute values are kept twice: `raw` exactly as the file spells it, `value` with entities
 * decoded. The corpus has 347 entity references in attribute values, mostly quoted speech in
 * conversation text, so a reader that keeps only `raw` shows `&quot;Objective&quot;` to a human and
 * a writer that keeps only `value` re-escapes to a different byte sequence than it read.
 *
 * There is no text content anywhere in the format — every fact is an attribute — so the model has
 * no text node, and the reader refuses a document that has one rather than dropping it silently.
 */
import type { CutsceneOrigin } from './registry.js'

/** An identifier as the document spells it. Never parsed, normalised or reissued. */
export type CutsceneGuid = string

export interface CutsceneAttribute {
  readonly name: string
  /** The value as written, entities and all — what the writer puts back. */
  readonly raw: string
  /** The value with entities decoded — what a checker compares and a reader is shown. */
  readonly value: string
  /** Which delimiter the document used, so the writer does not change it. */
  readonly quote: '"' | "'"
  /**
   * The whitespace before this attribute.
   *
   * Usually one space. `MainMenu_Zeratul.SC2Cutscene` puts two between `interactive` and
   * `waitForResources`, and one Heroes file does the same; collapsing them is exactly the kind of
   * "just formatting" that makes a byte-identical round trip unreachable.
   */
  readonly lead: string
}

export interface CutsceneElement {
  readonly tag: string
  readonly attributes: readonly CutsceneAttribute[]
  readonly children: readonly CutsceneElement[]
  /** Written as `<Tag/>` rather than `<Tag></Tag>`. */
  readonly selfClosing: boolean
  /**
   * Whitespace between the last attribute and the tag's `>`.
   *
   * Shipped files disagree about this within a single archive — `duration="199800"/>` in one
   * campaign, `curveInType="3" />` in another — so it is data, not formatting to normalise.
   */
  readonly gap: string
  /**
   * The whitespace before this element's `<`, and before its closing `</`, as the file wrote them.
   *
   * Indentation is data here, not formatting. Most files are four spaces per level; 18 of 2233 are
   * not. Some indent a sibling by eight spaces where its neighbours use four, two indent with a
   * tab, and one puts a child on the same line as its parent's open tag. Those are hand-edited
   * documents, and a writer that "corrected" them would rewrite lines their author never touched —
   * a worse diff, and a failed byte-identical round trip.
   *
   * `undefined` means the element was constructed rather than read, and the writer indents it from
   * the document's layout instead.
   */
  readonly lead: string | undefined
  readonly closeGap: string | undefined
  /** Character offsets of the element in the source text, for byte-range surfaces. */
  readonly start: number
  readonly end: number
}

export interface CutsceneDocument {
  /** The XML declaration exactly as written; the corpus has both `utf-8` and `us-ascii`. */
  readonly declaration: string
  /** Four files of 2233 carry a BOM. Dropping it would be a three-byte difference forever. */
  readonly byteOrderMark: boolean
  /** Always `CutsceneState` — 336 of 336 SC2 files and 1897 of 1897 Storm files. */
  readonly root: CutsceneElement
  /**
   * `cutsceneVersion`, absent in 5 shipped files. Absent is a value, not a defect: those files
   * open in the editor, so a reader that requires the attribute is wrong about the format.
   */
  readonly version: string | undefined
  readonly text: string
}

/** The attribute named `name`, if the element has it. Names are case-sensitive in this format. */
export function attributeOf(
  element: CutsceneElement,
  name: string,
): CutsceneAttribute | undefined {
  return element.attributes.find(item => item.name === name)
}

/** The decoded value of `name`, or `undefined`. */
export function valueOf(element: CutsceneElement, name: string): string | undefined {
  return attributeOf(element, name)?.value
}

/** The element's own identifier, or `undefined` for the few elements that carry none. */
export function guidOf(element: CutsceneElement): CutsceneGuid | undefined {
  const guid = valueOf(element, 'guid')
  return guid === undefined || guid === '' ? undefined : guid
}

/**
 * A three-state flag.
 *
 * `enabled="-1"` occurs 226 times in shipped files beside 11 244 `1`s and 9 794 `0`s, and
 * `CCutsceneNodeSound/@mode="4294967295"` is the same `-1` packed as `uint32` 1136 times. A reader
 * testing `value === '1' || value === 'true'` gets the wrong answer for both, so the third state is named rather than
 * folded into either of the other two.
 */
export type CutsceneFlag = 'off' | 'on' | 'negative-one' | 'unknown'

export function flagOf(element: CutsceneElement, name: string): CutsceneFlag {
  return cutsceneFlagValue(valueOf(element, name))
}

/** Interpret the same native states for raw attributes and evaluated numeric property values. */
export function cutsceneFlagValue(value: string | number | undefined): CutsceneFlag {
  if (value === undefined) return 'unknown'
  if (value === 0 || value === '0' || value === 'false') return 'off'
  if (value === 1 || value === '1' || value === 'true') return 'on'
  if (value === -1 || value === 4294967295 || value === '-1' || value === '4294967295') return 'negative-one'
  return 'unknown'
}

/** Every element in the document, root first, in document order. */
export function* walk(element: CutsceneElement): Generator<CutsceneElement> {
  yield element
  for (const child of element.children) yield* walk(child)
}

/** Every element in the document paired with its parent; the root's parent is `undefined`. */
export function* walkWithParent(
  element: CutsceneElement,
  parent?: CutsceneElement,
): Generator<{ element: CutsceneElement; parent: CutsceneElement | undefined }> {
  yield { element, parent }
  for (const child of element.children) yield* walkWithParent(child, element)
}

/** How many elements of each tag the document holds — the census, computed from the model. */
export function tagCounts(document: CutsceneDocument): Map<string, number> {
  const counts = new Map<string, number>()
  for (const element of walk(document.root)) {
    counts.set(element.tag, (counts.get(element.tag) ?? 0) + 1)
  }
  return counts
}

/** Deepest nesting level in the document; the root counts as 1. */
export function depthOf(element: CutsceneElement): number {
  let deepest = 0
  for (const child of element.children) deepest = Math.max(deepest, depthOf(child))
  return deepest + 1
}

export type { CutsceneOrigin }
