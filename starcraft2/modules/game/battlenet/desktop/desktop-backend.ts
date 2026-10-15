/** Local interoperability backend. The supplied research runtime is explicit and host-owned. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { BattleNetDeleteRequest, BattleNetDeleteBackend } from '../publishing/deletion.js'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rename, rm, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { createServer, type Socket } from 'node:net'
import type { BattleNetLoginBackend, BattleNetAuthenticatedSession } from '../accounts/account-provider.js'
import { BattleNetContentSources } from '../content-sources/content-sources.js'
import { Sc2DesktopContentSources, hostLocalOptions, type Sc2HostContext } from '../content-sources/local-content-sources.js'
import type { CredentialPort } from '@modkit/sdk'
import { publishDesktopPackage } from '../publishing/desktop-publication.js'
import { checkedPublication, type BattleNetSeason, type BattleNetLobbySlot, type BattleNetOpenLobby, type BattleNetPublication, type BattleNetVfsApi } from '../content-sources/vfs-provider.js'
import { createPublicDepotApi, type PublicDepotApi } from '../content-sources/public-depot.js'
import { readMapPreview } from '../content-sources/map-preview.js'
import { cachedTextureLists, createPortraitImages } from '../profiles/portraits.js'
import { readMapVariants } from '../content-sources/map-variants.js'
import { readQueueHeader } from '../content-sources/queue-header.js'

interface RuntimeOptions { researchDirectory: string; pythonExecutable: string; electronExecutable: string; loginHelperScript?: string; stateDirectory?: string; battleNetCacheDirectory?: string }
type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid backend response')
  return value as RecordValue
}
const string = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid backend identity')
  return value
}
function publications(value: unknown): readonly BattleNetPublication[] {
  if (!Array.isArray(value) || value.length > 25000) throw new Error('Invalid publication list')
  return value.map(raw => {
    const item = record(raw)
    return checkedPublication({ id: item['id'] as number, version: item['version'] as number,
      name: item['name'] as string, isMod: item['is_mod'] as boolean,
      headerHandle: item['header_handle'] as string, private: item['private'] as boolean,
      locked: item['locked'] as boolean,
      ...(typeof item['approved'] === 'boolean' ? { approved: item['approved'] } : {}),
      ...(typeof item['under_moderation'] === 'boolean' ? { underModeration: item['under_moderation'] } : {}),
      // Own publications report how they are listed; a public search result reports none of it.
      ...(item['melee'] === undefined ? {} : { attributes: {
        extensionMod: item['extension_mod'] as boolean, melee: item['melee'] as boolean,
        hiddenLobby: item['hidden_lobby'] as boolean,
        skipInitialDownload: item['skip_initial_download'] as boolean,
        cluster: item['cluster'] as boolean,
        clusterParent: (item['cluster_parent'] ?? null) as number | null,
        labels: item['labels'] as readonly string[] } }) })
  })
}

const integer = (value: unknown, low: number, high: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) throw new Error('Invalid lobby record')
  return value
}
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid lobby record')
  return value
}
const U32 = 0xFFFFFFFF
/** A FourCC tag as the game writes it: one to four printable ASCII characters. */
const QUEUE_TAG = /^[!-~]{1,4}$/u
/** Hex CacheHandle40 of a queue header: type 's2qh', region, SHA-256. */
const QUEUE_HEADER_HANDLE = /^73327168[0-9a-f]{72}$/u
/** The worker's `season` answer: ids, numbers and dates only. */
function season(value: unknown): BattleNetSeason {
  try { return seasonRecord(record(value)) } catch { throw new Error('Invalid season record') }
}
function seasonRecord(item: RecordValue): BattleNetSeason {
  const optional = (key: string) => item[key] === undefined || item[key] === null ? {} : { [key]: integer(item[key], 0, 0xFFFF) }
  if (item['state'] !== 'active' && item['state'] !== 'roll-in-progress') throw new Error('Invalid season record')
  return { state: item['state'], seasonId: integer(item['seasonId'], 0, 0xFFFF), ...optional('number'), ...optional('year'),
    start: integer(item['start'], -0x80000000, 0x7FFFFFFF), end: integer(item['end'], -0x80000000, 0x7FFFFFFF) }
}
/** The worker's `queues` answer: each queue's handle and the cache handle of its header. */
function queueHandles(value: unknown): { id: number; version: number; headerHandle: string }[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid queue list')
  return value.map(raw => {
    const item = record(raw)
    const headerHandle = typeof item['header_handle'] === 'string' ? item['header_handle'].toLowerCase() : ''
    if (!QUEUE_HEADER_HANDLE.test(headerHandle)) throw new Error('Invalid queue header handle')
    return { id: integer(item['id'], 0, U32), version: integer(item['version'], 0, 0xFFFF), headerHandle }
  })
}
function openLobbies(value: unknown): readonly BattleNetOpenLobby[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid lobby list')
  return value.map(raw => {
    const item = record(raw)
    return { advert: { id: integer(item['advert_id'], 0, U32), serverLabel: integer(item['server_label'], 0, U32),
        serverEpoch: integer(item['server_epoch'], -0x80000000, 0x7FFFFFFF) },
      map: { id: integer(item['map_id'], 1, U32), version: integer(item['map_version'], 0, U32) },
      extensionMod: item['extension_mod_id'] === null ? null
        : { id: integer(item['extension_mod_id'], 1, U32), version: integer(item['extension_mod_version'], 0, U32) },
      variant: integer(item['variant'], 0, 63), title: text(item['title'], 252), hostName: text(item['host'], 100),
      players: integer(item['players'], 0, 255), capacity: integer(item['capacity'], 0, 255),
      createdAt: integer(item['created'], -0x80000000, 0x7FFFFFFF) }
  })
}
function lobbySlots(value: unknown): readonly BattleNetLobbySlot[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid lobby preview')
  return value.map(raw => {
    const item = record(raw)
    const kind = item['kind']
    if (kind !== 'closed' && kind !== 'ai' && kind !== 'open' && kind !== 'human') throw new Error('Invalid lobby preview')
    const name = item['name'] === null || item['name'] === undefined ? undefined : text(item['name'], 100)
    const profile = item['profile'] === null || item['profile'] === undefined ? undefined : profileHandle(item['profile'])
    return { team: integer(item['team'], 0, 255), kind, host: item['host'] === true, ...(name === undefined ? {} : { name }),
      ...(profile === undefined ? {} : { profile }) }
  })
}
/** The worker's `portraits` answer: one unlockable id or null per player asked, and the session's definition files. */
function playerPortraits(value: unknown, count: number) {
  const item = record(value)
  const players = item['players'], files = item['unlockableFiles']
  if (!Array.isArray(players) || players.length !== count || !Array.isArray(files) || files.length > 128) throw new Error('Invalid portrait answer')
  return {
    portraits: players.map(raw => { const portrait = record(raw)['portrait']; return portrait === null ? null : integer(portrait, 0, U32) }),
    unlockableFiles: files.map(handle => {
      if (typeof handle !== 'string' || !/^[a-f0-9]{80}$/u.test(handle)) throw new Error('Invalid portrait answer')
      return handle
    }),
  }
}
/** The worker's `inspectProfile` answer: counts and section paths only; anything else is refused. */
function profileShape(value: unknown) {
  const item = record(value)
  const counts = (raw: unknown, key: RegExp) => {
    const entries = Object.entries(record(raw))
    if (entries.length > 100) throw new Error('Invalid profile shape')
    return Object.fromEntries(entries.map(([name, count]) => {
      if (!key.test(name)) throw new Error('Invalid profile shape')
      return [name, integer(count, 0, U32)]
    }))
  }
  const number = (name: string) => item[name] === undefined || item[name] === null ? {} : { [name]: integer(item[name], 0, U32) }
  return {
    ...number('type'), ...number('bytes'), ...number('entries'), ...number('parsedTo'), ...number('s2gs'),
    ...number('addressError'), ...number('readFailure'),
    ...(item['cached'] === true ? { cached: true } : {}),
    ...(item['nameUnknown'] === true ? { nameUnknown: true } : {}),
    ...(item['valueTypes'] === undefined ? {} : { valueTypes: counts(item['valueTypes'], /^\d{1,3}$/u) }),
    ...(item['sections'] === undefined ? {} : { sections: counts(item['sections'], /^[0-9a-f]{2}(\/[0-9a-f]{2})?$/u) }),
  }
}
/** The worker's `names` answer: one entry per handle asked, in order, each with its name and clan tag or none. */
function playerIdentities(value: unknown, asked: readonly { region: number; realm: number; id: string }[]) {
  const players = record(value)['players']
  if (!Array.isArray(players) || players.length !== asked.length) throw new Error('Invalid name answer')
  return players.map((raw, index) => {
    const item = record(raw), want = asked[index]!
    const handle = profileHandle(item, 'Invalid name answer')
    if (handle.region !== want.region || handle.realm !== want.realm || handle.id !== want.id) throw new Error('Invalid name answer')
    const name = item['name'] === null || item['name'] === undefined ? undefined : text(item['name'], 100)
    const clanTag = item['tag'] === null || item['tag'] === undefined ? undefined : text(item['tag'], 24)
    return { ...handle, ...(name === undefined ? {} : { name }), ...(clanTag === undefined ? {} : { clanTag }) }
  })
}
function profileHandle(value: unknown, problem = 'Invalid lobby preview') {
  const item = record(value)
  const id = item['id']
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw new Error(problem)
  return { region: integer(item['region'], 0, 255), realm: integer(item['realm'], 0, U32), id }
}

