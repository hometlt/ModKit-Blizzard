import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@modkit/core'
import { RUNTIME_SESSION_CONTRACT } from '@modkit/sdk/runtime'

export const SC2_PLAYABLE_RUNTIME_ID = 'blizzard.starcraft2.playable-subset-v1'
export const SC2_PLAYABLE_RUNTIME_PROFILE = 'modkit.sc2/playable-subset-v1'
export const SC2_PLAYABLE_STATE_SCHEMA = 'modkit.sc2/playable-subset-state'
export const SC2_PLAYABLE_OFFER_ID = 'sc2-playable-subset-v1'

const STATE_SCHEMA_VERSION = 1
const COMMAND_ENTRYPOINT = 'sc2.simulation.issue-command'
const PROVIDER_ID = 'blizzard/sc2-runtime-provider'
const OFFERS = Object.freeze(['step', 'events', 'snapshot', 'restore', 'state-hash'])
const NO_DIAGNOSTICS = Object.freeze([])
const ZERO_USAGE = Object.freeze({ wallTimeMs: 0, ticks: 0, memoryBytes: 0 })
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_EVENTS = 4_096
const MAX_COMMANDS = 4_096
const UNIT_FIELDS = Object.freeze(['LifeMax', 'LifeStart', 'Speed', 'Food'])

const recordOf = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
const safeNonNegative = value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const finite = value => typeof value === 'number' && Number.isFinite(value)
const cloneJson = value => JSON.parse(JSON.stringify(value))
const canonicalBytes = value => encoder.encode(canonicalJsonStringify(value))
const digestOf = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function exactKeys(value, keys) {
  const record = recordOf(value)
  return (
    record !== undefined &&
    Object.keys(record).length === keys.length &&
    keys.every(key => key in record)
  )
}

function diagnostic(code, message) {
  return Object.freeze({ severity: 'warning', code, message })
}

function refuse(reason, code = reason) {
  return Object.freeze({
    outcome: 'refused',
    reason,
    diagnostics: Object.freeze([
      diagnostic(`sc2-runtime.playable/${code}`, `runtime operation refused: ${reason}`),
    ]),
  })
}

function executionRefusal(reason, code, message) {
  return Object.freeze({
    state: 'refused',
    reason,
    message,
    usage: ZERO_USAGE,
    diagnostics: Object.freeze([diagnostic(code, message)]),
  })
}

function budgetRefusal(reason, label, limit, requested) {
  const message = `${label} budget exceeded: requested ${requested}, limit ${limit}`
  return Object.freeze({
    state: 'refused',
    reason,
    message,
    limit,
    requested,
    usage: ZERO_USAGE,
    diagnostics: Object.freeze([diagnostic(`sc2-runtime.playable/${reason}`, message)]),
  })
}

function parseField(value, field, defaultValue) {
  if (value === undefined) return defaultValue
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed))
    throw new TypeError(`SC2 playable catalog field ${field} is not finite`)
  return parsed
}

