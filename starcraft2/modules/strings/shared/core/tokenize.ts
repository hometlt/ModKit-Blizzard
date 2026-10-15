/**
 * Flat tokenizer for SC2 localized string values. Produces a non-overlapping,
 * left-to-right list of typed spans that cover the whole value, so it can drive
 * a syntax-highlight overlay (the VS Code strings-table cell editor) with the
 * same coloring the rendered view uses.
 *
 * This is a scanner (not the structural `parseMarkup`) because highlighting needs
 * offset-accurate sub-tokens inside a tag — punctuation, attribute names, quoted
 * values, and the `+ - * / ( )` operators used inside `<d ref>` expressions.
 *
 * Browser-safe: pure string scanning, zero dependencies.
 */

export type TokenScope =
  | 'text'
  | 'comment'
  | 'punctuation'
  | 'tag'
  | 'attribute'
  | 'string'
  | 'operator'
  | 'ref'
  | 'stringref'
  | 'galaxyvar'
  | 'dynamic'
  | 'token'
  | 'hotkey'
  | 'newline'
  | 'image'
  | 'unknown'

export interface StringToken {
  start: number
  end: number
  scope: TokenScope
}

export type KeyTokenScope = 'namespace' | 'punctuation' | 'property' | 'objectid'

export interface KeyToken {
  start: number
  end: number
  scope: KeyTokenScope
}

/**
 * Split a localization key (`Race/Name/Zerg`, the part left of `=`) into typed
 * segments: the first segment is the catalog/namespace, the last is the object
 * id, and everything between is the property path. Two-segment keys (no
 * property) tag the second segment as the object id.
 */
export function tokenizeStringKey(key: string): KeyToken[] {
  const out: KeyToken[] = []
  const parts = key.split('/')
  let pos = 0
  parts.forEach((part, i) => {
    const scope: KeyTokenScope =
      i === 0 ? 'namespace' : i === parts.length - 1 && parts.length > 1 ? 'objectid' : 'property'
    if (part.length) out.push({ start: pos, end: pos + part.length, scope })
    pos += part.length
    if (i < parts.length - 1) {
      out.push({ start: pos, end: pos + 1, scope: 'punctuation' })
      pos += 1
    }
  })
  return out
}

/** Attributes whose value is a numeric/reference expression (operators highlighted). */
const EXPRESSION_ATTRS = new Set(
  [
    'ref',
    'time',
    'gamevalue',
    'score',
    'unitcount',
    'abilchargecount',
    'behaviorstackcount',
    'behaviorremainingduration',
    'upgradelevel',
    'upgradeeffectarrayvalue',
    'accumulatedvalue',
    'runaccumulators',
    'damage',
    'attackdamage',
  ].map(s => s.toLowerCase()),
)

const TAG_RE = /^<\/?[A-Za-z][^>]*>/
const TAG_NAME_RE = /^<\/?\s*([A-Za-z][\w]*)/
const DOLLAR_RE = /^\$[A-Za-z][^$]*\$/
const TILDE_RE = /^~[A-Za-z][A-Za-z0-9_]*(?:\|[A-Za-z][A-Za-z0-9_]*)*~/
const PERCENT_RE = /^%[A-Za-z][A-Za-z0-9_]*%/
const OP_RE = /[()*/+-]/g

/** Recognized SC2 string-markup tag names; anything else is plain text (e.g. `<None>`). */
const KNOWN_TAGS = new Set([
  'n',
  'sp',
  'h',
  'd',
  'c',
  's',
  'img',
  'k',
  'ul',
  'li',
  'w',
  'lang',
  'a',
  'ignore',
])

/** Scope for a `<tag …>` based on its name + attributes. */
function tagScope(name: string, attrKeys: string[]): TokenScope {
  const n = name.toLowerCase()
  if (n === 'n' || n === 'sp' || n === 'h') return 'newline'
  if (n === 'c') return 'tag'
  if (n === 's') return 'tag'
  if (n === 'k') return 'hotkey'
  if (n === 'img') return 'image'
  if (n === 'd') {
    const keys = attrKeys.map(k => k.toLowerCase())
    if (keys.includes('stringref')) return 'stringref'
    if (keys.includes('galaxyvar')) return 'galaxyvar'
    if (keys.some(k => EXPRESSION_ATTRS.has(k) && k !== 'ref' && k !== 'time')) return 'dynamic'
    return 'ref'
  }
  return 'tag'
}

/** Tokenize the quoted value of an expression attribute: strings + operators. */
function pushExpressionValue(value: string, valueStart: number, out: StringToken[]): void {
  OP_RE.lastIndex = 0
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = OP_RE.exec(value)) !== null) {
    if (m.index > pos)
      out.push({ start: valueStart + pos, end: valueStart + m.index, scope: 'string' })
    out.push({ start: valueStart + m.index, end: valueStart + m.index + 1, scope: 'operator' })
    pos = m.index + 1
  }
  if (pos < value.length)
    out.push({ start: valueStart + pos, end: valueStart + value.length, scope: 'string' })
}

