/**
 * Warcraft III replays (`.w3g`), the classic layout (1.07 – 1.26 and later 1.x).
 *
 * A fixed header — the signature, sizes, the product (`WAR3` or `W3XP`), game version, build,
 * whether it was a multiplayer game, the length in milliseconds — then zlib blocks whose
 * concatenation is the game record: the host and players, the game name, an encoded string with
 * the map and its settings, the slot table, then the replay itself — time slots carrying each
 * player's commands, chat, players leaving.
 *
 * Each player's command blocks are walked by their stated length, so the stream is read exactly
 * whatever the actions are; from patch 1.15 the actions inside are decoded too (`actions.ts`).
 *
 * Layout per the public description in `references/w3g-format/w3g_format.txt` (1.18, blue and
 * nagger); each block is a zlib stream cut at a sync flush (its section 3.0).
 */
import type { InflateSync } from '@modkit/codec-kit/compression/inflate'
import { decodesActions, emptyTally, tallyActions, type W3gActionTally } from './actions.js'

export const W3G_SIGNATURE = 'Warcraft III recorded game\u001a'
const SIGNATURE_BYTES = new TextEncoder().encode(W3G_SIGNATURE)
/** Header of versions that store a product and build (1.07 onwards); v0 has 0x40 bytes. */
const HEADER_V1_BYTES = 0x44
/** Reforged (build 10000+) moved to a different block header; not this reader's layout. */
const FIRST_REFORGED_VERSION = 10_000

export interface W3gHeader {
  readonly headerBytes: number
  readonly fileBytes: number
  readonly headerVersion: number
  readonly decompressedBytes: number
  readonly blocks: number
  readonly product: 'WAR3' | 'W3XP'
  readonly version: number
  readonly build: number
  readonly multiplayer: boolean
  readonly durationMs: number
}

export type W3gRace = 'human' | 'orc' | 'nightelf' | 'undead' | 'random'

export interface W3gSlot {
  readonly playerId: number
  readonly status: 'empty' | 'closed' | 'used'
  readonly computer: boolean
  /** 0–11; 12 is the observers' team. */
  readonly team: number
  readonly color: number
  readonly race: W3gRace | undefined
  readonly raceFixed: boolean
  readonly aiStrength: 'easy' | 'normal' | 'insane' | undefined
  readonly handicap: number
}

export interface W3gPlayer {
  readonly id: number
  readonly name: string
  readonly host: boolean
  readonly slot: W3gSlot | undefined
  /** Command blocks the player sent, and their total bytes. */
  readonly commands: number
  readonly commandBytes: number
  /** When the player left, in game milliseconds, and the result code the game recorded. */
  readonly leftAtMs?: number
  readonly leaveResult?: number
  /**
   * The decoded actions (patch 1.15 onwards): the standardized APM over the time the player
   * played without pauses, actions by kind, the build order, and what could not be decoded.
   */
  readonly actions?: W3gActionTally & { readonly apm: number }
}

export interface W3gChat {
  readonly timeMs: number
  readonly playerId: number
  /** `lobby` is chat before the game started; otherwise the addressees. */
  readonly scope: 'lobby' | 'all' | 'allies' | 'observers' | 'private'
  readonly toSlot?: number
  readonly text: string
}

export interface W3gReplay {
  readonly header: W3gHeader
  readonly gameName: string
  readonly map: { readonly path: string; readonly checksum: number; readonly creator: string }
  readonly settings: {
    readonly speed: 'slow' | 'normal' | 'fast' | undefined
    readonly settingBytes: readonly number[]
  }
  readonly players: readonly W3gPlayer[]
  readonly slots: readonly W3gSlot[]
  readonly randomSeed: number
  readonly chat: readonly W3gChat[]
  readonly timeSlots: number
  /** Sum of the time slots' increments: the game time the record covers, pauses included. */
  readonly recordedMs: number
  /** Of that, time the game stood paused (first pause to the next resume). */
  readonly pausedMs: number
}

export class W3gFormatError extends Error {}

export function isW3g(prefix: Uint8Array): boolean {
  return (
    prefix.byteLength >= SIGNATURE_BYTES.byteLength &&
    SIGNATURE_BYTES.every((value, index) => prefix[index] === value)
  )
}

