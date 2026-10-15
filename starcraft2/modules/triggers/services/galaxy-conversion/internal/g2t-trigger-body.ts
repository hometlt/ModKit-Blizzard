import type { GalaxyConstantIndex } from './galaxy-constants.js';
import { structuredStatements, structuredNode, structuredParam, declareStructuredLocal } from './g2t-structured.js';
/**
 * g2t-trigger-body — trigger and user-function body conversion for Galaxy→trigger.
 *
 * Converts Galaxy function bodies back into structured TriggerJson / FunctionDefJson
 * elements by walking their statement lists through the pattern recognisers in
 * g2t-actions.  Three entry points:
 *
 *   convertTriggerBody — converts a lib*_gt_*_Func body.  Extracts:
 *     • trigger conditions from the "if (testConds)" guard block
 *     • trigger actions from the remaining statements
 *     • local variable declarations
 *
 *   convertUserFunctionBody — converts a lib*_gf_* body.  Maps lp_xxx
 *     Galaxy parameters back to ParamDef refs so body statements can
 *     reference them, then converts the statement list to actions.
 *
 *   convertInitVariablesBody — converts lib*_InitVariables into the
 *     structured __InitVariablesRaw FunctionDef, stripping the boilerplate
 *     guard/set statements that trigger-to-galaxy emits.
 *
 * Depends on: g2t-core, g2t-call, g2t-actions.
 * Consumed by: galaxy-to-trigger.
 */
import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import type { Block, FunctionDeclaration } from '@modkit/blizzard-starcraft2/galaxy/language-core';

import type {
  TriggerLibraryJson,
  TriggerJson,
  VariableJson,
  FunctionDefJson,
  ElementJson,
  ElementRefJson,
} from '../../../shared/trigger-document/index.js';

import { startupFunctionName } from './conversion-model.js';
import {
  type CrossLibFunctionDefInfo,
  ReverseCtx,
  generateId,
  extractLocalVarName,
  extractAutoVarName,
  attachDefaultParam,
  triggerParamTypeFromGalaxyTypeName,
  getTypeName,
  getBlockStatements,
  forStmtUsesCounterVar,
  isLoopCounterDeclaration,
  unwrapArrayType,
  parseArraySizeExpr,
  exprContainsIdentifier,
  getAssignSides,
  getIdentifierName,
  readSignedIntLiteral,
  structureMemberKey,
  unwrapParens,
  upcomingForStmtUsesName,
} from './g2t-core.js';

import {
  exprToParamRef,
  collectConditionRefs,
  exprContainsUnresolvedCall,
} from './g2t-call.js';

import {
  stmtToActionFCRef,
  buildPickEachIntegerFromForStmt,
  tryBuildWaitForConditionWithMaxFromStmtSequence,
  tryBuildWaitForConditionFromStmtSequence,
  tryBuildActionQueueAddFromStmtSequence,
  tryBuildRepeatForeverFromStmt,
  tryBuildRepeatFromStmtSequence,
  tryBuildForEachIntegerFromStmtSequence,
  tryBuildSwitchFromStmtSequence,
  tryBuildLegacyPickEachPlayerFromStmtSequence,
  tryBuildPickEachPlayerFromStmtSequence,
  tryBuildPickEachUnitFromStmtSequence,
  buildCustomScriptActionFCRef,
  isTestCondsGuard,
  isRunActionsGuard,
} from './g2t-actions.js';

// ---------------------------------------------------------------------------
// Local variable type helper
// ---------------------------------------------------------------------------

function makeLocalVar(
  varId: string,
  libId: string,
  name: string,
  typeNode: any,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  ctx: ReverseCtx,
): VariableJson {
  const { baseType, sizes } = unwrapArrayType(typeNode);
  const galaxyTypeName = getTypeName(baseType);
  const varJson: VariableJson = {
    type: 'Variable', id: varId, library: libId, name,
    variableType: triggerParamTypeFromGalaxyTypeName(galaxyTypeName, ctx),
    isArray: sizes.length > 0 || undefined,
  };
  if (sizes.length > 0) {
    (varJson as any).arraySizes = sizes.map((sizeExpr: any, dim: number) => ({
      dim,
      ...parseArraySizeExpr(sizeExpr, globalVarByGalaxyName, ctx.constants),
    }));
  }
  return varJson;
}

// ---------------------------------------------------------------------------
// Guard detection helpers
// ---------------------------------------------------------------------------

export { isTestCondsGuard, isRunActionsGuard };

/** The guards of the editor's conditions block, `if (testConds) { if (!(c)) { return false; } ... }`,
 *  or undefined when `statement` is anything else. */
export function triggerConditionGuards(statement: any): any[] | undefined {
  if (statement?.kind !== SyntaxKind.IfStatement || statement.elseStatement ||
    !isTestCondsGuard(unwrapParens(statement.expression), statement.thenStatement)) return undefined;
  const guards: any[] = Array.from(statement.thenStatement?.statements ?? []);
  const returnsFalse = (branch: any): boolean => branch?.kind === SyntaxKind.Block && branch.statements.length === 1 &&
    branch.statements[0].kind === SyntaxKind.ReturnStatement && branch.statements[0].expression?.kind === SyntaxKind.FalseKeyword;
  return guards.length > 0 && guards.every(guard => guard.kind === SyntaxKind.IfStatement && !guard.elseStatement &&
    unwrapParens(guard.expression)?.kind === SyntaxKind.PrefixUnaryExpression &&
    unwrapParens(guard.expression).operator?.kind === SyntaxKind.ExclamationToken && returnsFalse(guard.thenStatement))
    ? guards : undefined;
}

