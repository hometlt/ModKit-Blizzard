/**
 * Converts a parsed Galaxy source file (sc2-galaxy-lang SourceFile AST) into EngineAst.
 *
 * ## Entry points
 *
 *   galaxySourceToEngineProgram(source, options)  → EngineProgram
 *   galaxySourceToEngineModule(source, options)   → EngineModule
 *
 * ## Coverage
 *
 *   globals, functions, parameters, local variable declarations,
 *   expression statements, assignment statements, return / break / continue,
 *   if statements, while statements, call expressions, unary / binary expressions,
 *   property access, element access, struct declarations, includes → module imports.
 *
 * ## Control-flow lowering
 *
 *   Galaxy for-statement  → [init]; while (cond) { body; increment }, with increment before continue.
 *   Galaxy do-while       → while (true) { body; if (cond) {} else { break; } }, also checking cond before continue.
 *   Continuation prefixes belong only to the innermost loop; no new Engine node kinds are needed.
 *
 * ## Galaxy for-loop parsing quirk
 *
 * sc2-galaxy-lang's for-loop parser only accepts expressions in the initializer
 * position — type declarations (`int i = 1`) fail silently, producing kind:0
 * (Unknown) nodes for all for-loop children. Real SC2 Galaxy always pre-declares
 * the variable: `int i; for (i = 1; ...)`. Tests and production code must follow
 * this pattern.
 *
 * ## Raw fallback
 *
 * Unsupported syntax nodes emit an EngineRawStatement(language:'galaxy') so the
 * source text is preserved in the AST for analysis tools. The runtime interpreter
 * throws on raw statements — use them only for offline analysis, not execution.
 */

import { SyntaxKind } from '../../language-core/types.js';
import { getKindName } from '../../language-core/utils.js';
import type {
  Block,
  CallExpression,
  DoStatement,
  ElementAccessExpression,
  Expression,
  ExpressionStatement,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  Node,
  ParameterDeclaration,
  ParenthesizedExpression,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  ReturnStatement,
  SourceFile,
  Statement,
  StructDeclaration,
  VariableDeclaration,
  WhileStatement,
} from '../../language-core/types.js';
import type {
  EngineExpression,
  EngineFunction,
  EngineModule,
  EngineProgram,
  EngineSourceRef,
  EngineStatement,
  EngineTypeRef,
  EngineVariable,
} from './to-engine-types.js';

import { printGalaxyNode } from './source.js';

export interface GalaxyToEngineOptions {
  moduleId?: string;
  moduleName?: string;
  includeRawFallbacks?: boolean;
}

export function galaxySourceToEngineProgram(
  sourceFile: SourceFile,
  options: GalaxyToEngineOptions = {},
): EngineProgram {
  return {
    kind: 'EngineProgram',
    modules: [galaxySourceToEngineModule(sourceFile, options)],
  };
}