const RACES: readonly [number, W3gRace][] = [
  [0x01, 'human'],
  [0x02, 'orc'],
  [0x04, 'nightelf'],
  [0x08, 'undead'],
  [0x20, 'random'],
]

class Reader {
  offset = 0
  constructor(
    private readonly bytes: Uint8Array,
    private readonly view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  ) {}
  get remaining(): number {
    return this.bytes.byteLength - this.offset
  }
  private need(count: number, what: string): void {
    if (count < 0 || this.offset + count > this.bytes.byteLength)
      throw new W3gFormatError(`replay ends inside ${what} at byte ${String(this.offset)}`)
  }
  u8(what: string): number {
    this.need(1, what)
    return this.bytes[this.offset++]!
  }
  u16(what: string): number {
    this.need(2, what)
    const value = this.view.getUint16(this.offset, true)
    this.offset += 2
    return value
  }
  u32(what: string): number {
    this.need(4, what)
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }
  skip(count: number, what: string): void {
    this.need(count, what)
    this.offset += count
  }
  take(count: number, what: string): Uint8Array {
    this.need(count, what)
    const slice = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return slice
  }
  /** A null-terminated byte string. */
  cbytes(what: string): Uint8Array {
    const end = this.bytes.indexOf(0, this.offset)
    if (end === -1) throw new W3gFormatError(`replay ends inside ${what}`)
    const slice = this.bytes.subarray(this.offset, end)
    this.offset = end + 1
    return slice
  }
  cstring(what: string): string {
    return decoder.decode(this.cbytes(what))
  }
}
const decoder = new TextDecoder('utf-8')

export function readW3gHeader(bytes: Uint8Array): W3gHeader {
  if (!isW3g(bytes)) throw new W3gFormatError('not a Warcraft III replay: the signature is missing')
  const reader = new Reader(bytes)
  reader.skip(28, 'signature')
  const headerBytes = reader.u32('header size')
  const fileBytes = reader.u32('file size')
  const headerVersion = reader.u32('header version')
  const decompressedBytes = reader.u32('decompressed size')
  const blocks = reader.u32('block count')
  if (headerVersion !== 1 || headerBytes !== HEADER_V1_BYTES)
    throw new W3gFormatError(
      `replay header version ${String(headerVersion)} (${String(headerBytes)} bytes) predates 1.07; not supported`,
    )
  const product = decoder.decode(reader.take(4, 'product')).split('').reverse().join('')
  if (product !== 'WAR3' && product !== 'W3XP')
    throw new W3gFormatError(`unknown replay product «${product}»`)
  const version = reader.u32('version')
  if (version >= FIRST_REFORGED_VERSION)
    throw new W3gFormatError(`Reforged replay (version ${String(version)}) is not supported`)
  const build = reader.u16('build')
  const flags = reader.u16('flags')
  const durationMs = reader.u32('length')
  return {
    headerBytes,
    fileBytes,
    headerVersion,
    decompressedBytes,
    blocks,
    product,
    version,
    build,
    multiplayer: (flags & 0x8000) !== 0,
    durationMs,
  }
}

/**
 * The game record: the blocks inflated and joined. Each block states its compressed and inflated
 * sizes; the last is padded with zeros to the block size, which the record parser ignores.
 */
export function readW3gBlocks(
  bytes: Uint8Array,
  header: W3gHeader,
  inflate: InflateSync,
  maxBytes: number,
  signal?: AbortSignal,
): Uint8Array {
  if (header.decompressedBytes === 0 || header.blocks === 0)
    throw new W3gFormatError('the replay holds no game record: the recording was cut off')
  if (header.decompressedBytes > maxBytes)
    throw new RangeError(
      `replay record of ${String(header.decompressedBytes)} bytes exceeds the budget of ${String(maxBytes)}`,
    )
  const reader = new Reader(bytes)
  reader.skip(header.headerBytes, 'header')
  const parts: Uint8Array[] = []
  let total = 0
  for (let block = 0; block < header.blocks; block += 1) {
    signal?.throwIfAborted()
    const compressed = reader.u16('block header')
    const inflated = reader.u16('block header')
    reader.skip(4, 'block checksum')
    const data = inflate(reader.take(compressed, 'block data'), inflated)
    if (data.byteLength !== inflated)
      throw new W3gFormatError(
        `block ${String(block)} inflates to ${String(data.byteLength)} bytes, not ${String(inflated)}`,
      )
    total += data.byteLength
    if (total > maxBytes) throw new RangeError('replay record exceeds the budget')
    parts.push(data)
  }
  const record = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    record.set(part, at)
    at += part.byteLength
  }
  return record
}

