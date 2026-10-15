/**
 * `ComponentList.SC2Components` — the package's own list of what the game loads.
 *
 * The parse is the shared one every SC2 container already uses to find its text locales; this file
 * only says whether a byte run is such a list at all.
 */

import { parseVersionFile, typeTagFor, writeVersionFile } from './version-file.js'
import type { VersionFileWriteInput } from './types.js'

export interface ComponentListEntry {
  readonly type: string
  readonly path: string
  readonly locale?: string
}

const COMPONENTS_ROOT = /^\s*(?:<\?xml\b[^>]*>\s*)?<Components(?:\s|>|\/>)/u

export function isComponentListText(text: string): boolean {
  return COMPONENTS_ROOT.test(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

export function parseComponentListEntries(text: string): readonly ComponentListEntry[] {
  return Object.freeze(
    parseComponentList(text).components.map(entry =>
      Object.freeze({
        type: entry.type,
        path: entry.path,
        ...(entry.locale === undefined ? {} : { locale: entry.locale }),
      }),
    ),
  )
}

/** Whether the list declares a `Type="text"` component for `locale` (compared without case). */
export function componentListHasLocale(text: string, locale: string): boolean {
  const wanted = locale.toLowerCase()
  return parseComponentListEntries(text).some(
    entry => entry.type.toLowerCase() === 'text' && entry.locale?.toLowerCase() === wanted,
  )
}

/**
 * Declare a text locale: insert `<DataComponent Type="text" Locale="…">` before `</Components>`,
 * reusing an existing text component's value and indentation. Unchanged when the locale is already
 * declared or the list has no `</Components>`.
 */
export function addTextLocaleToComponentList(text: string, locale: string, value = 'GameText'): string {
  if (componentListHasLocale(text, locale)) return text
  const close = text.search(/<\/Components>/iu)
  if (close === -1) return text
  const existing = /([ \t]*)<DataComponent\b[^>]*\bType="text"[^>]*>([^<]*)<\/DataComponent>\s*\n/iu.exec(text)
  const indent = existing?.[1] ?? '    '
  const line = `${indent}<DataComponent Type="text" Locale="${locale}">${existing?.[2] ?? value}</DataComponent>\n`
  const lineStart = text.lastIndexOf('\n', close - 1) + 1
  return text.slice(0, lineStart) + line + text.slice(lineStart)
}

/**
 * LEGACY plain-text reader: returns every non-comment line. Only the custom/test
 * flat-text `ComponentList.SC2Components` convention (one dependency path per line)
 * uses this shape. Real SC2 files are XML — use {@link parseComponentList}, which
 * routes by `isXml`.
 */
export function parseSc2ComponentList(text: string): string[] {
  const lines: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line && !line.startsWith('//') && !line.startsWith('#')) {
      lines.push(line)
    }
  }
  return lines
}

/** One `<DataComponent>` entry from a `ComponentList.SC2Components` file. */
export interface ComponentEntry {
  /** FourCC-ish kind: `gada`|`text`|`info`|`mapi`|`trig`|`cuts`|`plob`|`font`|`uiui`… */
  type: string
  /** Present iff `Type="text"`; the declared locale (PascalCase, e.g. `enUS`). */
  locale?: string
  /** Inner text — the data path/stem, e.g. `GameData` / `GameText` / `UI/Layout/DescIndex.SC2Layout`. */
  path: string
}

export interface ComponentListResult {
  components: ComponentEntry[]
  /** Distinct declared locales (`Type="text" Locale=…`), first-seen order. */
  locales: string[]
  /** true when the text is the SC2 `<Components>` XML form (vs the legacy flat text). */
  isXml: boolean
}

const RE_DATA_COMPONENT = /<DataComponent\b([^>]*)>([\s\S]*?)<\/DataComponent>/gi

/**
 * Structurally parse a SC2 `ComponentList.SC2Components` file (the XML form), yielding
 * typed `<DataComponent>` records and the authoritative set of declared locales.
 *
 * Browser-safe: pure regex/string scanning, zero deps. Attribute order is tolerated
 * (`Type` and `Locale` are matched independently). `isXml` is false for the legacy
 * flat-text convention (no `<Components>` wrapper), in which case there are no
 * components/locales — callers fall back to {@link parseSc2ComponentList}.
 */
export function parseComponentList(text: string): ComponentListResult {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // strip BOM
  const isXml = /<Components\b/i.test(text)
  const components: ComponentEntry[] = []
  const locales: string[] = []
  if (!isXml) return { components, locales, isXml }

  const seen = new Set<string>()
  RE_DATA_COMPONENT.lastIndex = 0
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = RE_DATA_COMPONENT.exec(text))) {
    const attrs = m[1]!
    const type = attrs.match(/\bType="([^"]*)"/i)?.[1] ?? ''
    const locale = attrs.match(/\bLocale="([^"]*)"/i)?.[1]
    const entry: ComponentEntry = { type, path: m[2]!.trim() }
    if (locale !== undefined) {
      entry.locale = locale
      if (!seen.has(locale)) {
        seen.add(locale)
        locales.push(locale)
      }
    }
    components.push(entry)
  }
  return { components, locales, isXml }
}


/** Plan missing root component sidecars using an explicit caller-selected native version profile.
 * A text component's locales share the same root GameText.version. Existing valid sidecars
 * are preserved byte-for-byte; malformed/mismatched ones refuse instead of being overwritten.
 * This is a pure package plan: it neither chooses an installation/build nor writes files.
 */
export function planSc2ComponentVersions(
  files: ReadonlyMap<string, Uint8Array>,
  profile: VersionFileWriteInput,
): readonly { path: string; bytes: Uint8Array }[] {
  const folded = new Map<string, Uint8Array>()
  for (const [path, bytes] of files) {
    const key = path.replaceAll('\\', '/').toLowerCase()
    if (folded.has(key)) throw new TypeError('Ambiguous case-insensitive package path')
    folded.set(key, bytes)
  }
  const bytes = folded.get('componentlist.sc2components')
  if (bytes === undefined || bytes.byteLength > 1024 * 1024)
    throw new RangeError('Component versions need a bounded ComponentList.SC2Components')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!isComponentListText(text)) throw new TypeError('Component versions require an XML component list')
  const components = parseComponentListEntries(text)
  if (components.length > 1024) throw new RangeError('Too many package components')
  const result: { path: string; bytes: Uint8Array }[] = []
  const planned = new Map<string, string>()
  for (const component of components) {
    const path = component.path.replaceAll('\\', '/')
    if (!path || path.length > 4096 || /^[A-Za-z]:|^\//u.test(path) || /[\u0000-\u001f]/u.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new TypeError('Unsafe component path')
    const tag = typeTagFor(component.type)
    if (tag === undefined) throw new TypeError(`Unsupported component type ${component.type}`)
    const versionPath = path.replace(/\.(?:xml|SC2Layout|SC2Style)$/iu, '') + '.version'
    const key = versionPath.toLowerCase()
    const priorTag = planned.get(key)
    if (priorTag !== undefined) {
      if (priorTag !== tag) throw new TypeError('Conflicting component version types')
      continue
    }
    planned.set(key, tag)
    const existing = folded.get(key)
    if (existing !== undefined) {
      const version = parseVersionFile(existing)
      if (version !== null && version.typeTag !== tag) throw new TypeError(`Component version type mismatch: ${versionPath}`)
      continue
    }
    result.push({ path: versionPath, bytes: writeVersionFile({ ...profile, typeTag: tag }) })
  }
  return result
}
