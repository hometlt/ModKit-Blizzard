/** Bounded, declaration-driven checks for a conversion's script/header pair.
 * This is not a linker or an execution engine: missing includes remain explicit.
 */
import { Parser, SyntaxKind as K, tokenToString, stringToToken, isKeywordTypeKind, forEachChild, isAssignmentOperator, isComparisonOperator, getKeywordType, getBinaryResultType, LiteralType, TypeFlags } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import type { AbstractType } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import { resolveGalaxyTypeAliases } from './internal/galaxy-type-resolution.js';

interface InputFile { fileName: string; text: string }
interface SymbolInfo { type: string; parameters?: string[]; constant?: boolean; node?: any; fileName?: string }
interface Finding { code: string; severity: 'error' | 'warning'; message: string; details: { fileName: string; start: number; end: number; symbol?: string } }
type Scope = Map<string, SymbolInfo>;

function typeName(node: any): string {
  if (!node) return 'unknown';
  if (node.returnType && node.typeArguments) return `${typeName(node.returnType)}<${node.typeArguments.map(typeName).join(',')}>`;
  if (node.kind === K.ArrayType) return `${typeName(node.elementType)}[]`;
  if (node.kind === K.Identifier) return typeof node.name === 'string' && node.name ? node.name : 'unknown';
  if (node.kind === K.TypeReference) return node.typeName?.name ?? 'unknown';
  return isKeywordTypeKind(node.kind) ? tokenToString(node.kind)! : 'unknown';
}

