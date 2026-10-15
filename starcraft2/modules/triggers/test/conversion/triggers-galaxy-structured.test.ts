import { describe, expect, it } from 'vitest';
import { convertGalaxyToTriggerLibrary, parseGalaxySource, resetGalaxyToTriggerIdCounter } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.js';
import { parseTriggerXmlSync } from '../../../../dist/modules/triggers/shared/trigger-document/sax-reader.js';
import { convertTriggerLibraryToGalaxyFull } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/trigger-to-galaxy.js';
import { serializeTriggerLibrary, normalizeTriggerLibrary } from '../../../../dist/modules/triggers/shared/trigger-document/trigger-xml.js';
import { convertGalaxyToTriggers, convertTriggersToGalaxy } from '../../../../dist/modules/triggers/services/galaxy-conversion/index.js';
import { assertConversionReferences, encodePayload, decodePayload, lookupElement } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/conversion-model.js';
import { validateLibraryStructure } from '../../../../dist/modules/triggers/shared/trigger-document/structure-validate.js';
import { syntaxShape, resolveTemplateDefinition } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/script-template.js';
import type { TriggerLibraryJson } from '../../../../dist/modules/triggers/shared/trigger-document/types.js';
import { generateId, reserveGalaxyToTriggerId } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/g2t-core.js';
import { pruneUnreachableElements } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/g2t-prune.js';

const xml = (body: string, library = 'TEST') => `<TriggerData><Library Id="${library}">${body}</Library></TriggerData>`;
const el = (type: string, id: string, body: string) => `<Element Type="${type}" Id="${id}">${body}</Element>`;
const ref = (tag: string, type: string, id: string, library = 'TEST') => `<${tag} Type="${type}" Id="${id}" Library="${library}"/>`;
function library(body: string, id = 'TEST') { return parseTriggerXmlSync(xml(body, id)).get(id)!; }
function reverse(source: string, dependencies: TriggerLibraryJson[] = []) {
  resetGalaxyToTriggerIdCounter();
  return normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(parseGalaxySource(source), parseGalaxySource(''), {
    libraryId: 'TEST', dependencyLibraries: new Map(dependencies.map(lib => [lib.id, lib])),
  })) as TriggerLibraryJson;
}
function roundtrip(source: string, dependencies: TriggerLibraryJson[] = []) {
  const restored = reverse(source, dependencies);
  const reparsed = parseTriggerXmlSync(serializeTriggerLibrary(restored)).get('TEST')!;
  const output = convertTriggerLibraryToGalaxyFull(reparsed, undefined, new Map(dependencies.map(lib => [lib.id, lib])));
  expect(parseGalaxySource(output.script).parseDiagnostics).toEqual([]);
  expect(parseGalaxySource(output.header).parseDiagnostics).toEqual([]);
  expect(Object.values(reparsed.elements).some((e: any) => e.flags?.includes('CustomScript'))).toBe(false);
  return { restored, reparsed, ...output };
}

function initializationSource(body: string, globals = 'int score; int[4] values;', rootTail = '') {
  return `${globals}
    bool libTEST_InitVariables_completed = false;
    bool libTEST_InitLib_completed = false;
    void libTEST_InitLibraries() { libNtve_InitVariables(); }
    void libTEST_InitVariables() { int arbitraryCounter;
      if (libTEST_InitVariables_completed) { return; }
      libTEST_InitVariables_completed = true;
      ${body}
    }
    void libTEST_InitTriggers() {}
    void libTEST_InitLib() {
      if (libTEST_InitLib_completed) { return; }
      libTEST_InitLib_completed = true;
      libTEST_InitLibraries(); libTEST_InitVariables(); libTEST_InitTriggers(); ${rootTail}
    }`;
}

function functionBody(source: string, name: string) {
  const functions = [...parseGalaxySource(source).statements].filter((node: any) => node.name?.name === name && node.body) as any[];
  expect(functions).toHaveLength(1);
  return functions[0].body.statements;
}

