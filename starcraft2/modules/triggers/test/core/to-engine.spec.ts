import { describe, expect, it } from 'vitest';
import { triggerLibraryToEngineProgram } from '@modkit/blizzard-starcraft2/triggers/document/to-engine.js';
import type { TriggerLibraryJson } from '@modkit/blizzard-starcraft2/triggers/document/types.js';

function emptyLibrary(): TriggerLibraryJson {
  return {
    id: 'TEST',
    name: 'TestLib',
    items: [],
    elements: {},
    elementsByType: {
      FunctionDef: {},
      ParamDef: {},
      FunctionCall: {},
      Param: {},
      Variable: {},
      Trigger: {},
      Preset: {},
      PresetValue: {},
      Category: {},
      Label: {},
      Structure: {},
    },
  };
}

/**
 * Minimal synthetic NativeLib that supplies:
 *  - Named FunctionDef entries for each control-flow function
 *  - subFuncTypeNames for each sub-block role used in unit tests
 *
 * Keyed by the Ntve IDs the unit tests hard-wire into their FunctionCall fixtures.
 */
function minimalNtveLib(): TriggerLibraryJson {
  return {
    id: 'Ntve',
    name: 'NativeLib',
    items: [],
    elements: {},
    elementsByType: {
      FunctionDef: {
        '00000137': { id: '00000137', type: 'FunctionDef', name: 'IfThenElse',           isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        '71596144': { id: '71596144', type: 'FunctionDef', name: 'While',                isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        '00000349': { id: '00000349', type: 'FunctionDef', name: 'Repeat',               isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        'CEDAB9C3': { id: 'CEDAB9C3', type: 'FunctionDef', name: 'RepeatForever',       isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        '66474248': { id: '66474248', type: 'FunctionDef', name: 'ForEachInteger',       isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        '119A6AF8': { id: '119A6AF8', type: 'FunctionDef', name: 'ForEachInteger2',      isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        '91C49196': { id: '91C49196', type: 'FunctionDef', name: 'Switch',               isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        '3A1227AB': { id: '3A1227AB', type: 'FunctionDef', name: 'SwitchCase',           isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        'B525B112': { id: 'B525B112', type: 'FunctionDef', name: 'ForEachPlayerInGroup', isSubFunction: true, parameters: [], returnType: { type: 'void' } },
        '00000327': { id: '00000327', type: 'FunctionDef', name: 'ForEachUnitInGroup',   isSubFunction: true, parameters: [], returnType: { type: 'void' } },
      },
      ParamDef: {}, FunctionCall: {}, Param: {}, Variable: {},
      Trigger: {}, Preset: {}, PresetValue: {}, Category: {}, Label: {}, Structure: {},
    },
    subFuncTypeNames: {
      // IfThenElse sub-blocks
      'Ntve_00000003': 'If',
      'Ntve_00000004': 'Then',
      'Ntve_00000005': 'Else',
      // While sub-blocks
      'Ntve_20298AEC': 'Conditions',
      'Ntve_A1B37466': 'Actions',
      // Repeat sub-block
      'Ntve_00000008': 'Actions',
      // RepeatForever sub-block
      'Ntve_4945FAA8': 'Actions',
      // Switch sub-blocks
      'Ntve_AD43BC93': 'Cases',
      'Ntve_3E7C4C40': 'Default',
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Adds a minimal IfThenElse FunctionCall to lib.
 * Returns the ref to the outer IfThenElse call.
 */
function addIfThenElse(
  lib: TriggerLibraryJson,
  prefix: string,
  condRef: { id: string; type: string },
  thenActions: { id: string; type: string }[],
  elseActions: { id: string; type: string }[] = [],
): { id: string; type: string } {
  const ifBlockId = `${prefix}_ifblock`;
  lib.elementsByType.FunctionCall[ifBlockId] = {
    id: ifBlockId, type: 'FunctionCall',
    subFunctionType: { library: 'Ntve', id: '00000003' },
    subFunctions: [condRef],
  };
  const thenBlockId = `${prefix}_thenblock`;
  lib.elementsByType.FunctionCall[thenBlockId] = {
    id: thenBlockId, type: 'FunctionCall',
    subFunctionType: { library: 'Ntve', id: '00000004' },
    subFunctions: thenActions,
  };
  const elseBlockId = `${prefix}_elseblock`;
  lib.elementsByType.FunctionCall[elseBlockId] = {
    id: elseBlockId, type: 'FunctionCall',
    subFunctionType: { library: 'Ntve', id: '00000005' },
    subFunctions: elseActions,
  };
  const outerId = `${prefix}_outer`;
  lib.elementsByType.FunctionCall[outerId] = {
    id: outerId, type: 'FunctionCall',
    functionDef: { id: '00000137', library: 'Ntve', type: 'FunctionDef' },
    subFunctions: [
      { id: ifBlockId, type: 'FunctionCall' },
      { id: thenBlockId, type: 'FunctionCall' },
      { id: elseBlockId, type: 'FunctionCall' },
    ],
  };
  return { id: outerId, type: 'FunctionCall' };
}

describe('triggerLibraryToEngineProgram', () => {
  it('converts trigger library JSON to EngineAst', () => {
    const library = emptyLibrary();
    library.elementsByType.Variable.gv = {
      id: 'gv', type: 'Variable', name: 'gv_count',
      variableType: { type: 'int' },
      initialValue: { id: 'p0', type: 'Param' },
    };
    library.elementsByType.Param.p0 = {
      id: 'p0', type: 'Param', value: '0', valueType: { type: 'int' },
    };
    library.elementsByType.FunctionDef.fd = {
      id: 'fd', type: 'FunctionDef', name: 'DebugMessage',
      parameters: [{ id: 'pd', type: 'ParamDef' }],
      returnType: { type: 'void' }, isFuncAction: true,
    };
    library.elementsByType.ParamDef.pd = {
      id: 'pd', type: 'ParamDef', name: 'message',
      paramType: { type: 'string' },
    };
    library.elementsByType.Param.p1 = {
      id: 'p1', type: 'Param', value: 'hello', valueType: { type: 'string' },
    };
    library.elementsByType.FunctionCall.fc = {
      id: 'fc', type: 'FunctionCall',
      functionDef: { id: 'fd', type: 'FunctionDef' },
      parameters: [{ id: 'p1', type: 'Param' }],
    };
    library.elementsByType.Trigger.tr = {
      id: 'tr', type: 'Trigger', name: 'Init',
      events: [], conditions: [],
      actions: [{ id: 'fc', type: 'FunctionCall' }],
      localVariables: [],
    };

    const program = triggerLibraryToEngineProgram(library, { fileName: 'Triggers' });
    const module = program.modules[0];
    expect(module?.id).toBe('TEST');
    expect(module?.globals[0]?.name).toBe('gv_count');
    expect(module?.functions[0]?.name).toBe('DebugMessage');
    expect(module?.triggers[0]?.name).toBe('Init');
    expect(module?.triggers[0]?.actions[0]?.kind).toBe('EngineExpressionStatement');
  });

  describe('control-flow lowering', () => {
    it('lowers IfThenElse to EngineIfStatement', () => {
      const lib = emptyLibrary();
      lib.elementsByType.FunctionCall.cond = {
        id: 'cond', type: 'FunctionCall',
        functionDef: { id: 'fdBool', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionDef.fdBool = {
        id: 'fdBool', type: 'FunctionDef', name: 'IsReady',
        parameters: [], returnType: { type: 'bool' }, isFuncCall: true,
      };
      lib.elementsByType.FunctionCall.act = {
        id: 'act', type: 'FunctionCall',
        functionDef: { id: 'fdAct', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionDef.fdAct = {
        id: 'fdAct', type: 'FunctionDef', name: 'DoSomething',
        parameters: [], returnType: { type: 'void' }, isFuncAction: true,
      };
      const ifRef = addIfThenElse(lib, 'test1',
        { id: 'cond', type: 'FunctionCall' },
        [{ id: 'act', type: 'FunctionCall' }],
      );
      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [], actions: [ifRef], localVariables: [],
      };

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const actions = prog.modules[0]?.triggers[0]?.actions ?? [];
      expect(actions).toHaveLength(1);
      expect(actions[0]?.kind).toBe('EngineIfStatement');
      const ifStmt = actions[0] as any;
      expect(ifStmt.condition.kind).toBe('EngineCallExpression');
      expect(ifStmt.then).toHaveLength(1);
      expect(ifStmt.then[0]?.kind).toBe('EngineExpressionStatement');
      expect(ifStmt.else).toBeUndefined();
    });

    it('lowers IfThenElse with else branch', () => {
      const lib = emptyLibrary();
      lib.elementsByType.FunctionCall.cond = {
        id: 'cond', type: 'FunctionCall',
        functionDef: { id: 'fdBool', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionDef.fdBool = {
        id: 'fdBool', type: 'FunctionDef', name: 'Check',
        parameters: [], returnType: { type: 'bool' }, isFuncCall: true,
      };
      lib.elementsByType.FunctionCall.actThen = {
        id: 'actThen', type: 'FunctionCall',
        functionDef: { id: 'fdThen', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionDef.fdThen = {
        id: 'fdThen', type: 'FunctionDef', name: 'OnTrue',
        parameters: [], returnType: { type: 'void' }, isFuncAction: true,
      };
      lib.elementsByType.FunctionCall.actElse = {
        id: 'actElse', type: 'FunctionCall',
        functionDef: { id: 'fdElse', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionDef.fdElse = {
        id: 'fdElse', type: 'FunctionDef', name: 'OnFalse',
        parameters: [], returnType: { type: 'void' }, isFuncAction: true,
      };
      const ifRef = addIfThenElse(lib, 'test2',
        { id: 'cond', type: 'FunctionCall' },
        [{ id: 'actThen', type: 'FunctionCall' }],
        [{ id: 'actElse', type: 'FunctionCall' }],
      );
      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [], actions: [ifRef], localVariables: [],
      };

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const ifStmt = prog.modules[0]?.triggers[0]?.actions[0] as any;
      expect(ifStmt?.kind).toBe('EngineIfStatement');
      expect(ifStmt.else).toHaveLength(1);
      expect(ifStmt.else[0]?.kind).toBe('EngineExpressionStatement');
    });

    it('lowers While to EngineWhileStatement', () => {
      const lib = emptyLibrary();
      lib.elementsByType.FunctionDef.fdCond = {
        id: 'fdCond', type: 'FunctionDef', name: 'HasMore',
        parameters: [], returnType: { type: 'bool' }, isFuncCall: true,
      };
      lib.elementsByType.FunctionCall.cond = {
        id: 'cond', type: 'FunctionCall',
        functionDef: { id: 'fdCond', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionDef.fdAct = {
        id: 'fdAct', type: 'FunctionDef', name: 'Step',
        parameters: [], returnType: { type: 'void' }, isFuncAction: true,
      };
      lib.elementsByType.FunctionCall.act = {
        id: 'act', type: 'FunctionCall',
        functionDef: { id: 'fdAct', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionCall.condBlock = {
        id: 'condBlock', type: 'FunctionCall',
        subFunctionType: { library: 'Ntve', id: '20298AEC' },
        subFunctions: [{ id: 'cond', type: 'FunctionCall' }],
      };
      lib.elementsByType.FunctionCall.actBlock = {
        id: 'actBlock', type: 'FunctionCall',
        subFunctionType: { library: 'Ntve', id: 'A1B37466' },
        subFunctions: [{ id: 'act', type: 'FunctionCall' }],
      };
      lib.elementsByType.FunctionCall.whileCall = {
        id: 'whileCall', type: 'FunctionCall',
        functionDef: { id: '71596144', library: 'Ntve', type: 'FunctionDef' },
        subFunctions: [
          { id: 'condBlock', type: 'FunctionCall' },
          { id: 'actBlock', type: 'FunctionCall' },
        ],
      };
      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [],
        actions: [{ id: 'whileCall', type: 'FunctionCall' }],
        localVariables: [],
      };

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const stmt = prog.modules[0]?.triggers[0]?.actions[0] as any;
      expect(stmt?.kind).toBe('EngineWhileStatement');
      expect(stmt.condition?.kind).toBe('EngineCallExpression');
      expect(stmt.body).toHaveLength(1);
      expect(stmt.body[0]?.kind).toBe('EngineExpressionStatement');
    });

    it('lowers Repeat to EngineVariableStatement + EngineWhileStatement', () => {
      const lib = emptyLibrary();
      lib.elementsByType.FunctionDef.fdAct = {
        id: 'fdAct', type: 'FunctionDef', name: 'Tick',
        parameters: [], returnType: { type: 'void' }, isFuncAction: true,
      };
      lib.elementsByType.FunctionCall.act = {
        id: 'act', type: 'FunctionCall',
        functionDef: { id: 'fdAct', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionCall.actBlock = {
        id: 'actBlock', type: 'FunctionCall',
        subFunctionType: { library: 'Ntve', id: '00000008' },
        subFunctions: [{ id: 'act', type: 'FunctionCall' }],
      };
      lib.elementsByType.Param.pCount = {
        id: 'pCount', type: 'Param', value: '5', valueType: { type: 'int' },
      };
      lib.elementsByType.FunctionCall.repeatCall = {
        id: 'repeatCall', type: 'FunctionCall',
        functionDef: { id: '00000349', library: 'Ntve', type: 'FunctionDef' },
        parameters: [{ id: 'pCount', type: 'Param' }],
        subFunctions: [{ id: 'actBlock', type: 'FunctionCall' }],
      };
      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [],
        actions: [{ id: 'repeatCall', type: 'FunctionCall' }],
        localVariables: [],
      };

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const actions = prog.modules[0]?.triggers[0]?.actions ?? [];
      expect(actions).toHaveLength(2);
      expect(actions[0]?.kind).toBe('EngineVariableStatement');
      expect(actions[1]?.kind).toBe('EngineWhileStatement');
      const whileStmt = actions[1] as any;
      expect(whileStmt.body).toHaveLength(2);
      expect(whileStmt.body[0]?.kind).toBe('EngineExpressionStatement');
      expect(whileStmt.body[1]?.kind).toBe('EngineAssignmentStatement');
    });

    it('lowers RepeatForever to infinite EngineWhileStatement', () => {
      const lib = emptyLibrary();
      lib.elementsByType.FunctionDef.fdAct = {
        id: 'fdAct', type: 'FunctionDef', name: 'Loop',
        parameters: [], returnType: { type: 'void' }, isFuncAction: true,
      };
      lib.elementsByType.FunctionCall.act = {
        id: 'act', type: 'FunctionCall',
        functionDef: { id: 'fdAct', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionCall.actBlock = {
        id: 'actBlock', type: 'FunctionCall',
        subFunctionType: { library: 'Ntve', id: '4945FAA8' },
        subFunctions: [{ id: 'act', type: 'FunctionCall' }],
      };
      lib.elementsByType.FunctionCall.rfCall = {
        id: 'rfCall', type: 'FunctionCall',
        functionDef: { id: 'CEDAB9C3', library: 'Ntve', type: 'FunctionDef' },
        subFunctions: [{ id: 'actBlock', type: 'FunctionCall' }],
      };
      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [],
        actions: [{ id: 'rfCall', type: 'FunctionCall' }],
        localVariables: [],
      };

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const stmt = prog.modules[0]?.triggers[0]?.actions[0] as any;
      expect(stmt?.kind).toBe('EngineWhileStatement');
      expect(stmt.condition).toEqual({ kind: 'EngineLiteralExpression', value: true });
      expect(stmt.body).toHaveLength(1);
    });

    it('falls through to raw statement for unrecognised subFunction call', () => {
      const lib = emptyLibrary();
      lib.elementsByType.FunctionCall.unknown = {
        id: 'unknown', type: 'FunctionCall',
        functionDef: { id: 'DEADBEEF', library: 'Ntve', type: 'FunctionDef' },
        subFunctions: [{ id: 'x', type: 'FunctionCall' }],
      };
      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [],
        actions: [{ id: 'unknown', type: 'FunctionCall' }],
        localVariables: [],
      };

      // DEADBEEF is not in minimalNtveLib → name lookup fails → falls through
      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: true,
        nativeLibraries: [minimalNtveLib()],
      });
      const actions = prog.modules[0]?.triggers[0]?.actions ?? [];
      expect(actions).toHaveLength(2);
      expect(actions[0]?.kind).toBe('EngineExpressionStatement');
      expect(actions[1]?.kind).toBe('EngineRawStatement');
    });
  });

  // ── Switch lowering ────────────────────────────────────────────────────────

  describe('Switch lowering', () => {
    function makeSwitchTrigger(lib: TriggerLibraryJson): void {
      // discriminant: literal param 'active'
      lib.elementsByType.Param.disc = {
        id: 'disc', type: 'Param', value: 'active',
      };

      // SwitchCase 1: value='Item', body=[action1]
      lib.elementsByType.Param.case1val = {
        id: 'case1val', type: 'Param', value: 'Item',
      };
      lib.elementsByType.FunctionCall.action1 = {
        id: 'action1', type: 'FunctionCall',
        functionDef: { id: 'ACT1', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionCall.case1 = {
        id: 'case1', type: 'FunctionCall',
        functionDef: { id: '3A1227AB', library: 'Ntve', type: 'FunctionDef' },
        parameters: [{ id: 'case1val', type: 'Param' }],
        subFunctions: [{ id: 'action1', type: 'FunctionCall' }],
        subFunctionType: { library: 'Ntve', id: 'AD43BC93' }, // Cases
      };

      // SwitchCase 2: value='PreventReveal', body=[action2]
      lib.elementsByType.Param.case2val = {
        id: 'case2val', type: 'Param', value: 'PreventReveal',
      };
      lib.elementsByType.FunctionCall.action2 = {
        id: 'action2', type: 'FunctionCall',
        functionDef: { id: 'ACT2', library: 'TEST', type: 'FunctionDef' },
      };
      lib.elementsByType.FunctionCall.case2 = {
        id: 'case2', type: 'FunctionCall',
        functionDef: { id: '3A1227AB', library: 'Ntve', type: 'FunctionDef' },
        parameters: [{ id: 'case2val', type: 'Param' }],
        subFunctions: [{ id: 'action2', type: 'FunctionCall' }],
        subFunctionType: { library: 'Ntve', id: 'AD43BC93' }, // Cases
      };

      // Default: a direct action FunctionCall (tagged Default)
      lib.elementsByType.FunctionCall.defaultAction = {
        id: 'defaultAction', type: 'FunctionCall',
        functionDef: { id: 'ACT3', library: 'TEST', type: 'FunctionDef' },
        subFunctionType: { library: 'Ntve', id: '3E7C4C40' }, // Default
      };

      // Switch outer call
      lib.elementsByType.FunctionCall.sw = {
        id: 'sw', type: 'FunctionCall',
        functionDef: { id: '91C49196', library: 'Ntve', type: 'FunctionDef' },
        parameters: [{ id: 'disc', type: 'Param' }],
        subFunctions: [
          { id: 'case1', type: 'FunctionCall' },
          { id: 'case2', type: 'FunctionCall' },
          { id: 'defaultAction', type: 'FunctionCall' },
        ],
      };

      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [],
        actions: [{ id: 'sw', type: 'FunctionCall' }],
        localVariables: [],
      };
    }

    it('lowers Switch to EngineSwitchStatement with cases and default', () => {
      const lib = emptyLibrary();
      makeSwitchTrigger(lib);

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const stmt = prog.modules[0]?.triggers[0]?.actions[0] as any;

      expect(stmt?.kind).toBe('EngineSwitchStatement');
      expect(stmt.discriminant.kind).toBe('EngineLiteralExpression');
      expect(stmt.discriminant.value).toBe('active');

      expect(stmt.cases).toHaveLength(2);
      expect(stmt.cases[0].value.value).toBe('Item');
      expect(stmt.cases[0].body).toHaveLength(1);
      expect(stmt.cases[0].body[0].kind).toBe('EngineExpressionStatement');

      expect(stmt.cases[1].value.value).toBe('PreventReveal');

      // Default body: the defaultAction FunctionCall lowered as ExpressionStatement
      expect(Array.isArray(stmt.default)).toBe(true);
      expect(stmt.default).toHaveLength(1);
      expect(stmt.default[0].kind).toBe('EngineExpressionStatement');
    });

    it('emits undefined default when no Default sub-block is present', () => {
      const lib = emptyLibrary();
      makeSwitchTrigger(lib);
      // Remove defaultAction from switch subFunctions
      lib.elementsByType.FunctionCall.sw.subFunctions = [
        { id: 'case1', type: 'FunctionCall' },
        { id: 'case2', type: 'FunctionCall' },
      ];

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const stmt = prog.modules[0]?.triggers[0]?.actions[0] as any;
      expect(stmt?.kind).toBe('EngineSwitchStatement');
      expect(stmt.default).toBeUndefined();
    });
  });

  // ── ForEachGroup lowering ─────────────────────────────────────────────────

  describe('ForEachGroup lowering', () => {
    it('lowers ForEachPlayerInGroup to EngineForEachStatement', () => {
      const lib = emptyLibrary();

      // Loop variable
      lib.elementsByType.Variable.pv = {
        id: 'pv', type: 'Variable', name: 'lp_player',
        variableType: { type: 'int' },
      };

      // params[0] = group expr (a FunctionCall returning a player group)
      lib.elementsByType.FunctionCall.groupExpr = {
        id: 'groupExpr', type: 'FunctionCall',
        functionDef: { id: 'PlayerGroupAll', library: 'Ntve', type: 'FunctionDef' },
      };
      lib.elementsByType.Param.groupParam = {
        id: 'groupParam', type: 'Param',
        functionCall: { id: 'groupExpr', library: 'TEST', type: 'FunctionCall' },
      };

      // params[1] = the loop variable ref
      lib.elementsByType.Param.varParam = {
        id: 'varParam', type: 'Param',
        variable: { id: 'pv', library: 'TEST', type: 'Variable' },
      };

      // Body action
      lib.elementsByType.FunctionCall.bodyAct = {
        id: 'bodyAct', type: 'FunctionCall',
        functionDef: { id: 'DoSomething', library: 'TEST', type: 'FunctionDef' },
      };

      lib.elementsByType.FunctionCall.forEach = {
        id: 'forEach', type: 'FunctionCall',
        functionDef: { id: 'B525B112', library: 'Ntve', type: 'FunctionDef' },
        parameters: [
          { id: 'groupParam', type: 'Param' },
          { id: 'varParam', type: 'Param' },
        ],
        subFunctions: [{ id: 'bodyAct', type: 'FunctionCall' }],
      };
      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [],
        actions: [{ id: 'forEach', type: 'FunctionCall' }],
        localVariables: [],
      };

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const stmt = prog.modules[0]?.triggers[0]?.actions[0] as any;

      expect(stmt?.kind).toBe('EngineForEachStatement');
      // variable resolved from params[1].variable
      expect(stmt.variable.name).toBe('lp_player');
      expect(stmt.variable.id).toBe('pv');
      // iterable = groupExpr call expression
      expect(stmt.iterable.kind).toBe('EngineCallExpression');
      // body has one action
      expect(stmt.body).toHaveLength(1);
      expect(stmt.body[0].kind).toBe('EngineExpressionStatement');
    });

    it('lowers ForEachUnitInGroup to EngineForEachStatement', () => {
      const lib = emptyLibrary();

      lib.elementsByType.Variable.uv = {
        id: 'uv', type: 'Variable', name: 'lp_unit',
        variableType: { type: 'unit' },
      };
      lib.elementsByType.Param.gp = {
        id: 'gp', type: 'Param',
        functionCall: { id: 'unitGrp', library: 'TEST', type: 'FunctionCall' },
      };
      lib.elementsByType.FunctionCall.unitGrp = {
        id: 'unitGrp', type: 'FunctionCall',
        functionDef: { id: 'LastCreatedGroup', library: 'Ntve', type: 'FunctionDef' },
      };
      lib.elementsByType.Param.vp = {
        id: 'vp', type: 'Param',
        variable: { id: 'uv', library: 'TEST', type: 'Variable' },
      };
      lib.elementsByType.FunctionCall.forEach = {
        id: 'forEach', type: 'FunctionCall',
        functionDef: { id: '00000327', library: 'Ntve', type: 'FunctionDef' },
        parameters: [
          { id: 'gp', type: 'Param' },
          { id: 'vp', type: 'Param' },
        ],
        subFunctions: [],
      };
      lib.elementsByType.Trigger.tr = {
        id: 'tr', type: 'Trigger', name: 'T',
        events: [], conditions: [],
        actions: [{ id: 'forEach', type: 'FunctionCall' }],
        localVariables: [],
      };

      const prog = triggerLibraryToEngineProgram(lib, {
        includeRawFallbacks: false,
        nativeLibraries: [minimalNtveLib()],
      });
      const stmt = prog.modules[0]?.triggers[0]?.actions[0] as any;
      expect(stmt?.kind).toBe('EngineForEachStatement');
      expect(stmt.variable.name).toBe('lp_unit');
      expect(stmt.iterable.kind).toBe('EngineCallExpression');
    });
  });
});
