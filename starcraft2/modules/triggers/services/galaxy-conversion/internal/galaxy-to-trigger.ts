import { GalaxyConstantIndex } from './galaxy-constants.js';
import { structuredNode, structuredParam } from './g2t-structured.js';
import { conversionError, globalVariables, globalVariableNames, globalVariableSpellings, libraryPrefix, withImplicitLibrary } from './conversion-model.js';
import { placeAdditionalScriptFolders, restoreEditorLayout } from './editor-layout.js';
import { recognizeGeneratedInitialization } from './g2t-initialization.js';
import { contextualAutoAncestor, printNode } from './script-template.js';
/**
 * galaxy-to-trigger — public API for the Galaxy→trigger reverse conversion.
 *
 * Entry point that converts a pair of Galaxy source files (script + header)
 * back into a TriggerLibraryJson suitable for writing as SC2 Triggers XML.
 *
 *   parseGalaxySource — thin wrapper around the sc2-galaxy-lang Parser
 *
 *   convertGalaxyToTriggerLibrary — main converter.  Two-pass over the Galaxy AST:
 *     Pass 1 (header) — reads struct declarations, global variable declarations,
 *       and user-function forward declarations to seed the lookup maps.
 *     Pass 2 (script, body pass) — converts InitVariables, trigger body functions
 *       (lib*_gt_*_Func), and user-function bodies (lib*_gf_*).
 *     Pass 3 (script, init pass) — reads trigger init functions (lib*_gt_*_Init)
 *       to recover event registrations.
 *
 * All heavy lifting is delegated to the g2t-* sub-modules.
 *
 * Depends on: g2t-core, g2t-params, g2t-payload, g2t-call, g2t-actions, g2t-trigger-body.
 */
import { Parser, SyntaxKind, forEachChild } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import type {
  SourceFile,
  FunctionDeclaration,
  VariableDeclaration,
  Identifier,
} from '@modkit/blizzard-starcraft2/galaxy/language-core';
import type {
  TriggerLibraryJson,
  TriggerJson,
  VariableJson,
  FunctionCallJson,
  FunctionDefJson,
  ParamDefJson,
  ParamJson,
  PresetJson,
  PresetValueJson,
  ParameterTypeJson,
  StructureJson,
  ElementJson,
  ElementRefJson,
  ElementType,
  CustomScriptJson,
} from '../../../shared/trigger-document/index.js';

import { resolveGalaxyTypeAliases } from './galaxy-type-resolution.js';
import {
  generateId,
  idFromKey,
  resetGalaxyToTriggerIdCounter,
  withIsolatedGalaxyToTriggerIds,
  extractGlobalVarName,
  extractLocalVarName,
  extractAutoVarName,
  extractUserFunctionName,
  extractTriggerName,
  isLibraryBoilerplate,
  isTriggerInitFunction,
  isTriggerBodyFunction,
  structureMemberKey,
  triggerParamTypeFromGalaxyTypeName,
  fdRef,
  buildFuncNameToFuncDefMap,
  buildGalaxyConstToPresetMap,
  buildRoleToSubFuncTypeMap,
  unwrapArrayType,
  parseArraySizeExpr,
  getTypeName,
  getIdentifierName,
  unwrapParens,
} from './g2t-core.js';

import type { ReverseCtx } from './g2t-core.js';
import { pruneUnreachableElements } from './g2t-prune.js';
import { syntaxShape } from './script-template.js';
import { matchDependencyFunctionDeclarations } from './dependency-functions.js';
import { resolveParamDefByRef } from './g2t-params.js';
import { indexDeclaredGalaxySymbols, namingIndexes, withNamingIndexes } from './ttg-core.js';

import {
  convertTriggerBody,
  convertUserFunctionBody,
  analyzeTriggerPrefix,
  triggerConditionGuards,
} from './g2t-trigger-body.js';

function resolveParamDefType(
  ref: ElementRefJson | undefined,
  elements: Record<string, ElementJson>,
  nativeLibrary: TriggerLibraryJson | undefined,
  libId: string,
): string | undefined {
  if (!ref?.id) return undefined;
  const local = elements[ref.id] as ParamDefJson | undefined;
  if (local?.type === 'ParamDef') return local.paramType?.type;
  if ((ref.library ?? libId) === (nativeLibrary?.id ?? 'Ntve')) {
    const nativeParamDef = nativeLibrary?.elementsByType?.ParamDef?.[ref.id] as ParamDefJson | undefined;
    return nativeParamDef?.paramType?.type;
  }
  return undefined;
}

function calledFunctionNames(statements: readonly any[]): Set<string> {
  const names = new Set<string>();
  const visit = (node: any): void => {
    if (node?.kind === SyntaxKind.CallExpression && node.expression?.kind === SyntaxKind.Identifier) {
      names.add(node.expression.name);
    }
    forEachChild(node, visit);
  };
  for (const statement of statements) visit(statement);
  return names;
}

function nativeDependencyDeclarations(sources: readonly SourceFile[], calledNames: ReadonlySet<string>): Map<string, FunctionDeclaration> {
  const declarations = new Map<string, FunctionDeclaration>();
  for (const source of sources) for (const statement of Array.from(source.statements) as any[]) {
    if (statement.kind !== SyntaxKind.FunctionDeclaration || statement.body ||
      !statement.modifiers?.some((modifier: any) => modifier.kind === SyntaxKind.NativeKeyword)) continue;
    const name = statement.name?.name as string | undefined;
    if (!name || !calledNames.has(name)) continue;
    const existing = declarations.get(name) as any;
    if (existing) {
      const signature = (declaration: any): string => JSON.stringify({
        returnType: getTypeName(declaration.type) || 'void',
        parameters: Array.from(declaration.parameters ?? []).map((parameter: any) => getTypeName(parameter.type)),
      });
      if (signature(existing) !== signature(statement)) {
        conversionError('NATIVE_DECLARATION_CONFLICT', 'Loaded Galaxy declarations disagree about a called native function', { function: name });
      }
      continue;
    }
    declarations.set(name, statement as FunctionDeclaration);
  }
  return declarations;
}

function normalizeTriggerValueParams(
  elements: Record<string, ElementJson>,
  libId: string,
  nativeLibrary: TriggerLibraryJson | undefined,
  triggerByGalaxyName: Map<string, ElementRefJson>,
): void {
  for (const el of Object.values(elements)) {
    if (el.type !== 'Param') continue;
    const param = el as ParamJson;
    if (typeof param.value !== 'string') continue;
    const triggerRef = triggerByGalaxyName.get(param.value);
    if (!triggerRef) continue;
    const paramType = resolveParamDefType(param.parameterDef, elements, nativeLibrary, libId)?.toLowerCase();
    if (paramType !== 'trigger') continue;
    delete (param as any).value;
    param.valueType = { type: 'trigger' };
    (param as any).valueElement = {
      type: 'Trigger',
      library: triggerRef.library ?? libId,
      id: triggerRef.id,
    };
  }
}

function readBoolLiteral(expr: any): boolean | undefined {
  const unwrapped = expr?.kind === SyntaxKind.ParenthesizedExpression ? expr.expression : expr;
  if (unwrapped?.kind === SyntaxKind.TrueKeyword) return true;
  if (unwrapped?.kind === SyntaxKind.FalseKeyword) return false;
  if (unwrapped?.kind === SyntaxKind.Identifier) {
    if (unwrapped.name === 'true') return true;
    if (unwrapped.name === 'false') return false;
  }
  return undefined;
}

function getTopLevelStatements(...sources: SourceFile[]): any[] {
  return sources.flatMap(source => Array.from((source as any).statements ?? []));
}

interface ThreadedFunctionPattern {
  wrapperName: string;
  callbackName: string;
  machineryGlobals: Set<string>;
  authoredFunction: FunctionDeclaration;
}

function assignmentExpression(statement: any): any | undefined {
  const expression = statement?.kind === SyntaxKind.ExpressionStatement ? unwrapParens(statement.expression) : undefined;
  return expression?.kind === SyntaxKind.BinaryExpression && expression.operatorToken?.kind === SyntaxKind.EqualsToken
    ? expression : undefined;
}

function exactIdentifier(node: any, name: string): boolean {
  return getIdentifierName(unwrapParens(node)) === name;
}

function sameGalaxyType(left: any, right: any): boolean {
  return getTypeName(left) === getTypeName(right);
}

/** Reverse the exact four-part compiler expansion emitted for
 * FlagCreateThread functions.  Names only select a candidate; all signatures,
 * assignments, globals, TriggerCreate and TriggerExecute operands are checked
 * before any machinery is hidden. */
