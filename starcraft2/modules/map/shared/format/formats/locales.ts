/**
 * Parser and writer for `Locales.xml` embedded in `.SC2Map` / `.SC2Mod` archives.
 *
 * Format: XML listing the locale data folders present in the archive.
 *
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <Locales>
 *   <Locale name="enUS" label="en-US" required="1"/>
 *   <Locale name="deDE" label="de-DE"/>
 *   <Locale name="ruRU" label="ru-RU"/>
 * </Locales>
 * ```
 *
 * Each `<Locale>` corresponds to a `<localeCode>.SC2Data/` folder inside the
 * archive. The engine reads this file to know which localizations to offer.
 * `required="1"` (when present) marks the mandatory fallback locale.
 *
 * Browser-safe: pure regex / string scanning, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocaleEntry {
  /** Locale code, e.g. `"enUS"`, `"deDE"`. */
  name: string
  /** Human-readable BCP-47 label, e.g. `"en-US"`. May be absent. */
  label?: string
  /** When true, this is the required/fallback locale. */
  required?: boolean
  /** Any additional attributes for round-trip fidelity. */
  extra: Record<string, string>
}

export interface LocalesResult {
  locales: LocaleEntry[]
  /** Look up a locale entry by locale code (case-insensitive). */
  byName: Map<string, LocaleEntry>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function xmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /\b(\w[\w:.-]*)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr)) !== null) {
    out[m[1]!] = xmlUnescape(m[2]!)
  }
  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a `Locales.xml` string. */
export function readLocales(xml: string): LocalesResult {
  const locales: LocaleEntry[] = []
  const byName = new Map<string, LocaleEntry>()

  const re = /<Locale((?:\s[^>]*?)?)\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    const name = attrs['name'] ?? ''
    const label = attrs['label']
    const requiredRaw = attrs['required']
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(attrs)) {
      if (k !== 'name' && k !== 'label' && k !== 'required') extra[k] = v
    }
    const entry: LocaleEntry = { name, extra }
    if (label !== undefined) entry.label = label
    if (requiredRaw !== undefined) entry.required = requiredRaw === '1' || requiredRaw.toLowerCase() === 'true'
    locales.push(entry)
    byName.set(name.toLowerCase(), entry)
  }

  return { locales, byName }
}

/** Serialize a `LocalesResult` back to XML. */
export function writeLocales(data: LocalesResult): string {
  let out = `<?xml version="1.0" encoding="utf-8"?>\n<Locales>\n`
  for (const loc of data.locales) {
    let tag = `    <Locale name="${xmlEscape(loc.name)}"`
    if (loc.label !== undefined) tag += ` label="${xmlEscape(loc.label)}"`
    if (loc.required) tag += ` required="1"`
    for (const [k, v] of Object.entries(loc.extra)) {
      tag += ` ${k}="${xmlEscape(v)}"`
    }
    out += `${tag}/>\n`
  }
  out += `</Locales>\n`
  return out
}
