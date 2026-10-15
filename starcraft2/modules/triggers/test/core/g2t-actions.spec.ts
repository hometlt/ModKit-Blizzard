import { describe, expect, it } from 'vitest'
import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core'
import { parseGalaxySource } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/galaxy-to-trigger.js'
import { buildCustomScriptActionFCRef, buildPickEachIntegerFromForStmt, convertStatementListToActionRefs, parseSwitchIfChain, stmtToActionFCRef } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-actions.js'
import { collectConditionRefs } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-call.js'
import { structuredParam, structuredStatements, tryCapturedIntegerLoop } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-structured.js'
import { buildFuncNameToFuncDefMap, buildRoleToSubFuncTypeMap, resetGalaxyToTriggerIdCounter } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-core.js'
import { compileTemplateVariants, matchTemplatePrefix } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/script-template.js'
import { toGalaxyFunctionName } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ttg-core.js'

function context(): any {
  const nativeLibrary: any = {
    id: 'Ntve',
    subFuncTypeNames: { 'Ntve_ACTIONS': 'Actions' },
    elementsByType: {
      SubFuncType: { ACTIONS: { type: 'SubFuncType', id: 'ACTIONS', library: 'Ntve', name: 'actions', identifier: 'Actions', isAction: true } },
      ParamDef: {
        START: { type: 'ParamDef', id: 'START', library: 'Ntve', name: 's', identifier: 's', paramType: { type: 'int' } },
        END: { type: 'ParamDef', id: 'END', library: 'Ntve', name: 'e', identifier: 'e', paramType: { type: 'int' } },
        GROUP: { type: 'ParamDef', id: 'GROUP', library: 'Ntve', paramType: { type: 'playergroup' } },
        PLAYER_VAR: { type: 'ParamDef', id: 'PLAYER_VAR', library: 'Ntve', paramType: { type: 'anyvariable', variableType: 'int' }, isReference: true },
        PLAYER: { type: 'ParamDef', id: 'PLAYER', library: 'Ntve', paramType: { type: 'int' } },
      },
      FunctionDef: {
        PICK: {
          type: 'FunctionDef', id: 'PICK', library: 'Ntve', name: 'PickEachInteger',
          parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'START' }, { type: 'ParamDef', library: 'Ntve', id: 'END' }],
          subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'ACTIONS' }],
          scriptCode: `#AUTOVAR(ae, int) = #PARAM(e);
            #AUTOVAR(var) = #PARAM(s);
            for ( ; #AUTOVAR(var) <= #AUTOVAR(ae); #AUTOVAR(var) += 1 ) { #SUBFUNCS(actions) }`,
        },
        PICK_LEGACY: {
          type: 'FunctionDef', id: 'PICK_LEGACY', library: 'Ntve', name: 'PickEachIntegerDeprecated',
          parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'START' }, { type: 'ParamDef', library: 'Ntve', id: 'END' }],
          subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'ACTIONS' }],
          scriptCode: `IntLoopBegin(#PARAM(s), #PARAM(e));
            for ( ; !IntLoopDone() ; IntLoopStep() ) { #SUBFUNCS(actions) }
            IntLoopEnd();`,
        },
        INTEGER_CURRENT: { type: 'FunctionDef', id: 'INTEGER_CURRENT', library: 'Ntve', name: 'IntLoopCurrent',
          parameters: [], returnType: { type: 'int' }, flags: ['Call', 'Operator'],
          scriptCode: '#AUTOVAR(var,ancestor:PickEachInteger)' },
        INTEGER_CURRENT_LEGACY: { type: 'FunctionDef', id: 'INTEGER_CURRENT_LEGACY', library: 'Ntve', name: 'IntLoopCurrentDeprecated',
          parameters: [], returnType: { type: 'int' }, flags: ['Call', 'Native'] },
        STOP: { type: 'FunctionDef', id: 'STOP', library: 'Ntve', name: 'StopLooping', parameters: [] },
        PICK_PLAYER_LEGACY: {
          type: 'FunctionDef', id: 'PICK_PLAYER_LEGACY', library: 'Ntve', name: 'PickEachPlayerInGroupDeprecated',
          parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'GROUP' }],
          subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'ACTIONS' }],
          scriptCode: `PlayerGroupLoopBegin(#PARAM(group));
            for ( ; !PlayerGroupLoopDone() ; PlayerGroupLoopStep() ) { #SUBFUNCS(actions); }
            PlayerGroupLoopEnd();`,
        },
        FOR_EACH_PLAYER_LEGACY: {
          type: 'FunctionDef', id: 'FOR_EACH_PLAYER_LEGACY', library: 'Ntve', name: 'ForEachPlayerInGroupDeprecated',
          parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'PLAYER_VAR' }, { type: 'ParamDef', library: 'Ntve', id: 'GROUP' }],
          subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'ACTIONS' }],
          scriptCode: `#AUTOVAR(g, playergroup) = #PARAM(group); #AUTOVAR(p) = 1;
            for (; #AUTOVAR(p) <= PlayerGroupCount(#AUTOVAR(g));
              #AUTOVAR(p) += BoolToInt(#PARAM(var) == PlayerGroupPlayer(#AUTOVAR(g), #AUTOVAR(p)))) {
              #PARAM(var) = PlayerGroupPlayer(#AUTOVAR(g), #AUTOVAR(p)); #SUBFUNCS(actions)
            }`,
        },
        PLAYER_CURRENT: { type: 'FunctionDef', id: 'PLAYER_CURRENT', library: 'Ntve', name: 'PlayerGroupLoopCurrent',
          parameters: [], returnType: { type: 'int' }, flags: ['Call', 'Operator'],
          scriptCode: '#AUTOVAR(var,ancestor:PickEachPlayerInGroup)' },
        PLAYER_CURRENT_LEGACY: { type: 'FunctionDef', id: 'PLAYER_CURRENT_LEGACY', library: 'Ntve', name: 'PlayerGroupLoopCurrentDeprecated',
          parameters: [], returnType: { type: 'int' }, flags: ['Call', 'Native'] },
        USE_PLAYER: { type: 'FunctionDef', id: 'USE_PLAYER', library: 'Ntve', name: 'UsePlayer',
          parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'PLAYER' }], flags: ['Action', 'Native'] },
      },
    },
  }
  nativeLibrary.elements = { ...nativeLibrary.elementsByType.SubFuncType, ...nativeLibrary.elementsByType.ParamDef, ...nativeLibrary.elementsByType.FunctionDef }
  return {
    libId: 'Map', elements: {}, nativeLibrary,
    funcNameToFuncDef: buildFuncNameToFuncDefMap(nativeLibrary),
    roleToSubFuncType: buildRoleToSubFuncTypeMap(nativeLibrary),
    localVarByGalaxyName: new Map([['init_i1', 'LOCAL']]), globalVarByGalaxyName: new Map(),
    pendingAutoInits: new Map(), pendingAutoEnds: new Map(), pendingAutoIncrements: new Map(),
    galaxyConstToPreset: new Map(),
  }
}

// COOP maps (06-MistOpportunities): a parameter can be the first expression converted in a
// context, and a call into a library that is not loaded must stay a template instead of
// becoming a reference to a function that exists in no loaded library.
describe('parameters that call an unloaded library', () => {
  it('never references the unloaded library', () => {
    const ctx = context()
    const source = parseGalaxySource('void Test() { int v = libZZZ_gf_Score(3) + 1; }')
    const declaration = [...(([...source.statements][0] as any).body.statements)][0] as any
    structuredParam(declaration.initializer, ctx)
    const fabricated = Object.values(ctx.elements).filter((element: any) =>
      element.type === 'FunctionCall' && element.functionDef?.library === 'ZZZ')
    expect(fabricated).toEqual([])
  })
})

function firstFor(code: string): any {
  const source = parseGalaxySource(`void Test() { ${code} }`)
  const fn = [...source.statements][0] as any
  return [...fn.body.statements].find((node: any) => node.kind === SyntaxKind.ForStatement)
}

describe('native counted-loop recovery', () => {
  it('recovers an inclusive unit-step Galaxy for as PickEachInteger', () => {
    const ctx = context()
    const ref = buildPickEachIntegerFromForStmt(firstFor('for (init_i1 = 0; init_i1 <= 10; init_i1 += 1) {}'), undefined, ctx)
    expect(ref).toBeDefined()
    expect((ctx.elements[ref!.id] as any).functionDef.id).toBe('PICK')
  })

  it('does not change the semantics of non-unit or exclusive loops', () => {
    expect(buildPickEachIntegerFromForStmt(firstFor('for (init_i1 = 0; init_i1 < 10; init_i1 += 1) {}'), undefined, context())).toBeUndefined()
    expect(buildPickEachIntegerFromForStmt(firstFor('for (init_i1 = 0; init_i1 <= 10; init_i1 += 2) {}'), undefined, context())).toBeUndefined()
  })
})