/** The map string: after each mask byte, seven bytes, each one lower when its mask bit is clear. */
function decodeMapString(encoded: Uint8Array): Uint8Array {
  const decoded: number[] = []
  let mask = 0
  for (let index = 0; index < encoded.byteLength; index += 1) {
    const value = encoded[index]!
    if (index % 8 === 0) mask = value
    else decoded.push((mask & (1 << index % 8)) === 0 ? value - 1 : value)
  }
  return Uint8Array.from(decoded)
}

function slotOf(reader: Reader): W3gSlot {
  const playerId = reader.u8('slot')
  reader.skip(1, 'slot download')
  const status = reader.u8('slot')
  const computer = reader.u8('slot') === 1
  const team = reader.u8('slot')
  const color = reader.u8('slot')
  const raceFlags = reader.u8('slot')
  const ai = reader.u8('slot')
  const handicap = reader.u8('slot')
  return {
    playerId,
    status: status === 2 ? 'used' : status === 1 ? 'closed' : 'empty',
    computer,
    team,
    color,
    race: RACES.find(([flag]) => (raceFlags & flag) !== 0)?.[1],
    raceFixed: (raceFlags & 0x40) === 0,
    aiStrength: computer ? (['easy', 'normal', 'insane'] as const)[ai] : undefined,
    handicap,
  }
}

const CHAT_SCOPES = ['all', 'allies', 'observers'] as const

