/** Node/Electron main-process entry. Credentials stay in the session-bound API adapter. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { openMpqReader, type MpqReader } from '@modkit/blizzard-mpq/reader'
import { BattleNetVfsError } from '../shared/errors.js'
import { deleteBattleNetPublication, type BattleNetDeleteBackend, type BattleNetDeleteOptions, type BattleNetDeleteReceipt } from '../publishing/deletion.js'
export { BattleNetDeleteOutcomeUnknownError } from '../publishing/deletion.js'
export type { BattleNetDeleteOptions, BattleNetDeleteRequest, BattleNetDeleteReceipt, BattleNetDeleteBackend } from '../publishing/deletion.js'
import { publishBattleNetArchive, type BattleNetPublishBackend, type BattleNetPublishOptions,
  type BattleNetPublishReceipt } from '../publishing/publisher.js'
export { BattleNetVfsError } from '../shared/errors.js'
export { BattleNetPublishOutcomeUnknownError, BattleNetPublishRejectedError } from '../publishing/publisher.js'
export type { BattleNetPublishOptions, BattleNetPublishTarget, BattleNetPublishProgress,
  BattleNetPublishRequest, BattleNetPublishReceipt, BattleNetPublishRejection, BattleNetPublishBackend } from '../publishing/publisher.js'
import {
  clampVfsLimits, normalizeVfsPath,
  type RandomAccessSource, type VfsLimits, type VfsMount, type VfsNode,
  type VfsProvider, type VfsProviderContext,
} from '@modkit/vfs'

export type BattleNetRegion = 'us' | 'eu' | 'kr'
export type BattleNetRegionInput = BattleNetRegion | 'na'

/** NA/Americas is represented as US in depot handles and native API requests. */
export function normalizeBattleNetRegion(region: string): BattleNetRegion {
  const normalized = region.toLowerCase()
  if (normalized === 'na') return 'us'
  if (normalized === 'us' || normalized === 'eu' || normalized === 'kr') return normalized
  throw new BattleNetVfsError('blizzard.battlenet/invalid-region', 'Supported regions: na/us, eu, kr')
}

export interface BattleNetPublication {
  readonly id: number
  /** Concrete native version (major << 16 | minor); zero/latest must be resolved by the API. */
  readonly version: number
  readonly name: string
  readonly isMod: boolean
  /** Native .s2mh CacheHandle40, hex encoded. Also pins the catalogue revision. */
  readonly headerHandle: string
  readonly private?: boolean
  readonly locked?: boolean
  /** What the service thinks of this publication: a moderated one cannot be revised. */
  readonly approved?: boolean
  readonly underModeration?: boolean
  /** How the publication is listed; a next revision must carry these over or the server resets them. */
  readonly attributes?: BattleNetPublishAttributes
}

/**
 * The publish attributes the catalogue reports. Two the editor sends are not reported back by any
 * query — the category mask and the undependable flag — so a republish cannot preserve them.
 */
export interface BattleNetPublishAttributes {
  readonly extensionMod: boolean
  readonly melee: boolean
  readonly hiddenLobby: boolean
  readonly skipInitialDownload: boolean
  readonly cluster: boolean
  readonly clusterParent: number | null
  readonly labels: readonly string[]
}

export interface BattleNetPage {
  readonly items: readonly BattleNetPublication[]
  /** Omit only when the result is complete. Empty pages may still carry a cursor. */
  readonly nextCursor?: string
  /** The service answered with only its first results and has no further page; a narrower query finds the rest. */
  readonly truncated?: true
}

export interface BattleNetRequest {
  readonly region: BattleNetRegion
  readonly signal: AbortSignal
}

/** Lobby-server reference of an open Arcade lobby; asks the server for that lobby's slots. */
export interface BattleNetLobbyAdvert {
  readonly id: number
  readonly serverLabel: number
  readonly serverEpoch: number
}

/** A published map or mod revision (S2Map::Handle). */
export interface BattleNetMapHandle {
  readonly id: number
  readonly version: number
}

/** One open Arcade lobby as the in-game lobby browser lists it. */
export interface BattleNetOpenLobby {
  readonly advert: BattleNetLobbyAdvert
  readonly map: BattleNetMapHandle
  readonly extensionMod: BattleNetMapHandle | null
  /** Index of the map variant the host picked. */
  readonly variant: number
  /** Title the host typed; empty when none. */
  readonly title: string
  readonly hostName: string
  readonly players: number
  readonly capacity: number
  /** Creation time in Unix seconds by the server clock. */
  readonly createdAt: number
}

/** One lobby variant of a map (`Battlenet::S2Map::VariantInfo`): what a lobby's variant index means. */
export interface BattleNetMapVariant {
  /** The index a lobby's `variant` refers to. */
  readonly index: number
  readonly categoryId: number
  readonly modeId: number
  /** Names from the map's locale tables, e.g. "Tug Of War" / "3V3"; absent when the map leaves them unnamed. */
  readonly category?: string
  readonly mode?: string
  readonly maxTeamSize?: number
  readonly maxHumanPlayers?: number
}

/** A StarCraft II profile (toon): Battle.net region number (1 US, 2 EU, 3 KR), realm and decimal id. */
export interface BattleNetProfileHandle {
  readonly region: number
  readonly realm: number
  readonly id: string
}

export interface BattleNetLobbySlot {
  readonly team: number
  readonly kind: 'closed' | 'ai' | 'open' | 'human'
  readonly name?: string
  /** The player's profile, for a human slot. */
  readonly profile?: BattleNetProfileHandle
  readonly host: boolean
}

/** A player to look up by the name a lobby shows: Battle.net region number, realm and toon name. */
export interface BattleNetPlayerName {
  readonly region: number
  readonly realm: number
  readonly name: string
}

/**
 * The shape of a profile record, for diagnostics and research: counts of its entries by section
 * (first path bytes, hex) and by value type, and how many game summary handles it names. No values.
 */
