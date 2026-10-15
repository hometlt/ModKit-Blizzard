import { createHash } from 'node:crypto'
import { RUNTIME_PROVIDER_CONTRACT, RUNTIME_SESSION_CONTRACT } from '@modkit/sdk/runtime'
import {
  SC2_PLAYABLE_OFFER_ID,
  SC2_PLAYABLE_RUNTIME_ID,
  createPlayableSession,
} from '../../services/playable.js'

export const SC2_BOUNDED_RUNTIME_ID = 'blizzard.starcraft2.galaxy-pure-bounded-v1'
export const SC2_BOUNDED_RUNTIME_PROFILE = 'modkit.sc2/galaxy-pure-bounded-v1'
export const SC2_BOUNDED_STATE_SCHEMA = 'modkit.sc2/galaxy-pure-bounded-state'

const PROVIDER_ID = 'blizzard/sc2-runtime-provider'
const STATE_SCHEMA_VERSION = 1
const OFFERS = Object.freeze(['step', 'events', 'snapshot', 'restore', 'state-hash'])
const ZERO_USAGE = Object.freeze({ wallTimeMs: 0, ticks: 0, memoryBytes: 0 })
const NO_DIAGNOSTICS = Object.freeze([])
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_INPUTS = 64
const MAX_RETAINED_EVENTS = 4_096
const MAX_RETAINED_CALLS = 1_024
const SUPPORTED_RETURN_TYPES = new Set(['void', 'bool', 'int', 'string'])

const recordOf = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
const safeNonNegative = value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const digestOf = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const canonicalBytes = value => encoder.encode(JSON.stringify(value))
const cloneJson = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

function hasExactKeys(value, keys) {
  const record = recordOf(value)
  return (
    record !== undefined &&
    Object.keys(record).length === keys.length &&
    keys.every(key => key in record)
  )
}

function equalBytes(left, right) {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

function boundedJsonValue(value, depth = 0, nodes = { count: 0 }) {
  nodes.count += 1
  if (nodes.count > 10_000 || depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => boundedJsonValue(item, depth + 1, nodes))
  const record = recordOf(value)
  return (
    record !== undefined &&
    Object.values(record).every(item => boundedJsonValue(item, depth + 1, nodes))
  )
}

function diagnostic(severity, code, message) {
  return Object.freeze({ severity, code, message })
}

function refuse(reason, code, message) {
  return Object.freeze({
    state: 'refused',
    reason,
    message,
    usage: ZERO_USAGE,
    diagnostics: Object.freeze([diagnostic('warning', code, message)]),
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
    diagnostics: Object.freeze([diagnostic('warning', `sc2-runtime.bounded/${reason}`, message)]),
  })
}

function abortRefusal(signal) {
  return signal?.aborted === true
    ? refuse('cancelled', 'sc2-runtime.bounded/cancelled', 'runtime request was cancelled')
    : undefined
}

function exactRuntimeBudget(value) {
  const record = recordOf(value)
  const keys = record === undefined ? [] : Object.keys(record)
  if (
    record === undefined ||
    keys.length !== 3 ||
    !keys.every(key => ['maxWallTimeMs', 'maxTicks', 'maxMemoryBytes'].includes(key)) ||
    !safeNonNegative(record.maxWallTimeMs) ||
    !safeNonNegative(record.maxTicks) ||
    !safeNonNegative(record.maxMemoryBytes)
  ) {
    throw new TypeError('SC2 bounded runtime requires an exact non-negative runtime budget')
  }
  return Object.freeze({
    maxWallTimeMs: record.maxWallTimeMs,
    maxTicks: record.maxTicks,
    maxMemoryBytes: record.maxMemoryBytes,
  })
}

function exactExecutionResources(value) {
  const record = recordOf(value)
  const keys = record === undefined ? [] : Object.keys(record)
  if (
    record === undefined ||
    keys.length !== 3 ||
    !keys.every(key => ['wallTimeMs', 'ticks', 'memoryBytes'].includes(key)) ||
    !safeNonNegative(record.wallTimeMs) ||
    !safeNonNegative(record.ticks) ||
    !safeNonNegative(record.memoryBytes)
  ) {
    throw new TypeError(
      'SC2 bounded runtime execution resources must be non-negative safe integers',
    )
  }
  return Object.freeze({
    wallTimeMs: record.wallTimeMs,
    ticks: record.ticks,
    memoryBytes: record.memoryBytes,
  })
}

function lexGalaxy(source) {
  const tokens = []
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (/\s/u.test(character)) continue
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2)
      cursor = newline < 0 ? source.length : newline
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const close = source.indexOf('*/', cursor + 2)
      if (close < 0) throw new TypeError('Galaxy block comment is not terminated')
      cursor = close + 1
      continue
    }
    if (character === '"' || character === "'") {
      const start = cursor
      let closed = false
      for (cursor += 1; cursor < source.length; cursor += 1) {
        if (source[cursor] === '\\') cursor += 1
        else if (source[cursor] === character) {
          closed = true
          break
        }
      }
      if (!closed) throw new TypeError('Galaxy string literal is not terminated')
      tokens.push(Object.freeze({ kind: 'string', value: source.slice(start, cursor + 1) }))
      continue
    }
    const identifier = /^[A-Za-z_]\w*/u.exec(source.slice(cursor))
    if (identifier !== null) {
      tokens.push(Object.freeze({ kind: 'identifier', value: identifier[0] }))
      cursor += identifier[0].length - 1
      continue
    }
    const number = /^\d+/u.exec(source.slice(cursor))
    if (number !== null) {
      tokens.push(Object.freeze({ kind: 'number', value: number[0] }))
      cursor += number[0].length - 1
      continue
    }
    tokens.push(Object.freeze({ kind: 'symbol', value: character }))
  }
  return tokens
}

