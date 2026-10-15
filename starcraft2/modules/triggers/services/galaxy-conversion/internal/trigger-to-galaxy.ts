/**
 * trigger-to-galaxy — public API and library-level orchestration.
 *
 * Entry point for the trigger→Galaxy forward conversion.  This module owns
 * the high-level assembly of a complete Galaxy library from a TriggerLibraryJson:
 *   - convertTriggerLibraryToGalaxy  — builds the .galaxy SourceFile AST
 *   - convertTriggerLibraryToGalaxyFull — builds both .galaxy and _h.galaxy
 *     (GalaxyOutput) including structure declarations, variable declarations,
 *     trigger handle variables, and user-function forward declarations.
 *
 * Internal helpers in this file:
 *   - convertTrigger / convertTriggerInit — per-trigger body + event init functions
 *   - maybeCreateUserFunctionDefinition — user-defined function bodies
 *   - createLibraryInitBoilerplatePart1/2 — InitLibraries / InitVariables / InitTriggers / InitLib
 *   - buildStructureDeclaration — struct gs_Name { ... } header declarations
 *
 * Depends on: ttg-core, ttg-params, ttg-convert, ttg-actions.
 */
import { SyntaxKind, Printer,
  editorPrinterOptions, Parser } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import { isInlineTemplate } from './ttg-template.js';
import { assertConversionReferences, conversionError, firstPresetOrdinal, lookupElement, refKey, startupFunctionName, withImplicitLibrary } from './conversion-model.js';
import { editorLayoutComment } from './editor-layout.js';
import { preservedInitializationRoot } from './g2t-initialization.js';

import type {
  TriggerLibraryJson,
  ElementJson,
  TriggerJson,
  VariableJson,
  FunctionDefJson,
  FunctionCallJson,
  ParamJson,
  ParamDefJson,
  PresetValueJson,
  PresetJson,
  StructureJson,
  ElementRefJson,
  CustomScriptJson,
} from '../../../shared/trigger-document/index.js';

import type {
  SourceFile,
  Statement,
  Expression,
  FunctionDeclaration,
  ParameterDeclaration,
} from '@modkit/blizzard-starcraft2/galaxy/language-core';

import {
  createSourceFile,
  createIncludeStatement,
  createFunctionDeclaration,
  createVariableDeclaration,
  createParameter,
  createCallExpression,
  createIdentifier,
  createStringLiteral,
  createNumericLiteral,
  createBinaryExpression,
  createIfStatement,
  createCommentStatement,
  createReturnStatement,
  createExpressionStatement,
  createForStatement,
  createUnaryNot,
  createParenthesizedExpression,
  createElementAccessExpression,
  createPropertyAccessExpression,
  createStructDeclaration,
  createPropertyDeclaration,
} from './ast-factory.js';

import {
  type GalaxyOutput,
  type GalaxyGenerationOptions,
  type ConversionContext,
  type ConversionTrace,
  resolveRefFull,
  documentDependencies,
  referencedLibraries,
  sanitizeName,
  globalVarName,
  buildGlobalVarNamesMap,
  localVarName,
  structureTypeName,
  triggerFuncName,
  triggerHandleName,
  triggerInitFuncName,
  findElementsOfType,
  deriveNativeTypeMapping,
  lowerInitial,
  namingIndexes,
  withNamingIndexes,
  indexDependencyFunctionNames,
  indexDependencyVariableNames,
  indexDeclaredGalaxySymbols,
  isIdentityConversionOperator,
  mapParameterTypeToGalaxy,
  presetValueConstantName,
  presetIdentifierFunctionName,
  getVariableArrayDims,
  buildGalaxyArrayTypeSuffix,
  resolveArraySizeUpperBoundExpr,
  toGalaxyFunctionName,
  libraryInitializationNames,
  buildSubFuncTypeNamesMap,
} from './ttg-core.js';

import {
  convertParamExpr,
} from './ttg-params.js';

import {
  convertFunctionCallExpr,
} from './ttg-convert.js';

import {
  convertAction,
  RAW_SCRIPT_PLACEHOLDER,
} from './ttg-actions.js';

// Re-exports for backward compatibility
export type { GalaxyOutput };
export {
  globalVarName,
  localVarName,
  buildGlobalVarNamesMap,
  triggerFuncName,
  triggerHandleName,
  triggerInitFuncName,
} from './ttg-core.js';

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env?.[name];
}

function shouldTraceLibrary(libraryId: string): boolean {
  const filter = readEnv('MX_T2G_TRACE');
  if (!filter) return false;
  if (filter === '1' || filter.toLowerCase() === 'true') return true;
  return filter.split(',').map(s => s.trim()).includes(libraryId);
}