describe('authored control flow and parameter assignment', () => {
  function actionContext(): any {
    const ctx = context()
    ctx.nativeLibrary.elementsByType.SubFuncType.CONDITIONS = {
      type: 'SubFuncType', id: 'CONDITIONS', library: 'Ntve', identifier: 'Conditions', condition: true,
    }
    Object.assign(ctx.nativeLibrary.elementsByType.ParamDef, {
      TARGET: { type: 'ParamDef', id: 'TARGET', library: 'Ntve', name: 'var', identifier: 'var', paramType: { type: 'anyvariable' }, isReference: true },
      VALUE: { type: 'ParamDef', id: 'VALUE', library: 'Ntve', name: 'val', identifier: 'val', paramType: {
        type: 'sameas', typeElement: { type: 'ParamDef', library: 'Ntve', id: 'TARGET' },
      } },
      RETURN_VALUE: { type: 'ParamDef', id: 'RETURN_VALUE', library: 'Ntve', name: 'val', identifier: 'val', paramType: { type: 'return' } },
    })
    Object.assign(ctx.nativeLibrary.elementsByType.FunctionDef, {
      SET: { type: 'FunctionDef', id: 'SET', library: 'Ntve', name: 'SetVariable',
        scriptCode: '#PARAM(var) = #PARAM(val);',
        parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'TARGET' }, { type: 'ParamDef', library: 'Ntve', id: 'VALUE' }] },
      RETURN: { type: 'FunctionDef', id: 'RETURN', library: 'Ntve', name: 'Return',
        scriptCode: 'return #PARAM(val);',
        parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'RETURN_VALUE' }] },
      SKIP: { type: 'FunctionDef', id: 'SKIP', library: 'Ntve', name: 'SkipRemaining', parameters: [] },
      CHECK: { type: 'FunctionDef', id: 'CHECK', library: 'Ntve', name: 'Check', parameters: [], returnType: { type: 'bool' } },
      LAST_CONTROL: { type: 'FunctionDef', id: 'LAST_CONTROL', library: 'Ntve', name: 'DialogControlLastCreated', parameters: [], returnType: { type: 'control' } },
      WHILE2: { type: 'FunctionDef', id: 'WHILE2', library: 'Ntve', name: 'While2', parameters: [],
        subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'ACTIONS' }, { type: 'SubFuncType', library: 'Ntve', id: 'CONDITIONS' }] },
    })
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elementsByType.SubFuncType,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    ctx.paramRefByGalaxyName = new Map([['lp_count', { type: 'ParamDef', library: 'Map', id: 'COUNT' }]])
    ctx.elements.COUNT = { type: 'ParamDef', id: 'COUNT', library: 'Map', name: 'count', paramType: { type: 'int' }, isReference: true }
    ctx.isUserFunction = true
    ctx.returnType = 'void'
    return ctx
  }

  it('keeps a bare return as Skip Remaining Actions in a void user function', () => {
    const fn = parseGalaxySource('void Test() { return; }').statements[0] as any
    const ctx = actionContext()
    const ref = stmtToActionFCRef(fn.body.statements[0], undefined, ctx)
    expect(ref).toBeDefined()
    expect(ctx.elements[ref!.id].functionDef.id).toBe('SKIP')
  })

  it('uses a function parameter as the Set Variable reference target', () => {
    const fn = parseGalaxySource('void Test(int lp_count) { lp_count = 3; }').statements[0] as any
    const ctx = actionContext()
    const ref = stmtToActionFCRef(fn.body.statements[0], undefined, ctx)
    expect(ref).toBeDefined()
    const call = ctx.elements[ref!.id]
    expect(call.functionDef.id).toBe('SET')
    expect(ctx.elements[call.parameters[0].id].paramRef.id).toBe('COUNT')
    expect(ctx.elements[call.parameters[1].id].value).toBe('3')
  })

  it('uses the assignment target domain for a sameas value parameter', () => {
    const fn = parseGalaxySource('void Test() { tint = Color(100.0, 100.0, 100.0); }').statements[0] as any
    const ctx = actionContext()
    ctx.elements.TINT = { type: 'Variable', id: 'TINT', library: 'Map', name: 'tint', variableType: { type: 'color' } }
    ctx.globalVarByGalaxyName.set('tint', { type: 'Variable', library: 'Map', id: 'TINT' })

    const ref = stmtToActionFCRef(fn.body.statements[0], undefined, ctx)
    expect(ref).toBeDefined()
    const call = ctx.elements[ref!.id]
    expect(ctx.elements[call.parameters[1].id]).toMatchObject({
      value: '255,255,255,255',
      valueType: { type: 'color' },
    })
  })

  it('uses an array target domain when a loaded SetVariable template wins', () => {
    const fn = parseGalaxySource('void Test() { tint[1] = Color(100.0, 100.0, 100.0); }').statements[0] as any
    const ctx = actionContext()
    ctx.elements.TINT = { type: 'Variable', id: 'TINT', library: 'Map', name: 'tint', variableType: { type: 'color' }, isArray: true }
    ctx.globalVarByGalaxyName.set('tint', { type: 'Variable', library: 'Map', id: 'TINT' })

    const refs = structuredStatements([...fn.body.statements], ctx)
    const call = ctx.elements[refs[0].id]
    expect(call.functionDef.id).toBe('SET')
    expect(ctx.elements[call.parameters[1].id]).toMatchObject({
      value: '255,255,255,255',
      valueType: { type: 'color' },
    })
  })

  // TextureMap.galaxy of Ice Baneling: 2040 `tm[i] = "…" + "…";` became Arithmetic (Integer).
  it('combines strings assigned to a string array element instead of adding integers', () => {
    const fn = parseGalaxySource('void Test() { names[1] = "ab" + "cd"; }').statements[0] as any
    const ctx = actionContext()
    const param = (id: string, type: string) => ({ type: 'ParamDef', id, library: 'Ntve', paramType: { type } })
    const refs = (...ids: string[]) => ids.map(id => ({ type: 'ParamDef', library: 'Ntve', id }))
    Object.assign(ctx.nativeLibrary.elementsByType.ParamDef, {
      INT_LEFT: param('INT_LEFT', 'int'), INT_OP: param('INT_OP', 'preset'), INT_RIGHT: param('INT_RIGHT', 'int'),
      STRING_LEFT: param('STRING_LEFT', 'string'), STRING_RIGHT: param('STRING_RIGHT', 'string'),
    })
    Object.assign(ctx.nativeLibrary.elementsByType.FunctionDef, {
      ADD: { type: 'FunctionDef', id: 'ADD', library: 'Ntve', name: 'ArithmeticInt', flags: ['Call', 'Operator'],
        returnType: { type: 'int' }, parameters: refs('INT_LEFT', 'INT_OP', 'INT_RIGHT') },
      COMBINE: { type: 'FunctionDef', id: 'COMBINE', library: 'Ntve', name: 'CombineStrings', flags: ['Call', 'Operator'],
        returnType: { type: 'string' }, parameters: refs('STRING_LEFT', 'STRING_RIGHT') },
    })
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elements,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    ctx.elements.NAMES = { type: 'Variable', id: 'NAMES', library: 'Map', name: 'names', variableType: { type: 'string' }, isArray: true }
    ctx.globalVarByGalaxyName.set('names', { type: 'Variable', library: 'Map', id: 'NAMES' })

    const refsOut = structuredStatements([...fn.body.statements], ctx)
    const call = ctx.elements[refsOut[0].id]
    expect(call.functionDef.id).toBe('SET')
    const value = ctx.elements[call.parameters[1].id]
    expect(ctx.elements[value.functionCall.id].functionDef.id).toBe('COMBINE')
  })

  it('refines an integer-backed local handle from the assigned function contract', () => {
    const fn = parseGalaxySource('void Test() { int lv_s; lv_s = DialogControlLastCreated(); }').statements[0] as any
    const ctx = actionContext()
    ctx.structuredLocals = []

    const refs = structuredStatements([...fn.body.statements], ctx)
    expect(refs).toHaveLength(1)
    expect(ctx.structuredLocals).toHaveLength(1)
    expect(ctx.elements[ctx.structuredLocals[0].id].variableType).toEqual({ type: 'control' })
    expect(ctx.elements[refs[0].id].functionDef.id).toBe('SET')
  })

  it('uses the authored function return type for a loaded Return template', () => {
    const fn = parseGalaxySource('color Test() { return Color(100.0, 0.0, 0.0); }').statements[0] as any
    const ctx = actionContext()
    ctx.returnType = 'color'

    const refs = structuredStatements([...fn.body.statements], ctx)
    const call = ctx.elements[refs[0].id]
    expect(ctx.elements[call.parameters[0].id]).toMatchObject({
      value: '255,255,0,0',
      valueType: { type: 'color' },
    })
  })

  function ifContext(): any {
    const ctx = actionContext()
    const role = (id: string, identifier: string) => ({ type: 'SubFuncType', id, library: 'Ntve', identifier, isAction: true })
    Object.assign(ctx.nativeLibrary.elementsByType.SubFuncType, {
      ELSE_IF: role('ELSE_IF', 'If'), ELSE_THEN: role('ELSE_THEN', 'Then'), ELSE_ELSE: role('ELSE_ELSE', 'Else'),
      BRANCHES: role('BRANCHES', 'IfThen'), BRANCH_IF: role('BRANCH_IF', 'if'), BRANCH_THEN: role('BRANCH_THEN', 'then'),
    })
    const roles = (...ids: string[]) => ids.map(id => ({ type: 'SubFuncType', library: 'Ntve', id }))
    Object.assign(ctx.nativeLibrary.elementsByType.FunctionDef, {
      IF_ELSE: { type: 'FunctionDef', id: 'IF_ELSE', library: 'Ntve', name: 'IfThenElse', parameters: [], subFunctionTypes: roles('ELSE_IF', 'ELSE_THEN', 'ELSE_ELSE') },
      IF_MULTI: { type: 'FunctionDef', id: 'IF_MULTI', library: 'Ntve', name: 'IfThenMultiple', parameters: [], subFunctionTypes: roles('BRANCHES') },
      IF_THEN: { type: 'FunctionDef', id: 'IF_THEN', library: 'Ntve', name: 'IfThen', parameters: [], flags: ['Action', 'SubFunctions', 'Hidden'],
        subFunctionTypes: roles('BRANCH_IF', 'BRANCH_THEN'), scriptCode: '#IFSUBFUNC(notfirst,else )if (#SUBFUNCS(if," && ")) { #SUBFUNCS(then) }' },
    })
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elementsByType.SubFuncType,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    return ctx
  }

  // Editor oracle (Star Party v): about 100 `else if` chains came back as nested
  // If Then Else, which the editor regenerates as `else { if … }`.
  it.each([
    ['an else-if chain', 'if (Check()) { lp_count = 1; } else if (Check()) { lp_count = 2; }', 'IF_MULTI'],
    ['an else branch that braces its if', 'if (Check()) { lp_count = 1; } else { if (Check()) { lp_count = 2; } }', 'IF_ELSE'],
  ])('restores %s with the editor action that prints it', (_shape, code, expected) => {
    const fn = parseGalaxySource(`void Test(int lp_count) { ${code} }`).statements[0] as any
    const ctx = ifContext()
    const ref = stmtToActionFCRef(fn.body.statements[0], undefined, ctx)
    const call = ctx.elements[ref!.id]
    expect(call.functionDef.id).toBe(expected)
    if (expected === 'IF_MULTI') {
      expect(call.subFunctions.map((child: any) => ctx.elements[child.id].functionDef.id)).toEqual(['IF_THEN', 'IF_THEN'])
      expect(call.subFunctions.map((child: any) => ctx.elements[child.id].subFunctionType.id)).toEqual(['BRANCHES', 'BRANCHES'])
      for (const child of call.subFunctions) {
        expect(ctx.elements[child.id].subFunctions.map((item: any) => ctx.elements[item.id].subFunctionType.id).sort()).toEqual(['BRANCH_IF', 'BRANCH_THEN'])
      }
    }
  })

  // Editor oracle (Star Party v): Switch was recognized only outside function
  // bodies, so its auto value became a Set Variable over a local and an If chain.
  it('restores Switch inside a structured function body without its auto value local', () => {
    resetGalaxyToTriggerIdCounter()
    const fn = parseGalaxySource(`void Test(int lp_count) {
      int auto44444444_val;
      auto44444444_val = lp_count;
      if (auto44444444_val == 1) { lp_count = 2; }
      else if (auto44444444_val == 2) { lp_count = 3; }
    }`).statements[0] as any
    const ctx = actionContext()
    const role = (id: string, identifier: string) => ({ type: 'SubFuncType', id, library: 'Ntve', identifier, isAction: true })
    Object.assign(ctx.nativeLibrary.elementsByType.SubFuncType, { CASES: role('CASES', 'Cases'), DEFAULTS: role('DEFAULTS', 'Defaults'), CASE_ACTIONS: role('CASE_ACTIONS', 'Actions') })
    Object.assign(ctx.nativeLibrary.elementsByType.ParamDef, {
      SWITCH_VALUE: { type: 'ParamDef', id: 'SWITCH_VALUE', library: 'Ntve', name: 'value', identifier: 'value', paramType: { type: 'int' } },
      CASE_VALUE: { type: 'ParamDef', id: 'CASE_VALUE', library: 'Ntve', name: 'value', identifier: 'value', paramType: { type: 'int' } },
    })
    Object.assign(ctx.nativeLibrary.elementsByType.FunctionDef, {
      SWITCH: { type: 'FunctionDef', id: 'SWITCH', library: 'Ntve', name: 'Switch', parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'SWITCH_VALUE' }],
        subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'CASES' }, { type: 'SubFuncType', library: 'Ntve', id: 'DEFAULTS' }] },
      SWITCH_CASE: { type: 'FunctionDef', id: 'SWITCH_CASE', library: 'Ntve', name: 'SwitchCase', parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'CASE_VALUE' }],
        subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'CASE_ACTIONS' }] },
    })
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elementsByType.SubFuncType,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    ctx.structuredLocals = []

    const refs = structuredStatements([...fn.body.statements], ctx)
    expect(refs.map(ref => ctx.elements[ref.id].functionDef.id)).toEqual(['SWITCH'])
    // The editor names the auto value after the Switch call: auto44444444_val.
    expect(refs[0].id).toBe('44444444')
    const cases = ctx.elements[refs[0].id].subFunctions.map((child: any) => ctx.elements[child.id])
    expect(cases.map((call: any) => call.functionDef.id)).toEqual(['SWITCH_CASE', 'SWITCH_CASE'])
    expect(ctx.structuredLocals).toEqual([])
  })

  it('keeps an unrelated nested if inside the Switch default branch', () => {
    const fn = parseGalaxySource(`void Test(string value, int player) {
      string auto4367001A_val;
      auto4367001A_val = value;
      if (auto4367001A_val == "0003") { UsePlayer(3); }
      else if (auto4367001A_val == "0002") { UsePlayer(2); }
      else { if (player == 1) { UsePlayer(1); } else { UsePlayer(0); } }
    }`).statements[0] as any
    const chain = parseSwitchIfChain(fn.body.statements[2], 'auto4367001A_val')
    expect(chain?.cases).toHaveLength(2)
    expect(chain?.defaultStmts).toHaveLength(1)
    expect(chain?.defaultStmts[0].kind).toBe(SyntaxKind.IfStatement)
  })

  // Rainbow Arena (MD5): a bitwise return value has no native operator and came
  // back as `return null;`.
  it('keeps a return value without a native operator as a template instead of null', () => {
    const fn = parseGalaxySource('int Test(int lp_count) { return (lp_count << 2) | 1; }').statements[0] as any
    const ctx = actionContext()
    ctx.returnType = 'int'
    const refs = structuredStatements([...fn.body.statements], ctx)
    const call = ctx.elements[refs[0].id]
    expect(call.functionDef.id).toBe('RETURN')
    const value = ctx.elements[call.parameters[0].id]
    expect(ctx.elements[ctx.elements[value.functionCall.id].functionDef.id].scriptCode).toBe('#PARAM(left) | #PARAM(right)')
  })

  // Mercs Episode 1 needs a mod that is not installed: this condition became a
  // FunctionDef reference that no loaded library defines, failing the whole map.
  it('keeps a call without a loaded definition in a structured condition as a template', () => {
    const fn = parseGalaxySource('void Test(int lp_count) { if (libDBC6B6C4_gf_Missing(lp_count)) { lp_count = 2; } }').statements[0] as any
    const ctx = ifContext()
    const refs = structuredStatements([...fn.body.statements], ctx)
    const call = ctx.elements[refs[0].id]
    expect(call.functionDef.id).toBe('IF_ELSE')
    const condition = ctx.elements[call.subFunctions[0].id]
    expect(ctx.elements[condition.functionDef.id]).toMatchObject({
      type: 'FunctionDef', scriptCode: 'libDBC6B6C4_gf_Missing(#PARAM(argument1))',
    })
  })

  it('restores a do-while as the loaded While2 contract instead of Custom Script', () => {
    const fn = parseGalaxySource('void Test(int lp_count) { do { lp_count = 3; } while (Check()); }').statements[0] as any
    const ctx = actionContext()

    const ref = stmtToActionFCRef(fn.body.statements[0], undefined, ctx)
    expect(ref).toBeDefined()
    const call = ctx.elements[ref!.id]
    expect(call.functionDef.id).toBe('WHILE2')
    expect(call.scriptCode).toBeUndefined()
    expect(call.subFunctions.map((item: any) => ctx.elements[item.id].subFunctionType.id)).toEqual(['CONDITIONS', 'ACTIONS'])
  })

  it('recovers an editor auto counter assignment followed by PickEachInteger', () => {
    resetGalaxyToTriggerIdCounter()
    const source = parseGalaxySource(`void Test() {
      const int auto25C6AB35_ae = 34;
      int auto25C6AB35_var;
      auto25C6AB35_var = 23;
      for (; auto25C6AB35_var <= auto25C6AB35_ae; auto25C6AB35_var += 1) { break; }
    }`) as any
    const ctx = context()
    ctx.structuredLocals = []

    const refs = structuredStatements([...source.statements[0].body.statements], ctx)
    expect(refs).toHaveLength(1)
    const loop: any = ctx.elements[refs[0]!.id]
    expect(loop.functionDef.id).toBe('PICK')
    expect(loop.id).toBe('25C6AB35')
    expect(loop.subFunctions).toHaveLength(1)
    expect(ctx.elements[loop.subFunctions[0].id].functionDef.id).toBe('STOP')
    expect(ctx.structuredLocals).toHaveLength(0)
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'For Statement')).toBe(false)
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'Binary Expression')).toBe(false)
  })

  // Editor oracle (Star Party v): the statement right before `autoX_var = 1; for`
  // vanished because the PickEachInteger match started one statement early.
  it('keeps the statement that precedes an editor auto counter loop', () => {
    const source = parseGalaxySource(`void Test() {
      const int auto25C6AB35_ae = 34;
      int auto25C6AB35_var;
      UsePlayer(3);
      auto25C6AB35_var = 23;
      for (; auto25C6AB35_var <= auto25C6AB35_ae; auto25C6AB35_var += 1) { break; }
    }`) as any
    const ctx = context()
    ctx.structuredLocals = []

    const refs = structuredStatements([...source.statements[0].body.statements], ctx)
    expect(refs.map(ref => (ctx.elements[ref.id] as any).functionDef.id)).toEqual(['USE_PLAYER', 'PICK'])
  })

  // The editor expands ScriptCode only for Operator/SubFunctions definitions; a
  // <Template/> holder compiled to undefined lf_ExpressionStatement,
  // lf_BinaryExpression and lf_TriggerAddEventUnitRegion calls.
  it('flags synthesized templates as editor inline definitions, never as Template', () => {
    const fn = parseGalaxySource('void Test(int lp_count) { for (; lp_count > 0; lp_count -= 3) { lp_count = lp_count << 1; } }').statements[0] as any
    const ctx = actionContext()
    ctx.elements.COUNT = { type: 'ParamDef', id: 'COUNT', library: 'Map', name: 'count', paramType: { type: 'int' } }
    ctx.paramRefByGalaxyName = new Map([['lp_count', { type: 'ParamDef', library: 'Map', id: 'COUNT' }]])

    structuredStatements([...fn.body.statements], ctx)
    const synthesized = Object.values(ctx.elements).filter((element: any) => element.type === 'FunctionDef') as any[]
    expect(synthesized.map(definition => definition.name)).toContain('For Statement')
    for (const definition of synthesized) {
      expect(definition.scriptCode).toBeTruthy()
      expect(definition.flags).not.toContain('Template')
      expect(definition.flags).toContain(definition.subFunctionTypes?.length ? 'SubFunctions' : 'Operator')
    }
  })

  it('uses a member of a structref function parameter as the Set Variable target', () => {
    const fn = parseGalaxySource('void Test(structref<State> lp_state) { lp_state.lv_value = 3; }').statements[0] as any
    const ctx = actionContext()
    ctx.elements.STATE = { type: 'Structure', id: 'STATE', library: 'Map', name: 'State', variables: [{ type: 'Variable', library: 'Map', id: 'VALUE_MEMBER' }] }
    ctx.elements.VALUE_MEMBER = { type: 'Variable', id: 'VALUE_MEMBER', library: 'Map', name: 'value', variableType: { type: 'int' } }
    ctx.elements.STATE_PARAM = { type: 'ParamDef', id: 'STATE_PARAM', library: 'Map', name: 'state', paramType: { type: 'struct', typeElement: { type: 'Structure', library: 'Map', id: 'STATE' } }, isReference: true }
    ctx.paramRefByGalaxyName = new Map([['lp_state', { type: 'ParamDef', library: 'Map', id: 'STATE_PARAM' }]])
    ctx.structureMemberByKey = new Map([['STATE:lv_value', { type: 'Variable', library: 'Map', id: 'VALUE_MEMBER' }]])

    const ref = stmtToActionFCRef(fn.body.statements[0], undefined, ctx)
    expect(ref).toBeDefined()
    const call = ctx.elements[ref!.id]
    const target = ctx.elements[call.parameters[0].id]
    const member = ctx.elements[target.structMember.id]
    expect(target.paramRef.id).toBe('STATE_PARAM')
    expect(member.variable.id).toBe('VALUE_MEMBER')
    expect(ctx.elements[call.parameters[1].id].value).toBe('3')
  })

  it('lowers a compound assignment in a user function without synthesizing an Expression Statement template', () => {
    const fn = parseGalaxySource('void Test() { gv_video[lp_count].lv_frame += 24; }').statements[0] as any
    const ctx = actionContext()
    Object.assign(ctx.nativeLibrary.elementsByType.ParamDef, {
      INC_TARGET: { type: 'ParamDef', id: 'INC_TARGET', library: 'Ntve', name: 'var', paramType: { type: 'anyvariable', variableType: { type: 'int' } }, isReference: true },
      INC_OPERATOR: { type: 'ParamDef', id: 'INC_OPERATOR', library: 'Ntve', name: 'operator', paramType: { type: 'preset' } },
      INC_VALUE: { type: 'ParamDef', id: 'INC_VALUE', library: 'Ntve', name: 'val', paramType: { type: 'int' } },
    })
    ctx.nativeLibrary.elementsByType.FunctionDef.INCREMENT = {
      type: 'FunctionDef', id: 'INCREMENT', library: 'Ntve', name: 'IncrementInteger', flags: ['Action', 'Operator'],
      parameters: [
        { type: 'ParamDef', library: 'Ntve', id: 'INC_TARGET' },
        { type: 'ParamDef', library: 'Ntve', id: 'INC_OPERATOR' },
        { type: 'ParamDef', library: 'Ntve', id: 'INC_VALUE' },
      ],
      scriptCode: '#PARAM(var) #PARAM(operator)= #PARAM(val);',
    }
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elementsByType.SubFuncType,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    ctx.elements.VIDEO = { type: 'Variable', id: 'VIDEO', library: 'Map', name: 'video', variableType: { type: 'struct', typeElement: { type: 'Structure', library: 'Map', id: 'VIDEO_STRUCT' } }, isArray: true }
    ctx.elements.FRAME = { type: 'Variable', id: 'FRAME', library: 'Map', name: 'frame', variableType: { type: 'int' } }
    ctx.structureMemberByKey = new Map([['VIDEO_STRUCT:lv_frame', { type: 'Variable', library: 'Map', id: 'FRAME' }]])
    ctx.globalVarByGalaxyName.set('gv_video', { type: 'Variable', library: 'Map', id: 'VIDEO' })

    const refs = structuredStatements([...fn.body.statements], ctx)
    expect(refs).toHaveLength(1)
    const call = ctx.elements[refs[0]!.id]
    expect(call.functionDef.id).toBe('INCREMENT')
    const target = ctx.elements[call.parameters[0].id]
    expect(target.variable.id).toBe('VIDEO')
    expect(ctx.elements[target.structMember.id].variable.id).toBe('FRAME')
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'Expression Statement')).toBe(false)
  })

  it('lowers a compound array assignment whose index is a resolved call', () => {
    const fn = parseGalaxySource('void Test() { gv_playerskills[KillingPlayer()] += 1; }').statements[0] as any
    const ctx = actionContext()
    Object.assign(ctx.nativeLibrary.elementsByType.ParamDef, {
      INC_TARGET: { type: 'ParamDef', id: 'INC_TARGET', library: 'Ntve', name: 'var', paramType: { type: 'anyvariable', variableType: { type: 'int' } }, isReference: true },
      INC_OPERATOR: { type: 'ParamDef', id: 'INC_OPERATOR', library: 'Ntve', name: 'operator', paramType: { type: 'preset' } },
      INC_VALUE: { type: 'ParamDef', id: 'INC_VALUE', library: 'Ntve', name: 'val', paramType: { type: 'int' } },
    })
    Object.assign(ctx.nativeLibrary.elementsByType.FunctionDef, {
      INCREMENT: { type: 'FunctionDef', id: 'INCREMENT', library: 'Ntve', name: 'IncrementInteger', flags: ['Action', 'Operator'],
        parameters: [
          { type: 'ParamDef', library: 'Ntve', id: 'INC_TARGET' },
          { type: 'ParamDef', library: 'Ntve', id: 'INC_OPERATOR' },
          { type: 'ParamDef', library: 'Ntve', id: 'INC_VALUE' },
        ], scriptCode: '#PARAM(var) #PARAM(operator)= #PARAM(val);' },
      KILLING_PLAYER: { type: 'FunctionDef', id: 'KILLING_PLAYER', library: 'Ntve', name: 'KillingPlayer', flags: ['Call'], returnType: { type: 'int' }, parameters: [] },
    })
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elementsByType.SubFuncType,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    ctx.elements.PLAYER_SKILLS = { type: 'Variable', id: 'PLAYER_SKILLS', library: 'Map', name: 'playerskills', variableType: { type: 'int' }, isArray: true }
    ctx.globalVarByGalaxyName.set('gv_playerskills', { type: 'Variable', library: 'Map', id: 'PLAYER_SKILLS' })

    const refs = structuredStatements([...fn.body.statements], ctx)
    expect(refs).toHaveLength(1)
    const increment: any = ctx.elements[refs[0]!.id]
    expect(increment.functionDef.id).toBe('INCREMENT')
    const target: any = ctx.elements[increment.parameters[0].id]
    const index: any = ctx.elements[target.array.id]
    expect(ctx.elements[index.functionCall.id].functionDef.id).toBe('KILLING_PLAYER')
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'Expression Statement')).toBe(false)
  })

  it('rewrites proven bindings inside a Custom Script fallback without touching unknown calls', () => {
    const text = 'void Test() { gv_units[i] = unknown(); gt_Ready_Init(); }'
    const source = parseGalaxySource(text) as any
    const [assignment, initializer] = source.statements[0].body.statements
    const ctx = actionContext()
    ctx.sourceText = text
    ctx.pickEachIntVarName = 'i'
    ctx.elements.UNITS = { type: 'Variable', id: 'UNITS', library: 'Map', name: 'units', variableType: { type: 'unit' }, isArray: true }
    ctx.elements.READY = { type: 'Trigger', id: 'READY', library: 'Map', name: 'Ready', events: [], conditions: [], actions: [], localVariables: [] }
    ctx.globalVarByGalaxyName.set('gv_units', { type: 'Variable', library: 'Map', id: 'UNITS' })
    ctx.triggerByGalaxyName = new Map([
      ['gt_Ready', { type: 'Trigger', library: 'Map', id: 'READY' }],
    ])
    ctx.nativeLibrary.elementsByType.FunctionDef.CUSTOM = { type: 'FunctionDef', id: 'CUSTOM', library: 'Ntve', name: 'CustomScriptAction', parameters: [], isFuncAction: true }
    ctx.nativeLibrary.elements.CUSTOM = ctx.nativeLibrary.elementsByType.FunctionDef.CUSTOM
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)

    // Exercise the range-less wrapper used when an unresolved call appears
    // inside an otherwise ordinary expression statement.
    const ref = buildCustomScriptActionFCRef({ kind: SyntaxKind.ExpressionStatement, expression: assignment.expression }, undefined, ctx)
    // IntLoopCurrent() reads only a deprecated IntLoopBegin loop, so the iterator
    // keeps its spelling; the loop recognizer rejects a body that reads it.
    expect(ctx.elements[ref.id].scriptCode).toBe('libMap_gv_units[i] = unknown();')
    const initRef = buildCustomScriptActionFCRef({ kind: SyntaxKind.ExpressionStatement, expression: initializer.expression }, undefined, ctx)
    expect(ctx.elements[initRef.id].scriptCode).toBe('libMap_gt_Ready_Init();')
  })

  it('prints the AST instead of slicing offsets from a different source document', () => {
    const parsed = parseGalaxySource('void Test() { unknown(); }') as any
    const statement = parsed.statements[0].body.statements[0]
    const ctx = actionContext()
    ctx.sourceText = 'void Other() { prefix(); damaged(); }'
    ctx.nativeLibrary.elementsByType.FunctionDef.CUSTOM = {
      type: 'FunctionDef', id: 'CUSTOM', library: 'Ntve', name: 'CustomScriptAction',
      flags: ['Action', 'CustomScript'], parameters: [], isFuncAction: true,
    }
    ctx.nativeLibrary.elements.CUSTOM = ctx.nativeLibrary.elementsByType.FunctionDef.CUSTOM
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)

    const ref = buildCustomScriptActionFCRef(statement, undefined, ctx)
    expect(ctx.elements[ref.id].scriptCode).toBe('unknown();')
  })

  // Mercs Episode 1: a Custom Script sliced from a CRLF MapScript failed the
  // service's save-and-reload check, because ScriptCode reads back with LF.
  it('stores a Custom Script sliced from a CRLF source with LF line breaks', () => {
    const text = 'void Test() {\r\n    if (unknown()) {\r\n        other();\r\n    }\r\n}'
    const statement = (parseGalaxySource(text).statements[0] as any).body.statements[0]
    const ctx = actionContext()
    ctx.sourceText = text
    ctx.nativeLibrary.elementsByType.FunctionDef.CUSTOM = { type: 'FunctionDef', id: 'CUSTOM', library: 'Ntve', name: 'CustomScriptAction', parameters: [], isFuncAction: true }
    ctx.nativeLibrary.elements.CUSTOM = ctx.nativeLibrary.elementsByType.FunctionDef.CUSTOM
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)

    const ref = buildCustomScriptActionFCRef(statement, undefined, ctx)
    expect(ctx.elements[ref.id].scriptCode).toBe('if (unknown()) {\n        other();\n    }')
  })

  it('preserves a dynamically targeted event native as Custom Script', () => {
    const text = 'void Test() { TriggerAddEventUnitRegion(gt_Target, null, lv_region, false); }'
    const fn = parseGalaxySource(text).statements[0] as any
    const ctx = actionContext()
    ctx.sourceText = text
    Object.assign(ctx.nativeLibrary.elementsByType.FunctionDef, {
      EVENT: { type: 'FunctionDef', id: 'EVENT', library: 'Ntve', name: 'TriggerAddEventUnitRegion', flags: ['Event', 'Native'], parameters: [] },
      CUSTOM: { type: 'FunctionDef', id: 'CUSTOM', library: 'Ntve', name: 'CustomScriptAction', flags: ['Action', 'CustomScript'], parameters: [], isFuncAction: true },
    })
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elementsByType.SubFuncType,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)

    const ref = stmtToActionFCRef(fn.body.statements[0], undefined, ctx)
    expect(ref).toBeDefined()
    expect(ctx.elements[ref!.id].functionDef.id).toBe('CUSTOM')
    expect(ctx.elements[ref!.id].scriptCode).toBe('TriggerAddEventUnitRegion(gt_Target, null, lv_region, false);')
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionCall' && element.functionDef?.id === 'EVENT')).toBe(false)
  })

  it('unwraps a logical condition compared with true instead of emitting a null value', () => {
    const ctx = actionContext()
    Object.assign(ctx.nativeLibrary.elementsByType.ParamDef, {
      LEFT: { type: 'ParamDef', id: 'LEFT', library: 'Ntve', paramType: { type: 'anyvariable' } },
      OP: { type: 'ParamDef', id: 'OP', library: 'Ntve', paramType: { type: 'operator' } },
      RIGHT: { type: 'ParamDef', id: 'RIGHT', library: 'Ntve', paramType: { type: 'sameas' } },
    })
    ctx.nativeLibrary.elementsByType.FunctionDef.COMPARISON = {
      type: 'FunctionDef', id: 'COMPARISON', library: 'Ntve', name: 'Comparison',
      parameters: [
        { type: 'ParamDef', library: 'Ntve', id: 'LEFT' },
        { type: 'ParamDef', library: 'Ntve', id: 'OP' },
        { type: 'ParamDef', library: 'Ntve', id: 'RIGHT' },
      ],
    }
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elementsByType.SubFuncType,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    ctx.elements.A = { type: 'Variable', id: 'A', library: 'Map', name: 'a', variableType: { type: 'int' } }
    ctx.localVarByGalaxyName.set('a', 'A')
    const fn = parseGalaxySource('void Test() { if ((((a >= 150) && (a <= 200)) == true)) {} }').statements[0] as any
    const refs = collectConditionRefs(fn.body.statements[0].expression, undefined, ctx)

    expect(refs).toHaveLength(2)
    const calls = refs.map(ref => ctx.elements[ref.id])
    expect(calls.every(call => call.functionDef.id === 'COMPARISON')).toBe(true)
    const params = calls.flatMap(call => call.parameters.map((ref: any) => ctx.elements[ref.id]))
    expect(params.some((param: any) => param.value === 'null')).toBe(false)

    // Editor oracle (Star Party v): a value compared with a boolean literal is the
    // Comparison the editor prints as `(F() == false)`, not Not(F()).
    const valueFn = parseGalaxySource('void Test() { if ((Check() == false)) {} }').statements[0] as any
    const valueRefs = collectConditionRefs(valueFn.body.statements[0].expression, undefined, ctx)
    expect(valueRefs.map(ref => ctx.elements[ref.id].functionDef.id)).toEqual(['COMPARISON'])
  })

  it('recovers the legacy editor player-group loop as its loaded trigger action', () => {
    const source = parseGalaxySource(`void Test() {
      PlayerGroupLoopBegin(gv_players);
      for ( ; !PlayerGroupLoopDone() ; PlayerGroupLoopStep() ) { break; }
      PlayerGroupLoopEnd();
    }`) as any
    const ctx = context()
    ctx.elements.PLAYERS = { type: 'Variable', id: 'PLAYERS', library: 'Map', name: 'players', variableType: { type: 'playergroup' } }
    ctx.globalVarByGalaxyName.set('gv_players', { type: 'Variable', library: 'Map', id: 'PLAYERS' })

    const refs = structuredStatements([...source.statements[0].body.statements], ctx)
    expect(refs).toHaveLength(1)
    const loop = ctx.elements[refs[0].id]
    expect(loop.functionDef.id).toBe('PICK_PLAYER_LEGACY')
    expect(loop.parameters).toHaveLength(1)
    expect(ctx.elements[loop.parameters[0].id].variable.id).toBe('PLAYERS')
    expect(loop.subFunctions).toHaveLength(1)
    expect(ctx.elements[loop.subFunctions[0].id].functionDef.id).toBe('STOP')
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'For Statement')).toBe(false)
  })

  it('uses the loaded deprecated native accessor inside a legacy player-group loop', () => {
    const source = parseGalaxySource(`void Test() {
      PlayerGroupLoopBegin(gv_players);
      for ( ; !PlayerGroupLoopDone() ; PlayerGroupLoopStep() ) { UsePlayer(PlayerGroupLoopCurrent()); }
      PlayerGroupLoopEnd();
    }`) as any
    const ctx = context()
    ctx.elements.PLAYERS = { type: 'Variable', id: 'PLAYERS', library: 'Map', name: 'players', variableType: { type: 'playergroup' } }
    ctx.globalVarByGalaxyName.set('gv_players', { type: 'Variable', library: 'Map', id: 'PLAYERS' })

    const refs = structuredStatements([...source.statements[0].body.statements], ctx)
    const loop = ctx.elements[refs[0].id]
    const action = ctx.elements[loop.subFunctions[0].id]
    const argument = ctx.elements[action.parameters[0].id]
    const accessor = ctx.elements[argument.functionCall.id]
    expect(accessor.functionDef.id).toBe('PLAYER_CURRENT_LEGACY')
    const namingCtx: any = {
      libId: 'Map', library: { id: 'Map', items: [], elements: {}, elementsByType: {} },
      nativeLibrary: ctx.nativeLibrary, allLibraries: new Map([['Ntve', ctx.nativeLibrary]]),
      templateScopes: [{ definition: ctx.nativeLibrary.elementsByType.FunctionDef.PICK_PLAYER_LEGACY, variables: new Map() }],
    }
    expect(toGalaxyFunctionName(ctx.nativeLibrary.elementsByType.FunctionDef.PLAYER_CURRENT_LEGACY, namingCtx)).toBe('PlayerGroupLoopCurrent')
  })

  it('recovers the deprecated indexed player-group loop and removes its private auto locals', () => {
    const source = parseGalaxySource(`void Test(playergroup lp_group) {
      playergroup autoABCDEF12_g;
      int autoABCDEF12_p;
      int lv_player;
      autoABCDEF12_g = lp_group;
      autoABCDEF12_p = 1;
      for (; autoABCDEF12_p <= PlayerGroupCount(autoABCDEF12_g);
        autoABCDEF12_p += BoolToInt(lv_player == PlayerGroupPlayer(autoABCDEF12_g, autoABCDEF12_p))) {
        lv_player = PlayerGroupPlayer(autoABCDEF12_g, autoABCDEF12_p);
        break;
      }
    }`) as any
    const ctx = context()
    ctx.paramRefByGalaxyName = new Map([['lp_group', { type: 'ParamDef', library: 'Map', id: 'INPUT_GROUP' }]])
    ctx.elements.INPUT_GROUP = { type: 'ParamDef', id: 'INPUT_GROUP', library: 'Map', name: 'group', paramType: { type: 'playergroup' } }
    ctx.structuredLocals = []

    const refs = structuredStatements([...source.statements[0].body.statements], ctx)
    expect(refs).toHaveLength(1)
    const loop = ctx.elements[refs[0].id]
    expect(loop.functionDef.id).toBe('FOR_EACH_PLAYER_LEGACY')
    expect(loop.parameters).toHaveLength(2)
    expect(loop.subFunctions).toHaveLength(1)
    expect(ctx.elements[loop.subFunctions[0].id].functionDef.id).toBe('STOP')
    expect(ctx.structuredLocals.map((ref: any) => ctx.elements[ref.id].name)).toEqual(['player'])
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'For Statement')).toBe(false)
  })

  it('recovers the complete loaded IntLoop begin/for/end template atomically', () => {
    const source = parseGalaxySource(`void Test() {
      IntLoopBegin(0, 11);
      for ( ; !IntLoopDone() ; IntLoopStep() ) { UsePlayer(1); }
      IntLoopEnd();
    }`) as any
    const ctx = context()
    ctx.structuredLocals = []

    const template = compileTemplateVariants(ctx.nativeLibrary.elementsByType.FunctionDef.PICK_LEGACY, [ctx.nativeLibrary])[0]
    expect(template).toBeDefined()
    expect(matchTemplatePrefix(template, [...source.statements[0].body.statements])).toBeDefined()

    const refs = structuredStatements([...source.statements[0].body.statements], ctx)
    expect(refs).toHaveLength(1)
    const loop: any = ctx.elements[refs[0].id]
    expect(loop.functionDef.id).toBe('PICK_LEGACY')
    expect(loop.scriptCode).toBeUndefined()
    expect(loop.subFunctions).toHaveLength(1)
    expect(ctx.elements[loop.subFunctions[0].id].functionDef.id).toBe('USE_PLAYER')
    expect(Object.values(ctx.elements).some((element: any) => element.scriptCode?.includes('IntLoopDone'))).toBe(false)
  })

  it('recovers a loaded IntLoop sequence atomically inside an else role', () => {
    const source = parseGalaxySource(`void Test(bool lp_ready) {
      if (lp_ready) { UsePlayer(1); }
      else {
        IntLoopBegin(0, 11);
        for ( ; !IntLoopDone() ; IntLoopStep() ) { UsePlayer(IntLoopCurrent()); }
        IntLoopEnd();
      }
    }`) as any
    const ctx = context()
    ctx.structuredLocals = []

    const refs = structuredStatements([...source.statements[0].body.statements], ctx)
    expect(refs).toHaveLength(1)
    const calls = Object.values(ctx.elements).filter((element: any) => element.type === 'FunctionCall') as any[]
    const loops = calls.filter(call => call.functionDef?.id === 'PICK_LEGACY')
    expect(loops).toHaveLength(1)
    expect(loops[0].subFunctions).toHaveLength(1)
    expect(ctx.elements[loops[0].subFunctions[0].id].functionDef.id).toBe('USE_PLAYER')
    const accessorParam = ctx.elements[ctx.elements[loops[0].subFunctions[0].id].parameters[0].id]
    const accessor = ctx.elements[accessorParam.functionCall.id]
    expect(accessor.functionDef.id).toBe('INTEGER_CURRENT_LEGACY')
    expect(Object.values(ctx.elements).some((element: any) => element.scriptCode?.includes('IntLoopDone'))).toBe(false)
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'IntLoopCurrent')).toBe(false)

    const namingCtx: any = {
      libId: 'Map', library: { id: 'Map', items: [], elements: {}, elementsByType: {} },
      nativeLibrary: ctx.nativeLibrary, allLibraries: new Map([['Ntve', ctx.nativeLibrary]]),
      templateScopes: [{ definition: ctx.nativeLibrary.elementsByType.FunctionDef.PICK_LEGACY, variables: new Map() }],
    }
    expect(toGalaxyFunctionName(ctx.nativeLibrary.elementsByType.FunctionDef.INTEGER_CURRENT_LEGACY, namingCtx)).toBe('IntLoopCurrent')
  })
})

