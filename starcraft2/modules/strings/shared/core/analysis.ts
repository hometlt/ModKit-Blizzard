/**
 * String-file analysis & diagnostics. See docs/tasks-active/entity-cards-strings/PLAN-strings-cards-views.md (A6).
 *
 * Two kinds of output:
 *  - per-file diagnostics (duplicate keys, broken `<d ref>`, empty values), and
 *  - cross-locale comparison (missing / orphaned / identical / empty) used by the
 *    VS Code strings table to drive status badges and the translate workflow.
 *
 * Browser-safe.
 */

import type { StringFileModel } from './text-file.js'
import { resolveStringValue, type CatalogResolver, type ResolvedSegment } from './resolve.js'
import { validateMarkupSyntax, parseMarkup, type MarkupSegment } from './markup.js'

export type StringDiagnosticCode =
  'duplicate-key' | 'broken-ref' | 'malformed-markup' | 'invalid-hotkey'

export interface StringDiagnostic {
  key: string
  /** Index into `model.lines` of the offending line. */
  line: number
  severity: 'error' | 'warning'
  code: StringDiagnosticCode
  message: string
  /** Character offset range within the value (right of `key=`) covering just the
   * offending fragment (a `<d ref>` tag, a malformed token, …), when known — lets
   * consumers underline only that substring instead of the whole value. */
  start?: number
  end?: number
}

/**
 * Per-file diagnostics. Duplicate keys are warnings (a later line overrides an
 * earlier line with the same key at load time). Broken refs require a resolver.
 */
export function analyzeStringFile(
  model: StringFileModel,
  resolver?: CatalogResolver,
): StringDiagnostic[] {
  const out: StringDiagnostic[] = []

  // Duplicate keys → warning on every occurrence after the first.
  for (const [key, lines] of model.index) {
    if (lines.length < 2) continue
    for (let i = 1; i < lines.length; i++) {
      out.push({
        key,
        line: model.lines.indexOf(lines[i]!),
        severity: 'warning',
        code: 'duplicate-key',
        message: `Duplicate key "${key}" (${lines.length} occurrences); this line overrides the earlier value`,
      })
    }
  }

  // Empty values are intentional and very common in SC2 strings (e.g. blank
  // Abil/Name/* entries), so they are NOT diagnosed here. Cross-locale "empty" is
  // reported by compareLocales for the translation workflow instead.
  for (let i = 0; i < model.lines.length; i++) {
    const line = model.lines[i]!
    if (
      !line.isEntry ||
      !(line.value.includes('~') || line.value.includes('[d') || line.value.includes('<d'))
    )
      continue
    for (const issue of validateMarkupSyntax(line.value)) {
      out.push({
        key: line.key,
        line: i,
        severity: 'error',
        code: 'malformed-markup',
        message: issue.message,
        start: issue.offset,
        end: issue.offset + issue.raw.length,
      })
    }
  }

  if (resolver) {
    for (let i = 0; i < model.lines.length; i++) {
      const line = model.lines[i]!
      if (
        !line.isEntry ||
        !(line.value.includes('<') || line.value.includes('$') || line.value.includes('[d'))
      )
        continue
      const markupSegs = parseMarkup(line.value)
      const resolvedSegs = resolveStringValue(line.value, resolver).segments
      for (const err of collectRefErrors(markupSegs, resolvedSegs, 0)) {
        out.push({
          key: line.key,
          line: i,
          severity: 'error',
          code: 'broken-ref',
          message: `Unresolved reference: ${err.error}`,
          start: err.start,
          end: err.end,
        })
      }
    }
  }

  return out
}

interface RefError {
  start: number
  end: number
  error: string
}

/**
 * Locate the offset span of each unresolved `ref`/`stringref` segment. `markupSegs`
 * and `resolvedSegs` are both derived from the same `parseMarkup(value)` call
 * (`resolveStringValue` maps 1:1 over it, recursing into children in the same
 * order), so they can be walked in parallel by index to recover the exact source
 * offsets that `ResolvedSegment` itself doesn't carry.
 */
function collectRefErrors(
  markupSegs: MarkupSegment[],
  resolvedSegs: ResolvedSegment[],
  base: number,
): RefError[] {
  const out: RefError[] = []
  let pos = base
  for (let i = 0; i < markupSegs.length; i++) {
    const m = markupSegs[i]!
    const r = resolvedSegs[i]
    const len = m.kind === 'text' ? m.text.length : m.raw.length
    if (r && (r.kind === 'ref' || r.kind === 'stringref') && r.error) {
      out.push({ start: pos, end: pos + len, error: r.error })
    }
    if ('children' in m && m.children.length && r && 'children' in r) {
      const openLen = Math.max(1, m.raw.indexOf('>') + 1) // e.g. `<c val="...">` — content starts right after
      out.push(...collectRefErrors(m.children, r.children, pos + openLen))
    }
    pos += len
  }
  return out
}

export interface LocaleComparison {
  /** Keys present in source but missing from target. */
  missing: string[]
  /** Keys present in target but not in source (stale translations). */
  orphaned: string[]
  /** Keys whose target value equals the source value (likely untranslated). */
  identical: string[]
  /** Keys whose target value is empty. */
  empty: string[]
  total: number
  translated: number
}

/** Compare a target locale against a source locale (effective last-wins values). */
export function compareLocales(source: StringFileModel, target: StringFileModel): LocaleComparison {
  const srcVal = effectiveMap(source)
  const tgtVal = effectiveMap(target)

  const missing: string[] = []
  const identical: string[] = []
  const empty: string[] = []
  let translated = 0

  for (const [key, sv] of srcVal) {
    const tv = tgtVal.get(key)
    if (tv === undefined) {
      missing.push(key)
      continue
    }
    if (tv === '') {
      empty.push(key)
      continue
    }
    if (tv === sv) {
      identical.push(key)
      continue
    }
    translated++
  }

  const orphaned: string[] = []
  for (const key of tgtVal.keys()) if (!srcVal.has(key)) orphaned.push(key)

  return { missing, orphaned, identical, empty, total: srcVal.size, translated }
}

function effectiveMap(model: StringFileModel): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of model.lines) if (line.isEntry) m.set(line.key, line.value) // later wins
  return m
}
