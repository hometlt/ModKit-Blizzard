/**
 * Unit tests for ttg-core.ts — the forward-conversion infrastructure.
 * These tests cover pure/stateless functions that need no real trigger data.
 */
import { describe, it, expect } from 'vitest';
import type { TriggerLibraryJson, VariableJson, ElementJson, FunctionDefJson, FunctionCallJson } from '@modkit/blizzard-starcraft2/triggers/document/index.js';
import type { ConversionContext } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-core.js';
import {
  sanitizeName,
  globalVarName,
  localVarName,
  buildGlobalVarNamesMap,
  mapTriggerTypeToGalaxy,
  detectDependencies,
  resolve,
  resolveRefFull,
  findElementsOfType,
  buildSubFuncTypeNamesMap,
  classifyScriptCodeAction,
  buildGalaxyArrayTypeSuffix,
  toGalaxyFunctionName,
  triggerFuncName,
  triggerHandleName,
  triggerInitFuncName,
  indexDeclaredGalaxySymbols,
  declaredPresetValueName,
  withNamingIndexes,
  deriveNativeTypeMapping,
  mapParameterTypeToGalaxy,
  resolveVariableGalaxyName,
} from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-core.js';
import { convertFunctionCallExpr } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-convert.js';
import { convertParamExpr } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-params.js';
import { buildOrderedArgs } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-convert.js';
import { Printer } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import { emitScriptTemplate } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-template.js';
import { parseTriggerXmlSync } from '@modkit/blizzard-starcraft2/triggers/document/sax-reader.js';
import { convertTriggerLibraryToGalaxyFull } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/trigger-to-galaxy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLib(id: string, elements: Record<string, any> = {}): TriggerLibraryJson {
  return { id, name: id, items: [], elements, elementsByType: {} } as any;
}

function makeCtx(library: TriggerLibraryJson, overrides: Partial<ConversionContext> = {}): ConversionContext {
  return {
    library,
    libId: library.id,
    localVarIds: new Set(),
    subFuncTypeNames: new Map(),
    autoVarDeclarations: [],
    ...overrides,
  };
}

function makeVar(id: string, name: string, library = 'LIB'): VariableJson {
  return { type: 'Variable', id, library, name } as VariableJson;
}

// ---------------------------------------------------------------------------
// sanitizeName
// ---------------------------------------------------------------------------

describe('sanitizeName', () => {
  it('strips spaces and special characters', () => {
    expect(sanitizeName('My Trigger!')).toBe('MyTrigger');
  });

  it('preserves alphanumeric and underscores', () => {
    expect(sanitizeName('gv_myVar_01')).toBe('gv_myVar_01');
  });

  it('returns empty string for all-special input', () => {
    expect(sanitizeName('!@#$%')).toBe('');
  });

  it('handles empty input', () => {
    expect(sanitizeName('')).toBe('');
  });

  it('writes a character outside ASCII as the uppercase hex of its UTF-8 bytes', () => {
    // Paired XML/Galaxy: the authored name below appears in the editor's own
    // output under exactly this encoding.
    expect(sanitizeName('蜂巢刷新递归')).toBe('E89C82E5B7A2E588B7E696B0E98092E5BD92');
  });

  it('keeps ASCII identifier characters beside encoded ones and still drops ASCII punctuation', () => {
    expect(sanitizeName('Wave 海 2!')).toBe('WaveE6B5B72');
  });

  it('leaves a name that already reads as those hex digits untouched', () => {
    expect(sanitizeName('E89C82E5B7A2')).toBe('E89C82E5B7A2');
  });

  it('prefixes an authored digit-leading identifier stem like the editor', () => {
    expect(sanitizeName('1x1 Max Count Per Row')).toBe('_1x1MaxCountPerRow');
    expect(globalVarName('LIB', makeVar('V4', '1x1 Max Count Per Row')))
      .toBe('libLIB_gv__1x1MaxCountPerRow');
  });
});

// ---------------------------------------------------------------------------
// globalVarName
// ---------------------------------------------------------------------------

describe('globalVarName', () => {
  it('produces lib{ID}_gv_{name} with lowercase first char', () => {
    expect(globalVarName('DPAN', makeVar('V1', 'MyVar'))).toBe('libDPAN_gv_myVar');
  });

  it('uses element id when name is missing', () => {
    const v = { type: 'Variable', id: 'ABC123', library: 'DPAN' } as any;
    expect(globalVarName('DPAN', v)).toBe('libDPAN_gv_aBC123');
  });

  it('strips spaces from display name', () => {
    expect(globalVarName('LIB', makeVar('V2', 'Spawn Count'))).toBe('libLIB_gv_spawnCount');
  });

  it('encodes a name outside ASCII instead of dropping it', () => {
    // Without this the whole name disappears and the emitter falls back to an id.
    expect(globalVarName('LIB', makeVar('V3', '时空之门冷却X')))
      .toBe('libLIB_gv_e697B6E7A9BAE4B98BE997A8E586B7E58DB4X');
  });
});

// ---------------------------------------------------------------------------
// localVarName
// ---------------------------------------------------------------------------

describe('localVarName', () => {
  it('adds lv_ prefix to a plain name', () => {
    expect(localVarName(makeVar('V1', 'count'))).toBe('lv_count');
  });

  it('preserves lv_ prefixed names as-is', () => {
    expect(localVarName(makeVar('V1', 'lv_count'))).toBe('lv_count');
  });

  // SC2 Editor declares a local Variable named after an iterator as `lv_auto…`
  // (401 declarations in the installed corpus), like any other local.
  it('prefixes a local named like an automatic iterator', () => {
    expect(localVarName(makeVar('V1', 'auto75079F91_var'))).toBe('lv_auto75079F91_var');
    expect(localVarName(makeVar('V1', 'Auto75079F91_var'))).toBe('lv_auto75079F91_var');
  });

  it('lowercases the first char when adding lv_ prefix', () => {
    expect(localVarName(makeVar('V1', 'MyUnit'))).toBe('lv_myUnit');
  });

  it('keeps a generated PickEachUnit iterator and a reconstructed auto-local bare', () => {
    const typed = (name: string, type: string): VariableJson => ({ ...makeVar('V1', name), variableType: { type } } as VariableJson);
    expect(localVarName(typed('auto9DE7D937_var', 'unit'))).toBe('auto9DE7D937_var');
    expect(localVarName(typed('Auto9DE7D937_var', 'unit'))).toBe('auto9DE7D937_var');
    expect(localVarName(typed('auto9DE7D937_var', 'int'))).toBe('lv_auto9DE7D937_var');
    expect(localVarName(typed('auto9DE7D937_n', 'unit'))).toBe('lv_auto9DE7D937_n');
    expect(localVarName({ ...typed('auto9DE7D937_n', 'int'), flags: ['NoScriptPrefix'] })).toBe('auto9DE7D937_n');
    expect(localVarName({ ...typed('Auto9DE7D937_val', 'int'), flags: ['NoScriptPrefix'] })).toBe('auto9DE7D937_val');
  });
});

