/**
 * `CutsceneDocument` → bytes, byte-identical to what was read.
 *
 * The acceptance gate for the reader is that `decode` then `encode` reproduces the input exactly,
 * on every shipped file. That is the only check that actually proves the reader dropped nothing;
 * a "semantically equal" comparison proves only that the two agree about the things the comparison
 * knows to look at, which is the same set the reader knows to keep.
 *
 * Making that gate reachable is why whitespace is carried on the model rather than regenerated. The
 * conventions hold for most of the corpus — four spaces per level, LF, no final newline — and then
 * do not: of 2233 files, 162 end with a newline, 16 indent a sibling at the wrong level, 2 indent
 * with a tab, 15 put a space before `/>`, 4 carry a BOM, 10 declare `us-ascii`, and 2 separate two
 * attributes with two spaces. Every one of those is a handful of bytes, and every one would have
 * been dismissed as "just formatting" right up until it made the gate unreachable — at which point
 * the temptation is to weaken the gate rather than fix the writer.
 *
 * So an element written by a human keeps the whitespace that human wrote, and only an element this
 * codec constructs is indented from `layout`.
 */
import type { CutsceneDocument, CutsceneElement } from './model.js'

const encoder = new TextEncoder()

/** How the document spells its own whitespace. Detected on read, reused on write. */
export interface CutsceneLayout {
  readonly newline: string
  readonly indentUnit: string
  readonly trailingNewline: string
}

/** The conventions every shipped file follows, for a document written from scratch. */
export const DEFAULT_CUTSCENE_LAYOUT: CutsceneLayout = Object.freeze({
  newline: '\n',
  indentUnit: '    ',
  trailingNewline: '',
})

/**
 * Read the layout back out of the source text.
 *
 * The indent unit is taken from the first nested element rather than assumed to be four spaces: a
 * hand-edited file, or a future editor version, can use something else, and a writer that imposed
 * its own would reformat a file a human maintains.
 */
export function layoutOf(document: CutsceneDocument): CutsceneLayout {
  const { text } = document
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const firstChild = document.root.children[0]
  const indentUnit =
    firstChild === undefined
      ? DEFAULT_CUTSCENE_LAYOUT.indentUnit
      : (/(?:\r?\n)([ \t]*)$/u.exec(text.slice(0, firstChild.start))?.[1] ??
        DEFAULT_CUTSCENE_LAYOUT.indentUnit)
  // `+` rather than `*`: an optional match would succeed as the empty string at offset 0 and
  // report "no trailing newline" for every file that has one.
  const trailingNewline = /(?:\r?\n)+$/u.exec(text)?.[0] ?? ''
  return Object.freeze({
    newline,
    indentUnit: indentUnit === '' ? DEFAULT_CUTSCENE_LAYOUT.indentUnit : indentUnit,
    trailingNewline,
  })
}

function writeElement(
  element: CutsceneElement,
  depth: number,
  layout: CutsceneLayout,
  out: string[],
  fallbackLead: string,
): void {
  const indent = layout.indentUnit.repeat(depth)
  out.push(element.lead ?? fallbackLead, '<', element.tag)
  for (const attribute of element.attributes) {
    out.push(
      attribute.lead === '' ? ' ' : attribute.lead,
      attribute.name,
      '=',
      attribute.quote,
      attribute.raw,
      attribute.quote,
    )
  }
  out.push(element.gap)
  if (element.selfClosing) {
    out.push('/>')
    return
  }
  out.push('>')
  for (const child of element.children) {
    writeElement(child, depth + 1, layout, out, `${layout.newline}${layout.indentUnit.repeat(depth + 1)}`)
  }
  // A read element closes exactly where it closed; a constructed one closes on its own line.
  out.push(
    element.closeGap ??
      (element.children.length > 0 ? `${layout.newline}${indent}` : ''),
    '</',
    element.tag,
    '>',
  )
}

/** Serialise to text. `layout` defaults to the document's own, so a read file writes back as read. */
export function encodeCutsceneText(
  document: CutsceneDocument,
  layout: CutsceneLayout = layoutOf(document),
): string {
  const out: string[] = []
  if (document.byteOrderMark) out.push('﻿')
  if (document.declaration !== '') out.push(document.declaration)
  writeElement(document.root, 0, layout, out, document.declaration === '' ? '' : layout.newline)
  out.push(layout.trailingNewline)
  return out.join('')
}

/** Serialise to bytes. */
export function encodeCutscene(
  document: CutsceneDocument,
  layout?: CutsceneLayout,
): Uint8Array {
  return encoder.encode(encodeCutsceneText(document, layout))
}