describe('generated unit-loop recovery', () => {
  it('folds group/count/for scaffolding and removes only its auto variables', () => {
    const ctx = context()
    Object.assign(ctx.nativeLibrary.elementsByType.ParamDef, {
      UNIT_VAR: { type: 'ParamDef', id: 'UNIT_VAR', library: 'Ntve', paramType: { type: 'unit' } },
      GROUP: { type: 'ParamDef', id: 'GROUP', library: 'Ntve', paramType: { type: 'unitgroup' } },
    })
    ctx.nativeLibrary.elementsByType.FunctionDef.FOREACH = {
      type: 'FunctionDef', id: 'FOREACH', library: 'Ntve', name: 'ForEachUnitInGroup',
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'UNIT_VAR' }, { type: 'ParamDef', library: 'Ntve', id: 'GROUP' }],
      subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'ACTIONS' }],
    }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    Object.assign(ctx.elements, {
      AUTO_G: { type: 'Variable', id: 'AUTO_G', library: 'Map', name: 'auto12345678_g', variableType: { type: 'unitgroup' } },
      AUTO_U: { type: 'Variable', id: 'AUTO_U', library: 'Map', name: 'auto12345678_u', variableType: { type: 'int' } },
      UNITS: { type: 'Variable', id: 'UNITS', library: 'Map', name: 'units_created', variableType: { type: 'unitgroup' } },
      UNIT: { type: 'Variable', id: 'UNIT', library: 'Map', name: 'lv_unit', variableType: { type: 'unit' } },
    })
    ctx.localVarByGalaxyName = new Map([
      ['auto12345678_g', 'AUTO_G'], ['auto12345678_u', 'AUTO_U'], ['units_created', 'UNITS'], ['lv_unit', 'UNIT'],
    ])
    ctx.structuredLocals = ['AUTO_G', 'AUTO_U', 'UNITS', 'UNIT'].map(id => ({ type: 'Variable', library: 'Map', id }))
    const source = parseGalaxySource(`void Test() {
      unitgroup auto12345678_g;
      int auto12345678_u;
      unitgroup units_created;
      unit lv_unit;
      auto12345678_g = units_created;
      auto12345678_u = UnitGroupCount(auto12345678_g, c_unitCountAll);
      for (;; auto12345678_u -= 1) {
        lv_unit = UnitGroupUnitFromEnd(auto12345678_g, auto12345678_u);
        if (lv_unit == null) { break; }
      }
    }`)
    const statements = [...([...source.statements][0] as any).body.statements].slice(-3)
    expect(ctx.funcNameToFuncDef.has('ForEachUnitInGroup')).toBe(true)
    const refs = structuredStatements(statements, ctx)
    expect(refs).toHaveLength(1)
    expect((ctx.elements[refs[0].id] as any).functionDef.id).toBe('FOREACH')
    expect(ctx.elements.AUTO_G).toBeUndefined()
    expect(ctx.elements.AUTO_U).toBeUndefined()
    expect(ctx.elements.UNITS).toBeDefined()
    expect(ctx.elements.UNIT).toBeDefined()
    expect(ctx.structuredLocals.map((ref: any) => ref.id)).toEqual(['UNITS', 'UNIT'])
  })
})

