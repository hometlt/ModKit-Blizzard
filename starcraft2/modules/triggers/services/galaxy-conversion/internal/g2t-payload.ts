import { decodePayload, conversionError, libraryPrefix } from './conversion-model.js';
/**
 * g2t-payload — payload decode helpers for the Galaxy→trigger reverse conversion.
 *
 * Mirrors the encode functions in ttg-convert.ts.  When galaxy-to-trigger
 * encounters a call with the __MKX_SF__ sentinel tail (written by
 * buildEncodedUnknownFunctionCallExpr), these functions reconstruct the
 * original FunctionCall elements from the serialised payload:
 *
 *   readStringLiteral / readIntLiteral — extract typed literals from AST nodes
 *   decodeRoleToken — parses role name or raw __MKX_SFT__ SubFuncType token
 *   decodeUnknownSubFunctionPayload — base64-decodes a __MKX_FCJSON__ string
 *   rehydrateParamPayload — rebuilds a ParamJson element from a decoded payload
 *   rehydrateFunctionCallPayload — rebuilds a FunctionCallJson element tree
 *   decodeUnknownSubFunctionTail — orchestrates the full tail extraction
 *
 * callFn and condFn are passed as callbacks to break the circular dependency
 * between this module and g2t-call (which owns callExprToFCRef / exprToConditionFCRef).
 *
 * Depends on: g2t-core, payload-sentinels.
 * Consumed by: g2t-call.
 */
import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core';

import type {
  FunctionCallJson,
  ParamJson,
  ElementRefJson,
} from '../../../shared/trigger-document/index.js';

import {
  ReverseCtx,
  mkParamRef,
  mkFCRef,
  fdRef,
  unwrapParens,
  sanitizeFuncName,
} from './g2t-core.js';

import {
  UNKNOWN_SUBFUNC_SENTINEL,
  UNKNOWN_SUBFUNC_TYPE_SENTINEL,
  UNKNOWN_SUBFUNC_JSON_SENTINEL,
} from '../../../shared/trigger-document/payload-sentinels.js';

// ---------------------------------------------------------------------------
// Literal readers
// ---------------------------------------------------------------------------

export function readStringLiteral(expr: any): string | undefined {
  const e = unwrapParens(expr);
  if (e?.kind !== SyntaxKind.StringLiteral) return undefined;
  return String(e.value ?? '');
}

