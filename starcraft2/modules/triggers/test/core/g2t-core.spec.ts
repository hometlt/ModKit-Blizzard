/**
 * Unit tests for g2t-core.ts — the reverse-conversion infrastructure.
 *
 * Includes tests previously in galaxy-to-trigger.vs-test.spec.ts for the
 * name-extraction and boilerplate-detection helpers (now re-homed here since
 * those functions live in g2t-core.ts).
 *
 * Also covers AST utility functions, type helpers, and lookup-map builders.
 */
import { describe, it, expect } from 'vitest';
import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import {
  // Name extraction
  extractGlobalVarName,
  extractLocalVarName,
  extractAutoVarName,
  extractTriggerName,
  // Boilerplate detection
  isLibraryBoilerplate,
  isTriggerInitFunction,
  isTriggerBodyFunction,
  // Default value helpers
  defaultValueForType,
  // Type helpers
  galaxyTypeToTrigger,
  getTypeName,
  // AST utilities
  unwrapParens,
  getIdentifierName,
  lvalueKey,
  readSignedIntLiteral,
  isTrueExpr,
  isGeneratedAutoLoopVarName,
  getBlockStatements,
  isBreakGuardOnNegative,
  isBreakGuardOnNull,
  forStmtUsesCounterVar,
  // Lookup map builders
  buildRoleToSubFuncTypeMap,
  buildFuncDefRoleMap,
  buildGalaxyConstToPresetMap,
  mkFCRef,
} from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-core.js';
import { withImplicitLibrary } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/conversion-model.js';

// ---------------------------------------------------------------------------
// Helpers — minimal AST node factories
// ---------------------------------------------------------------------------

const id = (name: string) => ({ kind: SyntaxKind.Identifier, name, pos: 0, end: name.length });
const num = (v: number) => ({ kind: SyntaxKind.NumericLiteral, text: String(v), value: v });
const paren = (expr: any) => ({ kind: SyntaxKind.ParenthesizedExpression, expression: expr });
const binExpr = (left: any, op: SyntaxKind, right: any) => ({
  kind: SyntaxKind.BinaryExpression,
  left,
  operatorToken: { kind: op },
  right,
});
const block = (...stmts: any[]) => ({ kind: SyntaxKind.Block, statements: stmts });
const exprStmt = (expr: any) => ({ kind: SyntaxKind.ExpressionStatement, expression: expr });
const ifStmt = (cond: any, then: any, els?: any) => ({ kind: SyntaxKind.IfStatement, expression: cond, thenStatement: then, elseStatement: els });
const breakStmt = () => ({ kind: SyntaxKind.BreakStatement });
const nullKw = () => ({ kind: SyntaxKind.NullKeyword });

describe('preset constant lookup', () => {
  it('prefers a concrete choice over a DefinesDefault wildcard sharing its Galaxy value', () => {
    const nativeLibrary: any = {
      id: 'Ntve', elements: {}, items: [],
      elementsByType: {
        PresetValue: {
          ANY: { type: 'PresetValue', id: 'ANY', library: 'Ntve', value: 'c_invalidHandle', definesDefault: true },
          NONE: { type: 'PresetValue', id: 'NONE', library: 'Ntve', value: 'c_invalidHandle' },
        },
        Preset: {},
      },
    };
    expect(buildGalaxyConstToPresetMap(nativeLibrary).get('c_invalidHandle')).toEqual({
      type: 'PresetValue', library: 'Ntve', id: 'NONE',
    });
  });
});

// ---------------------------------------------------------------------------
// Name extraction helpers (moved from galaxy-to-trigger.vs-test.spec.ts)
// ---------------------------------------------------------------------------