export interface BattleNetProfileShape {
  readonly type?: number
  readonly bytes?: number
  readonly entries?: number
  readonly parsedTo?: number
  readonly valueTypes?: Readonly<Record<string, number>>
  readonly sections?: Readonly<Record<string, number>>
  readonly s2gs?: number
  /** The profile service refused the address or the read (error code), or answered from cache. */
  readonly addressError?: number
  readonly readFailure?: number
  readonly cached?: boolean
  /** The profile service knows no name for the handle, so the record cannot be addressed. */
  readonly nameUnknown?: boolean
}

/** One map of a matchmaking queue: the map by Battle.net id and the extension mods it is played with. */
export interface BattleNetQueueMap {
  readonly id: number
  /** Absent when the queue plays the latest revision (the header says version 0). */
  readonly version?: number
  readonly mods: readonly number[]
  readonly variantIndex?: number
  /** Game speed FourCC, e.g. `Fasr` (Faster). */
  readonly speed?: string
}

/**
 * A matchmaking queue of the session's region and its map pool, read from the queue's header
 * (`.s2qh`). A ranked ladder queue carries the tag `Ladd`; `teamSize` and `teamCount` give its mode.
 */
export interface BattleNetQueue {
  readonly id: number
  /** Changes whenever the queue changes, e.g. a new season's map pool. */
  readonly version: number
  /** Hex `CacheHandle40` of the queue's `.s2qh`. */
  readonly headerHandle: string
  readonly teamSize: number
  readonly teamCount: number
  /** FourCC tags: `Ladd` ranked ladder, `Solo`, `Team`, `LotV`, `Coop`, `Trny`... */
  readonly tags: readonly string[]
  /** `1v1`, `2v2`, `3v3`, `4v4` for a ranked ladder queue (tag `Ladd`, two teams); absent otherwise. */
  readonly ladderMode?: string
  readonly active?: boolean
  /** The queue's name in the requested locale when it has one, else enUS. */
  readonly name?: string
  readonly shortName?: string
  readonly maps: readonly BattleNetQueueMap[]
}

/** The current ladder season of a region, as the game's matchmaking service states it. */
export interface BattleNetSeason {
  /** `roll-in-progress` while the season changes over. */
  readonly state: 'active' | 'roll-in-progress'
  /** Internal season id (66...), the one ladder and league keys carry. */
  readonly seasonId: number
  /** Season of the year as players count it (Season 2 of 2026), when the service gives it. */
  readonly number?: number
  readonly year?: number
  /** Unix seconds. */
  readonly start: number
  readonly end: number
}

/** A player by toon handle, with the name and clan tag the profile service gives it (absent when unknown). */
export interface BattleNetPlayerIdentity extends BattleNetProfileHandle {
  readonly name?: string
  readonly clanTag?: string
}

/** The portrait a player selected, cut from its atlas and re-encoded as PNG. */
export interface BattleNetPortrait {
  /** Unlockable id of the portrait. */
  readonly id: number
  readonly width: number
  readonly height: number
  readonly png: Uint8Array
}

/** The image a map is listed with in the Arcade, cropped to the map and re-encoded as PNG. */
export interface BattleNetMapPreview {
  readonly width: number
  readonly height: number
  readonly png: Uint8Array
}

export interface BattleNetArchive {
  /** Depot location from the verified archive handle; it can differ from the account region (e.g. SG). */
  readonly depotRegion?: string
  /** Digest of the actual .s2ma payload, obtained from the verified .s2mh header. */
  readonly sha256: string
  /** Exact depot length if known; do not use Battle.net's publication accounting size. */
  readonly size?: number
  readonly kind: 'mpq' | 'standard-data'
}

/**
 * Implement this boundary with the custom native Battle.net API/IPC bridge, not public OAuth.
 * Bind one adapter to one authenticated profile for its lifetime. No passwords or tickets in URIs.
 * Requests must honour signal, validate native replies, and return only authorized publications.
 */