function closingToken(tokens, start, open, close) {
  let depth = 1
  for (let cursor = start + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].value === open) depth += 1
    else if (tokens[cursor].value === close) {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  throw new TypeError(`Galaxy ${open}${close} pair is not closed`)
}

function parseFunctions(source) {
  const tokens = lexGalaxy(source)
  const functions = new Map()
  let topLevelDepth = 0
  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]
    if (token.value === '{') {
      topLevelDepth += 1
      continue
    }
    if (token.value === '}') {
      topLevelDepth -= 1
      if (topLevelDepth < 0) throw new TypeError('Galaxy braces are unbalanced')
      continue
    }
    if (
      topLevelDepth !== 0 ||
      token.kind !== 'identifier' ||
      tokens[cursor + 1]?.kind !== 'identifier' ||
      tokens[cursor + 2]?.value !== '('
    )
      continue
    const closeParameters = closingToken(tokens, cursor + 2, '(', ')')
    if (tokens[closeParameters + 1]?.value !== '{') continue
    const closeBody = closingToken(tokens, closeParameters + 1, '{', '}')
    const returnType = token.value
    const name = tokens[cursor + 1].value
    const parameterTokens = tokens.slice(cursor + 3, closeParameters)
    const parameters =
      parameterTokens.length === 0
        ? 0
        : 1 + parameterTokens.filter(value => value.value === ',').length
    if (functions.has(name)) throw new TypeError(`duplicate Galaxy function ${name}`)
    functions.set(
      name,
      Object.freeze({
        returnType,
        parameters,
        body: Object.freeze(tokens.slice(closeParameters + 2, closeBody)),
      }),
    )
    cursor = closeBody
  }
  if (topLevelDepth !== 0) throw new TypeError('Galaxy braces are unbalanced')
  return functions
}

function parseLiteral(tokens) {
  if (tokens.length === 1 && tokens[0].kind === 'number') {
    const value = Number(tokens[0].value)
    return value <= 2_147_483_647 ? { state: 'value', value } : { state: 'unsupported' }
  }
  if (tokens.length === 2 && tokens[0].value === '-' && tokens[1].kind === 'number') {
    const magnitude = Number(tokens[1].value)
    return magnitude <= 2_147_483_648
      ? { state: 'value', value: -magnitude }
      : { state: 'unsupported' }
  }
  if (tokens.length === 1 && tokens[0].value === 'true') return { state: 'value', value: true }
  if (tokens.length === 1 && tokens[0].value === 'false') return { state: 'value', value: false }
  if (tokens.length === 1 && tokens[0].value === 'null') return { state: 'value', value: null }
  if (tokens.length === 1 && tokens[0].kind === 'string' && tokens[0].value.startsWith('"')) {
    try {
      return { state: 'value', value: JSON.parse(tokens[0].value) }
    } catch {
      return { state: 'unsupported' }
    }
  }
  if (
    tokens.length === 3 &&
    tokens[0].kind === 'identifier' &&
    tokens[1].value === '(' &&
    tokens[2].value === ')'
  )
    return { state: 'call', name: tokens[0].value }
  return { state: 'unsupported' }
}