describe('extractGlobalVarName', () => {
  it('extracts name from libCD5269DE_gv_tEST_GLOBAL_VAR', () => {
    expect(extractGlobalVarName('libCD5269DE_gv_tEST_GLOBAL_VAR', 'CD5269DE')).toBe('tEST_GLOBAL_VAR');
  });

  it('extracts name from libD970AA02_gv_name (cross-library)', () => {
    expect(extractGlobalVarName('libD970AA02_gv_tEST_GLOBAL_VAR', 'D970AA02')).toBe('tEST_GLOBAL_VAR');
  });

  it('extracts MapScript-style gv_ globals', () => {
    expect(extractGlobalVarName('gv_myVar', '')).toBe('myVar');
  });

  it('returns undefined for non-global names', () => {
    expect(extractGlobalVarName('lv_local', 'CD5269DE')).toBeUndefined();
    expect(extractGlobalVarName('libCD5269DE_gt_TRIGGER', 'CD5269DE')).toBeUndefined();
    expect(extractGlobalVarName('libNtve_InitVariables', 'CD5269DE')).toBeUndefined();
  });

  it('returns undefined for gv_ with no suffix', () => {
    expect(extractGlobalVarName('gv_', '')).toBeUndefined();
  });

  it('removes historical embedded-library linkage from map globals and constants', () => {
    withImplicitLibrary('Map', () => {
      expect(extractGlobalVarName('libAny_gv_player_count', 'Map')).toBe('player_count');
      expect(extractGlobalVarName('libAny_ge_CosmeticType_Decoration', 'Map')).toBe('CosmeticType_Decoration');
    });
  });
});

describe('extractLocalVarName', () => {
  it('extracts name from lv_tEST_LOCAL_VAR', () => {
    expect(extractLocalVarName('lv_tEST_LOCAL_VAR')).toBe('tEST_LOCAL_VAR');
  });

  it('extracts name from lv_MyVar', () => {
    expect(extractLocalVarName('lv_MyVar')).toBe('MyVar');
  });

  it('returns undefined for non-local names', () => {
    expect(extractLocalVarName('libCD5269DE_gv_var')).toBeUndefined();
    expect(extractLocalVarName('lv_')).toBeUndefined();
    expect(extractLocalVarName('var')).toBeUndefined();
  });
});

describe('extractAutoVarName', () => {
  it('extracts id and suffix from auto75079F91_var', () => {
    expect(extractAutoVarName('auto75079F91_var')).toEqual({ id: '75079F91', suffix: 'var' });
  });

  it('extracts id and suffix from auto75079F91_ae', () => {
    expect(extractAutoVarName('auto75079F91_ae')).toEqual({ id: '75079F91', suffix: 'ae' });
  });

  it('handles all valid suffixes', () => {
    for (const suffix of ['var', 'ae', 'ai', 'at']) {
      expect(extractAutoVarName(`autoABCDEF01_${suffix}`)?.suffix).toBe(suffix);
    }
  });

  it('returns undefined for non-auto names', () => {
    expect(extractAutoVarName('lv_var')).toBeUndefined();
    expect(extractAutoVarName('auto_var')).toBeUndefined();
    expect(extractAutoVarName('auto123_var')).toBeUndefined(); // non-hex characters
  });
});

describe('extractTriggerName', () => {
  it('extracts name from trigger handle libCD5269DE_gt_TEST_TRIGGER', () => {
    expect(extractTriggerName('libCD5269DE_gt_TEST_TRIGGER', 'CD5269DE')).toBe('TEST_TRIGGER');
  });

  it('strips _Func suffix from trigger body function', () => {
    expect(extractTriggerName('libCD5269DE_gt_TEST_TRIGGER_Func', 'CD5269DE')).toBe('TEST_TRIGGER');
  });

  it('handles MapScript-style gt_ names', () => {
    expect(extractTriggerName('gt_MyTrigger', 'LIB')).toBe('MyTrigger');
    expect(extractTriggerName('gt_MyTrigger_Func', 'LIB')).toBe('MyTrigger');
  });

  it('returns undefined for non-trigger names', () => {
    expect(extractTriggerName('libCD5269DE_gv_var', 'CD5269DE')).toBeUndefined();
    expect(extractTriggerName('libCD5269DE_InitLib', 'CD5269DE')).toBeUndefined();
  });
});

