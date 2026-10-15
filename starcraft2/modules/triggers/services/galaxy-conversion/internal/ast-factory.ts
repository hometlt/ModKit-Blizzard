import {
  SyntaxKind,
} from '@modkit/blizzard-starcraft2/galaxy/language-core';

import type {
  SourceFile,
  Block,
  FunctionDeclaration,
  VariableDeclaration,
  ParameterDeclaration,
  IfStatement,
  WhileStatement,
  ForStatement,
  ReturnStatement,
  ExpressionStatement,
  IncludeStatement,
  CallExpression,
  BinaryExpression,
  PrefixUnaryExpression,
  ParenthesizedExpression,
  ElementAccessExpression,
  PropertyAccessExpression,
  Identifier,
  StringLiteral,
  NumericLiteral,
  TypeNode,
  Expression,
  Statement,
  Token,
  NodeArray,
  Modifier,
} from '@modkit/blizzard-starcraft2/galaxy/language-core';

let nodeId = 0;

function makePos(line = 0, char = 0, pos = 0, end = 0) {
  return { line, char, pos, end };
}

function makeNode<T extends { kind: SyntaxKind; line: number; char: number; pos: number; end: number }>(
  base: T
): T {
  (base as any).id = ++nodeId;
  return base;
}

export function createIdentifier(name: string): Identifier {
  return makeNode({
    kind: SyntaxKind.Identifier,
    ...makePos(),
    name,
    syntaxTokens: [],
  } as unknown as Identifier);
}

export function createStringLiteral(text: string): StringLiteral {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return makeNode({
    kind: SyntaxKind.StringLiteral,
    ...makePos(),
    text: `"${escaped}"`,
    value: text,
    syntaxTokens: [],
  } as unknown as StringLiteral);
}

export function createNumericLiteral(value: number | string): NumericLiteral {
  const text = typeof value === 'string' ? value : String(value);
  return makeNode({
    kind: SyntaxKind.NumericLiteral,
    ...makePos(),
    text,
    value: text,
    syntaxTokens: [],
  } as unknown as NumericLiteral);
}

export function createToken<TKind extends SyntaxKind>(kind: TKind): Token<TKind> {
  return makeNode({
    kind,
    ...makePos(),
  } as Token<TKind>);
}

export function createType(name: string): TypeNode {
  // Для простых типов (int, void, string, bool) — используем Identifier как TypeNode
  return createIdentifier(name) as unknown as TypeNode;
}

export function createVariableDeclaration(
  type: string,
  name: string,
  initializer?: Expression,
  isConst?: boolean,
): VariableDeclaration {
  let modifiers: any = undefined;
  if (isConst) {
    const constMod: any = makeNode({ kind: SyntaxKind.ConstKeyword, ...makePos(), syntaxTokens: [] } as any);
    modifiers = [constMod] as any;
    modifiers.line = 0; modifiers.char = 0; modifiers.pos = 0; modifiers.end = 0;
  }
  return makeNode({
    kind: SyntaxKind.VariableDeclaration,
    ...makePos(),
    name: createIdentifier(name),
    type: createType(type),
    initializer,
    modifiers,
    syntaxTokens: [],
  } as unknown as VariableDeclaration);
}

export function createParameter(type: string, name: string): ParameterDeclaration {
  return makeNode({
    kind: SyntaxKind.ParameterDeclaration,
    ...makePos(),
    name: createIdentifier(name),
    type: createType(type),
    syntaxTokens: [],
  } as unknown as ParameterDeclaration);
}

export function createCallExpression(
  functionName: string,
  args: Expression[]
): CallExpression {
  const arr = args as any;
  arr.line = 0; arr.char = 0; arr.pos = 0; arr.end = 0;
  return makeNode({
    kind: SyntaxKind.CallExpression,
    ...makePos(),
    expression: createIdentifier(functionName),
    arguments: arr as NodeArray<Expression>,
    syntaxTokens: [],
  } as unknown as CallExpression);
}