export function galaxySourceToEngineModule(
  sourceFile: SourceFile,
  options: GalaxyToEngineOptions = {},
): EngineModule {
  const ctx: GalaxyEngineCtx = {
    sourceFile,
    moduleId: options.moduleId ?? sourceFile.fileName,
    includeRawFallbacks: options.includeRawFallbacks ?? true,
  };

  return {
    kind: 'EngineModule',
    id: ctx.moduleId,
    name: options.moduleName,
    imports: sourceFile.statements
      .filter((stmt) => stmt.kind === SyntaxKind.IncludeStatement)
      .map((stmt: any) => ({
        moduleId: stmt.path?.text?.replace(/"/g, '') ?? printGalaxyNode(stmt),
        source: sourceRef(ctx, stmt, 'IncludeStatement'),
      })),
    globals: sourceFile.statements
      .filter((stmt): stmt is VariableDeclaration => stmt.kind === SyntaxKind.VariableDeclaration)
      .map((variable) => variableToEngine(variable, 'global', ctx)),
    functions: sourceFile.statements
      .filter((stmt): stmt is FunctionDeclaration => stmt.kind === SyntaxKind.FunctionDeclaration)
      .map((func) => functionToEngine(func, ctx)),
    triggers: [],
    structs: sourceFile.statements
      .filter((stmt): stmt is StructDeclaration => stmt.kind === SyntaxKind.StructDeclaration)
      .map((structure) => ({
        kind: 'EngineStruct' as const,
        id: identifierName(structure.name),
        name: identifierName(structure.name),
        fields: (structure.members ?? []).map((member: any) => ({
          kind: 'EngineVariable' as const,
          id: identifierName(member.name),
          name: identifierName(member.name),
          type: typeRef(member.type),
          scope: 'struct-field' as const,
          source: sourceRef(ctx, member, 'PropertyDeclaration'),
        })),
        source: sourceRef(ctx, structure, 'StructDeclaration'),
      })),
    source: sourceRef(ctx, sourceFile, 'SourceFile'),
  };
}

interface GalaxyEngineCtx {
  sourceFile: SourceFile;
  moduleId: string;
  includeRawFallbacks: boolean;
  /** Statements needed before a continue targeting the current loop. */
  continuePrefix?: readonly EngineStatement[];
}

function functionToEngine(func: FunctionDeclaration, ctx: GalaxyEngineCtx): EngineFunction {
  return {
    kind: 'EngineFunction',
    id: identifierName(func.name),
    name: identifierName(func.name),
    returnType: typeRef(func.type),
    parameters: (func.parameters ?? []).map((param) => parameterToEngine(param, ctx)),
    locals: collectLocalVariables(func.body, ctx),
    body: func.body ? blockStatements(func.body, ctx) : [],
    flags: {
      native: hasModifier(func, SyntaxKind.NativeKeyword),
      hasBody: func.body !== undefined,
    },
    source: sourceRef(ctx, func, 'FunctionDeclaration'),
  };
}

function collectLocalVariables(body: Block | undefined, ctx: GalaxyEngineCtx): EngineVariable[] {
  if (!body) return [];
  return (body.statements ?? [])
    .filter((stmt): stmt is VariableDeclaration => stmt.kind === SyntaxKind.VariableDeclaration)
    .map((variable) => variableToEngine(variable, 'local', ctx));
}

function parameterToEngine(param: ParameterDeclaration, ctx: GalaxyEngineCtx): EngineVariable {
  return {
    kind: 'EngineVariable',
    id: identifierName(param.name),
    name: identifierName(param.name),
    type: typeRef(param.type),
    scope: 'parameter',
    source: sourceRef(ctx, param, 'ParameterDeclaration'),
  };
}

function variableToEngine(
  variable: VariableDeclaration,
  scope: EngineVariable['scope'],
  ctx: GalaxyEngineCtx,
): EngineVariable {
  return {
    kind: 'EngineVariable',
    id: identifierName(variable.name),
    name: identifierName(variable.name),
    type: typeRef(variable.type),
    scope,
    constant: hasModifier(variable, SyntaxKind.ConstKeyword),
    initialValue: variable.initializer ? expressionToEngine(variable.initializer, ctx) : undefined,
    source: sourceRef(ctx, variable, 'VariableDeclaration'),
  };
}

function blockStatements(block: Block, ctx: GalaxyEngineCtx): EngineStatement[] {
  return (block.statements ?? []).flatMap((stmt) => statementToEngine(stmt, ctx));
}

function statementToEngine(stmt: Statement, ctx: GalaxyEngineCtx): EngineStatement[] {
  switch (stmt.kind) {
    case SyntaxKind.Block:
      return [{
        kind: 'EngineBlockStatement',
        statements: blockStatements(stmt as Block, ctx),
        source: sourceRef(ctx, stmt, 'Block'),
      }];
    case SyntaxKind.VariableDeclaration:
      return [{
        kind: 'EngineVariableStatement',
        variable: variableToEngine(stmt as VariableDeclaration, 'local', ctx),
        source: sourceRef(ctx, stmt, 'VariableDeclaration'),
      }];
    case SyntaxKind.ExpressionStatement:
      return expressionStatementToEngine(stmt as ExpressionStatement, ctx);
    case SyntaxKind.IfStatement: {
      const ifStmt = stmt as IfStatement;
      return [{
        kind: 'EngineIfStatement',
        condition: expressionToEngine(ifStmt.expression, ctx),
        then: statementToBlockList(ifStmt.thenStatement, ctx),
        else: ifStmt.elseStatement ? statementToBlockList(ifStmt.elseStatement, ctx) : undefined,
        source: sourceRef(ctx, stmt, 'IfStatement'),
      }];
    }
    case SyntaxKind.WhileStatement: {
      const whileStmt = stmt as WhileStatement;
      return [{
        kind: 'EngineWhileStatement',
        condition: expressionToEngine(whileStmt.expression, ctx),
        body: statementToBlockList(whileStmt.statement, { ...ctx, continuePrefix: [] }),
        source: sourceRef(ctx, stmt, 'WhileStatement'),
      }];
    }
    case SyntaxKind.ReturnStatement: {
      const ret = stmt as ReturnStatement;
      return [{
        kind: 'EngineReturnStatement',
        value: ret.expression ? expressionToEngine(ret.expression, ctx) : undefined,
        source: sourceRef(ctx, stmt, 'ReturnStatement'),
      }];
    }
    case SyntaxKind.DoStatement: {
      // Keep the first iteration inside the loop. Continue takes the same bottom check.
      const doStmt = stmt as DoStatement;
      const source = sourceRef(ctx, stmt, 'DoStatement');
      const check: EngineStatement = {
        kind: 'EngineIfStatement',
        condition: expressionToEngine(doStmt.expression, ctx),
        then: [],
        else: [{ kind: 'EngineBreakStatement', source }],
        source,
      };
      const body = statementToBlockList(doStmt.statement, { ...ctx, continuePrefix: [check] });
      return [{
        kind: 'EngineWhileStatement',
        condition: { kind: 'EngineLiteralExpression', value: true, valueType: { name: 'bool' }, source },
        body: [...body, check],
        source,
      }];
    }
    case SyntaxKind.ForStatement: {
      // for (init; cond; incr) { body }
      //   →  [init]  while (cond ?? true) { body; incr }
      const forStmt = stmt as ForStatement;
      const src = sourceRef(ctx, stmt, 'ForStatement');
      const initStmts: EngineStatement[] = [];
      if (forStmt.initializer) {
        if (forStmt.initializer.kind === SyntaxKind.VariableDeclaration) {
          initStmts.push({
            kind: 'EngineVariableStatement',
            variable: variableToEngine(forStmt.initializer as VariableDeclaration, 'local', ctx),
            source: src,
          });
        } else {
          initStmts.push(...expressionStatementToEngine(
            { kind: SyntaxKind.ExpressionStatement, expression: forStmt.initializer,
              pos: forStmt.initializer.pos, end: forStmt.initializer.end } as ExpressionStatement,
            ctx,
          ));
        }
      }
      const condition: EngineExpression = forStmt.condition
        ? expressionToEngine(forStmt.condition, ctx)
        : { kind: 'EngineLiteralExpression', value: true };
      const incrStmts: EngineStatement[] = forStmt.incrementor
        ? expressionStatementToEngine(
            { kind: SyntaxKind.ExpressionStatement, expression: forStmt.incrementor,
              pos: forStmt.incrementor.pos, end: forStmt.incrementor.end } as ExpressionStatement,
            ctx,
          )
        : [];
      const body = statementToBlockList(forStmt.statement, { ...ctx, continuePrefix: incrStmts });
      return [
        ...initStmts,
        {
          kind: 'EngineWhileStatement',
          condition,
          body: [...body, ...incrStmts],
          source: src,
        },
      ];
    }
    case SyntaxKind.BreakStatement:
      return [{ kind: 'EngineBreakStatement', source: sourceRef(ctx, stmt, 'BreakStatement') }];
    case SyntaxKind.ContinueStatement:
      return [...(ctx.continuePrefix ?? []),
        { kind: 'EngineContinueStatement', source: sourceRef(ctx, stmt, 'ContinueStatement') }];
    default:
      return rawStatement(stmt, ctx);
  }
}

function expressionStatementToEngine(stmt: ExpressionStatement, ctx: GalaxyEngineCtx): EngineStatement[] {
  if (stmt.expression.kind === SyntaxKind.BinaryExpression) {
    const binary = stmt.expression as any;
    const operator = tokenText(binary.operatorToken?.kind);
    if (operator.endsWith('=')) {
      return [{
        kind: 'EngineAssignmentStatement',
        target: expressionToEngine(binary.left, ctx),
        value: expressionToEngine(binary.right, ctx),
        operator: ['=', '+=', '-=', '*=', '/='].includes(operator) ? operator as any : undefined,
        source: sourceRef(ctx, stmt, 'ExpressionStatement'),
      }];
    }
  }
  return [{
    kind: 'EngineExpressionStatement',
    expression: expressionToEngine(stmt.expression, ctx),
    source: sourceRef(ctx, stmt, 'ExpressionStatement'),
  }];
}

function statementToBlockList(stmt: Statement, ctx: GalaxyEngineCtx): EngineStatement[] {
  return stmt.kind === SyntaxKind.Block ? blockStatements(stmt as Block, ctx) : statementToEngine(stmt, ctx);
}

function expressionToEngine(expr: Expression, ctx: GalaxyEngineCtx): EngineExpression {
  switch (expr.kind) {
    case SyntaxKind.ParenthesizedExpression:
      // Grouping is already represented by the parsed child tree. Keep the child's
      // token span so literal lexemes and source diagnostics remain exact.
      return expressionToEngine((expr as ParenthesizedExpression).expression, ctx);
    case SyntaxKind.StringLiteral:
      return {
        kind: 'EngineLiteralExpression',
        value: (expr as any).text ?? (expr as any).value ?? '',
        valueType: { name: 'string' },
        source: sourceRef(ctx, expr, 'StringLiteral'),
      };
    case SyntaxKind.NumericLiteral:
      return {
        kind: 'EngineLiteralExpression',
        value: Number((expr as any).text ?? (expr as any).value ?? 0),
        valueType: { name: 'number' },
        source: sourceRef(ctx, expr, 'NumericLiteral'),
      };
    case SyntaxKind.TrueKeyword:
      return { kind: 'EngineLiteralExpression', value: true, valueType: { name: 'bool' }, source: sourceRef(ctx, expr, 'TrueKeyword') };
    case SyntaxKind.FalseKeyword:
      return { kind: 'EngineLiteralExpression', value: false, valueType: { name: 'bool' }, source: sourceRef(ctx, expr, 'FalseKeyword') };
    case SyntaxKind.NullKeyword:
      return { kind: 'EngineLiteralExpression', value: null, source: sourceRef(ctx, expr, 'NullKeyword') };
    case SyntaxKind.Identifier:
      return {
        kind: 'EngineIdentifierExpression',
        name: identifierName(expr as Identifier),
        source: sourceRef(ctx, expr, 'Identifier'),
      };
    case SyntaxKind.CallExpression: {
      const call = expr as CallExpression;
      return {
        kind: 'EngineCallExpression',
        callee: { name: expressionName(call.expression), moduleId: ctx.moduleId },
        args: (call.arguments ?? []).map((arg) => expressionToEngine(arg, ctx)),
        source: sourceRef(ctx, expr, 'CallExpression'),
      };
    }
    case SyntaxKind.PropertyAccessExpression: {
      const access = expr as PropertyAccessExpression;
      return {
        kind: 'EngineMemberExpression',
        object: expressionToEngine(access.expression, ctx),
        member: identifierName(access.name),
        source: sourceRef(ctx, expr, 'PropertyAccessExpression'),
      };
    }
    case SyntaxKind.ElementAccessExpression: {
      const access = expr as ElementAccessExpression;
      return {
        kind: 'EngineElementAccessExpression',
        object: expressionToEngine(access.expression, ctx),
        index: expressionToEngine(access.argumentExpression, ctx),
        source: sourceRef(ctx, expr, 'ElementAccessExpression'),
      };
    }
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = expr as PrefixUnaryExpression;
      const operator = tokenText(unary.operator?.kind);
      return {
        kind: 'EngineUnaryExpression',
        operator: operator === '!' || operator === '-' || operator === '+' ? operator : '+',
        operand: expressionToEngine(unary.operand, ctx),
        source: sourceRef(ctx, expr, 'PrefixUnaryExpression'),
      };
    }
    case SyntaxKind.BinaryExpression: {
      const binary = expr as any;
      return {
        kind: 'EngineBinaryExpression',
        operator: tokenText(binary.operatorToken?.kind),
        left: expressionToEngine(binary.left, ctx),
        right: expressionToEngine(binary.right, ctx),
        source: sourceRef(ctx, expr, 'BinaryExpression'),
      };
    }
    default:
      return {
        kind: 'EngineRawExpression',
        language: 'galaxy',
        code: printGalaxyNode(expr),
        source: sourceRef(ctx, expr, getKindName(expr.kind)),
      };
  }
}

