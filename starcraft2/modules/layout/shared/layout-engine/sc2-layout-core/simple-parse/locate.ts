/**
 * Locate a frame's source position in raw `.SC2Layout` XML by its name path,
 * without a position-tracking parser: a lightweight scanner that only follows
 * `<Frame>` open/close nesting (frames never nest inside other element kinds
 * in valid layouts) while staying correct across comments, CDATA, quoted
 * attribute values containing `>`/`<Frame`, and self-closing tags.
 */

export interface FrameLocation {
  /** Byte offset of the frame's `<` in the source text. */
  offset: number
  /** 0-based line of the frame's opening tag. */
  line: number
  /** 0-based character (column) of the frame's opening tag. */
  character: number
}

/**
 * Find the opening `<Frame …>` tag matching `framePath` (frame `name`
 * attributes from the file root down, compared case-insensitively — SC2
 * resolves desc names case-insensitively). Returns the first match in
 * document order, or undefined.
 */
export function locateFrame(xmlText: string, framePath: readonly string[]): FrameLocation | undefined {
  if (framePath.length === 0) return undefined
  const target = framePath.map((s) => s.toLowerCase())
  const stack: string[] = []
  const len = xmlText.length
  let i = 0

  while (i < len) {
    const lt = xmlText.indexOf('<', i)
    if (lt === -1) break

    if (xmlText.startsWith('<!--', lt)) {
      const end = xmlText.indexOf('-->', lt + 4)
      if (end === -1) break
      i = end + 3
      continue
    }
    if (xmlText.startsWith('<![CDATA[', lt)) {
      const end = xmlText.indexOf(']]>', lt + 9)
      if (end === -1) break
      i = end + 3
      continue
    }

    const tag = scanTag(xmlText, lt)
    if (!tag) break

    if (isFrameTag(xmlText, lt + 1, false)) {
      const name = attrValue(xmlText.slice(lt, tag.end + 1), 'name') ?? ''
      const depth = stack.length
      const matches =
        depth === target.length - 1 &&
        name.toLowerCase() === target[depth] &&
        stackMatches(stack, target)
      if (matches) return withPosition(xmlText, lt)
      if (!tag.selfClosing) stack.push(name.toLowerCase())
    } else if (isFrameTag(xmlText, lt + 1, true)) {
      stack.pop()
    }

    i = tag.end + 1
  }
  return undefined
}

function stackMatches(stack: readonly string[], target: readonly string[]): boolean {
  for (let d = 0; d < stack.length; d++) if (stack[d] !== target[d]) return false
  return true
}

/** True when the tag starting after `<` (or `</` when closing) is exactly `Frame`. */
function isFrameTag(text: string, afterLt: number, closing: boolean): boolean {
  const start = closing ? afterLt + 1 : afterLt
  if (closing && text[afterLt] !== '/') return false
  if (!text.startsWith('Frame', start)) return false
  const next = text[start + 5]
  return next === ' ' || next === '\t' || next === '\r' || next === '\n' || next === '>' || next === '/'
}

/**
 * Scan from `<` to the matching `>` honoring quoted attribute values (raw `>`
 * is legal inside them). Returns the `>` offset and whether the tag self-closes.
 */
function scanTag(text: string, lt: number): { end: number; selfClosing: boolean } | undefined {
  let quote: string | undefined
  let lastMeaningful = ''
  for (let i = lt + 1; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') return { end: i, selfClosing: lastMeaningful === '/' }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') lastMeaningful = ch
  }
  return undefined
}

/** Extract an attribute value from a single tag's text (quote-aware, first match). */
function attrValue(tagText: string, attr: string): string | undefined {
  const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const m = re.exec(tagText)
  return m ? (m[2] ?? m[3]) : undefined
}

function withPosition(text: string, offset: number): FrameLocation {
  let line = 0
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1 }
  }
  return { offset, line, character: offset - lineStart }
}
