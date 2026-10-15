/**
 * A matchmaking queue header (`.s2qh`, `Battlenet::MatchMaker::Header`): what a ladder or other
 * matchmaking queue is — its handle, team size, tags — and the maps it plays, i.e. the season's map
 * pool. The game service names a queue's header by its cache handle (S2Master MMQGetInfo); the public
 * depot serves the file like any map part, and the game keeps it in its Battle.net cache.
 *
 * The file is the same tagged tree as a publication header, with the tags of the game's own schema
 * (they match `Battlenet::MatchMaker::Header` field for field). Names come from the queue's locale
 * tables (`.s2ql`), the same XML string tables a map's `.s2ml` are.
 */
import { array, blob, decodeCacheHeader, field, number, optionalField as optional, type CacheNode } from './cache-header.js'
import { parseLocaleTable } from './header-strings.js'
import type { DepotComponentRequest } from './public-depot.js'
import type { BattleNetQueue, BattleNetQueueMap } from './vfs-provider.js'

/** `Battlenet::MatchMaker::Header`. */
export const QUEUE_HEADER_FIELDS: Readonly<Record<string, string>> = { 0: 'HeaderBase', 2: 'm_handle', 3: 'm_maps' }
/** `Battlenet::MatchMaker::HeaderBase`, field 0 of the header. */
export const QUEUE_BASE_FIELDS: Readonly<Record<string, string>> = {
  2: 'm_locales', 3: 'm_visualFiles', 4: 'm_name', 5: 'm_shortName', 6: 'm_description', 7: 'm_icon',
  8: 'm_teamSize', 9: 'm_teamCount', 10: 'm_computerTeamCount', 11: 'm_premadeTeamsAttribute',
  12: 'm_uiSortOrder', 13: 'm_definitionHandleList', 14: 'm_tags', 15: 'm_requiredPermissions', 16: 'm_active',
  17: 'm_isCountsTowardPopularity', 18: 'm_allowsArrangedTeams', 19: 'm_jitterOptions', 20: 'm_minVariance',
  21: 'm_initialVariance', 23: 'm_requiredUnlocks', 25: 'm_allowLeavers', 26: 'm_countLeavers',
  27: 'm_decrementLeaveCount', 29: 'm_draftDefinitionHandleList', 30: 'm_tournamentConfig',
  31: 'm_allowedGroupTypeList', 33: 'm_mapRotationSettings', 34: 'm_cutoffs', 35: 'm_gameCountRuleConfig',
  36: 'm_rankDifferenceRuleConfig', 37: 'm_aiDifficultyRuleConfig', 38: 'm_alliedCommanderSettings',
  39: 'm_partyLeagueDifferenceMax', 40: 'm_forbiddenLicenses', 41: 'm_optimizerConfig',
}
/** `Battlenet::MatchMaker::Handle`. */
export const QUEUE_HANDLE_FIELDS: Readonly<Record<string, string>> = { 0: 'm_region', 1: 'm_programId', 3: 'm_id', 4: 'm_version' }
/** `Battlenet::MatchMaker::MapSpec` and the `Battlenet::S2Map::Link` it holds. */
export const QUEUE_MAP_FIELDS: Readonly<Record<string, string>> = { 0: 'm_link', 1: 'm_deltas' }
export const MAP_LINK_FIELDS: Readonly<Record<string, string>> = { 0: 'm_variantIndex', 1: 'm_speed', 3: 'm_extraEntries' }

/** `Battlenet::Region` numbers as the game uses them. */
const REGIONS: Readonly<Record<number, string>> = { 1: 'US', 2: 'EU', 3: 'KR', 5: 'CN', 98: 'XX' }
/** `Battlenet::S2Map::LinkEntryType`: the map itself; other entries are extension mods. */
const PRIMARY = 0

/** A queue's own name reference: which string table (`m_fileIndex`) and which string (`m_id`, 0 is a real id here). */
export interface QueueString { readonly table: number; readonly id: number }

/** A queue header as read from its file, without names (they live in the locale tables). */
export interface QueueHeader {
  readonly region: string
  readonly program: string
  readonly id: number
  readonly version: number
  readonly teamSize: number
  readonly teamCount: number
  /** FourCC tags, e.g. `Ladd` (ranked ladder), `Solo`, `Team`, `LotV`, `Coop`. */
  readonly tags: readonly string[]
  readonly active?: boolean
  /** Locale code to the cache handles (hex) of its `.s2ql` tables, in the header's order. */
  readonly locales: ReadonlyMap<string, readonly string[]>
  readonly name?: QueueString
  readonly shortName?: QueueString
  readonly maps: readonly BattleNetQueueMap[]
}

const decoder = new TextDecoder('utf-8')
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
/** A FourCC as the file keeps it (four bytes, short codes padded with NUL in front). */
const fourcc = (node: CacheNode) => decoder.decode(blob(node)).replace(/^\0+/u, '')

const fields = (node: CacheNode) => {
  if (node.kind !== 5) throw new Error('Invalid queue header structure')
  return node.value as Map<bigint, CacheNode>
}

