/** Narrow, explicit SC2 Galaxy→Luau lowering. The Galaxy owner parses and normalizes syntax;
 * the universal compiler owns Luau→UVB. Refuse every effect this slice cannot preserve.
 */
import { parseGalaxySource } from '@modkit/blizzard-starcraft2/galaxy/analysis/source.js'
import { galaxySourceToEngineModule } from '@modkit/blizzard-starcraft2/galaxy/analysis/to-engine.js'
import { analyzeGalaxyRuntimeClosure } from './galaxy-runtime-closure.js'
import { resolveSc2WorldPoint, Sc2WorldPointError, type Sc2SpawnPoint } from './world-points.js'
import type { EngineModule, EngineNode, EngineSourceRef }
  from '@modkit/blizzard-starcraft2/galaxy/analysis/to-engine-types.js'

interface GalaxySpawnAnalysisRequest {
  readonly text: string
  readonly fileName: string
  readonly functionName: string
  readonly quantizeFixed64Decimal: (decimal: string) => string
}
interface GalaxySpawnLoweringRequest extends GalaxySpawnAnalysisRequest {
  readonly space: string
  readonly world?: unknown
}
interface AnalyzedGalaxySpawn {
  readonly unitId: string
  readonly playerId: string
  readonly point: Sc2SpawnPoint
  readonly pointSource: EngineSourceRef | undefined
  readonly line: number
  readonly fileName: string
  readonly functionName: string
  readonly span: Readonly<{ start: number; end: number }>
}

const analyzedSpawns = new WeakSet<AnalyzedGalaxySpawn>()

export class Sc2GalaxyRuntimeLoweringError extends Error {
  readonly code: string
  readonly span: EngineSourceRef['span'] | undefined
  constructor(code: string, message: string, span?: EngineSourceRef['span']) {
    super(message)
    this.code = code
    this.span = span
  }
}

function refuse(code: string, message: string,
  source?: Pick<EngineSourceRef, 'span'>): never {
  throw new Sc2GalaxyRuntimeLoweringError(code, message, source?.span)
}

function decimal(sourceText: string, expression: EngineNode | undefined,
  label: string, quantize: (decimal: string) => string): string {
  if (expression?.kind !== 'EngineLiteralExpression')
    refuse('sc2-runtime/unsupported-expression', `${label} must be a fixed literal`, expression?.source)
  const span = expression.source?.span
  const raw = span && sourceText.slice(span.start, span.end)
  if (!raw || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw))
    refuse('sc2-runtime/unsupported-expression', `${label} must be a nonnegative decimal literal`, expression.source)
  try { return quantize(raw) }
  catch (error) { refuse('sc2-runtime/fixed-out-of-range',
    error instanceof Error ? error.message : String(error), expression.source) }
}

function integer(sourceText: string, expression: EngineNode | undefined,
  label: string, constants: ReadonlyMap<string, bigint>): bigint {
  if (expression?.kind === 'EngineIdentifierExpression') {
    const value = expression.name ? constants.get(expression.name) : undefined
    if (value === undefined)
      refuse('sc2-runtime/unsupported-expression',
        `${label} must be an integer literal or a resolved const int`, expression.source)
    return value
  }
  const span = expression?.source?.span
  const raw = span && sourceText.slice(span.start, span.end)
  if (expression?.kind !== 'EngineLiteralExpression' || !raw || !/^(?:0|[1-9][0-9]*)$/u.test(raw))
    refuse('sc2-runtime/unsupported-expression', `${label} must be an integer literal`, expression?.source)
  return BigInt(raw)
}

/** First executable Galaxy slice: a parameterless void function with one UnitCreate call.
 * Count=1, create-style=0, facing=0, Point/PointFromId and an unused unitgroup result are admitted.
 * All other syntax is refused, including any surrounding module side effects.
 * Analyze before the expensive Data/Map resolution; bind the selected UVW space afterwards.
 */