// ---------------------------------------------------------------------------
// buildGlobalVarNamesMap — collision disambiguation
// ---------------------------------------------------------------------------

describe('buildGlobalVarNamesMap', () => {
  it('assigns simple names when no collision', () => {
    const vars = [makeVar('V1', 'count'), makeVar('V2', 'flag')];
    const map = buildGlobalVarNamesMap('LIB', vars);
    expect(map.get('V1')).toBe('libLIB_gv_count');
    expect(map.get('V2')).toBe('libLIB_gv_flag');
  });

  it('appends element ID suffix when two variables produce the same galaxy name', () => {
    // Both produce libLIB_gv_upgrade — disambiguation by element ID
    const vars = [makeVar('AABBCCDD', 'upgrade'), makeVar('11223344', 'upgrade')];
    const map = buildGlobalVarNamesMap('LIB', vars);
    expect(map.get('AABBCCDD')).toBe('libLIB_gv_upgrade_AABBCCDD');
    expect(map.get('11223344')).toBe('libLIB_gv_upgrade_11223344');
  });

  it('does not suffix when only one variable has that name', () => {
    const vars = [makeVar('V1', 'unique'), makeVar('V2', 'upgrade'), makeVar('V3', 'upgrade')];
    const map = buildGlobalVarNamesMap('LIB', vars);
    expect(map.get('V1')).toBe('libLIB_gv_unique');
    // upgrade collides → suffixed
    expect(map.get('V2')).toContain('upgrade_');
    expect(map.get('V3')).toContain('upgrade_');
  });
});

// ---------------------------------------------------------------------------
// mapTriggerTypeToGalaxy
// ---------------------------------------------------------------------------

describe('mapTriggerTypeToGalaxy', () => {
  it('maps primitive types', () => {
    expect(mapTriggerTypeToGalaxy('int')).toBe('int');
    expect(mapTriggerTypeToGalaxy('fixed')).toBe('fixed');
    expect(mapTriggerTypeToGalaxy('bool')).toBe('bool');
    expect(mapTriggerTypeToGalaxy('string')).toBe('string');
    expect(mapTriggerTypeToGalaxy('void')).toBe('void');
  });

  it('maps SC2-specific types', () => {
    expect(mapTriggerTypeToGalaxy('unit')).toBe('unit');
    expect(mapTriggerTypeToGalaxy('unitgroup')).toBe('unitgroup');
    expect(mapTriggerTypeToGalaxy('point')).toBe('point');
    expect(mapTriggerTypeToGalaxy('trigger')).toBe('trigger');
  });

  it('maps abstract trigger types to int', () => {
    expect(mapTriggerTypeToGalaxy('preset')).toBe('int');
    expect(mapTriggerTypeToGalaxy('anycompare')).toBe('int');
    expect(mapTriggerTypeToGalaxy('any')).toBe('int');
  });

  it('maps gamelink types to string', () => {
    expect(mapTriggerTypeToGalaxy('gamelink')).toBe('string');
    expect(mapTriggerTypeToGalaxy('anygamelink')).toBe('string');
  });

  it('is case-insensitive', () => {
    expect(mapTriggerTypeToGalaxy('INT')).toBe('int');
    expect(mapTriggerTypeToGalaxy('Unit')).toBe('unit');
  });

  it('passes through unknown types unchanged', () => {
    expect(mapTriggerTypeToGalaxy('customType')).toBe('customtype');
  });
});

// ---------------------------------------------------------------------------
// triggerFuncName / triggerHandleName / triggerInitFuncName
// ---------------------------------------------------------------------------

describe('trigger name helpers', () => {
  const trigger: any = { type: 'Trigger', id: 'T1', library: 'DPAN', name: 'My Trigger' };

  it('triggerFuncName produces lib{ID}_gt_{Name}_Func', () => {
    expect(triggerFuncName('DPAN', trigger)).toBe('libDPAN_gt_MyTrigger_Func');
  });

  it('triggerHandleName produces lib{ID}_gt_{Name}', () => {
    expect(triggerHandleName('DPAN', trigger)).toBe('libDPAN_gt_MyTrigger');
  });

  it('triggerInitFuncName produces lib{ID}_gt_{Name}_Init', () => {
    expect(triggerInitFuncName('DPAN', trigger)).toBe('libDPAN_gt_MyTrigger_Init');
  });
});

// ---------------------------------------------------------------------------
// detectDependencies
// ---------------------------------------------------------------------------

