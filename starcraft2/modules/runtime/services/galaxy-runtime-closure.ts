/** Runtime dependency inventory over the Galaxy owner's canonical EngineModule.
 * This is an admission input, not an executor: includes and unresolved calls must
 * be resolved through the selected ModContext before any source can run. Native
 * declarations remain owner AST witnesses; every call retains its initializer/function origin.
 * Call sites are static witnesses, not an execution-order or bootstrap plan.
 */

import type { EngineSourceRef, EngineNode, EngineFunction, EngineVariable, EngineModule, EngineLiteralExpression }
  from '@modkit/blizzard-starcraft2/galaxy/analysis/to-engine-types.js'

interface RuntimeCallSite {
  readonly origin: 'function' | 'global-initializer'
  readonly owner: string
  readonly span: EngineSourceRef['span']
  readonly source: EngineSourceRef | undefined
}

const span = (node: Pick<EngineNode, 'source'> | undefined) => node?.source?.span

function visit(node: unknown, onNode: (node: EngineNode) => void,
  budget: { count: number; max: number; maxDepth: number }, depth = 0): void {
  if (!node || typeof node !== 'object') return
  if (depth > budget.maxDepth)
    throw new RangeError(`Galaxy runtime closure exceeds ${budget.maxDepth} Engine levels`)
  if (++budget.count > budget.max)
    throw new RangeError(`Galaxy runtime closure exceeds ${budget.max} Engine nodes`)
  if (Array.isArray(node)) {
    for (const child of node) visit(child, onNode, budget, depth + 1)
    return
  }
  const record = node as EngineNode
  if (typeof record.kind === 'string') onNode(record)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'source' || key === 'valueType' || key === 'type'
        || key === 'returnType' || key === 'callee') continue
    if (value && typeof value === 'object') visit(value, onNode, budget, depth + 1)
  }
}

/** Inventory the selected entry's transitive calls and supplied module initialization.
 * Declarations without bodies, external calls and imports remain unresolved by design.
 */
