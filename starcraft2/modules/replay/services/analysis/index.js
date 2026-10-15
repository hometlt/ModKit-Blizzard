const REPLAY_LOOPS_PER_SECOND = 22.4
const ENGAGEMENT_GAP_LOOPS = REPLAY_LOOPS_PER_SECOND * 10
const WORKER_TYPES = new Set(['SCV', 'Drone', 'Probe', 'MULE'])
const UNIT_CLASSES = new Set(['worker', 'army', 'building', 'other'])
const MAXIMUM_LOOKUP_ENTRIES = 10_000

const timeLabel = loop => {
  const seconds = Math.floor(loop / REPLAY_LOOPS_PER_SECOND)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const playerRecord = (player, index) => ({
  playerId: index + 1,
  name: player.name,
  race: player.race,
  result: player.result,
  unitsProduced: 0,
  workersProduced: 0,
  armyProduced: 0,
  buildingsProduced: 0,
  unitsLost: 0,
  unitsKilled: 0,
  supplyBlockSeconds: 0,
  buildOrder: [],
})

function clusterEngagements(deaths) {
  const result = []
  let current
  let previous = -Infinity
  for (const death of deaths) {
    if (current === undefined || death.gameloop - previous > ENGAGEMENT_GAP_LOOPS) {
      current = {
        startGameloop: death.gameloop,
        endGameloop: death.gameloop,
        time: timeLabel(death.gameloop),
        deaths: {},
        totalDeaths: 0,
      }
      result.push(current)
    }
    current.endGameloop = death.gameloop
    current.deaths[death.playerId] = (current.deaths[death.playerId] ?? 0) + 1
    current.totalDeaths += 1
    previous = death.gameloop
  }
  return result
}

function addGameEventMetrics(gameEvents, players) {
  const state = new Map()
  const get = userId => {
    let value = state.get(userId)
    if (value === undefined) {
      value = {
        screenStart: undefined,
        firstAction: undefined,
        actions: 0,
        totalActions: 0,
        cameras: 0,
        cycles: 0,
        latencyLoops: 0,
        actionsInCycles: 0,
        gapLoops: 0,
        previousCycleStart: undefined,
        maximumLoop: 0,
      }
      state.set(userId, value)
    }
    return value
  }
  const closeCycle = value => {
    if (value.screenStart === undefined || value.firstAction === undefined) return
    value.cycles += 1
    value.latencyLoops += value.firstAction - value.screenStart
    value.actionsInCycles += value.actions
    if (value.previousCycleStart !== undefined)
      value.gapLoops += value.screenStart - value.previousCycleStart
    value.previousCycleStart = value.screenStart
  }
  for (const event of gameEvents ?? []) {
    const userId = event?._userid?.m_userId
    if (!Number.isSafeInteger(userId) || !Number.isFinite(event?._gameloop)) continue
    const value = get(userId)
    value.maximumLoop = Math.max(value.maximumLoop, event._gameloop)
    if (String(event._event ?? '').includes('CameraUpdate')) {
      value.cameras += 1
      closeCycle(value)
      value.screenStart = event._gameloop
      value.firstAction = undefined
      value.actions = 0
    } else {
      value.totalActions += 1
      if (value.screenStart === undefined) value.screenStart = event._gameloop
      if (value.firstAction === undefined) value.firstAction = event._gameloop
      value.actions += 1
    }
  }
  for (const player of players.values()) {
    const value = state.get(player.playerId - 1)
    if (value === undefined) continue
    closeCycle(value)
    const minutes = value.maximumLoop / REPLAY_LOOPS_PER_SECOND / 60 || 1
    player.apm = Math.round(value.totalActions / minutes)
    player.cameraMoves = value.cameras
    player.pac = value.cycles
    player.pacPerMin = Math.round((value.cycles / minutes) * 10) / 10
    if (value.cycles > 0) {
      player.actionsPerPac = Math.round((value.actionsInCycles / value.cycles) * 100) / 100
      player.pacLatencySec =
        Math.round((value.latencyLoops / value.cycles / REPLAY_LOOPS_PER_SECOND) * 100) / 100
      if (value.cycles > 1)
        player.pacGapSec =
          Math.round((value.gapLoops / (value.cycles - 1) / REPLAY_LOOPS_PER_SECOND) * 100) / 100
    }
  }
}

export function chatLines(messageEvents) {
  const decoder = new TextDecoder()
  return (messageEvents ?? []).flatMap(event => {
    if (!String(event?._event ?? '').endsWith('SChatMessage')) return []
    const raw = event.m_string
    const gameloop = Number(event._gameloop ?? 0)
    const userId = event?._userid?.m_userId
    return [
      {
        gameloop,
        time: timeLabel(gameloop),
        ...(Number.isSafeInteger(userId) ? { userId } : {}),
        message: raw instanceof Uint8Array ? decoder.decode(raw) : String(raw ?? ''),
      },
    ]
  })
}

function addCost(player, key, cost) {
  if (
    cost === null ||
    typeof cost !== 'object' ||
    !Number.isFinite(cost.minerals) ||
    !Number.isFinite(cost.gas)
  )
    return
  const current = player[key] ?? { minerals: 0, gas: 0 }
  current.minerals += cost.minerals
  current.gas += cost.gas
  player[key] = current
}

function addInitialRatings(initData, players) {
  const users = initData?.m_syncLobbyState?.m_userInitialData
  if (!Array.isArray(users)) return
  users.forEach((user, userId) => {
    const rating = user?.m_scaledRating
    const player = players.get(userId + 1)
    if (player !== undefined && Number.isFinite(rating)) player.mmr = rating
  })
}

function validateAnalysisOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('replay analysis options must be an object')
  }
  if (options.includeWorkers !== undefined && typeof options.includeWorkers !== 'boolean') {
    throw new TypeError('includeWorkers must be boolean')
  }
  const validateLookup = (value, label, validate) => {
    if (value === undefined) return
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${label} must be an object`)
    }
    const entries = Object.entries(value)
    if (entries.length > MAXIMUM_LOOKUP_ENTRIES) {
      throw new RangeError(`${label} exceeds ${MAXIMUM_LOOKUP_ENTRIES} entries`)
    }
    for (const [key, item] of entries) {
      if (key.length === 0 || key.length > 1_024) throw new TypeError(`${label} has an invalid key`)
      validate(item, `${label}.${key}`)
    }
  }
  validateLookup(options.unitClass, 'unitClass', (value, label) => {
    if (!UNIT_CLASSES.has(value)) throw new TypeError(`${label} is not a supported unit class`)
  })
  validateLookup(options.unitCost, 'unitCost', (value, label) => {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Number.isFinite(value.minerals) ||
      value.minerals < 0 ||
      !Number.isFinite(value.gas) ||
      value.gas < 0
    ) {
      throw new TypeError(`${label} must contain non-negative finite minerals and gas`)
    }
  })
}

/**
 * The unit types the players fielded, sorted: the catalog entries analysis classifies and prices
 * (beacons are markers, not units).
 */
export function replayUnitTypes({ trackerEvents }) {
  const types = new Set()
  for (const event of trackerEvents) {
    if (event.event !== 'UnitInit' && event.event !== 'UnitBorn') continue
    const name = String(event.unitTypeName)
    if (name !== '' && !name.startsWith('Beacon')) types.add(name)
  }
  return [...types].sort()
}

/** Build-only analysis over decoded replay streams; catalog-dependent classification stays external. */
export function analyzeReplay(
  { header, details, trackerEvents, gameEvents, messageEvents, initData },
  options = {},
) {
  validateAnalysisOptions(options)
  const buildOrderLimit = options.buildOrderLimit ?? 20
  if (!Number.isSafeInteger(buildOrderLimit) || buildOrderLimit < 0 || buildOrderLimit > 10_000)
    throw new RangeError('replay buildOrderLimit must be an integer within [0, 10000]')
  const players = new Map(
    details.players.map((player, index) => [index + 1, playerRecord(player, index)]),
  )
  const owners = new Map(),
    types = new Map(),
    supplies = new Map(),
    finalStats = new Map(),
    economy = new Map()
  const deaths = [],
    timeline = []
  let pending,
    pendingLoop = -1
  const flush = () => {
    if (pending !== undefined) timeline.push(pending)
    pending = undefined
  }
  for (const event of trackerEvents) {
    if (event.event === 'PlayerStats') {
      const player = players.get(event.playerId),
        stats = event.stats
      supplies.set(event.playerId, stats.foodUsed)
      finalStats.set(event.playerId, stats)
      let aggregate = economy.get(event.playerId)
      if (aggregate === undefined) {
        aggregate = {
          income: 0,
          unspent: 0,
          samples: 0,
          blockedLoops: 0,
          previousLoop: event.gameloop,
          blocked: false,
        }
        economy.set(event.playerId, aggregate)
      }
      aggregate.income += stats.mineralsCollectionRate + stats.vespeneCollectionRate
      aggregate.unspent += stats.mineralsCurrent + stats.vespeneCurrent
      aggregate.samples += 1
      if (aggregate.blocked) aggregate.blockedLoops += event.gameloop - aggregate.previousLoop
      aggregate.blocked =
        stats.foodMade > 0 && stats.foodMade < 200 && stats.foodUsed >= stats.foodMade
      aggregate.previousLoop = event.gameloop
      if (event.gameloop !== pendingLoop) {
        flush()
        pendingLoop = event.gameloop
        pending = {
          gameloop: event.gameloop,
          seconds: Math.round(event.gameloop / REPLAY_LOOPS_PER_SECOND),
          players: {},
        }
      }
      pending.players[event.playerId] = {
        minerals: stats.mineralsCurrent,
        vespene: stats.vespeneCurrent,
        mineralsRate: stats.mineralsCollectionRate,
        vespeneRate: stats.vespeneCollectionRate,
        supplyUsed: stats.foodUsed,
        supplyCap: stats.foodMade,
        workers: stats.workersActiveCount,
        armyValueMinerals: stats.mineralsUsedCurrentArmy,
        armyValueVespene: stats.vespeneUsedCurrentArmy,
      }
    } else if (event.event === 'UnitInit' || event.event === 'UnitBorn') {
      if (String(event.unitTypeName).startsWith('Beacon')) continue
      owners.set(event.unitTag, event.controlPlayerId)
      types.set(event.unitTag, event.unitTypeName)
      const player = players.get(event.controlPlayerId)
      if (player === undefined) continue
      const classification =
        (options.unitClass !== undefined && Object.hasOwn(options.unitClass, event.unitTypeName)
          ? options.unitClass[event.unitTypeName]
          : undefined) ?? (WORKER_TYPES.has(event.unitTypeName) ? 'worker' : undefined)
      player.unitsProduced += 1
      if (classification === 'worker') player.workersProduced += 1
      else if (classification === 'army') player.armyProduced += 1
      else if (classification === 'building') player.buildingsProduced += 1
      const includeInBuildOrder =
        (options.includeWorkers === true || classification !== 'worker') &&
        classification !== 'other'
      if (includeInBuildOrder && player.buildOrder.length < buildOrderLimit)
        player.buildOrder.push({
          gameloop: event.gameloop,
          time: timeLabel(event.gameloop),
          name: event.unitTypeName,
          supply: supplies.get(event.controlPlayerId) ?? 0,
        })
    } else if (event.event === 'UnitDied') {
      const owner = owners.get(event.unitTag)
      const type = types.get(event.unitTag)
      const cost =
        type !== undefined &&
        options.unitCost !== undefined &&
        Object.hasOwn(options.unitCost, type)
          ? options.unitCost[type]
          : undefined
      const loser = players.get(owner)
      if (loser !== undefined) {
        loser.unitsLost += 1
        addCost(loser, 'resourcesLost', cost)
        deaths.push({ gameloop: event.gameloop, playerId: owner })
      }
      if (
        event.killerPlayerId !== undefined &&
        event.killerPlayerId !== 0 &&
        event.killerPlayerId !== owner
      ) {
        const killer = players.get(event.killerPlayerId)
        if (killer !== undefined) {
          killer.unitsKilled += 1
          addCost(killer, 'resourcesKilled', cost)
        }
      }
    }
  }
  flush()
  for (const [playerId, stats] of finalStats) {
    const player = players.get(playerId)
    if (player !== undefined) player.finalStats = stats
  }
  for (const [playerId, aggregate] of economy) {
    const player = players.get(playerId)
    if (player === undefined || aggregate.samples === 0) continue
    player.sq = Math.round(
      35 *
        (0.00137 * (aggregate.income / aggregate.samples) -
          Math.log(Math.max(1, aggregate.unspent / aggregate.samples))) +
        240,
    )
    player.supplyBlockSeconds = Math.round(aggregate.blockedLoops / REPLAY_LOOPS_PER_SECOND)
  }
  addGameEventMetrics(gameEvents, players)
  addInitialRatings(initData, players)
  const durationGameloops = header.elapsedGameLoops || trackerEvents.at(-1)?.gameloop || 0
  const winner = [...players.values()].find(player => player.result === 1)?.playerId
  return {
    map: details.title,
    durationGameloops,
    durationSeconds: Math.round(durationGameloops / REPLAY_LOOPS_PER_SECOND),
    ...(winner === undefined ? {} : { winner }),
    players: [...players.values()],
    timeline,
    chat: chatLines(messageEvents),
    engagements: clusterEngagements(deaths),
  }
}

export { REPLAY_LOOPS_PER_SECOND }
