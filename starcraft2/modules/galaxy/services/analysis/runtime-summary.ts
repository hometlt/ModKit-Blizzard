/** Runtime inspection and authored validation share the canonical Galaxy parser. */
import { parseGalaxySource } from './source.js'
import { SyntaxKind, type Block, type FunctionDeclaration, type IncludeStatement,
  type Node, type Statement } from '../../language-core/types.js'

export function scanGalaxySource(text: string, budget: Readonly<{ maxNodes: number; maxDepth: number }>) {
  const source = parseGalaxySource(text, { preserveSourceText: false })
  if (source.parseDiagnostics.length > 0)
    throw new TypeError(`Galaxy source has ${source.parseDiagnostics.length} syntax error(s)`)
  const functions: { name: string; parameters: number }[] = []
  const includes: string[] = []
  let maximumDepth = 0
  const visit = (statement: Statement, depth: number): void => {
    if (statement.kind === SyntaxKind.Block) {
      const nextDepth = depth + 1
      maximumDepth = Math.max(maximumDepth, nextDepth)
      if (nextDepth > budget.maxDepth) throw new RangeError('Galaxy blocks exceed maxDepth budget')
      for (const child of (statement as Block).statements) visit(child, nextDepth)
      return
    }
    if (statement.kind === SyntaxKind.FunctionDeclaration) {
      const func = statement as FunctionDeclaration
      functions.push({ name: func.name.name, parameters: func.parameters.length })
      if (functions.length > budget.maxNodes)
        throw new RangeError('Galaxy declarations exceed maxNodes budget')
      if (func.body) visit(func.body, depth)
      return
    }
    if (statement.kind === SyntaxKind.IncludeStatement) {
      includes.push((statement as IncludeStatement).path.value ?? '')
      return
    }
    // Walk statements only. Expression trees cannot introduce Galaxy block depth.
    for (const value of Object.values(statement as unknown as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)
          && 'kind' in value && 'pos' in value && value !== (statement as Node).parent)
        if ('statements' in value || 'thenStatement' in value || 'statement' in value)
          visit(value as unknown as Statement, depth)
    }
  }
  for (const statement of source.statements) visit(statement, 0)
  return Object.freeze({ functions: Object.freeze(functions.map(item => Object.freeze(item))),
    includes: Object.freeze(includes), maximumDepth })
}
