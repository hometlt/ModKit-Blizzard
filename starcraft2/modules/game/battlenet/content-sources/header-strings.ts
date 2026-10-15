/**
 * Text a publication header points at: its locale tables (`m_locales`, one `.s2ml` per table) and the
 * string references its fields carry (`{ 1: table, 2: string id }`). Shared by the Battle.net cache
 * source (titles of cached maps) and map variant names, which load the tables from different places.
 */
import { parseXml, XmlCdata, XmlElement, XmlText } from '@rgrove/parse-xml'
import { array, blob, field, number, type CacheNode } from './cache-header.js'

export interface HeaderLocale {
  readonly name: string
  /** Cache handles (40 bytes) of the locale's `.s2ml` tables, in the header's order. */
  readonly tables: readonly Uint8Array[]
}

export interface StringReference {
  readonly table: number
  /** 0 means the field carries no text. */
  readonly id: number
}

const decoder = new TextDecoder('utf-8')

/** `m_locales`: the preferred locale first, then enUS, then the others in header order. */
export function headerLocales(header: CacheNode, preferred?: string): HeaderLocale[] {
  const locales = array(field(header, 8)).map(item => ({
    name: decoder.decode(blob(field(item, 0))), tables: array(field(item, 1)).map(blob),
  }))
  const rank = (name: string) => name === preferred ? 0 : name === 'enUS' ? 1 : 2
  return locales.sort((a, b) => rank(a.name) - rank(b.name))
}

export function stringReference(node: CacheNode): StringReference {
  return { table: number(field(node, 1)), id: number(field(node, 2)) }
}

/** One `.s2ml` or `.s2ql` table (root `Locale` or `locale`): string id to its trimmed text. */
export function parseLocaleTable(xml: string): Map<number, string> {
  const root = parseXml(xml).children.find((item): item is XmlElement => item instanceof XmlElement && item.name.toLowerCase() === 'locale')
  const strings = new Map<number, string>()
  for (const item of root?.children ?? []) {
    if (!(item instanceof XmlElement) || item.name !== 'e') continue
    const id = Number(item.attributes['id'])
    if (!Number.isSafeInteger(id) || strings.has(id)) continue
    const text = item.children.map(child => child instanceof XmlText || child instanceof XmlCdata ? child.text : '').join('').trim()
    if (text) strings.set(id, text.slice(0, 16384))
  }
  return strings
}

/**
 * The text of `reference` in the first locale that has it. `readTable` loads one table by its cache
 * handle; a table that is missing or unreadable is skipped, so it never hides the other locales.
 */
export async function headerText(locales: readonly HeaderLocale[], reference: StringReference,
  readTable: (handle: Uint8Array) => Promise<ReadonlyMap<number, string> | undefined>): Promise<string | undefined> {
  if (reference.id === 0) return undefined
  for (const locale of locales) {
    const handle = locale.tables[reference.table]
    if (!handle) continue
    try {
      const text = (await readTable(handle))?.get(reference.id)
      if (text) return text
    } catch { /* Try the next locale. */ }
  }
  return undefined
}