function parseDefinition(input) {
  let value
  try {
    value = JSON.parse(decoder.decode(input.bytes))
  } catch (error) {
    throw new TypeError('SC2 playable definition is not canonical UTF-8 JSON', { cause: error })
  }
  if (
    !exactKeys(value, ['schemaVersion', 'profile', 'tickRate', 'randomSeed', 'catalog']) ||
    value.schemaVersion !== 1 ||
    value.profile !== SC2_PLAYABLE_RUNTIME_PROFILE ||
    value.tickRate !== 16 ||
    !safeNonNegative(value.randomSeed)
  ) {
    throw new TypeError('SC2 playable definition has an unsupported profile or state shape')
  }
  const catalog = recordOf(value.catalog)
  if (catalog === undefined || Object.keys(catalog).length === 0) {
    throw new TypeError('SC2 playable definition requires at least one Unit catalog entry')
  }
  const parsedCatalog = {}
  for (const [key, rawFields] of Object.entries(catalog).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!key.startsWith('Unit/') || key.length <= 'Unit/'.length) {
      throw new TypeError(`SC2 playable catalog key is outside the Unit subset: ${key}`)
    }
    const fields = recordOf(rawFields)
    if (fields === undefined || !Object.keys(fields).every(field => UNIT_FIELDS.includes(field))) {
      throw new TypeError(`SC2 playable Unit entry ${key} contains an unsupported field`)
    }
    const lifeMax = Math.max(0, parseField(fields.LifeMax, 'LifeMax', 0))
    const lifeStart = Math.max(
      0,
      Math.min(parseField(fields.LifeStart, 'LifeStart', lifeMax), lifeMax),
    )
    parsedCatalog[key.slice('Unit/'.length)] = Object.freeze({
      lifeMax,
      lifeStart,
      speed: parseField(fields.Speed, 'Speed', 0),
      food: parseField(fields.Food, 'Food', 0),
    })
  }
  return Object.freeze({
    tickRate: value.tickRate,
    randomSeed: value.randomSeed,
    catalog: Object.freeze(parsedCatalog),
  })
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function parseIssuedCommand(argument, state) {
  const record = recordOf(argument)
  if (
    record === undefined ||
    !Object.keys(record).every(key => ['player', 'seq', 'atTick', 'command'].includes(key)) ||
    !Number.isSafeInteger(record.player) ||
    (record.seq !== undefined && !safeNonNegative(record.seq)) ||
    (record.atTick !== undefined && !safeNonNegative(record.atTick))
  ) {
    throw new TypeError('SC2 playable command envelope is malformed')
  }
  const command = recordOf(record.command)
  if (command === undefined || !nonEmptyString(command.kind)) {
    throw new TypeError('SC2 playable command is malformed')
  }
  let parsed
  if (command.kind === 'spawn') {
    if (
      !exactKeys(command, ['kind', 'unitType', 'owner', 'x', 'y']) ||
      !nonEmptyString(command.unitType) ||
      !safeNonNegative(command.owner) ||
      !finite(command.x) ||
      !finite(command.y)
    ) {
      throw new TypeError('SC2 playable spawn command is malformed')
    }
    parsed = {
      kind: 'spawn',
      unitType: command.unitType,
      owner: command.owner,
      x: command.x,
      y: command.y,
    }
  } else if (command.kind === 'move') {
    if (
      !exactKeys(command, ['kind', 'unitIds', 'x', 'y']) ||
      !Array.isArray(command.unitIds) ||
      command.unitIds.length === 0 ||
      !command.unitIds.every(nonEmptyString) ||
      !finite(command.x) ||
      !finite(command.y)
    ) {
      throw new TypeError('SC2 playable move command is malformed')
    }
    parsed = { kind: 'move', unitIds: [...command.unitIds], x: command.x, y: command.y }
  } else if (command.kind === 'stop') {
    if (
      !exactKeys(command, ['kind', 'unitIds']) ||
      !Array.isArray(command.unitIds) ||
      command.unitIds.length === 0 ||
      !command.unitIds.every(nonEmptyString)
    ) {
      throw new TypeError('SC2 playable stop command is malformed')
    }
    parsed = { kind: 'stop', unitIds: [...command.unitIds] }
  } else {
    throw new TypeError(`SC2 playable command kind is unavailable: ${command.kind}`)
  }
  const seq = record.seq ?? state.nextLocalSequence
  return Object.freeze({
    tick: Math.max(state.tick, record.atTick ?? state.tick),
    player: record.player,
    seq,
    command: Object.freeze(parsed),
    nextLocalSequence: record.seq === undefined ? seq + 1 : state.nextLocalSequence,
  })
}

function commandOrder(left, right) {
  return left.tick - right.tick || left.player - right.player || left.seq - right.seq
}

function buildUnit(id, command, fields) {
  return {
    id,
    unitType: command.unitType,
    owner: command.owner,
    alive: true,
    x: command.x,
    y: command.y,
    life: { current: fields.lifeStart, max: fields.lifeMax },
    speed: fields.speed,
    food: fields.food,
    orderQueue: [],
  }
}

