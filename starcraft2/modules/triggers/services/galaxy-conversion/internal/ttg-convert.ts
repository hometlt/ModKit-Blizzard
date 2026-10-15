import { conversionError, encodePayload, refKey } from './conversion-model.js';
import { createBlock } from './ast-factory.js';
import { convertAction as forwardAction } from './ttg-actions.js';
import { expressionKey, memoExpression } from './ttg-core.js';
import { actualParameterType, convertParamExpr as forwardParamExpr } from './ttg-params.js';
import { emitScriptTemplate, isInlineTemplate } from './ttg-template.js';
/**
 * ttg-convert — expression and payload conversion hub for trigger→Galaxy.
 *
 * This file is the central converter for the forward direction.  It owns:
 *   - Payload encoding types and functions (EncodedXxx, encodeXxx)
 *     Used to preserve unresolved sub-function trees across the roundtrip.
 *     See payload-sentinels.ts for the wire format documentation.
 *   - convertFunctionCallExpr — converts a FunctionCallJson to a Galaxy
 *     Expression using loaded templates or ordinary function calls.
 *   - Compatibility adapters — convertComparison, convertArithmeticOperator,
 *     convertSubFuncCondition, convertLogicalConditions, convertFirstConditionExpr.
 *
 * Depends on: ttg-core, ttg-params, payload-sentinels.
 * Consumed by: ttg-actions, trigger-to-galaxy.
 */
