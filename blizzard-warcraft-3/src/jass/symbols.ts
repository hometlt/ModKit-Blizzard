/**
 * JASS declarations and scopes over parsed documents: what a name refers to at a position.
 *
 * JASS has two scopes — the globals of every loaded script (types, natives, functions, global
 * variables) and one function's parameters and locals — and no nesting, so resolution is a lookup
 * in the function around the position and then in the global table.
 */
import type { JassDeclaration, JassName, JassParameter, JassProgram, JassSpan } from './parser.js'

export type JassSymbolKind = 'type' | 'native' | 'function' | 'global' | 'parameter' | 'local'

export interface JassSymbol {
  readonly name: string
  readonly kind: JassSymbolKind
  readonly uri: string
  /** The declared name. */
  readonly nameSpan: JassSpan
  /** The whole declaration. */
  readonly span: JassSpan
  /** One line of JASS that states the declaration: its signature or type. */
  readonly signature: string
  readonly parameters?: readonly JassParameter[]
  readonly type?: string
  readonly constant?: boolean
  /** The function whose parameter or local this is. */
  readonly owner?: string
}

export interface JassFunctionScope {
  readonly name: string
  readonly span: JassSpan
  readonly symbols: ReadonlyMap<string, JassSymbol>
}

export interface JassDocumentIndex {
  readonly uri: string
  readonly program: JassProgram
  readonly globals: readonly JassSymbol[]
  readonly functions: readonly JassFunctionScope[]
}

const parameterList = (parameters: readonly JassParameter[]) =>
  parameters.length === 0
    ? 'nothing'
    : parameters.map(parameter => `${parameter.type.name} ${parameter.name.name}`).join(', ')

function declarationSymbols(uri: string, declaration: JassDeclaration): JassSymbol[] {
  const at = (name: JassName) => ({ start: name.start, end: name.end })
  const span = { start: declaration.start, end: declaration.end }
  switch (declaration.kind) {
    case 'type':
      return [
        {
          name: declaration.name.name,
          kind: 'type',
          uri,
          nameSpan: at(declaration.name),
          span,
          signature: `type ${declaration.name.name} extends ${declaration.base.name}`,
          type: declaration.base.name,
        },
      ]
    case 'globals':
      return declaration.variables.map(variable => ({
        name: variable.name.name,
        kind: 'global',
        uri,
        nameSpan: at(variable.name),
        span: { start: variable.start, end: variable.end },
        signature: `${variable.constant ? 'constant ' : ''}${variable.type.name}${variable.array ? ' array' : ''} ${variable.name.name}`,
        type: variable.type.name,
        constant: variable.constant,
      }))
    case 'native':
    case 'function':
      return [
        {
          name: declaration.name.name,
          kind: declaration.kind,
          uri,
          nameSpan: at(declaration.name),
          span,
          signature:
            `${declaration.constant ? 'constant ' : ''}${declaration.kind} ${declaration.name.name} ` +
            `takes ${parameterList(declaration.parameters)} returns ${declaration.returns.name}`,
          parameters: declaration.parameters,
          type: declaration.returns.name,
          constant: declaration.constant,
        },
      ]
  }
}

export function indexJassDocument(uri: string, program: JassProgram): JassDocumentIndex {
  const globals = program.declarations.flatMap(declaration => declarationSymbols(uri, declaration))
  const functions = program.declarations.flatMap((declaration): JassFunctionScope[] => {
    if (declaration.kind !== 'function') return []
    const symbols = new Map<string, JassSymbol>()
    for (const parameter of declaration.parameters)
      symbols.set(parameter.name.name, {
        name: parameter.name.name,
        kind: 'parameter',
        uri,
        nameSpan: { start: parameter.name.start, end: parameter.name.end },
        span: { start: parameter.start, end: parameter.end },
        signature: `${parameter.type.name} ${parameter.name.name}`,
        type: parameter.type.name,
        owner: declaration.name.name,
      })
    for (const variable of declaration.locals)
      symbols.set(variable.name.name, {
        name: variable.name.name,
        kind: 'local',
        uri,
        nameSpan: { start: variable.name.start, end: variable.name.end },
        span: { start: variable.start, end: variable.end },
        signature: `local ${variable.type.name}${variable.array ? ' array' : ''} ${variable.name.name}`,
        type: variable.type.name,
        owner: declaration.name.name,
      })
    return [{ name: declaration.name.name, span: { start: declaration.start, end: declaration.end }, symbols }]
  })
  return { uri, program, globals, functions }
}

/** The global table of a workspace: a later document's declaration does not replace an earlier one. */
export function globalTable(indexes: readonly JassDocumentIndex[]): ReadonlyMap<string, JassSymbol> {
  const table = new Map<string, JassSymbol>()
  for (const index of indexes)
    for (const symbol of index.globals) if (!table.has(symbol.name)) table.set(symbol.name, symbol)
  return table
}

/** The function around `offset`: functions are in source order, so a binary search finds it. */
export function functionAt(index: JassDocumentIndex, offset: number): JassFunctionScope | undefined {
  const scopes = index.functions
  let low = 0
  let high = scopes.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const scope = scopes[middle]!
    if (offset < scope.span.start) high = middle - 1
    else if (offset > scope.span.end) low = middle + 1
    else return scope
  }
  return undefined
}

/** What `name` means at `offset` of `index`: a parameter or local first, then a global. */
export function resolveJassName(
  index: JassDocumentIndex,
  globals: ReadonlyMap<string, JassSymbol>,
  name: string,
  offset: number,
): JassSymbol | undefined {
  return functionAt(index, offset)?.symbols.get(name) ?? globals.get(name)
}
