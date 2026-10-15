import { describe, it, expect } from 'vitest';
import { validateLibraryStructure } from '@modkit/blizzard-starcraft2/triggers/document/structure-validate.js';
import type { TriggerLibraryJson } from '@modkit/blizzard-starcraft2/triggers/document/index.js';

function lib(id: string, elements: Record<string, any>): TriggerLibraryJson {
  return {
    id,
    name: id,
    items: Object.values(elements).map((e: any) => ({ type: e.type, library: id, id: e.id })),
    elements,
    elementsByType: {} as any,
  } as any;
}

const NTVE = lib('Ntve', {
  '00000123': { type: 'FunctionDef', id: '00000123', library: 'Ntve', name: 'CustomScriptAction', parameters: [] },
  '00000124': {
    type: 'FunctionDef', id: '00000124', library: 'Ntve', name: 'Not',
    parameters: [],
    subFunctionTypes: [{ library: 'Ntve', id: '00000125' }],
  },
  '00000200': {
    type: 'FunctionDef', id: '00000200', library: 'Ntve', name: 'SetVariable',
    parameters: [
      { type: 'ParamDef', library: 'Ntve', id: '00000201' },
      { type: 'ParamDef', library: 'Ntve', id: '00000202' },
    ],
  },
  '00000201': { type: 'ParamDef', id: '00000201', library: 'Ntve', name: 'var' },
  '00000202': { type: 'ParamDef', id: '00000202', library: 'Ntve', name: 'val' },
});

