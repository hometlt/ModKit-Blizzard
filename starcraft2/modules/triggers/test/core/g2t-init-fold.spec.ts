import { describe, it, expect } from 'vitest'
import { parseTriggerXmlSync } from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import { parseGalaxySource, convertGalaxyToTriggerLibrary } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/galaxy-to-trigger.js'
import { convertTriggerLibraryToGalaxyFull } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/trigger-to-galaxy.js'
import type { FunctionDefJson, FunctionCallJson } from '@modkit/blizzard-starcraft2/triggers/document/index.js'

// Only the native declaration participates in this regression. No installed
// game-data corpus is required to reproduce partial initialization data loss.
const native = parseTriggerXmlSync(`<TriggerData><Library Id="Ntve">
  <Element Type="FunctionDef" Id="00000001"><Identifier>TimerCreate</Identifier>
    <FlagNative/><FlagCall/><FlagNoScriptPrefix/><ReturnType><Type Value="timer"/></ReturnType>
  </Element>
</Library></TriggerData>`).get('Ntve')!

const HEADER = `
timer[17] lib1_gv_pingResetTimer;
int[3][5] lib1_gv_grid;
int lib1_gv_x;
int[17] lib1_gv_partial;
`

const SCRIPT = `
bool lib1_InitVariables_completed = false;
void lib1_InitVariables () {
    int init_i;
    int init_j;
    if (lib1_InitVariables_completed) { return; }
    lib1_InitVariables_completed = true;
    for (init_i = 0; init_i <= 16; init_i += 1) {
        lib1_gv_pingResetTimer[init_i] = TimerCreate();
    }
    for (init_i = 0; init_i <= 2; init_i += 1) {
        for (init_j = 0; init_j <= 4; init_j += 1) {
            lib1_gv_grid[init_i][init_j] = 7;
        }
    }
    lib1_gv_x = 5;
    for (init_i = 0; init_i <= 3; init_i += 1) {
        lib1_gv_partial[init_i] = 9;
    }
}
`