export interface BattleNetVfsApi {
  /** Optional native publishing capability. Unsupported backends fail before reading local files. */
  publish?: BattleNetPublishBackend
  deletePublication?: BattleNetDeleteBackend
  listPublished(request: BattleNetRequest & { readonly cursor?: string }): Promise<BattleNetPage>
  /**
   * Ask what a publication name is worth before anything is compiled: the attribute namespace a
   * header must carry, and the revision that name already has. A first publication cannot be
   * compiled without it, because the publisher refuses a header compiled with another namespace.
   */
  prepublish?(request: BattleNetRequest & { readonly names: readonly string[] }): Promise<{
    readonly namespace: number
    readonly prior: { readonly id: number; readonly version: number; readonly name: string; readonly linked: boolean } | null
  }>
  /** How much publication storage this account has left; a new publication needs a free slot. */
  storage?(request: BattleNetRequest): Promise<Record<string, number>>
  /**
   * Public catalogue search as the game's Arcade search: every word of `name` begins a word of the
   * map's name, in any order. May be absent until implemented by the native backend.
   */
  searchMods?(request: BattleNetRequest & {
    readonly name: string; readonly cursor?: string
  }): Promise<BattleNetPage>
  /**
   * Open Arcade lobbies of the session's region, only those of `mapId` (as map or extension mod)
   * when given. The list is complete or the call fails: a partial list would make open lobbies
   * look closed.
   */
  openLobbies?(request: BattleNetRequest & { readonly mapId?: number }): Promise<readonly BattleNetOpenLobby[]>
  /** Name and flags of exact map revisions, e.g. the maps of open lobbies (at most 100 per call). */
  describeMaps?(request: BattleNetRequest & { readonly maps: readonly BattleNetMapHandle[] }): Promise<readonly BattleNetPublication[]>
  /**
   * Lobby variants of a published map revision, read from its header (`headerHandle` of a
   * publication) and named in `locale` when the map has it, else enUS.
   */
  describeVariants?(request: BattleNetRequest & { readonly headerHandle: string; readonly locale?: string }): Promise<readonly BattleNetMapVariant[]>
  /**
   * The Arcade image of a published map revision (`m_bigMap` of its header), at most `maxSize`
   * pixels on its longer side; `null` when it has none or only the editor's placeholder.
   */
  describeMapPreview?(request: BattleNetRequest & { readonly headerHandle: string; readonly maxSize?: number }): Promise<BattleNetMapPreview | null>
  /**
   * Portraits the players selected, in the order asked (at most 16); `null` for a player whose
   * profile or portrait was not found. Players are looked up by name: the profile service does not
   * answer for a toon handle.
   */
  describePortraits?(request: BattleNetRequest & { readonly players: readonly BattleNetPlayerName[]; readonly maxSize?: number }): Promise<readonly (BattleNetPortrait | null)[]>
  /**
   * Players' names and clan tags by toon handle, in the order asked (at most 64); a handle the
   * service does not know comes back without a name.
   */
  describeNames?(request: BattleNetRequest & { readonly players: readonly BattleNetProfileHandle[] }): Promise<readonly BattleNetPlayerIdentity[]>
  /** Diagnostics: the shape of the session's own profile record (`player: 'self'`) or a player's. */
  inspectProfile?(request: BattleNetRequest & { readonly player: BattleNetProfileHandle | 'self' }): Promise<BattleNetProfileShape>
  /**
   * Matchmaking queues of the session's region with their map pools (at most 64). `tags` selects
   * queues that carry every tag given (`['Ladd']`: the ranked ladder); map names are not included —
   * `describeMaps` with version 0 names the latest revision of each map.
   */
  describeQueues?(request: BattleNetRequest & { readonly tags?: readonly string[]; readonly locale?: string }): Promise<readonly BattleNetQueue[]>
  /** The current ladder season of the session's region (S2Master CurrentSeason). */
  describeSeason?(request: BattleNetRequest): Promise<BattleNetSeason>
  /** Slots of one open lobby; `null` when it is gone. */
  lobbyPreview?(request: BattleNetRequest & { readonly advert: BattleNetLobbyAdvert }): Promise<readonly BattleNetLobbySlot[] | null>
  resolveArchive(request: BattleNetRequest & {
    readonly publication: BattleNetPublication
  }): Promise<BattleNetArchive>
  /** Stream verified-region depot bytes with bounded chunks and cancellation. */
  downloadArchive(request: BattleNetRequest & {
    readonly archive: BattleNetArchive
  }): AsyncIterable<Uint8Array>
}

export interface BattleNetVfsProviderOptions {
  readonly api: BattleNetVfsApi
  /** Optional binding used by the accounts provider to prevent cross-session URI routing. */
  readonly accountId?: string
  readonly region?: BattleNetRegion
  /** Stable, non-secret account + selected SC2 profile identifier. Never a session ticket. */
  readonly profileKey: string
  /** Dedicated host-owned cache directory; archives are partitioned by profile and region. */
  readonly cacheDirectory: string
  readonly limits?: Partial<VfsLimits>
  readonly maxArchiveBytes?: number
  readonly maxCataloguePages?: number
}

export interface BattleNetVfsNode extends VfsNode {
  readonly publication?: BattleNetPublication
}

function fail(code: string, message: string): never {
  throw new BattleNetVfsError(`blizzard.battlenet/${code}`, message)
}
const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const combine = (...signals: (AbortSignal | undefined)[]): AbortSignal =>
  AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined))
const positive = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid-option', `${label} must be a positive safe integer`)
  return value
}

interface Location {
  region: BattleNetRegion
  accountId?: string
  scope: 'mine' | 'search'
  name: string
  root: string
}

