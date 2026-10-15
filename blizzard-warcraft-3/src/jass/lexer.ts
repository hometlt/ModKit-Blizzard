/**
 * JASS 2 tokens: the language of `common.j`, `Blizzard.j`, `common.ai` and `war3map.j`.
 *
 * JASS is line-oriented — a statement ends at the end of its line — so line breaks are tokens.
 * Every token keeps its UTF-16 offsets into the source; positions are derived from them once.
 */

export type JassTokenKind =
  | 'identifier'
  | 'keyword'
  | 'integer'
  | 'real'
  | 'string'
  | 'rawcode'
  | 'operator'
  | 'newline'
  | 'comment'
  | 'end'
  | 'invalid'

export interface JassToken {
  readonly kind: JassTokenKind
  readonly text: string
  readonly start: number
  readonly end: number
}

export const JASS_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'extends', 'globals', 'endglobals', 'constant', 'native', 'function', 'takes',
  'returns', 'endfunction', 'local', 'array', 'set', 'call', 'if', 'then', 'elseif', 'else',
  'endif', 'loop', 'exitwhen', 'endloop', 'return', 'debug', 'and', 'or', 'not', 'true',
  'false', 'null', 'nothing',
])

const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', '=', '+', '-', '*', '/', ',', '(', ')', '[', ']']

const isIdentifierStart = (code: number) =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f
const isDigit = (code: number) => code >= 0x30 && code <= 0x39
const isHex = (code: number) => isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)

/** Tokens of `text`, comments included; the last token is always `end`. */
export function lexJass(text: string, signal?: AbortSignal): JassToken[] {
  const tokens: JassToken[] = []
  const push = (kind: JassTokenKind, start: number, end: number) =>
    tokens.push({ kind, text: text.slice(start, end), start, end })
  let at = 0
  while (at < text.length) {
    if ((tokens.length & 0xfff) === 0) signal?.throwIfAborted()
    const code = text.charCodeAt(at)
    const start = at
    if (code === 0x0a || code === 0x0d) {
      at += code === 0x0d && text.charCodeAt(at + 1) === 0x0a ? 2 : 1
      push('newline', start, at)
    } else if (code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c || code === 0xfeff) {
      at += 1
    } else if (code === 0x2f && text.charCodeAt(at + 1) === 0x2f) {
      while (at < text.length && text.charCodeAt(at) !== 0x0a && text.charCodeAt(at) !== 0x0d) at += 1
      push('comment', start, at)
    } else if (isIdentifierStart(code)) {
      at += 1
      while (at < text.length) {
        const next = text.charCodeAt(at)
        if (!isIdentifierStart(next) && !isDigit(next)) break
        at += 1
      }
      push(JASS_KEYWORDS.has(text.slice(start, at)) ? 'keyword' : 'identifier', start, at)
    } else if (code === 0x24 || (code === 0x30 && (text[at + 1] === 'x' || text[at + 1] === 'X'))) {
      // Hexadecimal: $FF or 0xFF.
      at += code === 0x24 ? 1 : 2
      const digits = at
      while (at < text.length && isHex(text.charCodeAt(at))) at += 1
      push(at > digits ? 'integer' : 'invalid', start, at)
    } else if (isDigit(code) || (code === 0x2e && isDigit(text.charCodeAt(at + 1)))) {
      let real = false
      while (at < text.length && isDigit(text.charCodeAt(at))) at += 1
      if (text.charCodeAt(at) === 0x2e) {
        real = true
        at += 1
        while (at < text.length && isDigit(text.charCodeAt(at))) at += 1
      }
      push(real ? 'real' : 'integer', start, at)
    } else if (code === 0x22) {
      at += 1
      while (at < text.length && text.charCodeAt(at) !== 0x22) {
        if (text.charCodeAt(at) === 0x5c) at += 1
        at += 1
      }
      const closed = at < text.length
      if (closed) at += 1
      push(closed ? 'string' : 'invalid', start, at)
    } else if (code === 0x27) {
      at += 1
      while (at < text.length && text.charCodeAt(at) !== 0x27 && text.charCodeAt(at) !== 0x0a) {
        if (text.charCodeAt(at) === 0x5c) at += 1
        at += 1
      }
      const closed = text.charCodeAt(at) === 0x27
      if (closed) at += 1
      const length = at - start - 2
      push(closed && (length === 1 || length === 4) ? 'rawcode' : 'invalid', start, at)
    } else {
      const operator = OPERATORS.find(candidate => text.startsWith(candidate, at))
      at += operator?.length ?? 1
      push(operator === undefined ? 'invalid' : 'operator', start, at)
    }
  }
  push('end', text.length, text.length)
  return tokens
}

/** Line starts of `text`, for turning offsets into editor positions. */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at)
    if (code === 0x0d && text.charCodeAt(at + 1) === 0x0a) continue
    if (code === 0x0a || code === 0x0d) starts.push(at + 1)
  }
  return starts
}

export function positionAt(starts: readonly number[], offset: number): { line: number; character: number } {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return { line: low, character: offset - starts[low]! }
}