function heapSummary(): string {
  if (typeof process === 'undefined' || !process.memoryUsage) return 'n/a';
  const mem = process.memoryUsage();
  return [
    `heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    `rss=${Math.round(mem.rss / 1024 / 1024)}MB`,
  ].join(' ');
}

function createLibraryTrace(libraryId: string): ConversionTrace | undefined {
  if (!shouldTraceLibrary(libraryId)) return undefined;
  return (event, data = {}) => {
    const payload = Object.entries(data)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    const suffix = payload ? ` ${payload}` : '';
    console.error(`[galaxy:t2g:${libraryId}] ${event} ${heapSummary()}${suffix}`);
  };
}

function traceElementsEnabled(): boolean {
  const value = readEnv('MX_T2G_TRACE_ELEMENTS');
  return value === '1' || value?.toLowerCase() === 'true';
}

function elementLabel(el: ElementJson | undefined): Record<string, unknown> {
  return {
    type: el?.type,
    id: el?.id,
    name: (el as any)?.name,
  };
}

function buildStructureDeclaration(
  structure: StructureJson,
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
): any | undefined {
  const structName = structureTypeName(
    { type: 'Structure', library: structure.library ?? library.id, id: structure.id },
    library,
    nativeLibrary,
    allLibraries,
  );
  if (!structName) return undefined;

  const ctx: ConversionContext = {
    ...namingIndexes(),
    library,
    nativeLibrary,
    allLibraries,
    libId: library.id,
    localVarIds: new Set(),
    subFuncTypeNames: new Map(),
    autoVarDeclarations: [],
  };

  const members = (structure.variables ?? [])
    .map(ref => resolveRefFull(ref, library, nativeLibrary, allLibraries) as VariableJson | undefined)
    .filter((member): member is VariableJson => member?.type === 'Variable')
    .map(member => {
      const baseType = mapParameterTypeToGalaxy(member.variableType, library, nativeLibrary, allLibraries);
      const fieldType = isArrayVar(member as any)
        ? `${baseType}${buildGalaxyArrayTypeSuffix(member, ctx)}`
        : baseType;
      return createPropertyDeclaration(fieldType, localVarName(member));
    });

  return createStructDeclaration(structName, members);
}

/** Array-ness check tolerant to parsed XML where only <ArraySize> children exist. */
function isArrayVar(v: { isArray?: boolean; arraySizes?: unknown[] } | undefined): boolean {
  return !!v && (v.isArray === true || ((v.arraySizes?.length ?? 0) > 0));
}

const initializationNamesByContext = new WeakMap<ConversionContext, Set<string>>();
const initializationDepthByContext = new WeakMap<ConversionContext, number>();

function reserveInitializationIndices(name: string, dims: ReturnType<typeof getVariableArrayDims>, ctx: ConversionContext): string[] {
  if (ctx.sharedInitializationIndices) return dims.map((_, dim) => {
    const depth = initializationDepthByContext.get(ctx) ?? 0;
    const base = dim < 18 ? `init_${String.fromCharCode(105 + dim)}` : `init_${dim}`;
    const index = depth ? `${base}${depth}` : base;
    if (!ctx.sharedInitializationIndices!.has(index)) {
      ctx.sharedInitializationIndices!.add(index);
      (ctx.initializationIndexDeclarations ?? ctx.autoVarDeclarations).push(createVariableDeclaration('int', index));
    }
    return index;
  });
  let reserved = initializationNamesByContext.get(ctx);
  if (!reserved) {
    reserved = new Set<string>();
    for (const element of Object.values(ctx.library.elements)) {
      if (element.type === 'Variable') {
        reserved.add(localVarName(element));
        reserved.add(globalVarName(ctx.libId, element));
      }
      if (element.name) { reserved.add(element.name); reserved.add(`lp_${lowerInitial(sanitizeName(element.name))}`); }
      if ('scriptCode' in element) for (const token of element.scriptCode?.match(/[A-Za-z_]\w*/g) ?? []) reserved.add(token);
    }
    initializationNamesByContext.set(ctx, reserved);
  }
  return dims.map((_, dim) => {
    const base = `${name}_init_${dim}`;
    let index = base, suffix = 0;
    while (reserved!.has(index)) index = `${base}_${++suffix}`;
    reserved!.add(index);
    ctx.autoVarDeclarations.push(createVariableDeclaration('int', index));
    return index;
  });
}

function wrapArrayInitialization(
  variable: VariableJson,
  target: Expression,
  name: string,
  ctx: ConversionContext,
  body: (element: Expression) => Statement[],
): Statement[] {
  const dims = getVariableArrayDims(variable);
  if (!dims.length) return body(target);
  const declarationsAt = ctx.autoVarDeclarations.length;
  const indexDeclarationsAt = ctx.initializationIndexDeclarations?.length ?? 0;
  const indices = reserveInitializationIndices(name, dims, ctx);
  let element = target;
  for (const index of indices) element = createElementAccessExpression(element, createIdentifier(index));
  const depth = initializationDepthByContext.get(ctx) ?? 0;
  initializationDepthByContext.set(ctx, depth + 1);
  let statements: Statement[];
  try {
    statements = body(element);
  } finally {
    initializationDepthByContext.set(ctx, depth);
  }
  if (!statements.length) {
    const added = [...ctx.autoVarDeclarations.splice(declarationsAt), ...ctx.initializationIndexDeclarations?.splice(indexDeclarationsAt) ?? []];
    if (ctx.sharedInitializationIndices) for (const declaration of added) ctx.sharedInitializationIndices.delete((declaration as any).name.name);
    return [];
  }
  for (let dim = dims.length - 1; dim >= 0; dim--) {
    const bound = resolveArraySizeUpperBoundExpr(dims[dim], ctx);
    if (!bound) conversionError('ARRAY_BOUND', 'Array initializer bound is unresolved', { variable: refKey(variable), dimension: dim });
    const index = createIdentifier(indices[dim]);
    statements = [createForStatement(
      createBinaryExpression(index, SyntaxKind.EqualsToken, createNumericLiteral(0)),
      createBinaryExpression(createIdentifier(indices[dim]), SyntaxKind.LessThanEqualsToken, bound),
      createBinaryExpression(createIdentifier(indices[dim]), SyntaxKind.PlusEqualsToken, createNumericLiteral(1)),
      statements,
    )];
  }
  return statements;
}

/** XML array sizes are inclusive bounds. Evaluate the initializer once per element. */
function variableInitialization(variable: VariableJson, name: string, value: Expression, ctx: ConversionContext): Statement {
  const statements = wrapArrayInitialization(variable, createIdentifier(name), name, ctx, element => [
    createExpressionStatement(createBinaryExpression(element, SyntaxKind.EqualsToken, value)),
  ]);
  if (statements.length !== 1) conversionError('ARRAY_DIMENSIONS', 'Array initializer did not produce one statement', { variable: refKey(variable) });
  return statements[0];
}

/** Emit the non-default member values which the editor applies to every value
 * of a struct variable. TriggerData stores these defaults on the Structure's
 * member Variables, not on each global/local instance. */
function structureVariableInitializations(
  variable: VariableJson,
  target: Expression,
  name: string,
  ctx: ConversionContext,
  visiting = new Set<string>(),
): Statement[] {
  const typeElement = variable.variableType?.typeElement;
  const structure = typeElement && resolveRefFull(typeElement, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as StructureJson | undefined;
  if (structure?.type !== 'Structure') return [];
  const key = refKey(structure, variable.library ?? ctx.library.id);
  if (visiting.has(key)) return conversionError('TYPEDEF_CYCLE', 'Recursive structure defaults cannot be initialized by value', { structure: key });
  const nestedVisiting = new Set(visiting).add(key);
  return wrapArrayInitialization(variable, target, name, ctx, element => {
    const statements: Statement[] = [];
    for (const memberRef of structure.variables ?? []) {
      const member = resolveRefFull(memberRef, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as VariableJson | undefined;
      if (!member || member.disabled || member.isConstant) continue;
      const memberName = localVarName(member);
      const memberTarget = createPropertyAccessExpression(element, memberName);
      if (member.initialValue) {
        const initial = resolveRefFull(member.initialValue, ctx.library, ctx.nativeLibrary, ctx.allLibraries) as ParamJson | undefined;
        const value = initial && convertParamExpr(initial, ctx);
        if (value && shouldEmitInitializer(value)) {
          statements.push(...wrapArrayInitialization(member, memberTarget, `${name}_${memberName}`, ctx, item => [
            createExpressionStatement(createBinaryExpression(item, SyntaxKind.EqualsToken, value)),
          ]));
        }
      }
      statements.push(...structureVariableInitializations(member, memberTarget, `${name}_${memberName}`, ctx, nestedVisiting));
    }
    return statements;
  });
}

function collectLocalVarIds(library: TriggerLibraryJson): Set<string> {
  const ids = new Set<string>();
  for (const el of Object.values(library.elements)) {
    const anyEl = el as any;
    if ((el.type === 'Trigger' || el.type === 'FunctionDef') && anyEl.localVariables) {
      for (const ref of anyEl.localVariables) ids.add(ref.id);
    }
  }
  return ids;
}

function collectStructureMemberVarIds(library: TriggerLibraryJson): Set<string> {
  const ids = new Set<string>();
  for (const structure of findElementsOfType<StructureJson>(library, 'Structure')) {
    for (const ref of structure.variables ?? []) ids.add(ref.id);
  }
  return ids;
}

function collectScriptTriggerHandleNames(
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
): Set<string> {
  const names = new Set<string>();
  const isIdentifier = (value: string | undefined): value is string => !!value && /^[A-Za-z_]\w*$/.test(value);
  const isHandleName = (value: string | undefined): value is string =>
    isIdentifier(value) && value !== 'true' && value !== 'false' && value !== 'null';

  for (const param of findElementsOfType<ParamJson>(library, 'Param')) {
    if (!isHandleName(param.value)) continue;
    const paramDef = resolveRefFull(param.parameterDef, library, nativeLibrary, allLibraries) as ParamDefJson | undefined;
    if (mapParameterTypeToGalaxy(paramDef?.paramType, library, nativeLibrary, allLibraries) === 'trigger') {
      names.add(param.value);
    }
  }

  for (const call of findElementsOfType<FunctionCallJson>(library, 'FunctionCall')) {
    const scriptCode = call.scriptCode ?? '';
    const createMatch = /\b([A-Za-z_]\w*)\s*=\s*TriggerCreate\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = createMatch.exec(scriptCode)) !== null) names.add(match[1]);
  }

  return names;
}

function convertTrigger(
  trigger: TriggerJson,
  library: TriggerLibraryJson,
  nativeLibrary: TriggerLibraryJson | undefined,
  subFuncTypeNames: Map<string, string>,
  allLibraries?: Map<string, TriggerLibraryJson>,
  globalVarNames?: Map<string, string>,
  rawScriptReplacements?: Map<string, string>,
  trace?: ConversionTrace,
): FunctionDeclaration {
  trace?.('trigger:convert:start', {
    id: trigger.id,
    name: trigger.name,
    locals: trigger.localVariables?.length ?? 0,
    conditions: trigger.conditions?.length ?? 0,
    actions: trigger.actions?.length ?? 0,
    events: trigger.events?.length ?? 0,
  });
  // Collect local variable IDs
  const localVarIds = new Set<string>();
  for (const lvRef of trigger.localVariables ?? []) localVarIds.add(lvRef.id);

  const ctx: ConversionContext = {
    ...namingIndexes(),
    library,
    nativeLibrary,
    allLibraries,
    libId: library.id,
    localVarIds,
    subFuncTypeNames,
    autoVarDeclarations: [],
    sharedInitializationIndices: new Set(),
    initializationIndexDeclarations: [],
    globalVarNames,
    exprCache: new Map(),
    returnType: 'bool',
    rawScriptReplacements,
    trace,
  };

  // Local variable declarations
  const localVarStmts: Statement[] = [];
  const localInitialStmts: Statement[] = [];
  for (const lvRef of trigger.localVariables ?? []) {
    const lv = resolveRefFull(lvRef, library, nativeLibrary, allLibraries) as VariableJson | undefined;
    if (traceElementsEnabled()) trace?.('trigger:local', { trigger: trigger.id, ...elementLabel(lv) });
    if (lv?.type === 'Variable' && !lv.disabled) {
      const baseType = mapParameterTypeToGalaxy(lv.variableType, library, nativeLibrary, allLibraries);
      const galaxyType = isArrayVar(lv as any) ? `${baseType}${buildGalaxyArrayTypeSuffix(lv, ctx)}` : baseType;
      const initial = lv.initialValue ? resolveRefFull(lv.initialValue, library, nativeLibrary, allLibraries) as ParamJson | undefined : undefined;
      const initialExpr = initial ? convertParamExpr(initial, ctx) : undefined;
      localVarStmts.push(createVariableDeclaration(galaxyType, localVarName(lv), lv.isConstant ? initialExpr : undefined, lv.isConstant));
      if (initialExpr && !lv.isConstant && shouldEmitInitializer(initialExpr)) {
        localInitialStmts.push(variableInitialization(lv, localVarName(lv), initialExpr, ctx));
      }
      else if (!initialExpr && !lv.isConstant) {
        localInitialStmts.push(...structureVariableInitializations(lv, createIdentifier(localVarName(lv)), localVarName(lv), ctx));
      }
    }
  }

  // Process conditions — also collects autoVarDeclarations if any condition uses loops (rare)
  const conditionGuardStmts: Statement[] = [];
  const conditionPreludeStmts: Statement[] = [];
  if (trigger.conditions.length > 0) {
    const innerStmts: Statement[] = [];
    for (const condRef of trigger.conditions) {
      const cond = resolveRefFull(condRef, library, nativeLibrary, allLibraries) as FunctionCallJson | undefined;
      if (traceElementsEnabled()) trace?.('trigger:condition', { trigger: trigger.id, ...elementLabel(cond) });
      if (cond && !cond.disabled) {
        const expressionPrelude = ctx.expressionPrelude ??= [];
        const preludeStart = expressionPrelude.length;
        const expr = convertFunctionCallExpr(cond, ctx);
        conditionPreludeStmts.push(...expressionPrelude.splice(preludeStart));
        if (expr) {
          innerStmts.push(
            createIfStatement(
              createUnaryNot(createParenthesizedExpression(expr)),
              [createReturnStatement(createIdentifier('false'))],
            ),
          );
        }
      }
    }
    if (innerStmts.length > 0) {
      conditionGuardStmts.push(
        createIfStatement(createIdentifier('testConds'), innerStmts),
      );
    }
  }

  // Process actions — populates ctx.autoVarDeclarations
  const actionStmts: Statement[] = [];
  for (const actionRef of trigger.actions) {
    const action = resolveRefFull(actionRef, library, nativeLibrary, allLibraries) as FunctionCallJson | undefined;
    if (traceElementsEnabled()) trace?.('trigger:action', { trigger: trigger.id, ...elementLabel(action) });
    if (action) {
      const result = convertAction(action, ctx);
      if (result !== undefined) {
        if (Array.isArray(result)) actionStmts.push(...result);
        else actionStmts.push(result);
      }
    }
  }

  // SC2 Editor labels every section of a trigger callback, including empty ones.
  // `Variable Declarations`/`Variable Initialization` appear only when the trigger owns
  // locals; `Automatic Variable Declarations` is always written; `Conditions` only with
  // conditions. Blank lines between sections are not reproduced: the corpus shows the
  // editor writing both a spaced and a compact layout for the same structure.
  const body: Statement[] = [
    // The indices of array initial values, init_i and on, come first (2407 corpus loops).
    ...ctx.initializationIndexDeclarations!,
    ...(localVarStmts.length > 0 ? [createCommentStatement('Variable Declarations')] : []),
    ...localVarStmts,
    createCommentStatement('Automatic Variable Declarations'),
    ...ctx.autoVarDeclarations,     // hoisted for-loop auto vars
    ...(localVarStmts.length > 0 ? [createCommentStatement('Variable Initialization')] : []),
    ...localInitialStmts,
    ...conditionPreludeStmts,
    ...(conditionGuardStmts.length > 0 ? [createCommentStatement('Conditions')] : []),
    ...conditionGuardStmts,
    ...(trigger.actions.length > 0 ? [createCommentStatement('Actions')] : []),
    // SC2 Editor writes no guard for a trigger without actions: 54 action-less
    // callbacks in the restore corpus lack it (the one with a guard and no statement
    // presumably holds disabled actions, which still count here).
    ...(trigger.actions.length > 0 ? [createIfStatement(
      createUnaryNot(createIdentifier('runActions')),
      [createReturnStatement(createIdentifier('true'))],
    )] : []),
    ...actionStmts,
    ...(statementListDefinitelyReturns(actionStmts)
      ? []
      : [createReturnStatement(createIdentifier('true'))]),
  ];

  const decl = createFunctionDeclaration(
    'bool',
    triggerFuncName(library.id, trigger),
    [
      createParameter('bool', 'testConds'),
      createParameter('bool', 'runActions'),
    ],
    body,
  );
  trace?.('trigger:convert:end', { id: trigger.id, name: trigger.name, statements: body.length });
  return decl;
}

// ---------------------------------------------------------------------------
// Trigger init function
// ---------------------------------------------------------------------------

function convertTriggerInit(
  trigger: TriggerJson,
  library: TriggerLibraryJson,
  nativeLibrary: TriggerLibraryJson | undefined,
  allLibraries?: Map<string, TriggerLibraryJson>,
  trace?: ConversionTrace,
): FunctionDeclaration {
  trace?.('trigger:init:start', { id: trigger.id, name: trigger.name, events: trigger.events?.length ?? 0 });
  const body: Statement[] = [];

  // lib{ID}_gt_{NAME} = TriggerCreate("lib{ID}_gt_{NAME}_Func");
  body.push(
    createExpressionStatement(
      createBinaryExpression(
        createIdentifier(triggerHandleName(library.id, trigger)),
        SyntaxKind.EqualsToken,
        createCallExpression('TriggerCreate', [
          createStringLiteral(triggerFuncName(library.id, trigger)),
        ]),
      ),
    ),
  );

  // "Initially Off" creates the trigger and leaves it disabled. Editor output
  // pairs the flag with this call without exception across the paired corpus.
  if (trigger.initOff || trigger.disabled) {
    body.push(
      createExpressionStatement(
        createCallExpression('TriggerEnable', [
          createIdentifier(triggerHandleName(library.id, trigger)),
          createIdentifier('false'),
        ]),
      ),
    );
  }

  // Event registrations
  for (const eventRef of trigger.events ?? []) {
    const event = resolveRefFull(eventRef, library, nativeLibrary, allLibraries) as FunctionCallJson | undefined;
    if (traceElementsEnabled()) trace?.('trigger:event', { trigger: trigger.id, ...elementLabel(event) });
    if (event && !event.disabled) {
      const funcDef = resolveRefFull(event.functionDef, library, nativeLibrary, allLibraries) as FunctionDefJson | undefined;
      if (funcDef?.name) {
        const ctx: ConversionContext = {
          eventRegistrationTarget: triggerHandleName(library.id, trigger),
          ...namingIndexes(),
          library,
          nativeLibrary,
          allLibraries,
          libId: library.id,
          localVarIds: new Set(),
          subFuncTypeNames: new Map(),
          autoVarDeclarations: [],
          exprCache: new Map(),
          trace,
        };
        const expression = convertFunctionCallExpr(event, ctx);
        if (expression) body.push(createExpressionStatement(expression));
      }
    }
  }

  const decl = createFunctionDeclaration('void', triggerInitFuncName(library.id, trigger), [], body);
  trace?.('trigger:init:end', { id: trigger.id, name: trigger.name, statements: body.length });
  return decl;
}

function parseScriptCodeStatements(scriptCode: string): Statement[] | undefined {
  const trimmed = scriptCode?.trim();
  if (!trimmed) return undefined;
  try {
    const parser = new Parser();
    const wrapper = `void __rt_tmp() {\n${trimmed}\n}\n`;
    const sf = parser.parseFile('__rt_tmp.galaxy', wrapper);
    const fn = sf.statements.find((s: any) => (s as any).kind === SyntaxKind.FunctionDeclaration) as any;
    const bodyStmts = fn?.body?.statements;
    if (!bodyStmts) return undefined;
    const statements = Array.from(bodyStmts as any) as Statement[];
    for (const statement of statements) stripAstParentLinks(statement);
    return statements;
  } catch {
    return undefined;
  }
}

function stripAstParentLinks(node: unknown, seen = new WeakSet<object>()): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (seen.has(obj)) return;
  seen.add(obj);
  if ('parent' in obj) obj['parent'] = undefined;
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) stripAstParentLinks(item, seen);
    } else {
      stripAstParentLinks(value, seen);
    }
  }
}

function eventParameterName(funcDef: FunctionDefJson, library: TriggerLibraryJson, nativeLibrary?: TriggerLibraryJson, allLibraries?: Map<string, TriggerLibraryJson>): string {
  const reserved = new Set<string>();
  for (const ref of [...funcDef.parameters, ...(funcDef.localVariables ?? [])]) {
    const element = resolveRefFull(ref, library, nativeLibrary, allLibraries);
    if (element?.name) { reserved.add(element.name); reserved.add(`lp_${lowerInitial(sanitizeName(element.name))}`); }
    if (element?.type === 'Variable') reserved.add(localVarName(element));
  }
  let name = 'eventTarget', suffix = 0;
  while (reserved.has(name)) name = `eventTarget_${++suffix}`;
  return name;
}

function buildUserFunctionParameters(
  funcDef: FunctionDefJson,
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
): ParameterDeclaration[] {
  const params: ParameterDeclaration[] = [];
  if (funcDef.flags?.includes('Event')) params.push(createParameter('trigger', eventParameterName(funcDef, library, nativeLibrary, allLibraries)));
  for (let i = 0; i < (funcDef.parameters ?? []).length; i++) {
    const paramRef = funcDef.parameters[i];
    const paramDef = resolveRefFull(paramRef, library, nativeLibrary, allLibraries) as ParamDefJson | undefined;
    const valueType = mapParameterTypeToGalaxy(paramDef?.paramType, library, nativeLibrary, allLibraries);
    const pType = paramDef?.paramType.type === 'struct' ? `structref<${valueType}>` : valueType;
    // The editor lower-cases the first character of a parameter name; a
    // function keeps the authored case. Verified on paired libraries.
    const rawName = lowerInitial(sanitizeName(paramDef?.name ?? `p${i}`) || `p${i}`);
    const pName = rawName.startsWith('lp_') ? rawName : `lp_${rawName}`;
    params.push(createParameter(pType, pName));
  }
  return params;
}

/** A void `FlagCreateThread` body is transplanted into the editor's generated
 * bool trigger callback.  Native SkipRemaining templates still emit a bare
 * `return;`, which is correct in the authored void function but invalid in that
 * callback.  Rewrite only bare returns; value-returning definitions never take
 * this path. */
function normalizeThreadedBodyReturns(statement: Statement): Statement {
  const node = statement as any;
  if (node.kind === SyntaxKind.ReturnStatement) {
    return node.expression == null ? createReturnStatement(createIdentifier('true')) : statement;
  }
  if (node.kind === SyntaxKind.Block) {
    return { ...node, statements: (node.statements ?? []).map(normalizeThreadedBodyReturns) } as Statement;
  }
  if (node.kind === SyntaxKind.IfStatement) {
    return { ...node,
      thenStatement: normalizeThreadedBodyReturns(node.thenStatement),
      elseStatement: node.elseStatement ? normalizeThreadedBodyReturns(node.elseStatement) : undefined,
    } as Statement;
  }
  if (node.kind === SyntaxKind.WhileStatement || node.kind === SyntaxKind.DoStatement || node.kind === SyntaxKind.ForStatement) {
    return { ...node, statement: normalizeThreadedBodyReturns(node.statement) } as Statement;
  }
  return statement;
}

/** `FlagCreateThread` on a void definition does not compile to one Galaxy
 * function. Editor output is a per-function trigger handle, one global per
 * parameter, a wrapper that stores the arguments and starts the trigger, and the
 * body as a trigger function ending in `return true`. Reproduce that whole shape. */
function threadedFunctionDeclarations(
  name: string,
  returnType: string,
  parameters: ParameterDeclaration[],
  body: Statement[],
): Statement[] {
  // A definition that returns a value cannot run detached, and editor output for
  // such a definition is an ordinary function: the flag is ignored, not an error.
  if (returnType !== 'void') return [createFunctionDeclaration(returnType, name, parameters, body)];
  const threadedBody = body.map(normalizeThreadedBodyReturns);
  const handle = `auto_${name}_Trigger`;
  const bodyName = `auto_${name}_TriggerFunc`;
  const declared = parameters.map(parameter => {
    const parameterName = (parameter as any).name.name as string;
    const parameterType = (parameter as any).type?.name?.name ?? (parameter as any).type?.name ?? 'int';
    return { parameterName, parameterType: String(parameterType), global: `auto_${name}_${parameterName}` };
  });
  return [
    createVariableDeclaration('trigger', handle, createIdentifier('null')),
    ...declared.map(item => createVariableDeclaration(item.parameterType, item.global)),
    createFunctionDeclaration('void', name, parameters, [
      ...declared.map(item => createExpressionStatement(createBinaryExpression(createIdentifier(item.global), SyntaxKind.EqualsToken, createIdentifier(item.parameterName)))),
      createIfStatement(
        createBinaryExpression(createIdentifier(handle), SyntaxKind.EqualsEqualsToken, createIdentifier('null')),
        [createExpressionStatement(createBinaryExpression(createIdentifier(handle), SyntaxKind.EqualsToken,
          createCallExpression('TriggerCreate', [createStringLiteral(bodyName)])))],
      ),
      createExpressionStatement(createCallExpression('TriggerExecute', [createIdentifier(handle), createIdentifier('false'), createIdentifier('false')])),
    ]),
    createFunctionDeclaration('bool', bodyName, [createParameter('bool', 'testConds'), createParameter('bool', 'runActions')], [
      ...declared.map(item => createVariableDeclaration(item.parameterType, item.parameterName, createIdentifier(item.global))),
      ...threadedBody,
      ...(statementListDefinitelyReturns(threadedBody)
        ? []
        : [createReturnStatement(createIdentifier('true'))]),
    ]),
  ];
}

/** Return type implied by the TriggerData contract when ReturnType is absent.
 * FlagAction and FlagEvent definitions both emit void Galaxy functions.  Keep
 * this in one place so declarations, streamed bodies and AST bodies cannot
 * silently disagree about the same function ABI. */
function effectiveFunctionReturnType(funcDef: FunctionDefJson) {
  return funcDef.returnType ?? {
    type: funcDef.isFuncAction || funcDef.flags?.includes('Event') ? 'void' : 'int',
  };
}

/** True only when control cannot reach the statement following this node.
 * Keep the proof intentionally small and syntax based: a return always exits,
 * a block exits when one of its reachable statements exits, and an if exits
 * only when both explicit branches do. Loops are never assumed to execute. */
function statementDefinitelyReturns(statement: Statement | undefined): boolean {
  const node = statement as any;
  if (!node) return false;
  if (node.kind === SyntaxKind.ReturnStatement) return true;
  if (node.kind === SyntaxKind.Block) return statementListDefinitelyReturns(node.statements ?? []);
  if (node.kind === SyntaxKind.IfStatement) {
    return !!node.elseStatement &&
      statementDefinitelyReturns(node.thenStatement) &&
      statementDefinitelyReturns(node.elseStatement);
  }
  return false;
}

function statementListDefinitelyReturns(statements: readonly Statement[]): boolean {
  return statements.some(statement => statementDefinitelyReturns(statement));
}

/** Reserve automatic locals while walking the authored call tree, before the
 * template reorders its branches into executable Galaxy statements. */
function editorAutoDeclarations(declarations: Statement[], library: TriggerLibraryJson, actions: ElementRefJson[]): Statement[] {
  if (declarations.length < 2) return declarations;
  const order = new Map<string, number>();
  const visited = new Set<string>();
  const visit = (ref: ElementRefJson): void => {
    if (ref.library && ref.library !== library.id) return;
    const key = `${ref.type}:${ref.id}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (ref.type === 'FunctionCall') {
      const call = library.elementsByType.FunctionCall[ref.id];
      if (!call) return;
      order.set(ref.id, order.size);
      call.parameters?.forEach(visit);
      call.subFunctions?.forEach(visit);
    } else if (ref.type === 'Param') {
      const param = library.elementsByType.Param[ref.id];
      if (!param) return;
      if (param.functionCall) visit(param.functionCall);
      param.expressionParams?.forEach(visit);
      param.valueParams?.forEach(visit);
      if (param.array) (Array.isArray(param.array) ? param.array : [param.array]).forEach(visit);
    }
  };
  actions.forEach(visit);
  const rank = (statement: Statement): number => {
    const name = (statement as any).name?.name as string | undefined;
    const id = /^auto([\dA-F]{8})_/i.exec(name ?? '')?.[1];
    return id === undefined ? Number.MAX_SAFE_INTEGER : order.get(id) ?? Number.MAX_SAFE_INTEGER;
  };
  return declarations.sort((left, right) => rank(left) - rank(right));
}