/** Bounded line parser: neither malformed helper output nor Electron startup chatter is retained. */
function lines(onLine: (line: string) => void, failed: () => void) {
  let buffer = ''
  const decoder = new StringDecoder('utf8')
  return (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    if (buffer.length > 4 * 1024 * 1024) { buffer = ''; failed(); return }
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); onLine(line)
    }
  }
}
export function createDepotApi(options: RuntimeOptions): PublicDepotApi {
  return createPublicDepotApi(options.battleNetCacheDirectory === undefined ? {} : { cacheDirectory: options.battleNetCacheDirectory })
}

/**
 * Where the sign-in is kept.
 *
 * A Battle.net account is not a regional thing — the game's own editor signs in once and publishes
 * to whichever server it is pointed at. One cookie jar for the machine means the second and third
 * region cost no login at all, and signing out is what it says: this machine is signed out of
 * Battle.net, not out of one server.
 */
const loginProfile = (options: RuntimeOptions): string | undefined =>
  options.stateDirectory === undefined ? undefined : join(options.stateDirectory, 'battlenet-login', 'account')

/**
 * A sign-in kept under the old per-region layout is the same sign-in; it becomes the account's.
 * Without this the first login after the change would ask for a password that is already known.
 */
async function adoptRegionalLoginProfile(options: RuntimeOptions): Promise<void> {
  const target = loginProfile(options)
  if (target === undefined || options.stateDirectory === undefined) return
  if (await stat(target).then(() => true, () => false)) return
  for (const region of ['us', 'eu', 'kr']) {
    const legacy = join(options.stateDirectory, 'battlenet-login', region)
    if (await stat(legacy).then(() => true, () => false)) {
      await rename(legacy, target).catch(() => undefined)
      return
    }
  }
}