function locationOf(uri: string): Location {
  // URL normalizes dot segments, so reject them before parsing as well as in VFS paths.
  const decoded = decodeURIComponent(uri)
  if (/(?:^|[/\\])\.{1,2}(?:[/\\?#]|$)/u.test(decoded)) fail('invalid-uri', 'Dot segments are not allowed')
  const url = new URL(uri)
  if (url.protocol !== 'battlenet:' || url.username || url.password || url.port || url.hash) {
    fail('invalid-uri', 'Expected battlenet://<region>/mine or /search?name=...')
  }
  const region = normalizeBattleNetRegion(url.hostname)
  if ([...url.searchParams.keys()].some(key => key !== 'name' && key !== 'account') ||
    url.searchParams.getAll('name').length > 1 || url.searchParams.getAll('account').length > 1) {
    fail('invalid-uri', 'Only one name and one account query parameter are supported')
  }
  const accountId = url.searchParams.get('account')
  if (accountId === '') fail('invalid-uri', 'The account selector must not be empty')
  const [scope = 'mine', ...parts] = (normalizeVfsPath(decodeURIComponent(url.pathname)) || 'mine').split('/')
  if (scope !== 'mine' && scope !== 'search') fail('invalid-uri', 'Expected /mine or /search')
  const name = (url.searchParams.get('name') ?? '').trim()
  if (name.length > 256 || (scope === 'search' && !name)) fail('invalid-search', 'Search needs a name of 1–256 characters')
  return { region, scope, name, root: parts.join('/'), ...(accountId === null ? {} : { accountId }) }
}

export function checkedPublication(value: BattleNetPublication): BattleNetPublication {
  if (!value || !Number.isInteger(value.id) || value.id <= 0 || value.id > 0xffffffff ||
    !Number.isInteger(value.version) || value.version <= 0 || value.version > 0xffffffff ||
    typeof value.name !== 'string' || value.name.length > 1024 || typeof value.isMod !== 'boolean' ||
    typeof value.headerHandle !== 'string' || !/^73326d68[0-9a-f]{72}$/iu.test(value.headerHandle)) {
    fail('invalid-publication', 'The API must supply a concrete id/version and .s2mh CacheHandle40')
  }
  const attributes = value.attributes
  if (attributes !== undefined) {
    const flags = [attributes.extensionMod, attributes.melee, attributes.hiddenLobby,
      attributes.skipInitialDownload, attributes.cluster]
    if (flags.some(flag => typeof flag !== 'boolean') ||
      !(attributes.clusterParent === null || (Number.isInteger(attributes.clusterParent) &&
        attributes.clusterParent! > 0 && attributes.clusterParent! <= 0xffffffff)) ||
      !Array.isArray(attributes.labels) || attributes.labels.length > 32 ||
      attributes.labels.some(label => typeof label !== 'string' || !label || label.length > 64)) {
      fail('invalid-publication', 'The API reported unusable publish attributes')
    }
  }
  return Object.freeze({ ...value, headerHandle: value.headerHandle.toLowerCase(),
    ...(attributes === undefined ? {} : { attributes: Object.freeze({ ...attributes, labels: Object.freeze([...attributes.labels]) }) }) })
}

/** The publication's own name as a package file name; two publications may share it. */
export function battleNetPublicationName(item: BattleNetPublication): string {
  return `${battleNetPublicationDirectory(item).split('--').slice(1).join('--')}`
}

/**
 * What a catalogue calls each publication: its own name, and the identified form only for the few
 * that would otherwise collide. A reader never has to know an id to address a publication, and two
 * publications that share a name stay addressable.
 */
export function battleNetPublicationNames(
  items: readonly BattleNetPublication[],
): Map<BattleNetPublication, string> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const name = battleNetPublicationName(item).toLowerCase()
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const names = new Map<BattleNetPublication, string>()
  for (const item of items) {
    const own = battleNetPublicationName(item)
    names.set(item, counts.get(own.toLowerCase()) === 1 ? own : battleNetPublicationDirectory(item))
  }
  return names
}

/** Stable ID/version prefix prevents collisions and keeps names out of local cache paths. */
export function battleNetPublicationDirectory(item: BattleNetPublication): string {
  const label = item.name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/u, '').slice(0, 100) || 'Untitled'
  return `${item.id}@${item.version}--${label}.${item.isMod ? 'SC2Mod' : 'SC2Map'}`
}

interface Job<T> { controller: AbortController; promise: Promise<T>; users: number }

/** One cancelled caller must not cancel a download still needed by another mount. */
class SharedJobs<T> {
  private readonly jobs = new Map<string, Job<T>>()
  run(key: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    let job = this.jobs.get(key)
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController()
      job = { controller, users: 0, promise: Promise.resolve().then(() => work(controller.signal)) }
      this.jobs.set(key, job)
      const current = job
      const remove = () => { if (this.jobs.get(key) === current) this.jobs.delete(key) }
      void job.promise.then(remove, remove)
    }
    const current = job
    current.users += 1
    return new Promise<T>((resolveJob, rejectJob) => {
      let done = false
      const finish = (error: boolean, value: unknown) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', aborted)
        if (--current.users === 0) current.controller.abort()
        if (error) rejectJob(value)
        else resolveJob(value as T)
      }
      const aborted = () => finish(true, signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      void current.promise.then(value => finish(false, value), error => finish(true, error))
      if (signal.aborted) aborted()
    })
  }
}

/**
 * Read-only MK3 VFS provider. /mine lists the selected profile's publications; ?name filters them.
 * /search?name= delegates public name search to the backend. Neither listing downloads archives.
 * Opening a publication directory downloads its .s2ma once and indexes the MPQ on demand.
 */
export class BattleNetVfsProvider implements VfsProvider {
  readonly id = 'blizzard.starcraft2.vfs.battlenet'
  readonly scheme = 'battlenet'
  private readonly limits: VfsLimits
  private readonly cacheRoot: string
  private readonly maxArchiveBytes: number
  private readonly maxPages: number
  private readonly downloads = new SharedJobs<string>()
  private readonly lifetime = new AbortController()
  private readonly mounts = new Set<VfsMount>()
  private readonly publicationsInFlight = new Set<Promise<unknown>>()
  private readonly publishingRegions = new Set<BattleNetRegion>()
  private disposal?: Promise<void>

  constructor(private readonly options: BattleNetVfsProviderOptions) {
    if (!options.profileKey.trim() || !options.cacheDirectory.trim()) fail('invalid-option', 'profileKey and cacheDirectory are required')
    this.limits = clampVfsLimits(options.limits)
    this.maxArchiveBytes = Math.min(positive(options.maxArchiveBytes ?? 128 * 1024 * 1024, 'maxArchiveBytes'), 1024 ** 3)
    this.maxPages = positive(options.maxCataloguePages ?? 100, 'maxCataloguePages')
    this.cacheRoot = join(resolve(options.cacheDirectory), 'battlenet-v1', digest(options.profileKey))
  }