function maybeCreateUserFunctionDefinition(
  funcDef: FunctionDefJson,
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
  rawScriptReplacements?: Map<string, string>,
  trace?: ConversionTrace,
): Statement[] {
  if (!funcDef.name) return [];
  if (funcDef.name === '__InitVariablesRaw') return [];
  trace?.('function:convert:start', {
    id: funcDef.id,
    name: funcDef.name,
    actions: funcDef.actions?.length ?? 0,
    locals: funcDef.localVariables?.length ?? 0,
    params: funcDef.parameters?.length ?? 0,
    hasScriptCode: !!funcDef.scriptCode,
  });
  const fdLibId = funcDef.library ?? library.id;
  const galaxyFuncName = toGalaxyFunctionName(funcDef, { libId: library.id, library, nativeLibrary, allLibraries } as ConversionContext);
  const returnType = mapParameterTypeToGalaxy(
    effectiveFunctionReturnType(funcDef),
    library,
    nativeLibrary,
    allLibraries,
  );
  const params = buildUserFunctionParameters(funcDef, library, nativeLibrary, allLibraries);

  // Prefer actions array (from original SC2 Editor XML) over scriptCode (from roundtrip)
  if (funcDef.actions !== undefined) {
    const subFuncTypeNames = buildSubFuncTypeNamesMap(nativeLibrary);
    // Build a local var name map from lp_* params
    const paramLocalVarIds = new Set<string>();
    for (const paramRef of funcDef.parameters ?? []) {
      paramLocalVarIds.add(paramRef.id);
    }
    const localVarIds = new Set<string>([
      ...paramLocalVarIds,
      ...(funcDef.localVariables ?? []).map(r => r.id),
    ]);
    const ctx: ConversionContext = {
    ...namingIndexes(),
      library, nativeLibrary, allLibraries,
      libId: fdLibId,
      localVarIds,
      subFuncTypeNames,
      autoVarDeclarations: [],
      sharedInitializationIndices: new Set(),
      initializationIndexDeclarations: [],
      exprCache: new Map(),
      returnType: funcDef.flags?.includes('CreateThread') && returnType === 'void' ? 'bool' : returnType,
      rawScriptReplacements,
      trace,
      eventRegistrationTarget: funcDef.flags?.includes('Event') ? eventParameterName(funcDef, library, nativeLibrary, allLibraries) : undefined,
    };
    // Local variable declarations (with initialization only for non-default values)
    const localVarStmts: Statement[] = [];
    const localVarInitStmts: Statement[] = [];
    for (const lvRef of funcDef.localVariables ?? []) {
      const lv = resolveRefFull(lvRef, library, nativeLibrary, allLibraries) as VariableJson | undefined;
      if (traceElementsEnabled()) trace?.('function:local', { function: funcDef.id, ...elementLabel(lv) });
      if (lv?.type === 'Variable' && !lv.disabled) {
        const baseType = mapParameterTypeToGalaxy(lv.variableType, library, nativeLibrary, allLibraries);
        const galaxyType = isArrayVar(lv as any) ? `${baseType}${buildGalaxyArrayTypeSuffix(lv, ctx)}` : baseType;
        const initialValue = lv.initialValue
          ? resolveRefFull(lv.initialValue, library, nativeLibrary, allLibraries) as ParamJson | undefined
          : undefined;
        const initialExpr = initialValue ? convertParamExpr(initialValue, ctx) : undefined;
        localVarStmts.push(createVariableDeclaration(galaxyType, localVarName(lv), lv.isConstant ? initialExpr : undefined, lv.isConstant));
        if (initialExpr && !lv.isConstant && shouldEmitInitializer(initialExpr)) {
          localVarInitStmts.push(variableInitialization(lv, localVarName(lv), initialExpr, ctx));
        }
        else if (!initialExpr && !lv.isConstant) {
          localVarInitStmts.push(...structureVariableInitializations(lv, createIdentifier(localVarName(lv)), localVarName(lv), ctx));
        }
      }
    }
    // Body action statements
    const actionStmts: Statement[] = [];
    for (const actionRef of funcDef.actions) {
      const action = resolveRefFull(actionRef, library, nativeLibrary, allLibraries) as FunctionCallJson | undefined;
      if (traceElementsEnabled()) trace?.('function:action', { function: funcDef.id, ...elementLabel(action) });
      if (action) {
        const result = convertAction(action, ctx);
        if (result !== undefined) {
          if (Array.isArray(result)) actionStmts.push(...result);
          else actionStmts.push(result);
        }
      }
    }
    // Every authored action is written, including a Return after an earlier return:
    // SC2 Editor emits and compiles such code (KeyStone gf_RetiredFeatureDeck), and
    // the only #DEFRETURN in NativeLib belongs to the authored Skip Remaining action.
    // Same section banners as a trigger callback, with `Implementation` in place of
    // `Conditions`/`Actions` (see the comment on the trigger body). The generated startup
    // functions carry none: the editor writes InitMap/InitLibs/InitGlobals/InitTriggers
    // as plain bodies.
    const labelled = !['InitLib', 'InitLibraries', 'InitVariables', 'InitTriggers']
      .some(role => galaxyFuncName === startupFunctionName(library.id, role));
    const banner = (text: string, when = true) => (labelled && when ? [createCommentStatement(text)] : []);
    const body = [
      ...ctx.initializationIndexDeclarations!,
      ...banner('Variable Declarations', localVarStmts.length > 0),
      ...localVarStmts,
      ...banner('Automatic Variable Declarations'),
      ...editorAutoDeclarations(ctx.autoVarDeclarations, library, funcDef.actions),
      ...banner('Variable Initialization', localVarStmts.length > 0),
      ...localVarInitStmts,
      ...banner('Implementation', actionStmts.length > 0),
      ...actionStmts,
    ];
    trace?.('function:convert:end', { id: funcDef.id, name: funcDef.name, statements: body.length });
    if (funcDef.flags?.includes('CreateThread')) return threadedFunctionDeclarations(galaxyFuncName, returnType, params, body);
    return [createFunctionDeclaration(returnType, galaxyFuncName, params, body)];
  }

  // Fallback: scriptCode from roundtrip
  if (!funcDef.scriptCode) return [];
  const body = parseScriptCodeStatements(funcDef.scriptCode);
  if (!body) return [];
  trace?.('function:convert:end', { id: funcDef.id, name: funcDef.name, statements: body.length, source: 'scriptCode' });
  if (funcDef.flags?.includes('CreateThread')) return threadedFunctionDeclarations(galaxyFuncName, returnType, params, body);
  return [createFunctionDeclaration(returnType, galaxyFuncName, params, body)];
}

