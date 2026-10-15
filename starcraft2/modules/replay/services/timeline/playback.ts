/**
 * Projects a decoded tracker timeline onto the generic transport timeline: participants, measured
 * series and markers on the transport's millisecond axis. Positions stay tracker samples — nothing
 * here simulates the game.
 */

export const REPLAY_PLAYBACK_LOOPS_PER_SECOND = 22.4

interface TrackLike {
  readonly typeId: number
  readonly controlPlayerId: number
  readonly bornLoop: number
  readonly initOnly: boolean
  readonly doneLoop?: number
  readonly diedLoop?: number
}

interface PlayerStatsLike {
  readonly mineralsUsedCurrentArmy: number
  readonly vespeneUsedCurrentArmy: number
}

export interface ReplayTimelineLike {
  readonly durationLoops: number
  readonly units: readonly TrackLike[]
  readonly typeNames: readonly string[]
  readonly upgrades: readonly {
    readonly loop: number
    readonly playerId: number
    readonly name: string
  }[]
  readonly stats: ReadonlyMap<number, readonly { readonly loop: number; readonly stats: PlayerStatsLike }[]>
  readonly players: readonly { readonly playerId: number; readonly slotId?: number }[]
}

export interface ReplayDetailsPlayerLike {
  readonly name: string
  readonly race: string
  readonly color: { readonly r: number; readonly g: number; readonly b: number }
  readonly result: number
  readonly observe?: number
  readonly workingSetSlotId?: number
}

export interface ReplayPlaybackInput {
  readonly timeline: ReplayTimelineLike
  readonly players?: readonly ReplayDetailsPlayerLike[]
  /** Actions per minute by details index, when game events were decoded. */
  readonly apm?: readonly (number | undefined)[]
  /** The map's title from details; a player shows it as the timeline's title. */
  readonly title?: string
  /** Chat lines as the replay analysis decodes them; `userId` is the details index. */
  readonly chat?: readonly { readonly gameloop: number; readonly userId?: number; readonly message: string }[]
}

export interface ReplayPlaybackRequest {
  readonly maxMarkers: number
  readonly maxSeriesPoints: number
}

export interface ReplayPlaybackTimeline {
  readonly label?: string
  readonly participants: readonly {
    readonly id: string
    readonly label: string
    readonly color?: string
    readonly group?: string
    readonly outcome?: 'win' | 'loss' | 'tie' | 'undecided'
    readonly facts: readonly { readonly id: string; readonly label: string; readonly value: string }[]
  }[]
  readonly series: readonly {
    readonly metric: string
    readonly label: string
    readonly participantId?: string
    readonly points: readonly number[]
  }[]
  readonly markers: readonly {
    readonly positionMs: number
    readonly kind: string
    readonly label: string
    readonly participantId?: string
  }[]
  readonly complete: boolean
  readonly fidelity: 'sampled'
}

const MAX_MARKERS = 100_000
const MAX_SERIES_POINTS = 100_000
// ponytail: fixed noise list; a catalog-driven "is this a unit worth listing" belongs to resolved data.
const NOISE_TYPES = new Set(['Larva', 'Egg', 'LarvaReleaseMissile', 'BroodlingEscort', 'Interceptor'])

export const loopToMs = (loop: number): number =>
  Math.round((loop * 1000) / REPLAY_PLAYBACK_LOOPS_PER_SECOND)

const hex = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0')

const OUTCOMES = { 1: 'win', 2: 'loss', 3: 'tie' } as const