function parseBody(tokens) {
  if (tokens.length === 0) return { state: 'supported', calls: [], returnExpression: undefined }
  const statements = []
  let start = 0
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== ';') continue
    if (index > start) statements.push(tokens.slice(start, index))
    start = index + 1
  }
  if (start !== tokens.length) return { state: 'unsupported' }
  const calls = []
  let returnExpression
  for (const [index, statement] of statements.entries()) {
    if (statement[0]?.value === 'return') {
      if (index !== statements.length - 1 || returnExpression !== undefined)
        return { state: 'unsupported' }
      if (statement.length === 1) {
        returnExpression = { state: 'value', value: undefined }
        continue
      }
      returnExpression = parseLiteral(statement.slice(1))
      if (returnExpression.state === 'unsupported') return { state: 'unsupported' }
      continue
    }
    if (
      statement.length !== 3 ||
      statement[0].kind !== 'identifier' ||
      statement[1].value !== '(' ||
      statement[2].value !== ')'
    )
      return { state: 'unsupported' }
    calls.push(statement[0].value)
  }
  return { state: 'supported', calls, returnExpression }
}

function literalMatchesReturnType(returnType, expression) {
  if (expression === undefined) return returnType === 'void'
  if (expression.state === 'call') return true
  const value = expression.value
  if (returnType === 'void') return value === undefined
  if (returnType === 'int') return Number.isInteger(value)
  if (returnType === 'bool') return typeof value === 'boolean'
  return returnType === 'string' && (typeof value === 'string' || value === null)
}

function analyzeEntrypoint(functions, entrypoint) {
  const root = functions.get(entrypoint)
  if (root === undefined) return { state: 'missing' }
  const visiting = new Set()
  const parsed = new Map()
  const natives = new Set()
  const visit = name => {
    const declaration = functions.get(name)
    if (declaration === undefined) {
      natives.add(name)
      return
    }
    if (declaration.parameters !== 0 || !SUPPORTED_RETURN_TYPES.has(declaration.returnType)) {
      return { state: 'unsupported', name }
    }
    if (visiting.has(name)) return { state: 'unsupported', name }
    if (parsed.has(name)) return
    for (let index = 0; index < declaration.body.length - 1; index += 1) {
      if (
        declaration.body[index].kind === 'identifier' &&
        declaration.body[index + 1].value === '(' &&
        !functions.has(declaration.body[index].value)
      ) {
        const close = closingToken(declaration.body, index + 1, '(', ')')
        if (declaration.body[close + 1]?.value !== '{') {
          natives.add(declaration.body[index].value)
        }
      }
    }
    const body = parseBody(declaration.body)
    if (body.state !== 'supported') return { state: 'unsupported', name }
    if (!literalMatchesReturnType(declaration.returnType, body.returnExpression)) {
      return { state: 'unsupported', name }
    }
    parsed.set(name, Object.freeze({ ...body, returnType: declaration.returnType }))
    visiting.add(name)
    for (const called of [
      ...body.calls,
      ...(body.returnExpression?.state === 'call' ? [body.returnExpression.name] : []),
    ]) {
      const issue = visit(called)
      if (issue !== undefined) return issue
    }
    if (
      body.returnExpression?.state === 'call' &&
      functions.get(body.returnExpression.name)?.returnType !== declaration.returnType
    )
      return { state: 'unsupported', name }
    visiting.delete(name)
  }
  const issue = visit(entrypoint)
  if (natives.size > 0) return { state: 'native', names: [...natives].sort() }
  if (issue !== undefined) return issue
  return { state: 'supported', parsed }
}