describe('validateLibraryStructure', () => {
  it('passes a minimal valid library', () => {
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000200' },
        parameters: [
          { type: 'Param', library: 'AAAA', id: 'A0000003' },
          { type: 'Param', library: 'AAAA', id: 'A0000004' },
        ],
      },
      'A0000003': { type: 'Param', id: 'A0000003', library: 'AAAA', parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00000201' }, value: '1' },
      'A0000004': { type: 'Param', id: 'A0000004', library: 'AAAA', parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00000202' }, value: '2' },
    });
    expect(validateLibraryStructure([L], { dependencyLibraries: [NTVE] })).toEqual([]);
  });

  it('treats an omitted implicit-map library as a same-library reference', () => {
    const L = lib('Map', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'Map', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: '', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'Map',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000123' },
        parameters: [],
      },
    });
    expect(validateLibraryStructure([L], { dependencyLibraries: [NTVE] })).toEqual([]);
  });

  it('does not compare polymorphic TriggerLib types as concrete types', () => {
    const native = lib('Ntve', {
      '00001000': {
        type: 'FunctionDef', id: '00001000', library: 'Ntve', name: 'Generic',
        parameters: [
          { type: 'ParamDef', library: 'Ntve', id: '00001001' },
          { type: 'ParamDef', library: 'Ntve', id: '00001002' },
        ],
      },
      '00001001': { type: 'ParamDef', id: '00001001', library: 'Ntve', paramType: { type: 'anyvariable' } },
      '00001002': { type: 'ParamDef', id: '00001002', library: 'Ntve', paramType: { type: 'sameas' } },
    });
    const L = lib('Map', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'Map', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: '', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'Map',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00001000' },
        parameters: [
          { type: 'Param', library: '', id: 'A0000003' },
          { type: 'Param', library: '', id: 'A0000004' },
        ],
      },
      'A0000003': {
        type: 'Param', id: 'A0000003', library: 'Map',
        parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00001001' },
        valueType: { type: 'int' }, value: '1',
      },
      'A0000004': {
        type: 'Param', id: 'A0000004', library: 'Map',
        parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00001002' },
        valueType: { type: 'playergroup' }, value: 'x',
      },
    });
    expect(validateLibraryStructure([L], { dependencyLibraries: [native], checkConcreteTypes: true })).toEqual([]);
  });

  it('flags orphaned Param and FunctionCall elements', () => {
    const L = lib('AAAA', {
      'A0000001': { type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T', events: [], conditions: [], localVariables: [], actions: [] },
      'A0000009': { type: 'Param', id: 'A0000009', library: 'AAAA', value: 'orphan' },
      'A000000A': { type: 'FunctionCall', id: 'A000000A', library: 'AAAA', functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000123' }, parameters: [] },
    });
    const f = validateLibraryStructure([L], { dependencyLibraries: [NTVE] });
    expect(f.filter(x => x.code === 'E_ORPHAN').map(x => x.elementId).sort()).toEqual(['A0000009', 'A000000A']);
  });

  it('flags refs to missing elements and name-shaped ids', () => {
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [
          { type: 'FunctionCall', library: 'AAAA', id: 'A0000002' },
        ],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: 'UnitFilter' }, // name leaked as id
        parameters: [{ type: 'Param', library: 'AAAA', id: 'A00000FF' }],        // missing
      },
    });
    const f = validateLibraryStructure([L], { dependencyLibraries: [NTVE] });
    expect(f.some(x => x.code === 'E_NAME_REF')).toBe(true);
    expect(f.some(x => x.code === 'E_BAD_REF')).toBe(true);
  });

  it('flags arity overflow', () => {
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000200' }, // declares 2 params
        parameters: [
          { type: 'Param', library: 'AAAA', id: 'A0000003' },
          { type: 'Param', library: 'AAAA', id: 'A0000004' },
          { type: 'Param', library: 'AAAA', id: 'A0000005' },
        ],
      },
      'A0000003': { type: 'Param', id: 'A0000003', library: 'AAAA', parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00000201' }, value: 'x' },
      'A0000004': { type: 'Param', id: 'A0000004', library: 'AAAA', parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00000202' }, value: 'y' },
      'A0000005': { type: 'Param', id: 'A0000005', library: 'AAAA', parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00000201' }, value: 'z' },
    });
    const f = validateLibraryStructure([L], { dependencyLibraries: [NTVE] });
    expect(f.some(x => x.code === 'E_ARITY')).toBe(true);
  });

  it('flags an extra raw parameter that the editor would remove as orphaned', () => {
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T', events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000200' },
        parameters: [
          { type: 'Param', library: 'AAAA', id: 'A0000003' },
          { type: 'Param', library: 'AAAA', id: 'A0000004' },
          { type: 'Param', library: 'AAAA', id: 'A0000005' },
        ],
      },
      'A0000003': { type: 'Param', id: 'A0000003', library: 'AAAA', parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00000201' }, value: 'x' },
      'A0000004': { type: 'Param', id: 'A0000004', library: 'AAAA', parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00000202' }, value: 'y' },
      'A0000005': { type: 'Param', id: 'A0000005', library: 'AAAA', valueType: 'bool', value: 'false' },
    });
    const f = validateLibraryStructure([L], { dependencyLibraries: [NTVE] });
    expect(f.some(x => x.code === 'E_PARAMDEF' && x.elementId === 'A0000005')).toBe(true);
  });

  it('matches FunctionCall parameters by explicit ParameterDef rather than XML order', () => {
    const native = lib('Ntve', {
      '00001000': {
        type: 'FunctionDef', id: '00001000', library: 'Ntve', name: 'Reordered',
        parameters: [
          { type: 'ParamDef', library: 'Ntve', id: '00001001' },
          { type: 'ParamDef', library: 'Ntve', id: '00001002' },
        ],
      },
      '00001001': { type: 'ParamDef', id: '00001001', library: 'Ntve', paramType: { type: 'int' } },
      '00001002': { type: 'ParamDef', id: '00001002', library: 'Ntve', paramType: { type: 'text' } },
    });
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00001000' },
        parameters: [
          { type: 'Param', library: 'AAAA', id: 'A0000003' },
          { type: 'Param', library: 'AAAA', id: 'A0000004' },
        ],
      },
      'A0000003': {
        type: 'Param', id: 'A0000003', library: 'AAAA',
        parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00001002' },
        valueType: { type: 'text' }, value: 'second formal first',
      },
      'A0000004': {
        type: 'Param', id: 'A0000004', library: 'AAAA',
        parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00001001' },
        valueType: { type: 'int' }, value: '7',
      },
    });
    expect(validateLibraryStructure([L], { dependencyLibraries: [native], checkConcreteTypes: true })).toEqual([]);
  });

  it('resolves a preset-backed actual parameter to the Preset base type', () => {
    const native = lib('Ntve', {
      '00001000': {
        type: 'FunctionDef', id: '00001000', library: 'Ntve', name: 'NeedsBool',
        parameters: [{ type: 'ParamDef', library: 'Ntve', id: '00001001' }],
      },
      '00001001': { type: 'ParamDef', id: '00001001', library: 'Ntve', paramType: { type: 'bool' } },
      '00001002': { type: 'Preset', id: '00001002', library: 'Ntve', baseType: 'bool', values: [] },
    });
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00001000' },
        parameters: [{ type: 'Param', library: 'AAAA', id: 'A0000003' }],
      },
      'A0000003': {
        type: 'Param', id: 'A0000003', library: 'AAAA',
        parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00001001' },
        valueType: { type: 'preset' },
        valueElement: { type: 'Preset', library: 'Ntve', id: '00001002' },
      },
    });
    expect(validateLibraryStructure([L], { dependencyLibraries: [native], checkConcreteTypes: true })).toEqual([]);
  });

  it('rejects a ParameterDef that exists but is not declared by the called FunctionDef', () => {
    const native = lib('Ntve', {
      '00001000': {
        type: 'FunctionDef', id: '00001000', library: 'Ntve', name: 'OneFormal',
        parameters: [{ type: 'ParamDef', library: 'Ntve', id: '00001001' }],
      },
      '00001001': { type: 'ParamDef', id: '00001001', library: 'Ntve', paramType: { type: 'int' } },
      '00001002': { type: 'ParamDef', id: '00001002', library: 'Ntve', paramType: { type: 'int' } },
    });
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00001000' },
        parameters: [{ type: 'Param', library: 'AAAA', id: 'A0000003' }],
      },
      'A0000003': {
        type: 'Param', id: 'A0000003', library: 'AAAA',
        parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00001002' },
        valueType: { type: 'int' }, value: '7',
      },
    });
    const findings = validateLibraryStructure([L], { dependencyLibraries: [native], checkConcreteTypes: true });
    expect(findings.some(f => f.code === 'E_PARAMDEF' && f.elementId === 'A0000003')).toBe(true);
  });

  it('flags sub-function calls missing a role accepted by the parent FunctionDef', () => {
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000124' },
        subFunctions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000003' }],
      },
      'A0000003': {
        type: 'FunctionCall', id: 'A0000003', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000123' },
      },
    });
    const f = validateLibraryStructure([L], { dependencyLibraries: [NTVE] });
    expect(f.some(x => x.code === 'E_SUBFUNC_ROLE' && x.elementId === 'A0000003')).toBe(true);
  });

  it('flags nested function return types that do not match the formal ParamDef', () => {
    const native = lib('Ntve', {
      '00001000': {
        type: 'FunctionDef', id: '00001000', library: 'Ntve', name: 'NeedsText',
        parameters: [{ type: 'ParamDef', library: 'Ntve', id: '00001001' }],
      },
      '00001001': {
        type: 'ParamDef', id: '00001001', library: 'Ntve', name: 'tooltip',
        paramType: { type: 'text' },
      },
      '00001002': {
        type: 'FunctionDef', id: '00001002', library: 'Ntve', name: 'StringToText',
        returnType: { type: 'actormsg' },
        parameters: [],
      },
    });
    const L = lib('AAAA', {
      'A0000001': {
        type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T',
        events: [], conditions: [], localVariables: [],
        actions: [{ type: 'FunctionCall', library: 'AAAA', id: 'A0000002' }],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00001000' },
        parameters: [{ type: 'Param', library: 'AAAA', id: 'A0000003' }],
      },
      'A0000003': {
        type: 'Param', id: 'A0000003', library: 'AAAA',
        parameterDef: { type: 'ParamDef', library: 'Ntve', id: '00001001' },
        functionCall: { type: 'FunctionCall', library: 'AAAA', id: 'A0000004' },
      },
      'A0000004': {
        type: 'FunctionCall', id: 'A0000004', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00001002' },
        parameters: [],
      },
    });
    const f = validateLibraryStructure([L], { dependencyLibraries: [native], checkConcreteTypes: true });
    expect(f.some(x => x.code === 'E_TYPE' && x.elementId === 'A0000003')).toBe(true);
  });

  it('flags placeholder leakage and __InitVariablesRaw', () => {
    const L = lib('AAAA', {
      'A0000001': {
        type: 'FunctionDef', id: 'A0000001', library: 'AAAA', name: '__InitVariablesRaw',
        parameters: [], actions: [], localVariables: [],
      },
      'A0000002': {
        type: 'FunctionCall', id: 'A0000002', library: 'AAAA',
        functionDef: { type: 'FunctionDef', library: 'Ntve', id: '00000123' },
        parameters: [], scriptCode: 'x = __mx_raw_script_0;',
      },
    });
    const f = validateLibraryStructure([L], { dependencyLibraries: [NTVE], skipOrphanCheck: true });
    expect(f.some(x => x.code === 'E_RAW_INIT')).toBe(true);
    expect(f.some(x => x.code === 'E_PLACEHOLDER')).toBe(true);
  });

  it('allows qualified ids across libraries and flags duplicate item entries', () => {
    const A = lib('AAAA', { 'A0000001': { type: 'Trigger', id: 'A0000001', library: 'AAAA', name: 'T', events: [], conditions: [], localVariables: [], actions: [] } });
    const B = lib('BBBB', { 'A0000001': { type: 'Trigger', id: 'A0000001', library: 'BBBB', name: 'U', events: [], conditions: [], localVariables: [], actions: [] } });
    (A.items as any).push({ type: 'Trigger', library: 'AAAA', id: 'A0000001' }); // dup item entry
    const f = validateLibraryStructure([A, B]);
    expect(f.filter(x => x.code === 'E_DUP_ID')).toHaveLength(1);
  });
});