function recognizeThreadedFunctions(statements: any[], libId: string): Map<string, ThreadedFunctionPattern> {
  const functions = new Map<string, any>();
  const globals = new Map<string, any>();
  for (const statement of statements) {
    if (statement?.kind === SyntaxKind.FunctionDeclaration && statement.body) functions.set(statement.name?.name, statement);
    if (statement?.kind === SyntaxKind.VariableDeclaration) globals.set(statement.name?.name, statement);
  }
  const result = new Map<string, ThreadedFunctionPattern>();
  for (const wrapper of functions.values()) {
    const wrapperName = wrapper.name?.name as string | undefined;
    if (!wrapperName || !extractUserFunctionName(wrapperName, libId) || getTypeName(wrapper.type) !== 'void') continue;
    const callbackName = `auto_${wrapperName}_TriggerFunc`;
    const handleName = `auto_${wrapperName}_Trigger`;
    const callback = functions.get(callbackName);
    const handle = globals.get(handleName);
    const parameters = Array.from(wrapper.parameters ?? []) as any[];
    const parameterGlobals = parameters.map(parameter => `auto_${wrapperName}_${parameter.name?.name ?? ''}`);
    if (!callback || !handle || getTypeName(handle.type) !== 'trigger' || unwrapParens(handle.initializer)?.kind !== SyntaxKind.NullKeyword) continue;
    if (getTypeName(callback.type) !== 'bool' || callback.parameters?.length !== 2 ||
      !callback.parameters.every((parameter: any) => getTypeName(parameter.type) === 'bool') ||
      callback.parameters[0]?.name?.name !== 'testConds' || callback.parameters[1]?.name?.name !== 'runActions') continue;
    if (parameterGlobals.some((name, index) => {
      const declaration = globals.get(name);
      return !declaration || declaration.initializer || !sameGalaxyType(declaration.type, parameters[index]?.type);
    })) continue;

    const wrapperBody = Array.from(wrapper.body?.statements ?? []) as any[];
    if (wrapperBody.length !== parameters.length + 2) continue;
    const parameterCopiesValid = parameters.every((parameter, index) => {
      const assignment = assignmentExpression(wrapperBody[index]);
      return assignment && exactIdentifier(assignment.left, parameterGlobals[index]) && exactIdentifier(assignment.right, parameter.name?.name);
    });
    if (!parameterCopiesValid) continue;

    const createIf = wrapperBody[parameters.length];
    const condition = unwrapParens(createIf?.expression);
    const createBody = createIf?.thenStatement?.kind === SyntaxKind.Block
      ? Array.from(createIf.thenStatement.statements ?? []) as any[] : [createIf?.thenStatement];
    const createAssignment = createBody.length === 1 ? assignmentExpression(createBody[0]) : undefined;
    const createCall = unwrapParens(createAssignment?.right);
    const conditionValid = createIf?.kind === SyntaxKind.IfStatement && !createIf.elseStatement &&
      condition?.kind === SyntaxKind.BinaryExpression && condition.operatorToken?.kind === SyntaxKind.EqualsEqualsToken &&
      ((exactIdentifier(condition.left, handleName) && unwrapParens(condition.right)?.kind === SyntaxKind.NullKeyword) ||
       (exactIdentifier(condition.right, handleName) && unwrapParens(condition.left)?.kind === SyntaxKind.NullKeyword));
    const createValid = createAssignment && exactIdentifier(createAssignment.left, handleName) &&
      createCall?.kind === SyntaxKind.CallExpression && exactIdentifier(createCall.expression, 'TriggerCreate') &&
      createCall.arguments?.length === 1 && unwrapParens(createCall.arguments[0])?.kind === SyntaxKind.StringLiteral &&
      String(unwrapParens(createCall.arguments[0]).value ?? '') === callbackName;
    if (!conditionValid || !createValid) continue;

    const execute = unwrapParens(wrapperBody[parameters.length + 1]?.expression);
    if (wrapperBody[parameters.length + 1]?.kind !== SyntaxKind.ExpressionStatement || execute?.kind !== SyntaxKind.CallExpression ||
      !exactIdentifier(execute.expression, 'TriggerExecute') || execute.arguments?.length !== 3 ||
      !exactIdentifier(execute.arguments[0], handleName) || readBoolLiteral(execute.arguments[1]) !== false ||
      readBoolLiteral(execute.arguments[2]) !== false) continue;

    const callbackBody = Array.from(callback.body?.statements ?? []) as any[];
    if (callbackBody.length < parameters.length + 1) continue;
    const localCopiesValid = parameters.every((parameter, index) => {
      const declaration = callbackBody[index];
      return declaration?.kind === SyntaxKind.VariableDeclaration && declaration.name?.name === parameter.name?.name &&
        sameGalaxyType(declaration.type, parameter.type) && exactIdentifier(declaration.initializer, parameterGlobals[index]);
    });
    const finalReturn = callbackBody[callbackBody.length - 1];
    if (!localCopiesValid || finalReturn?.kind !== SyntaxKind.ReturnStatement || unwrapParens(finalReturn.expression)?.kind !== SyntaxKind.TrueKeyword) continue;

    const restoreVoidReturns = (node: any): any => {
      if (!node || typeof node !== 'object') return node;
      if (node.kind === SyntaxKind.ReturnStatement && unwrapParens(node.expression)?.kind === SyntaxKind.TrueKeyword) {
        return { ...node, expression: undefined };
      }
      if (node.kind === SyntaxKind.Block) return { ...node, statements: [...(node.statements ?? [])].map(restoreVoidReturns) };
      if (node.kind === SyntaxKind.IfStatement) return { ...node,
        thenStatement: restoreVoidReturns(node.thenStatement),
        elseStatement: node.elseStatement ? restoreVoidReturns(node.elseStatement) : undefined };
      if ([SyntaxKind.WhileStatement, SyntaxKind.DoStatement, SyntaxKind.ForStatement].includes(node.kind)) {
        return { ...node, statement: restoreVoidReturns(node.statement) };
      }
      return node;
    };
    const authoredStatements = callbackBody.slice(parameters.length, -1).map(restoreVoidReturns);
    result.set(wrapperName, {
      wrapperName,
      callbackName,
      machineryGlobals: new Set([handleName, ...parameterGlobals]),
      authoredFunction: { ...wrapper, body: { ...callback.body, statements: authoredStatements } } as FunctionDeclaration,
    });
  }
  return result;
}

/** The preset and value a generated constant `ge_<Preset>_<Value>` names, split where the
 *  forward direction writes the name back exactly. Both parts are sanitized identifiers,
 *  and a value that begins with a digit gains a leading `_` (`1 Smallest` is
 *  `ge_CoopAIAttackWaveBuckets__1Smallest`), so a digit never directly follows the `_`
 *  that ends the preset: `ge_PersistentAttackLevel_Level_00` is the value `Level_00`. */
function splitLocalPresetConstName(name: string, libId: string): { presetName: string; valueName: string } | undefined {
  const prefix = `${libraryPrefix(libId)}ge_`;
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  for (let idx = rest.lastIndexOf('_'); idx > 0; idx = rest.lastIndexOf('_', idx - 1)) {
    const valueName = rest.slice(idx + 1);
    if (valueName === '' || /^\d/u.test(valueName)) continue;
    return { presetName: rest.slice(0, idx), valueName: /^_\d/u.test(valueName) ? valueName.slice(1) : valueName };
  }
  return undefined;
}

function collectLocalPresetDeclarations(
  statements: any[],
  libId: string,
  elements: Record<string, ElementJson>,
): Map<string, ElementRefJson> {
  const presetValuesByPreset = new Map<string, ElementRefJson[]>();
  const constToPresetValue = new Map<string, ElementRefJson>();
  const presetIdByName = new Map<string, string>();
  const valueIdByKey = new Map<string, string>();

  for (const stmt of statements) {
    if (stmt?.kind !== SyntaxKind.VariableDeclaration) continue;
    if (!stmt.modifiers?.some((modifier: any) => modifier.kind === SyntaxKind.ConstKeyword) || !stmt.initializer) continue;
    let scalar = unwrapParens(stmt.initializer);
    if (scalar.kind === SyntaxKind.PrefixUnaryExpression) scalar = unwrapParens(scalar.operand);
    if (![SyntaxKind.NumericLiteral, SyntaxKind.StringLiteral, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword].includes(scalar.kind)) continue;
    const name: string | undefined = (stmt.name as Identifier | undefined)?.name;
    if (!name) continue;
    const parsed = splitLocalPresetConstName(name, libId);
    if (!parsed) continue;

    const presetKey = `${libId}|preset|${parsed.presetName}`;
    const presetId = presetIdByName.get(presetKey) ?? idFromKey(presetKey);
    presetIdByName.set(presetKey, presetId);
    if (!elements[presetId]) {
      elements[presetId] = {
        type: 'Preset',
        id: presetId,
        library: libId,
        name: parsed.presetName,
        baseType: getTypeName(stmt.type) || 'int',
        generateConstants: true,
        values: [],
      } as PresetJson;
    }

    const valueKey = `${libId}|preset-value|${parsed.presetName}|${parsed.valueName}`;
    const valueId = valueIdByKey.get(valueKey) ?? idFromKey(valueKey);
    valueIdByKey.set(valueKey, valueId);
    const valueRef: ElementRefJson = { type: 'PresetValue', library: libId, id: valueId };
    if (!elements[valueId]) {
      elements[valueId] = {
        type: 'PresetValue',
        id: valueId,
        library: libId,
        name: parsed.valueName,
        value: printNode(stmt.initializer),
      } as PresetValueJson;
    }
    const values = presetValuesByPreset.get(presetId) ?? [];
    if (!values.some(v => v.id === valueId)) values.push(valueRef);
    presetValuesByPreset.set(presetId, values);
    constToPresetValue.set(name, valueRef);
  }

  for (const [presetId, values] of presetValuesByPreset) {
    const preset = elements[presetId] as PresetJson | undefined;
    if (preset?.type === 'Preset') preset.values = values;
  }

  return constToPresetValue;
}

function makePresetTypeFromValueRef(valueRef: ElementRefJson, elements: Record<string, ElementJson>): ParameterTypeJson | undefined {
  for (const el of Object.values(elements)) {
    if (el.type !== 'Preset') continue;
    const preset = el as PresetJson;
    if ((preset.values ?? []).some(v => (v.library ?? valueRef.library) === (valueRef.library ?? '') && v.id === valueRef.id)) {
      return { type: 'preset', typeElement: { type: 'Preset', library: preset.library, id: preset.id } };
    }
  }
  return undefined;
}

function walkAst(node: any, visit: (node: any) => void, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 128) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'pos' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visit, depth + 1);
    } else if (value && typeof value === 'object') {
      walkAst(value, visit, depth + 1);
    }
  }
}

/** Recover editor-only variable domains (control, dialog, ping, ...) from the
 * loaded trigger contract. Galaxy flattens several such domains to one ABI
 * type, commonly int. A vote is accepted only when the parsed Galaxy function
 * declaration proves that the formal has exactly the variable's declared ABI
 * type and every use agrees on one TriggerData type. */