function applyCommand(state, issued, catalog, diagnostics) {
  const { command, player } = issued
  if (command.kind === 'spawn') {
    const fields = catalog[command.unitType]
    if (fields === undefined) {
      diagnostics.push(
        diagnostic('sc2-runtime.playable/unknown-unit-type', `Unit/${command.unitType} is absent`),
      )
      return
    }
    const id = `unit${state.nextId}`
    state.nextId += 1
    state.units[id] = buildUnit(id, command, fields)
    return
  }
  for (const unitId of command.unitIds) {
    const unit = state.units[unitId]
    if (unit === undefined || !unit.alive || (player >= 0 && unit.owner !== player)) {
      diagnostics.push(
        diagnostic(
          'sc2-runtime.playable/command-dropped',
          `${command.kind} rejected for ${unitId}`,
        ),
      )
      continue
    }
    unit.orderQueue = command.kind === 'move' ? [{ kind: 'move', x: command.x, y: command.y }] : []
  }
}

function moveUnits(state, emitted) {
  const distancePerTick = 1 / state.tickRate
  for (const unit of Object.values(state.units)) {
    if (!unit.alive) continue
    const order = unit.orderQueue[0]
    if (order?.kind !== 'move') continue
    const travel = unit.speed * distancePerTick
    if (travel <= 0) {
      unit.orderQueue.shift()
      continue
    }
    const dx = order.x - unit.x
    const dy = order.y - unit.y
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared <= travel * travel) {
      unit.x = order.x
      unit.y = order.y
      unit.orderQueue.shift()
      emitted.push({ type: 'SimUnitArrived', payload: { unit: unit.id, x: unit.x, y: unit.y } })
      continue
    }
    if (distanceSquared > 0) {
      const distance = Math.sqrt(distanceSquared)
      const boundedTravel = Math.min(travel, distance)
      unit.x += (dx / distance) * boundedTravel
      unit.y += (dy / distance) * boundedTravel
    }
  }
}

function stepOnce(state, catalog, diagnostics) {
  const due = []
  const pending = []
  for (const command of state.commands) (command.tick <= state.tick ? due : pending).push(command)
  state.commands = pending
  for (const command of due.sort(commandOrder)) applyCommand(state, command, catalog, diagnostics)
  state.time += 1 / state.tickRate
  const emitted = []
  moveUnits(state, emitted)
  state.tick += 1
  for (const event of emitted) {
    state.sequence += 1
    state.events.push({
      sequence: state.sequence,
      tick: state.tick,
      kind: event.type,
      data: event.payload,
    })
  }
}

function validStoredCommand(value) {
  if (
    !exactKeys(value, ['tick', 'player', 'seq', 'command']) ||
    !safeNonNegative(value.tick) ||
    !Number.isSafeInteger(value.player) ||
    !safeNonNegative(value.seq)
  ) {
    return false
  }
  try {
    const parsed = parseIssuedCommand(
      { player: value.player, seq: value.seq, atTick: value.tick, command: value.command },
      { tick: 0, nextLocalSequence: 0 },
    )
    return (
      parsed.tick === value.tick &&
      canonicalJsonStringify(parsed.command) === canonicalJsonStringify(value.command)
    )
  } catch {
    return false
  }
}

function validEvent(event, index, nextId) {
  if (
    recordOf(event) === undefined ||
    event.sequence !== index + 1 ||
    !safeNonNegative(event.tick) ||
    typeof event.kind !== 'string'
  ) {
    return false
  }
  if (index === 0) return event.kind === 'sc2.definition.loaded' && event.tick === 0
  return (
    exactKeys(event, ['sequence', 'tick', 'kind', 'data']) &&
    event.kind === 'SimUnitArrived' &&
    exactKeys(event.data, ['unit', 'x', 'y']) &&
    /^unit[1-9][0-9]*$/u.test(event.data.unit) &&
    Number(event.data.unit.slice('unit'.length)) < nextId &&
    finite(event.data.x) &&
    finite(event.data.y)
  )
}

