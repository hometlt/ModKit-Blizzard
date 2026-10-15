/**
 * Parser and writer for `Includes.xml` (also `GameData.xml`) embedded in
 * `.SC2Map` / `.SC2Mod` archives.
 *
 * Format: XML listing catalog XML files to load from the archive's GameData
 * folder. The root element is `<Includes>` (for `Includes.xml`) or `<Includes>`
 * embedded inside `GameData.xml`:
 *
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <Includes>
 *   <Catalog path="GameData/UnitData.xml"/>
 *   <Catalog path="GameData/AbilData.xml"/>
 *   <Catalog path="GameData/MyCustomData.xml"/>
 * </Includes>
 * ```
 *
 * The engine processes these paths in order when loading the map/mod's catalog
 * data. Custom maps use `GameData.xml` at `Base.SC2Data/GameData.xml` to
 * declare their data XML files; the `Includes.xml` variant appears at the
 * archive root and serves the same purpose.
 *
 * Browser-safe: pure regex / string scanning, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogInclude {
  /** Relative path to the catalog XML file (e.g. `"GameData/UnitData.xml"`). */
  path: string
  /** Any additional attributes for round-trip fidelity. */
  extra: Record<string, string>
}

export interface IncludesResult {
  catalogs: CatalogInclude[]
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

/** Parse an `Includes.xml` or `GameData.xml` string. */
export function readIncludes(xml: string): IncludesResult {
  const catalogs: CatalogInclude[] = []

  // Match <Catalog path="..."/> self-closing elements
  const re = /<Catalog((?:\s[^>]*?)?)\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    const path = attrs['path'] ?? ''
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(attrs)) {
      if (k !== 'path') extra[k] = v
    }
    catalogs.push({ path, extra })
  }

  return { catalogs }
}

/** Serialize an `IncludesResult` back to XML. */
export function writeIncludes(data: IncludesResult): string {
  let out = `<?xml version="1.0" encoding="utf-8"?>\n<Includes>\n`
  for (const cat of data.catalogs) {
    let tag = `    <Catalog path="${xmlEscape(cat.path)}"`
    for (const [k, v] of Object.entries(cat.extra)) {
      tag += ` ${k}="${xmlEscape(v)}"`
    }
    out += `${tag}/>\n`
  }
  out += `</Includes>\n`
  return out
}
