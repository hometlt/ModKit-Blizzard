/**
 * Parser and writer for the `ScenarioProperties` file embedded in `.SC2Map`
 * archives. Format: XML with a root element (varies by editor version) containing
 * `<key value="..."/>` style children — map name, description, author, loading
 * screen settings, etc.
 *
 * Because the root element name and available children vary across editor
 * versions, we use a generic representation: the root tag is preserved, and
 * every child element (self-closing or with body) is captured as a
 * `PropertyEntry` so the round-trip is always byte-exact at the semantic level.
 *
 * Browser-safe: pure regex / string scanning, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PropertyEntry {
  /** XML element tag name. */
  tag: string
  /** All XML attributes on the element. */
  attrs: Record<string, string>
  /** Trimmed text content; empty string for self-closing / empty elements. */
  text: string
}

export interface ScenarioPropertiesResult {
  /** Root element tag name (e.g. `"MapInfo"`, `"ScenarioProperties"`). */
  rootTag: string
  /** Root element attributes (usually none, but preserved for round-trip). */
  rootAttrs: Record<string, string>
  /** All immediate children, in document order. */
  entries: PropertyEntry[]
}

// ---------------------------------------------------------------------------
// Helpers (shared with other XML formats)
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

/** Parse a ScenarioProperties XML string. */
export function readScenarioProperties(xml: string): ScenarioPropertiesResult {
  // Find the root element (skip <?xml ...?> declaration)
  const rootMatch = /<(\w+)((?:\s[^>]*?)?)>/s.exec(xml)
  const rootTag = rootMatch?.[1] ?? 'ScenarioProperties'
  const rootAttrs = parseAttrs(rootMatch?.[2] ?? '')

  const entries: PropertyEntry[] = []

  // Match both self-closing <Tag .../> and <Tag ...>content</Tag>
  const re = /<(\w+)((?:\s[^>]*?)?)(?:\/>|>([\s\S]*?)<\/\1>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tag = m[1]!
    if (tag === rootTag || tag === '?xml') continue  // skip root and XML declaration artefacts
    const attrs = parseAttrs(m[2] ?? '')
    const text = (m[3] ?? '').trim()
    entries.push({ tag, attrs, text })
  }

  return { rootTag, rootAttrs, entries }
}

/** Serialize a ScenarioPropertiesResult back to XML. */
export function writeScenarioProperties(data: ScenarioPropertiesResult): string {
  const rootAttrStr = Object.entries(data.rootAttrs)
    .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
    .join('')

  let out = `<?xml version="1.0" encoding="utf-8"?>\n<${data.rootTag}${rootAttrStr}>\n`

  for (const e of data.entries) {
    const attrStr = Object.entries(e.attrs)
      .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
      .join('')

    if (e.text) {
      out += `    <${e.tag}${attrStr}>${xmlEscape(e.text)}</${e.tag}>\n`
    } else {
      out += `    <${e.tag}${attrStr}/>\n`
    }
  }

  out += `</${data.rootTag}>\n`
  return out
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/** Return the `value` attribute of the first entry with the given tag, or undefined. */
export function getPropertyValue(
  data: ScenarioPropertiesResult,
  tag: string,
): string | undefined {
  return data.entries.find(e => e.tag === tag)?.attrs['value']
}