function validState(value, definitionDigest, budget, inputEvent, catalog) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'profile',
      'definitionDigest',
      'tickRate',
      'tick',
      'time',
      'randomSeed',
      'nextId',
      'nextLocalSequence',
      'executions',
      'reservedMemory',
      'sequence',
      'commands',
      'units',
      'events',
    ]) ||
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    value.profile !== SC2_PLAYABLE_RUNTIME_PROFILE ||
    value.definitionDigest !== definitionDigest ||
    value.tickRate !== 16 ||
    !safeNonNegative(value.tick) ||
    value.tick > budget.maxTicks ||
    !finite(value.time) ||
    value.time !== value.tick / value.tickRate ||
    !safeNonNegative(value.randomSeed) ||
    !safeNonNegative(value.nextId) ||
    !safeNonNegative(value.nextLocalSequence) ||
    !safeNonNegative(value.executions) ||
    !safeNonNegative(value.reservedMemory) ||
    !safeNonNegative(value.sequence) ||
    !Array.isArray(value.commands) ||
    value.commands.length > MAX_COMMANDS ||
    recordOf(value.units) === undefined ||
    !Array.isArray(value.events) ||
    value.events.length !== value.sequence ||
    value.events.length > MAX_EVENTS
  ) {
    return false
  }
  if (
    !value.commands.every(validStoredCommand) ||
    !value.events.every((event, index) => validEvent(event, index, value.nextId)) ||
    canonicalJsonStringify(value.events[0]) !== canonicalJsonStringify(inputEvent)
  ) {
    return false
  }
  const unitEntries = Object.entries(value.units)
  if (!unitEntries.every(([unitId]) => /^unit[1-9][0-9]*$/u.test(unitId))) return false
  unitEntries.sort(
    ([left], [right]) => Number(left.slice('unit'.length)) - Number(right.slice('unit'.length)),
  )
  if (value.nextId !== unitEntries.length + 1) return false
  for (const [index, [unitId, unit]] of unitEntries.entries()) {
    const unitRecord = recordOf(unit)
    const fields = unitRecord === undefined ? undefined : catalog[unitRecord.unitType]
    if (
      unitId !== `unit${index + 1}` ||
      fields === undefined ||
      !exactKeys(unit, [
        'id',
        'unitType',
        'owner',
        'alive',
        'x',
        'y',
        'life',
        'speed',
        'food',
        'orderQueue',
      ]) ||
      !nonEmptyString(unit.id) ||
      unit.id !== unitId ||
      !nonEmptyString(unit.unitType) ||
      !safeNonNegative(unit.owner) ||
      typeof unit.alive !== 'boolean' ||
      !finite(unit.x) ||
      !finite(unit.y) ||
      !finite(unit.speed) ||
      !finite(unit.food) ||
      !Array.isArray(unit.orderQueue) ||
      !exactKeys(unit.life, ['current', 'max']) ||
      !finite(unit.life.current) ||
      !finite(unit.life.max) ||
      unit.life.max !== fields.lifeMax ||
      unit.life.current < 0 ||
      unit.life.current > unit.life.max ||
      unit.speed !== fields.speed ||
      unit.food !== fields.food ||
      unit.orderQueue.length > 1 ||
      !unit.orderQueue.every(
        order =>
          exactKeys(order, ['kind', 'x', 'y']) &&
          order.kind === 'move' &&
          finite(order.x) &&
          finite(order.y),
      )
    ) {
      return false
    }
  }
  return true
}

/**
 * First Block 19 slice. Differential scope is intentionally exact and small: tick/time/seed,
 * pending command envelopes, and each unit's identity/owner/alive/position/life/speed/food/order.
 * The event differential covers only ordered `SimUnitArrived` tick/type/payload observations.
 */