describe('isLibraryBoilerplate', () => {
  it('recognizes all three boilerplate function names', () => {
    expect(isLibraryBoilerplate('libABCD_InitLibraries', 'ABCD')).toBe(true);
    expect(isLibraryBoilerplate('libABCD_InitVariables', 'ABCD')).toBe(true);
    expect(isLibraryBoilerplate('libABCD_InitLib', 'ABCD')).toBe(true);
  });

  it('returns false for trigger functions', () => {
    expect(isLibraryBoilerplate('libABCD_gt_Trigger_Func', 'ABCD')).toBe(false);
    expect(isLibraryBoilerplate('libABCD_gt_Trigger_Init', 'ABCD')).toBe(false);
  });

  it('returns false when lib ID does not match', () => {
    expect(isLibraryBoilerplate('libOTHER_InitLib', 'ABCD')).toBe(false);
  });
});

describe('isTriggerInitFunction', () => {
  it('recognizes trigger init functions', () => {
    expect(isTriggerInitFunction('libABCD_gt_MyTrigger_Init', 'ABCD')).toBe(true);
    expect(isTriggerInitFunction('gt_MyTrigger_Init', 'ABCD')).toBe(true);
  });

  it('returns false for trigger body functions', () => {
    expect(isTriggerInitFunction('libABCD_gt_MyTrigger_Func', 'ABCD')).toBe(false);
  });

  it('returns false for _Func_Init compound suffix', () => {
    expect(isTriggerInitFunction('libABCD_gt_MyTrigger_Func_Init', 'ABCD')).toBe(false);
  });
});