function evaluate(functions, entrypoint) {
  const body = functions.get(entrypoint)
  for (const called of body.calls) evaluate(functions, called)
  if (body.returnExpression === undefined) return undefined
  return body.returnExpression.state === 'call'
    ? evaluate(functions, body.returnExpression.name)
    : body.returnExpression.value
}

async function readInput(input, resources, signal, cumulative, memoryLimit) {
  if (
    recordOf(input) === undefined ||
    typeof input.id !== 'string' ||
    typeof input.logicalId !== 'string' ||
    !['source', 'trigger', 'definition'].includes(input.kind) ||
    !Array.isArray(input.scopes) ||
    !safeNonNegative(input.maxBytes)
  ) {
    throw new TypeError('SC2 runtime logical input is malformed')
  }
  const resolution = await resources.resolve(
    {
      id: input.id,
      logicalId: input.logicalId,
      role: 'buffer',
      scopes: input.scopes,
    },
    signal,
  )
  if (resolution.state !== 'resolved') {
    throw new TypeError(`SC2 runtime input ${input.logicalId} is ${resolution.reason}`)
  }
  try {
    const source = resolution.lease.value
    if (source.kind !== 'bytes')
      throw new TypeError(`SC2 runtime input ${input.logicalId} is not bytes`)
    if (source.size !== undefined && source.size > BigInt(input.maxBytes)) {
      throw new RangeError(`SC2 runtime input ${input.logicalId} exceeds ${input.maxBytes} bytes`)
    }
    if (source.size !== undefined && BigInt(cumulative.bytes) + source.size > BigInt(memoryLimit)) {
      throw new RangeError(`SC2 runtime inputs exceed memory budget ${memoryLimit}`)
    }
    const chunks = []
    let total = 0
    for await (const chunk of source.stream(undefined, signal)) {
      total += chunk.byteLength
      if (total > input.maxBytes)
        throw new RangeError(`SC2 runtime input ${input.logicalId} exceeds ${input.maxBytes} bytes`)
      if (cumulative.bytes + total > memoryLimit)
        throw new RangeError(`SC2 runtime inputs exceed memory budget ${memoryLimit}`)
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    cumulative.bytes += total
    return Object.freeze({
      id: input.id,
      kind: input.kind,
      logicalId: input.logicalId,
      revision: String(resolution.revision),
      bytes,
      digest: digestOf(bytes),
    })
  } finally {
    await resolution.lease.release()
  }
}

async function loadInvocation(request, budget) {
  const invocation = recordOf(request.providerInvocation)
  if (
    invocation === undefined ||
    !Array.isArray(invocation.inputs) ||
    recordOf(invocation.resources) === undefined ||
    typeof invocation.resources.resolve !== 'function'
  ) {
    throw new TypeError('SC2 bounded runtime requires a host ResourceSession invocation context')
  }
  if (invocation.inputs.length === 0 || invocation.inputs.length > MAX_INPUTS) {
    throw new RangeError(`SC2 bounded runtime accepts between 1 and ${MAX_INPUTS} logical inputs`)
  }
  const ids = new Set()
  const logicalInputs = new Set()
  for (const input of invocation.inputs) {
    const record = recordOf(input)
    const key = `${record?.kind ?? ''}\u0000${record?.logicalId ?? ''}`
    if (typeof record?.id !== 'string' || ids.has(record.id) || logicalInputs.has(key)) {
      throw new TypeError(
        'SC2 bounded runtime logical input ids and kind/logicalId pairs must be unique',
      )
    }
    ids.add(record.id)
    logicalInputs.add(key)
  }
  const loaded = []
  const cumulative = { bytes: 0 }
  try {
    for (const input of invocation.inputs) {
      request.signal?.throwIfAborted()
      loaded.push(
        await readInput(
          input,
          invocation.resources,
          request.signal,
          cumulative,
          budget.maxMemoryBytes,
        ),
      )
    }
    return Object.freeze(loaded)
  } catch (error) {
    // Each resolved input lease is released in readInput's finally; the host still owns the port.
    throw error
  }
}

function createSession(request, loaded, budget) {
  request.signal?.throwIfAborted()
  if (typeof request.sessionId !== 'string' || request.sessionId.trim() === '') {
    throw new TypeError('SC2 bounded runtime requires a non-empty session id')
  }
  const sourceInputs = loaded.filter(input => input.kind === 'source')
  if (sourceInputs.length === 0)
    throw new TypeError('SC2 bounded runtime requires Galaxy source input')
  const retainedBytes = loaded.reduce((total, input) => total + input.bytes.byteLength, 0)
  if (retainedBytes > budget.maxMemoryBytes) {
    throw new RangeError(`SC2 runtime inputs exceed memory budget ${budget.maxMemoryBytes}`)
  }
  const sourceText = sourceInputs.map(input => decoder.decode(input.bytes)).join('\n')
  const functions = parseFunctions(sourceText)
  if (functions.size === 0) throw new TypeError('SC2 runtime input contains no Galaxy functions')
  const programBytes =
    retainedBytes +
    encoder.encode(sourceText).byteLength +
    canonicalBytes(
      [...functions.entries()].map(([name, declaration]) => ({
        name,
        returnType: declaration.returnType,
        parameters: declaration.parameters,
        body: declaration.body,
      })),
    ).byteLength
  const sourceDigest = digestOf(
    canonicalBytes(
      sourceInputs.map(input => ({ logicalId: input.logicalId, digest: input.digest })),
    ),
  )
  const inputDescriptors = Object.freeze(
    loaded.map(input =>
      Object.freeze({
        kind: input.kind,
        logicalId: input.logicalId,
        digest: input.digest,
      }),
    ),
  )
  const inputEvents = loaded.map((input, index) =>
    Object.freeze({
      sequence: index + 1,
      tick: 0,
      kind: `sc2.${input.kind}.loaded`,
      data: Object.freeze({
        logicalId: input.logicalId,
        revision: input.revision,
        contentDigest: input.digest,
        nativeAuthority: true,
        portableUvArtifact: false,
        ...(input.kind === 'trigger' ? { lowering: 'unavailable' } : {}),
      }),
    }),
  )
  let disposed = false
  let executing = false
  let executions = 0
  let ticks = 0
  let reservedMemory = 0
  let sequence = inputEvents.length
  let log = [...inputEvents]
  let calls = []

  const stateRecord = (values = {}) => ({
    schemaVersion: STATE_SCHEMA_VERSION,
    profile: SC2_BOUNDED_RUNTIME_PROFILE,
    sourceDigest,
    inputs: inputDescriptors,
    executions: values.executions ?? executions,
    ticks: values.ticks ?? ticks,
    reservedMemory: values.reservedMemory ?? reservedMemory,
    sequence: values.sequence ?? sequence,
    calls: values.calls ?? calls,
    events: values.events ?? log,
  })
  const memoryOf = state => programBytes + state.reservedMemory + canonicalBytes(state).byteLength
  const currentState = () => stateRecord()
  const currentMemory = () => (disposed ? 0 : memoryOf(currentState()))
  const status = () =>
    Object.freeze({
      state: disposed ? 'disposed' : executing ? 'executing' : 'ready',
      executions,
      ticks,
      memoryBytes: currentMemory(),
    })
  const stateBytes = () => canonicalBytes(currentState())
  const v2Refusal = reason =>
    Object.freeze({
      outcome: 'refused',
      reason,
      diagnostics: Object.freeze([
        diagnostic(
          'warning',
          `sc2-runtime.bounded/${reason}`,
          `runtime operation refused: ${reason}`,
        ),
      ]),
    })
  const available = signal =>
    disposed
      ? v2Refusal('session-disposed')
      : signal?.aborted === true
        ? v2Refusal('cancelled')
        : undefined

  const restoredStateIsValid = restored => {
    if (
      !hasExactKeys(restored, [
        'schemaVersion',
        'profile',
        'sourceDigest',
        'inputs',
        'executions',
        'ticks',
        'reservedMemory',
        'sequence',
        'calls',
        'events',
      ]) ||
      restored.schemaVersion !== STATE_SCHEMA_VERSION ||
      restored.profile !== SC2_BOUNDED_RUNTIME_PROFILE ||
      restored.sourceDigest !== sourceDigest ||
      JSON.stringify(restored.inputs) !== JSON.stringify(inputDescriptors) ||
      !safeNonNegative(restored.executions) ||
      !safeNonNegative(restored.ticks) ||
      !safeNonNegative(restored.reservedMemory) ||
      !safeNonNegative(restored.sequence) ||
      restored.ticks > budget.maxTicks ||
      !Array.isArray(restored.calls) ||
      restored.calls.length !== restored.executions ||
      restored.calls.length > MAX_RETAINED_CALLS ||
      !Array.isArray(restored.events) ||
      restored.events.length !== restored.sequence ||
      restored.events.length > MAX_RETAINED_EVENTS
    )
      return false
    for (const call of restored.calls) {
      if (
        !hasExactKeys(call, ['entrypoint', 'value', 'tickDelta', 'memoryDelta']) ||
        typeof call.entrypoint !== 'string' ||
        call.entrypoint.trim() === '' ||
        !safeNonNegative(call.tickDelta) ||
        !safeNonNegative(call.memoryDelta) ||
        !boundedJsonValue(call.value)
      )
        return false
      const analysis = analyzeEntrypoint(functions, call.entrypoint)
      if (analysis.state !== 'supported') return false
      const expected = cloneJson(evaluate(analysis.parsed, call.entrypoint)) ?? null
      if (JSON.stringify(call.value) !== JSON.stringify(expected)) return false
    }
    if (
      JSON.stringify(restored.events.slice(0, inputEvents.length)) !== JSON.stringify(inputEvents)
    )
      return false
    let executed = 0
    let reachableTick = 0
    let reachableMemory = 0
    for (const [index, event] of restored.events.entries()) {
      if (
        !safeNonNegative(event?.sequence) ||
        event.sequence !== index + 1 ||
        !safeNonNegative(event.tick) ||
        event.tick > restored.ticks ||
        typeof event.kind !== 'string'
      )
        return false
      if (index < inputEvents.length) continue
      if (event.kind === 'sc2.clock.tick') {
        if (
          !hasExactKeys(event, ['sequence', 'tick', 'kind']) ||
          event.tick !== reachableTick + 1
        ) {
          return false
        }
        reachableTick = event.tick
        continue
      }
      const call = restored.calls[executed]
      if (
        event.kind !== 'sc2.galaxy.executed' ||
        !hasExactKeys(event, ['sequence', 'tick', 'kind', 'data']) ||
        !hasExactKeys(event.data, ['entrypoint', 'profile']) ||
        event.data.profile !== SC2_BOUNDED_RUNTIME_PROFILE ||
        event.data.entrypoint !== call?.entrypoint ||
        event.tick !== reachableTick + call.tickDelta
      )
        return false
      reachableTick = event.tick
      reachableMemory += call.memoryDelta
      executed += 1
    }
    if (executed !== restored.executions) return false
    if (reachableTick !== restored.ticks || reachableMemory !== restored.reservedMemory)
      return false
    return memoryOf(restored) <= budget.maxMemoryBytes
  }

  if (currentMemory() > budget.maxMemoryBytes) {
    throw new RangeError(
      `SC2 runtime retained state exceeds memory budget ${budget.maxMemoryBytes}`,
    )
  }

  const session = Object.freeze({
    contract: RUNTIME_SESSION_CONTRACT,
    sessionId: request.sessionId,
    providerId: PROVIDER_ID,
    budget,
    offers: OFFERS,
    async execute(execution) {
      const cancelled = abortRefusal(execution.signal)
      if (cancelled !== undefined) return cancelled
      if (disposed)
        return refuse(
          'session-disposed',
          'sc2-runtime.bounded/session-disposed',
          'runtime session is disposed',
        )
      if (executing)
        return refuse(
          'unsupported-runtime-subset',
          'sc2-runtime.bounded/reentrant',
          'runtime session is already executing',
        )
      if (typeof execution.entrypoint !== 'string' || execution.entrypoint.trim() === '') {
        return refuse(
          'entrypoint-unavailable',
          'sc2-runtime.bounded/entrypoint-unavailable',
          'runtime entrypoint must be a non-empty Galaxy function name',
        )
      }
      if ((execution.arguments?.length ?? 0) !== 0) {
        return refuse(
          'unsupported-runtime-subset',
          'sc2-runtime.bounded/arguments-unavailable',
          `${SC2_BOUNDED_RUNTIME_PROFILE} accepts only zero-argument entrypoints`,
        )
      }
      const resources = exactExecutionResources(execution.resources)
      if (resources.wallTimeMs > budget.maxWallTimeMs)
        return budgetRefusal(
          'max-wall-time-ms',
          'wall time',
          budget.maxWallTimeMs,
          resources.wallTimeMs,
        )
      const requestedTicks = ticks + resources.ticks
      if (requestedTicks > budget.maxTicks)
        return budgetRefusal('max-ticks', 'tick', budget.maxTicks, requestedTicks)
      const analysis = analyzeEntrypoint(functions, execution.entrypoint)
      if (analysis.state === 'missing') {
        const replacement = ['sign', 'launch', 'playback'].includes(execution.entrypoint)
          ? '; use the official external SC2 tool/client workflow'
          : ''
        return refuse(
          'entrypoint-unavailable',
          'sc2-runtime.bounded/entrypoint-unavailable',
          `Galaxy entrypoint ${execution.entrypoint} is unavailable${replacement}`,
        )
      }
      if (analysis.state === 'native') {
        return refuse(
          'native-unavailable',
          'sc2-runtime.bounded/native-unavailable',
          `Galaxy entrypoint ${execution.entrypoint} reaches unsupported native call(s): ${analysis.names.join(', ')}`,
        )
      }
      if (analysis.state === 'unsupported') {
        return refuse(
          'unsupported-runtime-subset',
          'sc2-runtime.bounded/subset-unavailable',
          `Galaxy function ${analysis.name} is outside ${SC2_BOUNDED_RUNTIME_PROFILE}`,
        )
      }
      executing = true
      try {
        execution.signal?.throwIfAborted()
        const value = evaluate(analysis.parsed, execution.entrypoint)
        if (calls.length + 1 > MAX_RETAINED_CALLS || log.length + 1 > MAX_RETAINED_EVENTS) {
          return budgetRefusal(
            'max-memory-bytes',
            'retained runtime state',
            budget.maxMemoryBytes,
            budget.maxMemoryBytes + 1,
          )
        }
        const nextSequence = sequence + 1
        const nextCalls = calls.concat(
          Object.freeze({
            entrypoint: execution.entrypoint,
            value: cloneJson(value) ?? null,
            tickDelta: resources.ticks,
            memoryDelta: resources.memoryBytes,
          }),
        )
        const nextLog = log.concat(
          Object.freeze({
            sequence: nextSequence,
            tick: requestedTicks,
            kind: 'sc2.galaxy.executed',
            data: Object.freeze({
              entrypoint: execution.entrypoint,
              profile: SC2_BOUNDED_RUNTIME_PROFILE,
            }),
          }),
        )
        const projected = stateRecord({
          executions: executions + 1,
          ticks: requestedTicks,
          reservedMemory: reservedMemory + resources.memoryBytes,
          sequence: nextSequence,
          calls: nextCalls,
          events: nextLog,
        })
        const requestedMemory = memoryOf(projected)
        if (requestedMemory > budget.maxMemoryBytes)
          return budgetRefusal('max-memory-bytes', 'memory', budget.maxMemoryBytes, requestedMemory)
        executions += 1
        ticks = requestedTicks
        reservedMemory += resources.memoryBytes
        calls = nextCalls
        sequence = nextSequence
        log = nextLog
        return Object.freeze({
          state: 'completed',
          ...(value === undefined ? {} : { value: cloneJson(value) }),
          usage: resources,
          diagnostics: NO_DIAGNOSTICS,
        })
      } catch (error) {
        if (execution.signal?.aborted === true) return abortRefusal(execution.signal)
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
        schemaId: SC2_BOUNDED_STATE_SCHEMA,
        schemaVersion: STATE_SCHEMA_VERSION,
      })
    },
    async step(count, signal) {
      const refused = available(signal)
      if (refused !== undefined) return refused
      if (!Number.isSafeInteger(count) || count < 0) return v2Refusal('budget-exceeded')
      if (ticks + count > budget.maxTicks) return v2Refusal('budget-exceeded')
      if (log.length + count > MAX_RETAINED_EVENTS) return v2Refusal('budget-exceeded')
      const nextTicks = ticks + count
      const nextSequence = sequence + count
      const added = []
      for (let index = 0; index < count; index += 1) {
        added.push(
          Object.freeze({
            sequence: sequence + index + 1,
            tick: ticks + index + 1,
            kind: 'sc2.clock.tick',
          }),
        )
      }
      const nextLog = log.concat(added)
      const projected = stateRecord({ ticks: nextTicks, sequence: nextSequence, events: nextLog })
      if (memoryOf(projected) > budget.maxMemoryBytes) return v2Refusal('budget-exceeded')
      ticks = nextTicks
      sequence = nextSequence
      log = nextLog
      return Object.freeze({ outcome: 'stepped', status: status(), diagnostics: NO_DIAGNOSTICS })
    },
    async *events(afterSequence = 0) {
      if (disposed || !Number.isSafeInteger(afterSequence) || afterSequence < 0) return
      for (const event of log) if (event.sequence > afterSequence) yield event
    },
    async snapshot(signal) {
      const refused = available(signal)
      if (refused !== undefined) return refused
      const bytes = stateBytes()
      if (currentMemory() + bytes.byteLength > budget.maxMemoryBytes) {
        return v2Refusal('budget-exceeded')
      }
      return Object.freeze({
        outcome: 'captured',
        snapshot: Object.freeze({
          identity: Object.freeze({
            contentDigest: digestOf(bytes),
            schemaId: SC2_BOUNDED_STATE_SCHEMA,
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
        snapshot?.identity?.schemaId !== SC2_BOUNDED_STATE_SCHEMA ||
        snapshot?.identity?.schemaVersion !== STATE_SCHEMA_VERSION
      )
        return v2Refusal('schema-mismatch')
      if (!(snapshot.bytes instanceof Uint8Array)) return v2Refusal('digest-mismatch')
      if (currentMemory() + snapshot.bytes.byteLength > budget.maxMemoryBytes) {
        return v2Refusal('budget-exceeded')
      }
      if (digestOf(snapshot.bytes) !== snapshot.identity.contentDigest)
        return v2Refusal('digest-mismatch')
      let restored
      try {
        restored = JSON.parse(decoder.decode(snapshot.bytes))
      } catch {
        return v2Refusal('digest-mismatch')
      }
      if (!equalBytes(canonicalBytes(restored), snapshot.bytes) || !restoredStateIsValid(restored))
        return v2Refusal('schema-mismatch')
      executions = restored.executions
      ticks = restored.ticks
      reservedMemory = restored.reservedMemory
      sequence = restored.sequence
      calls = cloneJson(restored.calls)
      log = cloneJson(restored.events)
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
      reservedMemory = 0
      log = []
      calls = []
    },
  })
}

export const abiVersion = 1
export const provides = Object.freeze([RUNTIME_PROVIDER_CONTRACT])

export function createProvider(selection) {
  if (
    selection.contract !== RUNTIME_PROVIDER_CONTRACT ||
    selection.major !== 1 ||
    !['sc2-galaxy-pure-bounded-v1', SC2_PLAYABLE_OFFER_ID].includes(selection.offerId)
  )
    throw new TypeError(
      `unsupported SC2 runtime selection ${selection.contract}@${selection.major}`,
    )
  return Object.freeze({
    value: Object.freeze({
      contract: RUNTIME_PROVIDER_CONTRACT,
      providerId: PROVIDER_ID,
      runtimeIds: Object.freeze([
        selection.offerId === SC2_PLAYABLE_OFFER_ID
          ? SC2_PLAYABLE_RUNTIME_ID
          : SC2_BOUNDED_RUNTIME_ID,
      ]),
      async createSession(request) {
        const budget = exactRuntimeBudget(request.budget)
        const loaded = await loadInvocation(request, budget)
        return selection.offerId === SC2_PLAYABLE_OFFER_ID
          ? createPlayableSession(request, loaded, budget)
          : createSession(request, loaded, budget)
      },
    }),
    release: async () => undefined,
  })
}
