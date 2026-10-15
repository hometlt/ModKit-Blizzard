/**
 * Parser and writer for the `Preload` file embedded in `.SC2Map` archives.
 *
 * Format: XML root `<Preload>` with heterogeneous child elements. Each child
 * element tag names a catalog namespace (or asset type) and carries an `id`
 * attribute (or `path` for `<Asset>`) that links into the catalog or the
 * asset tree.
 *
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <Preload>
 *     <Unit id="Marine" UserTag="Terr" Variations="0"/>
 *     <Actor id="MarineDeath" Variations="0"/>
 *     <Sound id="MainTheme" Variations="0 1 2"/>
 *     <Model id="MarineModel" Variations="0"/>
 *     <Asset path="Assets/Textures/Marine.dds" Type="Image"/>
 * </Preload>
 * ```
 *
 * ## Catalog namespace mapping
 *
 * | Element tag    | Catalog namespace | Rename target? |
 * |----------------|-------------------|----------------|
 * | Unit           | Unit              | yes            |
 * | Actor          | Actor             | yes            |
 * | Sound          | Sound             | yes            |
 * | Model          | Model             | yes            |
 * | Behavior       | Behavior          | yes            |
 * | Effect         | Effect            | yes            |
 * | Abil           | Abil              | yes            |
 * | Upgrade        | Upgrade           | yes            |
 * | Weapon         | Weapon            | yes            |
 * | Button         | Button            | yes            |
 * | Commander      | Commander         | yes            |
 * | Terrain        | Terrain           | yes            |
 * | TerrainObject  | Cliff             | yes            |
 * | Light          | Light             | yes            |
 * | Soundtrack     | Soundtrack        | yes            |
 * | Map            | Map               | yes            |
 * | PlayerResponse | PlayerResponse    | yes            |
 * | Achievement    | Achievement       | yes            |
 * | Spray          | Spray             | yes            |
 * | Race           | Race              | yes            |
 * | User           | User              | yes            |
 * | Asset          | (asset path)      | no             |
 *
 * Browser-safe: pure regex / string scanning, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One element in the `<Preload>` block.
 *
 * All attributes are stored verbatim in `attrs` so the writer can reproduce
 * the original XML exactly (including unknown attributes and ordering).
 *
 * For catalog-linked entries, `attrs.id` holds the entity id.
 * For `<Asset>` entries, `attrs.path` holds the asset path.
 */
export interface PreloadEntry {
  /** XML element tag: `"Unit"` | `"Actor"` | `"Asset"` | … */
  tag: string
  /** All attributes verbatim (id, path, Type, Variations, UserTag, …). */
  attrs: Record<string, string>
}

export interface PreloadResult {
  /** Entries in document order. */
  entries: PreloadEntry[]
}

/**
 * For every catalog-linked element tag, the attribute name that holds the
 * entity id and the catalog namespace it points into.
 *
 * Exported so `renamePreloadRefs` in `@modkitx/ops` can use the same table.
 */
export const PRELOAD_TAG_LINKS: ReadonlyMap<string, { attr: string; namespace: string }> = new Map([
  ['Unit',           { attr: 'id', namespace: 'Unit' }],
  ['Actor',          { attr: 'id', namespace: 'Actor' }],
  ['Sound',          { attr: 'id', namespace: 'Sound' }],
  ['Model',          { attr: 'id', namespace: 'Model' }],
  ['Behavior',       { attr: 'id', namespace: 'Behavior' }],
  ['Effect',         { attr: 'id', namespace: 'Effect' }],
  ['Abil',           { attr: 'id', namespace: 'Abil' }],
  ['Upgrade',        { attr: 'id', namespace: 'Upgrade' }],
  ['Weapon',         { attr: 'id', namespace: 'Weapon' }],
  ['Button',         { attr: 'id', namespace: 'Button' }],
  ['Commander',      { attr: 'id', namespace: 'Commander' }],
  ['Terrain',        { attr: 'id', namespace: 'Terrain' }],
  ['TerrainObject',  { attr: 'id', namespace: 'Cliff' }],
  ['Light',          { attr: 'id', namespace: 'Light' }],
  ['Soundtrack',     { attr: 'id', namespace: 'Soundtrack' }],
  ['Map',            { attr: 'id', namespace: 'Map' }],
  ['PlayerResponse', { attr: 'id', namespace: 'PlayerResponse' }],
  ['Achievement',    { attr: 'id', namespace: 'Achievement' }],
  ['Spray',          { attr: 'id', namespace: 'Spray' }],
  ['Race',           { attr: 'id', namespace: 'Race' }],
  ['User',           { attr: 'id', namespace: 'User' }],
])

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
  const re = /\b(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr)) !== null) {
    out[m[1]!] = xmlUnescape(m[2]!)
  }
  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a `<Preload>` XML string. */
export function readPreload(xml: string): PreloadResult {
  const entries: PreloadEntry[] = []

  // Match all self-closing child elements of <Preload>
  // Non-greedy [^>]*? avoids consuming the closing /> slash
  const re = /<(\w+)((?:\s[^>]*?)?)\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tag = m[1]!
    // Skip the root element itself and XML declaration
    if (tag === 'Preload' || tag === '?xml') continue
    const attrs = parseAttrs(m[2] ?? '')
    entries.push({ tag, attrs })
  }

  return { entries }
}

/** Serialize a `PreloadResult` back to XML. */
export function writePreload(data: PreloadResult): string {
  let out = `<?xml version="1.0" encoding="utf-8"?>\n<Preload>\n`
  for (const entry of data.entries) {
    let tag = `    <${entry.tag}`
    for (const [k, v] of Object.entries(entry.attrs)) {
      tag += ` ${k}="${xmlEscape(v)}"`
    }
    out += `${tag}/>\n`
  }
  out += `</Preload>\n`
  return out
}