  async open(uri: string, context: VfsProviderContext): Promise<VfsMount> {
    const location = locationOf(uri)
    if (location.accountId !== undefined && location.accountId !== this.options.accountId) {
      fail('account-mismatch', 'This provider is not bound to the account selected by the URI')
    }
    if (this.options.region !== undefined && location.region !== this.options.region) {
      fail('region-mismatch', 'This provider is bound to a different authenticated region')
    }
    const signal = combine(context.signal, this.lifetime.signal)
    signal.throwIfAborted()
    const limits = clampVfsLimits(context.limits, this.limits)
    const api = this.options.api
    if (location.scope === 'search' && !api.searchMods) {
      fail('search-unavailable', 'This Battle.net API adapter does not implement public name search')
    }
    const publications = new Map<string, BattleNetPublication>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let complete = false
    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
      signal.throwIfAborted()
      const request = { region: location.region, signal, ...(cursor === undefined ? {} : { cursor }) }
      const page = location.scope === 'mine'
        ? await api.listPublished(request)
        : await api.searchMods!({ ...request, name: location.name })
      signal.throwIfAborted()
      if (!page || !Array.isArray(page.items)) fail('invalid-page', 'The API returned an invalid catalogue page')
      for (const raw of page.items) {
        const item = checkedPublication(raw)
        const key = `${item.id}@${item.version}`
        const previous = publications.get(key)
        if (previous && previous.headerHandle !== item.headerHandle) fail('unstable-catalogue', 'Publication changed during pagination; reopen the catalogue')
        publications.set(key, item)
        if (publications.size > limits.maxEntries) fail('entry-limit', 'Catalogue exceeds VFS maxEntries; narrow the search')
      }
      if (page.nextCursor === undefined) { complete = true; break }
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) {
        fail('invalid-cursor', 'The API returned an empty or repeated catalogue cursor')
      }
      cursor = page.nextCursor
      cursors.add(cursor)
    }
    if (!complete) fail('page-limit', 'Catalogue pagination exceeded maxCataloguePages')
    const selected = [...publications.values()].filter(item => location.scope !== 'mine' ||
      !location.name || item.name.toLocaleLowerCase('en-US').includes(location.name.toLocaleLowerCase('en-US')))
    const inner = new BattleNetMount(uri, location, selected, limits, signal,
      (item, activeSignal) => this.cachedArchive(location.region, item, limits, activeSignal))
    const mount: VfsMount = {
      id: inner.id, rootUri: inner.rootUri, revision: inner.revision,
      stat: (path, activeSignal) => inner.stat(path, activeSignal),
      list: (path, activeSignal) => inner.list(path, activeSignal),
      open: (path, activeSignal) => inner.open(path, activeSignal),
      dispose: () => { this.mounts.delete(mount); inner.dispose() },
    }
    try {
      if (!await mount.stat('', signal)) fail('not-found', 'The requested Battle.net directory does not exist')
      this.mounts.add(mount)
      return mount
    } catch (error) { mount.dispose(); throw error }
  }

  /** Publish through this adapter's authenticated profile; native allocation/upload is never retried here. */
  publish(options: BattleNetPublishOptions): Promise<BattleNetPublishReceipt> {
    const task = this.performPublish(options)
    this.publicationsInFlight.add(task)
    void task.then(() => this.publicationsInFlight.delete(task), () => this.publicationsInFlight.delete(task))
    return task
  }

  /** What this account has left to publish into. */
  async storage(region: BattleNetRegionInput, signal?: AbortSignal) {
    const active = combine(signal, this.lifetime.signal)
    active.throwIfAborted()
    const normalized = normalizeBattleNetRegion(region)
    const ask = this.options.api.storage
    if (!ask) fail('publish-unavailable', 'This Battle.net backend cannot report publication storage')
    return ask({ region: normalized, signal: active })
  }

  /**
   * What the server says about a publication name before anything is compiled. A first publication
   * needs the namespace it answers with; an author also learns from it whether the name is taken.
   */
  async prepublish(region: BattleNetRegionInput, names: readonly string[], signal?: AbortSignal) {
    const active = combine(signal, this.lifetime.signal)
    active.throwIfAborted()
    const normalized = normalizeBattleNetRegion(region)
    if (this.options.region !== undefined && normalized !== this.options.region) fail('region-mismatch', 'This session is authenticated in another region')
    const ask = this.options.api.prepublish
    if (!ask) fail('publish-unavailable', 'This Battle.net backend cannot prepare a publication')
    return ask({ region: normalized, names: [...names], signal: active })
  }

  private async performPublish(options: BattleNetPublishOptions): Promise<BattleNetPublishReceipt> {
    const signal = combine(options.signal, this.lifetime.signal)
    signal.throwIfAborted()
    const region = normalizeBattleNetRegion(options.region)
    if (this.options.region !== undefined && region !== this.options.region) fail('region-mismatch', 'This session is authenticated in another region')
    const backend = this.options.api.publish
    if (!backend) fail('publish-unavailable', 'This Battle.net backend does not implement native publication')
    if (this.publishingRegions.has(region)) fail('publish-in-progress', 'Another publication is already active for this profile and region')
    this.publishingRegions.add(region)
    try {
      return await publishBattleNetArchive(options, region, this.limits, this.maxArchiveBytes, signal,
        request => backend.call(this.options.api, request))
    } finally { this.publishingRegions.delete(region) }
  }

  /** Unlink a concrete own publication through the authenticated adapter; never retry automatically. */
  deletePublication(options: BattleNetDeleteOptions): Promise<BattleNetDeleteReceipt> {
    const task = this.performDelete(options)
    this.publicationsInFlight.add(task)
    void task.then(() => this.publicationsInFlight.delete(task), () => this.publicationsInFlight.delete(task))
    return task
  }
  private async performDelete(options: BattleNetDeleteOptions): Promise<BattleNetDeleteReceipt> {
    const signal = combine(options.signal, this.lifetime.signal)
    signal.throwIfAborted()
    const region = normalizeBattleNetRegion(options.region)
    if (this.options.region !== undefined && region !== this.options.region) fail('region-mismatch', 'This session is authenticated in another region')
    const backend = this.options.api.deletePublication
    if (!backend) fail('delete-unavailable', 'Native publication deletion is not configured')
    if (this.publishingRegions.has(region)) fail('publish-in-progress', 'Another publication operation is active')
    this.publishingRegions.add(region)
    try { return await deleteBattleNetPublication(options, region, signal, request => backend.call(this.options.api, request)) }
    finally { this.publishingRegions.delete(region) }
  }

  /** Whether the verified current archive is present in this profile's local cache. */
  async isCached(region: BattleNetRegionInput, publication: BattleNetPublication, signal?: AbortSignal): Promise<boolean> {
    const active = combine(signal, this.lifetime.signal)
    active.throwIfAborted()
    const normalized = normalizeBattleNetRegion(region)
    if (this.options.region !== undefined && normalized !== this.options.region) fail('region-mismatch', 'This session is authenticated in another region')
    const archive = await this.options.api.resolveArchive({ region: normalized, publication: checkedPublication(publication), signal: active })
    active.throwIfAborted()
    if (!archive || !/^[0-9a-f]{64}$/iu.test(archive.sha256) || archive.kind !== 'mpq') return false
    const maximum = Math.min(this.maxArchiveBytes, Number(this.limits.maxMaterializedBytes), Number(this.limits.maxFileBytes))
    if (archive.size !== undefined && (!Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.size > maximum)) return false
    return validCacheFile(join(this.cacheRoot, normalized, `${archive.sha256.toLowerCase()}.s2ma`), archive.sha256.toLowerCase(), maximum, archive.size, active)
  }

  /**
   * Where this publication's archive sits in the local cache, when it is already downloaded and
   * still matches the published digest. A host reveals or opens that file; it never guesses a path.
   */
  async cachedArchivePath(region: BattleNetRegionInput, publication: BattleNetPublication,
    signal?: AbortSignal): Promise<string | undefined> {
    const active = combine(signal, this.lifetime.signal)
    active.throwIfAborted()
    const normalized = normalizeBattleNetRegion(region)
    if (this.options.region !== undefined && normalized !== this.options.region) fail('region-mismatch', 'This session is authenticated in another region')
    const archive = await this.options.api.resolveArchive({ region: normalized, publication: checkedPublication(publication), signal: active })
    active.throwIfAborted()
    if (!archive || !/^[0-9a-f]{64}$/iu.test(archive.sha256) || archive.kind !== 'mpq') return undefined
    const maximum = Math.min(this.maxArchiveBytes, Number(this.limits.maxMaterializedBytes), Number(this.limits.maxFileBytes))
    const path = join(this.cacheRoot, normalized, `${archive.sha256.toLowerCase()}.s2ma`)
    return (await validCacheFile(path, archive.sha256.toLowerCase(), maximum, archive.size, active)) ? path : undefined
  }

  /** Materialize a publication archive without requiring the user to browse inside it. */
  async download(region: BattleNetRegionInput, publication: BattleNetPublication, signal?: AbortSignal): Promise<void> {
    const active = combine(signal, this.lifetime.signal)
    await this.cachedArchive(normalizeBattleNetRegion(region), checkedPublication(publication), this.limits, active)
  }

  /** Remove only this archive from Modkit's profile-partitioned cache. */
  async clearCache(region: BattleNetRegionInput, publication: BattleNetPublication, signal?: AbortSignal): Promise<void> {
    const active = combine(signal, this.lifetime.signal)
    active.throwIfAborted()
    const normalized = normalizeBattleNetRegion(region)
    if (this.options.region !== undefined && normalized !== this.options.region) fail('region-mismatch', 'This session is authenticated in another region')
    const archive = await this.options.api.resolveArchive({ region: normalized, publication: checkedPublication(publication), signal: active })
    active.throwIfAborted()
    if (!archive || !/^[0-9a-f]{64}$/iu.test(archive.sha256)) fail('invalid-archive', 'The API returned an invalid archive reference')
    await unlink(join(this.cacheRoot, normalized, `${archive.sha256.toLowerCase()}.s2ma`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  /** Cancel VFS work and publication mutations. The session owner closes the native transport. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposal = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.mounts].map(mount => Promise.resolve().then(() => mount.dispose())))
      await Promise.allSettled([...this.publicationsInFlight])
    })
    this.lifetime.abort(new BattleNetVfsError('blizzard.battlenet/provider-disposed', 'Battle.net VFS provider is disposed'))
    return this.disposal
  }

  private async cachedArchive(region: BattleNetRegion, publication: BattleNetPublication,
    limits: VfsLimits, signal: AbortSignal): Promise<string> {
    const archive = await this.options.api.resolveArchive({ region, publication, signal })
    signal.throwIfAborted()
    if (!archive || !/^[0-9a-f]{64}$/iu.test(archive.sha256)) fail('invalid-archive', 'The API must return the archive SHA-256 from its verified header')
    if (archive.kind === 'standard-data') fail('standard-data-reference', 'This depot object refers to installed Standard Data; it is not an MPQ archive')
    if (archive.kind !== 'mpq') fail('invalid-archive', 'Unknown depot object kind')
    const maximum = Math.min(this.maxArchiveBytes, Number(limits.maxMaterializedBytes), Number(limits.maxFileBytes))
    if (archive.size !== undefined && (!Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.size > maximum)) {
      fail('archive-size-limit', 'Archive exceeds the download limit or has an invalid exact size')
    }
    const hash = archive.sha256.toLowerCase()
    const directory = join(this.cacheRoot, region)
    const destination = join(directory, `${hash}.s2ma`)
    return this.downloads.run(`${destination}:${maximum}:${archive.size ?? ''}`, signal, async activeSignal => {
      if (await validCacheFile(destination, hash, maximum, archive.size, activeSignal)) return destination
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `${hash}.${randomUUID()}.part`)
      const file = await open(temporary, 'wx', 0o600)
      try {
        const checksum = createHash('sha256')
        let size = 0
        for await (const chunk of this.options.api.downloadArchive({ region, archive, signal: activeSignal })) {
          activeSignal.throwIfAborted()
          if (!(chunk instanceof Uint8Array)) fail('invalid-download', 'Archive stream must contain byte chunks')
          size += chunk.byteLength
          if (!Number.isSafeInteger(size) || size > maximum) fail('archive-size-limit', 'Archive stream exceeded the download limit')
          checksum.update(chunk)
          let offset = 0
          while (offset < chunk.byteLength) {
            activeSignal.throwIfAborted()
            const written = await file.write(chunk, offset, chunk.byteLength - offset)
            if (!written.bytesWritten) fail('cache-write', 'Cache write made no progress')
            offset += written.bytesWritten
          }
        }
        activeSignal.throwIfAborted()
        if (!size || (archive.size !== undefined && size !== archive.size) || checksum.digest('hex') !== hash) {
          fail('integrity', 'Downloaded archive length or SHA-256 does not match the verified header')
        }
        await file.sync()
        await file.close()
        activeSignal.throwIfAborted()
        await rename(temporary, destination)
        return destination
      } finally {
        await file.close()
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    })
  }
}

async function validCacheFile(path: string, hash: string, maximum: number, exact: number | undefined,
  signal: AbortSignal): Promise<boolean> {
  try {
    const info = await stat(path)
    signal.throwIfAborted()
    if (!info.isFile() || info.size <= 0 || info.size > maximum || (exact !== undefined && exact !== info.size)) return false
    const checksum = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(path, { signal })) {
      size += chunk.length
      if (size > maximum) return false
      checksum.update(chunk)
    }
    return size === info.size && checksum.digest('hex') === hash
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

interface MountedArchive { reader: MpqReader; nodes: Map<string, VfsNode>; ids: Map<string, string> }

class BattleNetMount implements VfsMount {
  readonly id: string
  readonly revision: string
  private readonly lifetime = new AbortController()
  private readonly publications = new Map<string, BattleNetPublication>()
  private readonly archives = new Map<string, MountedArchive>()
  private readonly sources = new Set<RandomAccessSource>()
  private readonly preparing = new SharedJobs<MountedArchive>()
  private serial: Promise<unknown> = Promise.resolve()
  private materialized = 0
  private readBytes = 0n
  private entryCount: number

  constructor(readonly rootUri: string, private readonly location: Location,
    items: readonly BattleNetPublication[], private readonly limits: VfsLimits,
    private readonly parentSignal: AbortSignal | undefined,
    private readonly getArchive: (item: BattleNetPublication, signal: AbortSignal) => Promise<string>) {
    this.id = rootUri
    // The catalogue is named by the publications themselves; an id appears only where two collide.
    const names = battleNetPublicationNames(items)
    for (const item of items) this.publications.set(this.path(names.get(item)!), item)
    this.entryCount = items.length
    this.revision = `sha256:${digest(JSON.stringify([...this.publications].sort()))}`
    this.path(location.root)
  }

  private active(signal?: AbortSignal): AbortSignal {
    const result = combine(this.parentSignal, this.lifetime.signal, signal)
    result.throwIfAborted()
    return result
  }
  private path(value: string): string {
    const path = normalizeVfsPath(value)
    if (Buffer.byteLength(path, 'utf8') > this.limits.maxPathBytes) fail('path-limit', 'VFS path exceeds maxPathBytes')
    return path
  }
  private absolute(path: string): string {
    const relative = this.path(path)
    return this.path([this.location.root, relative].filter(Boolean).join('/'))
  }
  private relative(path: string): string {
    return this.location.root ? path.slice(this.location.root.length).replace(/^\//u, '') : path
  }
  private node(path: string, kind: 'file' | 'directory', publication?: BattleNetPublication): BattleNetVfsNode {
    return Object.freeze({ path, name: path.split('/').at(-1) ?? '', kind, revision: this.revision,
      ...(publication ? { publication } : {}) })
  }

  async stat(path: string, signal?: AbortSignal): Promise<VfsNode | undefined> {
    const active = this.active(signal)
    const absolute = this.absolute(path)
    if (!absolute) return this.node('', 'directory')
    const [directory = '', ...parts] = absolute.split('/')
    const item = this.publications.get(directory)
    if (!item) return undefined
    if (!parts.length) return this.node(this.relative(directory), 'directory', item)
    const archive = await this.prepare(directory, item, active)
    const node = archive.nodes.get(parts.join('/'))
    return node ? { ...node, path: this.relative(`${directory}/${node.path}`) } : undefined
  }

  async *list(path: string, signal?: AbortSignal): AsyncIterable<BattleNetVfsNode> {
    const active = this.active(signal)
    const absolute = this.absolute(path)
    if (!absolute) {
      for (const [directory, item] of [...this.publications].sort(([a], [b]) => a.localeCompare(b))) {
        active.throwIfAborted()
        yield this.node(directory, 'directory', item)
      }
      return
    }
    const [directory = '', ...parts] = absolute.split('/')
    const item = this.publications.get(directory)
    if (!item) fail('not-found', 'Publication directory was not found')
    const archive = await this.prepare(directory, item, active)
    const internal = parts.join('/')
    const current = internal ? archive.nodes.get(internal) : { kind: 'directory' }
    if (!current) fail('not-found', 'Archive directory was not found')
    if (current.kind !== 'directory') fail('not-a-directory', 'Cannot list an archive file')
    const prefix = internal ? `${internal}/` : ''
    for (const node of archive.nodes.values()) {
      active.throwIfAborted()
      if (!node.path.startsWith(prefix) || node.path.slice(prefix.length).includes('/')) continue
      yield { ...node, path: this.relative(`${directory}/${node.path}`) }
    }
  }

  async open(path: string, signal?: AbortSignal): Promise<RandomAccessSource> {
    const active = this.active(signal)
    const [directory = '', ...parts] = this.absolute(path).split('/')
    const item = this.publications.get(directory)
    if (!item || !parts.length) fail('not-a-file', 'Select a file inside a publication')
    const archive = await this.prepare(directory, item, active)
    const entry = archive.nodes.get(parts.join('/'))
    const entryId = archive.ids.get(parts.join('/'))
    if (!entry || entry.kind !== 'file' || entryId === undefined) fail('not-a-file', 'Archive file was not found')
    const size = Number(entry.size)
    this.reserve(size)
    let bytes: Uint8Array
    try {
      bytes = await archive.reader.read(entryId, active)
      active.throwIfAborted()
      if (bytes.byteLength !== size) fail('entry-size', 'Decoded MPQ entry size differs from its table')
    } catch (error) { this.materialized -= size; throw error }
    const source = this.source(`${this.rootUri}#${encodeURIComponent(path)}`, bytes, size)
    this.sources.add(source)
    return source
  }

  private prepare(directory: string, item: BattleNetPublication, signal: AbortSignal): Promise<MountedArchive> {
    const existing = this.archives.get(directory)
    if (existing) return Promise.resolve(existing)
    return this.preparing.run(directory, signal, workSignal => {
      // Serial indexing makes the mount-wide retained-byte/entry budget independent of races.
      const work = this.serial.then(async () => {
        const active = this.active(workSignal)
        const cached = this.archives.get(directory)
        if (cached) return cached
        const file = await this.getArchive(item, active)
        const info = await stat(file)
        active.throwIfAborted()
        this.reserve(info.size)
        let reservation = info.size
        let reader: MpqReader | undefined
        try {
          const bytes = await readFile(file, { signal: active })
          active.throwIfAborted()
          // Recheck the bytes consumed by the parser, including cache changes between reads.
          if (bytes.byteLength !== info.size || `${digest(bytes)}.s2ma` !== file.split(/[\\/]/u).at(-1)) {
            fail('integrity', 'Cached archive changed before it could be opened')
          }
          if (bytes.subarray(0, 14).toString() === 'Standard Data:') {
            fail('standard-data-reference', 'This depot object refers to installed Standard Data')
          }
          reader = await openMpqReader(bytes, {
            maxArchiveBytes: Math.max(1, info.size), maxEntries: this.limits.maxEntries,
            maxEntryBytes: Math.min(1024 ** 3, Number(this.limits.maxFileBytes), Number(this.limits.maxMaterializedBytes)),
            signal: active,
          })
          active.throwIfAborted()
          this.reserve(reader.retainedBytes - reservation)
          reservation = reader.retainedBytes
          const nodes = new Map<string, VfsNode>()
          const ids = new Map<string, string>()
          for (const entry of reader.entries) {
            const path = this.path(entry.path)
            this.path(`${directory}/${path}`)
            if (!path || nodes.has(path)) fail('archive-path-conflict', 'MPQ contains conflicting file paths')
            ids.set(path, entry.id)
            nodes.set(path, { ...this.node(path, 'file'), size: BigInt(entry.size) })
          }
          for (const path of ids.keys()) {
            const parts = path.split('/')
            parts.pop()
            while (parts.length) {
              const parent = parts.join('/')
              if (ids.has(parent)) fail('archive-path-conflict', 'An MPQ path is both a file and a directory')
              nodes.set(parent, this.node(parent, 'directory'))
              parts.pop()
            }
            if (this.entryCount + nodes.size > this.limits.maxEntries) fail('entry-limit', 'Mounted archive entries exceed maxEntries')
          }
          const result = { reader, nodes: new Map([...nodes].sort(([a], [b]) => a.localeCompare(b))), ids }
          this.entryCount += nodes.size
          this.archives.set(directory, result)
          return result
        } catch (error) { reader?.dispose(); this.materialized -= reservation; throw error }
      })
      this.serial = work.catch(() => undefined)
      return work
    })
  }

  private reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || BigInt(this.materialized + bytes) > this.limits.maxMaterializedBytes) {
      fail('memory-limit', 'Mount exceeds maxMaterializedBytes; close files or open a smaller catalogue')
    }
    this.materialized += bytes
  }

  private source(id: string, initial: Uint8Array, size: number): RandomAccessSource {
    let bytes = initial
    let disposed = false
    const live = (signal?: AbortSignal) => {
      this.active(signal)
      if (disposed) fail('source-disposed', 'VFS file source is disposed')
    }
    const range = (offset: number, length: number) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > size - offset) {
        fail('read-range', 'Read range is outside the file')
      }
    }
    const consume = (length: number) => {
      if (this.readBytes + BigInt(length) > this.limits.maxReadBytes) fail('read-limit', 'Mount exceeds cumulative maxReadBytes')
      this.readBytes += BigInt(length)
    }
    const source: RandomAccessSource = {
      id,
      size: async signal => { live(signal); return size },
      readAt: async (offset, length, signal) => {
        live(signal); range(offset, length)
        if (length > this.limits.maxReadRangeBytes) fail('range-limit', 'Read exceeds maxReadRangeBytes')
        consume(length)
        return bytes.slice(offset, offset + length)
      },
      stream: (start = 0, end = size, signal) => {
        live(signal); range(start, end - start)
        if (BigInt(end - start) > this.limits.maxStreamBytes) fail('stream-limit', 'Stream exceeds maxStreamBytes')
        let position = start
        return new ReadableStream<Uint8Array>({
          pull: controller => {
            live(signal)
            if (position === end) { controller.close(); return }
            const next = Math.min(position + 64 * 1024, end)
            consume(next - position)
            controller.enqueue(bytes.slice(position, next))
            position = next
          },
        })
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        bytes = new Uint8Array()
        this.materialized -= size
        this.sources.delete(source)
      },
    }
    return source
  }

  dispose(): void {
    this.lifetime.abort(new BattleNetVfsError('blizzard.battlenet/mount-disposed', 'Battle.net mount is disposed'))
    for (const source of this.sources) void source.dispose()
    for (const archive of this.archives.values()) {
      this.materialized -= archive.reader.retainedBytes
      archive.reader.dispose()
    }
    this.archives.clear()
  }
}

export function createBattleNetVfsProvider(options: BattleNetVfsProviderOptions): BattleNetVfsProvider {
  return new BattleNetVfsProvider(options)
}
