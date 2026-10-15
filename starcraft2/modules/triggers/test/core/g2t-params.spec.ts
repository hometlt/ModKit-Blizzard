/**
 * Unit tests for g2t-params.ts — standalone parameter helpers for Galaxy→trigger.
 * All functions here are pure/stateless and require no real Galaxy source files.
 */
import { describe, it, expect } from 'vitest';
import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import {
  coerceStringDomainType,
  simpleCallArgToScalarToken,
  tryBuildEncodedScalarParamFromCall,
  unitFilterStringFromCall,
  inferStringValueTypeWithoutParamDef,
  resolvePresetValueForParamScalar,
} from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-params.js';

// ---------------------------------------------------------------------------
// coerceStringDomainType
// ---------------------------------------------------------------------------

describe('coerceStringDomainType', () => {
  it('upgrades string valueType to soundlink when expected', () => {
    const data: any = { value: 'sound/MySound', valueType: { type: 'string' } };
    coerceStringDomainType(data, 'soundlink');
    expect(data.valueType.type).toBe('soundlink');
  });

  it('upgrades string valueType to filepath', () => {
    const data: any = { value: 'Assets/path.m3', valueType: { type: 'string' } };
    coerceStringDomainType(data, 'filepath');
    expect(data.valueType.type).toBe('filepath');
  });

  it('stores model animation literals as quoted Galaxy expressions for the editor', () => {
    const data: any = { value: 'Talk', valueType: { type: 'string' } };
    coerceStringDomainType(data, 'modelanim');
    expect(data).toEqual({ value: '"Talk"', valueType: { type: 'modelanim' } });
  });

  it('upgrades string valueType to color', () => {
    const data: any = { value: 'Color(255,0,0)', valueType: { type: 'string' } };
    coerceStringDomainType(data, 'color');
    expect(data.valueType.type).toBe('color');
  });

  it('does not change non-string valueType', () => {
    const data: any = { value: '5', valueType: { type: 'int' } };
    coerceStringDomainType(data, 'soundlink');
    expect(data.valueType.type).toBe('int');
  });

  // Editor oracle: an integer in a fixed slot is an int value (ARC2 stores <ValueType Type="int"/>
  // for 30 in a fixed parameter; CameraApplyInfo's velocity -1) and is written without `.0`.
  it('keeps an int value in a fixed slot', () => {
    const data: any = { value: '1', valueType: { type: 'int' } };
    coerceStringDomainType(data, 'fixed');
    expect(data.valueType.type).toBe('int');
  });

  it('does not change type for unrecognised domain', () => {
    const data: any = { value: 'x', valueType: { type: 'string' } };
    coerceStringDomainType(data, 'unknownDomain');
    expect(data.valueType.type).toBe('string');
  });

  it('does nothing when expected is undefined', () => {
    const data: any = { value: 'x', valueType: { type: 'string' } };
    coerceStringDomainType(data, undefined);
    expect(data.valueType.type).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// simpleCallArgToScalarToken
// ---------------------------------------------------------------------------

describe('simpleCallArgToScalarToken', () => {
  const numNode = (v: number) => ({ kind: SyntaxKind.NumericLiteral, text: String(v), value: v });
  const idNode = (name: string) => ({ kind: SyntaxKind.Identifier, name });
  const paren = (expr: any) => ({ kind: SyntaxKind.ParenthesizedExpression, expression: expr });

  it('returns name for an Identifier node', () => {
    expect(simpleCallArgToScalarToken(idNode('c_maxPlayers'))).toBe('c_maxPlayers');
  });

  it('returns text for a NumericLiteral node', () => {
    expect(simpleCallArgToScalarToken(numNode(255))).toBe('255');
  });

  it('returns "-N" for a negated numeric literal', () => {
    const neg = {
      kind: SyntaxKind.PrefixUnaryExpression,
      operator: { kind: SyntaxKind.MinusToken },
      operand: numNode(3),
    };
    expect(simpleCallArgToScalarToken(neg)).toBe('-3');
  });

  it('unwraps parentheses', () => {
    expect(simpleCallArgToScalarToken(paren(numNode(10)))).toBe('10');
  });

  it('returns undefined for complex expressions', () => {
    const binary = {
      kind: SyntaxKind.BinaryExpression,
      left: numNode(1),
      operatorToken: { kind: SyntaxKind.PlusToken },
      right: numNode(2),
    };
    expect(simpleCallArgToScalarToken(binary)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tryBuildEncodedScalarParamFromCall
// ---------------------------------------------------------------------------

describe('tryBuildEncodedScalarParamFromCall', () => {
  const numNode = (v: number) => ({ kind: SyntaxKind.NumericLiteral, text: String(v), value: v });
  const idNode = (name: string) => ({ kind: SyntaxKind.Identifier, name });

  function colorCall(...args: any[]) {
    return {
      kind: SyntaxKind.CallExpression,
      expression: idNode('Color'),
      arguments: args,
    };
  }

  function unitFilterCall(...args: any[]) {
    return {
      kind: SyntaxKind.CallExpression,
      expression: idNode('UnitFilter'),
      arguments: args,
    };
  }

  function namedCall(name: string, ...args: any[]) {
    return {
      kind: SyntaxKind.CallExpression,
      expression: idNode(name),
      arguments: args,
    };
  }

  it('encodes Galaxy RGB percentages as the editor ARGB byte tuple', () => {
    const result = tryBuildEncodedScalarParamFromCall(
      colorCall(numNode(100), numNode(50), numNode(0)),
      'color',
    );
    expect(result).toBeDefined();
    expect(result?.value).toBe('255,255,128,0');
    expect(result?.valueType?.type).toBe('color');
  });

  it('upgrades string valueType to gamelink', () => {
    const data: any = { value: 'PingAlert', valueType: { type: 'string' } };
    coerceStringDomainType(data, 'gamelink');
    expect(data.valueType.type).toBe('gamelink');
  });

  // ARC2 mod: a colour built from variables is not a literal the editor can store.
  it('leaves a colour built from variables to structured expression conversion', () => {
    expect(tryBuildEncodedScalarParamFromCall(colorCall(idNode('lv_r'), idNode('lv_g'), idNode('lv_b')), 'color')).toBeUndefined();
  });

  it('stores ColorWithAlpha in editor ARGB order', () => {
    const result = tryBuildEncodedScalarParamFromCall(
      namedCall('ColorWithAlpha', numNode(100), numNode(0), numNode(50), numNode(25)),
      'color',
    );
    expect(result?.value).toBe('64,255,0,128');
  });

  // Deity Wasp mod: stored as a string, `lv_c == Color(100,100,100)` came back as a
  // comparison against the text "Color(100.00,100.00,100.00)".
  it('leaves a colour to the structured path when the formal is not a colour', () => {
    const result = tryBuildEncodedScalarParamFromCall(
      colorCall(numNode(255), numNode(0), numNode(0)),
      'string',
    );
    expect(result).toBeUndefined();
  });

  it('leaves UnitFilter masks to structured expression conversion', () => {
    const result = tryBuildEncodedScalarParamFromCall(
      unitFilterCall(numNode(0), numNode(0), numNode(0), numNode(0)),
      undefined,
    );
    expect(result).toBeUndefined();
  });

  it('does not infer filter semantics from constant name patterns', () => {
    const shift = (name: string) => ({
      kind: SyntaxKind.BinaryExpression,
      left: numNode(1),
      operatorToken: { kind: SyntaxKind.LessThanLessThanToken },
      right: idNode(name),
    });
    const highShift = (name: string) => ({
      kind: SyntaxKind.BinaryExpression,
      left: numNode(1),
      operatorToken: { kind: SyntaxKind.LessThanLessThanToken },
      right: {
        kind: SyntaxKind.BinaryExpression,
        left: idNode(name),
        operatorToken: { kind: SyntaxKind.MinusToken },
        right: numNode(32),
      },
    });
    const orExpr = (left: any, right: any) => ({
      kind: SyntaxKind.BinaryExpression,
      left,
      operatorToken: { kind: SyntaxKind.BarToken },
      right,
    });

    const result = tryBuildEncodedScalarParamFromCall(
      unitFilterCall(
        numNode(0),
        numNode(0),
        shift('c_targetFilterMissile'),
        orExpr(highShift('c_targetFilterDead'), highShift('c_targetFilterHidden')),
      ),
      'unitfilter',
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined for non-Color/UnitFilter calls', () => {
    const call = {
      kind: SyntaxKind.CallExpression,
      expression: idNode('Wait'),
      arguments: [numNode(1)],
    };
    expect(tryBuildEncodedScalarParamFromCall(call, undefined)).toBeUndefined();
  });

  it('builds typed object refs from *FromId calls', () => {
    const result = tryBuildEncodedScalarParamFromCall(namedCall('RegionFromId', numNode(57)), 'region');
    expect(result).toEqual({ valueId: '57', valueType: { type: 'region' } });
    expect(tryBuildEncodedScalarParamFromCall(namedCall('RegionFromId', numNode(57)), 'point')).toBeUndefined();
  });

  it('stores UnitFromId as the editor object ValueId', () => {
    expect(tryBuildEncodedScalarParamFromCall(namedCall('UnitFromId', numNode(384)), 'unit'))
      .toEqual({ valueId: '384', valueType: { type: 'unit' } });
  });

  it('uses the constructor type rather than a sameas placeholder beside an object ValueId', () => {
    expect(tryBuildEncodedScalarParamFromCall(namedCall('UnitFromId', numNode(657494806)), 'sameas'))
      .toEqual({ valueId: '657494806', valueType: { type: 'unit' } });
    expect(tryBuildEncodedScalarParamFromCall(namedCall('RegionFromId', numNode(4)), 'sameasparent'))
      .toEqual({ valueId: '4', valueType: { type: 'region' } });
  });


  it('keeps the consuming unit contract for UnitRefFromUnit(UnitFromId(...))', () => {
    const result = tryBuildEncodedScalarParamFromCall(
      namedCall('UnitRefFromUnit', namedCall('UnitFromId', numNode(384))),
      'unit',
    );
    expect(result).toEqual({ valueId: '384', valueType: { type: 'unit' } });
  });

  // Ice Baneling: the callee came from a missing mod, so the value filled a template
  // slot, and a `unitref` ValueId there could not be generated again.
  it.each(['unitref', 'any'])('keeps UnitRefFromUnit(UnitFromId(...)) as a call for a %s formal', expected => {
    const result = tryBuildEncodedScalarParamFromCall(
      namedCall('UnitRefFromUnit', namedCall('UnitFromId', numNode(948700082))),
      expected,
    );
    expect(result).toBeUndefined();
  });

  it('keeps UnitRefFromVariable as authored unit-reference expression text', () => {
    const result = tryBuildEncodedScalarParamFromCall(
      namedCall('UnitRefFromVariable', { kind: SyntaxKind.StringLiteral, value: 'gv_units[0]' }),
      'unit',
    );
    expect(result).toEqual({ value: 'gv_units[0]', valueType: { type: 'unitref' } });
  });

  it('returns undefined when a Color argument is a complex expression', () => {
    const binary = {
      kind: SyntaxKind.BinaryExpression,
      left: numNode(1),
      operatorToken: { kind: SyntaxKind.PlusToken },
      right: numNode(2),
    };
    expect(tryBuildEncodedScalarParamFromCall(colorCall(binary), undefined)).toBeUndefined();
  });

  it('returns undefined for non-call expressions', () => {
    expect(tryBuildEncodedScalarParamFromCall(idNode('x'), undefined)).toBeUndefined();
    expect(tryBuildEncodedScalarParamFromCall(null, undefined)).toBeUndefined();
  });
});

describe('unitFilterStringFromCall', () => {
  const numNode = (v: number) => ({ kind: SyntaxKind.NumericLiteral, text: String(v), value: v });
  const idNode = (name: string) => ({ kind: SyntaxKind.Identifier, name });
  const shift = (flag: string) => ({
    kind: SyntaxKind.BinaryExpression,
    left: numNode(1),
    operatorToken: { kind: SyntaxKind.LessThanLessThanToken },
    right: idNode(flag),
  });
  const highShift = (flag: string) => ({
    kind: SyntaxKind.BinaryExpression,
    left: numNode(1),
    operatorToken: { kind: SyntaxKind.LessThanLessThanToken },
    right: {
      kind: SyntaxKind.BinaryExpression,
      left: idNode(flag),
      operatorToken: { kind: SyntaxKind.MinusToken },
      right: numNode(32),
    },
  });

  it('uses resolved preset definitions rather than a numeric filter table', () => {
    const call = {
      kind: SyntaxKind.CallExpression,
      expression: idNode('UnitFilter'),
      arguments: [numNode(0), numNode(0), shift('targetFilterHeroic'), highShift('targetFilterDead')],
    };
    const names = new Map([['targetFilterHeroic', 'Heroic'], ['targetFilterDead', 'Dead']]);
    expect(unitFilterStringFromCall(call, identifier => names.get(identifier))).toBe('-;Heroic,Dead');
  });
});

describe('resolvePresetValueForParamScalar', () => {
  it('resolves named scalar choices from a non-native dependency library', () => {
    const dependency: any = {
      id: 'UI', items: [], elementsByType: {},
      elements: {
        Param: { type: 'ParamDef', id: 'Param', library: 'UI', paramType: { type: 'bool' }, preset: { type: 'Preset', id: 'Choice', library: 'UI' } },
        Choice: { type: 'Preset', id: 'Choice', library: 'UI', values: [{ type: 'PresetValue', id: 'Hide', library: 'UI' }] },
        Hide: { type: 'PresetValue', id: 'Hide', library: 'UI', value: 'false' },
      },
    };
    const ctx: any = { libId: 'TEST', elements: {}, dependencyLibraries: new Map([['UI', dependency]]) };
    expect(resolvePresetValueForParamScalar({ type: 'ParamDef', id: 'Param', library: 'UI' }, 'false', ctx))
      .toEqual({ type: 'PresetValue', id: 'Hide', library: 'UI' });
  });
});

// ---------------------------------------------------------------------------
// inferStringValueTypeWithoutParamDef
// ---------------------------------------------------------------------------

describe('inferStringValueTypeWithoutParamDef', () => {
  it('returns "filepath" for Assets\\ paths', () => {
    expect(inferStringValueTypeWithoutParamDef('Assets\\Textures\\foo.dds')).toBe('filepath');
  });

  it('returns "filepath" for Windows absolute paths', () => {
    expect(inferStringValueTypeWithoutParamDef('C:\\SC2\\Assets\\foo.m3')).toBe('filepath');
  });

  it('returns "filepath" for paths with backslash and extension', () => {
    expect(inferStringValueTypeWithoutParamDef('Models\\hero\\unit.m3')).toBe('filepath');
  });

  it('returns undefined for plain strings', () => {
    expect(inferStringValueTypeWithoutParamDef('Hello World')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(inferStringValueTypeWithoutParamDef('')).toBeUndefined();
  });

  it('returns undefined for strings without a file extension', () => {
    expect(inferStringValueTypeWithoutParamDef('Assets\\NoExtension')).toBeUndefined();
  });
});