export function analyzeGalaxyRuntimeClosure(module: EngineModule, functionName: string,
  { dependencies = [], maxNodes = 200_000, maxDepth = 128 }: {
    readonly dependencies?: readonly EngineModule[]
    readonly maxNodes?: number
    readonly maxDepth?: number
  } = {}) {
  if (module?.kind !== 'EngineModule' || typeof functionName !== 'string' || !functionName
      || !Array.isArray(dependencies) || dependencies.length > 256
      || dependencies.some(item => item?.kind !== 'EngineModule')
      || !Number.isSafeInteger(maxNodes) || maxNodes < 1
      || !Number.isSafeInteger(maxDepth) || maxDepth < 1)
    throw new TypeError('Galaxy runtime closure requires an EngineModule, entry and node budget')

  const modules = [module, ...dependencies]
  const definitions = new Map<string, EngineFunction>()
  const declarations = new Map<string, EngineFunction[]>()
  const ambiguous = new Set<string>()
  for (const source of modules) {
    for (const func of source.functions ?? []) {
      if (!func.name) continue
      if (!declarations.has(func.name)) declarations.set(func.name, [])
      declarations.get(func.name)!.push(func)
      if (func.flags?.native || func.flags?.hasBody === false
          || (func.flags?.hasBody !== true && !func.body?.length)) continue
      if (definitions.has(func.name)) ambiguous.add(func.name)
      else definitions.set(func.name, func)
    }
  }
  const entry = definitions.get(functionName)
  if (!entry || ambiguous.has(functionName))
    throw new TypeError(`Galaxy runtime entry ${functionName} has no unique implementation`)

  const globals = new Map<string, EngineVariable>()
  const ambiguousGlobals = new Set<string>()
  for (const source of modules) {
    for (const variable of source.globals ?? []) {
      if (globals.has(variable.name)) ambiguousGlobals.add(variable.name)
      else globals.set(variable.name, variable)
    }
  }
  const reachable = new Set<string>()
  const usedGlobals = new Map<string, EngineVariable>()
  const externalCalls = new Map<string, { name: string; reason: string;
    span: EngineSourceRef['span']; source: EngineSourceRef | undefined;
    declaration?: EngineSourceRef | undefined;
    nativeDeclarations: readonly EngineFunction[]; callSites: RuntimeCallSite[] }>()
  const externalSymbols = new Map<string, { name: string; reason?: string;
    span: EngineSourceRef['span']; source: EngineSourceRef | undefined }>()
  const functionReferences = new Map<string, { name: string; via: string;
    span: EngineSourceRef['span']; source: EngineSourceRef | undefined }>()
  const initializerCalls: (RuntimeCallSite & { readonly name: string | undefined })[] = []
  const rawNodes: { kind: string; span: EngineSourceRef['span'];
    source: EngineSourceRef | undefined; origin: 'function' | 'global-initializer';
    owner: string }[] = []
  const budget = { count: 0, max: maxNodes, maxDepth }
  // Keep name-level admission and every source witness together, including unused globals.
  const externalCall = (name: string, node: EngineNode,
    origin: RuntimeCallSite['origin'], owner: string) => {
    const site = Object.freeze({ origin, owner, span: span(node), source: node.source })
    const existing = externalCalls.get(name)
    if (existing) { existing.callSites.push(site); return }
    const declared = declarations.get(name) ?? []
    const natives = declared.filter(func => func.flags?.native)
    const signature = (func: EngineFunction) => JSON.stringify([func.returnType?.name,
      ...(func.parameters ?? []).map(parameter => parameter.type?.name)])
    const reason = ambiguous.has(name) ? 'ambiguous-implementation'
      : natives.length > 0 && new Set(natives.map(signature)).size > 1
        ? 'conflicting-native-signatures'
        : natives.length > 0 ? 'unmapped-native'
          : declared.length > 0 ? 'no-executable-body' : 'unknown-call'
    externalCalls.set(name, { name, reason, span: span(node), source: node.source,
      ...(natives.length > 0 ? { declaration: natives[0]?.source } : {}),
      nativeDeclarations: Object.freeze(natives), callSites: [site] })
  }
  const referenceFunction = (name: string, node: EngineNode, via: string) => {
    functionReferences.set(name, functionReferences.get(name) ?? {
      name, via, span: span(node), source: node.source,
    })
    scanFunction(name)
  }
  const scan = (root: unknown, locals: ReadonlySet<string>,
    origin: 'function' | 'global-initializer', owner: string) => visit(root, node => {
    if (node.kind === 'EngineCallExpression') {
      const name = node.callee?.name
      if (origin === 'global-initializer')
        initializerCalls.push(Object.freeze({ name, origin, owner, span: span(node), source: node.source }))
      if (name && definitions.has(name) && !ambiguous.has(name)) scanFunction(name)
      else if (name) externalCall(name, node, origin, owner)
    } else if (node.kind === 'EngineIdentifierExpression' && typeof node.name === 'string'
        && !locals.has(node.name)) {
      if (ambiguousGlobals.has(node.name))
        externalSymbols.set(node.name, externalSymbols.get(node.name) ?? {
          name: node.name, reason: 'ambiguous-global', span: span(node), source: node.source,
        })
      else if (globals.has(node.name)) usedGlobals.set(node.name, globals.get(node.name)!)
      else if (definitions.has(node.name) && !ambiguous.has(node.name)) {
        referenceFunction(node.name, node, 'identifier')
      } else externalSymbols.set(node.name, externalSymbols.get(node.name) ?? {
        name: node.name, span: span(node), source: node.source,
      })
    } else if (node.kind === 'EngineLiteralExpression' && node.valueType?.name === 'string') {
      // Galaxy trigger APIs pass callback names as strings (TriggerCreate("name")).
      // Treat every exact local function-name literal as a possible callback.
      const name = typeof node.value === 'string'
        ? /^"([A-Za-z_][A-Za-z0-9_]*)"$/u.exec(node.value)?.[1] : undefined
      if (name && definitions.has(name) && !ambiguous.has(name))
        referenceFunction(name, node, 'string')
    } else if (node.kind === 'EngineRawExpression' || node.kind === 'EngineRawStatement') {
      rawNodes.push({ kind: node.kind, span: span(node), source: node.source, origin, owner })
    }
  }, budget)
  const scanFunction = (name: string): void => {
    if (reachable.has(name)) return
    reachable.add(name)
    const func = definitions.get(name)!
    const locals = new Set([...func.parameters.map(item => item.name),
      ...func.locals.map(item => item.name)])
    scan(func.body, locals, 'function', name)
  }

  // Galaxy global initializers run on module load, including globals not read by entry.
  for (const source of modules)
    for (const variable of source.globals ?? [])
      if (variable.initialValue)
        scan(variable.initialValue, new Set(), 'global-initializer', variable.name)
  scanFunction(functionName)
  const literalIntGlobals = [...usedGlobals.values()].filter((variable): variable is EngineVariable & {
    readonly initialValue: EngineLiteralExpression & { readonly value: number }
  } =>
    variable.constant === true && variable.type?.name === 'int'
      && variable.initialValue?.kind === 'EngineLiteralExpression'
      && typeof variable.initialValue.value === 'number'
      && Number.isInteger(variable.initialValue.value)
      && variable.initialValue.value >= -(2 ** 31)
      && variable.initialValue.value <= 2 ** 31 - 1)
    .map(variable => Object.freeze({ name: variable.name, value: variable.initialValue!.value as number,
      declaration: variable.source, initializer: variable.initialValue!.source }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return Object.freeze({
    entry: functionName,
    suppliedModules: modules.length,
    functions: Object.freeze([...reachable].sort()),
    globals: Object.freeze([...usedGlobals.keys()].sort()),
    literalIntGlobals: Object.freeze(literalIntGlobals),
    declaredGlobals: Object.freeze([...globals.keys()].sort()),
    initializedGlobals: Object.freeze(modules.flatMap(source => source.globals ?? [])
      .filter(item => item.initialValue).map(item => item.name).sort()),
    initializerCalls: Object.freeze(initializerCalls),
    ambiguousGlobals: Object.freeze([...ambiguousGlobals].sort()),
    functionReferences: Object.freeze([...functionReferences.values()].sort((a, b) =>
      a.name.localeCompare(b.name))),
    imports: Object.freeze(modules.flatMap(source => source.imports ?? []).map(item => ({
      moduleId: item.moduleId, span: span(item), source: item.source,
    }))),
    externalCalls: Object.freeze([...externalCalls.values()].sort((a, b) =>
      a.name.localeCompare(b.name)).map(call => Object.freeze({ ...call,
      callSites: Object.freeze(call.callSites) }))),
    externalSymbols: Object.freeze([...externalSymbols.values()].sort((a, b) =>
      a.name.localeCompare(b.name))),
    ambiguousFunctions: Object.freeze([...ambiguous].sort()),
    rawNodes: Object.freeze(rawNodes),
    inspectedNodes: budget.count,
  })
}