describe('loaded automatic-variable template recovery', () => {
  it('uses loaded ScriptCode to restore a collection loop and remove private auto locals', () => {
    const ctx = context()
    Object.assign(ctx.nativeLibrary.elementsByType.SubFuncType.ACTIONS, { name: 'actions', identifier: 'actions' })
    Object.assign(ctx.nativeLibrary.elementsByType.ParamDef, {
      BEHAVIOR: { type: 'ParamDef', id: 'BEHAVIOR', library: 'Ntve', name: 'var', isReference: true,
        paramType: { type: 'anyvariable', variableType: 'gamelink' } },
      UNIT: { type: 'ParamDef', id: 'UNIT', library: 'Ntve', name: 'unit', paramType: { type: 'unit' } },
    })
    ctx.nativeLibrary.elementsByType.FunctionDef.BEHAVIOR_LOOP = {
      type: 'FunctionDef', id: 'BEHAVIOR_LOOP', library: 'Ntve', name: 'LoadedCollectionLoop',
      parameters: [{ type: 'ParamDef', library: 'Ntve', id: 'BEHAVIOR' }, { type: 'ParamDef', library: 'Ntve', id: 'UNIT' }],
      subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'ACTIONS' }],
      flags: ['Action', 'SubFunctions'], isFuncAction: true, isSubFunction: true,
      scriptCode: `#AUTOVAR(u, unit) = #PARAM(unit);
#AUTOVAR(i) = 1;
for ( ; #AUTOVAR(i) <= UnitBehaviorCountAll(#AUTOVAR(u)) ; #AUTOVAR(i) += BoolToInt(#PARAM(var) == UnitBehaviorGet(#AUTOVAR(u), #AUTOVAR(i))) ) {
  #PARAM(var) = UnitBehaviorGet(#AUTOVAR(u), #AUTOVAR(i));
  #SUBFUNCS(actions)
}`,
    }
    ctx.nativeLibrary.elements = { ...ctx.nativeLibrary.elementsByType.SubFuncType,
      ...ctx.nativeLibrary.elementsByType.ParamDef, ...ctx.nativeLibrary.elementsByType.FunctionDef }
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    ctx.structuredLocals = []
    // A nested loaded template gets its own AUTOVAR scope even when the parent
    // template uses the same macro-role names.
    ctx.structuredActiveAutoNames = new Set(['u', 'i'])
    const parsed = parseGalaxySource(`void Test() {
      string behavior;
      unit source;
      unit auto12345678_u;
      int auto12345678_i;
      auto12345678_u = source;
      auto12345678_i = 1;
      for (; auto12345678_i <= UnitBehaviorCountAll(auto12345678_u); auto12345678_i += BoolToInt(behavior == UnitBehaviorGet(auto12345678_u, auto12345678_i))) {
        behavior = UnitBehaviorGet(auto12345678_u, auto12345678_i);
      }
    }`)
    const refs = structuredStatements([...([...parsed.statements][0] as any).body.statements], ctx)
    expect(refs).toHaveLength(1)
    expect(ctx.elements[refs[0].id].functionDef.id).toBe('BEHAVIOR_LOOP')
    expect(ctx.structuredLocals.map((ref: any) => ctx.elements[ref.id].name)).toEqual(['behavior', 'source'])
    expect([...ctx.localVarByGalaxyName.keys()]).not.toContain('auto12345678_u')
    expect([...ctx.localVarByGalaxyName.keys()]).not.toContain('auto12345678_i')
  })
})