const queueString = (node: CacheNode | undefined): QueueString | undefined => {
  if (node === undefined || node.kind !== 5) return undefined
  return { table: number(field(node, 1)), id: number(field(node, 2)) }
}

function mapOf(spec: CacheNode): BattleNetQueueMap {
  const link = field(spec, 0)
  const entries = array(field(link, 3)).map(entry => ({
    id: number(field(field(entry, 0), 0)), version: number(field(field(entry, 0), 1)), type: number(field(entry, 1)),
  }))
  const primary = entries.find(entry => entry.type === PRIMARY)
  if (primary === undefined) throw new Error('A queue map names no map')
  const speed = fields(link).get(1n)
  const variant = fields(link).get(0n)
  return {
    id: primary.id,
    ...(primary.version ? { version: primary.version } : {}),
    mods: entries.filter(entry => entry !== primary).map(entry => entry.id),
    ...(variant && typeof variant.value === 'bigint' ? { variantIndex: number(variant) } : {}),
    ...(speed && speed.value instanceof Uint8Array ? { speed: fourcc(speed) } : {}),
  }
}

export function decodeQueueHeader(bytes: Uint8Array): QueueHeader {
  const root = decodeCacheHeader(bytes)
  const base = field(root, 0)
  const handle = field(root, 2)
  const region = number(field(handle, 0))
  const locales = new Map<string, string[]>()
  for (const entry of array(optional(base, 2) ?? { kind: 0, value: [] })) {
    locales.set(decoder.decode(blob(field(entry, 0))), array(field(entry, 1)).map(node => hex(blob(node))))
  }
  const active = optional(base, 16)
  const name = queueString(optional(base, 4)), shortName = queueString(optional(base, 5))
  return {
    region: REGIONS[region] ?? String(region),
    program: fourcc(field(handle, 1)),
    id: number(field(handle, 3)),
    version: number(field(handle, 4)),
    teamSize: number(field(base, 8)),
    teamCount: number(field(base, 9)),
    tags: array(optional(base, 14) ?? { kind: 0, value: [] }).map(fourcc),
    ...(active?.value instanceof Uint8Array ? { active: active.value[0] === 1 } : {}),
    locales,
    ...(name ? { name } : {}),
    ...(shortName ? { shortName } : {}),
    maps: array(field(root, 3)).map(mapOf),
  }
}

export interface QueueHeaderRequest {
  readonly region: string
  /** Hex `CacheHandle40` of the queue's `.s2qh`, as MMQGetInfo answers it. */
  readonly headerHandle: string
  /** Locale of the names (`ruRU`...); enUS, then any other, when the queue has none in it. */
  readonly locale?: string
  readonly signal: AbortSignal
}

const HEADER_BYTES = 1024 * 1024
const LOCALE_TABLE_BYTES = 1024 * 1024

/** A queue as `describeQueues` answers it: its header, named from its locale tables where it has them. */
export async function readQueueHeader(readComponent: (request: DepotComponentRequest) => Promise<Uint8Array>,
  request: QueueHeaderRequest): Promise<BattleNetQueue> {
  const header = decodeQueueHeader(await readComponent({ region: request.region, handle: request.headerHandle, maximumBytes: HEADER_BYTES, signal: request.signal }))
  const order = [...header.locales.keys()].sort((a, b) => rank(a, request.locale) - rank(b, request.locale))
  const tables = new Map<string, Promise<Map<number, string>>>()
  const text = async (reference: QueueString | undefined) => {
    if (reference === undefined) return undefined
    for (const locale of order) {
      const handle = header.locales.get(locale)?.[reference.table]
      if (handle === undefined) continue
      let table = tables.get(handle)
      if (!table) {
        table = readComponent({ region: request.region, handle, maximumBytes: LOCALE_TABLE_BYTES, signal: request.signal })
          .then(raw => parseLocaleTable(decoder.decode(raw)))
        tables.set(handle, table)
      }
      try {
        const value = (await table).get(reference.id)
        if (value) return value
      } catch { /* Try the next locale. */ }
    }
    return undefined
  }
  const [name, shortName] = await Promise.all([text(header.name), text(header.shortName)])
  const mode = ladderMode(header)
  return {
    id: header.id, version: header.version, headerHandle: request.headerHandle.toLowerCase(),
    teamSize: header.teamSize, teamCount: header.teamCount, tags: header.tags,
    ...(mode === undefined ? {} : { ladderMode: mode }),
    ...(header.active === undefined ? {} : { active: header.active }),
    ...(name === undefined ? {} : { name }), ...(shortName === undefined ? {} : { shortName }),
    maps: header.maps,
  }
}

const rank = (locale: string, preferred?: string) => locale === preferred ? 0 : locale === 'enUS' ? 1 : 2

/** A ranked ladder queue (tag `Ladd`), and its mode as players name it (`1v1`, `2v2`...). */
export function ladderMode(queue: Pick<BattleNetQueue, 'tags' | 'teamSize' | 'teamCount'>): string | undefined {
  if (!queue.tags.includes('Ladd') || queue.teamCount !== 2 || queue.teamSize < 1) return undefined
  return `${String(queue.teamSize)}v${String(queue.teamSize)}`
}