describe('syntax-directed Galaxy conversion', () => {
  it('does not reuse an authored localized parameter id in the generated id range', () => {
    resetGalaxyToTriggerIdCounter();
    expect(generateId()).toBe('A0000000');
    reserveGalaxyToTriggerId('A0000001');
    expect(generateId()).toBe('A0000002');
  });

  it('retains an old initializer parameter while another generated call still owns it', () => {
    const elements: any = {
      OLDVALUE: { type: 'Param', id: 'OLDVALUE', library: 'TEST', value: '1' },
      NEWVALUE: { type: 'Param', id: 'NEWVALUE', library: 'TEST', value: '2' },
      NESTED: { type: 'FunctionCall', id: 'NESTED', library: 'TEST', parameters: [{ type: 'Param', library: 'TEST', id: 'OLDVALUE' }] },
      CALL: { type: 'FunctionCall', id: 'CALL', library: 'TEST', subFunctions: [{ type: 'FunctionCall', library: 'TEST', id: 'NESTED' }] },
      VARIABLE: { type: 'Variable', id: 'VARIABLE', library: 'TEST', initialValue: { type: 'Param', library: 'TEST', id: 'NEWVALUE' } },
      FUNCTION: { type: 'FunctionDef', id: 'FUNCTION', library: 'TEST', body: [{ type: 'FunctionCall', library: 'TEST', id: 'CALL' }] },
      ORPHANPARAM: { type: 'Param', id: 'ORPHANPARAM', library: 'TEST', value: '3' },
      ORPHANCALL: { type: 'FunctionCall', id: 'ORPHANCALL', library: 'TEST', parameters: [{ type: 'Param', library: 'TEST', id: 'ORPHANPARAM' }] },
    };
    expect(pruneUnreachableElements(elements, 'TEST').removedIds.sort()).toEqual(['ORPHANCALL', 'ORPHANPARAM']);
    expect(elements.OLDVALUE).toBeDefined();
    expect(elements.NESTED).toBeDefined();
  });

  it('validates an acyclic generated expression graph deeper than the old 256-node budget', () => {
    const elements: any = {
      ROOT: { type: 'FunctionDef', id: 'ROOT', library: 'TEST', body: [{ type: 'FunctionCall', library: 'TEST', id: 'CALL0' }] },
    };
    for (let index = 0; index < 300; index += 1) {
      elements[`CALL${index}`] = {
        type: 'FunctionCall', id: `CALL${index}`, library: 'TEST',
        ...(index < 299 ? { subFunctions: [{ type: 'FunctionCall', library: 'TEST', id: `CALL${index + 1}` }] } : {}),
      };
    }
    expect(() => assertConversionReferences({
      id: 'TEST', name: 'TEST', items: [{ type: 'FunctionDef', library: 'TEST', id: 'ROOT' }], elements, elementsByType: {} as any,
    })).not.toThrow();
  });

  it('preserves arbitrary function names, an empty function and a bare return through XML', () => {
    const { script, reparsed } = roundtrip('void untouched() {} void execute() { return; }');
    expect(script).toContain('void untouched ()');
    expect(script).toMatch(/void execute \(\)[\s\S]*return;/u);
    expect(Object.values(reparsed.elements).filter(e => e.type === 'FunctionDef' && e.name === 'execute')[0]).toMatchObject({ isFuncAction: true, flags: expect.arrayContaining(['Action', 'NoScriptPrefix']) });
  });

  // The editor parenthesizes a comparison operator once, wherever it stands:
  // `if (!((a == b)))` in a condition guard, `BoolToInt((a == b))` as an argument.
  it('synthesizes a parenthesized template for a comparison operator', () => {
    const native = library(
      el('PresetValue', '00000101', '<Identifier>Equal</Identifier><Value>==</Value>') +
      el('Preset', '00000102', '<BaseType Value="int"/>' + ref('Item', 'PresetValue', '00000101', 'Ntve')) +
      el('ParamDef', '00000103', '<Identifier>value1</Identifier><ParameterType><Type Value="int"/></ParameterType>') +
      el('ParamDef', '00000104', '<Identifier>operator</Identifier><ParameterType><Type Value="preset"/><TypeElement Type="Preset" Library="Ntve" Id="00000102"/></ParameterType>') +
      el('ParamDef', '00000105', '<Identifier>value2</Identifier><ParameterType><Type Value="int"/></ParameterType>') +
      el('FunctionDef', '00000106', '<Identifier>Comparison</Identifier><FlagCondition/><FlagOperator/><ReturnType><Type Value="bool"/></ReturnType>' +
        ref('Parameter', 'ParamDef', '00000103', 'Ntve') + ref('Parameter', 'ParamDef', '00000104', 'Ntve') + ref('Parameter', 'ParamDef', '00000105', 'Ntve')),
      'Ntve',
    );
    const comparison = native.elementsByType.FunctionDef!['00000106'];
    expect(resolveTemplateDefinition(comparison, [native]).scriptCode)
      .toBe('(#PARAM(value1) #PARAM(operator) #PARAM(value2))');
  });

  // SC2 Editor labels each section of a generated body, including the empty ones
  // (03-DeadOfNight and every other COOP map). Blank lines between them are not
  // reproduced: the corpus carries both a spaced and a compact editor layout.
  it('writes the editor section banners in a converted function', () => {
    const { script } = roundtrip('int compute(int x) { int total; total = x; return total; }');
    const body = script.slice(script.indexOf('int compute ('));
    expect(body.split('\n').slice(0, 7).map(line => line.trim())).toEqual([
      'int compute (int lp_x) {',
      '// Variable Declarations',
      'int lv_total;',
      '// Automatic Variable Declarations',
      '// Variable Initialization',
      '// Implementation',
      'lv_total = lp_x;',
    ]);
  });

  it('preserves precedence and early returns in handwritten functions', () => {
    const { script } = roundtrip('int compute(int x) { int total = (x + 2) * 3; if (total > 4) { return total; } return 0; }');
    expect(script).toContain('(lp_x + 2) * 3');
    const body = script.slice(script.indexOf('int compute ('));
    expect(body.match(/return /gu)).toHaveLength(2);
    expect(body).toContain('return 0;');
    expect(body).toContain('lv_total =');
  });

  it('preserves while, for, continue, break and initializer timing', () => {
    const { script } = roundtrip('int calculate(int count) { int i = 0; int value = 0; for (i = 0; i < count; i += 1) { value = i + 1; if(value > 4) { break; } continue; } while (value < count) { value += 2; } return value; }');
    expect(script).toContain('for (');
    expect(script).toContain('while (');
    expect(script).toContain('continue;');
    expect(script).toContain('break;');
    const declarations = [...script.matchAll(/int (lv_value);/gu)].map(m => m[1]);
    expect(new Set(declarations).size).toBe(1);
    expect(script.indexOf(`${declarations[0]} = 0;`)).toBeLessThan(script.indexOf('for ('));
  });

  it('does not reinterpret an ordinary function because its name resembles an editor callback', () => {
    const { script, reparsed } = roundtrip('int libTEST_gt_Unusual_Func(int input) { return input + 1; } void libTEST_InitVariables() { return; }');
    expect(script).toContain('int libTEST_gt_Unusual_Func (');
    expect(Object.values(reparsed.elements).filter(e => e.type === 'Trigger')).toHaveLength(0);
    functionBody(script, 'libTEST_InitVariables');
    // A library without globals has no generated variable stage to rename around.
    expect(script).not.toContain('libTEST_InitVariables_1');
  });

  it('does not delete handwritten initialization functions merely because completion globals exist', () => {
    const source = `bool libTEST_InitVariables_completed = false; bool libTEST_InitLib_completed = false;
      int libTEST_InitVariables(int value) { return value + 7; }
      void libTEST_InitVariables_1() {} int execute() { return libTEST_InitVariables(3); }`;
    const { script, header, reparsed } = roundtrip(source);
    expect(script).toMatch(/return \(?lp_value \+ 7\)?;/u);
    expect(script).toContain('return libTEST_InitVariables(3);');
    functionBody(script, 'libTEST_InitVariables');
    functionBody(script, 'libTEST_InitVariables_1');
    functionBody(script, 'libTEST_InitVariables_2');
    expect(header).toContain('void libTEST_InitVariables_2 ();');
    expect(Object.values(reparsed.elements).filter(e => e.type === 'Variable')).toHaveLength(2);
  });

  it('folds a fully verified literal initialization bundle including full-array loops', () => {
    const { reparsed, script } = roundtrip(initializationSource('score = 7; for (arbitraryCounter = 0; arbitraryCounter < 4; arbitraryCounter += 1) { values[arbitraryCounter] = 9; }'));
    const variables = Object.values(reparsed.elements).filter(e => e.type === 'Variable') as any[];
    for (const [name, value] of [['score', '7'], ['values', '9']]) {
      const variable = variables.find(e => e.name === name);
      expect(lookupElement([reparsed], variable.initialValue, reparsed.id)).toMatchObject({ type: 'Param', value });
    }
    expect(variables).toHaveLength(2);
    expect(Object.values(reparsed.elements).some(e => e.type === 'FunctionDef' && e.name?.includes('InitVariables'))).toBe(false);
    expect(script).toContain(' score = 7;');
    expect(script).toMatch(/ values\[([A-Za-z_]\w*)\] = 9;/);
  });

  it.each([
    'score = 7; observe(); for (arbitraryCounter = 0; arbitraryCounter < 4; arbitraryCounter += 1) { values[arbitraryCounter] = 9; }',
    'score = 7; for (arbitraryCounter = 0; arbitraryCounter < 2; arbitraryCounter += 1) { values[arbitraryCounter] = 9; } observe();',
    'score = 7; values[0] = score; observe();',
  ])('preserves all initialization steps and their order when the bundle is not wholly foldable: %s', body => {
    const { reparsed, script } = roundtrip(initializationSource(body, 'void observe(); int score; int[4] values;'));
    const initializer: any = Object.values(reparsed.elements).find(e => e.type === 'FunctionDef' && e.name === 'libTEST_InitVariables');
    expect(initializer.actions.length).toBeGreaterThan(2);
    expect(Object.values(reparsed.elements).some(e => e.name === '__InitVariablesRaw')).toBe(false);
    const statements = functionBody(script, 'libTEST_InitVariables');
    expect(statements.length).toBeGreaterThan(4);
    const bodyStart = script.indexOf('void libTEST_InitVariables ()');
    const bodyEnd = script.indexOf('void libTEST_InitTriggers ()', bodyStart);
    const emitted = script.slice(bodyStart, bodyEnd);
    expect(emitted.indexOf('= 7;')).toBeLessThan(emitted.indexOf('observe();'));
    expect(emitted).toContain(body.includes('= 9') ? '= 9;' : '= score;');
    expect(emitted).toContain(' values[');
  });

  it('retains extra initialization logic, flag references and an else branch', () => {
    const source = initializationSource('score = 7;', 'int score;', 'score += 1;') +
      ' bool completed() { return libTEST_InitVariables_completed; }';
    const { script } = roundtrip(source.replace('if (libTEST_InitVariables_completed) { return; }', 'if (libTEST_InitVariables_completed) { return; } else { score = 3; }'));
    functionBody(script, 'libTEST_InitLib');
    functionBody(script, 'libTEST_InitVariables');
    expect(script).toContain('else {');
    expect(script).toContain(' score += 1;');
    expect(script).toContain('return libTEST_InitVariables_completed;');
  });

  it('does not accumulate duplicate startup functions on a second XML and Galaxy conversion', () => {
    const first = roundtrip(initializationSource('score = 7; observe();', 'void observe(); int score;'));
    const second = convertGalaxyToTriggerLibrary(parseGalaxySource(first.script), parseGalaxySource(first.header), { libraryId: 'TEST' });
    const emitted = convertTriggerLibraryToGalaxyFull(second);
    for (const name of ['libTEST_InitVariables', 'libTEST_InitLib']) functionBody(emitted.script, name);
    expect(emitted.script).not.toMatch(/void libTEST_Init (?:Variables|Lib)_\d+\(/u);
  });

  it('verifies the complete XML model for mixed initialization through the public operation', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', header: '',
      script: initializationSource('score = 7; observe();', 'void observe(); int score;') });
    expect(result.fidelity.verification).toMatchObject({ generatedTriggerDataReparsed: true, semanticModelExact: true });
    expect(result.fidelity.completeness).toBe('partial');
    expect(result.output.triggerData).toContain('<Identifier>libTEST_InitVariables</Identifier>');
    expect(result.output.triggerData).not.toContain('__InitVariablesRaw');
    expect(result.output.triggerData).not.toContain('FlagCustomScript');
  });

  it('keeps a bare generated auto-local distinct from an lv_auto editor local', () => {
    const { script } = roundtrip('void perform() { int autoA56C8841_temp = 1; int lv_autoA56C8841_temp = 2; consume(autoA56C8841_temp, lv_autoA56C8841_temp); }');
    expect(script).toContain('int autoA56C8841_temp;');
    expect(script).toContain('int lv_autoA56C8841_temp;');
    expect(script).toContain('consume(autoA56C8841_temp, lv_autoA56C8841_temp)');
  });

  it('retains localized text keys and values through the public reverse operation', async () => {
    const key = 'Param/Value/lib_TEST_A0000001';
    const result = await convertGalaxyToTriggers({
      libraryId: 'TEST', header: '',
      script: `text libTEST_gv_message = StringExternal("${key}");`,
      gameStrings: `${key}=Localized message`,
    });
    expect(result.output.gameStrings).toContain(`${key}=Localized message`);
    const forward = await convertTriggersToGalaxy(result.output.triggerData, {
      libraryId: 'TEST', triggerStrings: result.output.triggerStrings, gameStrings: result.output.gameStrings,
    });
    expect(forward.output.script).toContain(`StringExternal("${key}")`);
  });

  // SC2 Editor 5.0.16 prefixes every custom function's script name: a restored
  // <Identifier>gf_BuildControlsUI</Identifier> compiled to gf_gf_BuildControlsUI.
  it('stores a map function identifier without the gf_ prefix the editor adds', async () => {
    const script = 'int gv_count;\nvoid gf_BuildControlsUI (int lp_width) { gv_count = lp_width; }\nvoid gf_Setup () { gf_BuildControlsUI(3); }';
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script, header: '' });
    expect(reverse.output.triggerData).toContain('<Identifier>BuildControlsUI</Identifier>');
    expect(reverse.output.triggerData).not.toContain('<Identifier>gf_');
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map' });
    expect(forward.output.script).toMatch(/void gf_BuildControlsUI\s*\(int lp_width\)/u);
    expect(forward.output.script).toMatch(/gf_BuildControlsUI\(3\)/u);
    expect(forward.output.script).not.toContain('gf_gf_');
  });

  it('keeps distinct source symbols whose editor display names happen to be identical', () => {
    const source = 'int value; int libTEST_gv_value; int work(int x) { return x + 1; } int libTEST_gf_work(int x) { return x + 2; } int run() { value = work(3); libTEST_gv_value = libTEST_gf_work(4); return value + libTEST_gv_value; }';
    const { script, reparsed } = roundtrip(source);
    const functions = Object.values(reparsed.elements).filter(e => e.type === 'FunctionDef' && e.name === 'work');
    expect(functions).toHaveLength(2);
    expect(new Set(functions.map(e => e.id)).size).toBe(2);
    functionBody(script, 'work');
    functionBody(script, 'libTEST_gf_work');
    const variables = Object.values(reparsed.elements).filter(e => e.type === 'Variable' && e.name === 'value');
    expect(variables).toHaveLength(2);
    expect(new Set(variables.map(e => e.id)).size).toBe(2);
    expect(script).toMatch(/ value = work\(3\);/u);
    expect(script).toMatch(/libTEST_gv_value = libTEST_gf_work\(4\);/u);
  });

  it('does not mutate a loaded dependency when a source definition uses the same name', () => {
    const dependency = library(el('FunctionDef', '00000001', '<Identifier>Work</Identifier><FlagAction/><FlagNoScriptPrefix/>'), 'EXT');
    const before = serializeTriggerLibrary(dependency);
    const { script, reparsed } = roundtrip('void Work() { return; }', [dependency]);
    functionBody(script, 'Work');
    expect(Object.values(reparsed.elements).some(e => e.type === 'FunctionDef' && e.name === 'Work')).toBe(true);
    expect(serializeTriggerLibrary(dependency)).toBe(before);
  });

  it('keeps trigger early returns while stripping only the verified wrapper tail', () => {
    const { script } = roundtrip('bool libTEST_gt_Run_Func(bool testConds, bool runActions) { int value = 7; if (!runActions) { return true; } return true; value = 9; return true; }');
    const body = script.slice(script.indexOf('bool libTEST_gt_Run_Func ('), script.indexOf('void libTEST_gt_Run_Init ('));
    const early = body.indexOf('return true;', body.indexOf('= 7;'));
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(body.indexOf('= 9;'));
  });

  // COOP maps (06-MistOpportunities): a call into a library that is not loaded keeps its own
  // name inside a parameter expression instead of naming a function of another library.
  it('keeps a call the loaded library does not define inside a parameter expression', () => {
    const dependency = library(el('FunctionDef', '00000001', '<Identifier>Known</Identifier>'), 'ZZZ');
    const source = [
      'int libZZZ_gf_Missing(int lp_task);',
      'bool libTEST_gt_Run_Func (bool testConds, bool runActions) {',
      '    // Variable Declarations',
      '    int lv_v;',
      '',
      '    // Variable Initialization',
      '    lv_v = libZZZ_gf_Missing(3) + 1;',
      '',
      '    // Implementation',
      '    return true;',
      '}',
    ].join('\n');
    const { script, restored } = roundtrip(source, [dependency]);
    expect(script).toContain('libZZZ_gf_Missing(3)');
    // A reference to a function the loaded library does not define fails the service's
    // reference validation, which rejects the whole document.
    expect(Object.values(restored.elements).filter((element: any) =>
      element.functionDef?.library === 'ZZZ' && element.functionDef?.id === 'Missing')).toEqual([]);
  });

  // KeyStone (gf_RetiredFeatureDeck): the editor writes and compiles actions after a return,
  // so the final authored Return must survive.
  it('keeps an authored final return after an earlier return in a function', () => {
    const { script } = roundtrip('void observe(); int libTEST_gf_Pick() { return 1; observe(); return 2; }');
    expect(functionBody(script, 'libTEST_gf_Pick').map((node: any) => node.expression?.text ?? node.expression?.expression?.name))
      .toEqual(['1', 'observe', '2']);
  });

  // Mercs Episodes: SC2 Editor writes no runActions guard into a trigger without actions.
  it('writes the runActions guard only into a trigger that has actions', () => {
    const { script, reparsed } = roundtrip(`trigger TriggerCreate(string callback); void observe(); trigger libTEST_gt_Empty; trigger libTEST_gt_Busy;
      bool libTEST_gt_Empty_Func(bool testConds, bool runActions) { return true; }
      void libTEST_gt_Empty_Init() { libTEST_gt_Empty = TriggerCreate("libTEST_gt_Empty_Func"); }
      bool libTEST_gt_Busy_Func(bool testConds, bool runActions) { if (!runActions) { return true; } observe(); return true; }
      void libTEST_gt_Busy_Init() { libTEST_gt_Busy = TriggerCreate("libTEST_gt_Busy_Func"); }`);
    expect(Object.values(reparsed.elements).filter(e => e.type === 'Trigger')).toHaveLength(2);
    const guards = (name: string) => functionBody(script, name).filter((node: any) => node.expression?.operand?.name === 'runActions').length;
    expect([guards('libTEST_gt_Empty_Func'), guards('libTEST_gt_Busy_Func')]).toEqual([0, 1]);
  });

  it('preserves trigger-like handles without a verified callback and initializer', () => {
    const { script, header, reparsed } = roundtrip('trigger TriggerCreate(string callback); trigger libTEST_gt_Manual; void createManual() { libTEST_gt_Manual = TriggerCreate("manual"); }');
    expect(Object.values(reparsed.elements).filter(e => e.type === 'Trigger')).toHaveLength(0);
    expect(header).toContain('trigger libTEST_gt_Manual;');
    expect(script).toContain('libTEST_gt_Manual = TriggerCreate("manual");');
  });

  it('preserves additional commands in a trigger initializer as structured functions', () => {
    const source = `trigger TriggerCreate(string callback); void observe(); trigger libTEST_gt_Manual;
      bool libTEST_gt_Manual_Func(bool testConds, bool runActions) { if (!runActions) { return true; } return true; }
      void libTEST_gt_Manual_Init() { libTEST_gt_Manual = TriggerCreate("libTEST_gt_Manual_Func"); observe(); }`;
    const { script, reparsed } = roundtrip(source);
    expect(Object.values(reparsed.elements).filter(e => e.type === 'Trigger')).toHaveLength(0);
    const initializer = functionBody(script, 'libTEST_gt_Manual_Init');
    expect(initializer).toHaveLength(2);
    expect(initializer[1].expression.expression.name).toBe('observe');
  });

  it('requires the whole runActions guard before treating a callback name as an editor trigger', () => {
    const { script, reparsed } = roundtrip('void observe(); bool libTEST_gt_NotAWrapper_Func(bool testConds, bool runActions) { if (!runActions) { observe(); return true; } return true; }');
    expect(Object.values(reparsed.elements).filter(e => e.type === 'Trigger')).toHaveLength(0);
    functionBody(script, 'libTEST_gt_NotAWrapper_Func');
    expect(script).toContain('observe();');
  });

  it('recovers only fully verified event registration and an initially-off trigger', () => {
    const dependency = library(el('ParamDef', '00000001', '<Identifier>period</Identifier><ParameterType><Type Value="int"/></ParameterType>') +
      el('FunctionDef', '00000002', '<Identifier>Watch</Identifier><FlagEvent/><FlagNative/><FlagNoScriptPrefix/>' + ref('Parameter', 'ParamDef', '00000001', 'EXT')), 'EXT');
    const source = `trigger libTEST_gt_Event;
      bool libTEST_gt_Event_Func(bool testConds, bool runActions) { if (!runActions) { return true; } return true; }
      void libTEST_gt_Event_Init() { libTEST_gt_Event = TriggerCreate("libTEST_gt_Event_Func"); Watch(libTEST_gt_Event, 4); TriggerEnable(libTEST_gt_Event, false); }`;
    const { script, reparsed } = roundtrip(source, [dependency]);
    const trigger: any = Object.values(reparsed.elements).find(e => e.type === 'Trigger');
    // TriggerEnable(handle, false) inside the trigger's own init function is the
    // editor's "Initially Off"; a disabled trigger has no init function at all.
    expect(trigger).toMatchObject({ initOff: true, events: [expect.objectContaining({ type: 'FunctionCall' })] });
    expect(trigger.disabled).toBeUndefined();
    expect(script).toContain('Watch(libTEST_gt_Event, 4);');
    expect(script).toContain('TriggerEnable(libTEST_gt_Event, false);');
  });

  // City of Tempest: TriggerAddEventUnitGainLevel(gt_LevelUp, UnitRefFromUnit(EventUnit())). The Param holds the
  // unit value; the wrapper is the compiler's, and it used to become a map-local native FunctionDef.
  it('keeps the unit value a UnitRefFromUnit wrapper passes to a unit reference formal', () => {
    const dependency = library(
      el('ParamDef', '00000001', '<Identifier>unit</Identifier><ParameterType><Type Value="unit"/></ParameterType><ParamFlagReference/>') +
      el('FunctionDef', '00000002', '<Identifier>WatchUnit</Identifier><FlagEvent/><FlagNative/><FlagNoScriptPrefix/>' + ref('Parameter', 'ParamDef', '00000001', 'EXT')) +
      el('FunctionDef', '00000003', '<Identifier>EventUnit</Identifier><FlagCall/><FlagNative/><FlagNoScriptPrefix/><ReturnType><Type Value="unit"/></ReturnType>'),
      'EXT');
    const source = `trigger libTEST_gt_Watch;
      bool libTEST_gt_Watch_Func(bool testConds, bool runActions) { if (!runActions) { return true; } return true; }
      void libTEST_gt_Watch_Init() { libTEST_gt_Watch = TriggerCreate("libTEST_gt_Watch_Func"); WatchUnit(libTEST_gt_Watch, UnitRefFromUnit(EventUnit())); }`;
    const { script, reparsed } = roundtrip(source, [dependency]);
    expect(Object.values(reparsed.elements).some((element: any) => element.type === 'FunctionDef' && element.name === 'UnitRefFromUnit')).toBe(false);
    expect(script).toContain('WatchUnit(libTEST_gt_Watch, UnitRefFromUnit(EventUnit()));');
  });

  it('initializes only dependency variables from a library even when its public initializer is allocated', () => {
    const dependency = library(el('FunctionDef', '00000001', '<Identifier>libEXT_InitLib</Identifier><FlagAction/><FlagNoScriptPrefix/>') +
      el('Variable', '00000002', '<Identifier>Score</Identifier><VariableType><Type Value="int"/></VariableType>'), 'EXT');
    const { script } = roundtrip('int external() { return libEXT_gv_score; }', [dependency]);
    expect(script).toContain('libEXT_InitVariables();');
    expect(script).not.toContain('\tlibEXT_InitLib();');
    expect(script).not.toContain('\tlibEXT_InitLib_1();');
  });

  it.each([
    [' && ', 'true || false', 'false', '(true || false) && false', 'bool'],
    [' * ', '2 + 3', '4', '(2 + 3) * 4', 'int'],
    [' - ', '9', '5 - 2', '9 - (5 - 2)', 'int'],
  ])('preserves child-expression grouping in a ScriptCode subfunction separator %s', (separator, left, right, expected, type) => {
    const source = library(
      el('SubFuncType', '00000001', '<Identifier>operands</Identifier>') +
      el('FunctionDef', '00000002', `<Identifier>Sequence</Identifier><FlagCall/><FlagSubFunctions/><Template/><ReturnType><Type Value="${type}"/></ReturnType>` +
        ref('SubFunctionType', 'SubFuncType', '00000001') + `<ScriptCode><![CDATA[#SUBFUNCS(operands,${JSON.stringify(separator)})]]></ScriptCode>`) +
      el('FunctionDef', '00000003', `<Identifier>Left</Identifier><FlagCall/><Template/><ReturnType><Type Value="${type}"/></ReturnType><ScriptCode><![CDATA[${left}]]></ScriptCode>`) +
      el('FunctionDef', '00000004', `<Identifier>Right</Identifier><FlagCall/><Template/><ReturnType><Type Value="${type}"/></ReturnType><ScriptCode><![CDATA[${right}]]></ScriptCode>`) +
      el('ParamDef', '00000005', `<Identifier>value</Identifier><ParameterType><Type Value="${type}"/></ParameterType>`) +
      el('FunctionDef', '00000006', '<Identifier>Return</Identifier><FlagAction/><Template/>' + ref('Parameter', 'ParamDef', '00000005') + '<ScriptCode>return #PARAM(value);</ScriptCode>') +
      el('FunctionDef', '00000007', `<Identifier>Compute</Identifier><FlagCall/><ReturnType><Type Value="${type}"/></ReturnType>` + ref('FunctionCall', 'FunctionCall', '00000008')) +
      el('FunctionCall', '00000008', ref('FunctionDef', 'FunctionDef', '00000006') + ref('Parameter', 'Param', '00000009')) +
      el('Param', '00000009', ref('ParameterDef', 'ParamDef', '00000005') + ref('FunctionCall', 'FunctionCall', '0000000A')) +
      el('FunctionCall', '0000000A', ref('FunctionDef', 'FunctionDef', '00000002') + ref('FunctionCall', 'FunctionCall', '0000000B') + ref('FunctionCall', 'FunctionCall', '0000000C')) +
      el('FunctionCall', '0000000B', ref('FunctionDef', 'FunctionDef', '00000003') + ref('SubFunctionType', 'SubFuncType', '00000001')) +
      el('FunctionCall', '0000000C', ref('FunctionDef', 'FunctionDef', '00000004') + ref('SubFunctionType', 'SubFuncType', '00000001')),
    );
    const { script } = convertTriggerLibraryToGalaxyFull(source);
    const actual = functionBody(script, 'libTEST_gf_Compute')[0].expression;
    const wanted = functionBody(`${type} expected() { return ${expected}; }`, 'expected')[0].expression;
    expect(syntaxShape(actual)).toEqual(syntaxShape(wanted));
  });

  it.each(['BranchFromPlugin', 'WhileDo', 'TotallyDifferent'])('matches loaded templates and real role identifiers despite display name %s', name => {
    const dependency = library(
      el('ParamDef', '00000001', '<Identifier>choice</Identifier><ParameterType><Type Value="bool"/></ParameterType>') +
      el('SubFuncType', '00000002', '<Identifier>chosen</Identifier><Action/>') +
      el('SubFuncType', '00000003', '<Identifier>otherwise</Identifier><Action/>') +
      el('FunctionDef', '00000004', `<Identifier>${name}</Identifier><FlagAction/><FlagSubFunctions/><Template/>` +
        ref('Parameter', 'ParamDef', '00000001', 'EXT') + ref('SubFunctionType', 'SubFuncType', '00000002', 'EXT') + ref('SubFunctionType', 'SubFuncType', '00000003', 'EXT') +
        '<ScriptCode><![CDATA[if (#PARAM(choice)) { #SUBFUNCS(chosen) } else { #SUBFUNCS(otherwise) }]]></ScriptCode>'), 'EXT');
    const { restored, script } = roundtrip('void perform(bool enabled) { if ((enabled)) { return; } else { return; } }', [dependency]);
    expect(Object.values(restored.elements).some((e: any) => e.type === 'FunctionCall' && e.functionDef?.library === 'EXT' && e.functionDef?.id === '00000004')).toBe(true);
    expect(script).toContain('if (lp_enabled)');
    expect(script).not.toContain(`${name}(`);
  });

  it('resolves ordinary function calls from dependency XML through the public operation', async () => {
    const dependency = xml(el('FunctionDef', '00000007', '<Identifier>Help</Identifier><FlagAction/>'), 'OTHER');
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'void perform() { libOTHER_gf_Help(); }', header: '', dependencyLibraries: [{ triggerData: dependency }] });
    expect(result.output.triggerData).toContain('<FunctionDef Type="FunctionDef" Library="OTHER" Id="00000007"/>');
    expect(result.output.triggerData).not.toContain('FlagCustomScript');
  });

  // Editor originals: a map includes `TriggerLibs/SwarmCampaignLib` and `LibEBBC9C87` whole, and
  // LibARMP includes LibB09742AC of another mod before its own header, with nothing at the end.
  it.each([
    ['Base.SC2Data/TriggerLibs/OtherLib.SC2Lib', 'TriggerLibs/OtherLib'],
    ['Triggers', 'LibOTHER'],
  ])('includes a library of another package whole, by its file: %s', async (sourcePath, include) => {
    const dependency = { triggerData: xml(el('FunctionDef', '00000007', '<Identifier>Help</Identifier><FlagAction/>'), 'OTHER'), sourcePath };
    const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'void perform() { libOTHER_gf_Help(); }', header: '', dependencyLibraries: [dependency] });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'TEST', dependencyLibraries: [dependency] });
    const includes = [...forward.output.script.matchAll(/^include "([^"]+)"/gmu)].map(match => match[1]);
    expect(includes).toEqual(['TriggerLibs/NativeLib', include, 'LibTEST_h']);
  });

  // Off by default: a file such as Ice Baneling's TextureMap.galaxy belongs to the include graph of a mod.
  it('turns other Galaxy files of a map into triggers, in a folder named after the file, only when asked', async () => {
    const script = 'include "Extra"\nvoid gf_Use() { initData(); }\n';
    const extra = { fileName: 'Extra.galaxy', text: 'int[2] data;\nvoid initData() { data[0] = 1; data[1] = 2; }\n' };
    // A map file the script does not include, such as one overriding a file a mod includes and calls.
    const hook = { fileName: 'TextureMap.galaxy', text: 'string[2] tm;\nvoid initTextureMap() { tm[0] = "a"; }\n' };
    const kept = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script, header: '', additionalScripts: [extra] });
    expect(kept.output.convertedScripts).toBeUndefined();
    expect(kept.output.triggerData).not.toContain('<Identifier>initData</Identifier>');
    const converted = await convertGalaxyToTriggers({
      libraryId: 'Map', documentKind: 'map', script, header: '', additionalScripts: [extra, hook], convertAdditionalScripts: true,
    });
    expect(converted.output.convertedScripts).toEqual(['Extra.galaxy']);
    expect(converted.output.triggerData).not.toContain('initTextureMap');
    expect(converted.fidelity.diagnostics.find((item: any) => item.code === 'sc2-triggers/additional-script-not-included')?.details)
      .toEqual({ fileName: 'TextureMap.galaxy' });
    expect(converted.output.triggerStrings).toMatch(/^Category\/Name\/\w+=Extra\.galaxy$/mu);
    const forward = await convertTriggersToGalaxy(converted.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: converted.output.triggerStrings,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program).toContain('int[2] data;');
    expect(program).toContain('void initData () {');
    expect(program).not.toContain('include "Extra"');
  });

  // EditorTest.SC2Map was converted by Modkit before: its strings use ids of the range fresh ids come from,
  // and a string variable took the name of the source's A00008FC ("auto2812FAE7 n").
  it('keeps fresh element ids clear of the ids the source strings use', async () => {
    const taken = Array.from({ length: 16 }, (_, index) => (0xA0000000 + index).toString(16).toUpperCase());
    const triggerStrings = taken.flatMap(id => [`Variable/Name/${id}=auto2812FAE7 n`, `FunctionDef/Name/${id}=Other`]).join('\n');
    const result = await convertGalaxyToTriggers({
      libraryId: 'Map', documentKind: 'map', script: 'string gv_s;\nvoid gf_Use() { gv_s = "x"; }\n', header: '', triggerStrings,
    });
    expect(result.output.triggerStrings).toMatch(/^Variable\/Name\/[0-9A-F]{8}=s$/mu);
    expect(result.output.triggerStrings).toMatch(/^FunctionDef\/Name\/[0-9A-F]{8}=Use$/mu);
    expect(result.output.triggerStrings).not.toContain('auto2812FAE7');
    expect(result.output.triggerStrings).not.toContain('=Other');
  });

  // The names of a library document live in its TriggerStrings; its own name among them (Library/Name/<Id>).
  it('writes the library name from the authored strings, else from the editor banner over its code', async () => {
    const script = '//----------------------------------------\n// Library: All Races\n//----------------------------------------\nvoid libLIB_gf_Go() {\n}\n';
    const fromBanner = await convertGalaxyToTriggers({ libraryId: 'LIB', documentKind: 'library', script, header: '' });
    expect(fromBanner.output.triggerStrings).toMatch(/^﻿?Library\/Name\/LIB=All Races$/mu);
    const authored = await convertGalaxyToTriggers({
      libraryId: 'LIB', documentKind: 'library', script, header: '', triggerStrings: 'Library/Name/LIB=Every Race\n',
    });
    expect(authored.output.triggerStrings).toMatch(/^﻿?Library\/Name\/LIB=Every Race$/mu);
    expect(authored.output.triggerStrings).not.toContain('=All Races');
    const map = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script: 'void gf_Go() {\n}\n', header: '' });
    expect(map.output.triggerStrings ?? '').not.toContain('Library/Name/');
  });

  it('binds unnamed dependency functions through a fully verified generated-header sequence', async () => {
    const dependency = xml(
      '<Root>' + ref('Item', 'Category', '00000001', 'EXT') + '</Root>' +
      el('Category', '00000001', ref('Item', 'FunctionDef', '00000002', 'EXT') + ref('Item', 'FunctionDef', '00000008', 'EXT') + ref('Item', 'FunctionDef', '00000009', 'EXT') + ref('Item', 'FunctionDef', '00000007', 'EXT') + ref('Item', 'FunctionDef', '00000003', 'EXT') + ref('Item', 'FunctionDef', '00000006', 'EXT')) +
      el('FunctionDef', '00000002', '<Identifier>InlineBranch</Identifier><FlagAction/><FlagSubFunctions/>') +
      el('FunctionDef', '00000008', '<Identifier>DisabledHelper</Identifier><Disabled/><FlagAction/>') +
      el('FunctionDef', '00000009', '<Identifier>InlineOperator</Identifier><FlagCall/><FlagOperator/><ReturnType><Type Value="int"/></ReturnType>') +
      el('FunctionDef', '00000007', '<Identifier>OnEvent</Identifier><FlagInternal/><FlagEvent/>') +
      el('FunctionDef', '00000003', '<Identifier>Known</Identifier><FlagAction/>') +
      el('ParamDef', '00000004', '<ParameterType><Type Value="bool"/></ParameterType>') +
      el('ParamDef', '00000005', '<ParameterType><Type Value="string"/></ParameterType>') +
      el('FunctionDef', '00000006', '<FlagAction/>' + ref('Parameter', 'ParamDef', '00000004', 'EXT') + ref('Parameter', 'ParamDef', '00000005', 'EXT')),
      'EXT',
    );
    const galaxyDeclarations = [{ fileName: 'Library_h.galaxy', text: 'void libEXT_gf_OnEvent(trigger lp_trigger);\nvoid libEXT_gf_Known();\nvoid libEXT_gf_Target(bool lp_enabled, string lp_value);' }];
    const result = await convertGalaxyToTriggers({
      libraryId: 'TEST',
      script: 'void perform() { libEXT_gf_Target(true, "value"); }',
      header: '',
      dependencyLibraries: [{ triggerData: dependency }],
      galaxyDeclarations,
    });
    const restored = parseTriggerXmlSync(result.output.triggerData).get('TEST')!;
    expect(Object.values(restored.elements).some((element: any) =>
      element.type === 'FunctionCall' && element.functionDef?.library === 'EXT' && element.functionDef?.id === '00000006')).toBe(true);
    expect(Object.values(restored.elements).some((element: any) =>
      element.type === 'FunctionDef' && element.library === 'TEST' && element.scriptCode?.includes('libEXT_gf_Target'))).toBe(false);
    const forward = await convertTriggersToGalaxy(result.output.triggerData, {
      libraryId: 'TEST', dependencyLibraries: [{ triggerData: dependency }], galaxyDeclarations,
    });
    expect(forward.output.script).toContain('libEXT_gf_Target(true, "value");');
    expect(forward.output.script).not.toContain('libEXT_gf_00000006');
  });

  it('prefers an exact dependency call and resolves unnamed integer presets through loaded constants', async () => {
    const dependency = xml(
      el('PresetValue', '00000001', '') +
      el('PresetValue', '00000002', '') +
      el('Preset', '00000003', '<PresetInteger/><BaseType Value="int"/><PresetGenConstVar/>' +
        ref('Item', 'PresetValue', '00000001', 'EXT') + ref('Item', 'PresetValue', '00000002', 'EXT')) +
      el('ParamDef', '00000004', '<Identifier>mode</Identifier><ParameterType><Type Value="preset"/>' +
        ref('TypeElement', 'Preset', '00000003', 'EXT') + '</ParameterType>') +
      el('ParamDef', '00000005', '<Identifier>target</Identifier><ParameterType><Type Value="unit"/></ParameterType>') +
      el('FunctionDef', '00000006', '<Identifier>Act</Identifier><FlagAction/>' +
        ref('Parameter', 'ParamDef', '00000004', 'EXT') + ref('Parameter', 'ParamDef', '00000005', 'EXT')),
      'EXT',
    );
    const result = await convertGalaxyToTriggers({
      libraryId: 'TEST',
      script: 'void perform() { libEXT_gf_Act(libEXT_ge_Mode_Last, UnitFromId(384)); }',
      header: '',
      dependencyLibraries: [{ triggerData: dependency }],
      galaxyDeclarations: [{ fileName: 'LibEXT_h.galaxy', text: 'const int libEXT_ge_Mode_Last = 1;' }],
    });
    const restored = parseTriggerXmlSync(result.output.triggerData).get('TEST')!;
    const call = Object.values(restored.elements).find((element: any) =>
      element.type === 'FunctionCall' && element.functionDef?.library === 'EXT' && element.functionDef?.id === '00000006') as any;
    expect(call).toBeDefined();
    const params = call.parameters.map((parameter: any) => lookupElement([restored], parameter, 'TEST') as any);
    expect(params[0].preset).toEqual({ type: 'PresetValue', library: 'EXT', id: '00000002' });
    expect(params[1]).toMatchObject({ valueId: '384', valueType: { type: 'unit' } });
    expect(Object.values(restored.elements).some((element: any) => element.type === 'FunctionDef' && element.library === 'TEST' && element.scriptCode?.includes('libEXT_gf_Act'))).toBe(false);
  });

  it('links dependency variables and functions with return values by their declared symbols', () => {
    const dependency = library(el('Variable', '00000001', '<Identifier>Score</Identifier><VariableType><Type Value="int"/></VariableType>') +
      el('FunctionDef', '00000002', '<Identifier>Fetch</Identifier><FlagCall/><ReturnType><Type Value="int"/></ReturnType>'), 'EXT');
    const { restored } = roundtrip('int externalValue() { return libEXT_gv_score + libEXT_gf_Fetch(); }', [dependency]);
    expect(Object.values(restored.elements).some((e: any) => e.type === 'Param' && e.variable?.library === 'EXT' && e.variable?.id === '00000001')).toBe(true);
    expect(Object.values(restored.elements).some((e: any) => e.type === 'FunctionCall' && e.functionDef?.library === 'EXT' && e.functionDef?.id === '00000002')).toBe(true);
  });

  it('preserves ScriptCode whitespace and game types through XML serialization', () => {
    const code = '\n  // comment\n\treturn #PARAM(value);\n';
    const source = library(el('FunctionDef', '00000001', `<FlagAction/><ScriptCode><![CDATA[${code}]]></ScriptCode>`) + el('Param', '00000002', '<ValueType Type="gamelink"/><ValueGameType Type="Unit"/><Value>Marine</Value>'));
    const reparsed = parseTriggerXmlSync(serializeTriggerLibrary(source)).get('TEST')!;
    expect(reparsed.elementsByType.FunctionDef['00000001'].scriptCode).toBe(code);
    expect(reparsed.elementsByType.Param['00000002'].valueType).toEqual({ type: 'gamelink', gameType: 'Unit' });
  });

  it('recovers gamelink namespaces from loaded parameter contracts', () => {
    const native = library(
      el('ParamDef', '00000001', '<ParameterType><Type Value="gamelink"/><GameType Value="Model"/></ParameterType>') +
      el('FunctionDef', '00000002', '<Identifier>UseLink</Identifier><FlagNative/><FlagAction/>' + ref('Parameter', 'ParamDef', '00000001', 'Ntve')),
      'Ntve',
    );
    const restored = convertGalaxyToTriggerLibrary(
      parseGalaxySource('void perform() { UseLink("PingAlert"); }'),
      parseGalaxySource(''),
      { libraryId: 'TEST', nativeLibrary: native, galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native void UseLink(string value);' }] },
    );
    const param = Object.values(restored.elements).find((element: any) => element.type === 'Param' && element.value === 'PingAlert') as any;
    expect(param.valueType).toEqual({ type: 'gamelink', gameType: 'Model' });
  });

  it('uses loaded Galaxy declarations to lower concatenation for a string-backed editor domain', () => {
    const native = library(
      el('ParamDef', 'TARGET', '<ParameterType><Type Value="actormsg"/></ParameterType>') +
      el('FunctionDef', 'USE', '<Identifier>UseActorMessage</Identifier><FlagNative/><FlagAction/>' + ref('Parameter', 'ParamDef', 'TARGET', 'Ntve')) +
      el('ParamDef', 'OPERAND', '<ParameterType><Type Value="string"/></ParameterType>') +
      el('FunctionDef', 'COMBINE', '<Identifier>CombineStringsMult</Identifier><FlagOperator/><FlagCall/><ReturnType><Type Value="string"/></ReturnType>' + ref('Parameter', 'ParamDef', 'OPERAND', 'Ntve')),
      'Ntve',
    );
    const restored = convertGalaxyToTriggerLibrary(
      parseGalaxySource('void perform(string part) { UseActorMessage("Signal " + part + " end"); }'),
      parseGalaxySource(''),
      {
        libraryId: 'TEST',
        nativeLibrary: native,
        galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native void UseActorMessage(string value);' }],
      },
    );
    const stringOperator = Object.values(restored.elements).find((element: any) =>
      element.type === 'FunctionDef' && element.returnType?.type === 'string' && element.scriptCode === '#PARAM(left) + #PARAM(right)') as any;
    expect(stringOperator).toBeDefined();
    expect(Object.values(restored.elements).some((element: any) =>
      element.type === 'FunctionDef' && /^ArithmeticInt(?:Mult)?$/u.test(element.name ?? ''))).toBe(false);
  });

  it('materializes called native Galaxy declarations that have no TriggerLib FunctionDef', () => {
    const restored = normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(
      parseGalaxySource('bool checkExpansion(int player) { return AIHasNearbyOpenExpansion(player); }'),
      parseGalaxySource(''),
      {
        libraryId: 'TEST',
        galaxyDeclarations: [{
          fileName: 'AI.galaxy',
          text: 'native bool AIHasNearbyOpenExpansion(int player); native bool UnusedNative(int player);',
        }],
      },
    ));
    const definition = Object.values(restored.elements).find((element: any) =>
      element.type === 'FunctionDef' && element.name === 'AIHasNearbyOpenExpansion') as any;
    expect(definition).toMatchObject({
      library: 'TEST',
      flags: expect.arrayContaining(['Native', 'NoScriptPrefix']),
      isFuncCall: true,
      returnType: { type: 'bool' },
    });
    expect(definition.parameters).toHaveLength(1);
    expect(Object.values(restored.elements).some((element: any) =>
      element.type === 'FunctionDef' && element.name === 'UnusedNative')).toBe(false);
    expect(Object.values(restored.elements).some((element: any) =>
      element.type === 'FunctionCall' && element.functionDef?.library === 'TEST' && element.functionDef?.id === definition.id)).toBe(true);
    expect(() => assertConversionReferences(restored, new Map())).not.toThrow();
  });

  // Editor oracle (Star Party v): 111 loop bodies read a local copy of the loop
  // variable, which the editor-regenerated loop never assigns.
  it('reads a loaded loop variable inside its action body through the contextual accessor', () => {
    const native = library(
      el('ParamDef', 'GROUP', '<Identifier>group</Identifier><ParameterType><Type Value="unitgroup"/></ParameterType>') +
      el('SubFuncType', 'ACTIONS', '<Identifier>actions</Identifier><Action/>') +
      el('FunctionDef', 'EACH', '<Identifier>EachUnit</Identifier><FlagAction/><FlagSubFunctions/>' +
        ref('Parameter', 'ParamDef', 'GROUP', 'Ntve') + ref('SubFunctionType', 'SubFuncType', 'ACTIONS', 'Ntve') +
        '<ScriptCode>#AUTOVAR(g, unitgroup) = #PARAM(group);\n#AUTOVAR(u) = UnitGroupCount(#AUTOVAR(g), c_unitCountAll);\n' +
        'for (;; #AUTOVAR(u) -= 1) {\n#AUTOVAR(var) = UnitGroupUnitFromEnd(#AUTOVAR(g), #AUTOVAR(u));\nif (#AUTOVAR(var) == null) { break; }\n#SUBFUNCS(actions)\n}</ScriptCode>') +
      el('FunctionDef', 'CURRENT', '<Identifier>EachUnitCurrent</Identifier><FlagCall/><FlagOperator/><ReturnType><Type Value="unit"/></ReturnType><ScriptCode>#AUTOVAR(var,ancestor:EachUnit)</ScriptCode>') +
      el('ParamDef', 'TARGET', '<Identifier>target</Identifier><ParameterType><Type Value="unit"/></ParameterType>') +
      el('FunctionDef', 'REMOVE', '<Identifier>UnitRemove</Identifier><FlagNative/><FlagAction/>' + ref('Parameter', 'ParamDef', 'TARGET', 'Ntve')),
      'Ntve',
    );
    const restored = normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(
      parseGalaxySource(`void libTEST_gf_Clean(unitgroup lp_group) {
        unitgroup auto11111111_g;
        int auto11111111_u;
        unit auto11111111_var;
        auto11111111_g = lp_group;
        auto11111111_u = UnitGroupCount(auto11111111_g, c_unitCountAll);
        for (;; auto11111111_u -= 1) {
          auto11111111_var = UnitGroupUnitFromEnd(auto11111111_g, auto11111111_u);
          if (auto11111111_var == null) { break; }
          UnitRemove(auto11111111_var);
        }
      }`),
      parseGalaxySource('void libTEST_gf_Clean(unitgroup lp_group);'),
      {
        libraryId: 'TEST',
        nativeLibrary: native,
        galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'const int c_unitCountAll = 0; native int UnitGroupCount(unitgroup g, int f); native unit UnitGroupUnitFromEnd(unitgroup g, int i); native void UnitRemove(unit u);' }],
      },
    ));
    const calls = Object.values(restored.elements).filter((element: any) => element.type === 'FunctionCall') as any[];
    expect(calls.some(call => call.functionDef?.id === 'EACH')).toBe(true);
    const remove = calls.find(call => call.functionDef?.id === 'REMOVE');
    const target = restored.elements[remove?.parameters?.[0]?.id] as any;
    expect(target?.variable).toBeUndefined();
    expect((restored.elements[target?.functionCall?.id] as any)?.functionDef?.id).toBe('CURRENT');
    expect(Object.values(restored.elements).some((element: any) => element.type === 'Variable' && element.name?.includes('auto11111111'))).toBe(false);
  });

  // Editor oracle (UEDFL_EP01M19): the editor names a loop's private variables after
  // the loop call's id, so a restored loop with a fresh id renamed auto9DE7D937_var
  // to autoA00000D8_var on the next compile.
  it('gives a restored loop the call id its automatic variables are named after', () => {
    const native = library(
      el('ParamDef', 'GROUP', '<Identifier>group</Identifier><ParameterType><Type Value="unitgroup"/></ParameterType>') +
      el('SubFuncType', 'ACTIONS', '<Identifier>actions</Identifier><Action/>') +
      el('FunctionDef', 'EACH', '<Identifier>EachUnit</Identifier><FlagAction/><FlagSubFunctions/>' +
        ref('Parameter', 'ParamDef', 'GROUP', 'Ntve') + ref('SubFunctionType', 'SubFuncType', 'ACTIONS', 'Ntve') +
        '<ScriptCode>#AUTOVAR(g, unitgroup) = #PARAM(group);\n#AUTOVAR(u) = UnitGroupCount(#AUTOVAR(g), c_unitCountAll);\n' +
        'for (;; #AUTOVAR(u) -= 1) {\n#AUTOVAR(var) = UnitGroupUnitFromEnd(#AUTOVAR(g), #AUTOVAR(u));\nif (#AUTOVAR(var) == null) { break; }\n#SUBFUNCS(actions)\n}</ScriptCode>') +
      el('FunctionDef', 'CURRENT', '<Identifier>EachUnitCurrent</Identifier><FlagCall/><FlagOperator/><ReturnType><Type Value="unit"/></ReturnType><ScriptCode>#AUTOVAR(var,ancestor:EachUnit)</ScriptCode>') +
      el('ParamDef', 'TARGET', '<Identifier>target</Identifier><ParameterType><Type Value="unit"/></ParameterType>') +
      el('FunctionDef', 'REMOVE', '<Identifier>UnitRemove</Identifier><FlagNative/><FlagAction/>' + ref('Parameter', 'ParamDef', 'TARGET', 'Ntve')),
      'Ntve',
    );
    const restored = normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(
      parseGalaxySource(`void libTEST_gf_Clean(unitgroup lp_group) {
        unitgroup auto9DE7D937_g;
        int auto9DE7D937_u;
        unit auto9DE7D937_var;
        auto9DE7D937_g = lp_group;
        auto9DE7D937_u = UnitGroupCount(auto9DE7D937_g, c_unitCountAll);
        for (;; auto9DE7D937_u -= 1) {
          auto9DE7D937_var = UnitGroupUnitFromEnd(auto9DE7D937_g, auto9DE7D937_u);
          if (auto9DE7D937_var == null) { break; }
          UnitRemove(auto9DE7D937_var);
        }
      }`),
      parseGalaxySource('void libTEST_gf_Clean(unitgroup lp_group);'),
      {
        libraryId: 'TEST',
        nativeLibrary: native,
        galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'const int c_unitCountAll = 0; native int UnitGroupCount(unitgroup g, int f); native unit UnitGroupUnitFromEnd(unitgroup g, int i); native void UnitRemove(unit u);' }],
      },
    ));
    const loop = Object.values(restored.elements).find((element: any) => element.type === 'FunctionCall' && element.functionDef?.id === 'EACH') as any;
    expect(loop?.id).toBe('9DE7D937');
  });

  // Editor oracle (Star Party v): 88 Pick Each Player loops came back as For Each
  // Player over an extra local, because both templates expand to the same Galaxy.
  it.each([
    ['an editor auto variable', 'auto22222222_var', 'PICK'],
    ['an authored local', 'lv_p', 'FOREACH'],
  ])('restores a player loop over %s with the template that owns the variable', (_shape, iterator, expected) => {
    const loop = (variable: string) => `#AUTOVAR(g, playergroup) = #PARAM(group);\n${variable} = -1;\nwhile (true) {\n` +
      `${variable} = PlayerGroupNextPlayer(#AUTOVAR(g), ${variable});\nif (${variable} &lt; 0) { break; }\n#SUBFUNCS(actions)\n}`;
    const native = library(
      el('ParamDef', 'GROUP', '<Identifier>group</Identifier><ParameterType><Type Value="playergroup"/></ParameterType>') +
      el('ParamDef', 'VAR', '<Identifier>var</Identifier><ParameterType><Type Value="anyvariable"/><VariableType Value="int"/></ParameterType><ParamFlagReference/>') +
      el('SubFuncType', 'ACTIONS', '<Identifier>actions</Identifier><Action/>') +
      el('FunctionDef', 'FOREACH', '<Identifier>ForEachPlayer</Identifier><FlagAction/><FlagSubFunctions/>' + ref('Parameter', 'ParamDef', 'VAR', 'Ntve') +
        ref('Parameter', 'ParamDef', 'GROUP', 'Ntve') + ref('SubFunctionType', 'SubFuncType', 'ACTIONS', 'Ntve') + `<ScriptCode>${loop('#PARAM(var)')}</ScriptCode>`) +
      el('FunctionDef', 'PICK', '<Identifier>PickEachPlayer</Identifier><FlagAction/><FlagSubFunctions/>' +
        ref('Parameter', 'ParamDef', 'GROUP', 'Ntve') + ref('SubFunctionType', 'SubFuncType', 'ACTIONS', 'Ntve') + `<ScriptCode>${loop('#AUTOVAR(var)')}</ScriptCode>`) +
      el('FunctionDef', 'CURRENT', '<Identifier>PickedPlayer</Identifier><FlagCall/><FlagOperator/><ReturnType><Type Value="int"/></ReturnType><ScriptCode>#AUTOVAR(var,ancestor:PickEachPlayer)</ScriptCode>') +
      el('ParamDef', 'PLAYER', '<Identifier>player</Identifier><ParameterType><Type Value="int"/></ParameterType>') +
      el('FunctionDef', 'USE', '<Identifier>UsePlayer</Identifier><FlagNative/><FlagAction/>' + ref('Parameter', 'ParamDef', 'PLAYER', 'Ntve')),
      'Ntve',
    );
    const restored = normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(
      parseGalaxySource(`void libTEST_gf_Visit(playergroup lp_group) {
        playergroup auto22222222_g;
        int ${iterator};
        auto22222222_g = lp_group;
        ${iterator} = -1;
        while (true) {
          ${iterator} = PlayerGroupNextPlayer(auto22222222_g, ${iterator});
          if (${iterator} < 0) { break; }
          UsePlayer(${iterator});
        }
      }`),
      parseGalaxySource('void libTEST_gf_Visit(playergroup lp_group);'),
      {
        libraryId: 'TEST',
        nativeLibrary: native,
        galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native int PlayerGroupNextPlayer(playergroup g, int p); native void UsePlayer(int p);' }],
      },
    ));
    const loops = Object.values(restored.elements).filter((element: any) => element.type === 'FunctionCall' && ['FOREACH', 'PICK'].includes(element.functionDef?.id)) as any[];
    expect(loops.map(call => call.functionDef.id)).toEqual([expected]);
    expect(Object.values(restored.elements).some((element: any) => element.type === 'Variable' && element.name?.includes('auto22222222'))).toBe(false);
  });

  // Ice Baneling: SwarmCampaignLib ships its presets without names, so
  // `libSwaC_ge_CampaignHeroes_None` became a raw template and InitLibs lost SwaC.
  it('binds a generated preset constant of a dependency whose preset names were stripped', () => {
    const values = [0, 1].map(index => ({ type: 'PresetValue', id: `V${index}`, library: 'DEP' } as any));
    const preset = { type: 'Preset', id: 'P', library: 'DEP', integer: true, generateConstants: true,
      values: values.map(value => ({ type: 'PresetValue', library: 'DEP', id: value.id })) } as any;
    const dependency = { id: 'DEP', name: 'DEP', items: [], elements: { P: preset, V0: values[0], V1: values[1] },
      elementsByType: { Preset: { P: preset }, PresetValue: { V0: values[0], V1: values[1] } } } as unknown as TriggerLibraryJson;
    const restored = convertGalaxyToTriggerLibrary(
      parseGalaxySource('int libTEST_gf_Hero() { return libDEP_ge_Heroes_Second; }'),
      parseGalaxySource('int libTEST_gf_Hero();'),
      { libraryId: 'TEST', dependencyLibraries: new Map([['DEP', dependency]]),
        galaxyDeclarations: [{ fileName: 'DEP_h.galaxy', text: 'const int libDEP_ge_Heroes_First = 0;\nconst int libDEP_ge_Heroes_Second = 1;' }] },
    );
    const presetRefs = Object.values(restored.elements).map((element: any) => element.preset).filter(Boolean);
    expect(presetRefs).toEqual([expect.objectContaining({ library: 'DEP', id: 'V1' })]);
    // And back: the constant, not its number. The forward converter hands the libraries over as an
    // iterator, which the unit-filter pass used to spend before the preset pass (AerialEvacuation).
    const { script } = convertTriggerLibraryToGalaxyFull(normalizeTriggerLibrary(restored), undefined, new Map([['DEP', dependency]]), {
      galaxyDeclarations: [{ fileName: 'DEP_h.galaxy', text: 'const int libDEP_ge_Heroes_First = 0;\nconst int libDEP_ge_Heroes_Second = 1;' }],
    });
    expect(script).toContain('return libDEP_ge_Heroes_Second;');
  });

  // 06-MistOpportunities: an unresolved call in a Pick Each Player body became a
  // Custom Script that kept the iterator's source name, while the loop itself was
  // regenerated under a new automatic name, so the script read an undeclared local.
  it('keeps a player loop iterator declared when a Custom Script in the body reads it', () => {
    const loop = `#AUTOVAR(g, playergroup) = #PARAM(group);\n#AUTOVAR(var) = -1;\nwhile (true) {\n` +
      `#AUTOVAR(var) = PlayerGroupNextPlayer(#AUTOVAR(g), #AUTOVAR(var));\nif (#AUTOVAR(var) &lt; 0) { break; }\n#SUBFUNCS(actions)\n}`;
    const native = library(
      el('ParamDef', 'GROUP', '<Identifier>group</Identifier><ParameterType><Type Value="playergroup"/></ParameterType>') +
      el('SubFuncType', 'ACTIONS', '<Identifier>actions</Identifier><Action/>') +
      el('FunctionDef', 'PICK', '<Identifier>PickEachPlayer</Identifier><FlagAction/><FlagSubFunctions/>' +
        ref('Parameter', 'ParamDef', 'GROUP', 'Ntve') + ref('SubFunctionType', 'SubFuncType', 'ACTIONS', 'Ntve') + `<ScriptCode>${loop}</ScriptCode>`) +
      el('FunctionDef', 'CURRENT', '<Identifier>PickedPlayer</Identifier><FlagCall/><FlagOperator/><ReturnType><Type Value="int"/></ReturnType><ScriptCode>#AUTOVAR(var,ancestor:PickEachPlayer)</ScriptCode>') +
      el('FunctionDef', 'SCRIPT', '<Identifier>CustomScriptAction</Identifier><FlagAction/><FlagCustomScript/>'),
      'Ntve',
    );
    const restored = normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(
      parseGalaxySource(`void libTEST_gf_Visit(playergroup lp_group) {
        playergroup auto22222222_g;
        int auto22222222_var;
        auto22222222_g = lp_group;
        auto22222222_var = -1;
        while (true) {
          auto22222222_var = PlayerGroupNextPlayer(auto22222222_g, auto22222222_var);
          if (auto22222222_var < 0) { break; }
          libZZZZ_gf_Unknown(auto22222222_var);
        }
      }`),
      parseGalaxySource('void libTEST_gf_Visit(playergroup lp_group);'),
      { libraryId: 'TEST', nativeLibrary: native,
        galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native int PlayerGroupNextPlayer(playergroup g, int p);' }] },
    ));
    const { script } = convertTriggerLibraryToGalaxyFull(restored, native, new Map([['Ntve', native]]));
    const used = new Set(script.match(/\b(?:lv_)?auto[0-9A-F]{8}_\w+/gu) ?? []);
    const declared = new Set([...script.matchAll(/\b\w+\s+((?:lv_)?auto[0-9A-F]{8}_\w+)\s*[;=]/gu)].map(match => match[1]));
    expect([...used].filter(name => !declared.has(name))).toEqual([]);
  });

  // Editor oracle (Star Party v): #INITAUTOVAR kept Repeat from compiling as a
  // template, so 83 Repeat loops came back as For Each Integer over extra locals.
  it.each([
    ['a literal count the editor promoted to a const auto', 'const int auto33333333_n = 3;\nint auto33333333_i;', '', { value: '3' }],
    ['a computed count assigned in place', 'int auto33333333_n;\nint auto33333333_i;', 'auto33333333_n = lp_count;', { paramRef: true }],
  ])('restores Repeat with %s', (_shape, declarations, assignment, expectedCount) => {
    const native = library(
      el('ParamDef', 'COUNT', '<Identifier>count</Identifier><ParameterType><Type Value="int"/></ParameterType>') +
      el('SubFuncType', 'ACTIONS', '<Identifier>actions</Identifier><Action/>') +
      el('FunctionDef', 'REPEAT', '<Identifier>Repeat</Identifier><FlagAction/><FlagSubFunctions/>' + ref('Parameter', 'ParamDef', 'COUNT', 'Ntve') +
        ref('SubFunctionType', 'SubFuncType', 'ACTIONS', 'Ntve') +
        '<ScriptCode>#INITAUTOVAR(n,count)\nfor (#AUTOVAR(i) = 1; #AUTOVAR(i) &lt;= #AUTOVAR(n); #AUTOVAR(i) += 1) {\n#SUBFUNCS(actions)\n}</ScriptCode>') +
      el('FunctionDef', 'TICK', '<Identifier>Tick</Identifier><FlagNative/><FlagAction/>'),
      'Ntve',
    );
    const restored = normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(
      parseGalaxySource(`void libTEST_gf_Beat(int lp_count) {
        ${declarations}
        ${assignment}
        for (auto33333333_i = 1; auto33333333_i <= auto33333333_n; auto33333333_i += 1) {
          Tick();
        }
      }`),
      parseGalaxySource('void libTEST_gf_Beat(int lp_count);'),
      { libraryId: 'TEST', nativeLibrary: native, galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native void Tick();' }] },
    ));
    const calls = Object.values(restored.elements).filter((element: any) => element.type === 'FunctionCall') as any[];
    const repeat = calls.find(call => call.functionDef?.id === 'REPEAT');
    expect(repeat).toBeDefined();
    expect(calls.some(call => call.functionDef?.id === 'TICK')).toBe(true);
    const count = restored.elements[repeat.parameters[0].id] as any;
    if ('value' in expectedCount) expect(count.value).toBe(expectedCount.value);
    else expect(count.paramRef).toBeDefined();
    expect(Object.values(restored.elements).some((element: any) => element.type === 'Variable' && element.name?.includes('auto33333333'))).toBe(false);
  });

  it('materializes a native declaration when the loaded namesake is only a contextual accessor', () => {
    const native = library(
      el('FunctionDef', 'CURRENT', '<Identifier>GroupLoopCurrent</Identifier><FlagCall/><FlagOperator/><ReturnType><Type Value="int"/></ReturnType><ScriptCode><![CDATA[#AUTOVAR(var,ancestor:PickEachGroup)]]></ScriptCode>'),
      'Ntve',
    );
    const restored = normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(
      parseGalaxySource('int libTEST_gf_ReadCurrent() { return GroupLoopCurrent(); }'),
      parseGalaxySource('int libTEST_gf_ReadCurrent();'),
      {
        libraryId: 'TEST',
        nativeLibrary: native,
        galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native int GroupLoopCurrent();' }],
      },
    ));
    const definition = Object.values(restored.elements).find((element: any) =>
      element.type === 'FunctionDef' && element.name === 'GroupLoopCurrent') as any;
    expect(definition).toMatchObject({
      library: 'TEST',
      flags: expect.arrayContaining(['Native', 'NoScriptPrefix']),
      isFuncCall: true,
      returnType: { type: 'int' },
    });
    expect(definition.scriptCode).toBeUndefined();
    // No synthesized holder next to the materialized native declaration.
    expect(Object.values(restored.elements).filter((element: any) =>
      element.type === 'FunctionDef' && element.name === 'GroupLoopCurrent')).toHaveLength(1);
    expect(Object.values(restored.elements).some((element: any) =>
      element.type === 'FunctionCall' && element.functionDef?.library === 'TEST' && element.functionDef?.id === definition.id)).toBe(true);

    const generated = convertTriggerLibraryToGalaxyFull(restored, native, new Map([['Ntve', native]]));
    expect(generated.script).toContain('return GroupLoopCurrent();');
    expect(generated.script).not.toContain('lf_GroupLoopCurrent');
  });

  it('removes provisional native definitions when structural lowering consumes their calls', () => {
    const restored = normalizeTriggerLibrary(convertGalaxyToTriggerLibrary(
      parseGalaxySource('unitfilter libTEST_gf_Make() { return UnitFilter(0, 0, 0, 0); }'),
      parseGalaxySource(''),
      {
        libraryId: 'TEST',
        galaxyDeclarations: [{
          fileName: 'natives.galaxy',
          text: 'native unitfilter UnitFilter(int required, int requiredHigh, int excluded, int excludedHigh);',
        }],
      },
    ));
    expect(Object.values(restored.elements).some((element: any) =>
      element.type === 'FunctionDef' && element.name === 'UnitFilter')).toBe(false);
  });

  it('recovers int-backed variable domains only from agreeing declarations and TriggerData contracts', () => {
    const native = library(
      el('FunctionDef', '00000001', '<Identifier>ControlLast</Identifier><FlagNative/><FlagCall/><ReturnType><Type Value="control"/></ReturnType>') +
      el('PresetValue', '00000002', '<Identifier>none</Identifier><Value>c_noDialog</Value>') +
      el('Preset', '00000003', '<BaseType Value="dialog"/><PresetGenConstVar/>' + ref('Item', 'PresetValue', '00000002', 'Ntve')),
      'Ntve',
    );
    const restored = convertGalaxyToTriggerLibrary(
      parseGalaxySource('int gv_control; int gv_dialog; void initialize() { gv_control = ControlLast(); gv_dialog = c_noDialog; }'),
      parseGalaxySource(''),
      { libraryId: 'Map', implicitLibrary: true, nativeLibrary: native, galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native int ControlLast(); const int c_noDialog = 0;' }] },
    );
    const variables = Object.values(restored.elements).filter((element: any) => element.type === 'Variable') as any[];
    expect(variables.find(variable => variable.name === 'control')?.variableType).toEqual({ type: 'control' });
    expect(variables.find(variable => variable.name === 'dialog')?.variableType).toEqual({ type: 'dialog' });
  });

  // traynor2: TriggerAddEventButtonPressed(t, gv_pLAYER_01_USER, "...") passes the trigger first, so the
  // player stood against the button's gamelink formal and the constant became `const string ... = 1`.
  it('pairs the arguments of an event registration with its parameters after the trigger', () => {
    const native = library(
      el('ParamDef', '00000001', '<Identifier>player</Identifier><ParameterType><Type Value="int"/></ParameterType>') +
      el('ParamDef', '00000002', '<Identifier>button</Identifier><ParameterType><Type Value="gamelink"/><GameType Value="Button"/></ParameterType>') +
      el('FunctionDef', '00000003', '<Identifier>TriggerAddEventButtonPressed</Identifier><FlagEvent/><FlagNative/>' +
        ref('Parameter', 'ParamDef', '00000001', 'Ntve') + ref('Parameter', 'ParamDef', '00000002', 'Ntve')),
      'Ntve',
    );
    const restored = convertGalaxyToTriggerLibrary(
      parseGalaxySource(`const int gv_pLAYER_01_USER = 1;
        trigger gt_Pressed;
        bool gt_Pressed_Func(bool testConds, bool runActions) { if (!runActions) { return true; } return true; }
        void gt_Pressed_Init() { gt_Pressed = TriggerCreate("gt_Pressed_Func"); TriggerAddEventButtonPressed(gt_Pressed, gv_pLAYER_01_USER, "Stop"); }`),
      parseGalaxySource(''),
      {
        libraryId: 'Map', implicitLibrary: true, nativeLibrary: native,
        galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native trigger TriggerCreate(string name); native void TriggerAddEventButtonPressed(trigger t, int player, string button);' }],
      },
    );
    const player = Object.values(restored.elements).find((element: any) => element.type === 'Variable' && element.name === 'pLAYER_01_USER') as any;
    expect(player?.variableType).toMatchObject({ type: 'int' });
  });

  it('recovers the semantic domain of an ABI-flattened global array', () => {
    const native = library(
      el('FunctionDef', '00000001', '<Identifier>UseControl</Identifier><FlagNative/><FlagAction/>' + ref('Parameter', 'ParamDef', '00000002', 'Ntve')) +
      el('ParamDef', '00000002', '<Identifier>value</Identifier><ParameterType><Type Value="control"/></ParameterType>'),
      'Ntve',
    );
    const restored = convertGalaxyToTriggerLibrary(
      parseGalaxySource('int[2] gv_controls; void useIt() { UseControl(gv_controls[1]); }'),
      parseGalaxySource(''),
      {
        libraryId: 'Map',
        implicitLibrary: true,
        nativeLibrary: native,
        galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native void UseControl(int value);' }],
      },
    );
    const control = Object.values(restored.elements).find((element: any) => element.type === 'Variable' && element.name === 'controls') as any;
    expect(control?.variableType).toEqual({ type: 'control' });
    expect(control?.arraySizes).toEqual([{ dim: 0, value: '1' }]);
  });

  it('rejects syntax errors before constructing partial output', () => {
    expect(() => reverse('void invalid( {')).toThrow('Galaxy input contains syntax errors');
  });

  it('keeps null as a handle value and preserves hexadecimal integer literals', () => {
    const { script } = roundtrip('unit noUnit() { return null; } int mask() { return 0xdead; }');
    expect(script).toContain('return null;');
    expect(script).not.toContain('return "null";');
    expect(script).toContain('return 57005;');
  });

  it('resolves structure members and indices using their declarations', () => {
    const { script, header } = roundtrip('struct Pair { int first; }; Pair result; int readValue() { result.first = 3; return result.first; }');
    expect(header).toContain('int lv_first;');
    expect(script).toContain('.lv_first = 3;');
    expect(script).toMatch(/return result\.lv_first;/u);
  });

  it('resolves generated member names on structures declared by another library', () => {
    const dependency = library(
      el('Structure', '00000001', ref('Variable', 'Variable', '00000002', 'EXT')) +
      el('Variable', '00000002', '<Identifier>ReviverUnit</Identifier><VariableType><Type Value="unit"/></VariableType>') +
      el('Variable', '00000003', '<Identifier>HeroUnitsData</Identifier><VariableType><Type Value="struct"/>' +
        '<TypeElement Type="Structure" Library="EXT" Id="00000001"/><ArraySize Dim="0" Value="8"/></VariableType>'),
      'EXT',
    );
    const { script } = roundtrip('unit readReviver(int index) { return libEXT_gv_heroUnitsData[index].lv_reviverUnit; }', [dependency]);
    expect(script).toContain('return libEXT_gv_heroUnitsData[lp_index].lv_reviverUnit;');
  });

  it('preserves an array index on a nested structure member', () => {
    const source = 'struct Card { int lv_type; }; struct Hand { Card[4] lv_card; }; struct Player { Hand lv_hand; }; Player[8] gv_player; int readValue(int player, int index) { return gv_player[player].lv_hand.lv_card[index].lv_type; }';
    const { script } = roundtrip(source);
    expect(script).toContain('libTEST_gv_player[lp_player].lv_hand.lv_card[lp_index].lv_type');
    expect(script).not.toContain('.lv_hand[lp_index].lv_card');
  });

  it('keeps boolean negation of a nested array member structural', () => {
    const source = 'struct Collection { bool[4] lv_transformed; }; Collection[8] gv_collection; void toggle(int player, int index) { gv_collection[player].lv_transformed[index] = !(gv_collection[player].lv_transformed[index]); }';
    const { script } = roundtrip(source);
    expect(script).toContain('libTEST_gv_collection[lp_player].lv_transformed[lp_index] = (!libTEST_gv_collection[lp_player].lv_transformed[lp_index]);');
    expect(script).not.toContain('lf_ElementAccessExpression');
  });

  it('preserves PresetAsBits and every ValuePreset through XML serialization', () => {
    const source = library(
      el('PresetValue', '00000001', '<Value>c_first</Value>') +
      el('PresetValue', '00000002', '<Value>c_second</Value>') +
      el('Preset', '00000003', '<PresetAsBits/><BaseType Value="int"/>' + ref('Item', 'PresetValue', '00000001') + ref('Item', 'PresetValue', '00000002')) +
      el('Param', '00000004', '<ValueType Type="preset"/>' + ref('ValueElement', 'Preset', '00000003') + ref('ValuePreset', 'PresetValue', '00000001') + ref('ValuePreset', 'PresetValue', '00000002')),
    );
    const serialized = serializeTriggerLibrary(source);
    expect(serialized).toContain('<PresetAsBits/>');
    expect(serialized.match(/<ValuePreset /gu)).toHaveLength(2);
    const reparsed: any = parseTriggerXmlSync(serialized).get('TEST')!;
    expect(reparsed.elements['Preset:00000003'].asBits).toBe(true);
    expect(reparsed.elements['Param:00000004'].valuePresets).toEqual([
      { type: 'PresetValue', library: 'TEST', id: '00000001' },
      { type: 'PresetValue', library: 'TEST', id: '00000002' },
    ]);
  });

  it('recovers explicit section banners and retains comments as editor labels', () => {
    const source = '// ----------------\n// Combat\n// ----------------\nvoid fight() {\n// execute attack\nreturn;\n}\n';
    const { reparsed, script } = roundtrip(source);
    const category = Object.values(reparsed.elements).find(e => e.type === 'Category' && e.name === 'Combat');
    expect(category).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ type: 'FunctionDef' })]) });
    expect(Object.values(reparsed.elements).some(e => e.type === 'Label' && e.name === 'execute attack')).toBe(true);
    expect(script).toContain('// @modkit-editor-layout ');
    const again = reverse(script);
    expect(Object.values(again.elements).filter(e => e.type === 'Category')).toHaveLength(1);
    expect(Object.values(again.elements).filter(e => e.type === 'Label')).toHaveLength(1);
  });

  it('preserves nested folder names and membership using non-executable metadata', () => {
    const source = library('<Root>' + ref('Item', 'Category', '00000001') + '</Root>' +
      el('Category', '00000001', '<Identifier>Outer</Identifier>' + ref('Item', 'Category', '00000002')) +
      el('Category', '00000002', '<Identifier>Inner</Identifier>' + ref('Item', 'FunctionDef', '00000003')) +
      el('FunctionDef', '00000003', '<Identifier>Work</Identifier><FlagAction/>'));
    const forward = convertTriggerLibraryToGalaxyFull(source);
    const restored = reverse(forward.script);
    const outer: any = Object.values(restored.elements).find(e => e.type === 'Category' && e.name === 'Outer');
    const inner: any = Object.values(restored.elements).find(e => e.type === 'Category' && e.name === 'Inner');
    expect(outer.items).toContainEqual({ type: 'Category', library: 'TEST', id: inner.id });
    expect(inner.items).toContainEqual(expect.objectContaining({ type: 'FunctionDef' }));
  });

  it('discovers operator syntax from loaded preset values without operator-slot name assumptions', () => {
    const dependency = library(el('PresetValue', '00000001', '<Value>+</Value>') + el('PresetValue', '00000002', '<Value>*</Value>') +
      el('Preset', '00000003', '<BaseType Value="int"/>' + ref('Item', 'PresetValue', '00000001', 'EXT') + ref('Item', 'PresetValue', '00000002', 'EXT')) +
      el('ParamDef', '00000004', '<Identifier>first</Identifier><ParameterType><Type Value="int"/></ParameterType>') +
      el('ParamDef', '00000005', '<Identifier>chosenToken</Identifier><ParameterType><Type Value="preset"/>' + ref('TypeElement', 'Preset', '00000003', 'EXT') + '</ParameterType>') +
      el('ParamDef', '00000006', '<Identifier>last</Identifier><ParameterType><Type Value="int"/></ParameterType>') +
      el('FunctionDef', '00000007', '<Identifier>AnyOperator</Identifier><FlagCall/><Template/><ReturnType><Type Value="int"/></ReturnType>' +
        ref('Parameter', 'ParamDef', '00000004', 'EXT') + ref('Parameter', 'ParamDef', '00000005', 'EXT') + ref('Parameter', 'ParamDef', '00000006', 'EXT') +
        '<ScriptCode>(#PARAM(first) #PARAM(chosenToken) #PARAM(last))</ScriptCode>'), 'EXT');
    const { restored, script } = roundtrip('int arithmetic(int x) { return (x + 2) * 3; }', [dependency]);
    expect(Object.values(restored.elements).filter((e: any) => e.type === 'FunctionCall' && e.functionDef?.library === 'EXT')).toHaveLength(2);
    expect(script).toContain('lp_x + 2');
  });
});

