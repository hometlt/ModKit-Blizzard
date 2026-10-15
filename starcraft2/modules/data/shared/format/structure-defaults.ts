/**
 * Root-level SC2 structure defaults (`<SCost>…</SCost>` beside the entities of a catalog file).
 *
 * Kept apart from the document loader so every catalog loader — the GameData codec and the MK2
 * `SC2ModReader` chain loader — extracts and applies them the same way. The game rules themselves
 * live in `services/catalog/struct-defaults.js`, shared with the resolved-data provider.
 */

import { parseCatalogXml, type RawFields, type RawValue } from '../catalog-engine/xml/index.js'
import type { StructureDefaultRules } from '../catalog-engine/sc2-catalog/index.js'
import { scanXml, type ScannedElement } from './language/xml-scan.js'
import {
  applyStarcraft2StructureDefaults,
  isStarcraft2StructureDefaultTag,
  mergeStructureDefault,
  starcraft2StructureDefaultNamespace,
} from '../../services/catalog/struct-defaults.js'

/** A root-level structure default (`<SCost>…</SCost>`) declared by one catalog file. */
export interface CatalogStructureDefault {
  readonly structureType: string
  /** Exact source text of the element, re-emitted verbatim when the file is rewritten. */
  readonly text: string
  readonly fields: RawFields
}

/** A structure default bound to the catalog namespace it applies to. */
export interface CatalogStructureDefaultEntry {
  readonly namespace: string
  readonly structureType: string
  readonly fields: RawFields
}

/** Root-level structure defaults of a catalog file, in document order. */
export function catalogStructureDefaults(text: string): CatalogStructureDefault[] {
  if (!/<S[A-Z]/u.test(text)) return []
  const catalog = scanXml(text).find(element => element.tag === 'Catalog')
  return (catalog?.children ?? [])
    .filter((element: ScannedElement) => isStarcraft2StructureDefaultTag(element.tag))
    .map(element => {
      const source = text.slice(element.start, element.end)
      // The catalog parser only accepts `C…` entry tags, so parse the element under a stand-in
      // entry name; the field conversion stays the parser's own.
      const alias = `CX${element.tag}`
      const opening = `<${alias}${source.slice(element.tag.length + 1)}`
      const closing = `</${element.tag}>`
      const renamed = opening.endsWith(closing)
        ? `${opening.slice(0, -closing.length)}</${alias}>`
        : opening
      const parsed = parseCatalogXml(`<Catalog>${renamed}</Catalog>`)
      return {
        structureType: element.tag,
        text: source,
        fields: parsed.entries.get(alias)?.[0]?.fields ?? {},
      }
    })
}

/**
 * Structure defaults of one catalog file bound to their namespace (`AbilData.xml` → `Abil`, else
 * the namespace of the file's first entity class). Files naming no catalog yield nothing.
 */
export function catalogStructureDefaultEntries(
  text: string,
  path: string,
  rootTypes: readonly string[],
): CatalogStructureDefaultEntry[] {
  const defaults = catalogStructureDefaults(text)
  if (defaults.length === 0) return []
  const namespace = starcraft2StructureDefaultNamespace(path, rootTypes)
  if (namespace === undefined) return []
  return defaults.map(item => ({ namespace, structureType: item.structureType, fields: item.fields }))
}

/** SC2 structure-default rules for `TypedCatalog`. */
export const STARCRAFT2_STRUCTURE_DEFAULT_RULES: StructureDefaultRules = {
  merge: (previous, next) => mergeStructureDefault(previous, next) as RawValue,
  apply: (typeId, entityId, fields, defaultsFor) =>
    applyStarcraft2StructureDefaults(typeId, entityId, fields, defaultsFor) as RawFields,
}
