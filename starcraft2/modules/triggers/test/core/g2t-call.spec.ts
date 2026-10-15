import { describe, expect, it } from 'vitest';
import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import { collectArithmeticOperands, exprToParamData, exprToParamRef, logicalExprToConditionFCRef } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-call.js';
import { structureMemberKey } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-core.js';
import { buildFuncNameToFuncDefMap } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-core.js';
import { structuredNode, structuredParam } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-structured.js';
import { parseGalaxySource } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/galaxy-to-trigger.js';

function minimalCtx(nativeLibrary: any): any {
  return {
    libId: 'TEST',
    elements: {},
    nativeLibrary,
    funcNameToFuncDef: buildFuncNameToFuncDefMap(nativeLibrary),
    roleToSubFuncType: new Map(),
    localVarByGalaxyName: new Map(),
    globalVarByGalaxyName: new Map(),
    pendingAutoInits: new Map(),
    pendingAutoEnds: new Map(),
    pendingAutoIncrements: new Map(),
    galaxyConstToPreset: new Map(),
  };
}

describe('exprToParamData', () => {
  it('restores a localized StringExternal key as the Param identity', () => {
    const nativeLibrary: any = { id: 'Ntve', elementsByType: { ParamDef: {
      TEXT: { type: 'ParamDef', id: 'TEXT', library: 'Ntve', paramType: { type: 'text' } },
    }, FunctionDef: {} } };
    const ctx = minimalCtx(nativeLibrary);
    const ref = exprToParamRef({
      kind: SyntaxKind.CallExpression,
      expression: { kind: SyntaxKind.Identifier, name: 'StringExternal' },
      arguments: [{ kind: SyntaxKind.StringLiteral, value: 'Param/Value/lib_Arbitrary_12Ab34cD' }],
    }, ctx, { type: 'ParamDef', library: 'Ntve', id: 'TEXT' });
    expect(ref.id).toBe('12AB34CD');
    expect(ctx.elements[ref.id]).toMatchObject({ parameterDef: { id: 'TEXT' }, valueType: { type: 'text' } });
    expect((ctx.elements[ref.id] as any).functionCall).toBeUndefined();
  });

  // EditorTest CAI2 loops over libCCUI_gv_productionUnits[lp_player][1] of a library that was not loaded:
  // the indices sat beside a text value and compiled back as libCCUI_gv_productionUnits.
  it('keeps an indexed access with an unresolved root whole instead of dropping its indices', () => {
    const sourceText = 'void f() { g = libZZ_gv_units[lp_player][1]; }';
    const assignment = (parseGalaxySource(sourceText).statements[0] as any).body.statements[0].expression;
    const ctx = { ...minimalCtx({ id: 'Ntve', elementsByType: {} }), sourceText };
    const ref = exprToParamRef(assignment.right, ctx);
    expect(ctx.elements[ref.id]).toMatchObject({ value: 'libZZ_gv_units[lp_player][1]' });
    expect((ctx.elements[ref.id] as any).array).toBeUndefined();
  });

  it('keeps every member in a nested structure access path', () => {
    const ctx = minimalCtx({ id: 'Ntve', elementsByType: {} });
    Object.assign(ctx.elements, {
      ROOT: { type: 'Variable', id: 'ROOT', library: 'TEST', variableType: { type: 'struct', typeElement: { type: 'Structure', library: 'TEST', id: 'PLAYER' } } },
      HAND: { type: 'Variable', id: 'HAND', library: 'TEST', name: 'lv_hand', variableType: { type: 'struct', typeElement: { type: 'Structure', library: 'TEST', id: 'HAND_STRUCT' } } },
      CARD: { type: 'Variable', id: 'CARD', library: 'TEST', name: 'lv_card', variableType: { type: 'int' } },
    });
    ctx.globalVarByGalaxyName.set('player', { library: 'TEST', id: 'ROOT' });
    ctx.structureMemberByKey = new Map([
      [structureMemberKey('PLAYER', 'lv_hand'), { type: 'Variable', library: 'TEST', id: 'HAND' }],
      [structureMemberKey('HAND_STRUCT', 'lv_card'), { type: 'Variable', library: 'TEST', id: 'CARD' }],
    ]);
    const property = (expression: any, name: string) => ({ kind: SyntaxKind.PropertyAccessExpression, expression, name: { kind: SyntaxKind.Identifier, name } });
    const data = exprToParamData(property(property({ kind: SyntaxKind.Identifier, name: 'player' }, 'lv_hand'), 'lv_card'), ctx);
    expect(data.variable?.id).toBe('ROOT');
    const first = ctx.elements[data.structMember!.id] as any;
    expect(first.variable.id).toBe('HAND');
    expect((ctx.elements[first.structMember.id] as any).variable.id).toBe('CARD');
  });

  it('attaches an array index to the innermost structure member', () => {
    const ctx = minimalCtx({ id: 'Ntve', elementsByType: {} });
    Object.assign(ctx.elements, {
      ROOT: { type: 'Variable', id: 'ROOT', library: 'TEST', variableType: { type: 'struct', typeElement: { type: 'Structure', library: 'TEST', id: 'PLAYER' } } },
      HAND: { type: 'Variable', id: 'HAND', library: 'TEST', name: 'lv_hand', variableType: { type: 'struct', typeElement: { type: 'Structure', library: 'TEST', id: 'HAND_STRUCT' } } },
      CARD: { type: 'Variable', id: 'CARD', library: 'TEST', name: 'lv_card', variableType: { type: 'int' } },
    });
    ctx.globalVarByGalaxyName.set('player', { library: 'TEST', id: 'ROOT' });
    ctx.localVarByGalaxyName.set('index', { library: 'TEST', id: 'INDEX' });
    ctx.elements.INDEX = { type: 'Variable', id: 'INDEX', library: 'TEST', name: 'index', variableType: { type: 'int' } };
    ctx.structureMemberByKey = new Map([
      [structureMemberKey('PLAYER', 'lv_hand'), { type: 'Variable', library: 'TEST', id: 'HAND' }],
      [structureMemberKey('HAND_STRUCT', 'lv_card'), { type: 'Variable', library: 'TEST', id: 'CARD' }],
    ]);
    const identifier = (name: string) => ({ kind: SyntaxKind.Identifier, name });
    const property = (expression: any, name: string) => ({ kind: SyntaxKind.PropertyAccessExpression, expression, name: identifier(name) });
    const data = exprToParamData({
      kind: SyntaxKind.ElementAccessExpression,
      expression: property(property(identifier('player'), 'lv_hand'), 'lv_card'),
      argumentExpression: identifier('index'),
    }, ctx);
    const hand = ctx.elements[data.structMember!.id] as any;
    const card = ctx.elements[hand.structMember.id] as any;
    expect(hand.array).toBeUndefined();
    expect(card.array).toMatchObject({ type: 'Param' });
    expect((ctx.elements[card.array.id] as any).variable.id).toMatchObject({ id: 'INDEX' });
  });

  it('encodes a bitwise preset expression as ordered ValuePreset selections', () => {
    const nativeLibrary: any = {
      id: 'Ntve',
      elements: {},
      elementsByType: {
        ParamDef: {
          FLAGS: { type: 'ParamDef', id: 'FLAGS', library: 'Ntve', paramType: { type: 'preset', typeElement: { type: 'Preset', library: 'Ntve', id: 'BITS' } } },
        },
        Preset: {
          BITS: { type: 'Preset', id: 'BITS', library: 'Ntve', baseType: 'int', asBits: true, values: [
            { type: 'PresetValue', library: 'Ntve', id: 'FIRST' },
            { type: 'PresetValue', library: 'Ntve', id: 'SECOND' },
          ] },
        },
        PresetValue: {
          FIRST: { type: 'PresetValue', id: 'FIRST', library: 'Ntve', value: 'c_first' },
          SECOND: { type: 'PresetValue', id: 'SECOND', library: 'Ntve', value: 'c_second' },
        },
      },
    };
    nativeLibrary.elements = { ...nativeLibrary.elementsByType.ParamDef, ...nativeLibrary.elementsByType.Preset, ...nativeLibrary.elementsByType.PresetValue };
    const ctx = minimalCtx(nativeLibrary);
    ctx.galaxyConstToPreset.set('c_first', { type: 'PresetValue', library: 'Ntve', id: 'FIRST' });
    ctx.galaxyConstToPreset.set('c_second', { type: 'PresetValue', library: 'Ntve', id: 'SECOND' });
    const ref = exprToParamRef({
      kind: SyntaxKind.BinaryExpression,
      left: { kind: SyntaxKind.Identifier, name: 'c_first' },
      operatorToken: { kind: SyntaxKind.BarToken },
      right: { kind: SyntaxKind.Identifier, name: 'c_second' },
    }, ctx, { type: 'ParamDef', library: 'Ntve', id: 'FLAGS' });
    expect(ctx.elements[ref.id]).toMatchObject({
      valueType: { type: 'preset' },
      valueElement: { type: 'Preset', library: 'Ntve', id: 'BITS' },
      valuePresets: [
        { type: 'PresetValue', library: 'Ntve', id: 'FIRST' },
        { type: 'PresetValue', library: 'Ntve', id: 'SECOND' },
      ],
    });

    const structuredRef = structuredParam({
      kind: SyntaxKind.BinaryExpression,
      left: { kind: SyntaxKind.Identifier, name: 'c_first' },
      operatorToken: { kind: SyntaxKind.BarToken },
      right: { kind: SyntaxKind.Identifier, name: 'c_second' },
    }, ctx, { type: 'ParamDef', library: 'Ntve', id: 'FLAGS' });
    expect(ctx.elements[structuredRef.id]).toMatchObject({
      valueType: { type: 'preset' },
      valueElement: { type: 'Preset', library: 'Ntve', id: 'BITS' },
      valuePresets: [
        { type: 'PresetValue', library: 'Ntve', id: 'FIRST' },
        { type: 'PresetValue', library: 'Ntve', id: 'SECOND' },
      ],
    });
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'Binary Expression')).toBe(false);
  });

  it('uses native Comparison for a boolean array reference in a condition role', () => {
    const nativeLibrary: any = {
      id: 'Ntve', elements: {}, elementsByType: {
        FunctionDef: {
          COMPARE: { type: 'FunctionDef', id: 'COMPARE', library: 'Ntve', name: 'Comparison', flags: ['Operator'], returnType: { type: 'bool' }, parameters: [
            { type: 'ParamDef', library: 'Ntve', id: 'LEFT' },
            { type: 'ParamDef', library: 'Ntve', id: 'OP' },
            { type: 'ParamDef', library: 'Ntve', id: 'RIGHT' },
          ] },
        },
        ParamDef: {
          LEFT: { type: 'ParamDef', id: 'LEFT', library: 'Ntve', paramType: { type: 'anycompare' } },
          OP: { type: 'ParamDef', id: 'OP', library: 'Ntve', paramType: { type: 'preset', typeElement: { type: 'Preset', library: 'Ntve', id: 'OPS' } } },
          RIGHT: { type: 'ParamDef', id: 'RIGHT', library: 'Ntve', paramType: { type: 'sameas' } },
        },
        Preset: {
          OPS: { type: 'Preset', id: 'OPS', library: 'Ntve', baseType: 'string', values: [{ type: 'PresetValue', library: 'Ntve', id: 'EQ' }] },
        },
        PresetValue: {
          EQ: { type: 'PresetValue', id: 'EQ', library: 'Ntve', value: '==' },
        },
      },
    };
    nativeLibrary.elements = Object.assign({}, ...Object.values(nativeLibrary.elementsByType).map((group: any) => group));
    const ctx = minimalCtx(nativeLibrary);
    ctx.dependencyLibraries = new Map();
    ctx.elements.ROOT = { type: 'Variable', id: 'ROOT', library: 'TEST', name: 'flags', variableType: { type: 'bool' }, isArray: true };
    ctx.globalVarByGalaxyName.set('flags', { library: 'TEST', id: 'ROOT' });
    const ref = structuredNode({
      kind: SyntaxKind.ElementAccessExpression,
      expression: { kind: SyntaxKind.Identifier, name: 'flags' },
      argumentExpression: { kind: SyntaxKind.NumericLiteral, text: '1', value: '1' },
    }, true, ctx, { type: 'SubFuncType', library: 'Ntve', id: 'COND' });
    const call: any = ctx.elements[ref.id];
    expect(call.functionDef).toEqual({ type: 'FunctionDef', library: 'Ntve', id: 'COMPARE' });
    expect(call.subFunctionType).toEqual({ type: 'SubFuncType', library: 'Ntve', id: 'COND' });
    expect(Object.values(ctx.elements).filter((element: any) => element.type === 'FunctionDef')).toEqual([]);
  });

  it('prefers the parameter-shaped native Not for a variable assignment value', () => {
    const nativeLibrary: any = {
      id: 'Ntve', elements: {}, elementsByType: {
        FunctionDef: {
          CONDITION_NOT: {
            type: 'FunctionDef', id: 'CONDITION_NOT', library: 'Ntve', name: 'Not', flags: ['Condition', 'SubFunctions'],
            returnType: { type: 'bool' }, subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'COND' }],
            scriptCode: '(!( #SUBFUNCS(cond," || ") ))',
          },
          PARAM_NOT: {
            type: 'FunctionDef', id: 'PARAM_NOT', library: 'Ntve', name: 'AndOrMult2', flags: ['Call', 'Operator'],
            returnType: { type: 'bool' }, parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'VALUE' }],
            scriptCode: '!(#PARAM(value))',
          },
        },
        ParamDef: {
          VALUE: { type: 'ParamDef', id: 'VALUE', library: 'Ntve', name: 'value', paramType: { type: 'bool' } },
          TARGET: { type: 'ParamDef', id: 'TARGET', library: 'Ntve', name: 'value', paramType: { type: 'bool' } },
        },
        SubFuncType: {
          COND: { type: 'SubFuncType', id: 'COND', library: 'Ntve', name: 'cond', flags: ['Condition'] },
        },
      },
    };
    nativeLibrary.elements = Object.assign({}, ...Object.values(nativeLibrary.elementsByType).map((group: any) => group));
    const ctx = minimalCtx(nativeLibrary);
    ctx.dependencyLibraries = new Map();
    ctx.elements.FLAG = { type: 'Variable', id: 'FLAG', library: 'TEST', name: 'flag', variableType: { type: 'bool' } };
    ctx.localVarByGalaxyName.set('flag', 'FLAG');

    const ref = structuredParam({
      kind: SyntaxKind.PrefixUnaryExpression,
      operator: { kind: SyntaxKind.ExclamationToken },
      operand: { kind: SyntaxKind.Identifier, name: 'flag' },
    }, ctx, { type: 'ParamDef', library: 'Ntve', id: 'TARGET' });
    const outer: any = ctx.elements[ref.id];
    const notCall: any = ctx.elements[outer.functionCall.id];
    expect(notCall.functionDef).toEqual({ type: 'FunctionDef', library: 'Ntve', id: 'PARAM_NOT' });
    expect(notCall.subFunctions).toHaveLength(0);
    const operand: any = ctx.elements[notCall.parameters[0].id];
    expect(operand).toMatchObject({ parameterDef: { id: 'VALUE' }, variable: { id: 'FLAG' } });
  });

  it('uses loaded arithmetic for unary minus instead of a synthesized Prefix Unary Expression', () => {
    const nativeLibrary: any = {
      id: 'Ntve', elements: {}, elementsByType: {
        FunctionDef: {
          ARITHMETIC: { type: 'FunctionDef', id: 'ARITHMETIC', library: 'Ntve', name: 'ArithmeticReal', flags: ['Call', 'Operator'],
            returnType: { type: 'fixed' }, parameters: [
              { type: 'ParamDef', library: 'Ntve', id: 'LEFT' },
              { type: 'ParamDef', library: 'Ntve', id: 'OP' },
              { type: 'ParamDef', library: 'Ntve', id: 'RIGHT' },
            ] },
        },
        ParamDef: {
          LEFT: { type: 'ParamDef', id: 'LEFT', library: 'Ntve', paramType: { type: 'fixed' } },
          OP: { type: 'ParamDef', id: 'OP', library: 'Ntve', paramType: { type: 'preset' } },
          RIGHT: { type: 'ParamDef', id: 'RIGHT', library: 'Ntve', paramType: { type: 'fixed' } },
          TARGET: { type: 'ParamDef', id: 'TARGET', library: 'Ntve', paramType: { type: 'fixed' } },
        },
      },
    };
    nativeLibrary.elements = { ...nativeLibrary.elementsByType.ParamDef, ...nativeLibrary.elementsByType.FunctionDef };
    const ctx = minimalCtx(nativeLibrary);
    ctx.elements.SINE = { type: 'Variable', id: 'SINE', library: 'TEST', name: 'sina', variableType: { type: 'fixed' } };
    ctx.localVarByGalaxyName.set('lv_sina', 'SINE');

    const ref = structuredParam({
      kind: SyntaxKind.PrefixUnaryExpression,
      operator: { kind: SyntaxKind.MinusToken },
      operand: { kind: SyntaxKind.Identifier, name: 'lv_sina' },
    }, ctx, { type: 'ParamDef', library: 'Ntve', id: 'TARGET' });
    const outer: any = ctx.elements[ref.id];
    const arithmetic: any = ctx.elements[outer.functionCall.id];
    expect(arithmetic.functionDef.id).toBe('ARITHMETIC');
    expect(ctx.elements[arithmetic.parameters[0].id]).toMatchObject({ value: '0.0', valueType: { type: 'fixed' } });
    expect(ctx.elements[arithmetic.parameters[2].id]).toMatchObject({ variable: { id: 'SINE' } });
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'Prefix Unary Expression')).toBe(false);
  });

  it('decodes UnitRefFromVariable into the editor reference parameter path', () => {
    const nativeLibrary: any = {
      id: 'Ntve', elements: {}, elementsByType: {
        ParamDef: {
          UNIT_REF: { type: 'ParamDef', id: 'UNIT_REF', library: 'Ntve', name: 'u', isReference: true, paramType: { type: 'unit' } },
        },
      },
    };
    nativeLibrary.elements = { ...nativeLibrary.elementsByType.ParamDef };
    const ctx = minimalCtx(nativeLibrary);
    ctx.elements.KEYSTONES = { type: 'Variable', id: 'KEYSTONES', library: 'TEST', name: 'keystones', isArray: true, variableType: { type: 'unit' } };
    ctx.globalVarByGalaxyName.set('gv_keystones', { library: 'TEST', id: 'KEYSTONES' });

    const ref = structuredParam({
      kind: SyntaxKind.CallExpression,
      expression: { kind: SyntaxKind.Identifier, name: 'UnitRefFromVariable' },
      arguments: [{ kind: SyntaxKind.StringLiteral, value: 'gv_keystones[1]' }],
    }, ctx, { type: 'ParamDef', library: 'Ntve', id: 'UNIT_REF' });
    const param: any = ctx.elements[ref.id];
    expect(param).toMatchObject({
      parameterDef: { id: 'UNIT_REF' },
      variable: { id: 'KEYSTONES' },
      array: [{ type: 'Param' }],
    });
    expect(param.value).toBeUndefined();
    expect(param.valueType).toBeUndefined();
    expect(ctx.elements[param.array[0].id]).toMatchObject({ value: '1', valueType: { type: 'int' } });
  });

  it('uses the And FunctionDef-owned cond role for every operand', () => {
    const nativeLibrary: any = {
      id: 'Ntve',
      subFuncTypeNames: { 'Ntve_COND': 'cond', 'Ntve_IF': 'Conditions' },
      elementsByType: {
        SubFuncType: {
          COND: { type: 'SubFuncType', id: 'COND', library: 'Ntve', identifier: 'cond' },
          IF: { type: 'SubFuncType', id: 'IF', library: 'Ntve', identifier: 'Conditions' },
        },
        FunctionDef: {
          AND: { type: 'FunctionDef', id: 'AND', library: 'Ntve', name: 'And', subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'COND' }] },
          LEFT: { type: 'FunctionDef', id: 'LEFT', library: 'Ntve', name: 'Left', parameters: [] },
          RIGHT: { type: 'FunctionDef', id: 'RIGHT', library: 'Ntve', name: 'Right', parameters: [] },
        },
      },
    };
    const ctx = minimalCtx(nativeLibrary);
    ctx.roleToSubFuncType = new Map([['Conditions', { type: 'SubFuncType', library: 'Ntve', id: 'IF' }]]);
    const call = (name: string) => ({ kind: SyntaxKind.CallExpression, expression: { kind: SyntaxKind.Identifier, name }, arguments: [] });
    const ref = logicalExprToConditionFCRef({
      kind: SyntaxKind.BinaryExpression,
      left: call('Left'), operatorToken: { kind: SyntaxKind.AmpersandAmpersandToken }, right: call('Right'),
    }, { library: 'Ntve', id: 'IF' }, ctx)!;
    const outer = ctx.elements[ref.id] as any;
    expect(outer.functionDef.id).toBe('AND');
    expect(outer.subFunctionType.id).toBe('IF');
    expect(outer.subFunctions).toHaveLength(2);
    for (const childRef of outer.subFunctions) {
      expect((ctx.elements[childRef.id] as any).subFunctionType).toEqual({ type: 'SubFuncType', library: 'Ntve', id: 'COND' });
    }
  });

  it('stores UnitFilter as a preset-resolved scalar inside conditions', () => {
    const nativeLibrary: any = {
      id: 'Ntve',
      elementsByType: {
        ParamDef: {
          FILTER: { type: 'ParamDef', id: 'FILTER', library: 'Ntve', paramType: { type: 'unitfilter' } },
        },
        PresetValue: {
          HEROIC: { type: 'PresetValue', id: 'HEROIC', library: 'Ntve', identifier: 'Heroic', value: 'c_targetFilterHeroic' },
          DEAD: { type: 'PresetValue', id: 'DEAD', library: 'Ntve', identifier: 'Dead', value: 'c_targetFilterDead' },
        },
      },
    };
    const ctx = minimalCtx(nativeLibrary);
    ctx.galaxyConstToPreset.set('c_targetFilterHeroic', { type: 'PresetValue', library: 'Ntve', id: 'HEROIC' });
    ctx.galaxyConstToPreset.set('c_targetFilterDead', { type: 'PresetValue', library: 'Ntve', id: 'DEAD' });
    const number = (value: number) => ({ kind: SyntaxKind.NumericLiteral, text: String(value), value });
    const shift = (name: string, high = false) => ({
      kind: SyntaxKind.BinaryExpression,
      left: number(1), operatorToken: { kind: SyntaxKind.LessThanLessThanToken },
      right: high ? { kind: SyntaxKind.BinaryExpression, left: { kind: SyntaxKind.Identifier, name }, operatorToken: { kind: SyntaxKind.MinusToken }, right: number(32) } : { kind: SyntaxKind.Identifier, name },
    });
    const ref = exprToParamRef({
      kind: SyntaxKind.CallExpression, expression: { kind: SyntaxKind.Identifier, name: 'UnitFilter' },
      arguments: [number(0), number(0), shift('c_targetFilterHeroic'), shift('c_targetFilterDead', true)],
    }, ctx, { type: 'ParamDef', library: 'Ntve', id: 'FILTER' });
    expect(ctx.elements[ref.id]).toMatchObject({ value: '-;Heroic,Dead', valueType: { type: 'unitfilter' } });
    expect((ctx.elements[ref.id] as any).functionCall).toBeUndefined();
  });

  it('stores null as an explicit token so SC2 Editor does not compile a blank operand', () => {
    const data = exprToParamData({ kind: SyntaxKind.NullKeyword }, {} as any);

    expect(data).toEqual({ value: 'null' });
  });

  it('selects the NativeLib overload whose return type matches the target ParamDef', () => {
    const nativeLibrary = {
      id: 'Ntve',
      elementsByType: {
        FunctionDef: {
          TEXT_FUNC: {
            type: 'FunctionDef',
            id: 'TEXT_FUNC',
            library: 'Ntve',
            name: 'StringToText',
            returnType: { type: 'text' },
            parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'TEXT_ARG' }],
          },
          ACTOR_FUNC: {
            type: 'FunctionDef',
            id: 'ACTOR_FUNC',
            library: 'Ntve',
            name: 'StringToText',
            returnType: { type: 'actormsg' },
            parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'ACTOR_ARG' }],
          },
        },
        ParamDef: {
          TARGET_TEXT: {
            type: 'ParamDef',
            id: 'TARGET_TEXT',
            library: 'Ntve',
            name: 'tooltip',
            paramType: { type: 'text' },
          },
          TEXT_ARG: {
            type: 'ParamDef',
            id: 'TEXT_ARG',
            library: 'Ntve',
            name: 'value',
            paramType: { type: 'string' },
          },
          ACTOR_ARG: {
            type: 'ParamDef',
            id: 'ACTOR_ARG',
            library: 'Ntve',
            name: 'value',
            paramType: { type: 'string' },
          },
        },
      },
    };
    const ctx = minimalCtx(nativeLibrary);
    expect(ctx.funcNameToFuncDef.get('StringToText')?.id).toBe('ACTOR_FUNC');

    const paramRef = exprToParamRef(
      {
        kind: SyntaxKind.CallExpression,
        expression: { kind: SyntaxKind.Identifier, name: 'StringToText' },
        arguments: [{ kind: SyntaxKind.StringLiteral, value: '' }],
      },
      ctx,
      { type: 'ParamDef', library: 'Ntve', id: 'TARGET_TEXT' },
    );

    const param = ctx.elements[paramRef.id];
    const call = ctx.elements[param.functionCall.id];
    const arg = ctx.elements[call.parameters[0].id];
    expect(call.functionDef.id).toBe('TEXT_FUNC');
    expect(arg.parameterDef.id).toBe('TEXT_ARG');
  });

  it('encodes text + chains as text combine operators instead of numeric arithmetic', () => {
    const nativeLibrary = {
      id: 'Ntve',
      elementsByType: {
        FunctionDef: {
          TEXT_FUNC: {
            type: 'FunctionDef',
            id: 'TEXT_FUNC',
            library: 'Ntve',
            name: 'StringToText',
            returnType: { type: 'text' },
            parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'TEXT_ARG' }],
          },
          ACTOR_FUNC: {
            type: 'FunctionDef',
            id: 'ACTOR_FUNC',
            library: 'Ntve',
            name: 'StringToText',
            returnType: { type: 'actormsg' },
            parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'ACTOR_ARG' }],
          },
          COMBINE_TEXT_MULT: {
            type: 'FunctionDef',
            id: 'COMBINE_TEXT_MULT',
            library: 'Ntve',
            name: 'CombineTextMultiple',
            returnType: { type: 'text' },
            isFuncCall: true,
            flags: ['Operator'],
            parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'IN_TEXT' }],
          },
          ARITH_INT_MULT: {
            type: 'FunctionDef',
            id: 'ARITH_INT_MULT',
            library: 'Ntve',
            name: 'ArithmeticIntMult',
            returnType: { type: 'int' },
            isFuncCall: true,
            flags: ['Operator'],
            parameters: [],
          },
        },
        ParamDef: {
          TARGET_TEXT: {
            type: 'ParamDef',
            id: 'TARGET_TEXT',
            library: 'Ntve',
            name: 'tooltip',
            paramType: { type: 'text' },
          },
          IN_TEXT: {
            type: 'ParamDef',
            id: 'IN_TEXT',
            library: 'Ntve',
            name: 'inText',
            paramType: { type: 'text' },
          },
          TEXT_ARG: {
            type: 'ParamDef',
            id: 'TEXT_ARG',
            library: 'Ntve',
            name: 'value',
            paramType: { type: 'string' },
          },
          ACTOR_ARG: {
            type: 'ParamDef',
            id: 'ACTOR_ARG',
            library: 'Ntve',
            name: 'value',
            paramType: { type: 'string' },
          },
        },
      },
    };
    const ctx = minimalCtx(nativeLibrary);
    const plus = SyntaxKind.PlusToken;
    const expr = {
      kind: SyntaxKind.BinaryExpression,
      left: {
        kind: SyntaxKind.BinaryExpression,
        left: { kind: SyntaxKind.StringLiteral, value: 'a' },
        operatorToken: { kind: plus },
        right: { kind: SyntaxKind.StringLiteral, value: 'b' },
      },
      operatorToken: { kind: plus },
      right: { kind: SyntaxKind.StringLiteral, value: 'c' },
    };

    const paramRef = exprToParamRef(
      expr,
      ctx,
      { type: 'ParamDef', library: 'Ntve', id: 'TARGET_TEXT' },
    );

    const param = ctx.elements[paramRef.id] as any;
    const call = ctx.elements[param.functionCall.id] as any;
    expect(call.functionDef.id).toBe('COMBINE_TEXT_MULT');
    expect(call.functionDef.id).not.toBe('ARITH_INT_MULT');
    expect(call.parameters).toHaveLength(3);
    for (const operandRef of call.parameters) {
      const operandParam = ctx.elements[operandRef.id] as any;
      expect(operandParam.parameterDef.id).toBe('IN_TEXT');
      const stringToText = ctx.elements[operandParam.functionCall.id] as any;
      expect(stringToText.functionDef.id).toBe('TEXT_FUNC');
      expect(stringToText.functionDef.id).not.toBe('ACTOR_FUNC');
    }
  });

  // Editor oracle (-old-red-data LibRED3): `(angle-(facing - 360.0))` came back as
  // `(angle - facing - 360.0)`. The editor writes each arithmetic and Combine Strings
  // call in parentheses of its own, so a parenthesized operand is a call of its own.
  it('keeps a parenthesized operand of an operator chain as one operand', () => {
    const statement: any = parseGalaxySource('void f () { x = (angle-(facing - 360.0)) + ("S" + (t + " " + u) + "}"); }').statements[0];
    const assignment = statement.body.statements[0].expression.right;
    const sum: any[] = [];
    collectArithmeticOperands(assignment, SyntaxKind.PlusToken, sum);
    expect(sum).toHaveLength(2);
    const difference: any[] = [];
    collectArithmeticOperands(sum[0], SyntaxKind.MinusToken, difference);
    expect(difference.map(operand => operand.kind)).toEqual([SyntaxKind.Identifier, SyntaxKind.ParenthesizedExpression]);
    const strings: any[] = [];
    collectArithmeticOperands(sum[1], SyntaxKind.PlusToken, strings);
    expect(strings.map(operand => operand.kind)).toEqual([SyntaxKind.StringLiteral, SyntaxKind.ParenthesizedExpression, SyntaxKind.StringLiteral]);
    const chain: any[] = [];
    collectArithmeticOperands(parseGalaxySource('void f () { x = a - b - c; }').statements[0].body.statements[0].expression.right, SyntaxKind.MinusToken, chain);
    expect(chain.map(operand => operand.name)).toEqual(['a', 'b', 'c']);
  });

  it('uses the declared Galaxy ABI to recover concatenation for a string-backed editor domain', () => {
    const nativeLibrary = {
      id: 'Ntve',
      elementsByType: {
        FunctionDef: {
          COMBINE_STRING_MULT: {
            type: 'FunctionDef', id: 'COMBINE_STRING_MULT', library: 'Ntve',
            name: 'CombineStringsMult', returnType: { type: 'string' },
            isFuncCall: true, flags: ['Operator'],
            parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'IN_STRING' }],
          },
          ARITH_INT_MULT: {
            type: 'FunctionDef', id: 'ARITH_INT_MULT', library: 'Ntve',
            name: 'ArithmeticIntMult', returnType: { type: 'int' },
            isFuncCall: true, flags: ['Operator'], parameters: [],
          },
        },
        ParamDef: {
          TARGET_ACTOR_MESSAGE: {
            type: 'ParamDef', id: 'TARGET_ACTOR_MESSAGE', library: 'Ntve',
            paramType: { type: 'actormsg' },
          },
          IN_STRING: {
            type: 'ParamDef', id: 'IN_STRING', library: 'Ntve',
            paramType: { type: 'string' },
          },
        },
      },
    };
    const ctx = minimalCtx(nativeLibrary);
    const plus = SyntaxKind.PlusToken;
    const expression = {
      kind: SyntaxKind.BinaryExpression,
      left: {
        kind: SyntaxKind.BinaryExpression,
        left: { kind: SyntaxKind.StringLiteral, value: 'Signal ' },
        operatorToken: { kind: plus },
        right: { kind: SyntaxKind.StringLiteral, value: 'SetScale ' },
      },
      operatorToken: { kind: plus },
      right: { kind: SyntaxKind.StringLiteral, value: '1' },
    };

    const paramRef = exprToParamRef(
      expression,
      ctx,
      { type: 'ParamDef', library: 'Ntve', id: 'TARGET_ACTOR_MESSAGE' },
      'string',
    );
    const parameter = ctx.elements[paramRef.id] as any;
    const call = ctx.elements[parameter.functionCall.id] as any;
    expect(call.functionDef.id).toBe('COMBINE_STRING_MULT');
    expect(call.functionDef.id).not.toBe('ARITH_INT_MULT');
  });

  it('encodes trigger handle identifiers as trigger ValueElement params', () => {
    const ctx = minimalCtx({ id: 'Ntve', elementsByType: {} });
    ctx.triggerByGalaxyName = new Map([
      ['libTEST_gt_Open', { type: 'Trigger', library: 'TEST', id: 'TRIG_OPEN' }],
    ]);

    const paramRef = exprToParamRef(
      { kind: SyntaxKind.Identifier, name: 'libTEST_gt_Open' },
      ctx,
      { type: 'ParamDef', library: 'Ntve', id: 'TRIGGER_ARG' },
      'trigger',
    );

    const param = ctx.elements[paramRef.id] as any;
    expect(param.value).toBeUndefined();
    expect(param.valueType).toEqual({ type: 'trigger' });
    expect(param.valueElement).toEqual({ type: 'Trigger', library: 'TEST', id: 'TRIG_OPEN' });
  });

  it('preserves the ValueGameType namespace of a gamelink formal', () => {
    const nativeLibrary: any = {
      id: 'Ntve',
      elementsByType: {
        ParamDef: {
          MODEL: { type: 'ParamDef', id: 'MODEL', library: 'Ntve', paramType: { type: 'gamelink', gameType: 'Model' } },
        },
      },
    };
    const ctx = minimalCtx(nativeLibrary);
    const paramRef = exprToParamRef(
      { kind: SyntaxKind.StringLiteral, value: 'PingAlert' },
      ctx,
      { type: 'ParamDef', library: 'Ntve', id: 'MODEL' },
    );
    expect((ctx.elements[paramRef.id] as any).valueType).toEqual({ type: 'gamelink', gameType: 'Model' });
  });

  it('prefers trigger handle refs over same-named global refs', () => {
    const ctx = minimalCtx({ id: 'Ntve', elementsByType: {} });
    ctx.globalVarByGalaxyName.set('libTEST_gt_Open', { library: 'TEST', id: 'GLOBAL_OPEN' });
    ctx.triggerByGalaxyName = new Map([
      ['libTEST_gt_Open', { type: 'Trigger', library: 'TEST', id: 'TRIG_OPEN' }],
    ]);

    const paramRef = exprToParamRef(
      { kind: SyntaxKind.Identifier, name: 'libTEST_gt_Open' },
      ctx,
      { type: 'ParamDef', library: 'Ntve', id: 'TRIGGER_ARG' },
      'trigger',
    );

    const param = ctx.elements[paramRef.id] as any;
    expect(param.variable).toBeUndefined();
    expect(param.valueElement).toEqual({ type: 'Trigger', library: 'TEST', id: 'TRIG_OPEN' });
  });
});