describe('initialization preservation', () => {
  it('keeps full and partial loops together without moving or dropping effectful initialization', () => {
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(SCRIPT), parseGalaxySource(HEADER), { libraryId: '1', nativeLibrary: native },
    )
    const elements = Object.values(lib.elements)
    const initializer = elements.find(e => e.type === 'FunctionDef' && e.name === 'lib1_InitVariables') as FunctionDefJson
    expect(initializer.actions).toHaveLength(6)
    expect(initializer.localVariables).toHaveLength(2)
    expect(elements.some(e => e.type === 'FunctionDef' && e.name === '__InitVariablesRaw')).toBe(false)
    expect(elements.some(e => e.type === 'FunctionDef' && e.flags?.includes('CustomScript'))).toBe(false)
    const calls = elements.filter(e => e.type === 'FunctionCall') as FunctionCallJson[]
    expect(calls.some(call => call.functionDef?.library === 'Ntve' && call.functionDef.id === '00000001')).toBe(true)

    const { script } = convertTriggerLibraryToGalaxyFull(lib, native)
    expect(parseGalaxySource(script).parseDiagnostics).toEqual([])
    const declarations = [...parseGalaxySource(script).statements] as any[]
    expect(declarations.filter(node => node.name?.name === 'lib1_InitVariables' && node.body)).toHaveLength(1)
    expect(declarations.filter(node => node.name?.name === 'lib1_InitVariables_1' && node.body)).toHaveLength(1)
    expect(script.match(/for \(/gu)).toHaveLength(4)
    expect(script).toContain('TimerCreate()')
    expect(script.indexOf('TimerCreate()')).toBeLessThan(script.indexOf('lib1_gv_x = 5;'))
    expect(script.indexOf('lib1_gv_x = 5;')).toBeLessThan(script.lastIndexOf('= 9;'))
  })

  it('folds ordered dependency initialization when concrete cross-library references preserve it', () => {
    const dependency: any = {
      id: 'DEP', items: [],
      elements: {
        USE: { type: 'FunctionDef', id: 'USE', library: 'DEP', name: 'Use', flags: ['Action'], isFuncAction: true, parameters: [] },
      },
      elementsByType: {
        FunctionDef: {
          USE: { type: 'FunctionDef', id: 'USE', library: 'DEP', name: 'Use', flags: ['Action'], isFuncAction: true, parameters: [] },
        },
      },
    }
    const source = `
bool libTEST_InitVariables_completed = false;
bool libTEST_InitLib_completed = false;
void libTEST_gf_Run() { libDEP_gf_Use(); }
void libTEST_InitLibraries() { libNtve_InitVariables(); libDEP_InitVariables(); }
void libTEST_InitVariables() {
  if (libTEST_InitVariables_completed) { return; }
  libTEST_InitVariables_completed = true;
}
void libTEST_InitTriggers() {}
void libTEST_InitLib() {
  if (libTEST_InitLib_completed) { return; }
  libTEST_InitLib_completed = true;
  libTEST_InitLibraries();
  libTEST_InitVariables();
  libTEST_InitTriggers();
}`
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(''),
      { libraryId: 'TEST', nativeLibrary: native, dependencyLibraries: new Map([['DEP', dependency]]) },
    )
    const elements = Object.values(lib.elements) as any[]
    expect(elements.some(element => /^libTEST_Init/u.test(element.name ?? ''))).toBe(false)
    expect(elements.some(element => /_completed$/u.test(element.name ?? ''))).toBe(false)

    const output = convertTriggerLibraryToGalaxyFull(lib, native, new Map([['DEP', dependency]]))
    expect(output.script).toContain('libDEP_InitVariables();')
    expect(output.script.match(/void libTEST_InitLibraries/g)).toHaveLength(1)
  })

  // Эпические Битвы с Боссами: a generated function's array initial value came back
  // as a For Each Integer action over IntLoopCurrent() and a stray init_i local.
  it('folds the variable initialization of a generated function into local initial values', () => {
    const source = `
int lib1_gf_Count () {
    int init_i;

    // Variable Declarations
    int lv_total;
    int[4] lv_cells;

    // Variable Initialization
    lv_total = 3;
    for (init_i = 0; init_i <= 3; init_i += 1) {
        lv_cells[init_i] = 9;
    }

    // Implementation
    lv_total = 4;
    return lv_cells[lv_total];
}
`
    const lib = convertGalaxyToTriggerLibrary(parseGalaxySource(source), parseGalaxySource(''), { libraryId: '1', nativeLibrary: native })
    const count = Object.values(lib.elements).find(element => element.type === 'FunctionDef' && element.name === 'Count') as FunctionDefJson
    const locals = count.localVariables!.map(ref => lib.elements[ref.id] as any)
    expect(locals.map(local => local.name)).toEqual(['total', 'cells'])
    expect(locals.map(local => (lib.elements[local.initialValue.id] as any).value)).toEqual(['3', '9'])
    expect(count.actions).toHaveLength(2)
  })
})

