/**
 * History of open Arcade lobbies across successive lobby-list polls: when each lobby opened, who
 * joined and left (once slot lists are known), what the host changed, and how it ended.
 *
 * Battle.net reports only that a lobby left the list. How it ended is inferred with the rules of the
 * original Arcade Watcher (legacy-server-v1 gametracker.ts): unseen too long - unknown; a full
 * single-player lobby - started; one human or fewer left - abandoned (the host leaving disbands the
 * lobby); two humans with a stale slot list that no longer holds the host - abandoned; otherwise started.
 */
import type { BattleNetLobbySlot, BattleNetOpenLobby } from '../content-sources/vfs-provider.js'

export type LobbyOutcome = 'started' | 'abandoned' | 'unknown'

export type LobbyEventKind = 'opened' | 'joined' | 'left' | 'players' | 'title' | 'host' | 'capacity' | 'variant' | 'closed'

export interface LobbyEvent {
  /** Unix seconds on the local clock. */
  readonly at: number
  readonly kind: LobbyEventKind
  /** Player of joined/left; host of opened. */
  readonly name?: string
  readonly from?: string | number
  readonly to?: string | number
  /** The player was already in the lobby when the watcher first saw its slots. */
  readonly late?: true
  readonly outcome?: LobbyOutcome
}

export interface TrackedLobby {
  lobby: BattleNetOpenLobby
  /** Creation time moved onto the local clock. */
  readonly openedAt: number
  readonly firstSeen: number
  lastSeen: number
  slots?: readonly BattleNetLobbySlot[]
  slotsAt?: number
  closedAt?: number
  outcome?: LobbyOutcome
  readonly events: LobbyEvent[]
}

/** A lobby unseen for longer than this before it disappeared closed while nobody was looking. */
const ORPHAN_SECONDS = 70
/** Players of a lobby first seen this soon after creation joined under observation. */
const FRESH_SECONDS = 45
/** A slot list older than this no longer describes who was in the lobby when it closed. */
const SLOTS_FRESH_SECONDS = 13
const MAX_EVENTS = 200

const humans = (slots: readonly BattleNetLobbySlot[] | undefined): string[] =>
  (slots ?? []).filter(slot => slot.kind === 'human' && slot.name !== undefined).map(slot => slot.name!)

export class LobbyTracker {
  readonly #open = new Map<number, TrackedLobby>()
  #closed: TrackedLobby[] = []
  /** How far the server clock runs ahead of ours, learned from freshly created lobbies. */
  #serverAhead = 0

  constructor(private readonly keepClosed = 50) {}

  get open(): readonly TrackedLobby[] { return [...this.#open.values()] }
  get closed(): readonly TrackedLobby[] { return this.#closed }

  /** Takes one complete lobby list; returns what changed since the previous one. */
  apply(lobbies: readonly BattleNetOpenLobby[], at: number): LobbyEvent[] {
    const events: LobbyEvent[] = []
    const seen = new Set<number>()
    for (const lobby of lobbies) {
      seen.add(lobby.advert.id)
      const known = this.#open.get(lobby.advert.id)
      if (known) {
        events.push(...this.#record(known, this.#changes(known, lobby, at)))
        known.lobby = lobby
        known.lastSeen = at
      } else {
        events.push(...this.#start(lobby, at).events)
      }
    }
    for (const tracked of [...this.#open.values()])
      if (!seen.has(tracked.lobby.advert.id)) events.push(this.#close(tracked, at))
    return events
  }

  /** Takes the slot list of an open lobby; returns who joined or left since the previous one. */
  applySlots(advertId: number, slots: readonly BattleNetLobbySlot[] | null, at: number): LobbyEvent[] {
    const tracked = this.#open.get(advertId)
    if (!tracked || slots === null) return []
    const before = tracked.slots === undefined ? undefined : humans(tracked.slots)
    const now = humans(slots)
    const events: LobbyEvent[] = []
    if (before === undefined) {
      const fresh = tracked.firstSeen - tracked.openedAt <= FRESH_SECONDS
      const host = slots.find(slot => slot.host)?.name
      for (const name of now)
        events.push(name === host ? { at: tracked.openedAt, kind: 'joined', name }
          : fresh ? { at, kind: 'joined', name } : { at, kind: 'joined', name, late: true })
    } else {
      for (const name of now) if (!before.includes(name)) events.push({ at, kind: 'joined', name })
      for (const name of before) if (!now.includes(name)) events.push({ at, kind: 'left', name })
    }
    tracked.slots = slots
    tracked.slotsAt = at
    return this.#record(tracked, events)
  }

  #start(lobby: BattleNetOpenLobby, at: number): TrackedLobby {
    const ahead = lobby.createdAt - at
    if (ahead > this.#serverAhead && ahead < 600) this.#serverAhead = ahead
    let openedAt = lobby.createdAt - this.#serverAhead
    // A creation time from the future or from days ago is not a clock worth using.
    if (openedAt > at || at - openedAt > 2 * 86400) openedAt = at
    const tracked: TrackedLobby = { lobby, openedAt, firstSeen: at, lastSeen: at,
      events: [{ at: openedAt, kind: 'opened', name: lobby.hostName }] }
    this.#open.set(lobby.advert.id, tracked)
    return tracked
  }

  #changes(tracked: TrackedLobby, lobby: BattleNetOpenLobby, at: number): LobbyEvent[] {
    const before = tracked.lobby
    const events: LobbyEvent[] = []
    const change = (kind: LobbyEventKind, from: string | number, to: string | number) => {
      if (from !== to) events.push({ at, kind, from, to })
    }
    change('title', before.title, lobby.title)
    change('host', before.hostName, lobby.hostName)
    change('capacity', before.capacity, lobby.capacity)
    change('variant', before.variant, lobby.variant)
    // With slot lists, joins and leaves name the players; without them only the count is known.
    if (tracked.slots === undefined) change('players', before.players, lobby.players)
    return events
  }

  #close(tracked: TrackedLobby, at: number): LobbyEvent {
    const { lobby } = tracked
    let closedAt = at
    let outcome: LobbyOutcome
    if (at - tracked.lastSeen > ORPHAN_SECONDS) {
      outcome = 'unknown'
      closedAt = tracked.lastSeen
    } else if (lobby.capacity === 1 && lobby.players === 1) {
      outcome = 'started'
    } else {
      const fresh = tracked.slotsAt !== undefined && tracked.lastSeen - tracked.slotsAt <= SLOTS_FRESH_SECONDS
      const count = fresh ? humans(tracked.slots).length : lobby.players
      const hostInSlots = humans(tracked.slots).includes(lobby.hostName)
      outcome = count <= 1 || (count === 2 && !fresh && tracked.slots !== undefined && !hostInSlots) ? 'abandoned' : 'started'
    }
    tracked.closedAt = closedAt
    tracked.outcome = outcome
    const event: LobbyEvent = { at: closedAt, kind: 'closed', outcome }
    this.#record(tracked, [event])
    this.#open.delete(lobby.advert.id)
    this.#closed.unshift(tracked)
    if (this.#closed.length > this.keepClosed) this.#closed.length = this.keepClosed
    return event
  }

  #record(tracked: TrackedLobby, events: LobbyEvent[]): LobbyEvent[] {
    tracked.events.push(...events)
    if (tracked.events.length > MAX_EVENTS) tracked.events.splice(1, tracked.events.length - MAX_EVENTS)
    return events
  }
}
