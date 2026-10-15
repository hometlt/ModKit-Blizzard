/**
 * Parser and writer for `GameData/EditorCategoryData.xml` (also any file with
 * name matching `editorcategor*` in a map/mod archive).
 *
 * Format: standard SC2 catalog XML with `<CEditorCategory>` entries. Each
 * category defines a named axis that appears in the Data Editor's object
 * browser filter. Catalog entities reference categories via the
 * `<EditorCategories value="Race:Terran,AbilityorEffectType:Units"/>` field.
 *
 * Example:
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <Catalog>
 *   <CEditorCategory id="Race">
 *     <Value value="Terran"/>
 *     <Value value="Zerg"/>
 *     <Value value="Protoss"/>
 *   </CEditorCategory>
 *   <CEditorCategory id="AbilityorEffectType">
 *     <Value value="Units"/>
 *     <Value value="Structures"/>
 *   </CEditorCategory>
 * </Catalog>
 * ```
 *
 * Maps and mods ship `EditorCategoryData.xml` to declare their own category
 * axes, which show up in the Data Editor alongside Blizzard's built-in ones.
 * The `EditorCategories` field on catalog entities is a comma-separated list of
 * `CategoryId:ValueId` pairs; only defined pairs are valid.
 *
 * Browser-safe: pure regex / string scanning, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorCategoryValue {
  /** The `value` attribute content. */
  value: string
  /** Any additional attributes beyond `value`. */
  extra: Record<string, string>
}

export interface EditorCategory {
  /** Category identifier (the axis name, e.g. `"Race"`). */
  id: string
  /** All values within this category (the options for the axis). */
  values: EditorCategoryValue[]
  /** Extra attributes on the `<CEditorCategory>` element. */
  extra: Record<string, string>
}

export interface EditorCategoriesResult {
  categories: EditorCategory[]
  /** Look up a category by id (lowercase). */
  byId: Map<string, EditorCategory>
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

/** Find all `<CEditorCategory ...>...</CEditorCategory>` blocks. */
function* scanCategoryBlocks(xml: string): Generator<{ attrs: Record<string, string>; body: string }> {
  const re = /<CEditorCategory((?:\s[^>]*?)?)>([\s\S]*?)<\/CEditorCategory>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    yield { attrs: parseAttrs(m[1] ?? ''), body: m[2] ?? '' }
  }
}

/** Find all `<Value .../>` children within a block body. */
function scanValues(body: string): EditorCategoryValue[] {
  const result: EditorCategoryValue[] = []
  const re = /<Value((?:\s[^>]*?)?)\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    const value = attrs['value'] ?? ''
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(attrs)) {
      if (k !== 'value') extra[k] = v
    }
    result.push({ value, extra })
  }
  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse an EditorCategoryData catalog XML string. */
export function readEditorCategories(xml: string): EditorCategoriesResult {
  const categories: EditorCategory[] = []
  const byId = new Map<string, EditorCategory>()

  for (const block of scanCategoryBlocks(xml)) {
    const id = block.attrs['id'] ?? ''
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(block.attrs)) {
      if (k !== 'id') extra[k] = v
    }
    const values = scanValues(block.body)
    const cat: EditorCategory = { id, values, extra }
    categories.push(cat)
    byId.set(id.toLowerCase(), cat)
  }

  return { categories, byId }
}

/** Serialize an EditorCategoriesResult back to catalog XML. */
export function writeEditorCategories(data: EditorCategoriesResult): string {
  let out = `<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n`

  for (const cat of data.categories) {
    const extraStr = Object.entries(cat.extra)
      .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
      .join('')
    out += `    <CEditorCategory id="${xmlEscape(cat.id)}"${extraStr}>\n`
    for (const val of cat.values) {
      const valExtraStr = Object.entries(val.extra)
        .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
        .join('')
      out += `        <Value value="${xmlEscape(val.value)}"${valExtraStr}/>\n`
    }
    out += `    </CEditorCategory>\n`
  }

  out += `</Catalog>\n`
  return out
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated `EditorCategories` field value (as found on catalog
 * entities) into structured `{ category, value }` pairs.
 *
 * Example: `"Race:Terran,AbilityorEffectType:Units"` →
 * `[{ category: "Race", value: "Terran" }, { category: "AbilityorEffectType", value: "Units" }]`
 */
export function parseEditorCategoriesValue(
  raw: string,
): Array<{ category: string; value: string }> {
  return raw
    .split(',')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const colon = pair.indexOf(':')
      if (colon === -1) return { category: pair, value: '' }
      return { category: pair.slice(0, colon), value: pair.slice(colon + 1) }
    })
}
