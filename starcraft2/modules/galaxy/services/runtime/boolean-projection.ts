/** Pure boolean Galaxy → readable Luau; the shared Runtime compiler owns UVB. */
import { parseGalaxySource } from '../analysis/source.js'
import { galaxySourceToEngineModule } from '../analysis/to-engine.js'
import type { EngineExpression, EngineFunction, EngineNode, EngineStatement }
  from '../analysis/to-engine-types.js'
import { SyntaxKind, type Node } from '../../language-core/types.js'
import { getLineAndCharacterOfPosition } from '../../language-core/utils.js'

export interface GalaxyBooleanRefusal {
  readonly rule: 'galaxy-parse' | 'unsupported-declaration' | 'unsupported-type' | 'unsupported-body' | 'unsupported-expression'
  readonly unit: string
  readonly line: number
  readonly reason: string
  /** Exact preserved source fragment for a later LoweringReceipt digest. */
  readonly fragment: string
}

export type GalaxyBooleanProjection =
  | Readonly<{ state: 'refused'; refusals: readonly GalaxyBooleanRefusal[]; totalUnits: number;
      luau: string; sourceMap: readonly Readonly<{ luauLine: number; nativeLine: number }>[];
      loweredUnits: number }>
  | Readonly<{ state: 'lowered'; refusals: readonly []; totalUnits: number;
      loweredUnits: number;
      luau: string; sourceMap: readonly Readonly<{ luauLine: number; nativeLine: number }>[];
      symbols: readonly Readonly<{ galaxy: string; uvb: string; line: number }>[] }>

class Unsupported extends Error {
  constructor(readonly rule: GalaxyBooleanRefusal['rule'], readonly node: Node | EngineNode, message: string) {
    super(message)
  }
}

const encoder = new TextEncoder()
const uvbName = (name: string) => `g${[...encoder.encode(name)]
  .map(byte => byte.toString(16).padStart(2, '0')).join('')}`

interface BooleanBinding { readonly name: string; readonly constant: boolean }
interface ProjectionContext {
  readonly bindings: Map<string, BooleanBinding>
  readonly functions: ReadonlyMap<string, EngineFunction>
  readonly moduleId: string
}

function projectExpression(node: EngineExpression, ctx: ProjectionContext, depth = 0): string {
  if (depth > 64)
    throw new Unsupported('unsupported-expression', node, 'boolean expression nesting exceeds 64')
  const child = (value: EngineExpression) => projectExpression(value, ctx, depth + 1)
  switch (node.kind) {
    case 'EngineLiteralExpression':
      if (typeof node.value !== 'boolean')
        throw new Unsupported('unsupported-expression', node, 'pure profile requires a boolean literal')
      return String(node.value)
    case 'EngineIdentifierExpression': {
      const binding = ctx.bindings.get(node.name)
      if (!binding) throw new Unsupported('unsupported-expression', node,
        'only initialized boolean locals and declared parameters can be read')
      return binding.name
    }
    case 'EngineUnaryExpression':
      if (node.operator !== '!')
        throw new Unsupported('unsupported-expression', node, 'only boolean negation is admitted')
      return `(not ${child(node.operand)})`
    case 'EngineBinaryExpression': {
      const operators: Readonly<Record<string, string>> = { '&&': 'and', '||': 'or', '==': '==', '!=': '~=' }
      const operator = operators[node.operator]
      if (operator === undefined)
        throw new Unsupported('unsupported-expression', node, 'only boolean logic and equality are admitted')
      return `(${child(node.left)} ${operator} ${child(node.right)})`
    }
    case 'EngineCallExpression': {
      const name = node.callee.name
      const callee = name === undefined ? undefined : ctx.functions.get(name)
      if (!callee || (name !== undefined && ctx.bindings.has(name)) || node.native || node.callee.nativeId
          || (node.callee.moduleId !== undefined && node.callee.moduleId !== ctx.moduleId)
          || callee.flags.native || !callee.flags.hasBody || callee.returnType.name !== 'bool'
          || callee.parameters.some(parameter => parameter.type.name !== 'bool')
          || node.args.length !== callee.parameters.length)
        throw new Unsupported('unsupported-expression', node, 'call requires an unshadowed local boolean function and matching arguments')
      return `${uvbName(callee.name)}(${node.args.map(child).join(', ')})`
    }
    default:
      throw new Unsupported('unsupported-expression', node, 'Galaxy expression has no pure boolean lowering')
  }
}

