/**
 * Lobby variants of a published map revision: `m_variants` of its header with names from its locale
 * tables, i.e. what the variant index of an open lobby means ("Tug Of War" / "3V3"). Public depot
 * data only; no account is involved.
 */
import { array, decodeCacheHeader, field, number, optionalField as optional, type CacheNode } from './cache-header.js'
import { headerLocales, headerText, parseLocaleTable, stringReference, type HeaderLocale } from './header-strings.js'
import type { DepotComponentRequest } from './public-depot.js'
import type { BattleNetMapVariant } from './vfs-provider.js'

export interface MapVariantsRequest {
  readonly region: string
  /** Hex `CacheHandle40` of the revision's `.s2mh`, as a publication carries it. */
  readonly headerHandle: string
  readonly locale?: string
  readonly signal: AbortSignal
}

const LOCALE_TABLE_BYTES = 4 * 1024 * 1024

const optionalNumber = (node: CacheNode, tag: number): number | undefined => {
  const value = optional(node, tag)
  return value && typeof value.value === 'bigint' ? number(value) : undefined
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

export async function readMapVariants(readComponent: (request: DepotComponentRequest) => Promise<Uint8Array>,
  request: MapVariantsRequest): Promise<BattleNetMapVariant[]> {
  const header = field(decodeCacheHeader(await readComponent({ region: request.region, handle: request.headerHandle, signal: request.signal })), 0)
  const variants = optional(header, 13)
  if (!variants) return []
  let locales: HeaderLocale[] = []
  try { locales = headerLocales(header, request.locale) } catch { /* Unnamed variants are still variants. */ }
  const tables = new Map<string, Promise<Map<number, string>>>()
  const readTable = (bytes: Uint8Array) => {
    const handle = hex(bytes)
    let table = tables.get(handle)
    if (!table) {
      table = readComponent({ region: request.region, handle, maximumBytes: LOCALE_TABLE_BYTES, signal: request.signal })
        .then(raw => parseLocaleTable(new TextDecoder('utf-8').decode(raw)))
      tables.set(handle, table)
    }
    return table
  }
  const text = async (variant: CacheNode, tag: number) => {
    const reference = optional(variant, tag)
    if (!reference) return undefined
    try { return await headerText(locales, stringReference(reference), readTable) } catch { return undefined }
  }
  return Promise.all(array(variants).map(async (variant, index): Promise<BattleNetMapVariant> => {
    const id = field(variant, 0)
    const [category, mode] = await Promise.all([text(variant, 1), text(variant, 2)])
    const maxTeamSize = optionalNumber(variant, 8), maxHumanPlayers = optionalNumber(variant, 12)
    return { index, categoryId: number(field(id, 0)), modeId: number(field(id, 1)),
      ...(category === undefined ? {} : { category }), ...(mode === undefined ? {} : { mode }),
      ...(maxTeamSize === undefined ? {} : { maxTeamSize }), ...(maxHumanPlayers === undefined ? {} : { maxHumanPlayers }) }
  }))
}
