/**
 * SC2 localized strings files (`GameStrings.txt` and the other `LocalizedData` tables): a key → value
 * map, and the browser-safe ordered line model used by native editing and Data localization.
 * Preserves duplicate keys, BOM, CR/CRLF/LF terminators and significant value whitespace; exposes
 * effective last-line values, byte-exact serialization, set/rename/add editing helpers. It performs
 * no I/O or markup/catalog validation; those remain with the Strings codec and analysis owner.
 * Lookup and ordered editing share one physical-line parse; lookup skips the editing-only index.
 */
/**
 * Parse a SC2 locale string file (.SC2Data/LocalizedData/*.txt or GameStrings.txt)
 * Format:  GameUI/ButtonName/Marine=Marine
 */
export function parseSc2Strings(text: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of parseStringLines(text).lines) {
    // Lookup normalizes keys only; value whitespace such as `Unlocks: ` is significant.
    if (line.isEntry) result.set(line.key.trim(), line.value)
  }
  return result
}

// ---------------------------------------------------------------------------
// Ordered line-model for locale string files (lossless / round-trip safe).
//
// `parseSc2Strings` above is a lossy lookup map: it trims, drops blank/comment
// lines, and silently collapses DUPLICATE keys (real GameStrings.txt files do
// contain duplicates). The ordered model below is the source of truth for any
// editing or byte-exact round-trip. See docs/tasks-complete/entity-cards-strings/STRING_FILE_MODEL.md.
// ---------------------------------------------------------------------------

/** One physical line of a locale `.txt` file. */
export interface StringLine {
  /** Key (text before the first `=`); '' for blank/comment lines. */
  key: string
  /** Value (everything after the first `=`); not trimmed. '' for non-entry lines. */
  value: string
  /** Exact original line text, WITHOUT the line terminator. */
  raw: string
  /** Terminator that followed this line ('' for a final line with no EOL). */
  eol: '\r\n' | '\n' | '\r' | ''
  /** True when the line contained a `=` (a real key/value entry). */
  isEntry: boolean
}

/** Ordered, lossless model of a locale string file. */
export interface StringFileModel {
  /** Whether the source began with a UTF-8 BOM (preserved on serialize). */
  bom: boolean
  /** All lines in order, including duplicates and blanks. */
  lines: StringLine[]
  /** Derived lookup: key → all entry lines with that key (last = effective). */
  index: Map<string, StringLine[]>
}

/** Split text into lines, recording each line's terminator (preserves mixed EOLs). */
function splitKeepEol(text: string): Array<{ content: string; eol: StringLine['eol'] }> {
  const out: Array<{ content: string; eol: StringLine['eol'] }> = []
  let i = 0
  for (const terminator of text.matchAll(/\r\n|\r|\n/gu)) {
    out.push({ content: text.slice(i, terminator.index), eol: terminator[0] as StringLine['eol'] })
    i = terminator.index + terminator[0].length
  }
  if (i < text.length) out.push({ content: text.slice(i), eol: '' })
  return out
}

/** Build the derived key → lines index for a model's line list. */
function buildStringIndex(lines: StringLine[]): Map<string, StringLine[]> {
  const index = new Map<string, StringLine[]>()
  for (const line of lines) {
    if (!line.isEntry) continue
    let bucket = index.get(line.key)
    if (!bucket) {
      bucket = []
      index.set(line.key, bucket)
    }
    bucket.push(line)
  }
  return index
}

/**
 * Parse a locale `.txt` into the lossless ordered model. Accepts a string or raw
 * UTF-8 bytes. Preserves BOM, per-line terminators, blank/comment lines, value
 * whitespace, and duplicate keys. Round-trips byte-exact via {@link serializeStringModel}.
 */
export function parseSc2StringsOrdered(input: string | Uint8Array): StringFileModel {
  const parsed = parseStringLines(input)
  return { ...parsed, index: buildStringIndex(parsed.lines) }
}