describe('captured integer-loop recovery', () => {
  function fixture(step: number, extra = '') {
    const ctx = context()
    const formals = ['ITER', 'FROM', 'TO', 'STEP'].map(id => ({ type: 'ParamDef', library: 'Ntve', id }))
    for (const ref of formals) ctx.nativeLibrary.elementsByType.ParamDef[ref.id] = { ...ref, paramType: { type: 'int' } }
    const definition = {
      type: 'FunctionDef', library: 'Ntve', id: 'COUNTED', name: 'ForEachInteger', parameters: formals,
      subFunctionTypes: [{ type: 'SubFuncType', library: 'Ntve', id: 'ACTIONS' }],
    }
    ctx.nativeLibrary.elementsByType.FunctionDef.COUNTED = definition
    ctx.funcNameToFuncDef = buildFuncNameToFuncDefMap(ctx.nativeLibrary)
    ctx.structuredLocals = []
    const parsed = parseGalaxySource(`void Test() {
      int capturedEnd;
      const int capturedStep = ${step};
      int count;
      int i;
      capturedEnd = count;
      i = 1;
      for (; ((capturedStep >= 0 && i <= capturedEnd) || (capturedStep < 0 && i >= capturedEnd)); i += capturedStep) {}
      ${extra}
    }`)
    expect(parsed.parseDiagnostics).toEqual([])
    const nodes = [...([...parsed.statements][0] as any).body.statements]
    return { ctx, nodes }
  }

  it.each([1, -2])('folds captured bound and constant step %s into native parameters', step => {
    const { ctx, nodes } = fixture(step)
    const refs = structuredStatements(nodes, ctx)
    expect(refs).toHaveLength(1)
    const call = ctx.elements[refs[0].id]
    expect(call.functionDef.id).toBe('COUNTED')
    expect(call.parameters).toHaveLength(4)
    expect(ctx.elements[call.parameters[3].id].value).toBe(String(step))
    expect(ctx.structuredLocals.map((ref: any) => ctx.elements[ref.id].name)).toEqual(['count', 'i'])
    expect(ctx.elements[call.parameters[0].id].variable.id).toBe(ctx.structuredLocals[1].id)
    expect(ctx.elements[call.parameters[2].id].variable.id).toBe(ctx.structuredLocals[0].id)
  })

  it('folds a bound captured in a const declaration initializer', () => {
    const { ctx } = fixture(1)
    const parsed = parseGalaxySource(`void Test() {
      int count;
      const int capturedEnd = count;
      const int capturedStep = 1;
      int i;
      i = 1;
      for (; ((capturedStep >= 0 && i <= capturedEnd) || (capturedStep < 0 && i >= capturedEnd)); i += capturedStep) {}
    }`)
    const nodes = [...([...parsed.statements][0] as any).body.statements]
    const refs = structuredStatements(nodes, ctx)
    expect(refs).toHaveLength(1)
    const call = ctx.elements[refs[0].id]
    expect(call.functionDef.id).toBe('COUNTED')
    expect(ctx.structuredLocals.map((ref: any) => ctx.elements[ref.id].name)).toEqual(['count', 'i'])
    expect(ctx.elements[call.parameters[0].id].variable.id).toBe(ctx.structuredLocals[1].id)
    expect(ctx.elements[call.parameters[2].id].variable.id).toBe(ctx.structuredLocals[0].id)
    expect(ctx.elements[call.parameters[3].id].value).toBe('1')
  })

  // Star Party: `gv_mGen.lv_tempInt1` loops became synthesized For Statement /
  // Binary Expression templates because iterators were compared by identifier name.
  it.each([
    ['a record field', 'gv_state.lv_counter'],
    ['a field of an array element', 'gv_states[2].lv_counter'],
  ])('folds an editor counted loop whose variable is %s', (_shape, iterator) => {
    resetGalaxyToTriggerIdCounter()
    const { ctx } = fixture(1)
    const structure = { type: 'Structure', library: 'Map', id: 'STATE' }
    Object.assign(ctx.elements, {
      STATE: { ...structure, name: 'State', variables: [{ type: 'Variable', library: 'Map', id: 'COUNTER' }] },
      COUNTER: { type: 'Variable', id: 'COUNTER', library: 'Map', name: 'counter', variableType: { type: 'int' } },
      STATE_VAR: { type: 'Variable', id: 'STATE_VAR', library: 'Map', name: 'state', variableType: { type: 'struct', typeElement: structure } },
      STATES_VAR: { type: 'Variable', id: 'STATES_VAR', library: 'Map', name: 'states', variableType: { type: 'struct', typeElement: structure }, isArray: true },
    })
    ctx.globalVarByGalaxyName.set('gv_state', { type: 'Variable', library: 'Map', id: 'STATE_VAR' })
    ctx.globalVarByGalaxyName.set('gv_states', { type: 'Variable', library: 'Map', id: 'STATES_VAR' })
    ctx.structureMemberByKey = new Map([['STATE:lv_counter', { type: 'Variable', library: 'Map', id: 'COUNTER' }]])
    const parsed = parseGalaxySource(`void Test() {
      const int auto81F07AD6_ae = 5;
      const int auto81F07AD6_ai = 1;
      ${iterator} = 1;
      for ( ; ( (auto81F07AD6_ai >= 0 && ${iterator} <= auto81F07AD6_ae) || (auto81F07AD6_ai < 0 && ${iterator} >= auto81F07AD6_ae) ) ; ${iterator} += auto81F07AD6_ai ) {}
    }`)
    expect(parsed.parseDiagnostics).toEqual([])
    const refs = structuredStatements([...([...parsed.statements][0] as any).body.statements], ctx)
    expect(refs).toHaveLength(1)
    const call = ctx.elements[refs[0].id]
    expect(call.functionDef.id).toBe('COUNTED')
    expect(call.id).toBe('81F07AD6')
    const target = ctx.elements[call.parameters[0].id]
    expect(target.variable.id).toBe(iterator.includes('[') ? 'STATES_VAR' : 'STATE_VAR')
    expect(ctx.elements[target.structMember.id].variable.id).toBe('COUNTER')
    expect(ctx.elements[call.parameters[2].id].value).toBe('5')
    expect(ctx.elements[call.parameters[3].id].value).toBe('1')
    expect(ctx.structuredLocals).toEqual([])
    expect(Object.values(ctx.elements).some((element: any) => element.type === 'FunctionDef' &&
      ['For Statement', 'Binary Expression'].includes(element.name))).toBe(false)
  })

  it('folds separately assigned bound and non-zero step, including the legacy <= zero guard', () => {
    const { ctx } = fixture(1)
    const parsed = parseGalaxySource(`void Test() {
      int capturedEnd;
      int capturedStep;
      int count;
      int i;
      capturedEnd = count;
      capturedStep = 1;
      i = 0;
      for (; ((capturedStep >= 0 && i <= capturedEnd) || (capturedStep <= 0 && i >= capturedEnd)); i += capturedStep) {}
    }`)
    const nodes = [...([...parsed.statements][0] as any).body.statements]
    const refs = structuredStatements(nodes, ctx)
    expect(refs).toHaveLength(1)
    const call = ctx.elements[refs[0].id]
    expect(call.functionDef.id).toBe('COUNTED')
    expect(ctx.structuredLocals.map((ref: any) => ctx.elements[ref.id].name)).toEqual(['count', 'i'])
    expect(ctx.elements[call.parameters[2].id].variable.id).toBe(ctx.structuredLocals[0].id)
    expect(ctx.elements[call.parameters[3].id].value).toBe('1')
  })

  it('removes private ae/ai helpers when a counted loop is recovered in a nested statement list', () => {
    const { ctx } = fixture(1)
    const parsed = parseGalaxySource(`void Test() {
      int auto12345678_ae;
      const int auto12345678_ai = 1;
      int count;
      int i;
      auto12345678_ae = count;
      i = 1;
      for (; ((auto12345678_ai >= 0 && i <= auto12345678_ae) || (auto12345678_ai < 0 && i >= auto12345678_ae)); i += auto12345678_ai) {}
    }`)
    const nodes = [...([...parsed.statements][0] as any).body.statements]
    ctx.structuredFunctionStatements = nodes
    Object.assign(ctx.elements, {
      END: { type: 'Variable', id: 'END', library: 'Map', name: 'auto12345678_ae', variableType: { type: 'int' } },
      STEP: { type: 'Variable', id: 'STEP', library: 'Map', name: 'auto12345678_ai', variableType: { type: 'int' }, isConstant: true },
      COUNT: { type: 'Variable', id: 'COUNT', library: 'Map', name: 'count', variableType: { type: 'int' } },
      ITER: { type: 'Variable', id: 'ITER', library: 'Map', name: 'i', variableType: { type: 'int' } },
    })
    ctx.localVarByGalaxyName = new Map([
      ['auto12345678_ae', 'END'], ['auto12345678_ai', 'STEP'], ['count', 'COUNT'], ['i', 'ITER'],
    ])
    ctx.structuredLocals = ['END', 'STEP', 'COUNT', 'ITER'].map(id => ({ type: 'Variable', library: 'Map', id }))
    const refs = convertStatementListToActionRefs(nodes.slice(-3), undefined, ctx)
    expect(refs).toHaveLength(1)
    const call = ctx.elements[refs[0].id]
    expect(call.functionDef.id).toBe('COUNTED')
    expect(ctx.elements.END).toBeUndefined()
    expect(ctx.elements.STEP).toBeUndefined()
    expect(ctx.structuredLocals.map((ref: any) => ref.id)).toEqual(['COUNT', 'ITER'])
    expect(ctx.elements[call.parameters[2].id].variable.id).toBe('COUNT')
    expect(ctx.elements[call.parameters[3].id].value).toBe('1')
  })

  it('does not rewrite a <= zero guard when the captured step is zero', () => {
    const { ctx } = fixture(1)
    const parsed = parseGalaxySource(`void Test() {
      const int capturedEnd = 5;
      const int capturedStep = 0;
      int i;
      i = 0;
      for (; ((capturedStep >= 0 && i <= capturedEnd) || (capturedStep <= 0 && i >= capturedEnd)); i += capturedStep) {}
    }`)
    const nodes = [...([...parsed.statements][0] as any).body.statements]
    const refs = structuredStatements(nodes, ctx)
    expect(refs).toHaveLength(2)
    expect(ctx.elements.capturedEnd).toBeUndefined()
    expect(ctx.structuredLocals.map((ref: any) => ctx.elements[ref.id].name)).toEqual(['capturedEnd', 'capturedStep', 'i'])
    expect(ctx.elements[refs[1].id].functionDef.id).not.toBe('COUNTED')
  })

  it('does not fold a captured bound observed after the loop', () => {
    const { ctx, nodes } = fixture(1, 'count = capturedEnd;')
    ctx.structuredFunctionStatements = nodes
    ctx.localVarByGalaxyName = new Map(['capturedEnd', 'capturedStep', 'i'].map(name => [name, name]))
    expect(tryCapturedIntegerLoop(nodes, 4, ctx)).toBeUndefined()
    expect(Object.keys(ctx.elements)).toEqual([])
  })
})