function buildInitVariablesBodyFromFunctionDef(
  funcDef: FunctionDefJson | undefined,
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
  globalVarNames?: Map<string, string>,
  structureMemberVarIds?: Set<string>,
  rawScriptReplacements?: Map<string, string>,
  trace?: ConversionTrace,
): Statement[] | undefined {
  if (!funcDef) return undefined;
  trace?.('init-vars:raw-function:start', {
    id: funcDef.id,
    name: funcDef.name,
    actions: funcDef.actions?.length ?? 0,
    locals: funcDef.localVariables?.length ?? 0,
  });

  // Prefer structured actions/localVariables.
  if (funcDef.actions !== undefined) {
    const localVarIds = new Set<string>((funcDef.localVariables ?? []).map(r => r.id));
    const ctx: ConversionContext = {
    ...namingIndexes(),
      library,
      nativeLibrary,
      allLibraries,
      libId: library.id,
      localVarIds,
      subFuncTypeNames: buildSubFuncTypeNamesMap(nativeLibrary),
      autoVarDeclarations: [],
      globalVarNames,
      structureMemberVarIds,
      exprCache: new Map(),
      rawScriptReplacements,
      trace,
    };
    const localVarStmts: Statement[] = [];
    const localVarInitStmts: Statement[] = [];
    for (const lvRef of funcDef.localVariables ?? []) {
      const lv = resolveRefFull(lvRef, library, nativeLibrary, allLibraries) as VariableJson | undefined;
      if (traceElementsEnabled()) trace?.('init-vars:local', { function: funcDef.id, ...elementLabel(lv) });
      if (lv?.type !== 'Variable') continue;
      const galaxyType = mapParameterTypeToGalaxy(lv.variableType, library, nativeLibrary, allLibraries);
      localVarStmts.push(createVariableDeclaration(galaxyType, localVarName(lv)));
      if (!lv.initialValue) continue;
      const initParam = resolveRefFull(lv.initialValue, library, nativeLibrary, allLibraries) as ParamJson | undefined;
      if (!initParam) continue;
      const initExpr = convertParamExpr(initParam, ctx);
      if (!initExpr) continue;
      localVarInitStmts.push(createExpressionStatement(
        createBinaryExpression(createIdentifier(localVarName(lv)), SyntaxKind.EqualsToken, initExpr),
      ));
    }
    const actionStmts: Statement[] = [];
    for (const actionRef of funcDef.actions) {
      const action = resolveRefFull(actionRef, library, nativeLibrary, allLibraries) as FunctionCallJson | undefined;
      if (traceElementsEnabled()) trace?.('init-vars:action', { function: funcDef.id, ...elementLabel(action) });
      if (!action) continue;
      const result = convertAction(action, ctx);
      if (result === undefined) continue;
      if (Array.isArray(result)) actionStmts.push(...result);
      else actionStmts.push(result);
    }
    const result = [...localVarStmts, ...ctx.autoVarDeclarations, ...localVarInitStmts, ...actionStmts];
    trace?.('init-vars:raw-function:end', { id: funcDef.id, name: funcDef.name, statements: result.length });
    return result;
  }

  // Fallback only when there is no structured representation.
  if (funcDef.scriptCode) {
    const result = parseScriptCodeStatements(funcDef.scriptCode);
    trace?.('init-vars:raw-function:end', { id: funcDef.id, name: funcDef.name, statements: result?.length ?? 0, source: 'scriptCode' });
    return result;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
function isGalaxyDefaultExpr(expr: Expression): boolean {
  const k = (expr as any).kind as SyntaxKind;
  if (k === SyntaxKind.NullKeyword || k === SyntaxKind.FalseKeyword) return true;
  if (k === SyntaxKind.NumericLiteral) return (expr as any).text === '0' || (expr as any).text === '0.0';
  if (k === SyntaxKind.Identifier) return (expr as any).name === 'false' || (expr as any).name === 'null';
  if (k === SyntaxKind.StringLiteral) return (expr as any).value === '';
  return false;
}

function shouldEmitInitializer(expr: Expression): boolean {
  // An uninitialized Galaxy string is not interchangeable with the editor's
  // explicit empty string, which it writes for locals, globals and structure
  // members alike. Numeric zero, false and null are runtime defaults and the
  // editor omits their redundant assignments.
  return (expr as any).kind === SyntaxKind.StringLiteral || !isGalaxyDefaultExpr(expr);
}

function isGalaxyConstantInitializer(expr: Expression | undefined, galaxyType: string): boolean {
  // Galaxy const objects/handles cannot be initialized by runtime natives.
  // The editor keeps TriggerData's Constant marker but emits such values as a
  // normal global followed by an InitVariables assignment.
  if (!expr || !new Set(['bool', 'byte', 'int', 'fixed', 'string']).has(galaxyType)) return false;
  const node = expr as any;
  if ([SyntaxKind.NumericLiteral, SyntaxKind.StringLiteral, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword].includes(node.kind)) return true;
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node.kind === SyntaxKind.ParenthesizedExpression) return isGalaxyConstantInitializer(node.expression, galaxyType);
  if (node.kind === SyntaxKind.PrefixUnaryExpression) return isGalaxyConstantInitializer(node.operand, galaxyType);
  if (node.kind === SyntaxKind.BinaryExpression) {
    return isGalaxyConstantInitializer(node.left, galaxyType) && isGalaxyConstantInitializer(node.right, galaxyType);
  }
  return false;
}

function isTriggerConstantInitializer(param: ParamJson | undefined, expr: Expression | undefined, galaxyType: string): boolean {
  // The editor decides whether a TriggerData constant can live in the Galaxy
  // header from the stored parameter form, before expanding FunctionCall
  // templates. Even a call that later reduces to `constant - 1` is emitted as
  // a mutable global plus an InitVariables assignment.
  if (param?.functionCall) return false;
  return isGalaxyConstantInitializer(expr, galaxyType);
}

// Library boilerplate (4 init functions)
// ---------------------------------------------------------------------------

function createLibraryInitBoilerplatePart1(
  library: TriggerLibraryJson,
  depLibIds: string[] = [],
  nativeLibId: string = 'Ntve',
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
  globalVarNames?: Map<string, string>,
  structureMemberVarIds?: Set<string>,
  localVarIds?: Set<string>,
  rawScriptReplacements?: Map<string, string>,
  trace?: ConversionTrace,
  names = libraryInitializationNames(library, nativeLibrary, allLibraries),
  includeVariables = true,
  librariesStage = true,
): Statement[] {
  const libId = library.id;
  trace?.('boilerplate:init-vars:start', { deps: depLibIds.length });
  const rawInitFd = findElementsOfType<FunctionDefJson>(library, 'FunctionDef')
    .find(fd => fd.library === library.id && fd.name === '__InitVariablesRaw');
  const rawInitBodyStmts = buildInitVariablesBodyFromFunctionDef(
    rawInitFd,
    library,
    nativeLibrary,
    allLibraries,
    globalVarNames,
    structureMemberVarIds,
    rawScriptReplacements,
    trace,
  );
  const subFuncTypeNames = buildSubFuncTypeNamesMap(nativeLibrary);
  const ctx: ConversionContext = {
    ...namingIndexes(),
    library,
    nativeLibrary,
    allLibraries,
    libId,
    localVarIds: new Set(),
    subFuncTypeNames,
    autoVarDeclarations: [],
    sharedInitializationIndices: new Set(),
    globalVarNames,
    structureMemberVarIds,
    exprCache: new Map(),
    rawScriptReplacements,
    trace,
  };
  const varInitStmts: Statement[] = [];
  // The editor executes global initializers in the same authored root/category
  // order used for declarations. Object/XML insertion order can differ (for
  // example after localization or layer assembly) and must not move an array
  // initializer across calls with observable effects.
  const allGlobalVars = orderedVariables(library);
  for (const variable of allGlobalVars) {
    if (traceElementsEnabled()) trace?.('global-variable:init', elementLabel(variable));
    if (structureMemberVarIds?.has(variable.id)) continue;
    if (localVarIds?.has(variable.id)) continue;
    const varName = globalVarNames?.get(variable.id) ?? globalVarName(libId, variable);
    if (!variable.initialValue) {
      varInitStmts.push(...structureVariableInitializations(variable, createIdentifier(varName), varName, ctx));
      continue;
    }
    const paramEl = resolveRefFull(variable.initialValue, library, nativeLibrary, allLibraries) as ParamJson | undefined;
    if (!paramEl) continue;
    const initExpr = convertParamExpr(paramEl, ctx);
    if (!initExpr) continue;

    if (variable.isConstant) {
      const galaxyType = mapParameterTypeToGalaxy(variable.variableType, library, nativeLibrary, allLibraries);
      if (isTriggerConstantInitializer(paramEl, initExpr, galaxyType)) continue;
    }

    if (!shouldEmitInitializer(initExpr)) continue;

    varInitStmts.push(variableInitialization(variable, varName, initExpr, ctx));
  }
  const initLoopVarDecls = ctx.autoVarDeclarations;
  const dependencyInitializer = (id: string): string => {
    const dependency = nativeLibrary?.id === id ? nativeLibrary : allLibraries?.get(id);
    const dependencyNames = dependency && libraryInitializationNames(dependency, nativeLibrary, allLibraries);
    // Map scripts own application startup and initialize complete dependency
    // libraries.  A library's InitLibraries stage only initializes dependency
    // variables; calling InitLib here would create dependency triggers while
    // the editor is still walking the variable-initialization graph.
    if (library.implicit === true) return dependencyNames?.library ?? startupFunctionName(id, 'InitLib');
    return dependencyNames?.variables ?? startupFunctionName(id, 'InitVariables');
  };
  const initCalls: Statement[] = [
    createExpressionStatement(createCallExpression(dependencyInitializer(nativeLibId), [])),
    ...depLibIds.map(depId =>
      createExpressionStatement(createCallExpression(dependencyInitializer(depId), [])),
    ),
  ];
  const result = [
    ...(librariesStage ? [createFunctionDeclaration(
      'void', names.libraries, [],
      initCalls,
    )] : []),
    ...(library.implicit === true || !includeVariables ? [] : [createVariableDeclaration('bool', names.variablesCompleted, createIdentifier('false'))]),
    // Galaxy requires ALL local declarations before the first statement —
    // hoist declaration statements from the raw init body above the guard.
    ...(includeVariables ? (() => {
      const rawDecls = (rawInitBodyStmts ?? []).filter(st => (st as any).kind === SyntaxKind.VariableDeclaration);
      const rawRest = (rawInitBodyStmts ?? []).filter(st => (st as any).kind !== SyntaxKind.VariableDeclaration);
      return [createFunctionDeclaration(
        'void', names.variables, [],
        [
          ...(rawInitBodyStmts ? rawDecls : initLoopVarDecls),
          ...(library.implicit === true ? [] : [
            createIfStatement(createIdentifier(names.variablesCompleted), [createReturnStatement()]),
            createExpressionStatement(createBinaryExpression(
              createIdentifier(names.variablesCompleted), SyntaxKind.EqualsToken, createIdentifier('true'),
            )),
          ]),
          ...(rawInitBodyStmts ? rawRest : varInitStmts),
        ],
      )];
    })() : []),
  ];
  trace?.('boilerplate:init-vars:end', {
    globals: allGlobalVars.length,
    statements: result.length,
    rawInit: !!rawInitBodyStmts,
  });
  return result;
}

function triggersInEditorTreeOrder(library: TriggerLibraryJson): TriggerJson[] {
  const all = findElementsOfType<TriggerJson>(library, 'Trigger');
  const ordered: TriggerJson[] = [];
  const seen = new Set<string>();
  const visit = (element: ElementJson | undefined): void => {
    if (!element) return;
    const key = refKey(element, library.id);
    if (seen.has(key)) return;
    seen.add(key);
    if (element.type === 'Trigger') {
      ordered.push(element as TriggerJson);
      return;
    }
    if (element.type !== 'Category') return;
    for (const ref of (element as any).items ?? []) {
      const owner = ref.library ?? library.id;
      if (owner !== library.id) continue;
      visit((library.elementsByType as any)?.[ref.type]?.[ref.id] ?? library.elements?.[`${ref.type}:${ref.id}`] ?? library.elements?.[ref.id]);
    }
  };
  // Root and category Item order is the Trigger Editor's visible order and the
  // order used by its generated InitTriggers. Flat XML element order is not:
  // the editor may serialize referenced trigger elements before their folders.
  for (const root of library.items ?? []) visit(root);
  // Keep unrooted triggers deterministic and lossless. They have no editor-tree
  // position to recover, so retain their authored XML order after rooted ones.
  for (const trigger of all) if (!seen.has(refKey(trigger, library.id))) ordered.push(trigger);
  return ordered;
}

/** InitCustomScript: one call per CustomScript initialization function. The editor
 *  writes it right after the custom script code (EditorTest CAI2, City of Tempest). */
function createCustomScriptInitialization(names: ReturnType<typeof libraryInitializationNames>, customInitializers: string[]): Statement {
  return createFunctionDeclaration('void', names.customScript, [], customInitializers.map(name => createExpressionStatement(createCallExpression(name, []))));
}

function createLibraryInitBoilerplatePart2(library: TriggerLibraryJson, names = libraryInitializationNames(library), hasCustomScripts = false, includeVariables = true, librariesStage = true): Statement[] {
  const libId = library.id;
  const initTriggerCalls = triggersInEditorTreeOrder(library).filter(trigger => !trigger.disabled).map(t =>
    createExpressionStatement(createCallExpression(triggerInitFuncName(libId, t), [])),
  );
  // A map with no triggers, variables or custom script of its own -- its triggers
  // all live in a library it defines -- has no trigger stage: InitMap calls
  // InitLibs alone (editor output of AllRacesTester and KeyStone). A library has
  // one only for triggers to initialize: 0 of 106 corpus libraries has an empty
  // InitTriggers, and none without triggers calls one.
  const triggerStage = initTriggerCalls.length > 0 || library.implicit === true && (hasCustomScripts || includeVariables);
  return [
    ...(triggerStage ? [createFunctionDeclaration('void', names.triggers, [], initTriggerCalls)] : []),
    ...(library.implicit === true ? [] : [createVariableDeclaration('bool', names.libraryCompleted, createIdentifier('false'))]),
    createFunctionDeclaration(
      'void', names.library, [],
      [
        ...(library.implicit === true ? [] : [
          createIfStatement(createIdentifier(names.libraryCompleted), [createReturnStatement()]),
          createExpressionStatement(createBinaryExpression(
            createIdentifier(names.libraryCompleted), SyntaxKind.EqualsToken, createIdentifier('true'),
          )),
        ]),
        ...(librariesStage ? [createExpressionStatement(createCallExpression(names.libraries, []))] : []),
        ...(includeVariables ? [createExpressionStatement(createCallExpression(names.variables, []))] : []),
        ...(hasCustomScripts ? [createExpressionStatement(createCallExpression(names.customScript, []))] : []),
        ...(triggerStage ? [createExpressionStatement(createCallExpression(names.triggers, []))] : []),
      ],
    ),
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Custom-script order follows the authored category tree, not sorted element IDs. */
function orderedCustomScripts(library: TriggerLibraryJson): CustomScriptJson[] {
  const result: CustomScriptJson[] = [], visited = new Set<string>();
  const visit = (ref: ElementRefJson) => {
    const element = lookupElement([library], ref, library.id);
    if (!element || element.disabled || visited.has(refKey(element, library.id))) return;
    visited.add(refKey(element, library.id));
    if (element.type === 'CustomScript') result.push(element);
    if (element.type === 'Category') for (const child of element.items) visit(child);
  };
  for (const ref of library.items.length ? library.items : Object.values(library.elements)) visit(ref);
  return result;
}

/** XML element sorting must not reorder declaration-time initialization. */
function orderedVariables(library: TriggerLibraryJson): VariableJson[] {
  const result: VariableJson[] = [], visited = new Set<string>();
  const visit = (ref: ElementRefJson) => {
    const element = lookupElement([library], ref, library.id);
    if (!element || visited.has(refKey(element, library.id))) return;
    visited.add(refKey(element, library.id));
    if (element.type === 'Variable' && !element.disabled) result.push(element);
    if (element.type === 'Category') element.items.forEach(visit);
  };
  library.items.forEach(visit);
  for (const variable of findElementsOfType<VariableJson>(library, 'Variable')) visit(variable);
  return result;
}

function presetIdentifierFunction(
  preset: PresetJson,
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
): FunctionDeclaration {
  const name = presetIdentifierFunctionName(preset, library.id);
  const body: Statement[] = [];
  for (const ref of preset.values) {
    const value = resolveRefFull(ref, library, nativeLibrary, allLibraries) as PresetValueJson | undefined;
    if (!value) continue;
    body.push(createIfStatement(
      createBinaryExpression(createIdentifier('lp_val'), SyntaxKind.EqualsEqualsToken, createIdentifier(presetValueConstantName(preset, value))),
      [createReturnStatement(createStringLiteral(sanitizeName(value.name ?? value.id)))],
    ));
  }
  body.push(createReturnStatement(createIdentifier('null')));
  return createFunctionDeclaration('string', name, [createParameter('int', 'lp_val')], body);
}

export function convertTriggerLibraryToGalaxy(
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
  rawScriptReplacements?: Map<string, string>,
  trace?: ConversionTrace,
  generation: GalaxyGenerationOptions = {},
  threadedGlobals: Statement[] = [],
): SourceFile {
  // A map document owns the script's namespace for the length of its conversion.
  return withImplicitLibrary(library.implicit === true ? library.id : undefined, () =>
    withNamingIndexes(() => convertTriggerLibraryToGalaxyBody(library, nativeLibrary, allLibraries, rawScriptReplacements, trace, generation, threadedGlobals)));
}

function convertTriggerLibraryToGalaxyBody(
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
  rawScriptReplacements?: Map<string, string>,
  trace?: ConversionTrace,
  generation: GalaxyGenerationOptions = {},
  threadedGlobals: Statement[] = [],
): SourceFile {
  trace?.('library:convert:start', {
    triggers: findElementsOfType<TriggerJson>(library, 'Trigger').length,
    functions: findElementsOfType<FunctionDefJson>(library, 'FunctionDef').length,
    variables: findElementsOfType<VariableJson>(library, 'Variable').length,
    structures: findElementsOfType<StructureJson>(library, 'Structure').length,
  });
  const subFuncTypeNames = buildSubFuncTypeNamesMap(nativeLibrary);
  const embedded = generation.embeddedLibraries ?? [];
  const depLibIds = documentDependencies(library, allLibraries, embedded);
  const initializationNames = libraryInitializationNames(library, nativeLibrary, allLibraries);
  const statements: Statement[] = [];

  // Build name disambiguation map once for this library
  const allGlobalVars = findElementsOfType<VariableJson>(library, 'Variable');
  const structureMemberVarIds = collectStructureMemberVarIds(library);
  const localVarIdSet = collectLocalVarIds(library);
  const globalVarNames = buildGlobalVarNamesMap(
    library.id,
    allGlobalVars.filter(v => !structureMemberVarIds.has(v.id) && !localVarIdSet.has(v.id)),
  );
  const hasRawVariableInitializer = findElementsOfType<FunctionDefJson>(library, 'FunctionDef')
    .some(definition => !definition.disabled && definition.library === library.id && definition.name === '__InitVariablesRaw');
  const includeVariables = hasRawVariableInitializer ||
    allGlobalVars.some(variable => !variable.disabled && !structureMemberVarIds.has(variable.id) && !localVarIdSet.has(variable.id));

  // A library whose elements reference no other library, the native one included,
  // gets TriggerLibs/natives and no InitLibraries from the editor (EditorTest's
  // empty CCEM and 10 more corpus libraries; AllRaces2-AI's, of AI includes and a
  // native function). Without the native library loaded a reconstructed library
  // cannot reference it, so the native library is then taken as used.
  const librariesStage = library.implicit === true || depLibIds.length > 0 || nativeLibrary === undefined ||
    referencedLibraries(library).has(nativeLibrary.id);
  statements.push(createIncludeStatement(librariesStage ? 'TriggerLibs/NativeLib' : 'TriggerLibs/natives'));
  // The editor includes a library from another package whole, before this
  // library's header (a map: `TriggerLibs/SwarmCampaignLib`, `LibEBBC9C87`).
  // A library of the same document gets its header here and its body last;
  // a map compiles the libraries it defines itself into its script instead.
  const externalIncludes = depLibIds.map(depId => allLibraries?.get(depId)?.includePath);
  depLibIds.forEach((_, index) => {
    const path = externalIncludes[index];
    if (path) statements.push(createIncludeStatement(path));
  });
  depLibIds.forEach((depId, index) => {
    if (!externalIncludes[index] && !embedded.includes(depId)) statements.push(createIncludeStatement(`Lib${depId}_h`));
  });
  statements.push(createIncludeStatement(`Lib${library.id}_h`));

  // Boilerplate part 1: InitLibraries + InitVariables (before triggers)
  if (generation.initialization !== 'preserve') statements.push(...createLibraryInitBoilerplatePart1(
    library,
    depLibIds,
    nativeLibrary?.id ?? 'Ntve',
    nativeLibrary,
    allLibraries,
    globalVarNames,
    structureMemberVarIds,
    localVarIdSet,
    rawScriptReplacements,
    trace,
    initializationNames,
    includeVariables,
    librariesStage,
  ));

  const customScripts = orderedCustomScripts(library);
  for (const custom of customScripts) {
    if (!custom.scriptCode) continue;
    const parsed = new Parser().parseFile(`Custom${custom.id}.galaxy`, custom.scriptCode);
    if (parsed.parseDiagnostics.length) conversionError('CUSTOM_SCRIPT_SYNTAX', 'CustomScript contains invalid Galaxy', { element: refKey(custom, library.id), diagnostics: parsed.parseDiagnostics });
    if (rawScriptReplacements) {
      const id = `custom_${rawScriptReplacements.size.toString(16)}`;
      rawScriptReplacements.set(id, custom.scriptCode.trim());
      statements.push(createExpressionStatement(createCallExpression(RAW_SCRIPT_PLACEHOLDER, [createStringLiteral(id)])));
    } else statements.push(...parsed.statements);
  }
  const customInitializers = customScripts.flatMap(custom => {
    if (!custom.initFunc) return [];
    if (!/^[A-Za-z_]\w*$/u.test(custom.initFunc)) conversionError('CUSTOM_SCRIPT_INITIALIZER', 'CustomScript initializer must be a Galaxy function identifier', { element: refKey(custom, library.id) });
    return [custom.initFunc];
  });
  if (generation.initialization !== 'preserve' && customScripts.length > 0) statements.push(createCustomScriptInitialization(initializationNames, customInitializers));
  for (const preset of findElementsOfType<PresetJson>(library, 'Preset')) {
    if (preset.generateIdentifier && !preset.disabled) statements.push(presetIdentifierFunction(preset, library, nativeLibrary, allLibraries));
  }

  // Trigger body + init function pairs
  for (const trigger of findElementsOfType<TriggerJson>(library, 'Trigger')) {
    if (trigger.disabled) continue;
    statements.push(convertTrigger(trigger, library, nativeLibrary, subFuncTypeNames, allLibraries, globalVarNames, rawScriptReplacements, trace));
    statements.push(convertTriggerInit(trigger, library, nativeLibrary, allLibraries, trace));
  }

  // Boilerplate part 2: InitTriggers + InitLib (after triggers)
  statements.push(...threadedGlobals);
  if (generation.initialization !== 'preserve') statements.push(...createLibraryInitBoilerplatePart2(
    library, initializationNames, customScripts.length > 0, includeVariables, librariesStage));
  else if (customInitializers.length) conversionError('INITIALIZATION_CUSTOM_SCRIPT', 'Preserving a source startup graph cannot implicitly schedule CustomScript initializers', { customInitializers });

  // Same-document dependency implementations at the bottom (Galaxy convention)
  depLibIds.forEach((depId, index) => {
    if (!externalIncludes[index] && !embedded.includes(depId)) statements.push(createIncludeStatement(`Lib${depId}`));
  });

  const sf = createSourceFile(`Lib${library.id}.galaxy`, statements);
  trace?.('library:convert:end', { statements: statements.length });
  return sf;
}

function buildUserFunctionSignatureText(
  funcDef: FunctionDefJson,
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
): { name: string; returnType: string; paramsText: string } | undefined {
  if (!funcDef.name) return undefined;
  const name = toGalaxyFunctionName(funcDef, { libId: library.id, library, nativeLibrary, allLibraries } as ConversionContext);
  const returnType = mapParameterTypeToGalaxy(
    effectiveFunctionReturnType(funcDef),
    library,
    nativeLibrary,
    allLibraries,
  );
  const params = buildUserFunctionParameters(funcDef, library, nativeLibrary, allLibraries)
    .map((p: any) => `${(p.type as any)?.name ?? 'int'} ${(p.name as any)?.name ?? 'lp_p0'}`);
  return { name, returnType, paramsText: params.join(', ') };
}

export function renderRawUserFunctionsText(
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
  rawScriptReplacements?: Map<string, string>,
  trace?: ConversionTrace,
  onProgress?: (completed: number, total: number) => void,
  threadedGlobals?: Statement[],
): string {
  const printer = new Printer(editorPrinterOptions());
  const parts: string[] = [];
  const definitions = findElementsOfType<FunctionDefJson>(library, 'FunctionDef');
  const progressInterval = Math.max(1, Math.floor(definitions.length / 100));
  trace?.('raw-functions:render:start');
  onProgress?.(0, definitions.length);
  for (let index = 0; index < definitions.length; index++) {
    if (index > 0 && index % progressInterval === 0) onProgress?.(index, definitions.length);
    const funcDef = definitions[index];
    if (funcDef.library !== library.id) continue;
    if (funcDef.disabled) continue;
    if (isInlineTemplate(funcDef) || funcDef.flags?.includes('Native') || isIdentityConversionOperator(funcDef, library, nativeLibrary, allLibraries)) continue;
    if (!funcDef.name || funcDef.name === '__InitVariablesRaw') continue;
    trace?.('raw-functions:function:start', {
      id: funcDef.id,
      name: funcDef.name,
      actions: funcDef.actions?.length ?? 0,
      hasScriptCode: !!funcDef.scriptCode,
    });
    // Prefer actions array (original SC2 Editor XML)
    if (funcDef.actions !== undefined) {
      const declarations = maybeCreateUserFunctionDefinition(funcDef, library, nativeLibrary, allLibraries, rawScriptReplacements, trace);
      if (declarations.length) {
        trace?.('raw-functions:function:print:start', { id: funcDef.id, name: funcDef.name });
        // A threaded definition prints as its globals, then its wrapper, then
        // its trigger function, with the globals directly above the wrapper.
        const printed = (statement: Statement) => printer.printNode(statement as any);
        const globals = declarations.filter(statement => statement.kind === SyntaxKind.VariableDeclaration);
        const functions = declarations.filter(statement => statement.kind !== SyntaxKind.VariableDeclaration);
        threadedGlobals?.push(...globals);
        parts.push([...(globals.length && !threadedGlobals ? [globals.map(printed).join('\n')] : []), ...functions.map(printed)].join('\n\n'));
        trace?.('raw-functions:function:print:end', { id: funcDef.id, name: funcDef.name });
      }
      continue;
    }
    // Fallback: raw scriptCode text (from roundtrip)
    if (!funcDef.scriptCode) continue;
    const sig = buildUserFunctionSignatureText(funcDef, library, nativeLibrary, allLibraries);
    if (!sig) continue;
    const body = funcDef.scriptCode;
    parts.push(`${sig.returnType} ${sig.name} (${sig.paramsText}) {\n${body}\n}`);
    trace?.('raw-functions:function:end', { id: funcDef.id, name: funcDef.name, source: 'scriptCode' });
  }
  onProgress?.(definitions.length, definitions.length);
  trace?.('raw-functions:render:end', { functions: parts.length });
  return parts.join('\n\n');
}

function applyRawScriptReplacements(scriptText: string, replacements: Map<string, string>): string {
  let out = scriptText;
  for (const [id, raw] of replacements) {
    const escapedName = RAW_SCRIPT_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^([ \\t]*)${escapedName}\\("${escapedId}"\\);[ \\t]*$`, 'gm');
    // At the indentation of the statement it stands for, as the editor writes a comment or custom script.
    out = out.replace(pattern, (_, indent: string) => raw.split('\n').map(line => line.trim() === '' ? line : indent + line).join('\n'));
  }
  return out;
}

export function convertTriggerLibraryToGalaxyFull(
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
  generation: GalaxyGenerationOptions = {},
): GalaxyOutput {
  return withImplicitLibrary(library.implicit === true ? library.id : undefined, () =>
    withNamingIndexes(() => convertTriggerLibraryToGalaxyFullBody(library, nativeLibrary, allLibraries, generation)));
}

function convertTriggerLibraryToGalaxyFullBody(
  library: TriggerLibraryJson,
  nativeLibrary?: TriggerLibraryJson,
  allLibraries?: Map<string, TriggerLibraryJson>,
  generation: GalaxyGenerationOptions = {},
): GalaxyOutput {
  const progress = (phase: import('./ttg-core.js').GalaxyGenerationProgress['phase'], completed: number, total: number): void => {
    try { generation.onProgress?.({ phase, completed, total }); } catch { /* observational only */ }
  };
  progress('validation', 0, 1);
  const dependencies = new Map(allLibraries);
  if (nativeLibrary) dependencies.set(nativeLibrary.id, nativeLibrary);
  assertConversionReferences(library, dependencies);
  // Read editor-type pairings out of the native library before anything asks for
  // a Galaxy type; without declarations this is a no-op and nothing changes.
  deriveNativeTypeMapping(nativeLibrary, generation.galaxyDeclarations);
  const symbolLibraries = new Map(allLibraries);
  symbolLibraries.set(library.id, library);
  if (nativeLibrary) symbolLibraries.set(nativeLibrary.id, nativeLibrary);
  indexDependencyFunctionNames(generation.galaxyDeclarations, symbolLibraries.values());
  indexDependencyVariableNames(generation.galaxyDeclarations, symbolLibraries.values());
  indexDeclaredGalaxySymbols(generation.galaxyDeclarations, symbolLibraries.values());
  progress('validation', 1, 1);
  const trace = createLibraryTrace(library.id);
  trace?.('full:start', {
    name: library.name,
    elements: Object.keys(library.elements ?? {}).length,
  });
  const rawScriptReplacements = new Map<string, string>();
  const threadedGlobals: Statement[] = [];
  let rawUserFns = renderRawUserFunctionsText(
    library,
    nativeLibrary,
    allLibraries,
    rawScriptReplacements,
    trace,
    (completed, total) => progress('user-functions', completed, total),
    threadedGlobals,
  );
  progress('startup-analysis', 0, 1);
  let startupSource = applyRawScriptReplacements(rawUserFns, rawScriptReplacements);
  let startupNodes = new Parser().parseFile('startup.galaxy', startupSource).statements;
  const preservedEntry = generation.initialization === 'library' ? undefined
    : preservedInitializationRoot([...startupNodes], library.id, generation.entryPoint);
  // Startup analysis needs every user function, but the generated script does
  // not need that parsed copy. Release it before constructing the trigger AST.
  startupNodes = [] as any;
  startupSource = '';
  progress('startup-analysis', 1, 1);
  const preserveStartup = generation.initialization === 'preserve' || !!preservedEntry;
  const effectiveGeneration: GalaxyGenerationOptions = { ...generation, ...(preserveStartup ? { initialization: 'preserve' } : {}) };
  trace?.('full:script-ast:start');
  progress('script-ast', 0, 1);
  const scriptAst = convertTriggerLibraryToGalaxy(library, nativeLibrary, allLibraries, rawScriptReplacements, trace, effectiveGeneration, threadedGlobals);
  trace?.('full:script-ast:end');
  progress('script-ast', 1, 1);

  // Header
  progress('header', 0, 1);
  const headerStmts: Statement[] = [];
  headerStmts.push(createIncludeStatement('TriggerLibs/natives'));

  for (const preset of findElementsOfType<PresetJson>(library, 'Preset')) {
    // PresetInteger is itself an editor request for ordinal ge_* constants;
    // older documents do not always repeat that request as PresetGenConstVar.
    if ((!preset.generateConstants && !preset.integer) || preset.disabled) continue;
    const type = mapParameterTypeToGalaxy({ type: preset.baseType ?? 'int' }, library, nativeLibrary, allLibraries);
    let ordinal = firstPresetOrdinal(preset);
    for (const [index, ref] of preset.values.entries()) {
      const value = resolveRefFull(ref, library, nativeLibrary, allLibraries) as PresetValueJson | undefined;
      if (!value) continue;
      let initializer: Expression | undefined;
      // PresetInteger is an editor contract: generated constants are ordinal
      // indexes. Disabled choices are retained as symbolic constants with -1
      // and do not consume an ordinal. Some old documents retain stale
      // textual/scalar Value payloads; the editor ignores those too.
      if (preset.integer) {
        initializer = createNumericLiteral(value.disabled ? -1 : ordinal++);
      } else if (value.value !== undefined) {
        const source = new Parser().parseFile('preset.galaxy', `void value() { return ${value.value}; }`);
        if (!source.parseDiagnostics.length) initializer = ((source.statements[0] as any).body.statements[0] as any).expression;
      } else if (type === 'int') initializer = createNumericLiteral(index);
      if (!initializer) conversionError('PRESET_VALUE', 'Generated preset constant has no supported value', { preset: refKey(preset, library.id), value: refKey(value, library.id) });
      headerStmts.push(createVariableDeclaration(type, presetValueConstantName(preset, value), initializer, true));
    }
    if (preset.generateIdentifier) {
      const name = presetIdentifierFunctionName(preset, library.id);
      headerStmts.push(createFunctionDeclaration('string', name, [createParameter('int', 'lp_val')], null));
    }
  }

  for (const structure of findElementsOfType<StructureJson>(library, 'Structure')) {
    if (structure.disabled) continue;
    if (traceElementsEnabled()) trace?.('header:structure', elementLabel(structure));
    const decl = buildStructureDeclaration(structure, library, nativeLibrary, allLibraries);
    if (decl) headerStmts.push(decl);
  }

  // Collect local variable IDs so they are excluded from the header
  const localVarIds = new Set<string>();
  for (const trigger of findElementsOfType<TriggerJson>(library, 'Trigger')) {
    for (const ref of trigger.localVariables ?? []) localVarIds.add(ref.id);
  }
  for (const funcDef of findElementsOfType<FunctionDefJson>(library, 'FunctionDef')) {
    for (const ref of funcDef.localVariables ?? []) localVarIds.add(ref.id);
  }

  // Use the same disambiguation map as the body generator
  trace?.('header:build:start');
  const allGlobalVarsForHeader = findElementsOfType<VariableJson>(library, 'Variable').filter(variable => !variable.disabled);
  const structureMemberVarIds = collectStructureMemberVarIds(library);
  const localVarIdSetForHeader = collectLocalVarIds(library);
  const hasRawVariableInitializer = findElementsOfType<FunctionDefJson>(library, 'FunctionDef')
    .some(definition => !definition.disabled && definition.library === library.id && definition.name === '__InitVariablesRaw');
  const includeVariables = hasRawVariableInitializer ||
    allGlobalVarsForHeader.some(variable => !variable.disabled && !structureMemberVarIds.has(variable.id) && !localVarIdSetForHeader.has(variable.id));
  const globalVarNamesForHeader = buildGlobalVarNamesMap(
    library.id,
    allGlobalVarsForHeader.filter(v => !structureMemberVarIds.has(v.id) && !localVarIdSetForHeader.has(v.id)),
  );
  const headerCtx: ConversionContext = {
    ...namingIndexes(),
    library,
    nativeLibrary,
    allLibraries,
    libId: library.id,
    localVarIds: new Set(),
    subFuncTypeNames: buildSubFuncTypeNamesMap(nativeLibrary),
    autoVarDeclarations: [],
    globalVarNames: globalVarNamesForHeader,
    structureMemberVarIds,
  };

  for (const variable of orderedVariables(library)) {
    if (traceElementsEnabled()) trace?.('header:variable', elementLabel(variable));
    if (structureMemberVarIds.has(variable.id)) continue;
    if (localVarIds.has(variable.id)) continue;
    const baseGalaxyType = mapParameterTypeToGalaxy(variable.variableType, library, nativeLibrary, allLibraries);
    const galaxyType = isArrayVar(variable as any)
      ? `${baseGalaxyType}${buildGalaxyArrayTypeSuffix(variable, headerCtx)}`
      : baseGalaxyType;
    const varName = globalVarNamesForHeader.get(variable.id) ?? globalVarName(library.id, variable);
    let initExpr: Expression | undefined;
    if (variable.initialValue && !isArrayVar(variable as any)) {
      const paramEl = resolveRefFull(variable.initialValue, library, nativeLibrary, allLibraries) as ParamJson | undefined;
      if (paramEl) initExpr = convertParamExpr(paramEl, headerCtx);
    }
    const inlineConstant = variable.isConstant && isTriggerConstantInitializer(
      variable.initialValue
        ? resolveRefFull(variable.initialValue, library, nativeLibrary, allLibraries) as ParamJson | undefined
        : undefined,
      initExpr,
      baseGalaxyType,
    );
    if ((inlineConstant || preserveStartup) && !isArrayVar(variable as any)) {
      headerStmts.push(createVariableDeclaration(galaxyType, varName, initExpr, inlineConstant));
    } else {
      headerStmts.push(createVariableDeclaration(galaxyType, varName));
    }
  }
  const declaredTriggerHandles = new Set<string>();
  for (const trigger of findElementsOfType<TriggerJson>(library, 'Trigger')) {
    if (trigger.disabled) continue;
    if (traceElementsEnabled()) trace?.('header:trigger-handle', elementLabel(trigger));
    const handleName = triggerHandleName(library.id, trigger);
    declaredTriggerHandles.add(handleName);
    headerStmts.push(createVariableDeclaration('trigger', handleName));
  }
  for (const handleName of [...collectScriptTriggerHandleNames(library, nativeLibrary, allLibraries)].sort()) {
    if (declaredTriggerHandles.has(handleName)) continue;
    headerStmts.push(createVariableDeclaration('trigger', handleName));
  }
  if (!preserveStartup && includeVariables) headerStmts.push(createFunctionDeclaration('void', libraryInitializationNames(library, nativeLibrary, allLibraries).variables, [], null));

  // User-defined function forward declarations
  for (const funcDef of findElementsOfType<FunctionDefJson>(library, 'FunctionDef')) {
    if (funcDef.disabled) continue;
    if (traceElementsEnabled()) trace?.('header:function-forward', elementLabel(funcDef));
    if (isInlineTemplate(funcDef) || isIdentityConversionOperator(funcDef, library, nativeLibrary, allLibraries)) continue;
    if (!funcDef.name || funcDef.name === '__InitVariablesRaw') continue;
    const galaxyFuncName = toGalaxyFunctionName(funcDef, { libId: library.id, library, nativeLibrary, allLibraries } as ConversionContext);
    const returnType = mapParameterTypeToGalaxy(
      effectiveFunctionReturnType(funcDef),
      library,
      nativeLibrary,
      allLibraries,
    );
    const params = buildUserFunctionParameters(funcDef, library, nativeLibrary, allLibraries);
    headerStmts.push(createFunctionDeclaration(returnType, galaxyFuncName, params, null));
  }
  const headerAst = createSourceFile(`Lib${library.id}_h.galaxy`, headerStmts);
  trace?.('header:build:end', { statements: headerStmts.length });
  progress('header', 1, 1);

  const printer = new Printer(editorPrinterOptions());
  // Embed library name as a comment so galaxy-to-trigger can recover it.
  // Only written when the name differs from the raw ID (avoids useless noise).
  const nameComment = (library.name && library.name !== library.id)
    ? `// LibraryName: ${library.name}\n`
    : '';
  trace?.('print:script:start');
  progress('print', 0, 1);
  let scriptText = printer.printFile(scriptAst);
  // The printed text is now authoritative; retaining every trigger AST node
  // through header generation only increases the peak heap.
  (scriptAst as any).statements = [];
  trace?.('print:script:end', { chars: scriptText.length });
  if (rawUserFns) {
    scriptText += `\n${rawUserFns}\n`;
    rawUserFns = '';
  }
  trace?.('raw-replacements:start', { replacements: rawScriptReplacements.size });
  scriptText = applyRawScriptReplacements(scriptText, rawScriptReplacements);
  rawScriptReplacements.clear();
  trace?.('raw-replacements:end', { chars: scriptText.length });
  trace?.('print:header:start');
  const headerText = printer.printFile(headerAst);
  (headerAst as any).statements = [];
  headerStmts.length = 0;
  trace?.('print:header:end', { chars: headerText.length });
  trace?.('full:end', { scriptChars: scriptText.length, headerChars: headerText.length });
  progress('print', 1, 1);
  progress('complete', 1, 1);
  return {
    script: editorLayoutComment(library, element => {
      if (element.type === 'FunctionDef' && !isInlineTemplate(element)) return toGalaxyFunctionName(element, headerCtx);
      if (element.type === 'Trigger') return triggerFuncName(library.id, element);
      if (element.type === 'Variable') return globalVarNamesForHeader.get(element.id);
      return undefined;
    }) + nameComment + scriptText,
    header: headerText,
    ...(preserveStartup ? { initialization: { mode: 'preserve' as const, ...(preservedEntry ? { entryPoint: preservedEntry } : {}) } } : {}),
  };
}

// buildSubFuncTypeNamesMap is imported from ttg-core.ts