function projectStatements(body: readonly EngineStatement[], ctx: ProjectionContext,
  emit: (text: string, source?: EngineNode) => void, indent = 1, loopDepth = 0): void {
  if (indent > 32 && body.length)
    throw new Unsupported('unsupported-body', body[0]!, 'boolean statement nesting exceeds 32')
  const line = (text: string, source?: EngineNode, extra = 0) => emit('  '.repeat(indent + extra) + text, source)
  for (const [index, node] of body.entries()) {
    // Luau requires a transfer to end its block. Keep unreachable normalized loop tails
    // inside the admitted source rather than deleting them or duplicating loop lowering.
    const wrapped = index < body.length - 1 && ['EngineReturnStatement', 'EngineBreakStatement', 'EngineContinueStatement'].includes(node.kind)
    if (wrapped) line('do')
    const transfer = (text: string) => line(text, node, wrapped ? 1 : 0)
    switch (node.kind) {
      case 'EngineVariableStatement': {
        const variable = node.variable
        if (variable.type.name !== 'bool')
          throw new Unsupported('unsupported-type', variable, 'pure profile admits only boolean locals')
        if (indent !== 1 || !variable.initialValue || ctx.bindings.has(variable.name))
          throw new Unsupported('unsupported-body', variable, 'local requires a unique name and explicit boolean initializer')
        const value = projectExpression(variable.initialValue, ctx)
        const name = `l${ctx.bindings.size}`
        line(`local ${name}: boolean = ${value}`, node)
        ctx.bindings.set(variable.name, { name, constant: variable.constant === true })
        break
      }
      case 'EngineAssignmentStatement': {
        const target = node.target.kind === 'EngineIdentifierExpression' ? ctx.bindings.get(node.target.name) : undefined
        if (node.operator !== '=' || !target || target.constant)
          throw new Unsupported('unsupported-body', node, 'assignment requires one mutable boolean binding and the = operator')
        line(`${target.name} = ${projectExpression(node.value, ctx)}`, node)
        break
      }
      case 'EngineExpressionStatement':
        if (node.expression.kind !== 'EngineCallExpression')
          throw new Unsupported('unsupported-body', node, 'only an admitted boolean function call can be discarded')
        line(projectExpression(node.expression, ctx), node)
        break
      case 'EngineReturnStatement':
        if (!node.value) throw new Unsupported('unsupported-body', node, 'boolean return requires a value')
        transfer(`return ${projectExpression(node.value, ctx)}`)
        break
      case 'EngineIfStatement':
        line(`if ${projectExpression(node.condition, ctx)} then`, node)
        projectStatements(node.then, ctx, emit, indent + 1, loopDepth)
        if (node.else?.length) {
          line('else')
          projectStatements(node.else, ctx, emit, indent + 1, loopDepth)
        }
        line('end')
        break
      case 'EngineWhileStatement':
        line(`while ${projectExpression(node.condition, ctx)} do`, node)
        projectStatements(node.body, ctx, emit, indent + 1, loopDepth + 1)
        line('end')
        break
      case 'EngineBlockStatement':
        line('do', node)
        projectStatements(node.statements, ctx, emit, indent + 1, loopDepth)
        line('end')
        break
      case 'EngineBreakStatement':
      case 'EngineContinueStatement':
        if (loopDepth === 0)
          throw new Unsupported('unsupported-body', node, 'loop control requires an enclosing loop')
        transfer(node.kind === 'EngineBreakStatement' ? 'break' : 'continue')
        break
      default:
        throw new Unsupported('unsupported-body', node, 'Galaxy statement has no pure boolean lowering')
    }
    if (wrapped) line('end')
  }
}

