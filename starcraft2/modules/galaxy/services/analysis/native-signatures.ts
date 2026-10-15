/** Exact Galaxy native signature inventory from the one language parser. No executable claim. */
import { parseGalaxySource, printGalaxyNode } from './source.js'
import { SyntaxKind, type FunctionDeclaration, type SourceFile } from '../../language-core/types.js'

export interface GalaxyNativeSignature {
  readonly name: string
  readonly returnType: string
  readonly parameters: readonly Readonly<{ name: string; type: string }>[]
  readonly line: number
  readonly fragment: string
  readonly admission: 'unmapped-native'
}

export function inventoryGalaxyNativeSignatures(text: string, file = 'natives.galaxy') {
  const source = parseGalaxySource(text, { fileName: file, preserveSourceText: false })
  return inventoryParsedGalaxyNativeSignatures(source, text)
}

/** Reuses an already parsed subject when the Galaxy codec exposes this through an operation. */
export function inventoryParsedGalaxyNativeSignatures(source: SourceFile, text: string) {
  if (source.parseDiagnostics.length > 0)
    throw new TypeError(`Galaxy native inventory has ${source.parseDiagnostics.length} syntax error(s)`)
  const signatures: GalaxyNativeSignature[] = []
  const names = new Set<string>()
  let functionDeclarations = 0
  for (const statement of source.statements) {
    if (statement.kind !== SyntaxKind.FunctionDeclaration) continue
    functionDeclarations++
    const func = statement as FunctionDeclaration
    if (!func.modifiers?.some(modifier => modifier.kind === SyntaxKind.NativeKeyword)) continue
    if (names.has(func.name.name)) throw new TypeError(`duplicate Galaxy native ${func.name.name}`)
    names.add(func.name.name)
    signatures.push(Object.freeze({
      name: func.name.name,
      returnType: printGalaxyNode(func.type).trim(),
      parameters: Object.freeze(func.parameters.map(parameter => Object.freeze({
        name: parameter.name.name, type: printGalaxyNode(parameter.type).trim(),
      }))),
      line: func.line + 1,
      fragment: text.slice(func.pos, func.end),
      admission: 'unmapped-native' as const,
    }))
  }
  return Object.freeze({ file: source.fileName, functionDeclarations,
    signatures: Object.freeze(signatures) })
}
