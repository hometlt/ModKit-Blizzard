/**
 * Key-level diffing of SC2 string files. See docs/tasks-active/entity-cards-strings/PLAN-strings-cards-views.md (A8).
 *
 * Two robust entry points:
 *  - `diffStringTexts(old, new)` compares two full file texts via the line-model
 *    (preferred — exact, last-wins), and
 *  - `parseStringFileDiff(unifiedDiff)` parses a `git diff` hunk when only the patch
 *    text is available.
 *
 * Browser-safe (pure). The Node side (`@modkitx/strings/node`) drives git + staging.
 */

import { parseSc2StringsOrdered } from './text-file.js'

export interface StringChange {
  key: string
  kind: 'added' | 'modified' | 'deleted'
  oldValue?: string
  newValue?: string
}

/** Effective (last-wins) key→value map for a string-file text. */
function effective(text: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of parseSc2StringsOrdered(text).lines) if (line.isEntry) m.set(line.key, line.value)
  return m
}

/** Compare two string-file texts key by key. */
export function diffStringTexts(oldText: string, newText: string): StringChange[] {
  const o = effective(oldText)
  const n = effective(newText)
  const out: StringChange[] = []
  for (const [key, nv] of n) {
    const ov = o.get(key)
    if (ov === undefined) out.push({ key, kind: 'added', newValue: nv })
    else if (ov !== nv) out.push({ key, kind: 'modified', oldValue: ov, newValue: nv })
  }
  for (const [key, ov] of o) if (!n.has(key)) out.push({ key, kind: 'deleted', oldValue: ov })
  return out
}

/** The added and modified keys with their new values as a `key=value` file — what a translator is handed. */
export function changedStringsText(changes: readonly StringChange[]): string {
  return stringsText(changes.flatMap(c => (c.kind === 'deleted' || c.newValue === undefined ? [] : [{ key: c.key, value: c.newValue }])))
}

/** Entries as an SC2 `key=value` file. */
export function stringsText(entries: readonly { key: string; value: string }[]): string {
  return entries.map(e => `${e.key}=${e.value}`).join('\n') + (entries.length ? '\n' : '')
}

/** Parse a unified `git diff` of a `key=value` file into key-level changes. */
export function parseStringFileDiff(unifiedDiff: string): StringChange[] {
  const removed = new Map<string, string>()
  const added = new Map<string, string>()
  for (const line of unifiedDiff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    const sign = line[0]
    if (sign !== '+' && sign !== '-') continue
    const body = line.slice(1)
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    ;(sign === '+' ? added : removed).set(body.slice(0, eq), body.slice(eq + 1))
  }
  const out: StringChange[] = []
  for (const [key, nv] of added) {
    if (removed.has(key)) out.push({ key, kind: 'modified', oldValue: removed.get(key)!, newValue: nv })
    else out.push({ key, kind: 'added', newValue: nv })
  }
  for (const [key, ov] of removed) if (!added.has(key)) out.push({ key, kind: 'deleted', oldValue: ov })
  return out
}
