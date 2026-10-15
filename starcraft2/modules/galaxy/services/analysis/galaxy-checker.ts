import * as gt from '../../language-core/types.js'
import { createDiagnosticForNode, forEachChild, getKindName } from '../../language-core/utils.js'

export interface CheckSourceFileOptions {
  resolveGlobalDeclaration?: (name: string) => gt.Declaration | undefined
}

interface FunctionMeta {
  name: string
  returnType: string
  parameters: string[]
  declaration: gt.FunctionDeclaration
}

type Scope = Map<string, string>

export function checkSourceFile(sourceFile: gt.SourceFile, options: CheckSourceFileOptions = {}): gt.Diagnostic[] {
  const diagnostics: gt.Diagnostic[] = []
  const globals = new Map<string, string>()
  const functions = new Map<string, FunctionMeta>()

  for (const stmt of sourceFile.statements ?? []) {
    if (stmt.kind === gt.SyntaxKind.VariableDeclaration) {
      const decl = stmt as gt.VariableDeclaration
      globals.set(decl.name.name, typeName(decl.type))
    } else if (stmt.kind === gt.SyntaxKind.FunctionDeclaration) {
      const decl = stmt as gt.FunctionDeclaration
      functions.set(decl.name.name, {
        name: decl.name.name,
        returnType: typeName(decl.type),
        parameters: Array.from(decl.parameters ?? []).map(param => typeName(param.type)),
        declaration: decl,
      })
    }
  }

  for (const stmt of sourceFile.statements ?? []) checkNode(stmt, [globals], undefined)
  return diagnostics

  function checkNode(node: gt.Node, scopes: Scope[], currentFunction: FunctionMeta | undefined): void {
    if (node.kind === gt.SyntaxKind.FunctionDeclaration) {
      const fn = node as gt.FunctionDeclaration
      const local = new Map<string, string>()
      for (const param of fn.parameters ?? []) local.set(param.name.name, typeName(param.type))
      for (const statement of fn.body?.statements ?? []) checkNode(statement, [local, ...scopes], functions.get(fn.name.name))
      return
    }

    if (node.kind === gt.SyntaxKind.VariableDeclaration) {
      const decl = node as gt.VariableDeclaration
      const declared = typeName(decl.type)
      if (decl.initializer) {
        const actual = expressionType(decl.initializer, scopes)
        if (!isAssignable(declared, actual)) {
          diagnostics.push(createDiagnosticForNode(
            decl.initializer,
            gt.DiagnosticCategory.Error,
            `Type '${actual}' is not assignable to '${declared}'.`,
          ))
        }
      }
      scopes[0]?.set(decl.name.name, declared)
      return
    }

    if (node.kind === gt.SyntaxKind.ReturnStatement && currentFunction) {
      const stmt = node as gt.ReturnStatement
      const actual = stmt.expression ? expressionType(stmt.expression, scopes) : 'void'
      if (!isAssignable(currentFunction.returnType, actual)) {
        diagnostics.push(createDiagnosticForNode(
          stmt.expression ?? stmt,
          gt.DiagnosticCategory.Error,
          `Type '${actual}' is not assignable to return type '${currentFunction.returnType}'.`,
        ))
      }
      return
    }

    if (node.kind === gt.SyntaxKind.ExpressionStatement) {
      const expr = (node as gt.ExpressionStatement).expression
      if (expr.kind === gt.SyntaxKind.BinaryExpression) {
        checkAssignment(expr as gt.BinaryExpression, scopes)
      } else {
        expressionType(expr, scopes)
      }
      return
    }

    if (node.kind === gt.SyntaxKind.CallExpression) {
      expressionType(node as gt.Expression, scopes)
      return
    }

    forEachChild(node, (child): undefined => {
      checkNode(child, scopes, currentFunction)
      return undefined
    })
  }

  function checkAssignment(expr: gt.BinaryExpression, scopes: Scope[]): void {
    if ((expr.operatorToken.kind as gt.SyntaxKind) !== gt.SyntaxKind.EqualsToken) {
      expressionType(expr, scopes)
      return
    }
    const left = expressionType(expr.left, scopes)
    const right = expressionType(expr.right, scopes)
    if (!isAssignable(left, right)) {
      diagnostics.push(createDiagnosticForNode(
        expr.right,
        gt.DiagnosticCategory.Error,
        `Type '${right}' is not assignable to '${left}'.`,
      ))
    }
  }

  function expressionType(expr: gt.Expression, scopes: Scope[]): string {
    switch (expr.kind) {
      case gt.SyntaxKind.NumericLiteral:
        return String((expr as gt.NumericLiteral).text ?? '').includes('.') ? 'fixed' : 'int'
      case gt.SyntaxKind.StringLiteral:
        return 'string'
      case gt.SyntaxKind.TrueKeyword:
      case gt.SyntaxKind.FalseKeyword:
        return 'bool'
      case gt.SyntaxKind.NullKeyword:
        return 'null'
      case gt.SyntaxKind.Identifier:
        return resolveIdentifierType((expr as gt.Identifier).name, scopes)
      case gt.SyntaxKind.ParenthesizedExpression:
        return expressionType((expr as gt.ParenthesizedExpression).expression, scopes)
      case gt.SyntaxKind.PrefixUnaryExpression: {
        const prefix = expr as gt.PrefixUnaryExpression
        if (prefix.operator.kind === gt.SyntaxKind.ExclamationToken) return 'bool'
        return expressionType(prefix.operand, scopes)
      }
      case gt.SyntaxKind.BinaryExpression:
        return binaryExpressionType(expr as gt.BinaryExpression, scopes)
      case gt.SyntaxKind.CallExpression:
        return callExpressionType(expr as gt.CallExpression, scopes)
      default:
        return 'unknown'
    }
  }

  function binaryExpressionType(expr: gt.BinaryExpression, scopes: Scope[]): string {
    const op = expr.operatorToken.kind as gt.SyntaxKind
    const left = expressionType(expr.left, scopes)
    const right = expressionType(expr.right, scopes)
    if (
      op === gt.SyntaxKind.EqualsEqualsToken ||
      op === gt.SyntaxKind.ExclamationEqualsToken ||
      op === gt.SyntaxKind.LessThanToken ||
      op === gt.SyntaxKind.LessThanEqualsToken ||
      op === gt.SyntaxKind.GreaterThanToken ||
      op === gt.SyntaxKind.GreaterThanEqualsToken ||
      op === gt.SyntaxKind.AmpersandAmpersandToken ||
      op === gt.SyntaxKind.BarBarToken
    ) return 'bool'
    if (op === gt.SyntaxKind.PlusToken && (left === 'string' || right === 'string')) return 'string'
    if (left === 'fixed' || right === 'fixed') return 'fixed'
    if (left === 'int' && right === 'int') return 'int'
    return left !== 'unknown' ? left : right
  }

  function callExpressionType(expr: gt.CallExpression, scopes: Scope[]): string {
    const name = expressionName(expr.expression)
    if (!name) return 'unknown'
    const fn = functions.get(name) ?? functionFromExternalDeclaration(name)
    if (!fn) return 'unknown'
    const args = Array.from(expr.arguments ?? [])
    if (args.length !== fn.parameters.length) {
      diagnostics.push(createDiagnosticForNode(
        expr,
        gt.DiagnosticCategory.Error,
        `Function '${name}' expects ${fn.parameters.length} argument(s), got ${args.length}.`,
      ))
    }
    for (let i = 0; i < Math.min(args.length, fn.parameters.length); i++) {
      const actual = expressionType(args[i]!, scopes)
      const expected = fn.parameters[i]!
      if (!isAssignable(expected, actual)) {
        diagnostics.push(createDiagnosticForNode(
          args[i]!,
          gt.DiagnosticCategory.Error,
          `Argument ${i + 1} of '${name}' expects '${expected}', got '${actual}'.`,
        ))
      }
    }
    return fn.returnType
  }

  function functionFromExternalDeclaration(name: string): FunctionMeta | undefined {
    const decl = options.resolveGlobalDeclaration?.(name)
    if (decl?.kind !== gt.SyntaxKind.FunctionDeclaration) return undefined
    const fn = decl as gt.FunctionDeclaration
    return {
      name,
      returnType: typeName(fn.type),
      parameters: Array.from(fn.parameters ?? []).map(param => typeName(param.type)),
      declaration: fn,
    }
  }
}