describe('detectDependencies', () => {
  it('returns empty array for a library with no cross-library refs', () => {
    const lib = makeLib('LIB', {
      A1: { type: 'Variable', id: 'A1', library: 'LIB', name: 'x' },
    });
    expect(detectDependencies(lib)).toEqual([]);
  });

  it('excludes Ntve from results', () => {
    const lib = makeLib('LIB', {
      FC1: {
        type: 'FunctionCall', id: 'FC1', library: 'LIB',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000001' },
      },
    });
    expect(detectDependencies(lib)).toEqual([]);
  });

  it("excludes the library's own ID from results", () => {
    const lib = makeLib('LIB', {
      V1: { type: 'Variable', id: 'V1', library: 'LIB', name: 'x' },
    });
    expect(detectDependencies(lib)).not.toContain('LIB');
  });

  it('finds a single external dependency', () => {
    const lib = makeLib('LIB', {
      FC1: {
        type: 'FunctionCall', id: 'FC1', library: 'LIB',
        functionDef: { type: 'FunctionDef', library: 'DEPLIB', id: 'ABC' },
      },
    });
    const deps = detectDependencies(lib);
    expect(deps).toContain('DEPLIB');
  });

  it('deduplicates multiple refs to the same dependency', () => {
    const lib = makeLib('LIB', {
      FC1: { type: 'FunctionCall', id: 'FC1', library: 'LIB',
        functionDef: { type: 'FunctionDef', library: 'DEPLIB', id: 'A1' } },
      FC2: { type: 'FunctionCall', id: 'FC2', library: 'LIB',
        functionDef: { type: 'FunctionDef', library: 'DEPLIB', id: 'A2' } },
    });
    const deps = detectDependencies(lib);
    expect(deps.filter(d => d === 'DEPLIB')).toHaveLength(1);
  });

  it('uses TriggerData library order instead of element-reference order', () => {
    const lib = makeLib('LIB', {
      FIRST_REF: { type: 'FunctionCall', id: 'FIRST_REF', library: 'LIB',
        functionDef: { type: 'FunctionDef', library: 'SECOND', id: 'F' } },
      SECOND_REF: { type: 'FunctionCall', id: 'SECOND_REF', library: 'LIB',
        functionDef: { type: 'FunctionDef', library: 'FIRST', id: 'F' } },
    });
    const allLibraries = new Map([
      ['FIRST', makeLib('FIRST')],
      ['LIB', lib],
      ['SECOND', makeLib('SECOND')],
    ]);
    expect(detectDependencies(lib, allLibraries)).toEqual(['FIRST', 'SECOND']);
  });

  it('ignores an individually disabled element without dropping enabled flat children', () => {
    const lib = makeLib('LIB', {
      DISABLED: {
        type: 'Trigger', id: 'DISABLED', library: 'LIB', disabled: true,
        events: [], conditions: [], localVariables: [], actions: [
          { type: 'FunctionCall', library: 'LIB', id: 'DISABLED_CALL' },
        ],
      },
      DISABLED_CALL: {
        type: 'FunctionCall', id: 'DISABLED_CALL', library: 'LIB', disabled: true,
        functionDef: { type: 'FunctionDef', library: 'UNUSED', id: 'F' },
      },
      ENABLED: {
        type: 'Trigger', id: 'ENABLED', library: 'LIB',
        events: [], conditions: [], localVariables: [], actions: [
          { type: 'FunctionCall', library: 'LIB', id: 'ENABLED_CALL' },
        ],
      },
      ENABLED_CALL: {
        type: 'FunctionCall', id: 'ENABLED_CALL', library: 'LIB',
        functionDef: { type: 'FunctionDef', library: 'USED', id: 'F' },
      },
    });

    expect(detectDependencies(lib)).toEqual(['USED']);
  });

  it('initializes dependency variables for a library and complete dependencies for a map', () => {
    const dependency = makeLib('DEP', {
      F: { type: 'FunctionDef', id: 'F', library: 'DEP', name: 'DependencyFunction', flags: ['Action'] },
    });
    const native = makeLib('Ntve');
    const reference = {
      type: 'FunctionCall', id: 'CALL', library: 'OWNER',
      functionDef: { type: 'FunctionDef', library: 'DEP', id: 'F' },
    };
    const library = makeLib('OWNER', { CALL: reference });
    const libraries = new Map([['DEP', dependency], ['OWNER', library]]);
    const libraryScript = convertTriggerLibraryToGalaxyFull(library, native, libraries).script;
    expect(libraryScript).toContain('libDEP_InitVariables();');
    expect(libraryScript).not.toMatch(/void libOWNER_InitLibraries[\s\S]*?\{[\s\S]*?libDEP_InitLib\(\);/);

    const map = { ...library, implicit: true } as TriggerLibraryJson;
    const mapLibraries = new Map([['DEP', dependency], ['OWNER', map]]);
    const mapScript = convertTriggerLibraryToGalaxyFull(map, native, mapLibraries).script;
    expect(mapScript).toContain('libDEP_InitLib();');
    expect(mapScript).not.toContain('InitVariables_completed');
    expect(mapScript).not.toContain('InitLib_completed');
  });

  it('omits disabled declarations but keeps an initially-off trigger', () => {
    const library = makeLib('LIB', {
      DISABLED_TRIGGER: { type: 'Trigger', id: 'DISABLED_TRIGGER', library: 'LIB', name: 'DisabledTrigger', disabled: true,
        localVariables: [], conditions: [], actions: [], events: [] },
      INITIAL_OFF: { type: 'Trigger', id: 'INITIAL_OFF', library: 'LIB', name: 'InitialOff', initOff: true,
        localVariables: [], conditions: [], actions: [], events: [] },
      DISABLED_FUNCTION: { type: 'FunctionDef', id: 'DISABLED_FUNCTION', library: 'LIB', name: 'DisabledFunction',
        disabled: true, flags: ['Action'], actions: [], localVariables: [] },
      DISABLED_VARIABLE: { type: 'Variable', id: 'DISABLED_VARIABLE', library: 'LIB', name: 'DisabledVariable',
        disabled: true, variableType: { type: 'int' } },
    });
    const output = convertTriggerLibraryToGalaxyFull(library, makeLib('Ntve'), new Map([['LIB', library]]));
    expect(output.script).not.toContain('DisabledTrigger');
    expect(output.header).not.toContain('DisabledTrigger');
    expect(output.script).not.toContain('DisabledFunction');
    expect(output.header).not.toContain('DisabledFunction');
    expect(output.header).not.toContain('disabledVariable');
    expect(output.script).toContain('libLIB_gt_InitialOff_Func');
    expect(output.script).toContain('TriggerEnable(libLIB_gt_InitialOff, false);');
  });

  // The editor writes no empty stage: none of the 151 corpus maps has an empty InitTriggers,
  // and the five whose triggers all live in a library of their own call InitLibs alone.
  it('omits the empty InitGlobals and InitTriggers stages from a map', () => {
    const map = { ...makeLib('Map'), implicit: true } as TriggerLibraryJson;
    const output = convertTriggerLibraryToGalaxyFull(map, makeLib('Ntve'), new Map([['Map', map]]));
    expect(output.script).not.toContain('void InitGlobals (');
    expect(output.script).not.toContain('InitGlobals();');
    expect(output.script).not.toContain('InitTriggers');
    expect(output.script).toContain('void InitLibs (');
    expect(output.script).toMatch(/void InitMap \(\) \{\s*InitLibs\(\);\s*\}/u);
  });

  it('initializes non-default structure members for every array element', () => {
    const initial = { type: 'Param', id: 'SEVEN', library: 'Map', value: '7', valueType: { type: 'int' } } as any;
    const member = { type: 'Variable', id: 'COUNT', library: 'Map', name: 'Count',
      variableType: { type: 'int' }, initialValue: { type: 'Param', library: 'Map', id: 'SEVEN' } } as any;
    const structure = { type: 'Structure', id: 'RECORD', library: 'Map', name: 'Record',
      variables: [{ type: 'Variable', library: 'Map', id: 'COUNT' }] } as any;
    const records = { type: 'Variable', id: 'RECORDS', library: 'Map', name: 'Records',
      variableType: { type: 'struct', typeElement: { type: 'Structure', library: 'Map', id: 'RECORD' } },
      arraySizes: [{ dim: 0, value: '1' }] } as any;
    const map = { ...makeLib('Map', { SEVEN: initial, COUNT: member, RECORD: structure, RECORDS: records }), implicit: true } as TriggerLibraryJson;

    const output = convertTriggerLibraryToGalaxyFull(map, makeLib('Ntve'), new Map([['Map', map]]));

    // The editor declares one `init_i` in InitGlobals and loops over the elements with it
    // (24 original MapScripts of the corpus; none uses a per-variable counter).
    expect(output.script).toContain('int init_i;');
    expect(output.script).toContain('for ( init_i = 0; init_i <= 1; init_i += 1 )');
    expect(output.script).toContain('gv_records[init_i].lv_count = 7;');
  });
});

describe('local variable initialization', () => {
  it('does not emit assignments for default-valued function locals', () => {
    const initial = { type: 'Param', id: 'ZERO', library: 'LIB', value: '0', valueType: { type: 'fixed' } } as any;
    const local = { type: 'Variable', id: 'LOCAL', library: 'LIB', name: 'Amount',
      variableType: { type: 'fixed' }, initialValue: { type: 'Param', library: 'LIB', id: 'ZERO' } } as any;
    const func = { type: 'FunctionDef', id: 'FUNC', library: 'LIB', name: 'Work', flags: ['Action'],
      parameters: [], localVariables: [{ type: 'Variable', library: 'LIB', id: 'LOCAL' }], actions: [] } as any;
    const lib = makeLib('LIB', { FUNC: func, LOCAL: local, ZERO: initial });
    const output = convertTriggerLibraryToGalaxyFull(lib, makeLib('Ntve'), new Map([['LIB', lib]]));
    expect(output.script).toContain('fixed lv_amount;');
    expect(output.script).not.toContain('lv_amount = 0');
  });

  it('emits the editor string initialization because empty string is not an uninitialized local', () => {
    const initial = { type: 'Param', id: 'EMPTY', library: 'LIB', valueType: { type: 'string' } } as any;
    const local = { type: 'Variable', id: 'LOCAL', library: 'LIB', name: 'Label',
      variableType: { type: 'string' }, initialValue: { type: 'Param', library: 'LIB', id: 'EMPTY' } } as any;
    const func = { type: 'FunctionDef', id: 'FUNC', library: 'LIB', name: 'Work', flags: ['Action'],
      parameters: [], localVariables: [{ type: 'Variable', library: 'LIB', id: 'LOCAL' }], actions: [] } as any;
    const lib = makeLib('LIB', { FUNC: func, LOCAL: local, EMPTY: initial });
    const output = convertTriggerLibraryToGalaxyFull(lib, makeLib('Ntve'), new Map([['LIB', lib]]));
    expect(output.script).toContain('lv_label = "";');
  });
});

describe('declared preset constants', () => {
  it('generates ordinal header constants for PresetInteger without PresetGenConstVar', () => {
    const values = [
      { type: 'PresetValue', id: 'TOP', library: 'DEP', name: 'Top' },
      { type: 'PresetValue', id: 'BOTTOM', library: 'DEP', name: 'Bottom' },
    ] as any[];
    const preset = { type: 'Preset', id: 'TUNNEL', library: 'DEP', name: 'Tunnel', integer: true, baseType: 'int',
      values: values.map(value => ({ type: 'PresetValue', library: 'DEP', id: value.id })) } as any;
    const lib = makeLib('DEP', { TUNNEL: preset, TOP: values[0], BOTTOM: values[1] });
    (lib.elementsByType as any).Preset = { TUNNEL: preset };
    (lib.elementsByType as any).PresetValue = { TOP: values[0], BOTTOM: values[1] };
    const output = convertTriggerLibraryToGalaxyFull(lib, makeLib('Ntve'), new Map([['DEP', lib]]));
    expect(output.header).toContain('const int libDEP_ge_Tunnel_Top = 0;');
    expect(output.header).toContain('const int libDEP_ge_Tunnel_Bottom = 1;');
  });

  it('recovers stripped integer preset names from an unambiguous loaded header group', () => {
    const values = [0, 1, 2].map(index => ({ type: 'PresetValue', id: `V${index}`, library: 'DEP' } as any));
    const preset = { type: 'Preset', id: 'P', library: 'DEP', integer: true,
      values: values.map(value => ({ type: 'PresetValue', library: 'DEP', id: value.id })) } as any;
    const lib = makeLib('DEP', { P: preset, V0: values[0], V1: values[1], V2: values[2] });
    withNamingIndexes(() => {
      indexDeclaredGalaxySymbols([{ text: [
        'const int libDEP_ge_Mode_First = 0;',
        'const int libDEP_ge_Mode_Second = 1;',
        'const int libDEP_ge_Mode_Third = 2;',
      ].join('\n') }], [lib]);
      expect(declaredPresetValueName(values[2], 'DEP')).toBe('libDEP_ge_Mode_Third');
    });
  });

  it('does not guess when one declaration group could belong to either preset', () => {
    const value = (id: string) => ({ type: 'PresetValue', id, library: 'DEP' } as any);
    const a = [value('A0'), value('A1')], b = [value('B0'), value('B1')];
    const preset = (id: string, values: any[]) => ({ type: 'Preset', id, library: 'DEP', integer: true,
      generateConstants: true, values: values.map(item => ({ type: 'PresetValue', library: 'DEP', id: item.id })) });
    const lib = makeLib('DEP', { PA: preset('PA', a), A0: a[0], A1: a[1], PB: preset('PB', b), B0: b[0], B1: b[1] });
    withNamingIndexes(() => {
      indexDeclaredGalaxySymbols([{ text: 'const int libDEP_ge_Mode_First = 0;\nconst int libDEP_ge_Mode_Second = 1;' }], [lib]);
      expect(declaredPresetValueName(a[0], 'DEP')).toBeUndefined();
      expect(declaredPresetValueName(b[0], 'DEP')).toBeUndefined();
    });
  });

  it('uses the ordinal of PresetInteger even when a stale scalar is present', () => {
    const value = { type: 'PresetValue', id: 'V0', library: 'DEP', value: 'true' } as any;
    const preset = { type: 'Preset', id: 'P', library: 'DEP', integer: true, generateConstants: true,
      values: [{ type: 'PresetValue', library: 'DEP', id: 'V0' }] } as any;
    const param = { type: 'Param', id: 'ARG', library: 'DEP',
      preset: { type: 'PresetValue', library: 'DEP', id: 'V0' } } as any;
    const lib = makeLib('DEP', { P: preset, V0: value, ARG: param });
    (lib.elementsByType as any).Preset = { P: preset };
    (lib.elementsByType as any).PresetValue = { V0: value };
    expect(new Printer().printNode(convertParamExpr(param, makeCtx(lib)) as any)).toBe('0');
  });

  it('uses the declared dependency ABI spelling for an internal global variable', () => {
    const variable = { type: 'Variable', id: 'V', library: 'DEP', name: 'ScriptFacing', flags: ['Internal'] } as any;
    const dependency = makeLib('DEP', { V: variable });
    (dependency.elementsByType as any).Variable = { V: variable };
    const current = makeLib('Map');
    withNamingIndexes(() => {
      indexDeclaredGalaxySymbols([{ text: 'int libDEP_gv_ScriptFacing;' }], [dependency]);
      const ctx = makeCtx(current, { allLibraries: new Map([['DEP', dependency]]) });
      expect(resolveVariableGalaxyName(variable, { type: 'Variable', id: 'V', library: 'DEP' }, ctx))
        .toBe('libDEP_gv_ScriptFacing');
    });
  });

  it('recovers stripped PresetAsBits names from an unambiguous hexadecimal header group', () => {
    const values = [0, 1, 2].map(index => ({ type: 'PresetValue', id: `B${index}`, library: 'DEP' } as any));
    const preset = { type: 'Preset', id: 'BITS', library: 'DEP', asBits: true,
      values: values.map(value => ({ type: 'PresetValue', library: 'DEP', id: value.id })) } as any;
    const lib = makeLib('DEP', { BITS: preset, B0: values[0], B1: values[1], B2: values[2] });
    withNamingIndexes(() => {
      indexDeclaredGalaxySymbols([{ text: [
        'const int libDEP_ge_Flags_First = 0x00000001;',
        'const int libDEP_ge_Flags_Second = 0x00000002;',
        'const int libDEP_ge_Flags_Third = 0x00000004;',
      ].join('\n') }], [lib]);
      expect(declaredPresetValueName(values[2], 'DEP')).toBe('libDEP_ge_Flags_Third');
    });
  });

  it('uses the constant generated by the current document for PresetInteger', () => {
    const value = { type: 'PresetValue', id: 'V2', library: 'DEP', name: 'Coop Needed' } as any;
    const preset = { type: 'Preset', id: 'P', library: 'DEP', name: 'Train Type', integer: true,
      values: [{ type: 'PresetValue', library: 'DEP', id: 'V2' }] } as any;
    const param = { type: 'Param', id: 'ARG', library: 'DEP',
      preset: { type: 'PresetValue', library: 'DEP', id: 'V2' } } as any;
    const lib = makeLib('DEP', { P: preset, V2: value, ARG: param });
    (lib.elementsByType as any).Preset = { P: preset };
    (lib.elementsByType as any).PresetValue = { V2: value };
    expect(new Printer().printNode(convertParamExpr(param, makeCtx(lib)) as any))
      .toBe('libDEP_ge_TrainType_CoopNeeded');
  });

  it('uses a named PresetInteger constant without PresetGenConstVar only when its header declares it', () => {
    const value = { type: 'PresetValue', id: 'V8', library: 'DEP', name: 'Map - TTosh01' } as any;
    const preset = { type: 'Preset', id: 'P', library: 'DEP', name: 'Map ID', integer: true,
      values: Array.from({ length: 9 }, (_, index) => ({ type: 'PresetValue', library: 'DEP', id: index === 8 ? 'V8' : `V${index}` })) } as any;
    const elements = { P: preset, V8: value } as any;
    for (let index = 0; index < 8; index++) elements[`V${index}`] = { type: 'PresetValue', id: `V${index}`, library: 'DEP' };
    const param = { type: 'Param', id: 'ARG', library: 'DEP',
      preset: { type: 'PresetValue', library: 'DEP', id: 'V8' } } as any;
    elements.ARG = param;
    const lib = makeLib('DEP', elements);
    (lib.elementsByType as any).Preset = { P: preset };
    (lib.elementsByType as any).PresetValue = Object.fromEntries(Object.entries(elements).filter(([, element]: any) => element.type === 'PresetValue'));

    withNamingIndexes(() => {
      indexDeclaredGalaxySymbols([{ text: 'const int libDEP_ge_MapID_MapTTosh01 = 8;' }], [lib]);
      expect(new Printer().printNode(convertParamExpr(param, makeCtx(lib)) as any)).toBe('libDEP_ge_MapID_MapTTosh01');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveRefFull / resolve<T>
// ---------------------------------------------------------------------------

describe('resolve / resolveRefFull', () => {
  it('resolves an element from the same library', () => {
    const v: VariableJson = makeVar('V1', 'count', 'LIB');
    const lib = makeLib('LIB', { V1: v });
    const ctx = makeCtx(lib);
    const result = resolve<VariableJson>({ type: 'Variable', library: 'LIB', id: 'V1' }, ctx);
    expect(result).toBe(v);
  });

  it('returns undefined for a missing element', () => {
    const lib = makeLib('LIB', {});
    const ctx = makeCtx(lib);
    const result = resolve<VariableJson>({ type: 'Variable', library: 'LIB', id: 'MISSING' }, ctx);
    expect(result).toBeUndefined();
  });

  it('returns undefined for an undefined ref', () => {
    const lib = makeLib('LIB', {});
    const ctx = makeCtx(lib);
    expect(resolve<VariableJson>(undefined, ctx)).toBeUndefined();
  });

  it('routes to nativeLibrary when ref.library matches', () => {
    const nativeEl: any = { type: 'FunctionDef', id: 'NF1', library: 'Ntve', name: 'Wait' };
    const nativeLib = makeLib('Ntve', { NF1: nativeEl });
    const lib = makeLib('LIB', {});
    const ctx = makeCtx(lib, { nativeLibrary: nativeLib });
    const result = resolve<FunctionDefJson>({ type: 'FunctionDef', library: 'Ntve', id: 'NF1' }, ctx);
    expect(result).toBe(nativeEl);
  });

  it('routes to allLibraries for a cross-library ref', () => {
    const crossEl: any = { type: 'Variable', id: 'CV1', library: 'OTHER', name: 'x' };
    const crossLib = makeLib('OTHER', { CV1: crossEl });
    const lib = makeLib('LIB', {});
    const ctx = makeCtx(lib, { allLibraries: new Map([['OTHER', crossLib]]) });
    const result = resolve<VariableJson>({ type: 'Variable', library: 'OTHER', id: 'CV1' }, ctx);
    expect(result).toBe(crossEl);
  });
});

describe('derived editor type mappings', () => {
  it('reads wrapper parameter types from the generated dependency header', () => {
    const formal: any = { type: 'ParamDef', id: 'STYLE', library: 'Ntve', paramType: { type: 'editorstyle' } };
    const wrapper: any = { type: 'FunctionDef', id: 'SET', library: 'Ntve', name: 'SetStyle',
      flags: ['Action'], parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'STYLE' }] };
    const native = makeLib('Ntve', { STYLE: formal, SET: wrapper });
    native.elementsByType = { ParamDef: { STYLE: formal }, FunctionDef: { SET: wrapper } } as any;
    deriveNativeTypeMapping(native, [{ text: 'void libNtve_gf_SetStyle(string lp_style);' }]);
    expect(mapParameterTypeToGalaxy({ type: 'editorstyle' }, native, native)).toBe('string');
  });

  it('prefers a supplied Galaxy ABI declaration over an earlier synthesized editor signature', () => {
    const formal: any = { type: 'ParamDef', id: 'CONTROL', library: 'Ntve', paramType: { type: 'control' } };
    const definition: any = { type: 'FunctionDef', id: 'GET', library: 'Ntve', name: 'DialogControlGetSelectedItem',
      flags: ['Native', 'Call'], returnType: { type: 'int' }, parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'CONTROL' }] };
    const native = makeLib('Ntve', { CONTROL: formal, GET: definition });
    native.elementsByType = { ParamDef: { CONTROL: formal }, FunctionDef: { GET: definition } } as any;
    deriveNativeTypeMapping(native, [
      { text: 'native int DialogControlGetSelectedItem(control value);' },
      { text: 'native int DialogControlGetSelectedItem(int value);' },
    ]);
    expect(mapParameterTypeToGalaxy({ type: 'control' }, native, native)).toBe('int');
  });

  it('reads an editor-only input type from a concrete unary conversion operator', () => {
    const formal: any = { type: 'ParamDef', id: 'TAG', library: 'Ntve', paramType: { type: 'editortag' } };
    const operator: any = { type: 'FunctionDef', id: 'CONVERT', library: 'Ntve', name: 'TagAsString',
      flags: ['Call', 'Operator'], returnType: { type: 'string' },
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'TAG' }] };
    const native = makeLib('Ntve', { TAG: formal, CONVERT: operator });
    native.elementsByType = { ParamDef: { TAG: formal }, FunctionDef: { CONVERT: operator } } as any;
    deriveNativeTypeMapping(native, [{ text: 'void Unrelated();' }]);
    expect(mapParameterTypeToGalaxy({ type: 'editortag' }, native, native)).toBe('string');
  });

  it('does not reinterpret a Galaxy primitive from the reverse direction of an operator', () => {
    const formal: any = { type: 'ParamDef', id: 'INDEX', library: 'Ntve', paramType: { type: 'int' } };
    const operator: any = { type: 'FunctionDef', id: 'TO_EDITOR', library: 'Ntve', name: 'IndexAsDifficulty',
      flags: ['Call', 'Operator'], returnType: { type: 'difficulty' },
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'INDEX' }] };
    const native = makeLib('Ntve', { INDEX: formal, TO_EDITOR: operator });
    native.elementsByType = { ParamDef: { INDEX: formal }, FunctionDef: { TO_EDITOR: operator } } as any;
    deriveNativeTypeMapping(native, [{ text: 'void Unrelated();' }]);
    expect(mapParameterTypeToGalaxy({ type: 'int' }, native, native)).toBe('int');
  });

  it('prefers a declared wrapper signature over secondary conversion operators', () => {
    const value: any = { type: 'ParamDef', id: 'VALUE', library: 'Ntve', paramType: { type: 'editordifficulty' } };
    const wrapper: any = { type: 'FunctionDef', id: 'SET', library: 'Ntve', name: 'SetDifficulty', flags: ['Action'],
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'VALUE' }] };
    const conversion: any = { type: 'FunctionDef', id: 'FIXED', library: 'Ntve', name: 'DifficultyAsFixed',
      flags: ['Call', 'Operator'], returnType: { type: 'fixed' }, parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'VALUE' }] };
    const native = makeLib('Ntve', { VALUE: value, SET: wrapper, FIXED: conversion });
    native.elementsByType = { ParamDef: { VALUE: value }, FunctionDef: { SET: wrapper, FIXED: conversion } } as any;
    deriveNativeTypeMapping(native, [{ text: 'void libNtve_gf_SetDifficulty(int lp_value);' }]);
    expect(mapParameterTypeToGalaxy({ type: 'editordifficulty' }, native, native)).toBe('int');
  });
});