function rawStatement(stmt: Statement, ctx: GalaxyEngineCtx): EngineStatement[] {
  return [{
    kind: 'EngineRawStatement',
    language: 'galaxy',
    code: printGalaxyNode(stmt),
    source: sourceRef(ctx, stmt, getKindName(stmt.kind)),
  }];
}

function typeRef(node: Node | undefined): EngineTypeRef {
  return { name: node ? printGalaxyNode(node).trim() : 'void' };
}

function identifierName(node: Identifier | undefined): string {
  return node?.name ?? '';
}

function expressionName(expr: Expression): string {
  if (expr.kind === SyntaxKind.Identifier) return identifierName(expr as Identifier);
  return printGalaxyNode(expr).trim();
}

function hasModifier(node: { modifiers?: readonly Node[] }, kind: SyntaxKind): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function sourceRef(ctx: GalaxyEngineCtx, node: Node, elementType?: string): EngineSourceRef {
  return {
    format: 'galaxy',
    fileName: ctx.sourceFile.fileName,
    moduleId: ctx.moduleId,
    elementType,
    span: typeof node.pos === 'number' && typeof node.end === 'number'
      ? { start: node.pos, end: node.end }
      : undefined,
  };
}

function tokenText(kind: SyntaxKind | undefined): string {
  switch (kind) {
    case SyntaxKind.EqualsToken: return '=';
    case SyntaxKind.PlusEqualsToken: return '+=';
    case SyntaxKind.MinusEqualsToken: return '-=';
    case SyntaxKind.AsteriskEqualsToken: return '*=';
    case SyntaxKind.SlashEqualsToken: return '/=';
    case SyntaxKind.PlusToken: return '+';
    case SyntaxKind.MinusToken: return '-';
    case SyntaxKind.AsteriskToken: return '*';
    case SyntaxKind.SlashToken: return '/';
    case SyntaxKind.PercentToken: return '%';
    case SyntaxKind.EqualsEqualsToken: return '==';
    case SyntaxKind.ExclamationEqualsToken: return '!=';
    case SyntaxKind.LessThanToken: return '<';
    case SyntaxKind.LessThanEqualsToken: return '<=';
    case SyntaxKind.GreaterThanToken: return '>';
    case SyntaxKind.GreaterThanEqualsToken: return '>=';
    case SyntaxKind.AmpersandAmpersandToken: return '&&';
    case SyntaxKind.BarBarToken: return '||';
    case SyntaxKind.ExclamationToken: return '!';
    default: return kind == null ? '' : getKindName(kind);
  }
}