function bound(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer within [0, ${maximum}]`)
  }
  return value
}

/** Tracker player id of every details player: PlayerSetup slot first, details order otherwise. */
function trackerPlayerIds(
  timeline: ReplayTimelineLike,
  players: readonly ReplayDetailsPlayerLike[],
): number[] {
  const bySlot = new Map(
    timeline.players.flatMap(player =>
      player.slotId === undefined ? [] : [[player.slotId, player.playerId] as const],
    ),
  )
  return players.map((player, index) =>
    player.workingSetSlotId === undefined
      ? index + 1
      : (bySlot.get(player.workingSetSlotId) ?? index + 1),
  )
}

/** At most `room` of `items`, taken at even steps so the first and the last stretch are both there. */
function spread<T>(items: readonly T[], room: number): T[] {
  if (items.length <= room) return [...items]
  return Array.from({ length: room }, (_, index) => items[Math.floor((index * items.length) / room)]!)
}

function downsample(points: number[], maximum: number): { points: number[]; cut: boolean } {
  const count = points.length / 2
  if (count <= maximum) return { points, cut: false }
  if (maximum === 0) return { points: [], cut: true }
  const out: number[] = []
  const stride = count / maximum
  for (let index = 0; index < maximum; index += 1) {
    const at = Math.min(count - 1, Math.floor(index * stride)) * 2
    out.push(points[at]!, points[at + 1]!)
  }
  return { points: out, cut: true }
}

export function projectReplayPlayback(
  input: ReplayPlaybackInput,
  request: ReplayPlaybackRequest,
): ReplayPlaybackTimeline {
  const maxMarkers = bound(request.maxMarkers, MAX_MARKERS, 'maxMarkers')
  const maxSeriesPoints = bound(request.maxSeriesPoints, MAX_SERIES_POINTS, 'maxSeriesPoints')
  const { timeline } = input
  const details = input.players ?? []
  const ids = trackerPlayerIds(timeline, details)
  const participantIds = new Set<number>(
    details.length > 0
      ? ids.filter((_, index) => details[index]!.observe !== 1 && details[index]!.observe !== 2)
      : [...timeline.stats.keys()],
  )
  const participants = [...participantIds].map(playerId => {
    const index = ids.indexOf(playerId)
    const player = index < 0 ? undefined : details[index]
    const apm = index < 0 ? undefined : input.apm?.[index]
    return Object.freeze({
      id: String(playerId),
      label: player?.name || `Player ${playerId}`,
      ...(player === undefined
        ? {}
        : {
            color: `#${hex(player.color.r)}${hex(player.color.g)}${hex(player.color.b)}`,
            ...(player.race === '' ? {} : { group: player.race }),
            outcome: OUTCOMES[player.result as keyof typeof OUTCOMES] ?? 'undecided',
          }),
      facts: Object.freeze(
        apm === undefined ? [] : [Object.freeze({ id: 'apm', label: 'APM', value: String(apm) })],
      ),
    })
  })

  let complete = true
  const series: ReplayPlaybackTimeline['series'][number][] = []
  const deltas: [loop: number, playerId: number, delta: number][] = []
  const markers: ReplayPlaybackTimeline['markers'][number][] = []
  for (const track of timeline.units) {
    const playerId = track.controlPlayerId
    if (!participantIds.has(playerId)) continue
    const name = timeline.typeNames[track.typeId] ?? String(track.typeId)
    const readyLoop = track.initOnly ? track.doneLoop : track.bornLoop
    if (!track.initOnly) {
      deltas.push([track.bornLoop, playerId, 1])
      if (track.diedLoop !== undefined) deltas.push([track.diedLoop, playerId, -1])
    }
    if (NOISE_TYPES.has(name) || name.startsWith('Beacon')) continue
    const participantId = String(playerId)
    // Loop 0 is the starting layout, not something that happened.
    if (readyLoop !== undefined && readyLoop > 0)
      markers.push({
        positionMs: loopToMs(readyLoop),
        kind: track.initOnly ? 'structure-done' : 'unit-born',
        label: name,
        participantId,
      })
    if (track.diedLoop !== undefined)
      markers.push({
        positionMs: loopToMs(track.diedLoop),
        kind: 'unit-died',
        label: name,
        participantId,
      })
  }
  for (const upgrade of timeline.upgrades) {
    if (upgrade.loop <= 0 || !participantIds.has(upgrade.playerId)) continue
    markers.push({
      positionMs: loopToMs(upgrade.loop),
      kind: 'upgrade',
      label: upgrade.name,
      participantId: String(upgrade.playerId),
    })
  }
  // What players said, where they said it; an observer's line keeps no participant.
  for (const line of input.chat ?? []) {
    const playerId = line.userId === undefined ? undefined : ids[line.userId]
    markers.push({
      positionMs: loopToMs(line.gameloop),
      kind: 'chat',
      label: line.message,
      ...(playerId !== undefined && participantIds.has(playerId) ? { participantId: String(playerId) } : {}),
    })
  }
  markers.sort((left, right) => left.positionMs - right.positionMs)
  if (markers.length > maxMarkers) {
    /*
     * Over the bound, chat stays first, then upgrades — few, and each one matters — and unit events
     * are thinned evenly over the whole game. Cutting at a moment ended a 39-minute FFA at 12:41.
     */
    complete = false
    const kept: typeof markers = []
    for (const tier of [['chat'], ['upgrade'], undefined])
      kept.push(
        ...spread(
          markers.filter(marker => (tier === undefined ? !['chat', 'upgrade'].includes(marker.kind) : tier.includes(marker.kind))),
          maxMarkers - kept.length,
        ),
      )
    kept.sort((left, right) => left.positionMs - right.positionMs)
    markers.length = 0
    for (const marker of kept) markers.push(marker)
  }

  deltas.sort((left, right) => left[0] - right[0])
  for (const playerId of participantIds) {
    const samples = timeline.stats.get(playerId) ?? []
    const army: number[] = []
    const units: number[] = []
    let alive = 0
    let cursor = 0
    for (const sample of samples) {
      while (cursor < deltas.length && deltas[cursor]![0] <= sample.loop) {
        const [, owner, delta] = deltas[cursor]!
        if (owner === playerId) alive += delta
        cursor += 1
      }
      const at = loopToMs(sample.loop)
      units.push(at, alive)
      army.push(at, sample.stats.mineralsUsedCurrentArmy + sample.stats.vespeneUsedCurrentArmy)
    }
    for (const [metric, label, points] of [
      ['units', 'Units', units],
      ['army-value', 'Army value', army],
    ] as const) {
      const bounded = downsample(points, maxSeriesPoints)
      if (bounded.cut) complete = false
      series.push(
        Object.freeze({
          metric,
          label,
          participantId: String(playerId),
          points: Object.freeze(bounded.points),
        }),
      )
    }
  }

  return Object.freeze({
    ...(input.title === undefined || input.title === '' ? {} : { label: input.title }),
    participants: Object.freeze(participants),
    series: Object.freeze(series),
    markers: Object.freeze(markers.map(marker => Object.freeze(marker))),
    complete,
    fidelity: 'sampled',
  })
}