export function createPlayableSession(request, loaded, budget) {
  request.signal?.throwIfAborted()
  if (typeof request.sessionId !== 'string' || request.sessionId.trim() === '') {
    throw new TypeError('SC2 playable runtime requires a non-empty session id')
  }
  const definitions = loaded.filter(input => input.kind === 'definition')
  if (definitions.length !== 1 || loaded.length !== 1) {
    throw new TypeError('SC2 playable runtime requires exactly one catalog definition input')
  }
  const definitionInput = definitions[0]
  const definition = parseDefinition(definitionInput)
  const definitionDigest = definitionInput.digest
  const inputEvent = Object.freeze({
    sequence: 1,
    tick: 0,
    kind: 'sc2.definition.loaded',
    data: Object.freeze({
      logicalId: definitionInput.logicalId,
      revision: definitionInput.revision,
      contentDigest: definitionDigest,
      catalogBacked: true,
      portableUvArtifact: false,
    }),
  })
  let state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    profile: SC2_PLAYABLE_RUNTIME_PROFILE,
    definitionDigest,
    tickRate: definition.tickRate,
    tick: 0,
    time: 0,
    randomSeed: definition.randomSeed,
    nextId: 1,
    nextLocalSequence: 0,
    executions: 0,
    reservedMemory: 0,
    sequence: 1,
    commands: [],
    units: {},
    events: [inputEvent],
  }
  let disposed = false
  let executing = false

  const stateBytes = candidate => canonicalBytes(candidate ?? state)
  const memoryOf = candidate =>
    definitionInput.bytes.byteLength + stateBytes(candidate).byteLength + candidate.reservedMemory
  const status = () =>
    Object.freeze({
      state: disposed ? 'disposed' : executing ? 'executing' : 'ready',
      executions: state.executions,
      ticks: state.tick,
      memoryBytes: disposed ? 0 : memoryOf(state),
    })
  const available = signal =>
    disposed
      ? refuse('session-disposed')
      : signal?.aborted === true
        ? refuse('cancelled')
        : undefined

  if (memoryOf(state) > budget.maxMemoryBytes) {
    throw new RangeError(`SC2 playable state exceeds memory budget ${budget.maxMemoryBytes}`)
  }

  const session = Object.freeze({
    contract: RUNTIME_SESSION_CONTRACT,
    sessionId: request.sessionId,
    providerId: PROVIDER_ID,
    budget,
    offers: OFFERS,
    async execute(execution) {
      if (execution.signal?.aborted === true) {
        return executionRefusal(
          'cancelled',
          'sc2-runtime.playable/cancelled',
          'runtime request was cancelled',
        )
      }
      if (disposed) {
        return executionRefusal(
          'session-disposed',
          'sc2-runtime.playable/session-disposed',
          'runtime session is disposed',
        )
      }
      if (executing) {
        return executionRefusal(
          'unsupported-runtime-subset',
          'sc2-runtime.playable/reentrant',
          'runtime session is already executing',
        )
      }
      if (execution.entrypoint !== COMMAND_ENTRYPOINT) {
        return executionRefusal(
          'entrypoint-unavailable',
          'sc2-runtime.playable/entrypoint-unavailable',
          `supported entrypoint is ${COMMAND_ENTRYPOINT}`,
        )
      }
      const resources = execution.resources
      if (
        recordOf(resources) === undefined ||
        !safeNonNegative(resources.wallTimeMs) ||
        !safeNonNegative(resources.ticks) ||
        !safeNonNegative(resources.memoryBytes)
      ) {
        throw new TypeError('SC2 playable execution resources are malformed')
      }
      if (resources.wallTimeMs > budget.maxWallTimeMs) {
        return budgetRefusal(
          'max-wall-time-ms',
          'wall time',
          budget.maxWallTimeMs,
          resources.wallTimeMs,
        )
      }
      if (resources.ticks !== 0) {
        return executionRefusal(
          'unsupported-runtime-subset',
          'sc2-runtime.playable/implicit-ticks-unavailable',
          'commands do not advance simulation; use session.step()',
        )
      }
      if (!Array.isArray(execution.arguments) || execution.arguments.length !== 1) {
        return executionRefusal(
          'unsupported-runtime-subset',
          'sc2-runtime.playable/arguments-unavailable',
          'issue-command requires one command envelope',
        )
      }
      let issued
      try {
        issued = parseIssuedCommand(execution.arguments[0], state)
      } catch (error) {
        return executionRefusal(
          'unsupported-runtime-subset',
          'sc2-runtime.playable/command-unavailable',
          error instanceof Error ? error.message : String(error),
        )
      }
      if (state.commands.length + 1 > MAX_COMMANDS) {
        return budgetRefusal(
          'max-memory-bytes',
          'retained command count',
          MAX_COMMANDS,
          state.commands.length + 1,
        )
      }
      executing = true
      try {
        execution.signal?.throwIfAborted()
        const projected = cloneJson(state)
        projected.commands.push({
          tick: issued.tick,
          player: issued.player,
          seq: issued.seq,
          command: issued.command,
        })
        projected.nextLocalSequence = issued.nextLocalSequence
        projected.executions += 1
        projected.reservedMemory += resources.memoryBytes
        const requestedMemory = memoryOf(projected)
        if (requestedMemory > budget.maxMemoryBytes) {
          return budgetRefusal('max-memory-bytes', 'memory', budget.maxMemoryBytes, requestedMemory)
        }
        state = projected
        return Object.freeze({
          state: 'completed',
          value: Object.freeze({ tick: issued.tick, player: issued.player, seq: issued.seq }),
          usage: Object.freeze({ ...resources }),
          diagnostics: NO_DIAGNOSTICS,
        })
      } catch (error) {
        if (execution.signal?.aborted === true) {
          return executionRefusal(
            'cancelled',
            'sc2-runtime.playable/cancelled',
            'runtime request was cancelled',
          )
        }
        throw error
      } finally {
        executing = false
      }
    },
    async status() {
      return status()
    },
    async identity() {
      return Object.freeze({
        contentDigest: digestOf(stateBytes()),
        schemaId: SC2_PLAYABLE_STATE_SCHEMA,
        schemaVersion: STATE_SCHEMA_VERSION,
      })
    },
    async step(count, signal) {
      const refused = available(signal)
      if (refused !== undefined) return refused
      if (!safeNonNegative(count) || state.tick + count > budget.maxTicks) {
        return refuse('budget-exceeded')
      }
      const projected = cloneJson(state)
      const diagnostics = []
      try {
        for (let index = 0; index < count; index += 1) {
          signal?.throwIfAborted()
          stepOnce(projected, definition.catalog, diagnostics)
          if (projected.events.length > MAX_EVENTS) return refuse('budget-exceeded')
        }
      } catch (error) {
        if (signal?.aborted === true) return refuse('cancelled')
        throw error
      }
      if (memoryOf(projected) > budget.maxMemoryBytes) return refuse('budget-exceeded')
      state = projected
      return Object.freeze({
        outcome: 'stepped',
        status: status(),
        diagnostics: Object.freeze(diagnostics),
      })
    },
    async *events(afterSequence = 0) {
      if (disposed || !safeNonNegative(afterSequence)) return
      for (const event of state.events) if (event.sequence > afterSequence) yield cloneJson(event)
    },
    async snapshot(signal) {
      const refused = available(signal)
      if (refused !== undefined) return refused
      const bytes = stateBytes()
      if (memoryOf(state) + bytes.byteLength > budget.maxMemoryBytes)
        return refuse('budget-exceeded')
      return Object.freeze({
        outcome: 'captured',
        snapshot: Object.freeze({
          identity: Object.freeze({
            contentDigest: digestOf(bytes),
            schemaId: SC2_PLAYABLE_STATE_SCHEMA,
            schemaVersion: STATE_SCHEMA_VERSION,
          }),
          bytes,
        }),
      })
    },
    async restore(snapshot, signal) {
      const refused = available(signal)
      if (refused !== undefined) return refused
      if (
        snapshot?.identity?.schemaId !== SC2_PLAYABLE_STATE_SCHEMA ||
        snapshot?.identity?.schemaVersion !== STATE_SCHEMA_VERSION
      ) {
        return refuse('schema-mismatch')
      }
      if (!(snapshot.bytes instanceof Uint8Array)) return refuse('digest-mismatch')
      if (memoryOf(state) + snapshot.bytes.byteLength > budget.maxMemoryBytes)
        return refuse('budget-exceeded')
      if (digestOf(snapshot.bytes) !== snapshot.identity.contentDigest)
        return refuse('digest-mismatch')
      let restored
      try {
        restored = JSON.parse(decoder.decode(snapshot.bytes))
      } catch {
        return refuse('digest-mismatch')
      }
      if (
        canonicalJsonStringify(restored) !== decoder.decode(snapshot.bytes) ||
        !validState(restored, definitionDigest, budget, inputEvent, definition.catalog)
      ) {
        return refuse('schema-mismatch')
      }
      if (memoryOf(restored) > budget.maxMemoryBytes) return refuse('budget-exceeded')
      state = cloneJson(restored)
      return Object.freeze({ outcome: 'restored', status: status() })
    },
    async stateHash(signal) {
      const refused = available(signal)
      return refused ?? Object.freeze({ outcome: 'hashed', stateHash: digestOf(stateBytes()) })
    },
  })

  let released = false
  return Object.freeze({
    value: session,
    async release() {
      if (released) return
      released = true
      disposed = true
      state = { ...state, commands: [], units: {}, events: [], reservedMemory: 0 }
    },
  })
}