export function createBinaryExpression(
  left: Expression,
  operator: SyntaxKind.PlusToken | SyntaxKind.MinusToken | SyntaxKind.AsteriskToken |
    SyntaxKind.SlashToken | SyntaxKind.PercentToken | SyntaxKind.LessThanToken |
    SyntaxKind.GreaterThanToken | SyntaxKind.LessThanEqualsToken |
    SyntaxKind.GreaterThanEqualsToken | SyntaxKind.EqualsEqualsToken |
    SyntaxKind.ExclamationEqualsToken | SyntaxKind.BarToken | SyntaxKind.BarBarToken |
    SyntaxKind.AmpersandAmpersandToken | SyntaxKind.EqualsToken |
    SyntaxKind.PlusEqualsToken | SyntaxKind.MinusEqualsToken |
    SyntaxKind.LessThanLessThanToken | SyntaxKind.GreaterThanGreaterThanToken,
  right: Expression
): BinaryExpression {
  return makeNode({
    kind: SyntaxKind.BinaryExpression,
    ...makePos(),
    left,
    operatorToken: createToken(operator),
    right,
    syntaxTokens: [],
  } as unknown as BinaryExpression);
}

export function createExpressionStatement(expression: Expression): ExpressionStatement {
  return makeNode({
    kind: SyntaxKind.ExpressionStatement,
    ...makePos(),
    expression,
    syntaxTokens: [],
  } as unknown as ExpressionStatement);
}

/** One SC2 Editor section banner (`// Actions`). The printer writes it as a comment line. */
export function createCommentStatement(text: string): Statement {
  return makeNode({
    kind: SyntaxKind.SingleLineCommentTrivia,
    ...makePos(),
    text,
    syntaxTokens: [],
  } as unknown as Statement);
}

export function createReturnStatement(expression?: Expression): ReturnStatement {
  return makeNode({
    kind: SyntaxKind.ReturnStatement,
    ...makePos(),
    expression,
    syntaxTokens: [],
  } as unknown as ReturnStatement);
}

export function createBreakStatement(): Statement {
  return makeNode({
    kind: SyntaxKind.BreakStatement,
    ...makePos(),
    syntaxTokens: [],
  } as unknown as Statement);
}

export function createContinueStatement(): Statement {
  return makeNode({
    kind: SyntaxKind.ContinueStatement,
    ...makePos(),
    syntaxTokens: [],
  } as unknown as Statement);
}

export function createIfStatement(
  condition: Expression,
  thenStatements: Statement[],
  elseStatements?: Statement[]
): IfStatement {
  const thenBlock = createBlock(thenStatements);
  return makeNode({
    kind: SyntaxKind.IfStatement,
    ...makePos(),
    expression: condition,
    thenStatement: thenBlock,
    elseStatement: elseStatements ? createBlock(elseStatements) : undefined,
    syntaxTokens: [],
  } as unknown as IfStatement);
}

export function createWhileStatement(
  condition: Expression,
  statements: Statement[]
): WhileStatement {
  return makeNode({
    kind: SyntaxKind.WhileStatement,
    ...makePos(),
    expression: condition,
    statement: createBlock(statements),
    syntaxTokens: [],
  } as unknown as WhileStatement);
}

export function createPrefixUnaryExpression(
  operator: SyntaxKind.ExclamationToken | SyntaxKind.MinusToken | SyntaxKind.PlusToken | SyntaxKind.TildeToken,
  operand: Expression
): PrefixUnaryExpression {
  return makeNode({
    kind: SyntaxKind.PrefixUnaryExpression,
    ...makePos(),
    operator: createToken(operator),
    operand,
    syntaxTokens: [],
  } as unknown as PrefixUnaryExpression);
}

export function createUnaryNot(operand: Expression): PrefixUnaryExpression {
  return createPrefixUnaryExpression(SyntaxKind.ExclamationToken, operand);
}

export function createElementAccessExpression(
  expression: Expression,
  argumentExpression: Expression,
): ElementAccessExpression {
  return makeNode({
    kind: SyntaxKind.ElementAccessExpression,
    ...makePos(),
    expression,
    argumentExpression,
    syntaxTokens: [],
  } as unknown as ElementAccessExpression);
}