export function extractConditionsFromGuard(thenBlock: Block, ctx: ReverseCtx): ElementRefJson[] {
  // Pattern: if (testConds) { if (!(cond)) { return false; } }
  const out: ElementRefJson[] = [];
  for (const stmt of (thenBlock as any).statements ?? []) {
    if (stmt.kind === SyntaxKind.IfStatement) {
      const innerIf = stmt;
      const cond = innerIf.expression;
      // The guard condition is !cond → we want cond
      if (cond?.kind === SyntaxKind.PrefixUnaryExpression &&
          cond.operator?.kind === SyntaxKind.ExclamationToken) {
        const innerCond = cond.operand;
        if (exprContainsUnresolvedCall(innerCond, ctx)) continue;
        for (const ref of collectConditionRefs(innerCond, undefined, ctx)) out.push(ref);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// User function body conversion
// ---------------------------------------------------------------------------

export function convertUserFunctionBody(
  funcDecl: FunctionDeclaration,
  funcDef: FunctionDefJson,
  libId: string,
  elements: Record<string, ElementJson>,
  funcNameToFuncDef: Map<string, FunctionDefJson>,
  roleToSubFuncType: Map<string, { library: string; id: string }>,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  galaxyConstToPreset: Map<string, ElementRefJson>,
  structureByGalaxyTypeName?: Map<string, ElementRefJson>,
  structureMemberByKey?: Map<string, ElementRefJson>,
  nativeLibrary?: TriggerLibraryJson,
  externalFuncParamTypes?: Map<string, string[]>,
  crossLibFuncDefs?: Map<string, CrossLibFunctionDefInfo>,
  sourceText?: string,
  triggerByGalaxyName?: Map<string, ElementRefJson>,
  dependencyLibraries?: Map<string, TriggerLibraryJson>,
  constants?: GalaxyConstantIndex,
): { actions: ElementRefJson[]; localVariables: ElementRefJson[] } {
  const actions: ElementRefJson[] = [];
  const localVariables: ElementRefJson[] = [];

  const localVarByGalaxyName = new Map<string, string>();
  const paramRefByGalaxyName = new Map<string, ElementRefJson>();
  const paramDefs = funcDef.parameters ?? [];
  const galaxyParams: any[] = Array.from((funcDecl as any).parameters ?? []);
  for (let i = 0; i < galaxyParams.length; i++) {
    const galaxyParamName: string = (galaxyParams[i]?.name as any)?.name ?? '';
    const paramDefRef = paramDefs[i] as ElementRefJson | undefined;
    if (paramDefRef && galaxyParamName) {
      paramRefByGalaxyName.set(galaxyParamName, paramDefRef);
    }
  }

  const pendingAutoInits = new Map<string, any>();
  const pendingAutoEnds = new Map<string, any>();
  const pendingAutoIncrements = new Map<string, any>();

  const ctx: ReverseCtx = {
    libId,
    elements,
    nativeLibrary,
    dependencyLibraries,
    constants: constants?.scope([...(funcDecl.parameters ?? []), ...((funcDecl.body as any)?.statements ?? [])]),
    funcNameToFuncDef,
    roleToSubFuncType,
    localVarByGalaxyName,
    globalVarByGalaxyName,
    pendingAutoInits,
    pendingAutoEnds,
    pendingAutoIncrements,
    galaxyConstToPreset,
    structureByGalaxyTypeName,
    structureMemberByKey,
    isUserFunction: true,
    paramRefByGalaxyName,
    externalFuncParamTypes,
    crossLibFuncDefs,
    sourceText,
    triggerByGalaxyName,
  };

  const body = (funcDecl as any).body;
  if (!body) return { actions, localVariables };

  ctx.returnType = getTypeName((funcDecl as any).type) || 'void';
  ctx.structuredLocals = localVariables;
  ctx.structuredTemplates = new Map();
  const statements = Array.from(body.statements ?? []) as any[];
  ctx.structuredFunctionStatements = statements;
  // Like a trigger, a generated function assigns initial values before its actions.
  // As actions, an array fill became For Each Integer over `lv_d[IntLoopCurrent()]`
  // with a stray `init_i` local (Эпические Битвы с Боссами).
  const start = generatedImplementationStart(body, statements, sourceText);
  const prefix = start === undefined ? undefined : localInitialization(statements, start);
  if (prefix) {
    for (const declaration of prefix.declarations) declareStructuredLocal(declaration, ctx);
    for (const initial of prefix.initializers) {
      const variable = elements[localVarByGalaxyName.get(initial.name)!] as VariableJson;
      variable.initialValue = structuredParam(initial.expression, ctx, undefined, variable.variableType?.type);
    }
  }
  actions.push(...structuredStatements(statements.slice(prefix?.length ?? 0), ctx));

  return { actions, localVariables };
}

export function isInitVariablesCompletedGuard(stmt: any, libId: string): boolean {
  if (stmt?.kind !== SyntaxKind.IfStatement) return false;
  if (stmt.expression?.kind !== SyntaxKind.Identifier) return false;
  if (stmt.expression.name !== `${startupFunctionName(libId, 'InitVariables')}_completed`) return false;
  const thenStmts = getBlockStatements(stmt.thenStatement);
  return thenStmts.length === 1 && thenStmts[0]?.kind === SyntaxKind.ReturnStatement;
}

export function isInitVariablesCompletedSet(stmt: any, libId: string): boolean {
  if (stmt?.kind !== SyntaxKind.ExpressionStatement) return false;
  const expr = stmt.expression;
  if (expr?.kind !== SyntaxKind.BinaryExpression) return false;
  if ((expr.operatorToken?.kind as SyntaxKind) !== SyntaxKind.EqualsToken) return false;
  if (expr.left?.kind !== SyntaxKind.Identifier) return false;
  if (expr.left.name !== `${startupFunctionName(libId, 'InitVariables')}_completed`) return false;
  const right = expr.right;
  return (
    right?.kind === SyntaxKind.TrueKeyword ||
    (right?.kind === SyntaxKind.Identifier && right.name === 'true')
  );
}

/**
 * Matches the array-initialization loop chains that appear in InitVariables
 * and returns the assignment target/value, the loop counters (outer→inner),
 * and how many top-level statements the chain consumes.
 *
 * Editor shape (counter initialized inside the for):
 *   for (init_i = 0; init_i <= 16; init_i += 1) {
 *     gv_arr[init_i] = <expr>;             // or a nested for for 2-D arrays
 *   }
 *
 * T2G shape (auto counter primed by a preceding assignment):
 *   autoX_var = 0;
 *   for ( ; autoX_var <= autoX_ae; autoX_var += 1 ) {
 *     gv_arr[autoX_var] = <expr>;
 *   }
 */
function matchInitLoopHeader(forStmt: any, ctx: ReverseCtx, presetCounter?: string):
  { counterName: string; literalBound?: number; boundVarName?: string } | undefined {
  if (!forStmt || forStmt.kind !== SyntaxKind.ForStatement) return undefined;
  let counterName = presetCounter;
  if (forStmt.initializer != null) {
    if (presetCounter) return undefined; // both preceding assign and initializer — not our shape
    const init = forStmt.initializer;
    if (init?.kind !== SyntaxKind.BinaryExpression) return undefined;
    if ((init.operatorToken?.kind as SyntaxKind) !== SyntaxKind.EqualsToken) return undefined;
    counterName = getIdentifierName(init.left);
    if (!counterName) return undefined;
    if (readSignedIntLiteral(init.right) !== 0) return undefined;
  }
  if (!counterName) return undefined;
  const cond = unwrapParens(forStmt.condition);
  if (!cond || cond.kind !== SyntaxKind.BinaryExpression) return undefined;
  if ((cond.operatorToken?.kind as SyntaxKind) !== SyntaxKind.LessThanEqualsToken) return undefined;
  if (getIdentifierName(cond.left) !== counterName) return undefined;
  const endName = getIdentifierName(cond.right);
  let literalBound: number | undefined;
  let boundVarName: string | undefined;
  if (endName) {
    if (extractAutoVarName(endName)?.suffix === 'ae') {
      // Captured const auto*_ae — fold only when its value is an int literal
      // or a global-variable identifier (matched against arraySizes later).
      const aeExpr = ctx.pendingAutoEnds.get(endName);
      if (!aeExpr) return undefined;
      literalBound = readSignedIntLiteral(aeExpr);
      if (literalBound === undefined) {
        const aeId = getIdentifierName(aeExpr);
        if (!aeId || !ctx.globalVarByGalaxyName.has(aeId)) return undefined;
        boundVarName = aeId;
      }
    } else if (ctx.globalVarByGalaxyName.has(endName)) {
      // Editor-style symbolic bound: a (const) global, e.g.
      //   for (init_i = 0; init_i <= lib1_gv_panels; ...)
      boundVarName = endName;
    } else {
      return undefined;
    }
  } else {
    literalBound = readSignedIntLiteral(cond.right);
    if (literalBound === undefined) return undefined;
  }
  const incr = forStmt.incrementor;
  if (!incr || incr.kind !== SyntaxKind.BinaryExpression) return undefined;
  if ((incr.operatorToken?.kind as SyntaxKind) !== SyntaxKind.PlusEqualsToken) return undefined;
  if (getIdentifierName(incr.left) !== counterName) return undefined;
  if (readSignedIntLiteral(incr.right) !== 1) return undefined;
  return { counterName, literalBound, boundVarName };
}

function matchArrayInitChain(
  forStmt: any,
  ctx: ReverseCtx,
  counters: string[],
  bounds: Array<number | string | undefined>,
  presetCounter?: string,
): { targetExpr: any; valueExpr: any } | undefined {
  const header = matchInitLoopHeader(forStmt, ctx, presetCounter);
  if (!header) return undefined;
  counters.push(header.counterName);
  bounds.push(header.literalBound ?? header.boundVarName);

  const body = getBlockStatements(forStmt.statement);
  if (body.length === 1 && (body[0] as any)?.kind === SyntaxKind.ExpressionStatement) {
    const inner = getAssignSides(body[0]);
    if (!inner) return undefined;
    return { targetExpr: inner.left, valueExpr: inner.right };
  }
  // Nested editor-style loop (counter initialized inside the for)
  if (body.length === 1 && (body[0] as any)?.kind === SyntaxKind.ForStatement) {
    return matchArrayInitChain(body[0], ctx, counters, bounds);
  }
  // Nested T2G-style pair: counter-prime assignment + for
  if (body.length === 2 && (body[1] as any)?.kind === SyntaxKind.ForStatement) {
    const primed = primeCounterName(body[0]);
    if (!primed) return undefined;
    return matchArrayInitChain(body[1], ctx, counters, bounds, primed);
  }
  return undefined;
}

/** Matches `autoX_var = 0;` (or any `c = 0;`) and returns the counter name. */
function primeCounterName(assignStmt: any): string | undefined {
  const assign = getAssignSides(assignStmt);
  if (!assign) return undefined;
  const name = getIdentifierName(assign.left);
  if (!name) return undefined;
  if (readSignedIntLiteral(assign.right) !== 0) return undefined;
  return name;
}

function collectElementAccessIndices(expr: any): { base: any; indices: string[] } {
  const indices: string[] = [];
  let base = expr;
  while (base?.kind === SyntaxKind.ElementAccessExpression) {
    indices.unshift(getIdentifierName(base.argumentExpression) ?? '');
    base = base.expression;
  }
  return { base, indices };
}

function boundsCoverArraySizes(
  bounds: Array<number | string | undefined>,
  arraySizes: Array<{ value?: string; variable?: { id?: string; library?: string } }> | undefined,
  offset: number,
  ctx: ReverseCtx,
): boolean {
  if (!arraySizes || offset + arraySizes.length > bounds.length) return false;
  for (let k = 0; k < arraySizes.length; k++) {
    const b = bounds[offset + k];
    if (b === undefined) return false;
    if (typeof b === 'number') {
      const declared = arraySizes[k]?.value !== undefined ? Number(arraySizes[k].value) : undefined;
      if (declared === undefined || b !== declared) return false;
    } else {
      const sizeVar = arraySizes[k]?.variable;
      const boundRef = ctx.globalVarByGalaxyName.get(b);
      if (!sizeVar?.id || !boundRef || boundRef.id !== sizeVar.id) return false;
    }
  }
  return true;
}

function tryFoldStructMemberInitIntoInitialValue(
  targetExpr: any,
  valueExpr: any,
  counters: string[],
  bounds: Array<number | string | undefined>,
  ctx: ReverseCtx,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  elements: Record<string, ElementJson>,
  libId: string,
): boolean {
  const trailing = collectElementAccessIndices(targetExpr);
  if (trailing.base?.kind !== SyntaxKind.PropertyAccessExpression) return false;

  const memberName = trailing.base.name?.name;
  if (!memberName) return false;

  const baseAccess = collectElementAccessIndices(trailing.base.expression);
  const baseName = getIdentifierName(baseAccess.base);
  if (!baseName) return false;

  const indexNames = [...baseAccess.indices, ...trailing.indices];
  if (indexNames.length !== counters.length) return false;
  if (!indexNames.every((n, k) => n === counters[k])) return false;

  const baseRef = globalVarByGalaxyName.get(baseName);
  if (!baseRef || baseRef.library !== libId) return false;
  const baseVar = elements[baseRef.id] as VariableJson | undefined;
  const structureRef = baseVar?.variableType?.typeElement;
  if (!baseVar || baseVar.type !== 'Variable' || !structureRef?.id) return false;

  const memberRef = ctx.structureMemberByKey?.get(structureMemberKey(structureRef.id, memberName));
  if (!memberRef || memberRef.library !== libId) return false;
  const memberVar = elements[memberRef.id] as VariableJson | undefined;
  if (!memberVar || memberVar.type !== 'Variable') return false;

  const baseArraySizes = (baseVar as any).arraySizes as Array<{ value?: string; variable?: { id?: string; library?: string } }> | undefined;
  const memberArraySizes = (memberVar as any).arraySizes as Array<{ value?: string; variable?: { id?: string; library?: string } }> | undefined;
  if (!boundsCoverArraySizes(bounds, baseArraySizes, 0, ctx)) return false;
  if (trailing.indices.length > 0) {
    if (!boundsCoverArraySizes(bounds, memberArraySizes, baseAccess.indices.length, ctx)) return false;
  } else if (memberArraySizes?.length) {
    return false;
  }

  for (const c of counters) {
    if (exprContainsIdentifier(valueExpr, c)) return false;
  }

  const newInitRef = exprToParamRef(valueExpr, ctx, undefined, memberVar.variableType?.type);
  // Do not eagerly delete the previous value. Template reconstruction can
  // legitimately share that Param with another generated call. The final
  // reachability pass removes it if no retained element owns it.
  memberVar.initialValue = newInitRef as any;
  return true;
}

function tryFoldStructMemberInitBlock(
  stmts: any[],
  counters: string[],
  bounds: Array<number | string | undefined>,
  ctx: ReverseCtx,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  elements: Record<string, ElementJson>,
  libId: string,
): boolean {
  let folded = 0;
  for (const stmt of stmts) {
    if (stmt?.kind === SyntaxKind.ExpressionStatement) {
      const sides = getAssignSides(stmt);
      if (!sides) return false;
      if (!tryFoldStructMemberInitIntoInitialValue(
        sides.left,
        sides.right,
        counters,
        bounds,
        ctx,
        globalVarByGalaxyName,
        elements,
        libId,
      )) {
        return false;
      }
      folded++;
      continue;
    }

    if (stmt?.kind === SyntaxKind.ForStatement) {
      const header = matchInitLoopHeader(stmt, ctx);
      if (!header) return false;
      counters.push(header.counterName);
      bounds.push(header.literalBound ?? header.boundVarName);
      const ok = tryFoldStructMemberInitBlock(
        getBlockStatements(stmt.statement),
        counters,
        bounds,
        ctx,
        globalVarByGalaxyName,
        elements,
        libId,
      );
      counters.pop();
      bounds.pop();
      if (!ok) return false;
      folded++;
      continue;
    }

    return false;
  }
  return folded > 0;
}

function tryFoldStructMemberInitLoopIntoInitialValue(
  stmts: any[],
  index: number,
  ctx: ReverseCtx,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  elements: Record<string, ElementJson>,
  libId: string,
): { consumed: number } | undefined {
  const stmt = stmts[index] as any;
  if (stmt?.kind !== SyntaxKind.ForStatement) return undefined;
  const header = matchInitLoopHeader(stmt, ctx);
  if (!header) return undefined;
  const counters = [header.counterName];
  const bounds: Array<number | string | undefined> = [header.literalBound ?? header.boundVarName];
  const ok = tryFoldStructMemberInitBlock(
    getBlockStatements(stmt.statement),
    counters,
    bounds,
    ctx,
    globalVarByGalaxyName,
    elements,
    libId,
  );
  return ok ? { consumed: 1 } : undefined;
}

/**
 * Folds an array init loop into Variable.initialValue and returns the consumed
 * statement count. The editor regenerates these loops in InitVariables from
 * the initial value itself — a synthetic __InitVariablesRaw holder must NOT
 * exist for them.
 */
function tryFoldGlobalArrayInitIntoInitialValue(
  stmts: any[],
  index: number,
  ctx: ReverseCtx,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  elements: Record<string, ElementJson>,
  libId: string,
): { consumed: number } | undefined {
  const s0 = stmts[index] as any;
  let matched: { targetExpr: any; valueExpr: any } | undefined;
  let consumed = 0;
  const counters: string[] = [];
  const bounds: Array<number | string | undefined> = [];

  if (s0?.kind === SyntaxKind.ForStatement) {
    matched = matchArrayInitChain(s0, ctx, counters, bounds);
    consumed = 1;
  } else if (index + 1 < stmts.length && (stmts[index + 1] as any)?.kind === SyntaxKind.ForStatement) {
    const primed = primeCounterName(s0);
    if (primed) {
      matched = matchArrayInitChain(stmts[index + 1], ctx, counters, bounds, primed);
      consumed = 2;
    }
  }
  if (!matched) return undefined;

  if (tryFoldStructMemberInitIntoInitialValue(
    matched.targetExpr,
    matched.valueExpr,
    counters,
    bounds,
    ctx,
    globalVarByGalaxyName,
    elements,
    libId,
  )) {
    return { consumed };
  }

  // Target must be gv[c1][c2]... over exactly the chain counters, in order.
  let t = matched.targetExpr;
  const indexNames: string[] = [];
  while (t?.kind === SyntaxKind.ElementAccessExpression) {
    indexNames.unshift(getIdentifierName(t.argumentExpression) ?? '');
    t = t.expression;
  }
  const gvName = getIdentifierName(t);
  if (!gvName) return undefined;
  if (indexNames.length !== counters.length) return undefined;
  if (!indexNames.every((n, k) => n === counters[k])) return undefined;

  const varRef = globalVarByGalaxyName.get(gvName);
  if (!varRef || varRef.library !== libId) return undefined;
  const variable = elements[varRef.id] as VariableJson | undefined;
  if (!variable || variable.type !== 'Variable' || !(variable as any).isArray) return undefined;

  // Each loop bound must cover the full declared dimension — a partial init
  // (bound < size) is real logic and must stay as actions, not initialValue.
  const arraySizes = (variable as any).arraySizes as Array<{ value?: string; variable?: { id?: string; library?: string } }> | undefined;
  if (!arraySizes || arraySizes.length !== bounds.length) return undefined;
  for (let k = 0; k < bounds.length; k++) {
    const b = bounds[k];
    if (b === undefined) return undefined;
    if (typeof b === 'number') {
      const declared = arraySizes[k]?.value !== undefined ? Number(arraySizes[k].value) : undefined;
      if (declared === undefined || b !== declared) return undefined;
    } else {
      // Symbolic bound: the bound's global variable must be the SAME variable
      // the array dimension was declared with ([gv + 1] → arraySizes.variable).
      const sizeVar = arraySizes[k]?.variable;
      const boundRef = ctx.globalVarByGalaxyName.get(b);
      if (!sizeVar?.id || !boundRef || boundRef.id !== sizeVar.id) return undefined;
    }
  }

  // The per-element value must not depend on the loop counters.
  for (const c of counters) {
    if (exprContainsIdentifier(matched.valueExpr, c)) return undefined;
  }

  const newInitRef = exprToParamRef(matched.valueExpr, ctx, undefined, variable.variableType?.type);
  // Ownership is graph-based rather than exclusive to this variable. Leave
  // cleanup to pruneUnreachableElements after every body has been rebuilt.
  variable.initialValue = newInitRef as any;
  return { consumed };
}

export function convertInitVariablesBody(
  funcDecl: FunctionDeclaration,
  libId: string,
  elements: Record<string, ElementJson>,
  funcNameToFuncDef: Map<string, FunctionDefJson>,
  roleToSubFuncType: Map<string, { library: string; id: string }>,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  galaxyConstToPreset: Map<string, ElementRefJson>,
  structureByGalaxyTypeName?: Map<string, ElementRefJson>,
  structureMemberByKey?: Map<string, ElementRefJson>,
  nativeLibrary?: TriggerLibraryJson,
  externalFuncParamTypes?: Map<string, string[]>,
  crossLibFuncDefs?: Map<string, CrossLibFunctionDefInfo>,
  sourceText?: string,
  triggerByGalaxyName?: Map<string, ElementRefJson>,
  dependencyLibraries?: Map<string, TriggerLibraryJson>,
  constants?: GalaxyConstantIndex,
): { actions: ElementRefJson[]; localVariables: ElementRefJson[] } {
  const actions: ElementRefJson[] = [];
  const localVariables: ElementRefJson[] = [];

  const localVarByGalaxyName = new Map<string, string>();
  const pendingAutoInits = new Map<string, any>();
  const pendingAutoEnds = new Map<string, any>();
  const pendingAutoIncrements = new Map<string, any>();

  const ctx: ReverseCtx = {
    libId,
    elements,
    nativeLibrary,
    dependencyLibraries,
    constants: constants?.scope([...(funcDecl.parameters ?? []), ...((funcDecl.body as any)?.statements ?? [])]),
    funcNameToFuncDef,
    roleToSubFuncType,
    localVarByGalaxyName,
    globalVarByGalaxyName,
    pendingAutoInits,
    pendingAutoEnds,
    pendingAutoIncrements,
    galaxyConstToPreset,
    structureByGalaxyTypeName,
    structureMemberByKey,
    isUserFunction: true,
    externalFuncParamTypes,
    crossLibFuncDefs,
    sourceText,
    triggerByGalaxyName,
  };

  const body = (funcDecl as any).body;
  if (!body) return { actions, localVariables };
  const topStmts = Array.from(body.statements ?? []) as any[];

  for (let i = 0; i < topStmts.length; i++) {
    const s = topStmts[i] as any;
    const foldedStructMemberInits = tryFoldStructMemberInitLoopIntoInitialValue(
      topStmts,
      i,
      ctx,
      globalVarByGalaxyName,
      elements,
      libId,
    );
    if (foldedStructMemberInits) {
      i += foldedStructMemberInits.consumed - 1;
      continue;
    }

    // Editor-style array init loop → Variable.initialValue (the editor
    // regenerates the loop itself; never keep it as a raw action).
    const foldedArrayInit = tryFoldGlobalArrayInitIntoInitialValue(topStmts, i, ctx, globalVarByGalaxyName, elements, libId);
    if (foldedArrayInit) {
      i += foldedArrayInit.consumed - 1;
      continue;
    }
    const topWaitMax = tryBuildWaitForConditionWithMaxFromStmtSequence(topStmts, i, undefined, ctx);
    if (topWaitMax) {
      actions.push(topWaitMax.ref);
      i += topWaitMax.consumed - 1;
      continue;
    }
    const topWaitCond = tryBuildWaitForConditionFromStmtSequence(topStmts, i, undefined, ctx);
    if (topWaitCond) {
      actions.push(topWaitCond.ref);
      i += topWaitCond.consumed - 1;
      continue;
    }
    const topActionQueueAdd = tryBuildActionQueueAddFromStmtSequence(topStmts, i, undefined, ctx);
    if (topActionQueueAdd) {
      actions.push(topActionQueueAdd.ref);
      i += topActionQueueAdd.consumed - 1;
      continue;
    }
    const topRepeatForever = tryBuildRepeatForeverFromStmt(s, undefined, ctx);
    if (topRepeatForever) {
      actions.push(topRepeatForever);
      continue;
    }
    const topRepeat = tryBuildRepeatFromStmtSequence(topStmts, i, undefined, ctx);
    if (topRepeat) {
      actions.push(topRepeat.ref);
      i += topRepeat.consumed - 1;
      continue;
    }
    const topForEachInteger = tryBuildForEachIntegerFromStmtSequence(topStmts, i, undefined, ctx);
    if (topForEachInteger) {
      actions.push(topForEachInteger.ref);
      i += topForEachInteger.consumed - 1;
      continue;
    }

    // Skip boilerplate guard emitted by converter-generated galaxy.
    if (isInitVariablesCompletedGuard(s, libId) || isInitVariablesCompletedSet(s, libId)) {
      continue;
    }

    if (s.kind === SyntaxKind.VariableDeclaration) {
      const varName: string = (s.name as any)?.name ?? '';
      const autoVar = extractAutoVarName(varName);
      if (autoVar?.suffix === 'ae') {
        if (s.initializer) pendingAutoEnds.set(varName, s.initializer);
        continue;
      }
      if (autoVar?.suffix === 'ai') {
        if (s.initializer) pendingAutoIncrements.set(varName, s.initializer);
        continue;
      }
      if (autoVar?.suffix === 'at' && getTypeName(s.type) === 'fixed') continue;
      if (autoVar?.suffix === 'var' && getTypeName(s.type) === 'int') continue;
      // Skip loop/switch temp vars emitted by T2G and SC2 Editor
      if (autoVar?.suffix === 'g') continue;
      if (autoVar?.suffix === 'u') continue;
      if (autoVar?.suffix === 'val') continue;
      if (
        !s.initializer &&
        getTypeName(s.type) === 'int' &&
        varName.length > 0 &&
        isLoopCounterDeclaration(topStmts, i, varName)
      ) {
        continue;
      }

      const localName = extractLocalVarName(varName) ?? varName;
      const varId = generateId();
      const varJson = makeLocalVar(varId, libId, localName, s.type, globalVarByGalaxyName, ctx);
      if (autoVar) varJson.flags = ['NoScriptPrefix'];
      if (s.initializer) {
        varJson.initialValue = exprToParamRef(s.initializer, ctx, undefined, varJson.variableType?.type);
      } else {
        varJson.initialValue = attachDefaultParam(varJson, elements, libId);
      }
      elements[varId] = varJson;
      localVariables.push({ type: 'Variable', library: libId, id: varId });
      localVarByGalaxyName.set(varName, varId);
      continue;
    }

    const topSwitch = tryBuildSwitchFromStmtSequence(topStmts, i, undefined, ctx);
    if (topSwitch) {
      actions.push(topSwitch.ref);
      i += topSwitch.consumed - 1;
      continue;
    }

    const legacyPickEachPlayer = tryBuildLegacyPickEachPlayerFromStmtSequence(topStmts, i, undefined, ctx);
    if (legacyPickEachPlayer) {
      actions.push(legacyPickEachPlayer.ref);
      i += legacyPickEachPlayer.consumed - 1;
      continue;
    }

    const pickEachPlayer = tryBuildPickEachPlayerFromStmtSequence(topStmts, i, undefined, ctx);
    if (pickEachPlayer) {
      actions.push(pickEachPlayer.ref);
      i += pickEachPlayer.consumed - 1;
      continue;
    }
    const pickEachUnit = tryBuildPickEachUnitFromStmtSequence(topStmts, i, undefined, ctx);
    if (pickEachUnit) {
      actions.push(pickEachUnit.ref);
      i += pickEachUnit.consumed - 1;
      continue;
    }

    if (s.kind === SyntaxKind.ForStatement) {
      if (exprContainsUnresolvedCall(s.condition, ctx)) {
        actions.push(buildCustomScriptActionFCRef(s, undefined, ctx));
        continue;
      }
      const ref = buildPickEachIntegerFromForStmt(s, undefined, ctx, topStmts, i);
      // NEVER drop a loop silently — preserve as custom script when no
      // structured conversion matched.
      actions.push(ref ?? buildCustomScriptActionFCRef(s, undefined, ctx));
      continue;
    }

    if (s.kind === SyntaxKind.ExpressionStatement) {
      const expr = s.expression;
      if (exprContainsUnresolvedCall(expr, ctx)) {
        actions.push(buildCustomScriptActionFCRef(s, undefined, ctx));
        continue;
      }
      if (expr?.kind === SyntaxKind.BinaryExpression) {
        const opKind = expr.operatorToken?.kind as SyntaxKind;
        const left = expr.left;
        if (opKind === SyntaxKind.EqualsToken && left?.kind === SyntaxKind.Identifier) {
          const leftName: string = left.name;
          if (extractAutoVarName(leftName)?.suffix === 'var') {
            const nextStmt = topStmts[i + 1] as any;
            if (forStmtUsesCounterVar(nextStmt, leftName)) {
              pendingAutoInits.set(leftName, expr.right);
              continue;
            }
          }
          // Loop scaffolding referenced by an upcoming for-statement must be
          // consumed — falling through double-converts it into a broken
          // SetVariable on a non-existent variable.
          if (extractAutoVarName(leftName)?.suffix === 'ae' && upcomingForStmtUsesName(topStmts, i, leftName)) {
            pendingAutoEnds.set(leftName, expr.right);
            continue;
          }
          if (extractAutoVarName(leftName)?.suffix === 'ai' && upcomingForStmtUsesName(topStmts, i, leftName)) {
            pendingAutoIncrements.set(leftName, expr.right);
            continue;
          }

          // Fold scalar global variable initializations into Variable.initialValue
          // instead of emitting a SetVariable action.
          const varRef = globalVarByGalaxyName.get(leftName);
          if (varRef && varRef.library === libId) {
            const variable = elements[varRef.id] as VariableJson | undefined;
            if (variable?.type === 'Variable' && !variable.isArray) {
              const newInitRef = exprToParamRef(expr.right, ctx, undefined, variable.variableType?.type);
              // A generated call may also reference the old default Param;
              // the final reachability pass is the safe place to reclaim it.
              variable.initialValue = newInitRef;
              continue;
            }
          }
        }
      }
    }

    const ref = stmtToActionFCRef(s, undefined, ctx);
    if (ref) actions.push(ref);
  }

  return { actions, localVariables };
}

// ---------------------------------------------------------------------------
// Trigger body conversion
// ---------------------------------------------------------------------------

/** Only a prefix representable as ordered local initial values may become GUI conditions. */
export function analyzeTriggerPrefix(funcDecl: any): { length: number; declarations: any[]; initializers: Array<{ name: string; expression: any }> } | undefined {
  const nodes: any[] = [...(funcDecl.body?.statements ?? [])];
  let length = nodes.findIndex(node => node.kind === SyntaxKind.IfStatement &&
    (isRunActionsGuard(unwrapParens(node.expression)) || isTestCondsGuard(unwrapParens(node.expression), node.thenStatement)));
  if (length < 0) {
    // The editor omits the runActions guard for an entirely empty Trigger and
    // emits only its final `return true;`.  The matching _Init/TriggerCreate
    // pair is checked by the caller, so accepting that exact terminal shape
    // does not turn an arbitrary bool function into a Trigger.
    const tail = nodes.at(-1);
    if (tail?.kind !== SyntaxKind.ReturnStatement || unwrapParens(tail.expression)?.kind !== SyntaxKind.TrueKeyword) return undefined;
    length = nodes.length - 1;
  }
  return localInitialization(nodes, length);
}

/** Where a generated function body starts its actions: the editor heads them with
 * `// Implementation`, and only its own locals and their initial values precede it.
 * Hand-written Galaxy has no such banner, so its statements all stay actions. */
function generatedImplementationStart(body: any, statements: any[], sourceText: string | undefined): number | undefined {
  if (typeof sourceText !== 'string' || typeof body?.pos !== 'number' || typeof body.end !== 'number') return undefined;
  // A line holding only the comment cannot be inside a Galaxy string literal.
  const banner = /^[ \t]*\/\/ Implementation[ \t]*\r?$/mu.exec(sourceText.slice(body.pos, body.end));
  if (!banner) return undefined;
  const position = body.pos + banner.index;
  const index = statements.findIndex(statement => statement.pos > position);
  return index < 0 ? statements.length : index;
}

/** The first `length` statements as local declarations and the initial values the
 * editor assigns them, or undefined when any of them is something else. */
function localInitialization(nodes: any[], length: number): { length: number; declarations: any[]; initializers: Array<{ name: string; expression: any }> } | undefined {
  const declarations: any[] = [], initializers: Array<{ name: string; expression: any }> = [], names = new Set<string>(), initialized = new Set<string>();
  const fillLoops = new Set<any>(), counters = new Set<string>();
  for (const node of nodes.slice(0, length)) {
    if (node.kind === SyntaxKind.VariableDeclaration) {
      declarations.push(node); names.add(node.name.name);
      if (node.initializer) { initialized.add(node.name.name); initializers.push({ name: node.name.name, expression: node.initializer }); }
    } else if (node.kind === SyntaxKind.ForStatement) {
      // An array local with an initial value is filled by a counted loop; the
      // model stores the element value, the declaration carries the bound.
      const filled = arrayFillLoop(node, names);
      if (!filled || initialized.has(filled.name)) return undefined;
      initialized.add(filled.name); initializers.push({ name: filled.name, expression: filled.expression });
      fillLoops.add(node);
      for (const counter of filled.counters) counters.add(counter);
    } else {
      const expression = node.kind === SyntaxKind.ExpressionStatement ? node.expression : undefined;
      const name = expression?.left?.kind === SyntaxKind.Identifier ? expression.left.name : undefined;
      if (expression?.kind !== SyntaxKind.BinaryExpression || expression.operatorToken?.kind !== SyntaxKind.EqualsToken ||
        !name || !names.has(name) || initialized.has(name)) return undefined;
      initialized.add(name); initializers.push({ name, expression: expression.right });
    }
  }
  // The model stores an initial value per local, not a statement order, so what
  // has to hold is that no value reads a local initialized after it. Demanding
  // that the two orders coincide instead rejected the editor's own output,
  // where a local whose value is not a constant is declared plain and assigned
  // after the const loop scaffolding.
  const initializedAt = new Map(initializers.map((value, index) => [value.name, index]));
  for (const [index, value] of initializers.entries()) {
    for (const name of prefixIdentifiers(value.expression)) {
      const other = initializedAt.get(name);
      if (other !== undefined && other > index) return undefined;
    }
  }
  // The fill loops count with `int init_i;`, which the editor declares for them and
  // generates again; kept, it became a stray local in every such trigger.
  const read = prefixIdentifiers(nodes.flatMap(node => fillLoops.has(node) ? []
    : node.kind === SyntaxKind.VariableDeclaration ? [node.initializer] : [node]));
  return { length, declarations: declarations.filter(node => !counters.has(node.name.name) || read.has(node.name.name)), initializers };
}

/** `for (i = 0; i <= bound; i += 1) { name[i][...] = value; }` as written by the
 *  editor for an array local with an initial value, or undefined for any other
 *  loop. The counter and the bound live in the declaration, so only the element
 *  value is recovered. */
function arrayFillLoop(node: any, names: Set<string>): { name: string; expression: any; counters: string[] } | undefined {
  const counters: string[] = [];
  let statement: any = node;
  while (statement?.kind === SyntaxKind.ForStatement) {
    const init = unwrapParens(statement.initializer);
    const counter = init?.left?.kind === SyntaxKind.Identifier ? init.left.name : undefined;
    const condition = unwrapParens(statement.condition);
    const increment = statement.incrementor;
    if (!counter || counters.includes(counter) ||
      init?.kind !== SyntaxKind.BinaryExpression || init.operatorToken?.kind !== SyntaxKind.EqualsToken ||
      unwrapParens(init.right)?.kind !== SyntaxKind.NumericLiteral || Number(unwrapParens(init.right).value) !== 0 ||
      condition?.kind !== SyntaxKind.BinaryExpression || condition.left?.name !== counter ||
      ![SyntaxKind.LessThanToken, SyntaxKind.LessThanEqualsToken].includes(condition.operatorToken?.kind) ||
      increment?.kind !== SyntaxKind.BinaryExpression || increment.operatorToken?.kind !== SyntaxKind.PlusEqualsToken ||
      increment.left?.name !== counter || unwrapParens(increment.right)?.kind !== SyntaxKind.NumericLiteral ||
      Number(unwrapParens(increment.right).value) !== 1) return undefined;
    const body = statement.statement?.kind === SyntaxKind.Block ? [...statement.statement.statements] : [statement.statement];
    if (body.length !== 1) return undefined;
    counters.push(counter);
    statement = body[0];
  }
  const write = statement?.kind === SyntaxKind.ExpressionStatement ? statement.expression : undefined;
  if (write?.kind !== SyntaxKind.BinaryExpression || write.operatorToken?.kind !== SyntaxKind.EqualsToken) return undefined;
  let target = unwrapParens(write.left);
  const indices: string[] = [];
  while (target?.kind === SyntaxKind.ElementAccessExpression) {
    const index = unwrapParens(target.argumentExpression);
    if (index?.kind !== SyntaxKind.Identifier) return undefined;
    indices.unshift(index.name);
    target = unwrapParens(target.expression);
  }
  const name = target?.kind === SyntaxKind.Identifier ? target.name : undefined;
  if (!name || !names.has(name) || indices.length !== counters.length ||
    !indices.every((index, position) => index === counters[position])) return undefined;
  return { name, expression: write.right, counters };
}

/** Every identifier an initializer expression reads. */
function prefixIdentifiers(node: any): Set<string> {
  const names = new Set<string>();
  const pending: any[] = [node];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (value.kind === SyntaxKind.Identifier && typeof value.name === 'string') names.add(value.name);
    for (const [key, child] of Object.entries(value)) {
      if (key === 'parent' || key === 'syntaxTokens') continue;
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return names;
}

export function convertTriggerBody(
  funcDecl: FunctionDeclaration,
  triggerName: string,
  libId: string,
  elements: Record<string, ElementJson>,
  funcNameToFuncDef: Map<string, FunctionDefJson>,
  roleToSubFuncType: Map<string, { library: string; id: string }>,
  globalVarByGalaxyName: Map<string, { id: string; library: string }>,
  galaxyConstToPreset: Map<string, ElementRefJson>,
  structureByGalaxyTypeName?: Map<string, ElementRefJson>,
  structureMemberByKey?: Map<string, ElementRefJson>,
  nativeLibrary?: TriggerLibraryJson,
  externalFuncParamTypes?: Map<string, string[]>,
  crossLibFuncDefs?: Map<string, CrossLibFunctionDefInfo>,
  sourceText?: string,
  triggerByGalaxyName?: Map<string, ElementRefJson>,
  dependencyLibraries?: Map<string, TriggerLibraryJson>,
  constants?: GalaxyConstantIndex,
  reservedId?: string,
): TriggerJson {
  // The caller reserves this identity before any body is read, so that a
  // forward reference to this trigger already resolves while it is converted.
  const triggerId = reservedId ?? generateId();
  const events: ElementRefJson[] = [];
  const conditions: ElementRefJson[] = [];
  const actions: ElementRefJson[] = [];
  const localVariables: ElementRefJson[] = [];

  const localVarByGalaxyName = new Map<string, string>();
  const pendingAutoInits = new Map<string, any>();
  const pendingAutoEnds = new Map<string, any>();
  const pendingAutoIncrements = new Map<string, any>();

  const ctx: ReverseCtx = {
    libId,
    elements,
    nativeLibrary,
    dependencyLibraries,
    constants: constants?.scope([...(funcDecl.parameters ?? []), ...((funcDecl.body as any)?.statements ?? [])]),
    funcNameToFuncDef,
    roleToSubFuncType,
    localVarByGalaxyName,
    globalVarByGalaxyName,
    pendingAutoInits,
    pendingAutoEnds,
    pendingAutoIncrements,
    galaxyConstToPreset,
    structureByGalaxyTypeName,
    structureMemberByKey,
    externalFuncParamTypes,
    crossLibFuncDefs,
    sourceText,
    triggerByGalaxyName,
  };

  const body = funcDecl.body;
  if (!body) {
    return { type: 'Trigger', id: triggerId, library: libId, name: triggerName, events, conditions, actions, localVariables };
  }

  ctx.returnType = 'bool';
  ctx.structuredLocals = localVariables;
  ctx.structuredTemplates = new Map();
  const topStmts = Array.from(body.statements ?? []) as any[];
  ctx.structuredFunctionStatements = topStmts;
  const prefix = analyzeTriggerPrefix(funcDecl);
  if (!prefix) throw new Error('Trigger prefix is not representable as ordered GUI initial values');
  for (const declaration of prefix.declarations) declareStructuredLocal(declaration, ctx);
  for (const initial of prefix.initializers) {
    const variable = elements[localVarByGalaxyName.get(initial.name)!] as VariableJson;
    variable.initialValue = structuredParam(initial.expression, ctx, undefined, variable.variableType?.type);
  }
  const retained: any[] = [];
  const returns = (statement: any, kind: SyntaxKind): boolean => statement?.kind === SyntaxKind.Block && statement.statements.length === 1 && statement.statements[0].kind === SyntaxKind.ReturnStatement && statement.statements[0].expression?.kind === kind;
  for (let i = prefix.length; i < topStmts.length; i++) {
    const s = topStmts[i];
    if (s.kind === SyntaxKind.IfStatement && !s.elseStatement) {
      if (isRunActionsGuard(unwrapParens(s.expression)) && returns(s.thenStatement, SyntaxKind.TrueKeyword)) continue;
      const guards = triggerConditionGuards(s);
      if (guards) {
        for (const guard of guards) conditions.push(structuredNode(unwrapParens(unwrapParens(guard.expression).operand), true, ctx));
        continue;
      }
    }
    if (s.kind === SyntaxKind.ReturnStatement && i === topStmts.length - 1 && s.expression?.kind === SyntaxKind.TrueKeyword) continue;
    retained.push(s);
  }
  actions.push(...structuredStatements(retained, ctx));

  return {
    type: 'Trigger',
    id: triggerId,
    library: libId,
    name: triggerName,
    events,
    conditions,
    actions,
    localVariables,
  };
}