describe('convertFunctionCallExpr', () => {
  it('does not emit invalid null() calls for unresolved empty FunctionDef refs', () => {
    const lib = makeLib('LIB', {});
    const ctx = makeCtx(lib);
    const call: FunctionCallJson = {
      type: 'FunctionCall',
      id: 'FC_MISSING',
      library: 'LIB',
      functionDef: { type: 'FunctionDef', library: 'LIB', id: '' },
    } as any;

    expect(convertFunctionCallExpr(call, ctx)).toBeUndefined();
  });

  it('wraps a concrete unit in UnitRefFromUnit for a resolved unitref formal', () => {
    const unitParam: any = {
      type: 'Param', id: 'UNIT', library: 'LIB',
      parameterDef: { type: 'ParamDef', library: 'Ntve', id: 'P_UNITREF' },
      valueId: '384', valueType: { type: 'unit' },
    };
    const lib = makeLib('LIB', { UNIT: unitParam });
    const native = makeLib('Ntve', {
      P_UNITREF: { type: 'ParamDef', id: 'P_UNITREF', library: 'Ntve', paramType: { type: 'unit' }, isReference: true },
    });
    const ctx = makeCtx(lib, { nativeLibrary: native });
    const def: any = {
      type: 'FunctionDef', id: 'EVENT', library: 'Ntve', name: 'TriggerAddEventUnitDied',
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'P_UNITREF' }],
    };
    const args = buildOrderedArgs({ type: 'FunctionCall', id: 'CALL', library: 'LIB', parameters: [{ type: 'Param', library: 'LIB', id: 'UNIT' }] } as any, def, ctx);
    expect(new Printer().printNode(args[0] as any)).toBe('UnitRefFromUnit(UnitFromId(384))');
  });

  it('wraps a structural unit variable path in UnitRefFromVariable for a reference formal', () => {
    const variable: any = {
      type: 'Variable', id: 'KEYSTONES', library: 'LIB', name: 'keystones',
      variableType: { type: 'unit' }, arraySizes: [{ value: '2', valueType: { type: 'int' } }],
    };
    const index: any = { type: 'Param', id: 'INDEX', library: 'LIB', value: '1', valueType: { type: 'int' } };
    const unitParam: any = {
      type: 'Param', id: 'UNIT', library: 'LIB',
      parameterDef: { type: 'ParamDef', library: 'Ntve', id: 'P_UNITREF' },
      variable: { type: 'Variable', library: 'LIB', id: 'KEYSTONES' },
      array: { type: 'Param', library: 'LIB', id: 'INDEX' },
    };
    const lib = makeLib('LIB', { KEYSTONES: variable, INDEX: index, UNIT: unitParam });
    const native = makeLib('Ntve', {
      P_UNITREF: { type: 'ParamDef', id: 'P_UNITREF', library: 'Ntve', paramType: { type: 'unit' }, isReference: true },
    });
    const ctx = makeCtx(lib, { nativeLibrary: native });
    const def: any = {
      type: 'FunctionDef', id: 'EVENT', library: 'Ntve', name: 'TriggerAddEventUnitDied',
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'P_UNITREF' }],
    };
    const args = buildOrderedArgs({ type: 'FunctionCall', id: 'CALL', library: 'LIB', parameters: [{ type: 'Param', library: 'LIB', id: 'UNIT' }] } as any, def, ctx);
    expect(new Printer().printNode(args[0] as any)).toBe('UnitRefFromVariable("libLIB_gv_keystones[1]")');
  });

  it('keeps a null unit reference as null', () => {
    const unitParam: any = {
      type: 'Param', id: 'UNIT', library: 'LIB',
      parameterDef: { type: 'ParamDef', library: 'Ntve', id: 'P_UNITREF' },
      value: '0', valueType: { type: 'unit' },
    };
    const lib = makeLib('LIB', { UNIT: unitParam });
    const formal: any = { type: 'ParamDef', id: 'P_UNITREF', library: 'Ntve', paramType: { type: 'unit' }, isReference: true };
    const native = makeLib('Ntve', { P_UNITREF: formal });
    const args = buildOrderedArgs(
      { type: 'FunctionCall', id: 'CALL', library: 'LIB', parameters: [{ type: 'Param', library: 'LIB', id: 'UNIT' }] } as any,
      { type: 'FunctionDef', id: 'EVENT', library: 'Ntve', parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'P_UNITREF' }] } as any,
      makeCtx(lib, { nativeLibrary: native }),
    );
    expect(new Printer().printNode(args[0] as any)).toBe('null');
  });

  it('expands every ParamFlagMultiple value through the ScriptCode separator', () => {
    const p0: any = { type: 'Param', id: 'P0', library: 'LIB', parameterDef: { type: 'ParamDef', library: 'Ntve', id: 'TEXT' }, valueType: { type: 'text' } };
    const p1: any = { type: 'Param', id: 'P1', library: 'LIB', parameterDef: { type: 'ParamDef', library: 'Ntve', id: 'TEXT' }, valueType: { type: 'text' } };
    const lib = makeLib('LIB', { P0: p0, P1: p1 });
    const formal: any = { type: 'ParamDef', id: 'TEXT', library: 'Ntve', name: 'inText', paramType: { type: 'text' }, isMultiple: true };
    const native = makeLib('Ntve', { TEXT: formal });
    const definition: any = { type: 'FunctionDef', id: 'COMBINE', library: 'Ntve', flags: ['Inline'], scriptCode: '(#PARAM(inText, " + "))', parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'TEXT' }] };
    const result = emitScriptTemplate({ type: 'FunctionCall', id: 'CALL', library: 'LIB', parameters: [{ type: 'Param', library: 'LIB', id: 'P0' }, { type: 'Param', library: 'LIB', id: 'P1' }] } as any, definition, makeCtx(lib, { nativeLibrary: native }), true);
    const printed = new Printer().printNode(result as any);
    expect(printed).toContain('Param/Value/lib_LIB_P0');
    expect(printed).toContain('Param/Value/lib_LIB_P1');
    expect(printed).toContain('+');
  });

  it('retains ParamFlagMultiple while parsing TriggerData', () => {
    const libraries = parseTriggerXmlSync('<TriggerData><Library Id="Ntve"><Element Type="ParamDef" Id="P"><Identifier>texts</Identifier><ParameterType><Type Value="text"/></ParameterType><ParamFlagMultiple/></Element></Library></TriggerData>');
    expect((libraries.get('Ntve')?.elements['ParamDef:P'] as any).isMultiple).toBe(true);
  });

  it('uses the editor default null for #DEFRETURN in a text-returning function', () => {
    const result = emitScriptTemplate(
      { type: 'FunctionCall', id: 'SKIP', library: 'LIB' } as any,
      { type: 'FunctionDef', id: 'SKIP_DEF', library: 'Ntve', scriptCode: 'return #DEFRETURN;', parameters: [] } as any,
      makeCtx(makeLib('LIB'), { returnType: 'text' }),
      false,
    ) as any[];
    expect(new Printer().printNode(result[0])).toBe('return null;');
  });

  it('promotes a literal #INITAUTOVAR value to an editor-style const local', () => {
    const actual: any = {
      type: 'Param', id: 'INCREMENT_VALUE', library: 'LIB',
      parameterDef: { type: 'ParamDef', library: 'Ntve', id: 'INCREMENT' },
      value: '-1', valueType: { type: 'int' },
    };
    const formal: any = {
      type: 'ParamDef', id: 'INCREMENT', library: 'Ntve', name: 'increment', paramType: { type: 'int' },
    };
    const lib = makeLib('LIB', { INCREMENT_VALUE: actual });
    const native = makeLib('Ntve', { INCREMENT: formal });
    const ctx = makeCtx(lib, { nativeLibrary: native });
    const definition: any = {
      type: 'FunctionDef', id: 'LOOP', library: 'Ntve', flags: ['Inline'],
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'INCREMENT' }],
      scriptCode: '#INITAUTOVAR(ai,increment)\n#AUTOVAR(ai) += 1;',
    };

    const result = emitScriptTemplate({
      type: 'FunctionCall', id: 'CALL', library: 'LIB',
      parameters: [{ type: 'Param', library: 'LIB', id: 'INCREMENT_VALUE' }],
    } as any, definition, ctx, false) as any[];

    expect(ctx.autoVarDeclarations.map(statement => new Printer().printNode(statement as any))).toEqual([
      'const int autoCALL_ai = -1;',
    ]);
    expect(result.map(statement => new Printer().printNode(statement)).join('\n')).toBe('autoCALL_ai += 1;');
  });

  it('promotes an #INITAUTOVAR reference only when the loaded variable is constant', () => {
    const end = { type: 'Variable', id: 'END', library: 'LIB', name: 'End', isConstant: true,
      variableType: { type: 'int' } } as any;
    const actual = { type: 'Param', id: 'END_VALUE', library: 'LIB',
      parameterDef: { type: 'ParamDef', library: 'Ntve', id: 'END_PARAM' },
      variable: { type: 'Variable', library: 'LIB', id: 'END' }, valueType: { type: 'int' } } as any;
    const formal = { type: 'ParamDef', id: 'END_PARAM', library: 'Ntve', name: 'end', paramType: { type: 'int' } } as any;
    const lib = makeLib('LIB', { END: end, END_VALUE: actual });
    const native = makeLib('Ntve', { END_PARAM: formal });
    const ctx = makeCtx(lib, { nativeLibrary: native });
    const definition: any = {
      type: 'FunctionDef', id: 'LOOP', library: 'Ntve', flags: ['Inline'],
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'END_PARAM' }],
      scriptCode: '#INITAUTOVAR(ae,end)\n#AUTOVAR(ae) += 1;',
    };

    emitScriptTemplate({ type: 'FunctionCall', id: 'CALL', library: 'LIB',
      parameters: [{ type: 'Param', library: 'LIB', id: 'END_VALUE' }] } as any, definition, ctx, false);

    expect(ctx.autoVarDeclarations.map(statement => new Printer().printNode(statement as any))).toEqual([
      'const int autoCALL_ae = libLIB_gv_end;',
    ]);
  });
});