export function validateGalaxyPair(primary: InputFile[], declarations: InputFile[] = [], strictSymbols = false) {
  const parser = new Parser();
  const sources = [...declarations.map(file => ({ ...file, external: true })), ...primary.map(file => ({ ...file, external: false }))]
    .map(file => ({ ...file, ast: parser.parseFile(file.fileName, file.text) }));
  const globals: Scope = new Map(), structures = new Map<string, Scope>();
  resolveGalaxyTypeAliases(sources.flatMap(source => [...source.ast.statements]));
  const diagnostics: Finding[] = [];
  const reported = new Set<string>(), unresolved = new Set<string>();
  let omitted = 0, errors = 0, uncheckedTypes = 0;
  const primaryDefinitions = new Set<string>();
  const declaredSymbols = new Set<string>();
  const report = (code: string, node: any, fileName: string, message: string, symbol?: string, missing = false) => {
    const key = `${code}:${fileName}:${node?.pos}:${symbol ?? ''}`;
    if (reported.has(key)) return;
    reported.add(key);
    const severity = missing && !strictSymbols ? 'warning' : 'error';
    if (severity === 'error') errors++;
    if (diagnostics.length >= 1000) { omitted++; return; }
    diagnostics.push({ code: `sc2-triggers/${code}`, severity, message, details: { fileName, start: Math.max(0, node?.pos ?? 0), end: Math.max(0, node?.end ?? 0), ...(symbol ? { symbol } : {}) } });
  };
  const symbolFor = (node: any, fileName: string): SymbolInfo => ({
    type: typeName(node.type), node, fileName,
    ...(node.kind === K.FunctionDeclaration ? { parameters: [...node.parameters].map(p => typeName(p.type)) } : {}),
    constant: node.modifiers?.some((m: any) => m.kind === K.ConstKeyword),
  });
  for (const source of sources) {
    for (const diagnostic of source.ast.parseDiagnostics) report('galaxy-syntax', { pos: diagnostic.start ?? 0, end: (diagnostic.start ?? 0) + (diagnostic.length ?? 0) }, source.fileName, diagnostic.messageText ?? 'Invalid Galaxy syntax');
    for (const node of source.ast.statements as any) {
      if (node.kind === K.StructDeclaration) {
        structures.set(node.name.name, new Map([...node.members].map((member: any) => [member.name.name, symbolFor(member, source.fileName)])));
      } else if (node.kind === K.VariableDeclaration || node.kind === K.FunctionDeclaration) {
        const name = node.name.name, info = symbolFor(node, source.fileName), existing = globals.get(name);
        if (!source.external) declaredSymbols.add(name);
        if (!source.external && (node.kind === K.VariableDeclaration || node.body)) {
          if (primaryDefinitions.has(name)) report('galaxy-duplicate-definition', node, source.fileName, `Duplicate definition of '${name}'.`, name);
          primaryDefinitions.add(name);
        }
        if (existing && (existing.type !== info.type || JSON.stringify(existing.parameters) !== JSON.stringify(info.parameters))) {
          report('galaxy-signature-conflict', node, source.fileName, `Conflicting declarations for '${name}'.`, name);
        }
        globals.set(name, info);
      }
    }
  }
  // Use the language core's singleton types and predicates. The declaration
  // walker remains bounded and can explicitly defer unavailable named types.
  const coreTypes = new Map<string, AbstractType | undefined>();
  const coreType = (name: string): AbstractType | undefined => {
    if (!coreTypes.has(name)) {
      const kind = name === 'null' ? K.NullKeyword : stringToToken(name);
      coreTypes.set(name, kind === undefined ? undefined : getKeywordType(kind));
    }
    return coreTypes.get(name);
  };
  const expressionTypes = new WeakMap<object, AbstractType>();
  const assignable = (expected: string, actual: string, actualNode?: any) => {
    if (expected === 'unknown' || actual === 'unknown') return true;
    const target = coreType(expected), value = expressionTypes.get(actualNode ?? {}) ?? coreType(actual);
    if (target && value) return value.isAssignableTo(target);
    if (actual === 'null') return expected.startsWith('funcref<');
    return expected === actual || expected === `structref<${actual}>`;
  };
  const lookup = (name: string, scopes: Scope[]) => { for (const scope of scopes) { const found = scope.get(name); if (found) return found; } return globals.get(name); };
  for (const source of sources.filter(file => !file.external)) {
    const mismatch = (expected: string, actual: string, node: any, label: string, actualNode = node) => {
      if (expected === 'unknown' || actual === 'unknown') uncheckedTypes++;
      if (!assignable(expected, actual, actualNode)) report('galaxy-type-mismatch', node, source.fileName, `${label} expects '${expected}', got '${actual}'.`);
    };
    const resolve = (node: any, scopes: Scope[]): SymbolInfo | undefined => {
      const value = lookup(node.name, scopes);
      if (!value) {
        unresolved.add(node.name);
        report('galaxy-unresolved-symbol', node, source.fileName, `No loaded declaration for '${node.name}'.`, node.name, true);
      }
      return value;
    };
    const inferExpression = (node: any, scopes: Scope[]): string => {
      if (!node) return 'unknown';
      switch (node.kind) {
        case K.Identifier: return resolve(node, scopes)?.type ?? 'unknown';
        case K.NumericLiteral: {
          const fixed = (node.text ?? '').includes('.');
          expressionTypes.set(node, new LiteralType(TypeFlags.NumericLiteral | (fixed ? TypeFlags.Fixed : TypeFlags.Integer), node));
          return fixed ? 'fixed' : 'int';
        }
        case K.StringLiteral:
          expressionTypes.set(node, new LiteralType(TypeFlags.StringLiteral | TypeFlags.String | TypeFlags.Nullable, node));
          return 'string';
        case K.TrueKeyword: case K.FalseKeyword: return 'bool';
        case K.NullKeyword: return 'null';
        case K.ParenthesizedExpression: {
          const type = expression(node.expression, scopes), value = expressionTypes.get(node.expression);
          if (value) expressionTypes.set(node, value);
          return type;
        }
        case K.CallExpression: {
          const fn = node.expression.kind === K.Identifier ? resolve(node.expression, scopes) : undefined;
          if (node.expression.kind !== K.Identifier) expression(node.expression, scopes);
          const args = [...node.arguments].map(arg => expression(arg, scopes));
          if (fn?.parameters) {
            if (args.length !== fn.parameters.length) report('galaxy-call-arity', node, source.fileName, `Function '${node.expression.name}' expects ${fn.parameters.length} argument(s), got ${args.length}.`, node.expression.name);
            args.forEach((actual, i) => { if (fn.parameters![i]) mismatch(fn.parameters![i], actual, node.arguments[i], `Argument ${i + 1} of '${node.expression.name}'`); });
          } else if (fn && fn.type !== 'unknown' && !fn.type.startsWith('funcref')) report('galaxy-not-callable', node, source.fileName, `'${node.expression.name}' is not a function.`, node.expression.name);
          return fn?.parameters ? fn.type : 'unknown';
        }
        case K.ElementAccessExpression: {
          const type = expression(node.expression, scopes);
          mismatch('int', expression(node.argumentExpression, scopes), node.argumentExpression, 'Array index');
          return type.endsWith('[]') ? type.slice(0, -2) : 'unknown';
        }
        case K.PropertyAccessExpression: {
          const type = expression(node.expression, scopes), structure = structures.get(/^structref<(.+)>$/u.exec(type)?.[1] ?? type);
          const member = structure?.get(node.name.name);
          if (structure && !member) report('galaxy-unknown-member', node.name, source.fileName, `Type '${type}' has no member '${node.name.name}'.`, node.name.name);
          return member?.type ?? 'unknown';
        }
        case K.BinaryExpression: {
          const left = expression(node.left, scopes), right = expression(node.right, scopes), op = node.operatorToken.kind;
          if (isAssignmentOperator(op)) {
            mismatch(left, right, node.right, 'Assignment');
            if (node.left.kind === K.Identifier && lookup(node.left.name, scopes)?.constant) report('galaxy-constant-write', node.left, source.fileName, `Cannot assign to constant '${node.left.name}'.`, node.left.name);
            return left;
          }
          if ([K.AmpersandAmpersandToken, K.BarBarToken].includes(op)) {
            mismatch('bool', left, node.left, 'Logical operand');
            mismatch('bool', right, node.right, 'Logical operand');
            return 'bool';
          }
          const leftType = expressionTypes.get(node.left), rightType = expressionTypes.get(node.right);
          if (isComparisonOperator(op)) {
            if (leftType && rightType) {
              if (!rightType.isComparableTo(leftType)) report('galaxy-type-mismatch', node.right, source.fileName, `Cannot compare '${left}' with '${right}'.`);
            } else uncheckedTypes++;
            return 'bool';
          }
          if (!leftType || !rightType) { uncheckedTypes++; return 'unknown'; }
          if (!leftType.isValidBinaryOperation(op, rightType)) report('galaxy-type-mismatch', node, source.fileName, `Operator '${tokenToString(op)}' is not supported between '${left}' and '${right}'.`);
          const result = getBinaryResultType(leftType, rightType, op);
          expressionTypes.set(node, result);
          return result.flags & TypeFlags.Fixed ? 'fixed' : result.flags & TypeFlags.Integer ? 'int' : left;
        }
        case K.PrefixUnaryExpression: case K.PostfixUnaryExpression: {
          const operand = expression(node.operand, scopes);
          const value = expressionTypes.get(node.operand);
          if (value) {
            if (node.kind === K.PrefixUnaryExpression && !value.isValidPrefixOperation(node.operator.kind)) report('galaxy-type-mismatch', node, source.fileName, `Prefix '${tokenToString(node.operator.kind)}' is not supported for '${operand}'.`);
            // The existing core checker preserves the operand type for unary
            // expressions, including !; do not invent a separate conversion rule.
            expressionTypes.set(node, value);
          } else uncheckedTypes++;
          return operand;
        }
        case K.TypeAssertionExpression: expression(node.expression, scopes); return typeName(node.type);
        default: uncheckedTypes++; return 'unknown';
      }
    };
    const definitelyReturns = (node: any): boolean => {
      if (!node) return false;
      if (node.kind === K.ReturnStatement) return true;
      if (node.kind === K.Block) return [...node.statements].some(definitelyReturns);
      return node.kind === K.IfStatement && definitelyReturns(node.thenStatement) && definitelyReturns(node.elseStatement);
    };
    const expression = (node: any, scopes: Scope[]): string => {
      const name = inferExpression(node, scopes);
      if (node && !expressionTypes.has(node)) {
        const value = coreType(name);
        if (value) expressionTypes.set(node, value);
      }
      return name;
    };
    const condition = (node: any, scopes: Scope[], label: string) => {
      const name = expression(node, scopes), value = expressionTypes.get(node);
      if (!value) uncheckedTypes++;
      else if (!value.isBoolExpression(false)) report('galaxy-type-mismatch', node, source.fileName, `${label} cannot use '${name}' as a boolean expression.`);
    };
    const walk = (node: any, scopes: Scope[], returnType?: string, loopDepth = 0): void => {
      if (!node) return;
      switch (node.kind) {
        case K.IncludeStatement: case K.StructDeclaration: return;
        case K.FunctionDeclaration: {
          for (const parameter of node.parameters) declaredSymbols.add(parameter.name.name);
          const local: Scope = new Map([...node.parameters].map((param: any) => [param.name.name, symbolFor(param, source.fileName)]));
          if (node.body) {
            const functionReturnType = typeName(node.type);
            walk(node.body, [local], functionReturnType, 0);
            if (functionReturnType !== 'void' && !definitelyReturns(node.body)) {
              report('galaxy-missing-return', node.name, source.fileName, `Function '${node.name.name}' can complete without returning '${functionReturnType}'.`, node.name.name);
            }
          }
          return;
        }
        case K.Block: {
          const inner: Scope = new Map();
          for (const child of node.statements) walk(child, [inner, ...scopes], returnType, loopDepth);
          return;
        }
        case K.VariableDeclaration:
          declaredSymbols.add(node.name.name);
          for (let type = node.type; type?.kind === K.ArrayType; type = type.elementType) if (type.size) mismatch('int', expression(type.size, scopes), type.size, 'Array length');
          if (node.initializer) mismatch(typeName(node.type), expression(node.initializer, scopes), node.initializer, 'Initializer');
          if (scopes.length) scopes[0].set(node.name.name, symbolFor(node, source.fileName));
          return;
        case K.ReturnStatement:
          mismatch(returnType ?? 'unknown', node.expression ? expression(node.expression, scopes) : 'void', node, 'Return', node.expression); return;
        case K.ExpressionStatement: expression(node.expression, scopes); return;
        case K.IfStatement:
          condition(node.expression, scopes, 'Condition');
          walk(node.thenStatement, scopes, returnType, loopDepth); walk(node.elseStatement, scopes, returnType, loopDepth); return;
        case K.ForStatement: {
          const inner: Scope[] = [new Map(), ...scopes];
          if (node.initializer?.kind === K.VariableDeclaration) walk(node.initializer, inner, returnType);
          else if (node.initializer) expression(node.initializer, inner);
          if (node.condition) condition(node.condition, inner, 'Loop condition');
          if (node.incrementor) expression(node.incrementor, inner);
          walk(node.statement, inner, returnType, loopDepth + 1); return;
        }
        case K.WhileStatement: case K.DoStatement:
          condition(node.expression, scopes, 'Loop condition');
          walk(node.statement, scopes, returnType, loopDepth + 1); return;
        case K.BreakStatement: case K.ContinueStatement:
          if (loopDepth === 0) report('galaxy-loop-control', node, source.fileName, `${node.kind === K.BreakStatement ? 'break' : 'continue'} used outside a loop.`);
          return;
        default: forEachChild(node, child => { walk(child, scopes, returnType, loopDepth); return undefined; });
      }
    };
    for (const node of source.ast.statements) walk(node, []);
  }
  return { diagnostics, declaredSymbols: [...declaredSymbols], verification: { status: errors ? 'failed' : unresolved.size || omitted || uncheckedTypes ? 'incomplete' : 'passed', errors, unresolvedSymbols: [...unresolved].sort(), uncheckedTypes, diagnosticsOmitted: omitted, declarationFiles: declarations.map(file => file.fileName) } };
}