export function readIntLiteral(expr: any): number | undefined {
  const e = unwrapParens(expr);
  if (e?.kind !== SyntaxKind.NumericLiteral) return undefined;
  const n = Number(e.text ?? e.value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

// ---------------------------------------------------------------------------
// Role token decoder
// ---------------------------------------------------------------------------

export function decodeRoleToken(roleToken: string | undefined, ctx: ReverseCtx): { library: string; id: string } | undefined {
  if (!roleToken) return undefined;
  if (roleToken.startsWith(`${UNKNOWN_SUBFUNC_TYPE_SENTINEL}:`)) {
    const raw = roleToken.slice((`${UNKNOWN_SUBFUNC_TYPE_SENTINEL}:`).length);
    const sep = raw.indexOf(':');
    if (sep > 0) {
      const lib = raw.slice(0, sep);
      const id = raw.slice(sep + 1);
      if (lib && id) return { library: lib, id };
    }
    return undefined;
  }
  return ctx.roleToSubFuncType.get(roleToken);
}

// ---------------------------------------------------------------------------
// Unknown subfunction payload decoders
// ---------------------------------------------------------------------------

export function decodeUnknownSubFunctionPayload(raw: string | undefined): any | undefined {
  if (!raw?.startsWith(`${UNKNOWN_SUBFUNC_JSON_SENTINEL}:`)) return undefined;
  try {
    const encoded = raw.slice((`${UNKNOWN_SUBFUNC_JSON_SENTINEL}:`).length);
    const json = decodePayload(encoded);
    return JSON.parse(json);
  } catch {
    conversionError('INVALID_PAYLOAD', 'Invalid encoded Trigger function-call payload');
  }
}

export function rehydrateParamPayload(payload: any, ctx: ReverseCtx): ElementRefJson | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const data: Partial<Omit<ParamJson, 'type' | 'id' | 'library'>> = {};
  if (payload.parameterDef?.id) data.parameterDef = payload.parameterDef;
  if (payload.value !== undefined) data.value = payload.value;
  if (payload.valueType?.type) data.valueType = { type: payload.valueType.type };
  if (payload.valueId?.id) (data as any).valueId = { id: payload.valueId.id };
  if (payload.valueElement?.id) data.valueElement = payload.valueElement;
  if (payload.valueGameType?.type) (data as any).valueGameType = { type: payload.valueGameType.type };
  if (payload.variable?.id) {
    const localId = payload.variable.name ? ctx.localVarByGalaxyName.get(payload.variable.name) : undefined;
    const globalRef = payload.variable.name ? ctx.globalVarByGalaxyName.get(payload.variable.name) : undefined;
    if (localId) {
      data.variable = { type: 'Variable', library: ctx.libId, id: localId };
    } else if (globalRef) {
      data.variable = { type: 'Variable', library: globalRef.library, id: globalRef.id };
    } else {
      data.variable = payload.variable;
    }
  }
  if (payload.preset?.id) data.preset = payload.preset;
  if (payload.functionCall) {
    const nested = rehydrateFunctionCallPayload(payload.functionCall, ctx);
    if (nested) data.functionCall = nested;
  }
  return mkParamRef(data, ctx);
}

export function rehydrateFunctionCallPayload(
  payload: any,
  ctx: ReverseCtx,
  fallbackRoleRef?: ElementRefJson,
): ElementRefJson | undefined {
  if (!payload || typeof payload !== 'object' || !payload.functionDef?.id) return undefined;
  const parameters = (payload.parameters ?? [])
    .map((paramPayload: any) => rehydrateParamPayload(paramPayload, ctx))
    .filter((ref: ElementRefJson | undefined): ref is ElementRefJson => ref !== undefined);
  const subFunctions = (payload.subFunctions ?? [])
    .map((fcPayload: any) => rehydrateFunctionCallPayload(fcPayload, ctx))
    .filter((ref: ElementRefJson | undefined): ref is ElementRefJson => ref !== undefined);

  const resolvedFunctionDef = (() => {
    const name = payload.functionDef?.name;
    if (!name) return undefined;
    // Try display name first (covers NativeLib and already-prefixed names).
    const byDisplay = ctx.funcNameToFuncDef.get(name);
    if (byDisplay) return byDisplay;
    // User-library functions are keyed as lib{LIB}_gf_{sanitizedName} in funcNameToFuncDef.
    const lib = payload.functionDef?.library;
    if (lib) {
      const sanitized = sanitizeFuncName(name);
      return ctx.funcNameToFuncDef.get(`${libraryPrefix(lib)}gf_${sanitized}`);
    }
    return undefined;
  })();
  const data: Partial<Omit<FunctionCallJson, 'type' | 'id' | 'library'>> = {
    functionDef: resolvedFunctionDef ? fdRef(resolvedFunctionDef) : payload.functionDef,
    parameters,
  };
  if (payload.subFunctionType?.id) {
    data.subFunctionType = payload.subFunctionType;
  } else if (fallbackRoleRef?.id && fallbackRoleRef.library) {
    data.subFunctionType = { id: fallbackRoleRef.id, library: fallbackRoleRef.library };
  }
  if (subFunctions.length > 0) data.subFunctions = subFunctions;
  return mkFCRef(data, ctx);
}

export function decodeUnknownSubFunctionTail(
  callExpr: any,
  ctx: ReverseCtx,
  callFn: (expr: any, role: { library: string; id: string } | undefined, ctx: ReverseCtx) => ElementRefJson | undefined,
  condFn: (expr: any, role: { library: string; id: string } | undefined, ctx: ReverseCtx) => ElementRefJson | undefined,
): { paramArgs: any[]; subFunctions: ElementRefJson[] } | undefined {
  const allArgs: any[] = Array.from(callExpr.arguments ?? []);
  const markerIndex = allArgs.findIndex(a => readStringLiteral(a) === UNKNOWN_SUBFUNC_SENTINEL);
  if (markerIndex < 0) return undefined;
  if (markerIndex + 1 >= allArgs.length) return undefined;
  const subCount = readIntLiteral(allArgs[markerIndex + 1]);
  if (subCount === undefined || subCount < 0) return undefined;
  const expectedTailLen = 2 + subCount * 2;
  if (markerIndex + expectedTailLen > allArgs.length) return undefined;

  const subFunctions: ElementRefJson[] = [];
  let p = markerIndex + 2;
  for (let i = 0; i < subCount; i++) {
    const roleToken = readStringLiteral(allArgs[p++]);
    const sfExpr = allArgs[p++];
    const sfRoleRef = decodeRoleToken(roleToken, ctx);
    const sfPayload = decodeUnknownSubFunctionPayload(readStringLiteral(sfExpr));
    const sfRef = sfPayload
      ? rehydrateFunctionCallPayload(sfPayload, ctx, sfRoleRef)
      : (!sfExpr
        ? undefined
        : (sfExpr.kind === SyntaxKind.CallExpression
          ? callFn(sfExpr, sfRoleRef, ctx)
          : condFn(sfExpr, sfRoleRef, ctx)));
    if (sfRef) subFunctions.push(sfRef);
  }
  return { paramArgs: allArgs.slice(0, markerIndex), subFunctions };
}
