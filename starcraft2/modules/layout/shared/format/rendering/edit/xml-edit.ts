/**
 * Offset-precise, format-preserving XML edit primitives over raw layout text.
 * Used by the edit planner (`edit/plan.ts`) to turn an intent — set an
 * attribute, insert an override child — into concrete text replacements without
 * reformatting the surrounding file.
 *
 * All functions take the full document text and an element's start offset (from
 * a resolved `SourceRef`) and return `RawEdit`s (start/end/newText, no uri —
 * the planner attaches it).
 */

export interface RawEdit {
  start: number
  end: number
  newText: string
}

export interface OpenTag {
  /** Offset of the `<`. */
  start: number
  /** Offset just past the closing `>`. */
  end: number
  /** True for `<Tag .../>`. */
  selfClosed: boolean
  /** The tag name (e.g. `Frame`, `Width`). */
  name: string
}

/** Locate the open tag of the element starting at `<` = `elementStart`. */
export function readOpenTag(text: string, elementStart: number): OpenTag | undefined {
  if (text[elementStart] !== '<') return undefined
  const nameMatch = /^<\s*([^\s/>]+)/.exec(text.slice(elementStart, elementStart + 200))
  const name = nameMatch?.[1] ?? ''

  let quote: string | undefined
  let prev = ''
  for (let i = elementStart + 1; i < text.length; i++) {
    const ch = text[i]!
    if (quote) { if (ch === quote) quote = undefined; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') return { start: elementStart, end: i + 1, selfClosed: prev === '/', name }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') prev = ch
  }
  return undefined
}

const ATTR_RE = (name: string): RegExp => new RegExp(`\\b${escapeRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')

/**
 * Edit(s) to set `attr="value"` on the element at `elementStart`: replace the
 * existing quoted value in place, or insert a new attribute before the tag
 * close. Returns [] if the element can't be read.
 */
export function setAttribute(text: string, elementStart: number, attr: string, value: string): RawEdit[] {
  const tag = readOpenTag(text, elementStart)
  if (!tag) return []
  const openText = text.slice(tag.start, tag.end)
  const m = ATTR_RE(attr).exec(openText)
  if (m) {
    // Replace the inner value (between the quotes) of the matched attribute.
    const quoted = m[1]!
    const innerStartInOpen = m.index + m[0]!.length - quoted.length + 1
    const start = tag.start + innerStartInOpen
    return [{ start, end: start + (quoted.length - 2), newText: escapeAttr(value) }]
  }
  // Insert ` attr="value"` before the `>` / `/>`.
  const insertAt = tag.selfClosed ? findSelfCloseSlash(text, tag) : tag.end - 1
  return [{ start: insertAt, end: insertAt, newText: ` ${attr}="${escapeAttr(value)}"` }]
}

/**
 * Edit to insert `childXml` as the first child of the element at `elementStart`.
 * Expands a self-closing element to an open/close pair. Indentation is derived
 * from the element's own line.
 */
export function insertFirstChild(text: string, elementStart: number, childXml: string): RawEdit[] {
  const tag = readOpenTag(text, elementStart)
  if (!tag) return []
  const indent = lineIndent(text, elementStart)
  const childIndent = `${indent}    `

  if (tag.selfClosed) {
    const slash = findSelfCloseSlash(text, tag)
    // `<Tag ... />` → `<Tag ...>\n  <child/>\n</Tag>` (drop the `/`).
    return [{
      start: slash,
      end: tag.end,
      newText: `>\n${childIndent}${childXml}\n${indent}</${tag.name}>`,
    }]
  }
  return [{ start: tag.end, end: tag.end, newText: `\n${childIndent}${childXml}` }]
}

/** Edit to delete the element spanning [start, end], plus its leading indentation/newline. */
export function deleteElement(text: string, start: number, end: number): RawEdit[] {
  let from = start
  // Swallow the whitespace back to (and including) the preceding newline.
  while (from > 0 && (text[from - 1] === ' ' || text[from - 1] === '\t')) from--
  if (from > 0 && text[from - 1] === '\n') from--
  return [{ start: from, end, newText: '' }]
}

function findSelfCloseSlash(text: string, tag: OpenTag): number {
  // Search backward from the `>` for the `/`.
  for (let i = tag.end - 2; i > tag.start; i--) {
    const ch = text[i]!
    if (ch === '/') return i
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') break
  }
  return tag.end - 1
}

function lineIndent(text: string, offset: number): string {
  let lineStart = offset
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--
  let i = lineStart
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  return text.slice(lineStart, i)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
