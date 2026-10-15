/**
 * Lightweight field documentation: a human type label, enum members, and a link to
 * external reference docs. The schema gives us the precise structure-type; prose
 * descriptions are sourced externally (the SC2 Editor's `catalogsData.xsd` annotations
 * — as the ShadowDragon extension does — and the community wiki). The link target is
 * configurable (`modkit.docsUrl`) so other wiki sources can be used.
 *
 * Full per-field prose (e.g. "EditorCategories: … filtering and organization within the
 * Editor") requires ingesting the XSD/wiki into a field→description map — see the
 * `fieldDescription` hook, currently empty, which that ingestion would populate.
 */

import type { FieldInfo } from '../../catalog-engine/sc2-catalog/index.js'

export const DEFAULT_DOCS_URL = 'https://sc2mapster.wiki.gg/wiki/Data_Types'

/** A concise human label for a field's type, e.g. "link → Weapon", "enum EAbilAlignment". */
export function fieldTypeLabel(info: FieldInfo): string {
  switch (info.kind) {
    case 'link':
      return (
        `link${info.linkNamespace ? ` → ${info.linkNamespace}` : ''}` +
        (info.isTextLink ? ' (text)' : info.isFileLink ? ' (file)' : '')
      )
    case 'catalogRef':
      return 'catalog reference'
    case 'enum':
      return info.typeName ? `enum ${info.typeName}` : 'enum'
    case 'flags':
      return info.typeName ? `flags ${info.typeName}` : 'flags'
    case 'struct':
      return info.typeName ? `struct ${info.typeName}` : 'struct'
    case 'array':
      return 'array'
    case 'record':
      return 'record'
    case 'editorCategories':
      return 'editor categories'
    default:
      return info.typeName ?? 'value'
  }
}

/** Reference-docs URL for a field type (anchored on the type name when available). */
export function docsUrl(info: FieldInfo, base: string = DEFAULT_DOCS_URL): string {
  return info.typeName ? `${base}#${info.typeName}` : base
}

/** Field/type name → prose description, populated from an XSD (see `parseXsdDocs`). */
let docsByName: Map<string, string> | undefined

/** Install a field-documentation map (from XSD ingestion). Pass undefined to clear. */
export function setFieldDocs(docs: Map<string, string> | undefined): void {
  docsByName = docs && docs.size > 0 ? docs : undefined
}

/** Whether prose docs are loaded. */
export function hasFieldDocs(): boolean {
  return docsByName !== undefined
}

/** Per-field prose description, when an XSD has been ingested. */
export function fieldDescription(className: string, field: string): string | undefined {
  if (!docsByName) return undefined
  return docsByName.get(`${className}.${field}`) ?? docsByName.get(field)
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse an SC2 `catalogsData.xsd` into a `name → documentation` map: for every
 * `<xs:element name="…">` (or attribute), the `<xs:documentation>` inside its own
 * `<xs:annotation>` (which precedes any child elements). Prefix-agnostic and lenient.
 */
export function parseXsdDocs(xsd: string): Map<string, string> {
  const out = new Map<string, string>()
  const el =
    /<(?:\w+:)?(?:element|attribute)\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)(?=<(?:\w+:)?(?:element|attribute)\b|$)/g
  const doc = /<(?:\w+:)?documentation[^>]*>([\s\S]*?)<\/(?:\w+:)?documentation>/
  for (let m = el.exec(xsd); m; m = el.exec(xsd)) {
    const name = m[1]!
    const d = doc.exec(m[2]!)
    if (d?.[1]) {
      const text = decodeEntities(d[1])
      if (text && !out.has(name)) out.set(name, text)
    }
  }
  return out
}

/** Markdown documentation block for a field: prose (if any) + type + members + link. */
export function fieldDoc(info: FieldInfo, className: string, field: string, base?: string): string {
  const lines: string[] = []
  const prose = fieldDescription(className, field)
  if (prose) lines.push(prose)
  lines.push(`_${fieldTypeLabel(info)}_`)
  if ((info.kind === 'enum' || info.kind === 'flags') && info.enumMembers?.length) {
    const head = info.enumMembers.slice(0, 12).join(', ')
    lines.push(info.enumMembers.length > 12 ? `${head}, …` : head)
  }
  lines.push(`[📖 Reference](${docsUrl(info, base)})`)
  return lines.join('\n\n')
}
