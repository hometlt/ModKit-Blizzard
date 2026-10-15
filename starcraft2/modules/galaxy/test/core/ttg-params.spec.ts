import { describe, expect, it } from 'vitest';
import { Printer } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import { convertParamExpr } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-params.js';
import { convertParamExpr as convertParamExprLegacy } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-convert.js';

const printer = new Printer();

function ctx(): any {
  return {
    library: { id: 'TEST', elements: {}, elementsByType: {} },
    libId: 'TEST',
    localVarIds: new Set(),
    subFuncTypeNames: new Map(),
    autoVarDeclarations: [],
  };
}

describe('convertParamExpr', () => {
  it('uses unqualified TriggerStrings keys for map text and qualified keys for libraries', () => {
    const mapCtx = ctx();
    mapCtx.library.implicit = true;
    const mapExpr = convertParamExpr({ type: 'Param', id: 'TEXT', library: 'Map', valueType: { type: 'text' } } as any, mapCtx);
    expect(printer.printNode(mapExpr as any)).toBe('StringExternal("Param/Value/TEXT")');

    const libraryExpr = convertParamExpr({ type: 'Param', id: 'TEXT', library: 'TEST', valueType: { type: 'text' } } as any, ctx());
    expect(printer.printNode(libraryExpr as any)).toBe('StringExternal("Param/Value/lib_TEST_TEXT")');
  });

  it('emits empty text only when both loaded string tables prove the Param/Value key is absent', () => {
    // TriggerStrings alone is a partial locale: the key may live in GameStrings.
    const partialCtx = ctx();
    partialCtx.library.implicit = true;
    partialCtx.library.triggerStringsLoaded = true;
    const partial = convertParamExpr({ type: 'Param', id: 'EMPTY', library: 'TEST', valueType: { type: 'text' } } as any, partialCtx);
    expect(printer.printNode(partial as any)).toBe('StringExternal("Param/Value/EMPTY")');

    const emptyCtx = ctx();
    emptyCtx.library.implicit = true;
    emptyCtx.library.triggerStringsLoaded = true;
    emptyCtx.library.completeLocalizedValues = true;
    const empty = convertParamExpr({ type: 'Param', id: 'EMPTY', library: 'TEST', valueType: { type: 'text' } } as any, emptyCtx);
    expect(printer.printNode(empty as any)).toBe('StringToText("")');

    const localized = convertParamExpr({ type: 'Param', id: 'TEXT', library: 'TEST', valueType: { type: 'text' }, localizedValue: 'Hello' } as any, emptyCtx);
    expect(printer.printNode(localized as any)).toBe('StringExternal("Param/Value/TEXT")');

    const explicitEmpty = convertParamExpr({ type: 'Param', id: 'EMPTY_KEY', library: 'TEST', valueType: { type: 'text' }, localizedValue: '' } as any, ctx());
    expect(printer.printNode(explicitEmpty as any)).toBe('StringExternal("Param/Value/lib_TEST_EMPTY_KEY")');

    const presetCtx = ctx();
    const presetFormal = { type: 'ParamDef', id: 'TEXT_FORMAL', library: 'TEST', paramType: { type: 'text' },
      preset: { type: 'Preset', id: 'NONE', library: 'TEST' } };
    presetCtx.library.elements = { TEXT_FORMAL: presetFormal };
    presetCtx.library.elementsByType = { ParamDef: { TEXT_FORMAL: presetFormal } };
    const presetEmpty = convertParamExpr({ type: 'Param', id: 'PRESET_EMPTY', library: 'TEST',
      parameterDef: { type: 'ParamDef', id: 'TEXT_FORMAL', library: 'TEST' },
      valueType: { type: 'text' }, localizedValue: '' } as any, presetCtx);
    expect(printer.printNode(presetEmpty as any)).toBe('StringToText("")');
  });

  it('emits localized text-expression token setters immediately before assembly', () => {
    const testCtx = ctx();
    testCtx.library.implicit = true;
    testCtx.expressionPrelude = [];
    const token = { type: 'Param', id: 'TOKEN', library: 'TEST', valueType: { type: 'text' }, localizedValue: 'Value', expressionCode: 'Count' } as any;
    const parent = { type: 'Param', id: 'PARENT', library: 'TEST', expressionType: 'text',
      expressionParams: [{ type: 'Param', id: 'TOKEN', library: 'TEST' }] } as any;
    testCtx.library.elements = { 'Param:TOKEN': token, 'Param:PARENT': parent };
    testCtx.library.elementsByType = { Param: { TOKEN: token, PARENT: parent } };

    expect(printer.printNode(convertParamExpr(parent, testCtx) as any))
      .toBe('TextExpressionAssemble("Param/Expression/PARENT")');
    expect(testCtx.expressionPrelude.map((statement: any) => printer.printNode(statement))).toEqual([
      'TextExpressionSetToken("Param/Expression/PARENT", "Count", StringExternal("Param/Value/TOKEN"));',
    ]);
  });

  it('emits untyped null values as the Galaxy null keyword', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({
        type: 'Param',
        id: 'P0',
        library: 'TEST',
        value: 'null',
      }, ctx());

      expect(expr).toBeDefined();
      expect(printer.printNode(expr as any)).toBe('null');
    }
  });

  it('emits every selected PresetAsBits value as a bitwise OR expression', () => {
    const testCtx = ctx();
    const first = { type: 'PresetValue', id: 'FIRST', library: 'TEST', value: 'c_first' };
    const second = { type: 'PresetValue', id: 'SECOND', library: 'TEST', value: 'c_second' };
    const bits = { type: 'Preset', id: 'BITS', library: 'TEST', baseType: 'int', asBits: true, values: [
      { type: 'PresetValue', library: 'TEST', id: 'FIRST' },
      { type: 'PresetValue', library: 'TEST', id: 'SECOND' },
    ] };
    testCtx.library.elements = { FIRST: first, SECOND: second, BITS: bits };
    testCtx.library.elementsByType = { PresetValue: { FIRST: first, SECOND: second }, Preset: { BITS: bits } };
    const expr = convertParamExpr({
      type: 'Param', id: 'FLAGS', library: 'TEST', valueType: { type: 'preset' },
      valueElement: { type: 'Preset', library: 'TEST', id: 'BITS' },
      valuePresets: [
        { type: 'PresetValue', library: 'TEST', id: 'FIRST' },
        { type: 'PresetValue', library: 'TEST', id: 'SECOND' },
      ],
    } as any, testCtx);
    expect(printer.printNode(expr as any)).toBe('c_first | c_second');
  });

  it('emits color values as Galaxy color constructors, not string literals', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({
        type: 'Param',
        id: 'P1',
        library: 'TEST',
        value: 'Color(100,100,100)',
        valueType: { type: 'color' },
      }, ctx());

      expect(expr).toBeDefined();
      expect(printer.printNode(expr as any)).toBe('Color(100, 100, 100)');
    }
  });

  it('parses the editor expression stored by modelanim without double quoting it', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({
        type: 'Param',
        id: 'PA',
        library: 'TEST',
        value: '"Talk"',
        valueType: { type: 'modelanim' },
      }, ctx());
      expect(printer.printNode(expr as any)).toBe('"Talk"');
    }
  });

  it('rejects an unquoted modelanim scalar that the editor would compile as an identifier', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      expect(() => convert({
        type: 'Param',
        id: 'PA',
        library: 'TEST',
        value: 'Talk',
        valueType: { type: 'modelanim' },
      }, ctx())).toThrow(/string literal expression/);
    }
  });

  it('preserves ColorWithAlpha constructor values', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({
        type: 'Param',
        id: 'P2',
        library: 'TEST',
        value: 'ColorWithAlpha(0.00,0.00,0.00,0.00)',
        valueType: { type: 'color' },
      }, ctx());

      expect(expr).toBeDefined();
      expect(printer.printNode(expr as any)).toBe('ColorWithAlpha(0.00, 0.00, 0.00, 0.00)');
    }
  });

  it.each([
    ['lv_entry', 'lv_entry'],
    ['\n                lv_entry;\n            ', 'lv_entry'],
    ['(a + b);', '(a + b)'],
  ])('accepts ScriptCode %j whose only extra statement is empty', (scriptCode, printed) => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({ type: 'Param', id: 'PS', library: 'TEST', scriptCode } as any, ctx());
      expect(expr).toBeDefined();
      expect(printer.printNode(expr as any)).toBe(printed);
    }
  });

  it.each(['lv_a; lv_b;', 'lv_a; DoThing();', 'if (true) { }'])('still rejects ScriptCode %j that is not one expression', scriptCode => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      expect(() => convert({ type: 'Param', id: 'PS', library: 'TEST', scriptCode } as any, ctx())).toThrow(/one Galaxy expression/);
    }
  });

  it.each([
    [{ valueId: '3' }, '3'],
    [{ valueId: '4', value: '3' }, '4'],
    [{ valueId: '2', value: '0' }, '2'],
  ])('emits the difficulty selector %j from its ValueId', (fields, printed) => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({ type: 'Param', id: 'PD', library: 'TEST', valueType: { type: 'difficulty' }, ...fields } as any, ctx());
      expect(expr).toBeDefined();
      expect(printer.printNode(expr as any)).toBe(printed);
    }
  });

  it('rejects a difficulty selector whose ValueId is not a nonnegative integer', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      expect(() => convert({ type: 'Param', id: 'PD', library: 'TEST', valueType: { type: 'difficulty' }, valueId: '-1' } as any, ctx())).toThrow(/nonnegative Galaxy integer/);
    }
  });

  it('builds a camera-info selector from its ValueId', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({ type: 'Param', id: 'PC', library: 'TEST', valueType: { type: 'camerainfo' }, valueId: '2227' } as any, ctx());
      expect(printer.printNode(expr as any)).toBe('CameraInfoFromId(2227)');
    }
  });

  it('builds unit, unit-group and doodad selectors from their ValueId', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const unit = convert({ type: 'Param', id: 'PU', library: 'TEST', valueType: { type: 'unit' }, valueId: '384' } as any, ctx());
      const group = convert({ type: 'Param', id: 'PG', library: 'TEST', valueType: { type: 'unitgroup' }, valueId: '17' } as any, ctx());
      const doodad = convert({ type: 'Param', id: 'PD', library: 'TEST', valueType: { type: 'doodad' }, valueId: '711' } as any, ctx());
      expect(printer.printNode(unit as any)).toBe('UnitFromId(384)');
      expect(printer.printNode(group as any)).toBe('UnitGroupFromId(17)');
      expect(printer.printNode(doodad as any)).toBe('DoodadFromId(711)');
    }
  });

  it('uses the catalog name of a gamelink and treats ValueId as editor selection metadata', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({
        type: 'Param',
        id: 'PG',
        library: 'TEST',
        value: 'RichMineralField',
        valueType: { type: 'gamelink', gameType: 'Unit' },
        valueId: '4294967295',
      } as any, ctx());
      expect(printer.printNode(expr as any)).toBe('"RichMineralField"');
    }
  });

  it('emits the neutral scalar for an empty preset from the declared preset base type', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const testCtx = ctx();
      const flags = { type: 'Preset', id: 'FLAGS', library: 'TEST', baseType: 'int', asBits: true, values: [] };
      const formal = {
        type: 'ParamDef', id: 'FORMAL', library: 'TEST',
        paramType: { type: 'preset', typeElement: { type: 'Preset', library: 'TEST', id: 'FLAGS' } },
      };
      testCtx.library.elements = { FLAGS: flags, FORMAL: formal };
      testCtx.library.elementsByType = { Preset: { FLAGS: flags }, ParamDef: { FORMAL: formal } };
      const expr = convert({
        type: 'Param', id: 'EMPTY', library: 'TEST',
        parameterDef: { type: 'ParamDef', library: 'TEST', id: 'FORMAL' },
        valueType: { type: 'preset' },
      } as any, testCtx);
      expect(printer.printNode(expr as any)).toBe('0');
    }
  });

  it('accepts an int selector that repeats its scalar in ValueId and rejects one that disagrees', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const expr = convert({ type: 'Param', id: 'PI', library: 'TEST', valueType: { type: 'int' }, value: '7', valueId: '7' } as any, ctx());
      expect(printer.printNode(expr as any)).toBe('7');
      expect(() => convert({ type: 'Param', id: 'PI', library: 'TEST', valueType: { type: 'int' }, value: '7', valueId: '8' } as any, ctx()))
        .toThrow(/no supported value codec/);
    }
  });

  it('emits trigger ValueElement params as trigger handle identifiers', () => {
    for (const convert of [convertParamExpr, convertParamExprLegacy]) {
      const testCtx = ctx();
      testCtx.library.elements.TRIG_OPEN = {
        type: 'Trigger',
        id: 'TRIG_OPEN',
        library: 'TEST',
        name: 'Open',
        localVariables: [],
        events: [],
        conditions: [],
        actions: [],
      };

      const expr = convert({
        type: 'Param',
        id: 'P3',
        library: 'TEST',
        valueType: { type: 'trigger' },
        valueElement: { type: 'Trigger', library: 'TEST', id: 'TRIG_OPEN' },
      } as any, testCtx);

      expect(expr).toBeDefined();
      expect(printer.printNode(expr as any)).toBe('libTEST_gt_Open');
    }
  });
});