/** One native BOM/EOL/entry parse; each consumer owns only its required derived lookup/index. */
function parseStringLines(input: string | Uint8Array): Pick<StringFileModel, 'bom' | 'lines'> {
  let text: string
  let bom = false
  if (typeof input === 'string') {
    if (input.charCodeAt(0) === 0xfeff) {
      bom = true
      text = input.slice(1)
    } else text = input
  } else {
    bom = input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf
    // TextDecoder('utf-8') strips a leading BOM by default, so the decoded text
    // has no BOM char regardless; we tracked it from the raw bytes above.
    text = new TextDecoder('utf-8').decode(input)
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  }

  const lines: StringLine[] = splitKeepEol(text).map(({ content, eol }) => {
    const eq = content.indexOf('=')
    // A line whose key portion starts with `//` is a full-line comment (distinct
    // from the `///` trailing-comment convention on a real entry's value), even if
    // the comment text itself happens to contain an `=`.
    const keyPart = eq === -1 ? content : content.slice(0, eq)
    if (eq === -1 || keyPart.trimStart().startsWith('//')) {
      return { key: '', value: '', raw: content, eol, isEntry: false }
    }
    return {
      key: content.slice(0, eq),
      value: content.slice(eq + 1),
      raw: content,
      eol,
      isEntry: true,
    }
  })

  return { bom, lines }
}

/** Serialize the ordered model back to text, byte-exact for an unedited model. */
export function serializeStringModel(model: StringFileModel): string {
  let out = model.bom ? '﻿' : ''
  for (const line of model.lines) out += line.raw + line.eol
  return out
}

/** Effective value for a key (last occurrence wins, matching the SC2 loader). */
export function effectiveValue(model: StringFileModel, key: string): string | undefined {
  const bucket = model.index.get(key)
  return bucket && bucket.length ? bucket[bucket.length - 1]!.value : undefined
}

/** Rebuild a line's `raw` from its current key/value (after an edit). */
function rebuildRaw(line: StringLine): void {
  line.raw = line.isEntry ? `${line.key}=${line.value}` : line.raw
}

/**
 * Set the value of `key`, patching only its LAST occurrence. Returns true when a
 * line changed. Does not create the key if absent (use {@link addStringEntry}).
 */
export function setStringValue(model: StringFileModel, key: string, newValue: string): boolean {
  const bucket = model.index.get(key)
  const line = bucket && bucket.length ? bucket[bucket.length - 1]! : undefined
  if (!line || line.value === newValue) return false
  line.value = newValue
  rebuildRaw(line)
  return true
}

/** Rename a key across all its occurrences (values/terminators untouched). Returns count. */
export function renameStringKey(model: StringFileModel, oldKey: string, newKey: string): number {
  const bucket = model.index.get(oldKey)
  if (!bucket || oldKey === newKey) return 0
  for (const line of bucket) {
    line.key = newKey
    rebuildRaw(line)
  }
  model.index.delete(oldKey)
  const dest = model.index.get(newKey)
  if (dest) dest.push(...bucket)
  else model.index.set(newKey, bucket)
  return bucket.length
}

/**
 * Remove every line of `key` with its terminator; every other line keeps its bytes. Returns the
 * number of lines removed.
 */
export function removeStringKey(model: StringFileModel, key: string): number {
  const bucket = model.index.get(key)
  if (!bucket) return 0
  const removed = new Set(bucket)
  model.lines = model.lines.filter(line => !removed.has(line))
  model.index.delete(key)
  return bucket.length
}

/** Append a new entry (optionally after the last occurrence of `afterKey`). */
export function addStringEntry(
  model: StringFileModel,
  key: string,
  value: string,
  afterKey?: string,
): void {
  const line: StringLine = { key, value, raw: `${key}=${value}`, eol: '\n', isEntry: true }
  // The current last line may lack a terminator; give it one so appends are valid.
  const last = model.lines[model.lines.length - 1]
  if (last && last.eol === '') last.eol = '\n'

  let pos = model.lines.length
  if (afterKey) {
    const bucket = model.index.get(afterKey)
    const anchor = bucket && bucket.length ? bucket[bucket.length - 1] : undefined
    if (anchor) pos = model.lines.indexOf(anchor) + 1
  }
  model.lines.splice(pos, 0, line)
  const dest = model.index.get(key)
  if (dest) dest.push(line)
  else model.index.set(key, [line])
}