function applyGlobalVariableDomainInference(
  statements: any[],
  declarationSources: SourceFile[],
  ctx: ReverseCtx,
): void {
  type Signature = { result: string; parameters: string[] };
  const signatures = new Map<string, Signature | null>();
  for (const source of declarationSources) for (const statement of source.statements as any) {
    if (statement.kind !== SyntaxKind.FunctionDeclaration) continue;
    const name = getIdentifierName(statement.name);
    if (!name) continue;
    const signature: Signature = {
      result: getTypeName(statement.type),
      parameters: Array.from(statement.parameters ?? []).map((parameter: any) => getTypeName(parameter.type)),
    };
    const prior = signatures.get(name);
    if (prior === undefined) signatures.set(name, signature);
    else if (prior === null || prior.result !== signature.result || prior.parameters.length !== signature.parameters.length ||
      prior.parameters.some((type, index) => type !== signature.parameters[index])) signatures.set(name, null);
  }

  const declaredGalaxyTypes = new Map<string, string>();
  const symbolGalaxyTypes = new Map<string, string>();
  for (const source of declarationSources) for (const statement of source.statements as any) if (statement.kind === SyntaxKind.VariableDeclaration) {
    const name = getIdentifierName(statement.name);
    if (name) symbolGalaxyTypes.set(name, getTypeName(unwrapArrayType(statement.type).baseType));
  }
  for (const statement of statements) if (statement.kind === SyntaxKind.VariableDeclaration) {
    const name = getIdentifierName(statement.name);
    if (name) {
      const type = getTypeName(unwrapArrayType(statement.type).baseType);
      declaredGalaxyTypes.set(name, type);
      symbolGalaxyTypes.set(name, type);
    }
  }
  const votes = new Map<string, Map<string, ParameterTypeJson>>();
  const primitive = new Set(['void', 'bool', 'byte', 'char', 'int', 'fixed', 'string', 'text']);
  const scalarOrArrayRootName = (node: any): string | undefined => {
    let current = unwrapParens(node);
    while (current?.kind === SyntaxKind.ElementAccessExpression) current = unwrapParens(current.expression);
    // A property access selects a structure member. Changing the root
    // structure's type would be wrong; member-domain inference is handled
    // separately. Plain arrays, including multiple dimensions, retain the
    // semantic domain of their root Variable.
    return current?.kind === SyntaxKind.Identifier ? getIdentifierName(current) : undefined;
  };
  const concrete = (candidate: ParameterTypeJson | undefined): ParameterTypeJson | undefined => {
    if (!candidate?.type) return undefined;
    const normalized = candidate.type.toLowerCase();
    if (/^(?:any|sameas)/u.test(normalized) && candidate.variableType && !/^(?:any|sameas)/u.test(candidate.variableType)) {
      return { type: candidate.variableType };
    }
    if (primitive.has(normalized) || /^(?:any|sameas|preset|struct)/u.test(normalized)) return undefined;
    return candidate;
  };
  const addVote = (name: string | undefined, candidate: ParameterTypeJson | undefined, abiType: string | undefined, shadowed: Set<string>): void => {
    const global = name && !shadowed.has(name) ? ctx.globalVarByGalaxyName.get(name) : undefined;
    if (!name || !global || global.library !== ctx.libId || !abiType || declaredGalaxyTypes.get(name) !== abiType) return;
    const variable = ctx.elements[global.id] as VariableJson | undefined;
    const domain = concrete(candidate);
    if (!variable || variable.type !== 'Variable' || !domain) return;
    const key = JSON.stringify(domain);
    const variableVotes = votes.get(global.id) ?? new Map<string, ParameterTypeJson>();
    variableVotes.set(key, domain);
    votes.set(global.id, variableVotes);
  };
  const callContract = (node: any): { type?: ParameterTypeJson; abi?: string } => {
    const call = unwrapParens(node);
    if (call?.kind !== SyntaxKind.CallExpression) return {};
    const callee = getIdentifierName(call.expression);
    const signature = callee ? signatures.get(callee) : undefined;
    const definition = callee ? ctx.funcNameToFuncDef.get(callee) : undefined;
    return signature && definition ? { type: definition.returnType, abi: signature.result } : {};
  };
  const presetContract = (node: any): { type?: ParameterTypeJson; abi?: string } => {
    const name = getIdentifierName(unwrapParens(node));
    const valueRef = name ? ctx.galaxyConstToPreset.get(name) : undefined;
    if (!name || !valueRef) return {};
    const libraries = [
      { id: ctx.libId, elements: ctx.elements },
      ...(ctx.nativeLibrary ? [ctx.nativeLibrary] : []),
      ...(ctx.dependencyLibraries?.values() ?? []),
    ];
    for (const library of libraries as any[]) for (const element of Object.values(library.elements ?? {}) as ElementJson[]) {
      if (element.type !== 'Preset') continue;
      const preset = element as PresetJson;
      if (!preset.baseType || !(preset.values ?? []).some(ref => ref.id === valueRef.id &&
          (ref.library ?? preset.library ?? library.id) === (valueRef.library ?? ctx.libId))) continue;
      return { type: { type: preset.baseType }, abi: symbolGalaxyTypes.get(name) };
    }
    return {};
  };

  for (const statement of statements) {
    const shadowed = new Set<string>();
    if (statement.kind === SyntaxKind.FunctionDeclaration) {
      for (const parameter of statement.parameters ?? []) {
        const name = getIdentifierName(parameter.name);
        if (name) shadowed.add(name);
      }
      walkAst(statement.body, node => {
        if (node.kind === SyntaxKind.VariableDeclaration) {
          const name = getIdentifierName(node.name);
          if (name) shadowed.add(name);
        }
      });
    }
    walkAst(statement, node => {
      if (node.kind !== SyntaxKind.CallExpression) return;
      const callee = getIdentifierName(node.expression);
      const signature = callee ? signatures.get(callee) : undefined;
      const definition = callee ? ctx.funcNameToFuncDef.get(callee) : undefined;
      if (!signature || !definition) return;
      // An event registration passes the trigger first; the event's own
      // parameters start at the second argument. Pairing them by position voted
      // the player of TriggerAddEventButtonPressed(t, player, button) into the
      // button's gamelink type (traynor2: const string gv_pLAYER_01_USER = 1).
      const offset = definition.flags?.includes('Event') ? 1 : 0;
      for (const [index, argument] of Array.from(node.arguments ?? []).entries()) {
        if (index < offset) continue;
        const name = scalarOrArrayRootName(argument);
        const paramRef = definition.parameters?.[index - offset];
        const formal = paramRef && resolveParamDefByRef(paramRef, ctx);
        addVote(name, formal?.paramType, signature.parameters[index], shadowed);
      }
      return;
    });
    walkAst(statement, node => {
      if (node.kind !== SyntaxKind.BinaryExpression) return;
      if (node.operatorToken?.kind === SyntaxKind.EqualsToken) {
        const contract = Object.keys(callContract(node.right)).length ? callContract(node.right) : presetContract(node.right);
        addVote(scalarOrArrayRootName(node.left), contract.type, contract.abi, shadowed);
        return;
      }
      if (node.operatorToken?.kind === SyntaxKind.EqualsEqualsToken || node.operatorToken?.kind === SyntaxKind.ExclamationEqualsToken) {
        const left = callContract(node.left);
        const right = callContract(node.right);
        addVote(scalarOrArrayRootName(node.right), left.type, left.abi, shadowed);
        addVote(scalarOrArrayRootName(node.left), right.type, right.abi, shadowed);
      }
    });
  }
  for (const [id, candidates] of votes) if (candidates.size === 1) {
    const variable = ctx.elements[id] as VariableJson;
    variable.variableType = { ...candidates.values().next().value! };
  }
}

function applyLocalPresetParamInference(
  statements: any[],
  funcNameToFuncDef: Map<string, FunctionDefJson>,
  elements: Record<string, ElementJson>,
  constToPresetValue: Map<string, ElementRefJson>,
): void {
  const apply = (funcDef: FunctionDefJson | undefined, index: number, constName: string | undefined): void => {
    if (!funcDef || index < 0 || !constName) return;
    const valueRef = constToPresetValue.get(constName);
    if (!valueRef) return;
    const presetType = makePresetTypeFromValueRef(valueRef, elements);
    const paramRef = funcDef.parameters?.[index];
    const paramDef = paramRef?.id ? elements[paramRef.id] as ParamDefJson | undefined : undefined;
    if (presetType && paramDef?.type === 'ParamDef' && paramDef.paramType?.type?.toLowerCase() === 'int') {
      paramDef.paramType = presetType;
    }
  };

  for (const stmt of statements) {
    if (stmt?.kind !== SyntaxKind.FunctionDeclaration) continue;
    const fd = stmt as FunctionDeclaration;
    const funcName = ((fd as any).name as Identifier)?.name;
    const funcDef = funcName ? funcNameToFuncDef.get(funcName) : undefined;
    const params = Array.from((fd as any).parameters ?? []) as any[];
    const paramIndexByName = new Map<string, number>();
    params.forEach((param, index) => {
      const name = (param.name as Identifier | undefined)?.name;
      if (name) paramIndexByName.set(name, index);
    });

    walkAst((fd as any).body, node => {
      if (node?.kind === SyntaxKind.BinaryExpression) {
        const leftName = getIdentifierName(node.left);
        const rightName = getIdentifierName(node.right);
        if (leftName && constToPresetValue.has(rightName ?? '')) apply(funcDef, paramIndexByName.get(leftName) ?? -1, rightName);
        if (rightName && constToPresetValue.has(leftName ?? '')) apply(funcDef, paramIndexByName.get(rightName) ?? -1, leftName);
      }
    });
  }

  for (const stmt of statements) {
    walkAst(stmt, node => {
      if (node?.kind !== SyntaxKind.CallExpression) return;
      const calleeName = getIdentifierName(node.expression);
      const funcDef = calleeName ? funcNameToFuncDef.get(calleeName) : undefined;
      if (!funcDef) return;
      const args = Array.from(node.arguments ?? []) as any[];
      args.forEach((arg, index) => apply(funcDef, index, getIdentifierName(arg)));
    });
  }
}

// GalaxyToTriggerOptions imported from g2t-core.js
export type { GalaxyToTriggerOptions } from './g2t-core.js';
// Re-export helpers for backward compatibility
export {
  resetGalaxyToTriggerIdCounter,
  extractGlobalVarName,
  extractLocalVarName,
  extractAutoVarName,
  extractTriggerName,
  isLibraryBoilerplate,
  isTriggerInitFunction,
  isTriggerBodyFunction,
};