export function readW3gRecord(
  header: W3gHeader,
  record: Uint8Array,
  signal?: AbortSignal,
): W3gReplay {
  const reader = new Reader(record)
  reader.skip(4, 'record prefix')
  const names = new Map<number, { name: string; host: boolean }>()
  const playerRecord = (host: boolean) => {
    const id = reader.u8('player record')
    const name = reader.cstring('player name')
    reader.skip(reader.u8('player record'), 'player record')
    names.set(id, { name, host })
  }
  if (reader.u8('host record') !== 0x00) throw new W3gFormatError('replay has no host record')
  playerRecord(true)
  const gameName = reader.cstring('game name')
  reader.cbytes('game record')
  const settings = new Reader(decodeMapString(reader.cbytes('map string')))
  const settingBytes = [...settings.take(9, 'map settings')]
  const checksum = settings.u32('map checksum')
  const path = settings.cstring('map path')
  const creator = settings.cstring('map creator')
  reader.skip(12, 'player count, game type and language')
  while (record[reader.offset] === 0x16) {
    reader.skip(1, 'player record')
    playerRecord(false)
    reader.skip(4, 'player record')
  }
  if (reader.u8('game start record') !== 0x19) throw new W3gFormatError('replay has no game start record')
  const startBytes = reader.u16('game start record')
  const startEnd = reader.offset + startBytes
  const slotCount = reader.u8('slot count')
  const slots: W3gSlot[] = []
  for (let slot = 0; slot < slotCount; slot += 1) slots.push(slotOf(reader))
  const randomSeed = reader.u32('random seed')
  reader.offset = startEnd

  const commands = new Map<number, { count: number; bytes: number }>()
  const tallies = new Map<number, W3gActionTally>()
  const decoding = decodesActions(header.version)
  const leaves = new Map<number, { atMs: number; result: number }>()
  const chat: W3gChat[] = []
  let timeMs = 0
  let timeSlots = 0
  // Paused time is taken out of the played time; the first pause stops the clock, the first
  // resume after it starts it again.
  let pausedAt: number | undefined
  let pausedMs = 0
  const pause = (paused: boolean) => {
    if (paused && pausedAt === undefined) pausedAt = timeMs
    else if (!paused && pausedAt !== undefined) {
      pausedMs += timeMs - pausedAt
      pausedAt = undefined
    }
  }
  replay: while (reader.remaining > 0) {
    signal?.throwIfAborted()
    const id = reader.u8('replay block')
    switch (id) {
      case 0x00:
        // The last block's zero padding: nothing follows.
        break replay
      case 0x17: {
        reader.skip(4, 'leave reason')
        const playerId = reader.u8('leave')
        const result = reader.u32('leave')
        reader.skip(4, 'leave')
        leaves.set(playerId, { atMs: timeMs, result })
        break
      }
      case 0x1a:
      case 0x1b:
      case 0x1c:
        reader.skip(4, 'start block')
        break
      case 0x1e:
      case 0x1f: {
        const length = reader.u16('time slot')
        const end = reader.offset + length
        timeMs += reader.u16('time increment')
        timeSlots += 1
        while (reader.offset < end) {
          const playerId = reader.u8('command block')
          const size = reader.u16('command block')
          const block = reader.take(size, 'command block')
          if (decoding) {
            let tally = tallies.get(playerId)
            if (tally === undefined) tallies.set(playerId, (tally = emptyTally()))
            tallyActions(block, timeMs, tally, pause)
          }
          const known = commands.get(playerId) ?? { count: 0, bytes: 0 }
          commands.set(playerId, { count: known.count + 1, bytes: known.bytes + size })
        }
        if (reader.offset !== end) throw new W3gFormatError('a time slot overruns its length')
        break
      }
      case 0x20: {
        const playerId = reader.u8('chat')
        const length = reader.u16('chat')
        const end = reader.offset + length
        const flags = reader.u8('chat')
        if (flags === 0x10) chat.push({ timeMs, playerId, scope: 'lobby', text: reader.cstring('chat') })
        else {
          const mode = reader.u32('chat mode')
          const text = reader.cstring('chat')
          chat.push(
            mode < 3
              ? { timeMs, playerId, scope: CHAT_SCOPES[mode]!, text }
              : { timeMs, playerId, scope: 'private', toSlot: mode - 3, text },
          )
        }
        reader.offset = end
        break
      }
      case 0x22:
        reader.skip(reader.u8('checksum'), 'checksum')
        break
      case 0x23:
        reader.skip(10, 'unknown block 0x23')
        break
      case 0x2f:
        reader.skip(8, 'game end countdown')
        break
      default:
        throw new W3gFormatError(
          `unknown replay block 0x${id.toString(16)} at byte ${String(reader.offset - 1)}`,
        )
    }
  }

  const slotByPlayer = new Map(slots.filter(slot => slot.status === 'used').map(slot => [slot.playerId, slot]))
  const players = [...names].map(([id, { name, host }]): W3gPlayer => {
    const sent = commands.get(id)
    const left = leaves.get(id)
    const tally = decoding ? (tallies.get(id) ?? emptyTally()) : undefined
    const playedMs = (left?.atMs ?? timeMs) - pausedMs
    return {
      id,
      name,
      host,
      slot: slotByPlayer.get(id),
      commands: sent?.count ?? 0,
      commandBytes: sent?.bytes ?? 0,
      ...(left === undefined ? {} : { leftAtMs: left.atMs, leaveResult: left.result }),
      ...(tally === undefined
        ? {}
        : { actions: { ...tally, apm: playedMs > 0 ? Math.round((tally.counted * 60_000) / playedMs) : 0 } }),
    }
  })
  // Game settings, byte 0: the speed in bits 0–1 (3 is unused).
  const speed = (settingBytes[0] ?? 3) & 3
  return {
    header,
    gameName,
    map: { path, checksum, creator },
    settings: {
      speed: (['slow', 'normal', 'fast'] as const)[speed],
      settingBytes,
    },
    players,
    slots,
    randomSeed,
    chat,
    timeSlots,
    recordedMs: timeMs,
    pausedMs: pausedMs + (pausedAt === undefined ? 0 : timeMs - pausedAt),
  }
}