describe('conversion integrity', () => {
  it('resolves identical IDs by library and element type', () => {
    const a = library(el('Param', '00000001', '<Value>7</Value>') + el('Variable', '00000001', '<Identifier>value</Identifier>'), 'A');
    const b = library(el('Param', '00000001', '<Value>9</Value>'), 'B');
    expect(lookupElement([a, b], { library: 'A', type: 'Param', id: '00000001' }, 'A')).toMatchObject({ value: '7' });
    expect(lookupElement([a, b], { library: 'B', type: 'Param', id: '00000001' }, 'A')).toMatchObject({ value: '9' });
    expect(lookupElement([a, b], { library: 'A', id: '00000001' }, 'A')).toBeUndefined();
    expect(lookupElement([a], { library: 'missing', type: 'Param', id: '00000001' }, 'A')).toBeUndefined();
    expect(validateLibraryStructure([a, b], { skipOrphanCheck: true }).filter(finding => finding.code === 'E_DUP_ID')).toEqual([]);
  });

  it('uses qualified expression-cache keys across libraries', async () => {
    const native = xml(el('ParamDef', '00000011', '<Identifier>a</Identifier><ParameterType><Type Value="int"/></ParameterType>') + el('ParamDef', '00000012', '<Identifier>b</Identifier><ParameterType><Type Value="int"/></ParameterType>') + el('FunctionDef', '00000013', '<Identifier>Pair</Identifier><FlagAction/><FlagNative/>' + ref('Parameter', 'ParamDef', '00000011', 'Ntve') + ref('Parameter', 'ParamDef', '00000012', 'Ntve')), 'Ntve');
    const params = ['A', 'B'].map((id, i) => xml(el('Param', '00000010', ref('ParameterDef', 'ParamDef', i ? '00000012' : '00000011', 'Ntve') + `<ValueType Type="int"/><Value>${i ? 9 : 7}</Value>`), id));
    const source = xml(el('FunctionCall', '00000001', ref('FunctionDef', 'FunctionDef', '00000013', 'Ntve') + ref('Parameter', 'Param', '00000010', 'A') + ref('Parameter', 'Param', '00000010', 'B')) + el('Trigger', '00000002', ref('Action', 'FunctionCall', '00000001')));
    const result = await convertTriggersToGalaxy(source, { dependencyLibraries: [native, ...params].map(triggerData => ({ triggerData })) });
    expect(result.output.script).toContain('Pair(7, 9)');
  });

  it('rejects missing actions and expansion cycles with a bounded diagnostic', () => {
    const missing = library(el('Trigger', '00000001', ref('Action', 'FunctionCall', '00000002')));
    expect(() => convertTriggerLibraryToGalaxyFull(missing)).toThrow('cannot be resolved');
    const cyclic = library(el('Param', '00000001', ref('FunctionCall', 'FunctionCall', '00000002')) + el('FunctionCall', '00000002', ref('Parameter', 'Param', '00000001')));
    expect(() => assertConversionReferences(cyclic)).toThrow('Cyclic Trigger');
  });

  it('requires external targets without recursively validating dependency internals', () => {
    const dependency = library(
      el('FunctionDef', '00000001', '<Identifier>Target</Identifier><FlagAction/>') +
      el('FunctionCall', '00000002', ref('FunctionDef', 'FunctionDef', '0000OLD0', 'TEST')),
      'EXT',
    );
    const current = library(
      el('FunctionCall', '00000003', ref('FunctionDef', 'FunctionDef', '00000001', 'EXT')),
      'TEST',
    );
    expect(() => assertConversionReferences(current, new Map([['EXT', dependency]]))).not.toThrow();

    const missing = library(el('FunctionCall', '00000003', ref('FunctionDef', 'FunctionDef', '0000DEAD', 'EXT')), 'TEST');
    expect(() => assertConversionReferences(missing, new Map([['EXT', dependency]]))).toThrow('cannot be resolved');
  });

  it('ignores a stale type element the declared type never reads, and keeps the one it does', () => {
    // The editor leaves a TypeElement behind when its target is deleted; the
    // declared type already carries everything the conversion needs.
    const inert = library(el('Variable', '00000001', '<Identifier>Commander</Identifier><VariableType><Type Value="userinstance"/>' +
      ref('TypeElement', 'ParamDef', '0000DEAD') + '<UserType Value="PlayerCommanders"/></VariableType>'));
    expect(() => assertConversionReferences(inert)).not.toThrow();
    const structural = library(el('Variable', '00000001', '<Identifier>Data</Identifier><VariableType><Type Value="struct"/>' +
      ref('TypeElement', 'Structure', '0000DEAD') + '</VariableType>'));
    expect(() => assertConversionReferences(structural)).toThrow('cannot be resolved');
  });

  it('ignores stale references owned only by disabled editor elements', () => {
    const disabled = library(el('FunctionDef', '00000001', '<Disabled/><FlagAction/>' +
      '<Parameter Type="ParamDef" Id="00000002"/>') +
      el('ParamDef', '00000002', '<ParameterType><Type Value="preset"/>' +
        '<TypeElement Type="Preset" Library="OLD" Id="0000DEAD"/></ParameterType>'));
    expect(() => assertConversionReferences(disabled)).not.toThrow();

    const enabled = library(el('FunctionDef', '00000001', '<FlagAction/>' +
      '<Parameter Type="ParamDef" Id="00000002"/>') +
      el('ParamDef', '00000002', '<ParameterType><Type Value="preset"/>' +
        '<TypeElement Type="Preset" Library="OLD" Id="0000DEAD"/></ParameterType>'));
    expect(() => assertConversionReferences(enabled)).toThrow('cannot be resolved');
  });

  it('disables nested actions and keeps local initial values', () => {
    const source = library(el('FunctionDef', '00000001', '<Identifier>AnyName</Identifier><Template/><FlagAction/><FlagSubFunctions/>' + ref('SubFunctionType', 'SubFuncType', '00000003') + '<ScriptCode>#SUBFUNCS(body)</ScriptCode>') +
      el('SubFuncType', '00000003', '<Identifier>body</Identifier><Action/>') +
      el('FunctionDef', '00000002', '<Identifier>Marker</Identifier><FlagAction/><FlagNative/>') +
      el('FunctionCall', '00000004', '<Disabled/>' + ref('FunctionDef', 'FunctionDef', '00000002')) +
      el('FunctionCall', '00000005', ref('FunctionDef', 'FunctionDef', '00000001') + ref('FunctionCall', 'FunctionCall', '00000004')) +
      el('Param', '00000006', '<ValueType Type="int"/><Value>7</Value>') +
      el('Variable', '00000007', '<Identifier>value</Identifier><VariableType><Type Value="int"/></VariableType>' + ref('InitialValue', 'Param', '00000006')) +
      el('Trigger', '00000008', ref('Variable', 'Variable', '00000007') + ref('Action', 'FunctionCall', '00000005')));
    const { script } = convertTriggerLibraryToGalaxyFull(source);
    expect(script).not.toContain('Marker(');
    expect(script).toContain('lv_value = 7;');
  });

  it('uses the same collision-free function names in declarations and definitions', () => {
    const source = library(el('FunctionDef', '00000001', '<Identifier>A B</Identifier><FlagAction/><ScriptCode>return;</ScriptCode>') + el('FunctionDef', '00000002', '<Identifier>AB</Identifier><FlagAction/><ScriptCode>return;</ScriptCode>'));
    const { script, header } = convertTriggerLibraryToGalaxyFull(source);
    for (const id of ['00000001', '00000002']) {
      expect(script).toContain(`libTEST_gf_AB_${id} ()`);
      expect(header).toContain(`libTEST_gf_AB_${id} ()`);
    }
  });

  it('encodes Unicode legacy metadata without the Node Buffer global', () => {
    const previous = globalThis.Buffer;
    try {
      (globalThis as any).Buffer = undefined;
      expect(decodePayload(encodePayload('триггер 🌌'))).toBe('триггер 🌌');
    } finally { globalThis.Buffer = previous; }
  });

  it('keeps macro-like text inside strings and comments in raw user functions', () => {
    const source = library(el('FunctionDef', '00000001', '<Identifier>Raw</Identifier><FlagCall/><ReturnType><Type Value="string"/></ReturnType><ScriptCode><![CDATA[// #PARAM(value) is text\nreturn "#SUBFUNCS(body)";]]></ScriptCode>'));
    const { script } = convertTriggerLibraryToGalaxyFull(source);
    expect(script).toContain('// #PARAM(value) is text');
    expect(script).toContain('return "#SUBFUNCS(body)";');
  });

  it('resolves child auto-variable references in the enclosing template scope', () => {
    const source = library(el('SubFuncType', '00000001', '<Identifier>body</Identifier><Action/>') +
      el('FunctionDef', '00000002', '<Identifier>OuterMacro</Identifier><FlagAction/><Template/><FlagSubFunctions/>' + ref('SubFunctionType', 'SubFuncType', '00000001') + '<ScriptCode>#AUTOVAR(cursor,int) = 4; #SUBFUNCS(body)</ScriptCode>') +
      el('FunctionDef', '00000003', '<Identifier>ReturnCursor</Identifier><FlagAction/><Template/><ScriptCode>return #AUTOVAR(cursor);</ScriptCode>') +
      el('FunctionCall', '00000004', ref('FunctionDef', 'FunctionDef', '00000003')) +
      el('FunctionCall', '00000005', ref('FunctionDef', 'FunctionDef', '00000002') + ref('FunctionCall', 'FunctionCall', '00000004')) +
      el('FunctionDef', '00000006', '<Identifier>GetCursor</Identifier><FlagCall/><ReturnType><Type Value="int"/></ReturnType>' + ref('Action', 'FunctionCall', '00000005')));
    const { script } = convertTriggerLibraryToGalaxyFull(source);
    expect(script).toContain('int auto00000005_cursor;');
    expect(script).toContain('return auto00000005_cursor;');
    expect(script).not.toContain('auto00000004_cursor');
  });
});