/** Tokenize a single `<…>` tag occupying [start, end) of the source. */
function pushTag(src: string, start: number, end: number, out: StringToken[]): void {
  const raw = src.slice(start, end)
  const nameMatch = /^<\/?\s*([A-Za-z][\w]*)/.exec(raw)
  const attrKeys: string[] = []
  const attrRe = /([A-Za-z_]\w*)\s*=/g
  let am: RegExpExecArray | null
  while ((am = attrRe.exec(raw)) !== null) attrKeys.push(am[1]!)
  const base = nameMatch ? tagScope(nameMatch[1]!, attrKeys) : 'tag'

  const sub: StringToken[] = []
  // Opening punctuation: `<` or `</`.
  const openPunct = /^<\/?/.exec(raw)![0]
  sub.push({ start, end: start + openPunct.length, scope: 'punctuation' })
  let i = openPunct.length
  if (nameMatch) {
    const nameStart = raw.indexOf(nameMatch[1]!, i)
    if (nameStart >= i) {
      sub.push({
        start: start + nameStart,
        end: start + nameStart + nameMatch[1]!.length,
        scope: base,
      })
      i = nameStart + nameMatch[1]!.length
    }
  }
  // Attributes: name = "value" | 'value'.
  const attrScan = /([A-Za-z_]\w*)\s*=\s*("([^"]*)"|'([^']*)')/g
  attrScan.lastIndex = i
  let m: RegExpExecArray | null
  while ((m = attrScan.exec(raw)) !== null) {
    const attrName = m[1]!
    const nameStart = m.index
    sub.push({
      start: start + nameStart,
      end: start + nameStart + attrName.length,
      scope: 'attribute',
    })
    const quoted = m[2]!
    const quoteStart = m.index + m[0].length - quoted.length
    const inner = m[3] ?? m[4] ?? ''
    const innerStart = quoteStart + 1
    // opening quote
    sub.push({ start: start + quoteStart, end: start + innerStart, scope: 'string' })
    if (inner.length) {
      if (EXPRESSION_ATTRS.has(attrName.toLowerCase()))
        pushExpressionValue(inner, start + innerStart, sub)
      else
        sub.push({
          start: start + innerStart,
          end: start + innerStart + inner.length,
          scope: 'string',
        })
    }
    // closing quote
    sub.push({
      start: start + innerStart + inner.length,
      end: start + quoteStart + quoted.length,
      scope: 'string',
    })
  }

  // Fill gaps with the base scope so coverage of [start,end) is contiguous.
  sub.sort((a, b) => a.start - b.start)
  let cursor = start
  for (const t of sub) {
    if (t.start > cursor) out.push({ start: cursor, end: t.start, scope: base })
    out.push(t)
    cursor = Math.max(cursor, t.end)
  }
  if (cursor < end) out.push({ start: cursor, end, scope: base })
}

/**
 * Tokenize a localized string value into contiguous, non-overlapping spans.
 * `commentAware` (default true) treats the first `///` as a trailing comment.
 */
export function tokenizeStringValue(value: string, commentAware = true): StringToken[] {
  const out: StringToken[] = []
  const commentAt = commentAware ? value.indexOf('///') : -1
  const scanEnd = commentAt >= 0 ? commentAt : value.length

  let i = 0
  let textStart = 0
  const flushText = (end: number): void => {
    if (end > textStart) out.push({ start: textStart, end, scope: 'text' })
  }
  while (i < scanEnd) {
    const ch = value[i]
    let raw: string | undefined
    let scope: TokenScope | undefined
    if (ch === '<') {
      const m = TAG_RE.exec(value.slice(i, scanEnd))
      const tagName = m ? TAG_NAME_RE.exec(m[0])?.[1] : undefined
      if (m && tagName && KNOWN_TAGS.has(tagName.toLowerCase())) {
        flushText(i)
        pushTag(value, i, i + m[0].length, out)
        i += m[0].length
        textStart = i
        continue
      }
    } else if (ch === '$') {
      const m = DOLLAR_RE.exec(value.slice(i, scanEnd))
      if (m) {
        raw = m[0]
        scope = 'token'
      }
    } else if (ch === '~') {
      const m = TILDE_RE.exec(value.slice(i, scanEnd))
      if (m) {
        raw = m[0]
        scope = 'token'
      }
    } else if (ch === '%') {
      const m = PERCENT_RE.exec(value.slice(i, scanEnd))
      if (m) {
        raw = m[0]
        scope = 'token'
      }
    }
    if (raw && scope) {
      flushText(i)
      out.push({ start: i, end: i + raw.length, scope })
      i += raw.length
      textStart = i
    } else {
      i++
    }
  }
  flushText(scanEnd)
  if (commentAt >= 0) out.push({ start: commentAt, end: value.length, scope: 'comment' })
  return out
}