/** Parses Galaxy code into AST */
export function parseGalaxySource(galaxyCode: string, fileName?: string): SourceFile {
  const parser = new Parser();
  const sourceFile = parser.parseFile(fileName ?? 'Lib.galaxy', galaxyCode);
  (sourceFile as any).__sourceText = galaxyCode;
  return sourceFile;
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

/** Includes a CustomScript wrote. The editor writes the includes of the libraries a
 *  script uses above its first declaration, a library's ending with its own header
 *  (`headerInclude`), and, in a library, the code of libraries of the same document
 *  below its last declaration; any other include is custom script. A library with no
 *  startup stage before its custom script has those includes right after its header
 *  (AllRaces2-AI's library of AI includes). */
function customScriptIncludes(source: SourceFile, headerInclude: string | undefined): any[] {
  const statements = Array.from(source.statements) as any[];
  const include = (statement: any): boolean => statement.kind === SyntaxKind.IncludeStatement;
  // The editor heads custom script with a `// Custom Script` banner and writes its own
  // includes above the first one: HotCargo's custom script "Triggers" includes
  // TriggerLibs/AI and TriggerLibs/Computer before any declaration of the map.
  const text: unknown = (source as any).__sourceText;
  const banner = typeof text === 'string' ? text.search(/^[ \t]*\/\/ Custom Script\b/mu) : -1;
  const aboveBanner = (statement: any): boolean => {
    if (banner < 0 || typeof text !== 'string') return true;
    const keyword = text.slice(statement.pos).search(/\binclude\s*"/u);
    return keyword < 0 || statement.pos + keyword < banner;
  };
  let first = statements.findIndex(statement => !include(statement) || !aboveBanner(statement));
  if (first < 0) first = statements.length;
  const header = headerInclude === undefined ? -1
    : statements.findIndex(statement => include(statement) && (statement.path?.value ?? statement.path?.text) === headerInclude);
  const lead = header >= 0 && header < first ? header + 1 : first;
  let last = statements.length - 1;
  while (last >= lead && include(statements[last])) last -= 1;
  return statements.slice(lead, last + 1).filter(include);
}

export function convertGalaxyToTriggerLibrary(
  galaxySource: SourceFile,
  headerSource: SourceFile,
  options: import('./g2t-core.js').GalaxyToTriggerOptions,
): TriggerLibraryJson {
  // A map's script names nothing after the document, so the whole reading of it
  // runs in that namespace -- the same one the forward direction wrote in.
  return withImplicitLibrary(options.implicitLibrary === true ? options.libraryId : undefined, () =>
    convertGalaxyToTriggerLibraryBody(galaxySource, headerSource, options));
}

function reportConversionProgress(
  options: import('./g2t-core.js').GalaxyToTriggerOptions,
  phase: import('./g2t-core.js').GalaxyToTriggerProgress['phase'],
  completed: number,
  total: number,
  elements: Record<string, ElementJson>,
): void {
  if (!options.onProgress) return;
  try {
    withIsolatedGalaxyToTriggerIds(() => options.onProgress!({ phase, completed, total, elements: Object.keys(elements).length }));
  } catch {
    // Progress is observational. AbortSignal, not a UI callback exception, is
    // the supported way to cancel a conversion.
  }
}

function convertGalaxyToTriggerLibraryBody(
  galaxySource: SourceFile,
  headerSource: SourceFile,
  options: import('./g2t-core.js').GalaxyToTriggerOptions,
): TriggerLibraryJson {
  for (const source of [galaxySource, headerSource]) if (source.parseDiagnostics?.length) {
    conversionError('GALAXY_SYNTAX', 'Galaxy input contains syntax errors', { file: source.fileName, diagnostics: source.parseDiagnostics.map(diagnostic => diagnostic.messageText) });
  }
  const dependencyDeclarationSources = (options.galaxyDeclarations ?? []).map(file => parseGalaxySource(file.text, file.fileName));
  const externalFuncParamTypes = new Map<string, string[]>(options.externalFuncParamTypes ?? []);
  const ambiguousFunctionSignatures = new Set<string>();
  for (const source of [...dependencyDeclarationSources, headerSource, galaxySource]) {
    for (const statement of source.statements as any) {
      if (statement.kind !== SyntaxKind.FunctionDeclaration) continue;
      const name = getIdentifierName(statement.name);
      if (!name || ambiguousFunctionSignatures.has(name)) continue;
      const parameterTypes = Array.from(statement.parameters ?? []).map((parameter: any) => getTypeName(parameter.type));
      const prior = externalFuncParamTypes.get(name);
      if (prior && (prior.length !== parameterTypes.length || prior.some((type, index) => type !== parameterTypes[index]))) {
        // Conflicting declarations are not sufficient evidence for ABI-guided
        // lowering. Keep the structural TriggerData contract and decline the
        // hint instead of choosing one declaration by load order.
        externalFuncParamTypes.delete(name);
        ambiguousFunctionSignatures.add(name);
      } else if (!prior) {
        externalFuncParamTypes.set(name, parameterTypes);
      }
    }
  }
  const constants = new GalaxyConstantIndex([
    ...dependencyDeclarationSources, headerSource, galaxySource,
  ], options.constantFolds);
  const elements: Record<string, ElementJson> = {};
  const libId = options.libraryId;

  // Build reverse lookup maps (requires nativeLibrary)
  const funcNameToFuncDef = buildFuncNameToFuncDefMap(options.nativeLibrary);
  const roleToSubFuncType = buildRoleToSubFuncTypeMap(options.nativeLibrary);
  const galaxyConstToPreset = buildGalaxyConstToPresetMap(options.nativeLibrary, options.dependencyLibraries);
  // A shipped library can drop every preset name (SwarmCampaignLib) while its
  // header still declares the generated constants. The forward converter aligns
  // them with the header; the reverse direction reads the same alignment, or
  // `libSwaC_ge_CampaignHeroes_None` stays an unbound name.
  // ponytail: parses the declarations a second time; share the parsed sources if it shows up in profiles.
  withNamingIndexes(() => {
    indexDeclaredGalaxySymbols(options.galaxyDeclarations,
      [options.nativeLibrary, ...(options.dependencyLibraries?.values() ?? [])].filter((library): library is TriggerLibraryJson => !!library));
    for (const [key, name] of namingIndexes().presetValueNames) {
      if (galaxyConstToPreset.has(name)) continue;
      const [library, type, id] = JSON.parse(key) as [string, string, string];
      galaxyConstToPreset.set(name, { type: type as ElementRefJson['type'], library, id });
    }
  });

  for (const library of options.dependencyLibraries?.values() ?? []) {
    for (const [name, definition] of buildFuncNameToFuncDefMap(library)) if (!funcNameToFuncDef.has(name)) funcNameToFuncDef.set(name, definition);
  }
  for (const [name, definition] of matchDependencyFunctionDeclarations(
    dependencyDeclarationSources, options.dependencyLibraries?.values() ?? [],
  )) if (!funcNameToFuncDef.has(name)) funcNameToFuncDef.set(name, definition);

  // Seed funcNameToFuncDef with cross-library function defs from already-converted libraries.
  // This allows callExprToFCRef to resolve lib{OTHER}_gf_{name} to proper element refs.
  if (options.crossLibFuncDefs) {
    for (const [galaxyName, ref] of options.crossLibFuncDefs) {
      if (funcNameToFuncDef.has(galaxyName)) continue;
      const match = /^lib([A-Za-z0-9]+)_gf_([A-Za-z0-9_]+)$/.exec(galaxyName);
      const displayName = match?.[2];
      if (!displayName) continue;
      funcNameToFuncDef.set(galaxyName, {
        type: 'FunctionDef', id: ref.id, library: ref.library,
        name: displayName, parameters: ref.parameters ?? [],
      });
    }
  }

  // Global var map: galaxy identifier → {id, library}; seeded with cross-library vars
  const globalVarByGalaxyName = new Map<string, { id: string; library: string }>(
    options.crossLibVars ?? [],
  );
  for (const library of options.dependencyLibraries?.values() ?? []) if (library.id !== libId) {
    const variables = globalVariables(library);
    const names = globalVariableNames(library.id, variables);
    for (const variable of variables) {
      const name = names.get(variable.id)!;
      // A loaded library's explicit identifier may be spelled either way (globalVariableSpellings).
      const spellings = name === globalVariableSpellings(library.id, variable)[0] ? globalVariableSpellings(library.id, variable) : [name];
      for (const spelling of spellings) if (!globalVarByGalaxyName.has(spelling)) globalVarByGalaxyName.set(spelling, { id: variable.id, library: library.id });
    }
  }
  const structureByGalaxyTypeName = new Map<string, ElementRefJson>();
  const structureMemberByKey = new Map<string, ElementRefJson>();
  const topLevelStatements = getTopLevelStatements(headerSource, galaxySource);
  const threadedPatterns = recognizeThreadedFunctions(topLevelStatements, libId);
  const threadedCallbacks = new Set([...threadedPatterns.values()].map(pattern => pattern.callbackName));
  const threadedGlobals = new Set([...threadedPatterns.values()].flatMap(pattern => [...pattern.machineryGlobals]));
  reportConversionProgress(options, 'index', 0, topLevelStatements.length, elements);
  resolveGalaxyTypeAliases(topLevelStatements);
  // Register every structure before resolving parameters or nested members.
  for (const statement of topLevelStatements as any[]) if (statement.kind === SyntaxKind.StructDeclaration) {
    structureByGalaxyTypeName.set(statement.name.name, { type: 'Structure', library: libId, id: generateId() });
  }
  // Naming conventions are evidence only when the callback signature and guards agree.
  const generatedBodies = new Set(topLevelStatements.filter((node: any) => {
    if (node.kind !== SyntaxKind.FunctionDeclaration || !isTriggerBodyFunction(node.name?.name ?? '', libId) || getTypeName(node.type) !== 'bool') return false;
    const callbackName = node.name.name as string;
    // An unqualified gt_* callback can be arbitrary hand-written Galaxy and
    // cannot be represented as a library Trigger without changing its public
    // symbol. A map's document format makes its global namespace explicit.
    const ownPrefix = libraryPrefix(libId);
    if (!(ownPrefix && callbackName.startsWith(`${ownPrefix}gt_`)) &&
      !(options.implicitLibrary && (/^lib[A-Za-z0-9_]+_gt_/u.test(callbackName) || callbackName.startsWith('gt_')))) return false;
    const parameters = node.parameters ?? [];
    const body = node.body?.statements ?? [];
    const prefix = analyzeTriggerPrefix(node);
    const emptyCallback = prefix?.length === body.length - 1 && body.length > 0;
    // A trigger with conditions and no actions: the editor writes its conditions
    // block, then `return true;` with no runActions guard (UEDFL Ouroboros, Mercs).
    const conditionsOnly = prefix?.length === body.length - 2 && triggerConditionGuards(body[body.length - 2]) !== undefined;
    return !!prefix && parameters.length === 2 && parameters.every((p: any) => getTypeName(p.type) === 'bool') &&
      parameters[0].name?.name === 'testConds' && parameters[1].name?.name === 'runActions' &&
      body[body.length - 1]?.kind === SyntaxKind.ReturnStatement && unwrapParens(body[body.length - 1]?.expression)?.kind === SyntaxKind.TrueKeyword &&
      (emptyCallback || conditionsOnly || body.some((s: any) => {
        const expression = unwrapParens(s.expression);
        const branch = s.thenStatement?.kind === SyntaxKind.Block ? s.thenStatement.statements : [s.thenStatement];
        return s.kind === SyntaxKind.IfStatement && !s.elseStatement && expression?.kind === SyntaxKind.PrefixUnaryExpression &&
          expression.operator?.kind === SyntaxKind.ExclamationToken && getIdentifierName(expression.operand) === 'runActions' &&
          branch.length === 1 && branch[0]?.kind === SyntaxKind.ReturnStatement && unwrapParens(branch[0]?.expression)?.kind === SyntaxKind.TrueKeyword;
      }));
  }).map((node: any) => node.name.name));
  const generatedInitializers = new Set<string>();
  const unrecoveredTriggerHandles = new Set<string>();
  for (const node of topLevelStatements) {
    if (node.kind !== SyntaxKind.FunctionDeclaration || !node.body || !isTriggerInitFunction(node.name.name, libId)) continue;
    const bodyName = node.name.name.slice(0, -5) + '_Func';
    if (!generatedBodies.has(bodyName)) continue;
    const handle = node.name.name.slice(0, -5);
    const [create, ...remaining] = Array.from(node.body.statements) as any[];
    const assignment = create?.kind === SyntaxKind.ExpressionStatement ? create.expression : undefined;
    const call = assignment?.right;
    // The map document kind is explicit namespace evidence.  A disabled or
    // dynamically registered trigger can legitimately have no static event in
    // its _Init body; requiring one misclassifies the handle as a Variable and
    // leaves the exact _Func/_Init pair as ordinary user functions.
    const validCreate = getTypeName(node.type) === 'void' && node.parameters.length === 0 &&
      assignment?.kind === SyntaxKind.BinaryExpression && assignment.operatorToken?.kind === SyntaxKind.EqualsToken &&
      getIdentifierName(assignment.left) === handle && call?.kind === SyntaxKind.CallExpression &&
      getIdentifierName(call.expression) === 'TriggerCreate' && call.arguments.length === 1 && call.arguments[0]?.value === bodyName;
    const valid = validCreate && remaining.every(statement => {
      const event = statement.kind === SyntaxKind.ExpressionStatement ? statement.expression : undefined;
      if (event?.kind !== SyntaxKind.CallExpression || getIdentifierName(event.arguments[0]) !== handle) return false;
      const name = getIdentifierName(event.expression);
      if (name === 'TriggerEnable') return event.arguments.length === 2 && readBoolLiteral(event.arguments[1]) !== undefined;
      const definition = name && funcNameToFuncDef.get(name);
      return definition && definition.flags?.includes('Event') && event.arguments.length === definition.parameters.length + 1;
    });
    if (valid) generatedInitializers.add(node.name.name);
    else {
      generatedBodies.delete(bodyName);
      if (validCreate) unrecoveredTriggerHandles.add(handle);
    }
  }
  const generatedInit = (name: string): boolean => generatedInitializers.has(name);
  const initialization = options.preserveInitialization ? undefined : recognizeGeneratedInitialization(topLevelStatements, libId, options.nativeLibrary?.id ?? 'Ntve',
    new Set(topLevelStatements.filter((node: any) => node.kind === SyntaxKind.FunctionDeclaration && node.body && generatedInit(node.name.name)).map((node: any) => node.name.name)),
    [...(options.dependencyLibraries?.keys() ?? [])].filter(id => id !== (options.nativeLibrary?.id ?? 'Ntve')),
    options.initializedDependencies ? new Set(options.initializedDependencies) : undefined);
  if (initialization?.droppedDependencyCalls) options.droppedStartupCalls?.push(...initialization.droppedDependencyCalls);
  const generatedBoilerplate = (name: string): boolean => initialization?.functions.has(name) ?? false;
  const completionGlobals = initialization?.completionGlobals ?? new Set<string>();
  const functionsWithBodies = new Set(topLevelStatements.filter((node: any) => node.kind === SyntaxKind.FunctionDeclaration && node.body).map((node: any) => node.name.name));
  const declarationFlags = (name: string): string[] => [
    ...(extractUserFunctionName(name, libId) ? [] : ['NoScriptPrefix']),
    ...(!functionsWithBodies.has(name) ? ['Native'] : []),
  ];
  // Bodyless declarations use Native to suppress a generated body. Native
  // names are emitted verbatim, so retain their complete source identifier.
  const declarationName = (name: string): string => functionsWithBodies.has(name)
    ? extractUserFunctionName(name, libId) ?? name : name;
  const headerCtx: ReverseCtx = {
    constants,
    libId,
    elements,
    nativeLibrary: options.nativeLibrary,
    dependencyLibraries: options.dependencyLibraries,
    funcNameToFuncDef,
    roleToSubFuncType,
    localVarByGalaxyName: new Map(),
    globalVarByGalaxyName,
    pendingAutoInits: new Map(),
    pendingAutoEnds: new Map(),
    pendingAutoIncrements: new Map(),
    galaxyConstToPreset,
    structureByGalaxyTypeName,
    structureMemberByKey,
    externalFuncParamTypes,
    crossLibFuncDefs: options.crossLibFuncDefs,
    // A global initializer can call a library function whose definition is not
    // loaded (a COOP map whose commander mod is missing). Trigger and function
    // bodies keep such a call as a synthesized template; without this the header
    // pass would instead name a FunctionDef that exists in no loaded library.
    structuredExpression: (expression, role, scope, expectedType) =>
      structuredNode(expression, true, scope, role as ElementRefJson | undefined, expectedType ? { type: expectedType } : undefined),
    sourceText: (headerSource as any).__sourceText,
  };
  reportConversionProgress(options, 'index', topLevelStatements.length, topLevelStatements.length, elements);

  const localPresetConstRefs = collectLocalPresetDeclarations(topLevelStatements, libId, elements);
  for (const [name, ref] of localPresetConstRefs) {
    if (!galaxyConstToPreset.has(name)) galaxyConstToPreset.set(name, ref);
  }

  const headerGlobalVarRefs = new Map<string, { id: string; library: string }>(globalVarByGalaxyName);
  for (const stmt of topLevelStatements) {
    if ((stmt as any).kind !== SyntaxKind.VariableDeclaration) continue;
    const vd = stmt as unknown as VariableDeclaration;
    const name = (vd.name as unknown as Identifier).name;
    if (completionGlobals.has(name)) continue;
    if (threadedGlobals.has(name)) continue;
    if (localPresetConstRefs.has(name)) continue;
    const varName = getTypeName(vd.type) === 'trigger' && generatedBodies.has(`${name}_Func`) ? undefined : extractGlobalVarName(name, libId) ?? name;
    if (!varName || headerGlobalVarRefs.has(name)) continue;
    headerGlobalVarRefs.set(name, { id: idFromKey(`${libId}|gv|${name}`), library: libId });
  }

  // Some maps keep user-function declarations in MapScript.galaxy itself rather than
  // a separate *_h.galaxy file. Seed those body-less declarations here so the body
  // pass can resolve and serialize the matching FunctionDef elements.
  for (const stmt of galaxySource.statements) {
    if ((stmt as any).kind !== SyntaxKind.FunctionDeclaration) continue;
    const fd = stmt as unknown as FunctionDeclaration;
    if ((fd as any).body) continue;
    const funcName = ((fd as any).name as Identifier).name;
    if (threadedCallbacks.has(funcName)) continue;
    const displayName = generatedBoilerplate(funcName) || generatedInit(funcName) || generatedBodies.has(funcName)
      ? undefined : declarationName(funcName);
    if (!displayName) continue;
    if (funcNameToFuncDef.has(funcName) && (!functionsWithBodies.has(funcName) || funcNameToFuncDef.get(funcName)?.library === libId)) continue;

    const returnTypeName = getTypeName((fd as any).type);
    const isVoid = !returnTypeName || returnTypeName === 'void';
    const id = idFromKey(`${libId}|gf|${funcName}`);
    // declarationName already keeps a bodyless (Native) name verbatim and strips
    // gf_ from a function with a body. The editor prefixes such a name itself, so
    // storing gf_X compiled to gf_gf_X (37 functions of a restored Star Party v).
    const storedName = displayName;
    const params: ElementRefJson[] = [];
    const galaxyParams = Array.from((fd as any).parameters ?? []) as any[];
    for (let paramIndex = 0; paramIndex < galaxyParams.length; paramIndex++) {
      const p = galaxyParams[paramIndex];
      const paramGalaxyName: string = (p.name as any)?.name ?? '';
      const localName = paramGalaxyName.startsWith('lp_')
        ? paramGalaxyName.slice(3)
        : (extractLocalVarName(paramGalaxyName) ?? paramGalaxyName);
      const paramTypeName = getTypeName(p.type);
      const paramDefId = idFromKey(`${libId}|gf-param|${funcName}|${paramIndex}|${localName}`);
      const paramDef: ParamDefJson = {
        type: 'ParamDef', id: paramDefId, library: libId,
        name: localName,
        paramType: triggerParamTypeFromGalaxyTypeName(paramTypeName, headerCtx, true),
      };
      elements[paramDefId] = paramDef;
      params.push({ type: 'ParamDef', library: libId, id: paramDefId });
    }
    const funcDef: FunctionDefJson = {
      type: 'FunctionDef', id, library: libId,
      name: storedName,
      flags: declarationFlags(funcName),
      parameters: params,
      isFuncAction: isVoid,
      isFuncCall: !isVoid,
      returnType: isVoid ? undefined : triggerParamTypeFromGalaxyTypeName(returnTypeName, headerCtx),
    };
    elements[id] = funcDef;
    funcNameToFuncDef.set(funcName, funcDef);
  }

  // ---- Header: global variables, trigger handles, and user function declarations ----
  reportConversionProgress(options, 'declarations', 0, topLevelStatements.length, elements);
  for (const stmt of topLevelStatements) {
    if ((stmt as any).kind !== SyntaxKind.StructDeclaration) continue;
    const sd = stmt as any;
    const structTypeName = (sd.name as Identifier)?.name;
    if (!structTypeName) continue;

    const structId = structureByGalaxyTypeName.get(structTypeName)!.id;
    const memberRefs: ElementRefJson[] = [];
    const structureRef: ElementRefJson = { type: 'Structure', library: libId, id: structId };
    structureByGalaxyTypeName.set(structTypeName, structureRef);

    for (const member of Array.from(sd.members ?? [])) {
      const memberName = ((member as any).name as Identifier)?.name ?? '';
      const localName = extractLocalVarName(memberName) ?? memberName;
      const { baseType, sizes } = unwrapArrayType((member as any).type);
      const galaxyTypeName = getTypeName(baseType);
      const variableId = generateId();
      const variable: VariableJson = {
        type: 'Variable',
        id: variableId,
        library: libId,
        name: localName,
        variableType: triggerParamTypeFromGalaxyTypeName(galaxyTypeName, headerCtx),
        isArray: sizes.length > 0 || undefined,
      };
      if (sizes.length > 0) {
        (variable as any).arraySizes = sizes.map((sizeExpr: any, dim: number) => {
          const parsed = parseArraySizeExpr(sizeExpr, headerGlobalVarRefs, constants);
          return { dim, ...parsed };
        });
      }
      elements[variableId] = variable;
      const variableRef: ElementRefJson = { type: 'Variable', library: libId, id: variableId };
      memberRefs.push(variableRef);
      structureMemberByKey.set(structureMemberKey(structId, memberName), variableRef);
    }

    // A map has no owning library wrapper, but authored/generated Galaxy can
    // still carry a historical `lib…_gs_` spelling.  It is linkage syntax, not
    // the editor-visible structure name.  Keep non-map library namespaces
    // intact; only the implicit-map document form establishes this rule.
    const mapStructName = options.implicitLibrary
      ? /^lib[A-Za-z0-9_]+_gs_(.+)$/u.exec(structTypeName)?.[1]
      : undefined;
    // A library names its own structures `lib<Id>_gs_<Name>`; the compiler adds that
    // prefix again, so keeping it in the name wrote `libCAI2_gs_LibCAI2_gs_AIData`.
    const ownPrefix = `lib${libId}_gs_`;
    const structureName = mapStructName ?? (structTypeName.startsWith(ownPrefix) ? structTypeName.slice(ownPrefix.length)
      : structTypeName.startsWith('gs_') ? structTypeName.slice(3) : structTypeName);
    elements[structId] = {
      type: 'Structure',
      id: structId,
      library: libId,
      name: structureName,
      variables: memberRefs,
    } as StructureJson;
  }
  reportConversionProgress(options, 'declarations', topLevelStatements.length, topLevelStatements.length, elements);

  for (const stmt of topLevelStatements) {
    if ((stmt as any).kind === SyntaxKind.VariableDeclaration) {
      const vd = stmt as unknown as VariableDeclaration;
      const name = (vd.name as unknown as Identifier).name;
      if (completionGlobals.has(name)) continue;
      if (threadedGlobals.has(name)) continue;
      if (localPresetConstRefs.has(name)) continue;

      // Global variable: lib{LIB}_gv_{NAME}
      const varName = getTypeName(vd.type) === 'trigger' && generatedBodies.has(`${name}_Func`) ? undefined : extractGlobalVarName(name, libId) ?? name;
      if (varName) {
        // Skip if already registered (e.g. duplicate declarations in header)
        if (globalVarByGalaxyName.has(name)) continue;
        const id = headerGlobalVarRefs.get(name)?.id ?? idFromKey(`${libId}|gv|${name}`);
        const { baseType, sizes } = unwrapArrayType((vd as any).type);
        const galaxyTypeName = getTypeName(baseType);
        const isArray = sizes.length > 0;
        const isConstant = !!((vd as any).modifiers ?? []).find((m: any) => m?.kind === SyntaxKind.ConstKeyword);
        const variable: VariableJson = {
          type: 'Variable', id, library: libId,
          name: varName,
          variableType: triggerParamTypeFromGalaxyTypeName(galaxyTypeName, headerCtx),
          ...((galaxyTypeName === 'trigger' && unrecoveredTriggerHandles.has(name)) || extractGlobalVarName(name, libId) === undefined
            ? { flags: ['NoScriptPrefix'] } : {}),
          isArray: isArray || undefined,
          isConstant: isConstant || undefined,
        };
        if (isArray) {
          (variable as any).arraySizes = sizes.map((sizeExpr: any, dim: number) => {
            const parsed = parseArraySizeExpr(sizeExpr, headerGlobalVarRefs, constants);
            return { dim, ...parsed };
          });
        }
        elements[id] = variable;
        globalVarByGalaxyName.set(name, { id, library: libId });
        if ((vd as any).initializer) {
          variable.initialValue = structuredParam((vd as any).initializer, headerCtx, undefined, variable.variableType?.type);
        }
        continue;
      }

      // Trigger handle (lib{LIB}_gt_{NAME}) → skip, resolved via body function
    }

    // User function forward declaration: returnType lib{LIB}_gf_{NAME}(params...) or gf_{NAME}(params...)
    if ((stmt as any).kind === SyntaxKind.FunctionDeclaration) {
      const fd = stmt as unknown as FunctionDeclaration;
      const funcName = ((fd as any).name as Identifier).name;
      if (threadedCallbacks.has(funcName)) continue;
      const displayName = generatedBoilerplate(funcName) || generatedInit(funcName) || generatedBodies.has(funcName)
      ? undefined : declarationName(funcName);
      if (!displayName) continue;
      // Skip if already registered (e.g. both header and body have this decl)
      if (funcNameToFuncDef.has(funcName) && (!functionsWithBodies.has(funcName) || funcNameToFuncDef.get(funcName)?.library === libId)) continue;
      const returnTypeName = getTypeName((fd as any).type);
      const isVoid = !returnTypeName || returnTypeName === 'void';
      const id = idFromKey(`${libId}|gf|${funcName}`);
      const storedName = displayName;
      const params: ElementRefJson[] = [];
      const galaxyParams = Array.from((fd as any).parameters ?? []) as any[];
      for (let paramIndex = 0; paramIndex < galaxyParams.length; paramIndex++) {
        const p = galaxyParams[paramIndex];
        const paramGalaxyName: string = (p.name as any)?.name ?? '';
        // ParamDef names are stored WITHOUT the lp_ prefix — T2G re-adds it.
        // Keeping the prefix here produces lp_lp_* body references (mismatch
        // with the generated signature) after roundtrip.
        const localName = paramGalaxyName.startsWith('lp_')
          ? paramGalaxyName.slice(3)
          : (extractLocalVarName(paramGalaxyName) ?? paramGalaxyName);
        const paramTypeName = getTypeName(p.type);
        const paramDefId = idFromKey(`${libId}|gf-param|${funcName}|${paramIndex}|${localName}`);
        const paramDef: ParamDefJson = {
          type: 'ParamDef', id: paramDefId, library: libId,
          name: localName,
          paramType: triggerParamTypeFromGalaxyTypeName(paramTypeName, headerCtx, true),
        };
        elements[paramDefId] = paramDef;
        params.push({ type: 'ParamDef', library: libId, id: paramDefId });
      }
      const funcDef: FunctionDefJson = {
        type: 'FunctionDef', id, library: libId,
        name: storedName,
      flags: declarationFlags(funcName),
        parameters: params,
        isFuncAction: isVoid,
        isFuncCall: !isVoid,
        returnType: isVoid ? undefined : triggerParamTypeFromGalaxyTypeName(returnTypeName, headerCtx),
      };
      elements[id] = funcDef;
      funcNameToFuncDef.set(funcName, funcDef);
    }
  }

  // Native declarations outside TriggerLib XML are still valid editor
  // contracts. The editor materializes a local FlagNative FunctionDef when a
  // library calls one of them. Reconstruct only declarations that are actually
  // called, and only when no loaded TriggerLib definition already represents
  // the function; this keeps arbitrary API declaration files from bloating the
  // trigger document.
  const calledNames = calledFunctionNames(topLevelStatements);
  const materializedNativeDefinitions = new Map<string, string[]>();
  for (const [funcName, fd] of nativeDependencyDeclarations(dependencyDeclarationSources, calledNames)) {
    const loadedDefinition = funcNameToFuncDef.get(funcName);
    // A pure #AUTOVAR accessor is only a valid representation while its named
    // GUI ancestor is active. Galaxy can also call the native bearing the same
    // spelling outside that ancestor (legacy loop-current APIs are common
    // examples). Preserve the declaration as a local FlagNative definition in
    // that case; otherwise the generic template fallback makes the editor emit
    // an undefined lf_* helper. The distinction is derived from TriggerLib and
    // Galaxy declarations, not from a list of API names.
    if (loadedDefinition && !contextualAutoAncestor(loadedDefinition)) continue;
    const parameters: ElementRefJson[] = [];
    const galaxyParams = Array.from((fd as any).parameters ?? []) as any[];
    for (let paramIndex = 0; paramIndex < galaxyParams.length; paramIndex++) {
      const parameter = galaxyParams[paramIndex];
      const parameterName = parameter.name?.name ?? `value${paramIndex + 1}`;
      const id = idFromKey(`${libId}|native-param|${funcName}|${paramIndex}|${parameterName}`);
      elements[id] = {
        type: 'ParamDef',
        id,
        library: libId,
        name: parameterName,
        paramType: triggerParamTypeFromGalaxyTypeName(getTypeName(parameter.type), headerCtx, true),
      } as ParamDefJson;
      parameters.push({ type: 'ParamDef', id, library: libId });
    }
    const returnTypeName = getTypeName((fd as any).type) || 'void';
    const isVoid = returnTypeName === 'void';
    const id = idFromKey(`${libId}|native|${funcName}`);
    const definition: FunctionDefJson = {
      type: 'FunctionDef',
      id,
      library: libId,
      name: funcName,
      flags: ['Native', 'NoScriptPrefix'],
      parameters,
      isFuncAction: isVoid,
      isFuncCall: !isVoid,
      returnType: isVoid ? undefined : triggerParamTypeFromGalaxyTypeName(returnTypeName, headerCtx),
    };
    elements[id] = definition;
    funcNameToFuncDef.set(funcName, definition);
    materializedNativeDefinitions.set(id, parameters.map(parameter => parameter.id));
  }

  // Map trigger handle galaxy name → TriggerJson for event injection in second pass
  applyLocalPresetParamInference(topLevelStatements, funcNameToFuncDef, elements, localPresetConstRefs);
  applyGlobalVariableDomainInference(
    topLevelStatements,
    [...dependencyDeclarationSources, headerSource, galaxySource],
    headerCtx,
  );

  const triggerByHandleName = new Map<string, TriggerJson>();
  const buildTriggerByGalaxyName = (): Map<string, ElementRefJson> => new Map(
    [...triggerByHandleName.entries()].map(([name, t]) => [
      name,
      { type: 'Trigger', library: libId, id: t.id },
    ]),
  );

  // The generator emits Global Functions before any trigger, and a trigger may
  // call one declared further down the file. Converting bodies in source order
  // leaves every such handle unresolved, and an unresolved handle becomes a
  // synthesized template that the editor re-emits as a call to a function it
  // never defines. Reserve each trigger's identity before any body is read.
  const triggerIdByFuncName = new Map<string, string>();
  for (const stmt of galaxySource.statements) {
    if ((stmt as any).kind !== SyntaxKind.FunctionDeclaration || !(stmt as any).body) continue;
    const funcName = ((stmt as any).name as Identifier).name;
    if (!generatedBodies.has(funcName) || generatedBoilerplate(funcName) || generatedInit(funcName)) continue;
    const triggerName = extractTriggerName(funcName, libId);
    if (!triggerName) continue;
    const id = generateId();
    triggerIdByFuncName.set(funcName, id);
    const handle = { type: 'Trigger', id, library: libId, name: triggerName } as TriggerJson;
    // Reserve the complete typed element, not only its id. Earlier trigger
    // bodies and Custom Script fallbacks may reference a trigger declared later
    // in source order; they need its name to emit the document's final Galaxy
    // namespace. The full body replaces this stub in pass 1.
    elements[id] = handle;
    triggerByHandleName.set(funcName.slice(0, -5), handle);
    triggerByHandleName.set(`${libraryPrefix(libId)}gt_${triggerName}`, handle);
    triggerByHandleName.set(`gt_${triggerName}`, handle);
  }

  // ---- Pass 1: trigger body functions ----
  const bodyDeclarations = [...galaxySource.statements].filter((stmt: any) => stmt.kind === SyntaxKind.FunctionDeclaration);
  const bodyProgressStride = Math.max(1, Math.floor(bodyDeclarations.length / 100));
  for (let bodyIndex = 0; bodyIndex < bodyDeclarations.length; bodyIndex++) {
    const stmt = bodyDeclarations[bodyIndex];
    if (bodyIndex % bodyProgressStride === 0) reportConversionProgress(options, 'bodies', bodyIndex, bodyDeclarations.length, elements);
    const fd = stmt as unknown as FunctionDeclaration;
    const funcName = ((fd as any).name as Identifier).name;

    if (threadedCallbacks.has(funcName)) continue;

    if (generatedBoilerplate(funcName)) {
      continue;
    }
    if (generatedInit(funcName)) continue;

    if (generatedBodies.has(funcName)) {
      const triggerName = extractTriggerName(funcName, libId);
      if (triggerName && (fd as any).body) {
        const trigger = convertTriggerBody(
          fd, triggerName, libId, elements,
          funcNameToFuncDef, roleToSubFuncType, globalVarByGalaxyName,
          galaxyConstToPreset, structureByGalaxyTypeName, structureMemberByKey,
          options.nativeLibrary, externalFuncParamTypes, options.crossLibFuncDefs,
          (galaxySource as any).__sourceText,
          buildTriggerByGalaxyName(),
          options.dependencyLibraries,
          constants,
          triggerIdByFuncName.get(funcName),
        );
        elements[trigger.id] = trigger;
        triggerByHandleName.set(funcName.slice(0, -5), trigger);
        triggerByHandleName.set(`${libraryPrefix(libId)}gt_${triggerName}`, trigger);
        triggerByHandleName.set(`gt_${triggerName}`, trigger);
      }
      continue;
    }

    // User function body: lib{LIB}_gf_{Name} or gf_{Name}
    const displayName = generatedBoilerplate(funcName) || generatedInit(funcName) || generatedBodies.has(funcName)
      ? undefined : extractUserFunctionName(funcName, libId) ?? funcName;
    if (displayName && (fd as any).body) {
      const funcDef = funcNameToFuncDef.get(funcName)
        ?? funcNameToFuncDef.get(`${libraryPrefix(libId)}gf_${displayName}`)
        ?? funcNameToFuncDef.get(`gf_${displayName}`);
      if (funcDef) {
        const threaded = threadedPatterns.get(funcName);
        const sourceFunction = threaded?.authoredFunction ?? fd;
        const returnTypeName = getTypeName((sourceFunction as any).type);
        const isVoid = !returnTypeName || returnTypeName === 'void';
        funcDef.returnType = triggerParamTypeFromGalaxyTypeName(returnTypeName || 'void', headerCtx);
        funcDef.isFuncAction = isVoid;
        funcDef.isFuncCall = !isVoid;
        if (threaded) funcDef.flags = [...new Set([...(funcDef.flags ?? []), 'CreateThread'])];
        const { actions, localVariables } = convertUserFunctionBody(
          sourceFunction as unknown as FunctionDeclaration,
          funcDef,
          libId, elements,
          funcNameToFuncDef, roleToSubFuncType,
          globalVarByGalaxyName, galaxyConstToPreset,
          structureByGalaxyTypeName, structureMemberByKey,
          options.nativeLibrary, externalFuncParamTypes, options.crossLibFuncDefs,
          (galaxySource as any).__sourceText,
          buildTriggerByGalaxyName(),
          options.dependencyLibraries,
          constants,
        );
        funcDef.actions = actions;
        funcDef.localVariables = localVariables;
        funcDef.scriptCode = undefined;
      }
    }
  }
  reportConversionProgress(options, 'bodies', bodyDeclarations.length, bodyDeclarations.length, elements);

  reportConversionProgress(options, 'initialization', 0, 1, elements);
  for (const [name, value] of initialization?.initialValues ?? []) {
    const ref = globalVarByGalaxyName.get(name);
    const variable = ref?.library === libId ? elements[ref.id] as VariableJson : undefined;
    if (!variable || variable.type !== 'Variable') conversionError('INITIALIZATION_REFERENCE', 'Verified initialization target is unavailable', { name });
    variable.initialValue = structuredParam(value, headerCtx, undefined, variable.variableType?.type);
  }

  // A member default belongs to the structure, so two arrays of one structure
  // cannot carry different defaults for the same member; the model has nowhere
  // to put the second. Recovering the first and dropping the rest would lose
  // initialization silently, so the disagreement is reported instead.
  const structureDefaultSource = new Map<string, string>();
  for (const entry of initialization?.structureValues ?? []) {
    const ref = globalVarByGalaxyName.get(entry.array);
    const variable = ref?.library === libId ? elements[ref.id] as VariableJson : undefined;
    if (!variable || variable.type !== 'Variable') conversionError('INITIALIZATION_REFERENCE', 'Verified initialization target is unavailable', { name: entry.array });
    // The path walks structure by structure: each member names the next one.
    let owner: VariableJson = variable!;
    let member: VariableJson | undefined;
    let memberRef: ElementRefJson | undefined;
    for (const name of entry.path) {
      const structureId = owner.variableType?.typeElement?.id;
      memberRef = structureId ? structureMemberByKey.get(structureMemberKey(structureId, `lv_${name}`))
        ?? structureMemberByKey.get(structureMemberKey(structureId, name)) : undefined;
      if (!memberRef) break;
      member = elements[memberRef.id] as VariableJson;
      owner = member;
    }
    if (!memberRef || !member) {
      conversionError('STRUCTURE_MEMBER', 'Initialized structure member cannot be resolved', { array: entry.array, path: entry.path.join('.') });
    }
    const source = JSON.stringify(syntaxShape(entry.value));
    const seen = structureDefaultSource.get(memberRef!.id);
    if (seen !== undefined && seen !== source) {
      conversionError('STRUCTURE_DEFAULT_CONFLICT', 'Arrays of one structure declare different defaults for a member', { path: entry.path.join('.') });
    }
    structureDefaultSource.set(memberRef!.id, source);
    member!.initialValue = structuredParam(entry.value, headerCtx, undefined, member!.variableType?.type);
  }
  if (initialization?.customInitializerBody) {
    const occupied = new Set(topLevelStatements.map((node: any) => node.name?.name).filter(Boolean));
    const baseName = 'modkitRecoveredInitGlobals';
    let initFunc = baseName;
    for (let suffix = 1; occupied.has(initFunc); suffix += 1) initFunc = `${baseName}${suffix}`;
    const id = idFromKey(`${libId}|custom-initializer|${initFunc}`);
    elements[id] = {
      type: 'CustomScript',
      id,
      library: libId,
      name: 'Recovered Initialization',
      scriptCode: `void ${initFunc} () ${printNode(initialization.customInitializerBody)}`,
      initFunc,
    } as CustomScriptJson;
  }
  // Custom script no other element regenerates: the includes a CustomScript wrote, and
  // the initializers the startup's InitCustomScript calls. The editor writes that stage
  // for any document with custom script, one of comments only too (Cold expedition's
  // Starcode library), so a stage that calls nothing still keeps one CustomScript.
  const customScripts: CustomScriptJson[] = [];
  const includes = customScriptIncludes(galaxySource, options.implicitLibrary === true ? undefined : `Lib${libId}_h`);
  if (includes.length) customScripts.push({
    type: 'CustomScript', id: idFromKey(`${libId}|custom-script|includes`), library: libId,
    name: 'Includes', displayName: 'Includes', scriptCode: includes.map(statement => printNode(statement).trim()).join('\n'),
  } as CustomScriptJson);
  for (const [index, initFunc] of (initialization?.customScriptInitializers ?? []).entries()) customScripts.push({
    type: 'CustomScript', id: idFromKey(`${libId}|custom-script|${index}|${initFunc}`), library: libId,
    name: initFunc, displayName: initFunc, initFunc,
  } as CustomScriptJson);
  if (initialization?.customScriptInitializers && !customScripts.length && !initialization.customInitializerBody) customScripts.push({
    type: 'CustomScript', id: idFromKey(`${libId}|custom-script|stage`), library: libId,
    name: 'Custom Script', displayName: 'Custom Script',
  } as CustomScriptJson);
  for (const custom of customScripts) elements[custom.id] = custom;
  reportConversionProgress(options, 'initialization', 1, 1, elements);

  // ---- Pass 2: trigger init functions → recover events ----
  const eventDeclarations = bodyDeclarations.filter((stmt: any) => generatedInit(stmt.name?.name ?? ''));
  const eventProgressStride = Math.max(1, Math.floor(eventDeclarations.length / 100));
  for (let eventIndex = 0; eventIndex < eventDeclarations.length; eventIndex++) {
    const stmt = eventDeclarations[eventIndex];
    if (eventIndex % eventProgressStride === 0) reportConversionProgress(options, 'events', eventIndex, eventDeclarations.length, elements);
    const fd = stmt as unknown as FunctionDeclaration;
    const funcName = ((fd as any).name as Identifier).name;

    if (!generatedInit(funcName)) continue;

    const handleName = funcName.slice(0, -5);
    const triggerName = extractTriggerName(`${handleName}_Func`, libId);
    if (!triggerName) continue;

    const trigger = triggerByHandleName.get(handleName);
    if (!trigger) continue;

    const ctx: ReverseCtx = {
      libId, elements, nativeLibrary: options.nativeLibrary,
    dependencyLibraries: options.dependencyLibraries,
      funcNameToFuncDef, roleToSubFuncType,
      localVarByGalaxyName: new Map(),
      globalVarByGalaxyName,
      pendingAutoInits: new Map(),
      pendingAutoEnds: new Map(),
      pendingAutoIncrements: new Map(),
      galaxyConstToPreset,
      structureByGalaxyTypeName,
      structureMemberByKey,
      triggerByGalaxyName: new Map(
        [...triggerByHandleName.entries()].map(([name, t]) => [
          name,
          { type: 'Trigger', library: libId, id: t.id },
        ]),
      ),
      externalFuncParamTypes,
      crossLibFuncDefs: options.crossLibFuncDefs,
      sourceText: (galaxySource as any).__sourceText,
    };

    for (const s of ((fd as any).body?.statements ?? [])) {
      if (s.kind !== SyntaxKind.ExpressionStatement) continue;
      const expr = s.expression;
      if (!expr) continue;

      // Skip: triggerHandle = TriggerCreate("...")
      if (
        expr.kind === SyntaxKind.BinaryExpression &&
        (expr.operatorToken?.kind as SyntaxKind) === SyntaxKind.EqualsToken &&
        expr.right?.kind === SyntaxKind.CallExpression &&
        expr.right?.expression?.name === 'TriggerCreate'
      ) continue;

      // Event registration: TriggerAdd*(handle, ...eventArgs) or TriggerRegister*(handle, ...eventArgs)
      if (expr.kind === SyntaxKind.CallExpression) {
        const calleeName: string = expr.expression?.name ?? '';
        const funcDef = funcNameToFuncDef.get(calleeName);

        if (calleeName === 'TriggerEnable') {
          const args = Array.from(expr.arguments ?? []) as any[];
          const targetName = getIdentifierName(args[0]);
          const enabled = readBoolLiteral(args[1]);
          if (targetName === handleName) {
            // Inside its own init function this call is the editor's "Initially
            // Off", not a disabled element: a disabled trigger has no init
            // function in editor output at all.
            if (enabled === false) trigger.initOff = true;
            if (enabled === true) trigger.initOff = undefined;
          }
          continue;
        }

        if (!funcDef?.flags?.includes('Event')) continue;

        // Drop first argument (trigger handle); remaining args are event params
        const args: any[] = Array.from(expr.arguments ?? []).slice(1);
        const parameters: ElementRefJson[] = args.map((arg: any, i: number) => {
          const paramDefRef = (funcDef?.parameters?.[i]) as ElementRefJson | undefined;
          return structuredParam(arg, ctx, paramDefRef);
        });

        const id = generateId();
        const fcElement: FunctionCallJson = {
          type: 'FunctionCall', id, library: libId,
          functionDef: funcDef
            ? fdRef(funcDef)
            : { type: 'FunctionDef', library: 'Ntve', id: calleeName },
          ...(parameters.length > 0 ? { parameters } : {}),
        };
        elements[id] = fcElement;
        trigger.events.push({ type: 'FunctionCall', library: libId, id });
      }
    }
  }
  reportConversionProgress(options, 'events', eventDeclarations.length, eventDeclarations.length, elements);

  // Declarations are indexed before body lowering so a genuinely retained raw
  // native call can be represented. Generated loop machinery and encoded
  // scalar constructors may disappear during structural lowering, however;
  // leaving their provisional FunctionDefs behind exposes phantom user
  // functions in the editor (and repeats them in every library). Keep only
  // definitions referenced by an actual reconstructed FunctionCall.
  const referencedLocalFunctionDefs = new Set(Object.values(elements)
    .filter((element): element is FunctionCallJson => element.type === 'FunctionCall')
    .map(call => call.functionDef)
    .filter(ref => (ref?.library ?? libId) === libId)
    .map(ref => ref!.id));
  for (const [definitionId, parameterIds] of materializedNativeDefinitions) {
    if (referencedLocalFunctionDefs.has(definitionId)) continue;
    delete elements[definitionId];
    for (const parameterId of parameterIds) delete elements[parameterId];
  }

  // Drop speculative Param/FunctionCall elements no parent references —
  // serializing them produces editor 'Orphaned trigger parameter/function
  // call removed' warnings and cascading data loss on first save.
  normalizeTriggerValueParams(elements, libId, options.nativeLibrary, buildTriggerByGalaxyName());
  pruneUnreachableElements(elements, libId);

  // A variable is a library root when no element owns it. Collect the owned ids
  // in one pass: rescanning every element per variable is quadratic, and a large
  // library spends nearly all of its time here.
  const ownedVariableIds = new Set<string>();
  for (const parent of Object.values(elements)) {
    for (const ref of ((parent as any).localVariables ?? (parent as any).variables ?? []) as ElementRefJson[]) ownedVariableIds.add(ref.id);
  }
  const result: TriggerLibraryJson = {
    id: libId,
    name: options.libraryName ?? libId,
    // Synthesized templates stay in the tree: SC2 Editor saves only tree elements,
    // so a hidden holder and every call to it were dropped on the first save.
    items: Object.values(elements).filter(e => ['FunctionDef', 'Trigger', 'Category', 'Structure', 'Preset', 'CustomScript'].includes(e.type) ||
      e.type === 'Variable' && !ownedVariableIds.has(e.id))
      .map(e => ({ type: e.type as ElementType, library: libId, id: e.id })) as any,
    elements,
    elementsByType: {} as any,
  };
  // Object key enumeration can sort numeric-looking IDs. Preserve declaration
  // order in the root references, which survive XML serialization unchanged.
  const rootVariableIds = new Set(result.items.filter(item => item.type === 'Variable').map(item => item.id));
  const orderedVariableRefs = [...globalVarByGalaxyName.values()].filter(ref => ref.library === libId && rootVariableIds.has(ref.id));
  let variableIndex = 0;
  result.items = result.items.map(item => item.type === 'Variable' && orderedVariableRefs[variableIndex]
    ? { ...item, ...orderedVariableRefs[variableIndex++] } : item);
  const symbols = new Map<string, ElementRefJson>();
  for (const [name, definition] of funcNameToFuncDef) if (definition.library === libId && elements[definition.id] === definition) symbols.set(name, fdRef(definition));
  for (const [name, variable] of globalVarByGalaxyName) if (variable.library === libId) symbols.set(name, { ...variable, type: 'Variable' });
  for (const [name, trigger] of triggerByHandleName) symbols.set(name + '_Func', { type: 'Trigger', library: libId, id: trigger.id });
  restoreEditorLayout(galaxySource, result, symbols);
  placeAdditionalScriptFolders(result, options.additionalScriptFolders, symbols);
  reportConversionProgress(options, 'finalize', 1, 1, elements);
  return result;
}