export function createDesktopLoginBackend(options: RuntimeOptions): BattleNetLoginBackend {
  const depot = createDepotApi(options)
  // One set of portrait catalogs and atlases for every server: they are the same files everywhere.
  const cacheDirectory = options.battleNetCacheDirectory
  const portraits = createPortraitImages({ readComponent: request => depot.readComponent(request),
    ...(cacheDirectory === undefined ? {} : { textureLists: (signal: AbortSignal) => cachedTextureLists(cacheDirectory, signal) }) })
  void adoptRegionalLoginProfile(options).catch(() => undefined)
  return { supportedRegions: ['us', 'eu', 'kr'],
    /** Signing out must leave nothing behind that would sign this account back in. */
    forget: async () => {
      const directory = loginProfile(options)
      if (directory) await rm(directory, { recursive: true, force: true })
    },
    login: request => new Promise((resolve, reject) => {
    request.signal.throwIfAborted()
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\modkit-battlenet-${randomUUID()}`
      : join(tmpdir(), `modkit-battlenet-${randomUUID()}.sock`)
    let transport: Socket | undefined
    const server = createServer(socket => {
      if (transport || closing) { socket.destroy(); return }
      transport = socket
      socket.on('data', onData)
      socket.on('error', fail)
      socket.once('close', fail)
    })
    server.listen(pipe)
    const profile = loginProfile(options)
    const child = spawn(options.electronExecutable,
      [join(options.researchDirectory, options.loginHelperScript ?? 'content_login.cjs'), request.region, options.pythonExecutable, pipe,
        ...(profile === undefined ? [] : [profile])],
      { cwd: options.researchDirectory, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'],
        // A command line is readable by any process on this machine; the ticket travels in the
        // environment of this one child instead.
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
          ...(request.ticket === undefined ? {} : { MODKIT_WEB_TICKET: request.ticket }) } })
    const lifetime = new AbortController()
    let ready = false
    let failureStage = 'starting'
    let diagnostic = ''
    let closing: Promise<void> | undefined
    let settleClose: (() => void) | undefined
    let exitCodeSeen = false
    let webTicket: string | undefined
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>()
    const loginTimer = setTimeout(() => fail(), 15 * 60_000)
    const close = (): Promise<void> => {
      if (closing) return closing
      closing = new Promise<void>(done => { settleClose = done })
      lifetime.abort(new Error('Battle.net connection ended'))
      clearTimeout(loginTimer)
      server.close()
      request.signal.removeEventListener('abort', abort)
      for (const task of pending.values()) void closing.then(() => task.reject(new Error('Battle.net connection ended')))
      pending.clear()
      if (exitCodeSeen) settleClose?.()
      else {
        transport?.end(JSON.stringify({ type: 'close' }) + '\n')
        const timer = setTimeout(() => child.kill(), 4000)
        timer.unref()
        child.once('close', () => clearTimeout(timer))
      }
      return closing
    }
    const fail = () => {
      const error = new Error(`Battle.net login/session failed (${failureStage}${diagnostic ? `: ${diagnostic}` : ''}). Check the selected region and native runtime.`)
      void close().then(() => reject(error))
    }
    server.on('error', fail)
    const abort = () => { const reason = request.signal.reason; void close().then(() => reject(reason)) }
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const rpc = (method: string, signal: AbortSignal, payload: Record<string, unknown> = {}, timeout = 180_000): Promise<unknown> => new Promise((res, rej) => {
      signal.throwIfAborted(); lifetime.signal.throwIfAborted()
      const id = randomUUID()
      // Native replies are ordered. Cancellation closes this session instead of leaving a pending wire reply.
      const cancel = () => { void close() }
      signal.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(cancel, timeout)
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); pending.delete(id) }
      pending.set(id, { resolve: value => { cleanup(); res(value) }, reject: error => { cleanup(); rej(error) } })
      transport!.write(JSON.stringify({ ...payload, type: 'request', id, method }) + '\n')
    })
    const onData = lines(line => {
      if (!line.startsWith('MODKIT_SOURCE:')) return
      try {
        const data = record(JSON.parse(line.slice(14)))
        if (typeof data['phase'] === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(data['phase'])) failureStage = data['phase']
        if (typeof data['diagnostic'] === 'string' && /^[A-Za-z0-9_-]{1,120}$/u.test(data['diagnostic'])) diagnostic = data['diagnostic']
        if (data['type'] === 'ticket' && typeof data['ticket'] === 'string' &&
          /^[A-Za-z0-9_-]{8,4096}$/u.test(data['ticket'])) { webTicket = data['ticket']; return }
        if (data['type'] === 'ready' && !ready && !closing) {
          ready = true; clearTimeout(loginTimer)
          const session: BattleNetAuthenticatedSession = {
            accountId: string(data['accountId']), accountName: string(data['accountName']),
            profileId: string(data['profileId']), profileName: string(data['profileName']),
            region: request.region, signal: lifetime.signal, close,
            ...(webTicket === undefined ? {} : { webTicket }),
            api: { ...depot,
              listPublished: async value => { if (value.region !== request.region) throw new Error('Session region mismatch'); return { items: publications(await rpc('list', value.signal)) } },
              searchMods: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                const answer = record(await rpc('search', value.signal, { name: value.name }))
                return { items: publications(answer['items']), ...(answer['truncated'] === true ? { truncated: true as const } : {}) }
              },
              openLobbies: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                return openLobbies(await rpc('lobbies', value.signal, value.mapId === undefined ? {} : { mapId: value.mapId }, 60_000))
              },
              describeMaps: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                if (value.maps.length < 1 || value.maps.length > 100) throw new Error('Describe 1 to 100 maps at a time')
                return publications(await rpc('maps', value.signal, { maps: value.maps.map(map => ({ id: map.id, version: map.version })) }, 60_000))
              },
              describeVariants: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                return readMapVariants(request => depot.readComponent(request), { region: value.region, headerHandle: value.headerHandle,
                  ...(value.locale === undefined ? {} : { locale: value.locale }), signal: value.signal })
              },
              describeMapPreview: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                return readMapPreview(request => depot.readComponent(request), { region: value.region, headerHandle: value.headerHandle,
                  ...(value.maxSize === undefined ? {} : { maxSize: value.maxSize }), signal: value.signal })
              },
              lobbyPreview: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                return lobbySlots(await rpc('preview', value.signal, { advert: { ...value.advert } }, 60_000))
              },
              describePortraits: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                if (value.players.length > 16) throw new Error('Ask for at most 16 players at a time')
                if (!value.players.length) return []
                const answer = playerPortraits(await rpc('portraits', value.signal,
                  { players: value.players.map(player => ({ region: player.region, realm: player.realm, name: player.name })) }, 120_000),
                value.players.length)
                const images = await Promise.allSettled(answer.portraits.map(portraitId => portraitId === null ? null : portraits.image({
                  region: value.region, portraitId, unlockableFiles: answer.unlockableFiles, signal: value.signal,
                  ...(value.maxSize === undefined ? {} : { maxSize: value.maxSize }) })))
                // One unreadable atlas costs its players' portraits; when nothing could be read, the caller hears why.
                const failed = images.find(image => image.status === 'rejected')
                if (failed && images.every(image => image.status === 'rejected')) throw failed.reason
                return images.map(image => image.status === 'fulfilled' ? image.value : null)
              },
              describeNames: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                if (value.players.length > 64) throw new Error('Ask for at most 64 players at a time')
                if (!value.players.length) return []
                const asked = value.players.map(player => profileHandle(player, 'Invalid player handle'))
                return playerIdentities(await rpc('names', value.signal, { players: asked }, 60_000), asked)
              },
              describeQueues: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                const tags = value.tags ?? []
                if (tags.length > 16 || tags.some(tag => !QUEUE_TAG.test(tag))) throw new Error('Invalid queue tags')
                const found = queueHandles(await rpc('queues', value.signal, { tags }, 120_000))
                const queues = await Promise.all(found.map(async item => {
                  const queue = await readQueueHeader(component => depot.readComponent(component), { region: value.region,
                    headerHandle: item.headerHandle, ...(value.locale === undefined ? {} : { locale: value.locale }), signal: value.signal })
                  // The header must describe the queue the service named it for.
                  if (queue.id !== item.id) throw new Error('Queue header describes another queue')
                  return queue
                }))
                return queues.filter(queue => tags.every(tag => queue.tags.includes(tag)))
              },
              describeSeason: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                return season(await rpc('season', value.signal, {}, 60_000))
              },
              inspectProfile: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                const target = value.player === 'self' ? { self: true } : { player: profileHandle(value.player, 'Invalid player handle') }
                return profileShape(await rpc('inspectProfile', value.signal, target, 120_000))
              },
              storage: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                const answer = record(await rpc('storage', value.signal))
                return Object.fromEntries(Object.entries(answer)
                  .filter(([, item]) => typeof item === 'number')) as Record<string, number>
              },
              prepublish: async value => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                const answer = record(await rpc('prepublish', value.signal, { names: [...value.names] }))
                const prior = answer['prior']
                if (typeof answer['namespace'] !== 'number') throw new Error('Invalid PrePublish answer')
                return {
                  namespace: answer['namespace'],
                  prior: prior === null || prior === undefined ? null : (() => {
                    const item = record(prior)
                    return { id: item['id'] as number, version: item['version'] as number,
                      name: string(item['name']), linked: item['linked'] === true }
                  })(),
                }
              },
              ...(options.stateDirectory ? {
                deletePublication: async (value: BattleNetDeleteRequest) => {
                  if (value.region !== request.region) throw new Error('Session region mismatch')
                  const scope = createHash('sha256').update(JSON.stringify([session.accountId, session.profileId, request.region])).digest('hex')
                  return await rpc('deletePublication', value.signal, { request: { region: value.region, publication: value.publication, operationId: value.operationId },
                    journalDirectory: join(options.stateDirectory!, 'publications', scope) }) as Awaited<ReturnType<BattleNetDeleteBackend>>
                },
                publish: async (value: Parameters<typeof publishDesktopPackage>[0]) => {
                if (value.region !== request.region) throw new Error('Session region mismatch')
                let submitted = false
                try {
                  return await publishDesktopPackage(value, options.stateDirectory!, JSON.stringify([session.accountId, session.profileId, request.region]),
                    (...args) => { submitted = true; return rpc(...args) })
                } catch (error) {
                  if (submitted) throw error
                  return { status: 'rejected' as const, operationId: value.operationId, region: value.region,
                    reason: 'Prepared package validation failed. Check the archive, component hashes, manifest paths and selected region.' }
                }
              } } : {}),
            },
          }
          if (data['region'] !== request.region) { fail(); return }
          resolve(session)
        } else if (data['type'] === 'response') {
          const task = pending.get(String(data['id']))
          if (data['error']) task?.reject(new Error(`Battle.net query failed${diagnostic ? ` (${diagnostic})` : ''}; narrow the search or reconnect`))
          else task?.resolve(data['value'])
        } else if (data['type'] === 'failed') fail()
      } catch { fail() }
    }, fail)
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    child.stdin.on('error', fail)
    child.once('error', fail)
    child.once('close', () => { exitCodeSeen = true; transport?.destroy(); fail(); settleClose?.() })
  }) }
}

/**
 * Entry loaded only by a trusted desktop host. No account connection is made until Connect. The
 * host's installation probes find a moved Documents folder, as for the standalone entry.
 */
export async function createContentSources(raw: Record<string, unknown>,
  context?: Sc2HostContext & { readonly credentials?: CredentialPort }): Promise<Sc2DesktopContentSources> {
  const local = await hostLocalOptions(raw, context)
  const options: RuntimeOptions = { researchDirectory: string(raw['researchDirectory']),
    pythonExecutable: string(raw['pythonExecutable']), electronExecutable: string(raw['electronExecutable']),
    stateDirectory: string(raw['stateDirectory']),
    ...(local.battleNetCacheDirectory === undefined ? {} : { battleNetCacheDirectory: local.battleNetCacheDirectory }) }
  for (const path of Object.values(options)) if (!isAbsolute(path)) throw new Error('Native runtime paths must be absolute')
  for (const path of [options.pythonExecutable, options.electronExecutable,
    join(options.researchDirectory, 'content_login.cjs'), join(options.researchDirectory, 'content_worker.py'),
    join(options.researchDirectory, 'content_publisher.py'),
    join(options.researchDirectory, 'content_deletion.py')]) {
    if (!(await stat(path)).isFile()) throw new Error('Native Battle.net runtime is not installed')
  }
  return new Sc2DesktopContentSources(local, new BattleNetContentSources({
    cacheDirectory: string(raw['cacheDirectory']), stateDirectory: string(raw['stateDirectory']),
    publishing: true, deletion: true, ...(context?.credentials === undefined ? {} : { credentials: context.credentials }),
    authentication: createDesktopLoginBackend(options), publicApi: createDepotApi(options) }))
}