import { Printer, SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core';

const expressionPrinter = new Printer();

import type {
  ElementRefJson,
  FunctionCallJson,
  FunctionDefJson,
  ParamDefJson,
  ParamJson,
  PresetValueJson,
  VariableJson
} from '../../../shared/trigger-document/index.js';

import type {
  Expression,
  Statement
} from '@modkit/blizzard-starcraft2/galaxy/language-core';

import {
  createBinaryExpression,
  createCallExpression,
  createIdentifier,
  createNumericLiteral,
  createParenthesizedExpression,
  createStringLiteral
} from './ast-factory.js';

import {
  ConversionContext,
  mapParameterTypeToGalaxy,
  getSubFuncRole,
  resolveRefFull,
  resolveVariableGalaxyName,
  toGalaxyFunctionName,
  isIdentityConversionOperator
} from './ttg-core.js';

import {
  UNKNOWN_SUBFUNC_JSON_SENTINEL,
  UNKNOWN_SUBFUNC_SENTINEL,
  UNKNOWN_SUBFUNC_TYPE_SENTINEL,
} from '../../../shared/trigger-document/payload-sentinels.js';

// ---------------------------------------------------------------------------
// Payload encoding types
// ---------------------------------------------------------------------------

export type EncodedRefPayload = {
  type?: string;
  library?: string;
  id: string;
  name?: string;
};

export type EncodedParamPayload = {
  parameterDef?: EncodedRefPayload;
  value?: string;
  valueType?: { type?: string };
  valueId?: { id: string };
  valueElement?: EncodedRefPayload;
  valueGameType?: { type?: string };
  variable?: EncodedRefPayload;
  preset?: EncodedRefPayload;
  functionCall?: EncodedFunctionCallPayload;
};

export type EncodedFunctionCallPayload = {
  functionDef?: EncodedRefPayload;
  subFunctionType?: EncodedRefPayload;
  parameters?: EncodedParamPayload[];
  subFunctions?: EncodedFunctionCallPayload[];
};

// ---------------------------------------------------------------------------
// Encode functions
// ---------------------------------------------------------------------------

export function encodeUnknownSubFunctionRoleToken(
  fc: FunctionCallJson,
  ctx: ConversionContext,
): string {
  if (fc.subFunctionType?.library && fc.subFunctionType?.id) {
    return `${UNKNOWN_SUBFUNC_TYPE_SENTINEL}:${fc.subFunctionType.library}:${fc.subFunctionType.id}`;
  }
  return getSubFuncRole(fc, ctx);
}

export function encodeRefPayload(ref: ElementRefJson | undefined): EncodedRefPayload | undefined {
  if (!ref?.id) return undefined;
  return {
    type: ref.type,
    library: ref.library,
    id: ref.id,
  };
}

export function encodeVariableRefPayload(
  ref: ElementRefJson | undefined,
  ctx: ConversionContext,
): EncodedRefPayload | undefined {
  if (!ref?.id) return undefined;
  const payload = encodeRefPayload(ref);
  const variable = resolveRefFull(ref, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as VariableJson | undefined;
  if (payload && variable) {
    payload.name = resolveVariableGalaxyName(variable, ref, ctx);
  }
  return payload;
}

export function encodeFunctionCallPayload(
  call: FunctionCallJson,
  ctx: ConversionContext,
): EncodedFunctionCallPayload {
  const parameters = (call.parameters ?? [])
    .map(ref => resolveRefFull(ref, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as ParamJson | undefined)
    .filter((param): param is ParamJson => param !== undefined)
    .map(param => encodeParamPayload(param, ctx));

  const subFunctions = (call.subFunctions ?? [])
    .map(ref => resolveRefFull(ref, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as FunctionCallJson | undefined)
    .filter((fc): fc is FunctionCallJson => fc !== undefined)
    .map(fc => encodeFunctionCallPayload(fc, ctx));

  const functionDefPayload = encodeRefPayload(call.functionDef);
  const functionDef = resolveRefFull(
    call.functionDef,
    ctx.library,
    ctx.nativeLibrary,
    ctx.allLibraries,
  ) as FunctionDefJson | undefined;
  if (functionDefPayload && functionDef?.name) {
    functionDefPayload.name = functionDef.name;
  }

  const out: EncodedFunctionCallPayload = {
    functionDef: functionDefPayload,
  };
  if (call.subFunctionType?.id) out.subFunctionType = encodeRefPayload(call.subFunctionType);
  if (parameters.length > 0) out.parameters = parameters;
  if (subFunctions.length > 0) out.subFunctions = subFunctions;
  return out;
}

export function encodeParamPayload(
  param: ParamJson,
  ctx: ConversionContext,
): EncodedParamPayload {
  const out: EncodedParamPayload = {};
  if (param.parameterDef?.id) out.parameterDef = encodeRefPayload(param.parameterDef);
  if (param.value !== undefined) out.value = param.value;
  if (param.valueType?.type) out.valueType = { type: param.valueType.type };
  if ((param as any).valueId?.id) out.valueId = { id: (param as any).valueId.id };
  if ((param as any).valueElement?.id) out.valueElement = encodeRefPayload((param as any).valueElement);
  if ((param as any).valueGameType?.type) out.valueGameType = { type: (param as any).valueGameType.type };
  if (param.variable?.id) out.variable = encodeVariableRefPayload(param.variable, ctx);
  if (param.preset?.id) out.preset = encodeRefPayload(param.preset);
  if (param.functionCall) {
    const nested = resolveRefFull(
      param.functionCall,
      ctx.library,
      ctx.nativeLibrary,
      ctx.allLibraries,
    ) as FunctionCallJson | undefined;
    if (nested) out.functionCall = encodeFunctionCallPayload(nested, ctx);
  }
  return out;
}

export function encodeUnknownSubFunctionPayload(
  call: FunctionCallJson,
  ctx: ConversionContext,
): string {
  const json = JSON.stringify(encodeFunctionCallPayload(call, ctx));
  return `${UNKNOWN_SUBFUNC_JSON_SENTINEL}:${encodePayload(json)}`;
}

// ---------------------------------------------------------------------------
// Parameter → Expression
// ---------------------------------------------------------------------------

export const _dbg = { paramCalls: 0, paramCacheHits: 0, fcCalls: 0, fcCacheHits: 0, actionDepth: 0, maxActionDepth: 0, actionCalls: 0 };
export function _dbgReset() { _dbg.paramCalls = 0; _dbg.paramCacheHits = 0; _dbg.fcCalls = 0; _dbg.fcCacheHits = 0; _dbg.actionDepth = 0; _dbg.maxActionDepth = 0; _dbg.actionCalls = 0; }

/** Compatibility entry point; literal and parameter rules have one implementation. */
export function convertParamExpr(param: ParamJson, ctx: ConversionContext): Expression | undefined {
  _dbg.paramCalls++;
  return forwardParamExpr(param, ctx);
}

export function convertFunctionCallExpr(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Expression | undefined {
  _dbg.fcCalls++;
  return memoExpression(call, ctx, () => _convertFunctionCallExprInner(call, ctx));
}

function _convertFunctionCallExprInner(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Expression | undefined {
  const funcDef = resolveRefFull(
    call.functionDef,
    ctx.library,
    ctx.nativeLibrary,
    ctx.allLibraries,
  ) as FunctionDefJson | undefined;

  if (funcDef && isIdentityConversionOperator(funcDef, ctx.library, ctx.nativeLibrary, ctx.allLibraries)) {
    // The editor writes a conversion between types of one Galaxy type as its argument in parentheses:
    // `StringToText((lp_hybrid))` for Convert Game Link To String (09-RiftsToKorhal, AllRaces2-Tester).
    const argument = buildOrderedArgs(call, funcDef, ctx)[0];
    return argument === undefined ? undefined : createParenthesizedExpression(argument);
  }
  // IntLoopCurrent inside a for-loop body → auto_var identifier
  if (funcDef && isInlineTemplate(funcDef)) return emitScriptTemplate(call, funcDef, ctx, true) as Expression;
  if ((call.subFunctions?.length ?? 0) > 0) conversionError('UNSUPPORTED_TEMPLATE', 'An expression subfunction tree needs a loaded ScriptCode template', { call: refKey(call) });

  const funcName = toGalaxyFunctionName(funcDef, ctx, call.functionDef);
  if (funcName === 'null') return undefined;
  const args: Expression[] = buildOrderedArgs(call, funcDef, ctx);
  if (funcDef?.flags?.includes('Event')) {
    if (ctx.eventRegistrationTarget) {
      args.unshift(createIdentifier(ctx.eventRegistrationTarget));
    } else {
      // TriggerData omits the first `trigger` argument used by Galaxy's
      // TriggerAddEvent* natives.  Calls attached to a Trigger obtain it from
      // eventRegistrationTarget above.  A direct runtime registration inside
      // an ordinary function has already preserved that hidden argument as an
      // extra positional Param during Galaxy -> Triggers conversion.
      const declaredCount = funcDef.parameters?.length ?? 0;
      if (args.length !== declaredCount + 1) {
        conversionError('EVENT_CONTEXT', 'Event registration requires a target trigger', { call: refKey(call) });
      }
    }
  }
  return createCallExpression(funcName, args);
}

export function buildEncodedUnknownFunctionCallExpr(
  call: FunctionCallJson,
  ctx: ConversionContext,
  funcDef?: FunctionDefJson,
): Expression | undefined {
  const funcName = toGalaxyFunctionName(funcDef, ctx, call.functionDef);
  const paramArgs = buildOrderedArgs(call, funcDef, ctx);
  const subCalls = (call.subFunctions ?? [])
    .map(r => resolveRefFull(r, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as FunctionCallJson | undefined)
    .filter((fc): fc is FunctionCallJson => fc !== undefined);

  const encodedChildren: Array<{ role: string; expr: Expression }> = [];
  for (const sf of subCalls) {
    const expr = (sf.subFunctions?.length ?? 0) > 0
      ? createStringLiteral(encodeUnknownSubFunctionPayload(sf, ctx))
      : convertFunctionCallExpr(sf, ctx) ?? createStringLiteral(encodeUnknownSubFunctionPayload(sf, ctx));
    if (!expr) continue;
    encodedChildren.push({
      role: encodeUnknownSubFunctionRoleToken(sf, ctx),
      expr,
    });
  }

  if (encodedChildren.length === 0) {
    return createCallExpression(funcName, paramArgs);
  }

  const tail: Expression[] = [
    createStringLiteral(UNKNOWN_SUBFUNC_SENTINEL),
    createNumericLiteral(encodedChildren.length),
  ];
  for (const child of encodedChildren) {
    tail.push(createStringLiteral(child.role));
    tail.push(child.expr);
  }

  return createCallExpression(funcName, [...paramArgs, ...tail]);
}

/**
 * Build call arguments in the order defined by the FunctionDef's parameters array.
 */
export function buildOrderedArgs(
  call: FunctionCallJson,
  funcDef: FunctionDefJson | undefined,
  ctx: ConversionContext,
): Expression[] {
  const rawParams = call.parameters ?? [];
  if (rawParams.length === 0) return [];

  // Local param cache: param.id → Expression.
  // Prevents re-converting the same param in the hasDuplicateDefIds and fallback
  // paths — without this, params are converted up to 3× per call, which is
  // 3^depth conversions in deeply-nested trigger code.
  const localCache = new Map<string, Expression>();
  function getExpr(param: ParamJson): Expression | undefined {
    const cached = localCache.get(expressionKey(param, ctx));
    if (cached) return cached;
    const expr = convertParamExpr(param, ctx);
    if (expr) localCache.set(expressionKey(param, ctx), expr);
    return expr;
  }

  // Single pass: resolve all params, convert once, build defId → expr map
  const paramByDefId = new Map<string, Expression>();
  const seenDefIds = new Set<string>();
  let hasDuplicateDefIds = false;
  const positional: Expression[] = [];
  // keep resolved params in order so fallback/duplicate paths don't re-resolve
  const resolvedInOrder: Array<ParamJson> = [];

  // The Trigger editor has a distinct `unitref` contract for event filters.
  // XML object IDs identify a concrete `unit`, while the Galaxy API expects a
  // reference wrapper. The wrapper is an SC2 API conversion, not a heuristic:
  // only insert it after both the declared formal type and actual operand type
  // have been resolved from loaded TriggerData.
  function coerceForFormal(param: ParamJson, expression: Expression, formal?: ParamDefJson): Expression {
    const expected = formal && mapParameterTypeToGalaxy(formal.paramType, ctx.library, ctx.nativeLibrary, ctx.allLibraries).toLowerCase();
    const actual = actualParameterType(param, ctx);
    const actualType = actual && mapParameterTypeToGalaxy(actual, ctx.library, ctx.nativeLibrary, ctx.allLibraries).toLowerCase();
    // NativeLib encodes `unitref` as a `unit` ParamType plus
    // ParamFlagReference. The generated Galaxy declaration exposes that as
    // `unitref`, so consult both pieces of the loaded contract.
    const isNull = expression.kind === SyntaxKind.Identifier && (expression as any).name === 'null';
    if (!isNull && (expected === 'unitref' || (expected === 'unit' && formal?.isReference === true)) && actualType === 'unit') {
      // ParamFlagReference has two distinct editor encodings. A structural
      // Variable/Array path names storage and must become UnitRefFromVariable
      // with that l-value as authored text. A scalar/object unit value denotes
      // an already resolved unit and therefore uses UnitRefFromUnit instead.
      // Do not choose between them by identifier spelling: the XML operand
      // shape is the contract used by the editor.
      if (param.variable) {
        return createCallExpression('UnitRefFromVariable', [
          createStringLiteral(expressionPrinter.printNode(expression).trim()),
        ]);
      }
      return createCallExpression('UnitRefFromUnit', [expression]);
    }
    return expression;
  }

  for (const paramRef of rawParams) {
    const param = resolveRefFull(paramRef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as ParamJson | undefined;
    if (!param) continue;
    resolvedInOrder.push(param);
    const expr = getExpr(param);
    if (!expr) continue;
    const defId = param.parameterDef ? refKey(param.parameterDef, ctx.libId) : undefined;
    if (defId) {
      if (seenDefIds.has(defId)) hasDuplicateDefIds = true;
      seenDefIds.add(defId);
      paramByDefId.set(defId, expr);
    } else {
      positional.push(expr);
    }
  }

  // Variadic calls (e.g. StringCombine) use XML order — reuse already-computed exprs
  if (hasDuplicateDefIds) {
    return resolvedInOrder.map(p => getExpr(p)).filter((e): e is Expression => !!e);
  }

  // Use funcDef's declared parameter order when available
  if (funcDef && funcDef.parameters && funcDef.parameters.length > 0) {
    const ordered: Expression[] = [];
    for (const paramDefRef of funcDef.parameters) {
      const defId = refKey(paramDefRef, funcDef.library ?? ctx.libId);
      if (defId) {
        const expr = paramByDefId.get(defId);
        if (expr) {
          const source = resolvedInOrder.find(param => param.parameterDef && refKey(param.parameterDef, ctx.libId) === defId);
          const formal = resolveRefFull(paramDefRef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as ParamDefJson | undefined;
          ordered.push(source ? coerceForFormal(source, expr, formal) : expr);
        }
      }
    }
    return ordered.length > 0 ? [...ordered, ...positional] : positional;
  }

  // Fallback: XML order — reuse already-computed exprs
  return resolvedInOrder.map(p => getExpr(p)).filter((e): e is Expression => !!e);
}

export function convertComparison(call: FunctionCallJson, ctx: ConversionContext): Expression | undefined {
  return convertFunctionCallExpr(call, ctx);
}

/** Convert Or/And FunctionCalls whose conditions are stored as sub-functions. */
export function convertSubFuncCondition(
  call: FunctionCallJson,
  scriptCode: string,
  ctx: ConversionContext,
): Expression | undefined {
  const m = scriptCode.match(/#SUBFUNCS\(\w+,\s*"([^"]+)"\)/);
  const sep = m?.[1] ?? ' && ';
  const logicOp = sep.includes('||') ? SyntaxKind.BarBarToken : SyntaxKind.AmpersandAmpersandToken;

  const exprs: Expression[] = [];
  for (const sfRef of call.subFunctions ?? []) {
    const sf = resolveRefFull(sfRef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as FunctionCallJson | undefined;
    if (sf) {
      const expr = convertFunctionCallExpr(sf, ctx);
      if (expr) exprs.push(expr);
    }
  }
  if (exprs.length === 0) return undefined;
  if (exprs.length === 1) return exprs[0];
  return createParenthesizedExpression(exprs.reduce((a, b) => createBinaryExpression(a, logicOp, b)));
}

export function convertLogicalConditions(
  call: FunctionCallJson,
  ctx: ConversionContext,
  isAnd: boolean,
): Expression | undefined {
  const exprs: Expression[] = [];
  for (const paramRef of call.parameters ?? []) {
    const param = resolveRefFull(paramRef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as ParamJson | undefined;
    if (param?.functionCall) {
      const fc = resolveRefFull(param.functionCall, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as FunctionCallJson | undefined;
      if (fc) {
        const expr = convertFunctionCallExpr(fc, ctx);
        if (expr) exprs.push(expr);
      }
    }
  }
  if (exprs.length === 0) return undefined;
  const logicOp = isAnd ? SyntaxKind.AmpersandAmpersandToken : SyntaxKind.BarBarToken;
  return exprs.reduce((a, b) => createBinaryExpression(a, logicOp, b));
}

/** Best-effort extraction of first nested condition expression. */
export function convertFirstConditionExpr(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Expression | undefined {
  for (const sfRef of call.subFunctions ?? []) {
    const sf = resolveRefFull(sfRef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as FunctionCallJson | undefined;
    if (!sf) continue;
    const expr = convertFunctionCallExpr(sf, ctx);
    if (expr) return expr;
  }
  for (const paramRef of call.parameters ?? []) {
    const param = resolveRefFull(paramRef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as ParamJson | undefined;
    if (!param?.functionCall) continue;
    const fc = resolveRefFull(param.functionCall, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as FunctionCallJson | undefined;
    if (!fc) continue;
    const expr = convertFunctionCallExpr(fc, ctx);
    if (expr) return expr;
  }
  return undefined;
}

export function buildParamNameMap(
  callParams: ElementRefJson[],
  ctx: ConversionContext,
): Map<string, ParamJson> {
  const map = new Map<string, ParamJson>();
  for (const paramRef of callParams) {
    const param = resolveRefFull(paramRef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as ParamJson | undefined;
    if (!param) continue;
    const paramDef = resolveRefFull(param.parameterDef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as ParamDefJson | undefined;
    const name = paramDef?.name ?? paramRef.id;
    map.set(name, param);
  }
  return map;
}

/** Resolve the string value of an operator preset param ("+" / "-" / "*" / "/" etc.). */
export function resolveOperatorString(opParam: ParamJson | undefined, ctx: ConversionContext): string | undefined {
  if (!opParam) return undefined;
  if (opParam.value) return opParam.value;
  if (opParam.preset) {
    const pv = resolveRefFull(opParam.preset, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as PresetValueJson | undefined;
    return pv?.value;
  }
  return undefined;
}

/** Convert a FlagCall+Operator function (e.g. ArithmeticInt) to infix (val1 op val2). */
export function convertArithmeticOperator(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Expression | undefined {
  return convertFunctionCallExpr(call, ctx);
}

/** Expand a FlagAction+Operator scriptCode template into a Statement. */
export function convertScriptCodeAction(
  call: FunctionCallJson,
  funcDef: FunctionDefJson,
  ctx: ConversionContext,
): Statement | undefined {
  const result = emitScriptTemplate(call, funcDef, ctx, false) as Statement[];
  return Array.isArray(result) ? result.length === 1 ? result[0] : createBlock(result) : result;
}

// ---------------------------------------------------------------------------
// Sub-block helpers
// ---------------------------------------------------------------------------

export function collectActionStatements(
  calls: FunctionCallJson[],
  ctx: ConversionContext,
): Statement[] {
  const stmts: Statement[] = [];
  for (const call of calls) {
    const result = convertAction(call, ctx);
    if (result !== undefined) {
      if (Array.isArray(result)) stmts.push(...result);
      else stmts.push(result);
    }
  }
  return stmts;
}

export function collectConditionExpr(
  calls: FunctionCallJson[],
  ctx: ConversionContext,
): Expression {
  if (calls.length === 0) return createIdentifier('true');
  const exprs = calls.map(c => convertFunctionCallExpr(c, ctx)).filter(Boolean) as Expression[];
  if (exprs.length === 0) return createIdentifier('true');
  if (exprs.length === 1) return exprs[0];
  return exprs.reduce((a, b) => createBinaryExpression(a, SyntaxKind.AmpersandAmpersandToken, b));
}

// ---------------------------------------------------------------------------
// Action conversion
// ---------------------------------------------------------------------------

export function convertAction(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement | Statement[] | undefined {
  return forwardAction(call, ctx);
}

export function convertSetVariable(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement | undefined {
  const result = convertAction(call, ctx);
  return Array.isArray(result) ? result.length === 1 ? result[0] : createBlock(result) : result;
}

export function convertIfThenElse(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement | undefined {
  const result = convertAction(call, ctx);
  return Array.isArray(result) ? result.length === 1 ? result[0] : createBlock(result) : result;
}

export function convertIfThenMultiple(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement | undefined {
  const result = convertAction(call, ctx);
  return Array.isArray(result) ? result.length === 1 ? result[0] : createBlock(result) : result;
}

export function convertWhileDo(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement | undefined {
  const result = convertAction(call, ctx);
  return Array.isArray(result) ? result.length === 1 ? result[0] : createBlock(result) : result;
}

export function convertRepeat(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement[] {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}

export function convertRepeatForever(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result.length === 1 ? result[0] : createBlock(result) : result;
}

export function convertWaitForCondition(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result.length === 1 ? result[0] : createBlock(result) : result;
}

export function convertWaitForConditionWithMaximumDuration(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement[] {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}

export function convertActionQueueAdd(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement[] {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}

export function convertPickEachInteger(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement[] {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}

export function exprLooksFixed(expr: Expression | undefined): boolean {
  if (!expr) return false;
  if (expr.kind === SyntaxKind.NumericLiteral) {
    const raw = String((expr as any).text ?? (expr as any).value ?? '');
    return raw.includes('.');
  }
  if (expr.kind === SyntaxKind.ParenthesizedExpression) {
    return exprLooksFixed((expr as any).expression);
  }
  return false;
}

export function convertForEachInteger(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement[] | undefined {
  const result = convertAction(call, ctx);
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}

export function convertPickEachPlayerInGroup(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement[] {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}

export function convertPickEachUnitInGroup(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement[] {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}

export function convertSwitch(
  call: FunctionCallJson,
  ctx: ConversionContext,
): Statement[] {
  const result = convertAction(call, ctx);
  if (result === undefined) return conversionError('ACTION_CONVERSION', 'Action could not be converted', { call: refKey(call) });
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}