describe('isTriggerBodyFunction', () => {
  it('recognizes trigger body functions', () => {
    expect(isTriggerBodyFunction('libABCD_gt_MyTrigger_Func', 'ABCD')).toBe(true);
    expect(isTriggerBodyFunction('gt_MyTrigger_Func', 'ABCD')).toBe(true);
  });

  it('returns false for init functions', () => {
    expect(isTriggerBodyFunction('libABCD_gt_MyTrigger_Init', 'ABCD')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// defaultValueForType
// ---------------------------------------------------------------------------

describe('defaultValueForType', () => {
  it('returns 0 for int', () => {
    const r = defaultValueForType('int');
    expect(r.value).toBe('0');
    expect(r.valueType?.type).toBe('int');
  });

  it('returns 0.0 for fixed', () => {
    const r = defaultValueForType('fixed');
    expect(r.value).toBe('0.0');
    expect(r.valueType?.type).toBe('fixed');
  });

  it('returns false for bool', () => {
    const r = defaultValueForType('bool');
    expect(r.value).toBe('false');
    expect(r.valueType?.type).toBe('bool');
  });

  it('returns empty string for string', () => {
    const r = defaultValueForType('string');
    expect(r.value).toBe('');
    expect(r.valueType?.type).toBe('string');
  });

  it('falls back to int for unknown types', () => {
    const r = defaultValueForType('unit');
    expect(r.value).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// galaxyTypeToTrigger
// ---------------------------------------------------------------------------

describe('galaxyTypeToTrigger', () => {
  it('lowercases known primitive types', () => {
    expect(galaxyTypeToTrigger('INT')).toBe('int');
    expect(galaxyTypeToTrigger('Fixed')).toBe('fixed');
    expect(galaxyTypeToTrigger('BOOL')).toBe('bool');
  });

  it('preserves original casing for unknown/custom types', () => {
    expect(galaxyTypeToTrigger('GameLink')).toBe('GameLink');
    expect(galaxyTypeToTrigger('CatalogEntry')).toBe('CatalogEntry');
  });

  it('handles known SC2 unit types', () => {
    expect(galaxyTypeToTrigger('unit')).toBe('unit');
    expect(galaxyTypeToTrigger('unitgroup')).toBe('unitgroup');
    expect(galaxyTypeToTrigger('playergroup')).toBe('playergroup');
  });
});

// ---------------------------------------------------------------------------
// getTypeName (AST type node → string)
// ---------------------------------------------------------------------------

describe('getTypeName', () => {
  it('returns "int" for null/undefined', () => {
    expect(getTypeName(null)).toBe('int');
    expect(getTypeName(undefined)).toBe('int');
  });

  it('reads .name when it is a non-empty string', () => {
    expect(getTypeName({ name: 'unit' })).toBe('unit');
  });

  it('maps keyword kinds to type strings', () => {
    expect(getTypeName({ kind: SyntaxKind.VoidKeyword })).toBe('void');
    expect(getTypeName({ kind: SyntaxKind.IntKeyword })).toBe('int');
    expect(getTypeName({ kind: SyntaxKind.BoolKeyword })).toBe('bool');
    expect(getTypeName({ kind: SyntaxKind.FixedKeyword })).toBe('fixed');
    expect(getTypeName({ kind: SyntaxKind.StringKeyword })).toBe('string');
    expect(getTypeName({ kind: SyntaxKind.UnitKeyword })).toBe('unit');
  });

  it('rejects an unrecognised kind rather than changing its type', () => {
    expect(() => getTypeName({ kind: 99999 })).toThrow('Unknown Galaxy type node');
  });
});

// ---------------------------------------------------------------------------
// AST utility functions
// ---------------------------------------------------------------------------

describe('unwrapParens', () => {
  it('returns non-paren expressions unchanged', () => {
    const expr = id('foo');
    expect(unwrapParens(expr)).toBe(expr);
  });

  it('unwraps one level of parentheses', () => {
    const inner = id('x');
    expect(unwrapParens(paren(inner))).toBe(inner);
  });

  it('unwraps multiple nested parentheses', () => {
    const inner = id('x');
    expect(unwrapParens(paren(paren(paren(inner))))).toBe(inner);
  });

  it('returns undefined/null unchanged', () => {
    expect(unwrapParens(null)).toBeNull();
    expect(unwrapParens(undefined)).toBeUndefined();
  });
});

describe('getIdentifierName', () => {
  it('returns name for an Identifier node', () => {
    expect(getIdentifierName(id('myVar'))).toBe('myVar');
  });

  it('unwraps parentheses before reading', () => {
    expect(getIdentifierName(paren(id('myVar')))).toBe('myVar');
  });

  it('returns undefined for non-identifier nodes', () => {
    expect(getIdentifierName(num(5))).toBeUndefined();
    expect(getIdentifierName(null)).toBeUndefined();
  });
});

describe('readSignedIntLiteral', () => {
  it('reads a positive integer literal', () => {
    expect(readSignedIntLiteral(num(42))).toBe(42);
  });

  it('reads 0', () => {
    expect(readSignedIntLiteral(num(0))).toBe(0);
  });

  it('reads a negative unary expression -N', () => {
    const negExpr = {
      kind: SyntaxKind.PrefixUnaryExpression,
      operator: { kind: SyntaxKind.MinusToken },
      operand: num(5),
    };
    expect(readSignedIntLiteral(negExpr)).toBe(-5);
  });

  it('returns undefined for identifiers', () => {
    expect(readSignedIntLiteral(id('x'))).toBeUndefined();
  });

  it('unwraps parentheses', () => {
    expect(readSignedIntLiteral(paren(num(7)))).toBe(7);
  });
});

describe('isTrueExpr', () => {
  it('returns true for TrueKeyword', () => {
    expect(isTrueExpr({ kind: SyntaxKind.TrueKeyword })).toBe(true);
  });

  it('returns false for FalseKeyword', () => {
    expect(isTrueExpr({ kind: SyntaxKind.FalseKeyword })).toBe(false);
  });

  it('unwraps parentheses', () => {
    expect(isTrueExpr(paren({ kind: SyntaxKind.TrueKeyword }))).toBe(true);
  });

  it('returns false for identifiers', () => {
    expect(isTrueExpr(id('true'))).toBe(false); // must be the keyword node, not an identifier
  });
});

describe('isGeneratedAutoLoopVarName', () => {
  it('matches auto*_var names', () => {
    expect(isGeneratedAutoLoopVarName('auto75079F91_var')).toBe(true);
    expect(isGeneratedAutoLoopVarName('autoABCD1234_var')).toBe(true);
  });

  it('rejects non-var suffixes', () => {
    expect(isGeneratedAutoLoopVarName('auto75079F91_ae')).toBe(false);
    expect(isGeneratedAutoLoopVarName('auto75079F91_ai')).toBe(false);
  });

  it('rejects plain identifiers', () => {
    expect(isGeneratedAutoLoopVarName('lv_count')).toBe(false);
    expect(isGeneratedAutoLoopVarName(undefined)).toBe(false);
  });
});

describe('getBlockStatements', () => {
  it('returns statements array from a Block node', () => {
    const s1 = exprStmt(id('a'));
    const s2 = exprStmt(id('b'));
    expect(getBlockStatements(block(s1, s2))).toEqual([s1, s2]);
  });

  it('wraps a single non-block statement in an array', () => {
    const s = exprStmt(id('a'));
    expect(getBlockStatements(s)).toEqual([s]);
  });

  it('returns empty array for null/undefined', () => {
    expect(getBlockStatements(null)).toEqual([]);
    expect(getBlockStatements(undefined)).toEqual([]);
  });
});

describe('isBreakGuardOnNegative', () => {
  it('recognises if (iterVar < 0) { break; }', () => {
    const stmt = ifStmt(
      binExpr(id('lv_i'), SyntaxKind.LessThanToken, num(0)),
      block(breakStmt()),
    );
    expect(isBreakGuardOnNegative(stmt, 'lv_i')).toBe(true);
  });

  it('returns false when the variable name does not match', () => {
    const stmt = ifStmt(
      binExpr(id('lv_j'), SyntaxKind.LessThanToken, num(0)),
      block(breakStmt()),
    );
    expect(isBreakGuardOnNegative(stmt, 'lv_i')).toBe(false);
  });

  it('returns false when the right side is not 0', () => {
    const stmt = ifStmt(
      binExpr(id('lv_i'), SyntaxKind.LessThanToken, num(1)),
      block(breakStmt()),
    );
    expect(isBreakGuardOnNegative(stmt, 'lv_i')).toBe(false);
  });
});

describe('lvalueKey', () => {
  const property = (base: any, member: string) => ({ kind: SyntaxKind.PropertyAccessExpression, expression: base, name: id(member) });
  const element = (base: any, index: any) => ({ kind: SyntaxKind.ElementAccessExpression, expression: base, argumentExpression: index });

  it('spells variables, record fields and array elements canonically', () => {
    expect(lvalueKey(id('lv_i'))).toBe('lv_i');
    expect(lvalueKey(property(id('gv_mGen'), 'lv_tempInt1'))).toBe('gv_mGen.lv_tempInt1');
    expect(lvalueKey(property(element(id('gv_states'), num(2)), 'lv_counter'))).toBe('gv_states[2].lv_counter');
    expect(lvalueKey(element(id('gv_units'), id('lv_i')))).toBe('gv_units[lv_i]');
  });

  it('rejects paths whose evaluation can have effects', () => {
    const call = { kind: SyntaxKind.CallExpression, expression: id('KillingPlayer'), arguments: [] };
    expect(lvalueKey(element(id('gv_score'), call))).toBeUndefined();
    expect(lvalueKey(call)).toBeUndefined();
  });

  it('matches a break guard on a record field iterator', () => {
    const stmt = ifStmt(
      binExpr(property(id('gv_mGen'), 'lv_unit'), SyntaxKind.EqualsEqualsToken, nullKw()),
      block(breakStmt()),
    );
    expect(isBreakGuardOnNull(stmt, 'gv_mGen.lv_unit')).toBe(true);
  });
});

describe('isBreakGuardOnNull', () => {
  it('recognises if (iterVar == null) { break; }', () => {
    const stmt = ifStmt(
      binExpr(id('lv_u'), SyntaxKind.EqualsEqualsToken, nullKw()),
      block(breakStmt()),
    );
    expect(isBreakGuardOnNull(stmt, 'lv_u')).toBe(true);
  });

  it('returns false when comparing to non-null', () => {
    const stmt = ifStmt(
      binExpr(id('lv_u'), SyntaxKind.EqualsEqualsToken, num(0)),
      block(breakStmt()),
    );
    expect(isBreakGuardOnNull(stmt, 'lv_u')).toBe(false);
  });
});

describe('forStmtUsesCounterVar', () => {
  const counterVar = 'auto12345678_var';

  it('returns true when condition references the counter var on left', () => {
    const forNode = {
      kind: SyntaxKind.ForStatement,
      condition: binExpr(id(counterVar), SyntaxKind.LessThanEqualsToken, id('auto12345678_ae')),
      incrementor: null,
      statement: block(),
    };
    expect(forStmtUsesCounterVar(forNode, counterVar)).toBe(true);
  });

  it('returns false for a null/undefined for statement', () => {
    expect(forStmtUsesCounterVar(null, counterVar)).toBe(false);
    expect(forStmtUsesCounterVar({ kind: SyntaxKind.WhileStatement }, counterVar)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildRoleToSubFuncTypeMap / buildFuncDefRoleMap
// ---------------------------------------------------------------------------

describe('buildRoleToSubFuncTypeMap', () => {
  it('returns empty map when nativeLibrary is undefined', () => {
    expect(buildRoleToSubFuncTypeMap(undefined).size).toBe(0);
  });

  it('builds a map from subFuncTypeNames', () => {
    const nativeLib: any = {
      subFuncTypeNames: {
        'Ntve_00000003': 'If',
        'Ntve_00000004': 'Then',
        'Ntve_00000007': 'Actions',
      },
    };
    const map = buildRoleToSubFuncTypeMap(nativeLib);
    expect(map.get('If')).toEqual({ type: 'SubFuncType', library: 'Ntve', id: '00000003' });
    expect(map.get('Then')).toEqual({ type: 'SubFuncType', library: 'Ntve', id: '00000004' });
    expect(map.get('Actions')).toEqual({ type: 'SubFuncType', library: 'Ntve', id: '00000007' });
  });

  it('uses the first entry when the same role name appears multiple times', () => {
    const nativeLib: any = {
      subFuncTypeNames: {
        'Ntve_00000001': 'Actions',
        'Ntve_00000007': 'Actions', // duplicate role
      },
    };
    const map = buildRoleToSubFuncTypeMap(nativeLib);
    expect(map.get('Actions')).toEqual({ type: 'SubFuncType', library: 'Ntve', id: '00000001' });
  });
});

describe('buildFuncDefRoleMap', () => {
  it('returns fallback map when funcDef has no subFunctionTypes', () => {
    const funcDef: any = { type: 'FunctionDef', id: 'F1', library: 'Ntve' };
    const fallback = new Map([['Actions', { library: 'Ntve', id: '00000007' }]]);
    expect(buildFuncDefRoleMap(funcDef, undefined, fallback)).toBe(fallback);
  });

  it('overrides fallback map with function-specific SubFuncType IDs', () => {
    const funcDef: any = {
      type: 'FunctionDef', id: 'F1', library: 'Ntve',
      subFunctionTypes: [{ library: 'Ntve', id: 'WHILECOND' }],
    };
    const nativeLib: any = {
      subFuncTypeNames: { 'Ntve_WHILECOND': 'Conditions' },
    };
    const fallback = new Map([['Conditions', { library: 'Ntve', id: '00000003' }]]);
    const map = buildFuncDefRoleMap(funcDef, nativeLib, fallback);
    expect(map.get('Conditions')).toEqual({ type: 'SubFuncType', library: 'Ntve', id: 'WHILECOND' });
  });

  it('does not leak roles owned by other FunctionDefs', () => {
    const funcDef: any = {
      type: 'FunctionDef', id: 'AND', library: 'Ntve',
      subFunctionTypes: [{ library: 'Ntve', id: 'COND' }],
    };
    const nativeLib: any = {
      subFuncTypeNames: { 'Ntve_COND': 'cond' },
    };
    const fallback = new Map([['Conditions', { library: 'Ntve', id: 'IF_CONDITIONS' }]]);
    const map = buildFuncDefRoleMap(funcDef, nativeLib, fallback);
    expect(map.get('cond')).toEqual({ type: 'SubFuncType', library: 'Ntve', id: 'COND' });
    expect(map.has('Conditions')).toBe(false);
  });
});

describe('mkFCRef subfunction roles', () => {
  const context = (roles: any[]): any => ({
    libId: 'TEST',
    elements: {
      PARENT: { type: 'FunctionDef', id: 'PARENT', library: 'TEST', subFunctionTypes: roles },
      CHILD: { type: 'FunctionCall', id: 'CHILD', library: 'TEST', functionDef: { type: 'FunctionDef', library: 'Ntve', id: 'ACTION' } },
    },
    dependencyLibraries: new Map(),
  });

  it('places an unroled executable child in the sole role declared by its parent', () => {
    const ctx = context([{ type: 'SubFuncType', library: 'Ntve', id: 'ONLY' }]);
    mkFCRef({
      functionDef: { type: 'FunctionDef', library: 'TEST', id: 'PARENT' },
      subFunctions: [{ type: 'FunctionCall', library: 'TEST', id: 'CHILD' }],
    }, ctx);
    expect(ctx.elements.CHILD.subFunctionType).toEqual({ type: 'SubFuncType', library: 'Ntve', id: 'ONLY' });
  });

  it('does not guess between multiple parent roles', () => {
    const ctx = context([
      { type: 'SubFuncType', library: 'Ntve', id: 'FIRST' },
      { type: 'SubFuncType', library: 'Ntve', id: 'SECOND' },
    ]);
    mkFCRef({
      functionDef: { type: 'FunctionDef', library: 'TEST', id: 'PARENT' },
      subFunctions: [{ type: 'FunctionCall', library: 'TEST', id: 'CHILD' }],
    }, ctx);
    expect(ctx.elements.CHILD.subFunctionType).toBeUndefined();
  });

  it('assigns an unroled comparison to the sole condition role of IfThen', () => {
    const ctx = context([
      { type: 'SubFuncType', library: 'Ntve', id: 'IF' },
      { type: 'SubFuncType', library: 'Ntve', id: 'THEN' },
    ]);
    ctx.nativeLibrary = {
      id: 'Ntve',
      elementsByType: {
        SubFuncType: {
          IF: { type: 'SubFuncType', id: 'IF', library: 'Ntve' },
          THEN: { type: 'SubFuncType', id: 'THEN', library: 'Ntve', isAction: true },
        },
        FunctionDef: {
          COMPARISON: { type: 'FunctionDef', id: 'COMPARISON', library: 'Ntve', isFuncAction: false },
        },
      },
    };
    ctx.elements.CHILD.functionDef.id = 'COMPARISON';
    mkFCRef({
      functionDef: { type: 'FunctionDef', library: 'TEST', id: 'PARENT' },
      subFunctions: [{ type: 'FunctionCall', library: 'TEST', id: 'CHILD' }],
    }, ctx);
    expect(ctx.elements.CHILD.subFunctionType).toEqual({ type: 'SubFuncType', library: 'Ntve', id: 'IF' });
  });
});