export function analyzeGalaxySingleUnitSpawn({ text, fileName, functionName,
  quantizeFixed64Decimal }: GalaxySpawnAnalysisRequest): AnalyzedGalaxySpawn {
  if (typeof text !== 'string' || !fileName || !functionName
      || typeof quantizeFixed64Decimal !== 'function')
    throw new TypeError('Galaxy runtime analysis requires source, file, function and quantizer')
  if (new TextEncoder().encode(text).byteLength > 1_048_576)
    refuse('sc2-runtime/source-budget', 'Galaxy source exceeds the 1 MiB lowering budget')
  const parsed = parseGalaxySource(text, { fileName })
  if (parsed.parseDiagnostics?.length || parsed.additionalSyntacticDiagnostics?.length)
    refuse('sc2-runtime/galaxy-syntax', 'Galaxy source has syntax errors',
      { span: { start: 0, end: text.length } })
  // The Galaxy owner currently publishes a permissive EngineNode shim. Admit only
  // the structural fields this read-only Runtime view needs, then retain its AST.
  const canonical = galaxySourceToEngineModule(parsed, { includeRawFallbacks: true })
  if (canonical['kind'] !== 'EngineModule' || !Array.isArray(canonical['functions'])
      || !Array.isArray(canonical['globals']) || !Array.isArray(canonical['imports'])
      || !Array.isArray(canonical['structs']))
    refuse('sc2-runtime/galaxy-ast', 'Galaxy parser did not produce a complete EngineModule')
  const module = canonical as unknown as EngineModule
  const function_ = module.functions.find(item => item.name === functionName)
  const inertConstants = module.globals.every(variable => variable.constant === true
    && variable.type?.name === 'int'
    && variable.initialValue?.kind === 'EngineLiteralExpression'
    && typeof variable.initialValue.value === 'number'
    && Number.isInteger(variable.initialValue.value)
    && variable.initialValue.value >= -(2 ** 31)
    && variable.initialValue.value <= 2 ** 31 - 1)
  if (parsed.statements.length !== module.globals.length + 1 || module.functions.length !== 1 || !function_
      || !inertConstants || module.imports!.length
      || module.structs.length || function_.flags?.native || function_.returnType?.name !== 'void'
      || function_.parameters.length || function_.locals.length || function_.body.length !== 1) {
    let detail = ''
    if (function_?.body?.length && !function_.flags?.native) {
      try {
        const closure = analyzeGalaxyRuntimeClosure(module, functionName)
        detail = `; observed dependency slice has ${closure.functions.length} functions, `
          + `${closure.declaredGlobals.length} globals, ${closure.imports.length} includes, `
          + `${closure.externalCalls.length} external calls and ${closure.rawNodes.length} raw nodes`
      } catch (error) {
        if (error instanceof RangeError)
          refuse('sc2-runtime/closure-budget', error.message, function_.source)
      }
    }
    refuse('sc2-runtime/galaxy-profile',
      `Only one effect-free void function with one UnitCreate statement is admitted${detail}`,
      function_?.source ?? module.source)
  }
  const nativeShadow = [...module.functions, ...module.globals].find(declaration =>
    declaration.name === 'UnitCreate' || declaration.name === 'Point' || declaration.name === 'PointFromId')
  if (nativeShadow)
    refuse('sc2-runtime/native-binding-shadowed',
      `Source declaration ${nativeShadow.name} shadows an admitted native binding`, nativeShadow.source)
  let closure: ReturnType<typeof analyzeGalaxyRuntimeClosure>
  try { closure = analyzeGalaxyRuntimeClosure(module, functionName) }
  catch (error) {
    if (error instanceof RangeError)
      refuse('sc2-runtime/closure-budget', error.message, function_.source)
    throw error
  }
  if (closure.ambiguousGlobals.length || closure.rawNodes.length)
    refuse('sc2-runtime/galaxy-profile',
      'Galaxy source has ambiguous globals or unsupported syntax', function_.source)
  const constants = new Map(closure.literalIntGlobals.map(variable =>
    [variable.name, BigInt(variable.value)]))
  const statement = function_.body[0]!
  const call = statement.kind === 'EngineExpressionStatement'
    ? statement['expression'] as EngineNode | undefined : undefined
  if (call?.kind !== 'EngineCallExpression' || call.callee?.name !== 'UnitCreate'
      || !Array.isArray(call['args']) || call['args'].length !== 6)
    refuse('sc2-runtime/native-unsupported', 'Only the six-argument UnitCreate statement is admitted',
      statement.source)
  const [count, type, style, player, position, facing] = call['args'] as EngineNode[]
  if (integer(text, count, 'count', constants) !== 1n)
    refuse('sc2-runtime/unit-count-unsupported', 'UnitCreate count must be exactly one', count?.source)
  const typeSpan = type?.source?.span
  const typeText = typeSpan && text.slice(typeSpan.start, typeSpan.end)
  if (type?.kind !== 'EngineLiteralExpression' || !/^"[A-Za-z][A-Za-z0-9_]*"$/u.test(typeText ?? ''))
    refuse('sc2-runtime/unit-type-unsupported', 'UnitCreate type must be a literal catalog ID', type?.source)
  const unitId = typeText!.slice(1, -1)
  if (integer(text, style, 'create style', constants) !== 0n)
    refuse('sc2-runtime/create-style-unsupported', 'UnitCreate style must be zero', style?.source)
  const playerId = integer(text, player, 'player', constants)
  if (playerId > 15n)
    refuse('sc2-runtime/player-unsupported', 'UnitCreate player must be in 0..15', player?.source)
  if (position?.kind !== 'EngineCallExpression' || !Array.isArray(position['args']))
    refuse('sc2-runtime/point-unsupported', 'UnitCreate position must be Point(x, y) or PointFromId(id)', position?.source)
  const pointArgs = position['args'] as EngineNode[]
  let point: Sc2SpawnPoint
  if (position.callee?.name === 'Point' && pointArgs.length === 2) {
    point = Object.freeze({ kind: 'literal',
      x: decimal(text, pointArgs[0], 'x', quantizeFixed64Decimal),
      y: decimal(text, pointArgs[1], 'y', quantizeFixed64Decimal) })
  } else if (position.callee?.name === 'PointFromId' && pointArgs.length === 1) {
    const id = integer(text, pointArgs[0], 'point ID', constants)
    if (id > BigInt(Number.MAX_SAFE_INTEGER))
      refuse('sc2-runtime/point-id-unsupported', 'PointFromId exceeds the map Objects ID range', pointArgs[0]?.source)
    point = Object.freeze({ kind: 'placed', id: id.toString() })
  } else {
    refuse('sc2-runtime/point-unsupported', 'UnitCreate position must be Point(x, y) or PointFromId(id)', position.source)
  }
  if (decimal(text, facing, 'facing', quantizeFixed64Decimal) !== '0')
    refuse('sc2-runtime/facing-unsupported', 'UnitCreate facing must be zero', facing?.source)
  if (!call.source?.span)
    refuse('sc2-runtime/galaxy-ast', 'Galaxy call has no source span', call.source)
  const line = text.slice(0, call.source.span.start).split(/\r\n|\r|\n/u).length
  const analyzed = Object.freeze({ unitId, playerId: playerId.toString(),
    point, pointSource: position.source,
    line, fileName, functionName, span: Object.freeze({ ...call.source.span }) })
  analyzedSpawns.add(analyzed)
  return analyzed
}