/** Refuses the entire file if any declaration is outside the admitted subset. */
export function projectGalaxyBooleanSource(text: string, file = 'MapScript.galaxy'): GalaxyBooleanProjection {
  if (file.length === 0 || /^[A-Za-z]:/u.test(file) || file.includes('\\') || file.includes('://'))
    throw new TypeError('Galaxy Runtime source name must be a logical path')
  const source = parseGalaxySource(text, { fileName: file, preserveSourceText: false })
  const position = (node: Node | EngineNode) => 'pos' in node
    ? { start: node.pos, end: node.end } : node.source?.span ?? { start: 0, end: text.length }
  const nativeLine = (node: Node | EngineNode) => getLineAndCharacterOfPosition(source, position(node).start).line + 1
  const refused = (rule: GalaxyBooleanRefusal['rule'], node: Node | EngineNode, reason: string,
    unit = `line ${nativeLine(node)}`): GalaxyBooleanRefusal => ({
    rule, unit, line: nativeLine(node), reason, fragment: text.slice(position(node).start, position(node).end),
  })
  if (source.parseDiagnostics.length > 0)
    return { state: 'refused', totalUnits: 1, loweredUnits: 0, luau: '', sourceMap: [],
      refusals: [refused('galaxy-parse', source, 'Galaxy parser reported syntax errors', file)] }
  const refusals: GalaxyBooleanRefusal[] = []
  const symbols: { galaxy: string; uvb: string; line: number }[] = []
  const luau: string[] = []
  const sourceMap: { luauLine: number; nativeLine: number }[] = []
  const seen = new Set<string>()
  const module = galaxySourceToEngineModule(source)
  const functions = new Map(module.functions.map(func => [func.name, func]))
  let functionIndex = 0
  for (const statement of source.statements) {
    if (statement.kind !== SyntaxKind.FunctionDeclaration) {
      refusals.push(refused('unsupported-declaration', statement,
        'only function declarations are admitted'))
      continue
    }
    const func = module.functions[functionIndex++]!
    try {
      if (func.returnType.name !== 'bool' ||
          func.parameters.some(parameter => parameter.type.name !== 'bool'))
        throw new Unsupported('unsupported-type', func, 'pure profile admits only bool parameters and return')
      if (func.flags.native || !func.flags.hasBody || func.body.at(-1)?.kind !== 'EngineReturnStatement')
        throw new Unsupported('unsupported-body', func, 'pure profile requires a body and a final boolean return')
      if (seen.has(func.name))
        throw new Unsupported('unsupported-declaration', func, 'duplicate Galaxy function name')
      seen.add(func.name)
      const ctx: ProjectionContext = { bindings: new Map(), functions, moduleId: module.id }
      func.parameters.forEach((parameter, index) => {
        if (ctx.bindings.has(parameter.name))
          throw new Unsupported('unsupported-declaration', parameter, 'duplicate parameter name')
        ctx.bindings.set(parameter.name, { name: `p${index}`, constant: false })
      })
      const lines: string[] = []
      const mappings: typeof sourceMap = []
      const emit = (line: string, node?: EngineNode) => {
        lines.push(line)
        if (node) mappings.push({ luauLine: luau.length + lines.length, nativeLine: nativeLine(node) })
      }
      const args = func.parameters.map((_, index) => `p${index}: boolean`).join(', ')
      emit(`function ${uvbName(func.name)}(${args}): boolean`, func)
      projectStatements(func.body, ctx, emit)
      emit('end')
      symbols.push({ galaxy: func.name, uvb: uvbName(func.name), line: nativeLine(func) })
      sourceMap.push(...mappings)
      luau.push(...lines, '')
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error
      refusals.push(refused(error.rule, error.node, error.message, func.name))
    }
  }
  if (luau.length === 0 && refusals.length === 0)
    refusals.push(refused('unsupported-declaration', source, 'source has no executable function', file))
  return refusals.length > 0
    ? { state: 'refused', totalUnits: source.statements.length || 1,
        loweredUnits: symbols.length, luau: luau.join('\n'), sourceMap, refusals }
    : { state: 'lowered', totalUnits: symbols.length, loweredUnits: symbols.length, refusals: [],
        luau: luau.join('\n'), sourceMap, symbols }
}