export function createPropertyAccessExpression(
  expression: Expression,
  name: string,
): PropertyAccessExpression {
  return makeNode({
    kind: SyntaxKind.PropertyAccessExpression,
    ...makePos(),
    expression,
    name: createIdentifier(name),
    syntaxTokens: [],
  } as unknown as PropertyAccessExpression);
}

export function createPropertyDeclaration(
  type: string,
  name: string,
): any {
  return makeNode({
    kind: SyntaxKind.PropertyDeclaration,
    ...makePos(),
    name: createIdentifier(name),
    type: createType(type),
    syntaxTokens: [],
  } as any);
}

export function createStructDeclaration(
  name: string,
  members: any[],
): any {
  const arr = members as any;
  arr.line = 0; arr.char = 0; arr.pos = 0; arr.end = 0;
  return makeNode({
    kind: SyntaxKind.StructDeclaration,
    ...makePos(),
    name: createIdentifier(name),
    members: arr,
    syntaxTokens: [],
  } as any);
}

export function createParenthesizedExpression(expression: Expression): ParenthesizedExpression {
  return makeNode({
    kind: SyntaxKind.ParenthesizedExpression,
    ...makePos(),
    expression,
    syntaxTokens: [],
  } as unknown as ParenthesizedExpression);
}

export function createForStatement(
  initializer: Expression | null,
  condition: Expression | null,
  incrementor: Expression,
  statements: Statement[]
): ForStatement {
  const body = createBlock(statements);
  return makeNode({
    kind: SyntaxKind.ForStatement,
    ...makePos(),
    initializer: initializer ?? undefined,
    condition,
    incrementor,
    statement: body,
    syntaxTokens: [],
  } as unknown as ForStatement);
}

export function createBlock(statements: Statement[]): Block {
  const arr = statements as any;
  arr.line = 0; arr.char = 0; arr.pos = 0; arr.end = 0;
  return makeNode({
    kind: SyntaxKind.Block,
    ...makePos(),
    statements: arr as NodeArray<Statement>,
    syntaxTokens: [],
  } as unknown as Block);
}

export function createFunctionDeclaration(
  returnType: string,
  name: string,
  parameters: ParameterDeclaration[],
  bodyStatements: Statement[] | null,
  modifiers?: Modifier[]
): FunctionDeclaration {
  const paramsArr = parameters as any;
  paramsArr.line = 0; paramsArr.char = 0; paramsArr.pos = 0; paramsArr.end = 0;
  const modsArr = modifiers ? (modifiers as any) : undefined;
  if (modsArr) { modsArr.line = 0; modsArr.char = 0; modsArr.pos = 0; modsArr.end = 0; }
  return makeNode({
    kind: SyntaxKind.FunctionDeclaration,
    ...makePos(),
    name: createIdentifier(name),
    type: createType(returnType),
    parameters: paramsArr as NodeArray<ParameterDeclaration>,
    body: bodyStatements !== null ? createBlock(bodyStatements) : undefined,
    modifiers: modsArr as NodeArray<Modifier>,
    syntaxTokens: [],
  } as unknown as FunctionDeclaration);
}

export function createIncludeStatement(path: string): IncludeStatement {
  return makeNode({
    kind: SyntaxKind.IncludeStatement,
    ...makePos(),
    path: createStringLiteral(path),
    syntaxTokens: [],
  } as unknown as IncludeStatement);
}

export function createSourceFile(
  fileName: string,
  statements: Statement[]
): SourceFile {
  const arr = statements as any;
  arr.line = 0; arr.char = 0; arr.pos = 0; arr.end = 0;
  const sf = makeNode({
    kind: SyntaxKind.SourceFile,
    ...makePos(),
    fileName,
    statements: arr as NodeArray<Statement>,
    lineMap: [],
    commentsLineMap: new Map(),
    syntaxTokens: [],
  } as unknown as SourceFile);
  (sf as any).parseDiagnostics = [];
  (sf as any).bindDiagnostics = [];
  (sf as any).additionalSyntacticDiagnostics = [];
  (sf as any).text = '';
  return sf;
}