export function bindGalaxySingleUnitSpawn(analyzed: AnalyzedGalaxySpawn, space: string,
  world: unknown, quantizeFixed64Decimal: (decimal: string) => string) {
  if (!analyzed || !analyzedSpawns.has(analyzed)
      || typeof space !== 'string' || !space || typeof quantizeFixed64Decimal !== 'function')
    throw new TypeError('Galaxy spawn binding requires analyzed source, UVW world, space and quantizer')
  let pos
  try { pos = resolveSc2WorldPoint(world, space, analyzed.point, quantizeFixed64Decimal) }
  catch (error) {
    if (error instanceof Sc2WorldPointError)
      refuse(error.code, error.message, analyzed.pointSource)
    throw error
  }
  const point = `mv.pos(${JSON.stringify(space)}, ${[pos.x, pos.y, pos.z]
    .map(value => `mv.fixed.fromQuantum(${JSON.stringify(value)})`).join(', ')})`
  return Object.freeze({
    luau: `function point(): Pos\n  return ${point}\nend\n`
      + 'function createAt(def: DefRef, owner: PlayerRef, at: Pos): EntityGroup\n'
      + '  local entity: EntityRef = mv.entity.create(def, owner, at)\n'
      + '  mv.require(mv.scenario.setOptionalEntity("sc2.native/state/lastCreatedUnit", mv.option.entity(entity)))\n'
      + '  return mv.group.append(mv.group.empty(), entity)\nend\n'
      + 'function spawn(def: DefRef, owner: PlayerRef): EntityGroup\n'
      + '  return createAt(def, owner, point())\nend\n'
      + 'function lastCreated(): OptionalEntityRef\n'
      + '  return mv.scenario.requireOptionalEntity("sc2.native/state/lastCreatedUnit")\nend\n',
    // One captured native State per composition; no script-side global store.
    scenarios: [{ path: 'native-state.uvs.json', document: {
      uv: { format: 'UVS', version: '1.5' }, namespace: 'sc2.native',
      charts: [{ name: 'state', initialState: 'idle',
        variables: [{ name: 'lastCreatedUnit', type: 'ref<entity>?', initial: null }],
        states: [{ name: 'idle', on: [] }] }],
    } }],
    totalUnits: 1, loweredUnits: 1, refusals: [],
    sourceMap: [{ luauLine: 2, nativeLine: analyzed.line },
      { luauLine: 5, nativeLine: analyzed.line },
      { luauLine: 6, nativeLine: analyzed.line },
      { luauLine: 7, nativeLine: analyzed.line },
      { luauLine: 10, nativeLine: analyzed.line }],
    invocation: { unit: { namespace: 'Unit', entityId: analyzed.unitId },
      playerId: analyzed.playerId, pos: { space, ...pos } },
    metadata: { fileName: analyzed.fileName, functionName: analyzed.functionName,
      native: 'UnitCreate', span: analyzed.span,
      admitted: ['count=1', 'style=0', 'facing=0', analyzed.point.kind === 'placed' ? 'placed PointFromId' : 'ground Point', 'unitgroup result', 'implicit last-created State update'],
      executableScope: 'single UnitCreate only' },
  })
}

export function lowerGalaxySingleUnitSpawn(request: GalaxySpawnLoweringRequest) {
  if (typeof request?.space !== 'string' || !request.space)
    throw new TypeError('Galaxy runtime lowering requires a UVW space')
  return bindGalaxySingleUnitSpawn(analyzeGalaxySingleUnitSpawn(request), request.space,
    request.world, request.quantizeFixed64Decimal)
}

/** Total-coverage projection for the shared lowering receipt. No rejected source executes. */
export function projectGalaxySingleUnitSpawn(request: GalaxySpawnLoweringRequest) {
  try { return lowerGalaxySingleUnitSpawn(request) }
  catch (error) {
    if (!(error instanceof Sc2GalaxyRuntimeLoweringError)) throw error
    const { text, functionName } = request
    const span = error.span
    const fragment = span && span.end > span.start
      ? text.slice(span.start, span.end)
      : text
    return { luau: '', totalUnits: 1, loweredUnits: 0, refusals: [{
      rule: error.code.replace(/^sc2-runtime\//u, ''), unit: functionName,
      reason: error.message, fragment,
    }] }
  }
}