describe('map trigger linkage', () => {
  it('keeps typed color array initialization as color instead of an implicitly cast string', () => {
    const header = 'color[4] gv_palette;'
    const source = `
color[4] gv_palette;
void InitLibs() { libNtve_InitLib(); }
void InitGlobals() {
  int init_i;
  for (init_i = 0; init_i <= 3; init_i += 1) {
    gv_palette[init_i] = Color(0, 0, 0);
  }
}
void InitTriggers() {}
void InitMap() { InitLibs(); InitGlobals(); InitTriggers(); }
`
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(header),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native },
    )
    const variable = Object.values(lib.elements).find(element => element.type === 'Variable' && element.name === 'palette') as any
    const initial = lib.elements[variable.initialValue.id] as any
    expect(initial).toMatchObject({ value: '255,0,0,0', valueType: { type: 'color' } })

    lib.implicit = true
    const { script } = convertTriggerLibraryToGalaxyFull(lib, native)
    expect(script).toMatch(/gv_palette\[[A-Za-z0-9_]+\] = Color\(0\.00, 0\.00, 0\.00\);/u)
    expect(script).not.toContain('"Color(')
  })

  // Star Party v: SC2 Editor writes `= "";` for a string global or structure member whose
  // initial value is the empty string, and nothing for one without an initial value.
  it('writes an empty string initial value of a global and a structure member', () => {
    const header = 'struct gs_Point { string[3] lv_name; }; string gv_board; string gv_other; gs_Point gv_point;'
    const source = `
struct gs_Point { string[3] lv_name; };
string gv_board;
string gv_other;
gs_Point gv_point;
void InitLibs() { libNtve_InitLib(); }
void InitGlobals() {
  int init_i1;
  gv_board = "";
  for (init_i1 = 0; init_i1 <= 2; init_i1 += 1) {
    gv_point.lv_name[init_i1] = "";
  }
}
void InitTriggers() {}
void InitMap() { InitLibs(); InitGlobals(); InitTriggers(); }
`
    const lib = convertGalaxyToTriggerLibrary(parseGalaxySource(source), parseGalaxySource(header),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native })
    lib.implicit = true
    const { script } = convertTriggerLibraryToGalaxyFull(lib, native)
    expect(script).toContain('gv_board = "";')
    expect(script).toMatch(/gv_point\.lv_name\[\w+\] = "";/u)
    expect(script).not.toContain('gv_other =')
  })

  // Star Party v: the counter of a local array fill stayed behind as a local named init_i.
  it('does not keep the counter of a local array fill as a trigger local', () => {
    const source = `
trigger gt_Test;
bool gt_Test_Func(bool testConds, bool runActions) {
  int init_i;
  int[4] lv_cells;
  for (init_i = 0; init_i <= 3; init_i += 1) {
    lv_cells[init_i] = 9;
  }
  if (!runActions) { return true; }
  return true;
}
void gt_Test_Init() { gt_Test = TriggerCreate("gt_Test_Func"); }
void InitLibs() { libNtve_InitLib(); }
void InitTriggers() { gt_Test_Init(); }
void InitMap() { InitLibs(); InitTriggers(); }
`
    const lib = convertGalaxyToTriggerLibrary(parseGalaxySource(source), parseGalaxySource('trigger gt_Test;'),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native })
    const trigger = Object.values(lib.elements).find(element => element.type === 'Trigger') as any
    expect(trigger.localVariables.map((ref: any) => (lib.elements[ref.id] as any).name)).toEqual(['cells'])
  })

  it('folds direct global-structure member defaults without preserving InitGlobals as script', () => {
    const header = `
struct gs_State { int lv_dialog; };
gs_State gv_state;
trigger gt_Test;
`
    const source = `
gs_State gv_state;
trigger gt_Test;
bool gt_Test_Func(bool testConds, bool runActions) {
  if (!runActions) { return true; }
  return true;
}
void gt_Test_Init() { gt_Test = TriggerCreate("gt_Test_Func"); }
void InitLibs() { libNtve_InitLib(); }
void InitGlobals() { gv_state.lv_dialog = 7; }
void InitTriggers() { gt_Test_Init(); }
void InitMap() { InitLibs(); InitGlobals(); InitTriggers(); }
`
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(header),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native },
    )
    const elements = Object.values(lib.elements) as any[]
    expect(elements.some(element => element.type === 'CustomScript')).toBe(false)
    expect(elements.some(element => element.type === 'FunctionDef' && element.name === 'InitGlobals')).toBe(false)
    const member = elements.find(element => element.type === 'Variable' && element.name === 'dialog')
    expect(member?.initialValue && (lib.elements as any)[member.initialValue.id]?.value).toBe('7')
  })

  it('replaces an unfoldable editor InitGlobals body with one scheduled custom initializer', () => {
    const source = `
int gv_first;
int gv_second;
trigger gt_Test;
bool gt_Test_Func(bool testConds, bool runActions) {
  if (!runActions) { return true; }
  return true;
}
void gt_Test_Init() {
  gt_Test = TriggerCreate("gt_Test_Func");
}
void InitLibs() { libNtve_InitLib(); }
void InitGlobals() {
  gv_first = gv_second;
  gv_second = 2;
}
void InitTriggers() { gt_Test_Init(); }
void InitMap() {
  InitLibs();
  InitGlobals();
  InitTriggers();
}`
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(''),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native },
    )
    const elements = Object.values(lib.elements) as any[]
    expect(elements.filter(element => element.type === 'FunctionDef' &&
      /^(?:InitLibs|InitGlobals|InitTriggers|InitMap)$/u.test(element.name ?? ''))).toEqual([])
    const custom = elements.filter(element => element.type === 'CustomScript')
    expect(custom).toHaveLength(1)
    expect(custom[0].initFunc).toBe('modkitRecoveredInitGlobals')
    expect(custom[0].scriptCode).toContain('gv_first = gv_second;')
    expect(custom[0].scriptCode).toContain('gv_second = 2;')
    expect(lib.items.some(item => item.type === 'CustomScript' && item.id === custom[0].id)).toBe(true)

    lib.implicit = true
    const { script } = convertTriggerLibraryToGalaxyFull(lib, native)
    expect(parseGalaxySource(script).parseDiagnostics).toEqual([])
    expect(script.match(/void InitLibs \(/gu)).toHaveLength(1)
    expect(script.match(/void InitGlobals \(/gu)).toHaveLength(1)
    expect(script.match(/void InitTriggers \(/gu)).toHaveLength(1)
    expect(script.match(/void InitMap \(/gu)).toHaveLength(1)
    expect(script).toContain('void modkitRecoveredInitGlobals ()')
    expect(script).toMatch(/InitGlobals\(\);\s*InitCustomScript\(\);\s*InitTriggers\(\);/u)
  })

  it('recovers a historical library-prefixed map callback and all registered events', () => {
    const eventNative: any = {
      id: 'Ntve',
      elementsByType: {
        FunctionDef: {
          EVENT: {
            type: 'FunctionDef', id: 'EVENT', library: 'Ntve', name: 'TriggerAddEventUnitRegion',
            flags: ['Event', 'Native', 'NoScriptPrefix'],
            parameters: [
              { type: 'ParamDef', library: 'Ntve', id: 'UNIT' },
              { type: 'ParamDef', library: 'Ntve', id: 'REGION' },
              { type: 'ParamDef', library: 'Ntve', id: 'BOOL' },
            ],
          },
        },
        ParamDef: {
          UNIT: { type: 'ParamDef', id: 'UNIT', library: 'Ntve', paramType: { type: 'unit' } },
          REGION: { type: 'ParamDef', id: 'REGION', library: 'Ntve', paramType: { type: 'region' } },
          BOOL: { type: 'ParamDef', id: 'BOOL', library: 'Ntve', paramType: { type: 'bool' } },
        },
      },
    }
    eventNative.elements = {
      ...eventNative.elementsByType.FunctionDef,
      ...eventNative.elementsByType.ParamDef,
    }
    const source = `
trigger lib1_gt_UnitEntersFrontofEnemyKeystone;
bool lib1_gt_UnitEntersFrontofEnemyKeystone_Func(bool testConds, bool runActions) {
    if (!runActions) { return true; }
    return true;
}
void lib1_gt_UnitEntersFrontofEnemyKeystone_Init() {
    lib1_gt_UnitEntersFrontofEnemyKeystone = TriggerCreate("lib1_gt_UnitEntersFrontofEnemyKeystone_Func");
    TriggerAddEventUnitRegion(lib1_gt_UnitEntersFrontofEnemyKeystone, null, RegionFromId(49), true);
    TriggerAddEventUnitRegion(lib1_gt_UnitEntersFrontofEnemyKeystone, null, RegionFromId(50), true);
}`
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(''),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: eventNative },
    )
    const triggers = Object.values(lib.elements).filter(e => e.type === 'Trigger') as any[]
    expect(triggers).toHaveLength(1)
    expect(triggers[0].name).toBe('UnitEntersFrontofEnemyKeystone')
    expect(triggers[0].events).toHaveLength(2)
    const eventCalls = triggers[0].events.map((ref: any) => lib.elements[ref.id]) as FunctionCallJson[]
    expect(eventCalls.map(call => call.parameters?.length)).toEqual([3, 3])
    expect(eventCalls.flatMap(call => call.parameters ?? []).map(ref => (lib.elements[ref.id] as any).parameterDef?.id)).toEqual([
      'UNIT', 'REGION', 'BOOL',
      'UNIT', 'REGION', 'BOOL',
    ])
    expect(Object.values(lib.elements).some((e: any) => e.type === 'FunctionDef' && e.name.endsWith('_Func'))).toBe(false)
  })

  it('recovers an unqualified map trigger whose events are registered dynamically elsewhere', () => {
    const source = `
trigger gt_Idle;
bool gt_Idle_Func(bool testConds, bool runActions) {
    if (!runActions) { return true; }
    return true;
}
void gt_Idle_Init() {
    gt_Idle = TriggerCreate("gt_Idle_Func");
    TriggerEnable(gt_Idle, false);
}`
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(''),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native },
    )
    const elements = Object.values(lib.elements) as any[]
    const trigger = elements.find(element => element.type === 'Trigger')
    expect(trigger?.name).toBe('Idle')
    expect(trigger?.initOff).toBe(true)
    expect(elements.some(element => element.type === 'Variable' && element.name === 'gt_Idle')).toBe(false)
    expect(elements.some(element => element.type === 'FunctionDef' && /^gt_Idle_(?:Func|Init)$/u.test(element.name ?? ''))).toBe(false)
  })

  it('recovers an empty editor trigger callback that omits the runActions guard', () => {
    const source = `
trigger gt_Empty;
bool gt_Empty_Func(bool testConds, bool runActions) {
    return true;
}
void gt_Empty_Init() {
    gt_Empty = TriggerCreate("gt_Empty_Func");
}`
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(''),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native },
    )
    const elements = Object.values(lib.elements) as any[]
    const trigger = elements.find(element => element.type === 'Trigger')
    expect(trigger?.name).toBe('Empty')
    expect(trigger?.actions).toEqual([])
    expect(elements.some(element => element.type === 'Variable' && element.name === 'gt_Empty')).toBe(false)
    expect(elements.some(element => element.type === 'FunctionDef' && /^gt_Empty_(?:Func|Init)$/u.test(element.name ?? ''))).toBe(false)
  })

  it('folds an embedded editor-library startup bundle into map initialization', () => {
    const source = `
int libQ_gv_value;
trigger libQ_gt_Test;
bool libQ_InitVariables_completed = false;
bool libQ_InitLib_completed = false;
bool libQ_gt_Test_Func(bool testConds, bool runActions) {
  if (!runActions) { return true; }
  return true;
}
void libQ_gt_Test_Init() {
  libQ_gt_Test = TriggerCreate("libQ_gt_Test_Func");
}
void libQ_InitLibraries() { libNtve_InitVariables(); }
void libQ_InitVariables() {
  if (libQ_InitVariables_completed) { return; }
  libQ_InitVariables_completed = true;
  libQ_gv_value = 5;
}
void libQ_InitTriggers() { libQ_gt_Test_Init(); }
void libQ_InitLib() {
  if (libQ_InitLib_completed) { return; }
  libQ_InitLib_completed = true;
  libQ_InitLibraries();
  libQ_InitVariables();
  libQ_InitTriggers();
}
void InitLibs() { libNtve_InitLib(); libQ_InitLib(); }
void InitMap() { InitLibs(); }
`
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(''),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native },
    )
    const elements = Object.values(lib.elements) as any[]
    expect(elements.filter(element => element.type === 'Trigger').map(element => element.name)).toEqual(['Test'])
    expect(elements.some(element => /^libQ_Init/u.test(element.name ?? ''))).toBe(false)
    expect(elements.some(element => element.type === 'Variable' && /_completed$/u.test(element.name ?? ''))).toBe(false)
    const value = elements.find(element => element.type === 'Variable' && element.name === 'value')
    expect(value).toBeDefined()
    expect((lib.elements[value.initialValue.id] as any).value).toBe('5')

    lib.implicit = true
    const { script } = convertTriggerLibraryToGalaxyFull(lib, native)
    expect(script).toContain('void InitMap ()')
    expect(script).toContain('void gt_Test_Init ()')
    expect(script).not.toContain('libQ_')
  })
})

// bridges.SC2Map: the editor writes no InitGlobals for a map without global
// variables, and the startup graph went unrecognized -- InitLibs, InitTriggers
// and every gt_*_Init came back as authored ScriptCode.
describe('map startup without a variable stage', () => {
  const source = `
void InitLibs () {
    libNtve_InitLib();
}

void InitTriggers () {
}

void InitMap () {
    InitLibs();
    InitTriggers();
}
`
  it('recognizes InitMap calling only InitLibs and InitTriggers', () => {
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(source), parseGalaxySource(''),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native },
    )
    const names = Object.values(lib.elements).map(element => (element as any).name)
    expect(names).not.toContain('InitMap')
    expect(names).not.toContain('InitLibs')
    expect(names).not.toContain('InitTriggers')
    expect(Object.values(lib.elements).some(element => element.flags?.includes('CustomScript'))).toBe(false)
  })

  it('still leaves a map function the startup graph never calls to the author', () => {
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(`${source}\nvoid InitGlobals () {\n}\n`), parseGalaxySource(''),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native },
    )
    const names = Object.values(lib.elements).map(element => (element as any).name)
    expect(names).toContain('InitGlobals')
  })
})