// ---------------------------------------------------------------------------
// findElementsOfType
// ---------------------------------------------------------------------------

describe('findElementsOfType', () => {
  it('returns elements of a specific type from elementsByType when available', () => {
    const v1 = makeVar('V1', 'a');
    const lib: TriggerLibraryJson = {
      ...makeLib('LIB', {}),
      elementsByType: { Variable: { V1: v1 } } as any,
    };
    const results = findElementsOfType<VariableJson>(lib, 'Variable');
    expect(results).toContain(v1);
  });

  it('falls back to flat elements scan when elementsByType map is empty', () => {
    const v1: any = makeVar('V1', 'a');
    const lib = makeLib('LIB', { V1: v1 });
    const results = findElementsOfType<VariableJson>(lib, 'Variable');
    expect(results).toContain(v1);
  });

  it('returns only elements of the requested type', () => {
    const v1: any = makeVar('V1', 'a');
    const fc1: any = { type: 'FunctionCall', id: 'FC1', library: 'LIB' };
    const lib = makeLib('LIB', { V1: v1, FC1: fc1 });
    const results = findElementsOfType(lib, 'Variable');
    expect(results).toContain(v1);
    expect(results).not.toContain(fc1);
  });

  it('returns empty array when no elements match', () => {
    const lib = makeLib('LIB', {});
    expect(findElementsOfType(lib, 'Trigger')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildSubFuncTypeNamesMap
// ---------------------------------------------------------------------------

describe('buildSubFuncTypeNamesMap', () => {
  it('returns empty map when nativeLibrary is undefined', () => {
    expect(buildSubFuncTypeNamesMap(undefined).size).toBe(0);
  });

  it('builds map from nativeLibrary.subFuncTypeNames', () => {
    const nativeLib: any = {
      id: 'Ntve',
      elements: {},
      elementsByType: {},
      subFuncTypeNames: { 'Ntve_00000003': 'If', 'Ntve_00000004': 'Then' },
    };
    const map = buildSubFuncTypeNamesMap(nativeLib);
    expect(map.get('Ntve_00000003')).toBe('If');
    expect(map.get('Ntve_00000004')).toBe('Then');
  });
});

// ---------------------------------------------------------------------------
// buildGalaxyArrayTypeSuffix
// ---------------------------------------------------------------------------

describe('buildGalaxyArrayTypeSuffix', () => {
  it('returns empty string for a non-array variable', () => {
    const v = makeVar('V1', 'x');
    const lib = makeLib('LIB');
    const ctx = makeCtx(lib);
    expect(buildGalaxyArrayTypeSuffix(v, ctx)).toBe('');
  });

  it('returns [size+1] for a literal upper-bound array', () => {
    const v: any = { ...makeVar('V1', 'items'), arraySizes: [{ dim: 0, value: '9' }] };
    const lib = makeLib('LIB');
    const ctx = makeCtx(lib);
    expect(buildGalaxyArrayTypeSuffix(v, ctx)).toBe('[10]');
  });

  it('returns [][] for a 2-D array with no resolved bounds', () => {
    const v: any = { ...makeVar('V1', 'grid'), arraySizes: [{ dim: 0 }, { dim: 1 }] };
    const lib = makeLib('LIB');
    const ctx = makeCtx(lib);
    expect(buildGalaxyArrayTypeSuffix(v, ctx)).toBe('[][]');
  });
});

// ---------------------------------------------------------------------------
// classifyScriptCodeAction
// ---------------------------------------------------------------------------

describe('classifyScriptCodeAction', () => {
  it('identifies player-group iterator patterns from scriptCode, not the function name', () => {
    const funcDef = {
      name: 'SomeDependencyFunction',
      scriptCode: `
        #AUTOVAR(g, playergroup) = #PARAM(group);
        #PARAM(var) = -1;
        while (true) {
          #PARAM(var) = PlayerGroupNextPlayer(#AUTOVAR(g), #PARAM(var));
          if (#PARAM(var) < 0) { break; }
          #SUBFUNCS(actions)
        }
      `,
    } as any as FunctionDefJson;

    expect(classifyScriptCodeAction(funcDef)).toBe('pickEachPlayerInGroup');
  });

  it('identifies unit-group iterator patterns from scriptCode, not the function name', () => {
    const funcDef = {
      name: 'SomeOtherDependencyFunction',
      scriptCode: `
        #AUTOVAR(g, unitgroup) = #PARAM(group);
        #AUTOVAR(u) = UnitGroupCount(#AUTOVAR(g), c_unitCountAll);
        for (;; #AUTOVAR(u) -= 1) {
          #AUTOVAR(var, unit) = UnitGroupUnitFromEnd(#AUTOVAR(g), #AUTOVAR(u));
          if (#AUTOVAR(var) == null) { break; }
          #SUBFUNCS(actions)
        }
      `,
    } as any as FunctionDefJson;

    expect(classifyScriptCodeAction(funcDef)).toBe('pickEachUnitInGroup');
  });

  it('identifies catalog-entry iterator patterns from scriptCode', () => {
    const funcDef = {
      name: 'CompletelyDifferentName',
      scriptCode: `
        #AUTOVAR(catalog, int) = #PARAM(catalog);
        #AUTOVAR(i) = 1;
        for ( ; #AUTOVAR(i) <= CatalogEntryCount(#PARAM(catalog)) ; #AUTOVAR(i) += 1 ) {
          #PARAM(entry) = CatalogEntryGet(#AUTOVAR(catalog), #AUTOVAR(i));
          #SUBFUNCS(actions)
        }
      `,
    } as any as FunctionDefJson;

    expect(classifyScriptCodeAction(funcDef)).toBe('forEachCatalogEntryInCatalog');
  });

  it('identifies user-data iterator patterns from scriptCode', () => {
    const funcDef = {
      name: 'AnotherDifferentName',
      scriptCode: `
        #AUTOVAR(userType, string) = #PARAM(userType);
        #AUTOVAR(i) = 1;
        for ( ; #AUTOVAR(i) <= UserDataInstanceCount(#AUTOVAR(userType)) ; #AUTOVAR(i) += 1 ) {
          #PARAM(instance) = UserDataInstance(#AUTOVAR(userType), #AUTOVAR(i));
          #SUBFUNCS(actions)
        }
      `,
    } as any as FunctionDefJson;

    expect(classifyScriptCodeAction(funcDef)).toBe('forEachUserDataInstanceInUserType');
  });

  it('identifies UI-frame iterator patterns from scriptCode', () => {
    const funcDef = {
      name: 'UiFrameLoopFromSomeMod',
      scriptCode: `
        #PARAM(var) = c_syncFrameTypeFirst;
        for ( ; #PARAM(var) <= c_syncFrameTypeLast ; #PARAM(var) += 1 ) {
          #SUBFUNCS(actions)
        }
      `,
    } as any as FunctionDefJson;

    expect(classifyScriptCodeAction(funcDef)).toBe('forEachUIFrame');
  });

  it('identifies fixed/integer foreach patterns from scriptCode', () => {
    const funcDef = {
      name: 'YetAnotherDependencyFunction',
      scriptCode: `
        #INITAUTOVAR(ae,e)
        #INITAUTOVAR(ai,increment)
        #PARAM(var) = #PARAM(s);
        for ( ; ( (#AUTOVAR(ai) >= 0 && #PARAM(var) <= #AUTOVAR(ae)) || (#AUTOVAR(ai) < 0 && #PARAM(var) >= #AUTOVAR(ae)) ) ; #PARAM(var) += #AUTOVAR(ai) ) {
          #SUBFUNCS(actions)
        }
      `,
    } as any as FunctionDefJson;

    expect(classifyScriptCodeAction(funcDef)).toBe('forEachInteger');
  });

  it('identifies deprecated fixed-precision foreach patterns from scriptCode', () => {
    const funcDef = {
      name: 'StillAnotherDependencyFunction',
      scriptCode: `
        #AUTOVAR(ae,fixed) = #PARAM(e);
        #AUTOVAR(ai,fixed) = #PARAM(increment);
        #PARAM(var) = #PARAM(s);
        for ( ; ( (#AUTOVAR(ai) >= 0 && #PARAM(var) <= #AUTOVAR(ae)) || (#AUTOVAR(ai) <= 0 && #PARAM(var) >= #AUTOVAR(ae)) ) ; #PARAM(var) += #AUTOVAR(ai) ) {
          #SUBFUNCS(actions)
        }
      `,
    } as any as FunctionDefJson;

    expect(classifyScriptCodeAction(funcDef)).toBe('forEachInteger');
  });
});