function resolveIdentifierType(name: string, scopes: Scope[]): string {
  for (const scope of scopes) {
    const type = scope.get(name)
    if (type) return type
  }
  if (name === 'true' || name === 'false') return 'bool'
  if (name === 'null') return 'null'
  return 'unknown'
}

function expressionName(expr: gt.Expression): string | undefined {
  if (expr.kind === gt.SyntaxKind.Identifier) return (expr as gt.Identifier).name
  if (expr.kind === gt.SyntaxKind.PropertyAccessExpression) return (expr as gt.PropertyAccessExpression).name.name
  return undefined
}

function isAssignable(expected: string, actual: string): boolean {
  if (expected === 'unknown' || actual === 'unknown') return true
  if (actual === 'null') return isNullable(expected)
  if (expected === actual) return true
  if (expected === 'fixed' && actual === 'int') return true
  if (expected === 'int' && actual === 'byte') return true
  return false
}

function isNullable(type: string): boolean {
  return !['void', 'bool', 'byte', 'char', 'int', 'fixed', 'string', 'text'].includes(type)
}

function typeName(node: gt.TypeNode | undefined): string {
  if (!node) return 'unknown'
  if (node.kind === gt.SyntaxKind.Identifier) return (node as gt.Identifier).name
  if (node.kind === gt.SyntaxKind.ArrayType) return `${typeName((node as gt.ArrayTypeNode).elementType)}[]`
  const name = getKindName(node.kind)
  return name.replace(/Keyword$/, '').toLowerCase()
}
