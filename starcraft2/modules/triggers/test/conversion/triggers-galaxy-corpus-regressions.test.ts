import { describe, expect, it } from 'vitest';
import { validateGalaxyPair } from '../../../../dist/modules/triggers/services/galaxy-conversion/validation.js';
import { convertGalaxyToTriggers, convertTriggersToGalaxy } from '../../../../dist/modules/triggers/services/galaxy-conversion/index.js';
import { serializeTriggerLibrary, serializeTriggerStrings } from '../../../../dist/modules/triggers/shared/trigger-document/trigger-xml.js';
import { parseTriggerXmlSync } from '../../../../dist/modules/triggers/shared/trigger-document/sax-reader.js';
import { convertGalaxyToTriggerLibrary, parseGalaxySource } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.js';
import { convertTriggerLibraryToGalaxyFull } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/trigger-to-galaxy.js';
import { buildFuncNameToFuncDefMap } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/g2t-core.js';
import type { ElementRefJson, TriggerLibraryJson } from '../../../../dist/modules/triggers/shared/trigger-document/types.js';
import { convertWhileDo, convertWaitForCondition } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/ttg-actions.js';
import { convertComparison } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/ttg-convert.js';
import { printNode } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/script-template.js';
import { compileTemplate } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/script-template.js';
import { parseTriggerStrings, applyTriggerStringsByType } from '../../../../dist/modules/triggers/shared/trigger-document/trigger-strings.js';
import { validateLibraryStructure } from '../../../../dist/modules/triggers/shared/trigger-document/structure-validate.js';
import { GalaxyConstantIndex } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-constants.js';
import { parseArraySizeExpr } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/g2t-core.js';
import { convertParamExpr } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/ttg-params.js';
import { toGalaxyFunctionName } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/ttg-core.js';
import { dependencyFunctionNames, dependencyVariableNames } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/dependency-functions.js';

function model() {
  let id = 0;
  const library: any = { id: 'TEST', items: [], elements: {}, elementsByType: {} };
  const add = (type: string, values: object = {}): ElementRefJson => {
    const key = (++id).toString(16).padStart(8, '0').toUpperCase();
    library.elements[key] = { type, id: key, library: library.id, ...values };
    return { type, id: key, library: library.id };
  };
  const get = (ref: ElementRefJson): any => library.elements[ref.id];
  const role = (name: string, isAction = true) => add('SubFuncType', { name, isAction });
  const formal = (name: string, type: string) => add('ParamDef', { name, paramType: { type } });
  const template = (name: string, scriptCode: string, parameters: ElementRefJson[] = [], roles: ElementRefJson[] = [], result = 'void') => add('FunctionDef', {
    name, scriptCode, parameters, subFunctionTypes: roles, returnType: { type: result }, flags: ['Template', result === 'void' ? 'Action' : 'Call'],
  });
  const call = (definition: ElementRefJson, args: Record<string, string> = {}, children: ElementRefJson[] = [], subFunctionType?: ElementRefJson) => add('FunctionCall', {
    functionDef: definition, parameters: get(definition).parameters.map((ref: ElementRefJson) => add('Param', {
      parameterDef: ref, value: args[get(ref).name], valueType: get(ref).paramType,
    })), subFunctions: children, subFunctionType,
  });
  const run = (...actions: ElementRefJson[]) => {
    library.items.push(add('FunctionDef', { name: 'Run', parameters: [], returnType: { type: 'void' }, flags: ['Action', 'NoScriptPrefix'], actions }));
  };
  const xml = () => serializeTriggerLibrary(library);
  const emit = () => {
    let output;
    try { output = convertTriggerLibraryToGalaxyFull(parseTriggerXmlSync(xml()).get('TEST')!); }
    catch (error: any) { throw new Error(JSON.stringify(error.context), { cause: error }); }
    expect(parseGalaxySource(output.script).parseDiagnostics).toEqual([]);
    expect(parseGalaxySource(output.header).parseDiagnostics).toEqual([]);
    return output;
  };
  return { library, add, get, role, formal, template, call, run, xml, emit };
}

describe('regressions found in authored SC2 trigger libraries', () => {
  it('spells a parameter the same way in the signature and in the body', () => {
    const m = model();
    const formal = m.formal('UnitAmount', 'int');
    const note = m.template('Note', 'Note(#PARAM(value));', [m.formal('value', 'int')]);
    const argument = m.add('Param', { parameterDef: m.get(note).parameters[0], paramRef: formal });
    const call = m.add('FunctionCall', { functionDef: note, parameters: [argument] });
    const fn = m.add('FunctionDef', { name: 'SpawnWave', parameters: [formal], returnType: { type: 'void' }, flags: ['Action'], actions: [call] });
    m.library.items.push(fn);
    const script = m.emit().script;
    expect(script).toMatch(/void libTEST_gf_SpawnWave \(int lp_unitAmount\)/);
    expect(script).toContain('Note(lp_unitAmount)');
    expect(script).not.toContain('lp_UnitAmount');
  });

  it('keeps Initially Off through XML and pairs it with the enable call', () => {
    const m = model();
    const trigger = m.add('Trigger', { name: 'Watcher', initOff: true, events: [], conditions: [], actions: [], localVariables: [] });
    m.library.items.push(trigger);
    expect(m.xml()).toContain('<InitOff/>');
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    expect((parsed.elements[`Trigger:${trigger.id}`] as any).initOff).toBe(true);
    const script = m.emit().script;
    expect(script).toMatch(/libTEST_gt_Watcher = TriggerCreate\("libTEST_gt_Watcher_Func"\);\s*\n\s*TriggerEnable\(libTEST_gt_Watcher, false\);/);
  });

  it('leaves a trigger without Initially Off enabled', () => {
    const m = model();
    const trigger = m.add('Trigger', { name: 'Watcher', events: [], conditions: [], actions: [], localVariables: [] });
    m.library.items.push(trigger);
    expect(m.xml()).not.toContain('<InitOff/>');
    expect(m.emit().script).not.toContain('TriggerEnable');
  });

  it('does not materialize a local-variable-section comment as an int variable', () => {
    const m = model();
    const comment = m.add('Comment', { comment: 'between locals' });
    const fn = m.add('FunctionDef', {
      name: 'WithLocalComment', flags: ['Action'], parameters: [], actions: [], localVariables: [comment],
    });
    m.library.items.push(fn);
    const xml = m.xml();
    expect(xml).toContain(`<Variable Type="Comment" Library="TEST" Id="${comment.id}"/>`);
    const output = m.emit();
    expect(output.script).toContain('void libTEST_gf_WithLocalComment ()');
    expect(output.script).not.toContain(`lv_${comment.id}`);
  });

  it('does not materialize a comment between structure fields as an int field', () => {
    const m = model();
    const before = m.add('Variable', { name: 'before', variableType: { type: 'int' } });
    const comment = m.add('Comment', { comment: 'between fields' });
    const after = m.add('Variable', { name: 'after', variableType: { type: 'bool' } });
    const structure = m.add('Structure', { name: 'Data', variables: [before, comment, after] });
    m.library.items.push(structure);
    const output = m.emit();
    expect(output.header).toMatch(/struct libTEST_gs_Data\s*\{[^}]*int lv_before;[^}]*bool lv_after;/s);
    expect(output.header).not.toContain(`lv_${comment.id}`);
  });

  it('keeps Custom AI function identifiers outside the NativeLib wrapper namespace', () => {
    const native: any = { id: 'Ntve', items: [], elements: {}, elementsByType: {} };
    const definition: any = { type: 'FunctionDef', id: '00000001', library: 'Ntve', name: 'cai_runall', flags: ['Action', 'CustomAI'], parameters: [] };
    native.elements[definition.id] = definition;
    native.elementsByType.FunctionDef = { [definition.id]: definition };
    expect(toGalaxyFunctionName(definition, {
      library: native, nativeLibrary: native, allLibraries: new Map([['Ntve', native]]), libId: 'Ntve',
      localVarIds: new Set(), subFuncTypeNames: new Map(), autoVarDeclarations: [],
    } as any)).toBe('cai_runall');
  });

  it('matches an unnamed dependency function to its header across inline template definitions', () => {
    const m = model();
    const before = m.add('FunctionDef', { name: 'Before', flags: ['Action'], parameters: [], returnType: { type: 'void' }, actions: [] });
    const inline = m.add('FunctionDef', { name: 'InlineOnly', flags: ['Template', 'Call'], parameters: [], returnType: { type: 'int' }, scriptCode: '1' });
    const unnamed = m.add('FunctionDef', { flags: ['Call'], parameters: [], returnType: { type: 'int' }, actions: [] });
    const after = m.add('FunctionDef', { name: 'After', flags: ['Action'], parameters: [], returnType: { type: 'void' }, actions: [] });
    m.library.items.push(before, inline, unnamed, after);
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const names = dependencyFunctionNames([{ text: [
      'void libTEST_gf_Before();',
      'int libTEST_gf_ResolvedUnnamed();',
      'void libTEST_gf_After();',
      'void libTEST_gf_NewerOnly();',
    ].join('\n') }], [parsed]);
    expect([...names.values()]).toContain('libTEST_gf_ResolvedUnnamed');
  });

  it('matches an unnamed dependency global to its fully anchored header sequence', () => {
    const m = model();
    const named = m.add('Variable', { name: 'Known', variableType: { type: 'int' } });
    const unnamed = m.add('Variable', { variableType: { type: 'bool' }, flags: ['Internal'] });
    m.library.items.push(named, unnamed);
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const names = dependencyVariableNames([{ text: [
      'int libTEST_gv_known;',
      'bool libTEST_gv_resolvedInternal;',
    ].join('\n') }], [parsed]);
    expect([...names.values()]).toContain('libTEST_gv_resolvedInternal');
  });

  it('matches reordered unnamed dependency globals by unique function-use fingerprints', () => {
    const m = model();
    const first = m.add('Variable', { variableType: { type: 'int' }, flags: ['Internal'] });
    const second = m.add('Variable', { variableType: { type: 'bool' }, flags: ['Internal'] });
    const firstArg = m.add('Param', { variable: first });
    const secondArg = m.add('Param', { variable: second });
    const sink = { type: 'FunctionDef', library: 'Ntve', id: '00000001' };
    const firstCall = m.add('FunctionCall', { functionDef: sink, parameters: [firstArg] });
    const secondCall = m.add('FunctionCall', { functionDef: sink, parameters: [secondArg] });
    const useFirst = m.add('FunctionDef', { name: 'UseFirst', flags: ['Action'], parameters: [], actions: [firstCall] });
    const useSecond = m.add('FunctionDef', { name: 'UseSecond', flags: ['Action'], parameters: [], actions: [secondCall] });
    m.library.items.push(first, second, useFirst, useSecond);
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const names = dependencyVariableNames([
      { text: 'bool libTEST_gv_second;\nint libTEST_gv_first;\nvoid libTEST_gf_UseFirst();\nvoid libTEST_gf_UseSecond();\nvoid libTEST_gf_NewerOnly();' },
      { text: 'void libTEST_gf_UseFirst() { Sink(libTEST_gv_first); }\nvoid libTEST_gf_UseSecond() { Sink(libTEST_gv_second); }\nvoid libTEST_gf_NewerOnly() {}' },
    ], [parsed]);
    expect([...names.values()]).toEqual(expect.arrayContaining(['libTEST_gv_first', 'libTEST_gv_second']));
  });

  it('does not rebind named dependency globals from conflicting use fingerprints', () => {
    const m = model();
    const room = m.add('Variable', { identifier: 'pS_RoomBeforeArchives', variableType: { type: 'int' } });
    const position = m.add('Variable', { identifier: 'pS_ConversationCutscenePosition', variableType: { type: 'point' } });
    const sink = { type: 'FunctionDef', library: 'Ntve', id: '00000001' };
    const roomUse = m.add('FunctionCall', { functionDef: sink, parameters: [m.add('Param', { variable: room })] });
    const positionUse = m.add('FunctionCall', { functionDef: sink, parameters: [m.add('Param', { variable: position })] });
    m.library.items.push(
      room, position,
      m.add('FunctionDef', { name: 'UseRoom', flags: ['Action'], parameters: [], actions: [roomUse] }),
      m.add('FunctionDef', { name: 'UsePosition', flags: ['Action'], parameters: [], actions: [positionUse] }),
    );
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const names = dependencyVariableNames([
      { text: 'int libTEST_gv_pS_RoomBeforeArchives;\npoint libTEST_gv_pS_ConversationCutscenePosition;\nint libTEST_gv_newerOnly;' },
      { text: [
        'void libTEST_gf_UseRoom() { Sink(libTEST_gv_pS_ConversationCutscenePosition); }',
        'void libTEST_gf_UsePosition() { Sink(libTEST_gv_pS_RoomBeforeArchives); }',
      ].join('\n') },
    ], [parsed]);
    const byId = new Map([...names].map(([key, name]) => [JSON.parse(key)[2], name]));
    expect(byId.get(room.id)).not.toBe('libTEST_gv_pS_ConversationCutscenePosition');
    expect(byId.get(position.id)).not.toBe('libTEST_gv_pS_RoomBeforeArchives');
  });

  it('matches an unnamed dependency global when generated code inlines its getter', () => {
    const m = model();
    const hidden = m.add('Variable', { variableType: { type: 'int' }, flags: ['Internal'] });
    const sink = { type: 'FunctionDef', library: 'Ntve', id: '00000001' };
    const useHidden = () => {
      const argument = m.add('Param', { variable: hidden });
      return m.add('FunctionCall', { functionDef: sink, parameters: [argument] });
    };
    const getter = m.add('FunctionDef', { name: 'GetHidden', flags: ['Call'], parameters: [], returnType: { type: 'int' }, actions: [useHidden()] });
    const initialize = m.add('FunctionDef', { name: 'Initialize', flags: ['Action'], parameters: [], returnType: { type: 'void' }, actions: [useHidden()] });
    const getterCall = m.add('FunctionCall', { functionDef: getter, parameters: [] });
    const caller = m.add('FunctionDef', { name: 'Caller', flags: ['Action'], parameters: [], returnType: { type: 'void' }, actions: [getterCall] });
    m.library.items.push(hidden, getter, initialize, caller);
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const names = dependencyVariableNames([
      { text: 'int libTEST_gv_hidden;\nint libTEST_gf_GetHidden();\nvoid libTEST_gf_Initialize();\nvoid libTEST_gf_Caller();' },
      { text: [
        'int libTEST_gf_GetHidden() { Sink(libTEST_gv_hidden); return 0; }',
        'void libTEST_gf_Initialize() { Sink(libTEST_gv_hidden); }',
        'void libTEST_gf_Caller() { Sink(libTEST_gv_hidden); }',
      ].join('\n') },
    ], [parsed]);
    expect([...names.values()]).toContain('libTEST_gv_hidden');
  });

  it('preserves ParamFlagPreload and omits its compile-time directive from runtime Galaxy', () => {
    const m = model();
    const resource = m.add('ParamDef', { name: 'Resource', paramType: { type: 'string' }, isPreload: true });
    const preload = m.add('FunctionDef', {
      name: 'PreloadResource', flags: ['Action', 'SubFunctions'], parameters: [resource],
      subFunctionTypes: [], returnType: { type: 'void' }, actions: [],
    });
    const argument = m.add('Param', { parameterDef: resource, value: 'Archive', valueType: { type: 'string' } });
    const call = m.add('FunctionCall', { functionDef: preload, parameters: [argument], subFunctions: [] });
    m.run(call);
    const xml = m.xml();
    expect(xml).toContain('<ParamFlagPreload/>');
    expect(parseTriggerXmlSync(xml).get('TEST')!.elementsByType.ParamDef[resource.id].isPreload).toBe(true);
    expect(m.emit().script.match(/PreloadResource ?\(/g)).toHaveLength(1);
  });

  it('initializes triggers in editor root/category order rather than flat XML order', () => {
    const m = model();
    const later = m.add('Trigger', { name: 'LaterInTree', events: [], conditions: [], actions: [], localVariables: [] });
    const first = m.add('Trigger', { name: 'FirstInTree', events: [], conditions: [], actions: [], localVariables: [] });
    const folder = m.add('Category', { name: 'Folder', items: [first, later] });
    m.library.items.push(folder);
    const body = /void libTEST_InitTriggers\s*\(\)\s*\{(?<body>[\s\S]*?)\}/u.exec(m.emit().script)?.groups?.body ?? '';
    expect(body.indexOf('libTEST_gt_FirstInTree_Init()')).toBeLessThan(body.indexOf('libTEST_gt_LaterInTree_Init()'));
  });

  it('initializes globals in editor root/category order rather than flat XML order', () => {
    const m = model();
    const firstValue = m.add('Param', { scriptCode: '1', valueType: { type: 'int' } });
    const first = m.add('Variable', { name: 'first', variableType: { type: 'int' }, initialValue: firstValue });
    const secondValue = m.add('Param', { scriptCode: '2', valueType: { type: 'int' } });
    const second = m.add('Variable', { name: 'second', variableType: { type: 'int' }, initialValue: secondValue });
    m.library.items.push(second, first);
    const script = m.emit().script;
    const secondIndex = script.indexOf('libTEST_gv_second = 2');
    const firstIndex = script.indexOf('libTEST_gv_first = 1');
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeLessThan(firstIndex);
  });

  it('lower-cases the first character of a parameter name and keeps the function case', () => {
    const m = model();
    const formal = m.formal('UnitAmount', 'int');
    const fn = m.add('FunctionDef', { name: 'SpawnWave', parameters: [formal], returnType: { type: 'void' }, flags: ['Action'], actions: [] });
    m.library.items.push(fn);
    const script = m.emit().script;
    expect(script).toMatch(/void libTEST_gf_SpawnWave \(int lp_unitAmount\)/);
  });

  it('emits a threaded definition as its trigger handle, wrapper and trigger function', () => {
    const m = model();
    const value = m.formal('battleNr', 'int');
    const action = m.template('Note', 'Note(#PARAM(text));', [m.formal('text', 'string')]);
    const threaded = m.add('FunctionDef', { name: 'UpdateThreaded', parameters: [value], returnType: { type: 'void' },
      flags: ['Action', 'CreateThread'], actions: [m.call(action, { text: 'x' })] });
    m.library.items.push(threaded);
    const script = m.emit().script;
    expect(script).toContain('trigger auto_libTEST_gf_UpdateThreaded_Trigger = null;');
    expect(script).toContain('int auto_libTEST_gf_UpdateThreaded_lp_battleNr;');
    expect(script).toMatch(/void libTEST_gf_UpdateThreaded \(int lp_battleNr\)/);
    expect(script).toContain('auto_libTEST_gf_UpdateThreaded_lp_battleNr = lp_battleNr;');
    expect(script).toContain('TriggerCreate("auto_libTEST_gf_UpdateThreaded_TriggerFunc")');
    expect(script).toContain('TriggerExecute(auto_libTEST_gf_UpdateThreaded_Trigger, false, false)');
    expect(script).toMatch(/bool auto_libTEST_gf_UpdateThreaded_TriggerFunc \(bool testConds, bool runActions\)/);
    expect(script).toContain('int lp_battleNr = auto_libTEST_gf_UpdateThreaded_lp_battleNr;');
    // The header declares only the wrapper, as editor output does.
    expect(m.emit().header).toContain('void libTEST_gf_UpdateThreaded (int lp_battleNr);');
    expect(m.emit().header).not.toContain('TriggerFunc');
  });

  it('returns true when a skip-remaining action exits a threaded trigger callback', () => {
    const m = model();
    const skip = m.template('SkipRemaining', 'return;', []);
    const threaded = m.add('FunctionDef', { name: 'ThreadWithEarlyExit', parameters: [], returnType: { type: 'void' },
      flags: ['Action', 'CreateThread'], actions: [m.call(skip, {})] });
    m.library.items.push(threaded);
    const script = m.emit().script;
    const body = /bool auto_libTEST_gf_ThreadWithEarlyExit_TriggerFunc[^\{]*\{([\s\S]*?)\n\}/u.exec(script)?.[1];
    expect(body?.match(/return true;/gu)).toHaveLength(1);
    expect(script).not.toMatch(/bool auto_libTEST_gf_ThreadWithEarlyExit_TriggerFunc[\s\S]*return\s*;/);
  });

  it('rewrites bare returns in commented raw templates only for a threaded bool callback', () => {
    const m = model();
    const skip = m.template('CommentedSkip', '// return; in a comment\nreturn;', []);
    const threaded = m.add('FunctionDef', { name: 'ThreadWithRawExit', parameters: [], returnType: { type: 'void' },
      flags: ['Action', 'CreateThread'], actions: [m.call(skip, {})] });
    m.library.items.push(threaded);
    const script = m.emit().script;
    expect(script).toContain('// return; in a comment');
    expect(script).toMatch(/bool auto_libTEST_gf_ThreadWithRawExit_TriggerFunc[\s\S]*\/\/ return; in a comment[\s\S]*return true;/);
  });

  it('leaves a value-returning definition alone even when it is flagged threaded', () => {
    const m = model();
    const returning = m.add('FunctionDef', { name: 'SideIndex', parameters: [], returnType: { type: 'int' },
      flags: ['Call', 'CreateThread'], actions: [] });
    m.library.items.push(returning);
    const script = m.emit().script;
    expect(script).toMatch(/int libTEST_gf_SideIndex \(\)/);
    expect(script).not.toContain('TriggerCreate');
  });

  it('keeps the threaded flag through the XML round trip', () => {
    const m = model();
    const threaded = m.add('FunctionDef', { name: 'UpdateThreaded', parameters: [], returnType: { type: 'void' },
      flags: ['Action', 'CreateThread'], actions: [] });
    m.library.items.push(threaded);
    expect(m.xml()).toContain('<FlagCreateThread/>');
    expect(parseTriggerXmlSync(m.xml()).get('TEST')!.elements[`FunctionDef:${threaded.id}`].flags).toContain('CreateThread');
  });

  it('folds the editor threaded-function expansion back into FlagCreateThread', () => {
    const script = `
      trigger auto_libArbitrary_gf_Fade_Trigger = null;
      int auto_libArbitrary_gf_Fade_lp_dialog;
      void libArbitrary_gf_Fade(int lp_dialog) {
        auto_libArbitrary_gf_Fade_lp_dialog = lp_dialog;
        if (auto_libArbitrary_gf_Fade_Trigger == null) {
          auto_libArbitrary_gf_Fade_Trigger = TriggerCreate("auto_libArbitrary_gf_Fade_TriggerFunc");
        }
        TriggerExecute(auto_libArbitrary_gf_Fade_Trigger, false, false);
      }
      bool auto_libArbitrary_gf_Fade_TriggerFunc(bool testConds, bool runActions) {
        int lp_dialog = auto_libArbitrary_gf_Fade_lp_dialog;
        return true;
      }
    `;
    const library = convertGalaxyToTriggerLibrary(parseGalaxySource(script), parseGalaxySource(''), {
      libraryId: 'Map', implicitLibrary: true,
    });
    const definitions = Object.values(library.elements).filter((element: any) => element.type === 'FunctionDef') as any[];
    expect(definitions).toEqual([expect.objectContaining({ name: 'Fade', flags: expect.arrayContaining(['CreateThread']) })]);
    expect(Object.values(library.elements).some((element: any) => /auto_libArbitrary_gf_Fade/u.test(element.name ?? ''))).toBe(false);
    expect(serializeTriggerLibrary(library)).toContain('<FlagCreateThread/>');
  });

  it('serializes a constant in the editor VariableType contract', () => {
    const m = model();
    const constant = m.add('Variable', { name: 'UpperBound', variableType: { type: 'int' }, isConstant: true,
      initialValue: m.add('Param', { value: '7', valueType: { type: 'int' } }) });
    m.library.items.push(constant);
    const xml = m.xml();
    expect(xml).toMatch(/<VariableType>[\s\S]*<Type Value="int"\/>[\s\S]*<Constant\/>[\s\S]*<\/VariableType>/);
    expect(xml).not.toContain('<Const/>');
    expect(parseTriggerXmlSync(xml).get('TEST')!.elements[`Variable:${constant.id}`].isConstant).toBe(true);
  });

  it('initializes a constant backed by a FunctionCall at runtime even when the template reduces to arithmetic', () => {
    const m = model();
    const left = m.formal('left', 'int');
    const right = m.formal('right', 'int');
    const subtract = m.template('Subtract', '#PARAM(left) - #PARAM(right)', [left, right], [], 'int');
    const call = m.add('FunctionCall', {
      functionDef: subtract,
      parameters: [
        m.add('Param', { parameterDef: left, value: '8', valueType: { type: 'int' } }),
        m.add('Param', { parameterDef: right, value: '1', valueType: { type: 'int' } }),
      ],
    });
    const initial = m.add('Param', { functionCall: call });
    const constant = m.add('Variable', { name: 'last', variableType: { type: 'int' }, isConstant: true, initialValue: initial });
    m.library.items.push(constant);
    const output = m.emit();
    expect(output.header).toContain('int libTEST_gv_last;');
    expect(output.header).not.toContain('const int libTEST_gv_last');
    expect(output.script).toContain('libTEST_gv_last = 8 - 1;');
  });

  it('preserves absent global initializers without inventing typed scalar zero values', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'color tint; unit selectedUnit; int counter; void Run() {}', header: '' });
    const library = parseTriggerXmlSync(result.output.triggerData).get('TEST')!;
    expect(Object.values(library.elementsByType.Variable).every(variable => variable.initialValue === undefined)).toBe(true);
    const output = convertTriggerLibraryToGalaxyFull(library, undefined, undefined, { initialization: 'preserve' });
    expect(output.header).toContain('color tint;');
    expect(output.header).not.toMatch(/tint\s*=/);
  });
  it('roundtrips localized macro bindings in their companion and initializes autos from actual types', async () => {
    const m = model(), formal = m.formal('Item', 'any');
    m.get(formal).displayName = 'Item';
    const template = m.template('StoreActual', '#INITAUTOVAR(saved,item) consume(#AUTOVAR(saved));', [formal]);
    const argument = m.add('Param', { parameterDef: formal, value: 'abc', valueType: { type: 'string' } });
    m.run(m.add('FunctionCall', { functionDef: template, parameters: [argument] }));
    const strings = serializeTriggerStrings(m.library);
    expect(m.xml()).not.toContain('<Identifier>Item</Identifier>');
    expect(strings).toContain('=Item');
    const result = await convertTriggersToGalaxy(m.xml(), { triggerStrings: strings, libraryId: 'TEST' });
    expect(result.output.script).toMatch(/string auto\w+_saved;/);
    expect(result.output.script).toMatch(/auto\w+_saved = "abc";/);
  });
  it('passes the target through nested custom event definitions with arbitrary names', () => {
    const m = model();
    const role = m.add('SubFuncType', { name: 'ArbitraryRole', isEvent: true });
    const container = m.add('FunctionDef', { name: 'ArbitraryContainer', flags: ['Action', 'SubFunctions'], parameters: [], subFunctionTypes: [role] });
    const native = m.add('FunctionDef', { name: 'ArbitraryNativeEvent', flags: ['Native', 'Event'], returnType: { type: 'void' }, parameters: [] });
    const child = m.add('FunctionCall', { functionDef: native, parameters: [], subFunctionType: role });
    // Editor-authored FlagEvent helpers commonly omit ReturnType in XML; the
    // Galaxy ABI is still void because the function only registers an event.
    const event = m.add('FunctionDef', { name: 'ArbitraryEvent', flags: ['Event'], parameters: [],
      actions: [m.add('FunctionCall', { functionDef: container, parameters: [], subFunctions: [child] })] });
    const outer = m.add('FunctionDef', { name: 'OuterEvent', flags: ['Event'], parameters: [],
      actions: [m.add('FunctionCall', { functionDef: container, parameters: [], subFunctions: [m.add('FunctionCall', { functionDef: event, subFunctionType: role })] })] });
    for (const name of ['First', 'Second']) m.library.items.push(m.add('Trigger', { name, actions: [], conditions: [], events: [m.call(outer)] }));
    const output = m.emit();
    expect(output.header).toContain('void libTEST_gf_ArbitraryEvent (trigger eventTarget)');
    expect(output.script).toContain('ArbitraryNativeEvent(eventTarget);');
    expect(output.script).toContain('libTEST_gf_ArbitraryEvent(eventTarget);');
    for (const name of ['First', 'Second']) expect(output.script).toContain(`libTEST_gf_OuterEvent(libTEST_gt_${name});`);
    m.run(m.call(native));
    expect(() => m.emit()).toThrow('EVENT_CONTEXT');
  });

  it('uses supplied declaration files for a public reverse conversion', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'int[ExternalLimit + 1] values; void Run() {}', header: '',
      galaxyDeclarations: [{ fileName: 'arbitrary.galaxy', text: 'const int ExternalLimit = 11;' }] });
    expect(result.output.triggerData).toContain('ArraySize Dim="0" Value="11"');
    expect(result.fidelity.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'sc2-triggers/constant-fold' })]));
  });
  it('keeps same-ID localized labels distinct and binds only implicit editor names', () => {
    const library = parseTriggerXmlSync('<TriggerData><Library Id="TEST"><Element Type="ParamDef" Id="00000001"><ParameterType><Type Value="int"/></ParameterType></Element><Element Type="FunctionDef" Id="00000001"><Identifier>Identity</Identifier><FlagCall/><Template/><ReturnType><Type Value="int"/></ReturnType><Parameter Type="ParamDef" Id="00000001"/><ScriptCode>#PARAM(task)</ScriptCode></Element></Library></TriggerData>').get('TEST')!;
    applyTriggerStringsByType('TEST', library.elementsByType, parseTriggerStrings('ParamDef/Name/lib_TEST_00000001=Task\nFunctionDef/Name/lib_TEST_00000001=Localized operator'));
    const param = library.elementsByType.ParamDef['00000001'], definition = library.elementsByType.FunctionDef['00000001'];
    expect(param.name).toBe('Task');
    expect(definition.name).toBe('Identity');
    expect(definition.displayName).toBe('Localized operator');
    expect([...compileTemplate(definition, [library])!.parameters.keys()]).toEqual(['task']);
    param.identifier = 'Task';
    expect(compileTemplate(definition, [library])).toBeUndefined();
  });

  it('retains companion grammar and non-hex library names without moving them into XML', () => {
    const library = parseTriggerXmlSync('<TriggerData><Library Id="USER_LIB"><Element Type="ParamDef" Id="00000001"><ParameterType><Type Value="int"/></ParameterType></Element></Library></TriggerData>').get('USER_LIB')!;
    const strings = 'Library/Name/USER_LIB=Custom library\nParamDef/Name/lib_USER_LIB_00000001=Count\nParamDef/Grammar/lib_USER_LIB_00000001=amount';
    const parsed = parseTriggerStrings(strings);
    expect(parsed.get('Library:USER_LIB')).toBe('Custom library');
    applyTriggerStringsByType('USER_LIB', library.elementsByType, parsed);
    expect(library.elementsByType.ParamDef['00000001']).toMatchObject({ displayName: 'Count', grammar: 'amount', grammarSource: 'strings' });
    expect(serializeTriggerLibrary(library)).not.toContain('<Grammar>');
    expect(serializeTriggerStrings(library)).toContain('ParamDef/Grammar/lib_USER_LIB_00000001=amount');
  });

  it('keeps Param/Value localization separate from trigger display names', () => {
    const library = parseTriggerXmlSync('<TriggerData><Library Id="TEST"><Element Type="Param" Id="A0000001"><ValueType Type="text"/></Element></Library></TriggerData>').get('TEST')!;
    const parsed = parseTriggerStrings('Param/Value/lib_TEST_A0000001=Localized text');
    applyTriggerStringsByType('TEST', library.elementsByType, parsed);
    expect(parsed.get('ParamValue:TEST_A0000001')).toBe('Localized text');
    expect(library.elementsByType.Param['A0000001']).toMatchObject({ localizedValue: 'Localized text' });
    expect(library.elementsByType.Param['A0000001'].name).toBeUndefined();
  });

  it('distinguishes empty and whitespace external text values', () => {
    const rawText = { type: 'ParamDef', id: 'D0000001', library: 'Map', paramType: { type: 'text' } };
    const presetText = { type: 'ParamDef', id: 'D0000002', library: 'Map', paramType: { type: 'text' }, preset: { type: 'Preset', id: 'P0000001', library: 'Map' } };
    const library: any = {
      id: 'Map', implicit: true, triggerStringsLoaded: true, paramValuesLoaded: true,
      elements: { D0000001: rawText, D0000002: presetText },
      elementsByType: { ParamDef: { D0000001: rawText, D0000002: presetText } },
    };
    const ctx = { library, libId: 'Map', allLibraries: new Map([['Map', library]]), autoVarDeclarations: [], exprCache: new Map() } as any;
    const parsed = parseTriggerStrings('Param/Value/A0000001= \nParam/Value/A0000002=');
    expect(parsed.get('ParamValue:Root:A0000001')).toBe(' ');
    expect(parsed.get('ParamValue:Root:A0000002')).toBe('');
    expect(printNode(convertParamExpr({
      type: 'Param', id: 'A0000001', library: 'Map', valueType: { type: 'text' }, localizedValue: parsed.get('ParamValue:Root:A0000001'),
    }, ctx))).toBe('StringExternal("Param/Value/A0000001")');
    expect(printNode(convertParamExpr({
      type: 'Param', id: 'A0000002', library: 'Map', parameterDef: { type: 'ParamDef', id: 'D0000001', library: 'Map' },
      valueType: { type: 'text' }, localizedValue: parsed.get('ParamValue:Root:A0000002'),
    }, ctx))).toBe('StringExternal("Param/Value/A0000002")');
    expect(printNode(convertParamExpr({
      type: 'Param', id: 'A0000004', library: 'Map', parameterDef: { type: 'ParamDef', id: 'D0000002', library: 'Map' },
      valueType: { type: 'text' }, localizedValue: parsed.get('ParamValue:Root:A0000002'),
    }, ctx))).toBe('StringToText("")');
    expect(printNode(convertParamExpr({
      type: 'Param', id: 'A0000003', library: 'Map', valueType: { type: 'text' },
    }, ctx))).toBe('StringExternal("Param/Value/A0000003")');
    library.completeLocalizedValues = true;
    ctx.exprCache.clear();
    expect(printNode(convertParamExpr({
      type: 'Param', id: 'A0000003', library: 'Map', valueType: { type: 'text' },
    }, ctx))).toBe('StringToText("")');
    library.completeLocalizedValues = false;
    ctx.exprCache.clear();
    library.paramValuesLoaded = false;
    expect(printNode(convertParamExpr({
      type: 'Param', id: 'A0000003', library: 'Map', valueType: { type: 'text' },
    }, ctx))).toBe('StringExternal("Param/Value/A0000003")');
  });

  it('prints an integral fixed parameter as a fixed literal', () => {
    expect(printNode(convertParamExpr({ type: 'Param', id: 'fixed', valueType: { type: 'fixed' }, value: '100' }, {} as any))).toBe('100.0');
  });

  it('compiles an attribute selection to its Galaxy value without the editor selector ID', () => {
    expect(printNode(convertParamExpr({ type: 'Param', id: 'race', valueType: { type: 'attributevalue' }, value: '16|0013' }, {} as any))).toBe('"0013"');
    expect(printNode(convertParamExpr({ type: 'Param', id: 'quoted', valueType: { type: 'attributevalue' }, value: '"16|0013"' }, {} as any))).toBe('"0013"');
    expect(printNode(convertParamExpr({ type: 'Param', id: 'plain', valueType: { type: 'attributevalue' }, value: '0013' }, {} as any))).toBe('"0013"');
  });

  it('omits InitVariables when an explicit library has no global variables', () => {
    const m = model();
    m.run();
    const output = m.emit();
    expect(output.script).not.toContain('void libTEST_InitVariables');
    expect(output.script).not.toContain('libTEST_InitVariables();');
    expect(output.script).not.toContain('libTEST_InitVariables_completed');
    expect(output.header).not.toContain('void libTEST_InitVariables');
  });

  it('evaluates external constant chains as lengths while preserving known symbolic upper bounds', () => {
    const source = parseGalaxySource('const int Limit = 8; const int Capacity = Limit * 2;', 'external.galaxy');
    const index = new GalaxyConstantIndex([source]);
    const length = (parseGalaxySource('int[Capacity + 1] values;').statements[0] as any).type.size;
    expect(parseArraySizeExpr(length, new Map(), index)).toEqual({ value: '16' });
    expect(index.folds[0]).toMatchObject({ value: 17, declarations: expect.arrayContaining([{ name: 'Capacity', file: 'external.galaxy' }]) });
    expect(parseArraySizeExpr(length, new Map([['Capacity', { id: '00000001', library: 'OTHER' }]]), index)).toEqual({ variable: { type: 'Variable', id: '00000001', library: 'OTHER' } });
  });

  it('does not fold mutable shadows, cycles, overflow or a zero divisor', () => {
    const expression = (code: string) => (parseGalaxySource(`void f() { return ${code}; }`).statements[0] as any).body.statements[0].expression;
    const index = new GalaxyConstantIndex([parseGalaxySource('const int Size = 8; const int A = B; const int B = A;')]);
    expect(index.scope(parseGalaxySource('int Size;').statements).evaluate(expression('Size + 1'))).toBeUndefined();
    expect(index.evaluate(expression('2147483647 + 1'))).toBeUndefined();
    expect(index.evaluate(expression('1 / 0'))).toBeUndefined();
    expect(() => index.evaluate(expression('A'))).toThrow();
  });

  it('emits an editor object reference from ValueId and refuses unknown components', () => {
    expect(printNode(convertParamExpr({ type: 'Param', id: '0', valueType: { type: 'byte' }, value: '0' }, {} as any))).toBe('0');
    expect(printNode(convertParamExpr({ type: 'Param', id: '00', valueType: { type: 'byte' } }, {} as any))).toBe('0');
    expect(printNode(convertParamExpr({ type: 'Param', id: '1', valueType: { type: 'region' }, valueId: '17' }, {} as any))).toBe('RegionFromId(17)');
    expect(printNode(convertParamExpr({ type: 'Param', id: '2', valueType: { type: 'region' }, valueId: '34', value: 'false' }, {} as any))).toBe('RegionFromId(34)');
    expect(printNode(convertParamExpr({ type: 'Param', id: '3', valueType: { type: 'point' }, valueId: '9', value: '1' }, {} as any))).toBe('PointFromId(9)');
    expect(printNode(convertParamExpr({ type: 'Param', id: '4', valueType: { type: 'doodad' }, valueId: '711' }, {} as any))).toBe('DoodadFromId(711)');
    expect(printNode(convertParamExpr({ type: 'Param', id: '5', valueType: { type: 'bool' }, valueId: '342', value: 'true' }, {} as any))).toBe('true');
    expect(printNode(convertParamExpr({ type: 'Param', id: '6', valueType: { type: 'bool' }, valueId: '342', value: 'false' }, {} as any))).toBe('false');
    expect(() => convertParamExpr({ type: 'Param', id: '1', valueType: { type: 'unknown' }, valueId: '17' }, {} as any)).toThrow();
    expect(() => convertParamExpr({ type: 'Param', id: '1', valueTypeInfo: '2' }, {} as any)).toThrow();
  });
  it('retains literal components and inline flags through XML serialization', () => {
    const m = model();
    const p = m.add('Param', { valueType: { type: 'region' }, valueId: '004', valueTypeInfo: '2' });
    const f = m.add('FunctionDef', { name: 'ArbitraryInline', flags: ['Inline', 'Action'], scriptCode: 'return;', grammar: 'arbitrary text' });
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    expect(parsed.elementsByType.Param[p.id]).toMatchObject({ valueId: '004', valueTypeInfo: '2' });
    expect(parsed.elementsByType.FunctionDef[f.id]).toMatchObject({ flags: ['Inline', 'Action'], grammar: 'arbitrary text', identifier: 'ArbitraryInline' });
    const twice = parseTriggerXmlSync(serializeTriggerLibrary(parsed)).get('TEST')!;
    expect(twice.elementsByType.Param[p.id]).toEqual(parsed.elementsByType.Param[p.id]);
  });

  it('preserves and evaluates editor ExpressionText with named structured operands', () => {
    const m = model();
    const numberFormal = m.formal('value', 'int');
    const intToString = m.add('FunctionDef', {
      name: 'IntToString', flags: ['Native', 'Call'], parameters: [numberFormal], returnType: { type: 'string' },
    });
    const number = m.add('Param', { parameterDef: numberFormal, value: '7', valueType: { type: 'int' } });
    const conversion = m.add('FunctionCall', { functionDef: intToString, parameters: [number] });
    const index = m.add('Param', { functionCall: conversion, expressionCode: 'Index' });
    const stringExpression = m.add('Param', {
      expressionType: 'string', expressionText: 'Area ~Index~ / ~Index~', expressionParams: [index],
    });
    const left = m.add('Param', { value: '2.0', valueType: { type: 'fixed' }, expressionCode: 'Left' });
    const right = m.add('Param', { value: '3.0', valueType: { type: 'fixed' }, expressionCode: 'Right' });
    const numericExpression = m.add('Param', {
      expressionType: 'fixed', expressionText: '~Left~ * (~Right~ + 1.0)', expressionParams: [left, right],
    });

    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const ctx = { library: parsed, libId: 'TEST', allLibraries: new Map([['TEST', parsed]]), autoVarDeclarations: [], exprCache: new Map() } as any;
    expect(printNode(convertParamExpr(parsed.elementsByType.Param[stringExpression.id], ctx)))
      .toBe('"Area " + IntToString(7) + " / " + IntToString(7)');
    expect(printNode(convertParamExpr(parsed.elementsByType.Param[numericExpression.id], ctx)))
      .toBe('2.0 * (3.0 + 1.0)');

    const twice = parseTriggerXmlSync(serializeTriggerLibrary(parsed)).get('TEST')!;
    expect(twice.elementsByType.Param[stringExpression.id]).toEqual(parsed.elementsByType.Param[stringExpression.id]);
    expect(twice.elementsByType.Param[index.id].expressionCode).toBe('Index');
  });

  it('ignores stale ExpressionParam bindings that ExpressionText no longer references', () => {
    const m = model();
    const used = m.add('Param', { value: '7', valueType: { type: 'int' }, expressionCode: 'A' });
    const stale = m.add('Param', { value: '99', valueType: { type: 'int' }, expressionCode: 'B' });
    const expression = m.add('Param', {
      expressionType: 'string', expressionText: 'Min~A~', expressionParams: [used, stale],
    });
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const ctx = { library: parsed, libId: 'TEST', allLibraries: new Map([['TEST', parsed]]), autoVarDeclarations: [], exprCache: new Map() } as any;
    expect(printNode(convertParamExpr(parsed.elementsByType.Param[expression.id], ctx))).toBe('"Min" + 7');
  });

  it('ignores unaddressable ExpressionParam children without ExpressionCode', () => {
    const m = model();
    const used = m.add('Param', { value: '7', valueType: { type: 'int' }, expressionCode: 'A' });
    const stale = m.add('Param', { value: '99', valueType: { type: 'int' } });
    const expression = m.add('Param', {
      expressionType: 'string', expressionText: 'Min~A~', expressionParams: [used, stale],
    });
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const ctx = { library: parsed, libId: 'TEST', allLibraries: new Map([['TEST', parsed]]), autoVarDeclarations: [], exprCache: new Map() } as any;
    expect(printNode(convertParamExpr(parsed.elementsByType.Param[expression.id], ctx))).toBe('"Min" + 7');
  });

  it('reconstructs and preserves dynamic ValueParam slots in a catalog field path', () => {
    const m = model();
    const first = m.add('Param', { value: '4', valueType: { type: 'int' } });
    const second = m.add('Param', { value: '9', valueType: { type: 'int' } });
    const path = m.add('Param', {
      value: 'InfoArray[0].Unit[1]', valueType: { type: 'catalogfieldpath' }, valueParams: [first, second],
    });
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const ctx = { library: parsed, libId: 'TEST', allLibraries: new Map([['TEST', parsed]]), autoVarDeclarations: [], exprCache: new Map() } as any;
    expect(printNode(convertParamExpr(parsed.elementsByType.Param[path.id], ctx)))
      .toBe('"InfoArray[" + IntToString(4) + "].Unit[" + IntToString(9) + "]"');
    expect(m.xml()).toContain('<ValueParam Type="Param" Library="TEST" Id="00000001"/>');
    const twice = parseTriggerXmlSync(serializeTriggerLibrary(parsed)).get('TEST')!;
    expect(twice.elementsByType.Param[path.id].valueParams).toEqual(parsed.elementsByType.Param[path.id].valueParams);
  });

  it('uses a complete FunctionCall operand instead of stale unbound ValueParam slots', () => {
    const m = model();
    const input = m.formal('value', 'string');
    const convert = m.add('FunctionDef', {
      name: 'ConvertPath', flags: ['Native', 'Call'], parameters: [input], returnType: { type: 'catalogfieldpath' },
    });
    const text = m.add('Param', { parameterDef: input, value: 'Unit', valueType: { type: 'string' } });
    const call = m.add('FunctionCall', { functionDef: convert, parameters: [text] });
    const stale = m.add('Param', { value: '3', valueType: { type: 'int' } });
    const path = m.add('Param', { functionCall: call, valueParams: [stale] });
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const ctx = { library: parsed, libId: 'TEST', allLibraries: new Map([['TEST', parsed]]), autoVarDeclarations: [], exprCache: new Map() } as any;
    expect(printNode(convertParamExpr(parsed.elementsByType.Param[path.id], ctx))).toBe('ConvertPath("Unit")');
  });

  it('places localized text-expression token setters immediately before their action', () => {
    const m = model();
    const value = m.formal('value', 'text');
    const consume = m.template('Consume', 'Consume(#PARAM(value));', [value]);
    const token = m.add('Param', { valueType: { type: 'text' }, localizedValue: 'Token value', expressionCode: 'A' });
    const expression = m.add('Param', { parameterDef: value, expressionType: 'text', expressionParams: [token] });
    const call = m.add('FunctionCall', { functionDef: consume, parameters: [expression] });
    m.run(call);
    const script = m.emit().script;
    const setter = 'TextExpressionSetToken("Param/Expression/lib_TEST_';
    const consumeCall = 'Consume(TextExpressionAssemble("Param/Expression/lib_TEST_';
    expect(script).toContain(setter);
    expect(script).toContain(consumeCall);
    expect(script.indexOf(setter)).toBeLessThan(script.indexOf(consumeCall));
  });

  it('ignores uncoded stale children in localized text expressions', () => {
    const m = model();
    const value = m.formal('value', 'text');
    const consume = m.template('Consume', 'Consume(#PARAM(value));', [value]);
    const token = m.add('Param', { valueType: { type: 'text' }, localizedValue: 'Token value', expressionCode: 'A' });
    const stale = m.add('Param', { valueType: { type: 'text' }, localizedValue: 'Stale value' });
    const expression = m.add('Param', { parameterDef: value, expressionType: 'text', expressionParams: [token, stale] });
    const call = m.add('FunctionCall', { functionDef: consume, parameters: [expression] });
    m.run(call);

    const script = m.emit().script;
    expect(script.match(/TextExpressionSetToken\(/gu)).toHaveLength(1);
    expect(script).toContain(', "A", StringExternal(');
    expect(script).toContain('Consume(TextExpressionAssemble(');
  });

  it('keeps localized text-expression token setters inside a nested template block', () => {
    const m = model();
    const body = m.role('Body');
    const loop = m.template('Loop', 'while (true) {\n#SUBFUNCS(Body)\nbreak;\n}', [], [body]);
    const value = m.formal('value', 'text');
    const consume = m.template('Consume', 'Consume(#PARAM(value));', [value]);
    const token = m.add('Param', { valueType: { type: 'text' }, localizedValue: 'Token value', expressionCode: 'A' });
    const expression = m.add('Param', { parameterDef: value, expressionType: 'text', expressionParams: [token] });
    const child = m.add('FunctionCall', { functionDef: consume, parameters: [expression], subFunctionType: body });
    m.run(m.add('FunctionCall', { functionDef: loop, parameters: [], subFunctions: [child] }));

    const script = m.emit().script;
    const loopAt = script.indexOf('while (true)');
    const setterAt = script.indexOf('TextExpressionSetToken(');
    const consumeAt = script.indexOf('Consume(TextExpressionAssemble(');
    expect(loopAt).toBeGreaterThanOrEqual(0);
    expect(setterAt).toBeGreaterThan(loopAt);
    expect(consumeAt).toBeGreaterThan(setterAt);
  });

  it('calls an action-bodied macro definition instead of inlining its ScriptCode', () => {
    const m = model();
    const value = m.formal('value', 'int');
    const nativeValue = m.formal('value', 'int');
    const native = m.add('FunctionDef', {
      name: 'NativeCheck', flags: ['Native', 'Call'], parameters: [nativeValue], returnType: { type: 'bool' },
    });
    const bodyArgument = m.add('Param', { parameterDef: nativeValue, paramRef: value });
    const bodyCall = m.add('FunctionCall', { functionDef: native, parameters: [bodyArgument] });
    const wrapper = m.add('FunctionDef', {
      name: 'VisibleWrapper', flags: ['Call'], parameters: [value], returnType: { type: 'bool' },
      actions: [bodyCall], scriptCode: 'NativeCheck(#PARAM(value));',
    });
    const consumeValue = m.formal('value', 'bool');
    const consume = m.template('Consume', 'Consume(#PARAM(value));', [consumeValue]);
    const literal = m.add('Param', { parameterDef: value, value: '7', valueType: { type: 'int' } });
    const wrapperCall = m.add('FunctionCall', { functionDef: wrapper, parameters: [literal] });
    const nested = m.add('Param', { parameterDef: consumeValue, functionCall: wrapperCall });
    m.library.items.push(wrapper);
    m.run(m.add('FunctionCall', { functionDef: consume, parameters: [nested] }));

    const script = m.emit().script;
    expect(script).toContain('Consume(libTEST_gf_VisibleWrapper(7));');
    expect(script).not.toContain('Consume(NativeCheck(7));');
  });

  it('uses the NativeLib wrapper name for a structured macro-bodied function', () => {
    const definition: any = {
      type: 'FunctionDef', id: 'WRAPPED', library: 'Ntve', name: 'VisibleWrapper',
      flags: ['Call'], scriptCode: 'NativeCheck(#PARAM(value));', actions: [{ type: 'FunctionCall', id: 'BODY', library: 'Ntve' }],
    };
    const native: any = {
      id: 'Ntve', items: [], elements: { 'FunctionDef:WRAPPED': definition },
      elementsByType: { FunctionDef: { WRAPPED: definition } },
    };
    const current: any = { id: 'Map', implicit: true, items: [], elements: {}, elementsByType: {} };
    const ctx: any = { libId: 'Map', library: current, nativeLibrary: native, allLibraries: new Map([['Ntve', native]]) };
    expect(toGalaxyFunctionName(definition, ctx)).toBe('libNtve_gf_VisibleWrapper');
  });

  it.each([
    ['point', undefined, '239', 'PointFromId(239)'],
    ['region', undefined, '004', 'RegionFromId(4)'],
    ['playercolor', undefined, undefined, '0'],
    ['playercolor', undefined, '23', '23'],
    ['soundlink', 'AnAuthoredSound', undefined, 'SoundLink("AnAuthoredSound", -1)'],
    ['soundlink', 'AnAuthoredSound', '0', 'SoundLink("AnAuthoredSound", -1)'],
    ['soundlink', 'AnAuthoredSound', '1', 'SoundLink("AnAuthoredSound", 0)'],
    ['soundlink', 'AnAuthoredSound', '7', 'SoundLink("AnAuthoredSound", 6)'],
  ])('decodes editor %s literals without depending on library or function names', (type, value, valueId, expected) => {
    expect(printNode(convertParamExpr({ type: 'Param', id: 'arbitrary', valueType: { type: type! }, value, valueId }, {} as any))).toBe(expected);
  });

  it.each(['-1', '1.5', '2147483648', 'invalid'])('rejects invalid compound value ID %s', valueId => {
    for (const type of ['point', 'region', 'soundlink', 'playercolor']) {
      expect(() => convertParamExpr({ type: 'Param', id: 'x', valueType: { type }, valueId, ...(type === 'soundlink' ? { value: 'AnySound' } : {}) }, {} as any)).toThrow();
    }
  });

  it('does not drop unknown metadata or conflicting components of a supported literal', () => {
    for (const valueType of ['point', 'region', 'soundlink', 'playercolor']) {
      expect(() => convertParamExpr({ type: 'Param', id: 'x', valueType: { type: valueType }, valueId: '4', valueTypeInfo: '2' }, {} as any)).toThrow();
    }
    expect(printNode(convertParamExpr({ type: 'Param', id: 'x', valueType: { type: 'point' }, valueId: '4', value: 'extra' }, {} as any))).toBe('PointFromId(4)');
    expect(() => convertParamExpr({ type: 'Param', id: 'x', valueType: { type: 'soundlink' }, valueId: '4' }, {} as any)).toThrow();
  });

  it('keeps sound handles and player color indices typed through declarations and variable references', async () => {
    const m = model(), actions: ElementRefJson[] = [];
    for (const [type, value, valueId] of [['soundlink', 'AuthoredSound', '3'], ['playercolor', undefined, '9']] as const) {
      const initial = m.add('Param', { valueType: { type }, value, valueId });
      const variable = m.add('Variable', { name: `${type}Value`, variableType: { type }, initialValue: initial });
      m.library.items.push(variable);
      const formal = m.formal('argument', type);
      const fn = m.add('FunctionDef', { name: `Consume_${type}`, flags: ['Native', 'Action'], parameters: [formal], returnType: { type: 'void' } });
      const actual = m.add('Param', { parameterDef: formal, valueType: { type }, variable });
      actions.push(m.add('FunctionCall', { functionDef: fn, parameters: [actual] }));
    }
    m.run(...actions);
    const result = await convertTriggersToGalaxy(m.xml(), { galaxyDeclarations: [{ fileName: 'api.galaxy', text: 'native soundlink SoundLink(string catalog, int index); native void Consume_soundlink(soundlink value); native void Consume_playercolor(int value);' }] });
    expect(result.output.header).toContain('soundlink libTEST_gv_soundlinkValue;');
    expect(result.output.header).toContain('int libTEST_gv_playercolorValue;');
    expect(result.output.script).toContain('SoundLink("AuthoredSound", 2)');
    expect(result.output.script).toContain('Consume_soundlink(libTEST_gv_soundlinkValue)');
    expect(result.fidelity.verification.galaxyValidation.errors).toBe(0);
  });

  it('inlines a macro-free operator return in the caller and keeps ordinary bodies separate', () => {
    const m = model();
    const operator = m.add('FunctionDef', { name: 'LeaveCaller', flags: ['Action', 'Operator'], parameters: [], scriptCode: 'return false;' });
    m.add('FunctionDef', { name: 'Ordinary', flags: ['Call'], returnType: { type: 'bool' }, parameters: [], scriptCode: 'return false;' });
    m.library.items.push(m.add('Trigger', { name: 'Caller', conditions: [], actions: [m.call(operator)], events: [] }));
    const output = m.emit();
    expect(output.script).not.toContain('gf_LeaveCaller');
    expect(output.header).not.toContain('gf_LeaveCaller');
    expect(output.script).toMatch(/bool libTEST_gt_Caller_Func[\s\S]*return false;/);
    expect(output.script).toContain('bool libTEST_gf_Ordinary (');
  });

  it('does not mistake an Inline flag on a GUI action body for missing ScriptCode', () => {
    const m = model();
    const action = m.template('Primitive', 'consume();');
    const helper = m.add('FunctionDef', { name: 'BodyFunction', flags: ['Action', 'Inline'], parameters: [], returnType: { type: 'void' }, actions: [m.call(action)] });
    m.run(m.call(helper));
    const output = m.emit();
    expect(output.script).toContain('void libTEST_gf_BodyFunction (');
    expect(output.script).toContain('libTEST_gf_BodyFunction();');
    expect(output.script).toContain('consume();');
  });

  // Editor oracle (2407 + 462 + 142 corpus loops, none with another index name): a local array's
  // initial value is filled with the indices init_i, init_j, ..., declared first in the body, ahead
  // of its Variable Declarations (Star Party v, KillfeedShowEvent: `int init_i;` then the banner).
  it.each(['Trigger', 'FunctionDef'])('fills multidimensional local arrays inside %s without scalar assignment', ownerType => {
    const m = model();
    const initial = m.add('Param', { scriptCode: 'NextValue()' });
    const local = m.add('Variable', { name: 'matrix', variableType: { type: 'int' }, isArray: true,
      arraySizes: [{ dim: 0, value: '1' }, { dim: 1, value: '2' }], initialValue: initial });
    // A local named like an index is still a local of its own, `lv_init_i`.
    const occupied = m.add('Variable', { name: 'init_i', variableType: { type: 'int' } });
    m.library.items.push(m.add(ownerType, { name: 'Run', localVariables: [local, occupied], parameters: [], actions: [], conditions: [], events: [], returnType: { type: 'void' }, flags: ['Action'] }));
    const output = m.emit().script;
    expect(output).not.toMatch(/\blv_matrix\s*=/);
    expect(output).toMatch(/lv_matrix\[init_i\]\[init_j\] = NextValue\(\);/);
    expect(output).toMatch(/init_i <= 1/);
    expect(output).toMatch(/init_j <= 2/);
    expect(output).toMatch(/\{\s*int init_i;\s*int init_j;\s*\/\/ Variable Declarations\s*int\[2\]\[3\] lv_matrix;\s*int lv_init_i;/u);
    expect(output.match(/NextValue\(\)/g)).toHaveLength(1);
  });

  it('writes the initial values of a function\'s local array back with the editor\'s index', async () => {
    const script = ['void gf_Fill () {', '    int init_i;', '', '    // Variable Declarations', '    int[6] lv_items;', '',
      '    // Automatic Variable Declarations', '    // Variable Initialization', '    for (init_i = 0; init_i <= 5; init_i += 1) {',
      '        lv_items[init_i] = 3;', '    }', '', '    // Implementation', '    lv_items[1] = 4;', '}', ''].join('\n');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script, header: '' });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map', ...reverse.output.generationOptions });
    expect(forward.output.script).toMatch(/void gf_Fill \(\) \{\s*int init_i;\s*\/\/ Variable Declarations\s*int\[6\] lv_items;/u);
    expect(forward.output.script).toMatch(/for \( ?init_i = 0; init_i <= 5; init_i \+= 1 ?\) \{\s*lv_items\[init_i\] = 3;\s*\}/u);
  });

  // KeyStone `lib1_gf_BuildStructure(..., false, -1, 0)`, TTosh1 `CameraApplyInfo(..., -1, 10, true)`: an integer
  // in a fixed slot is an int value to the editor, written without `.0`; they came back as `-1.0` and `10.0`.
  it('writes integer arguments of fixed parameters as they were', async () => {
    const script = 'void gf_Do (fixed lp_a, fixed lp_b, fixed lp_c) {\n}\nvoid gf_Go () {\n    gf_Do(-1, 10, 2.5);\n}\n';
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script, header: '' });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map', ...reverse.output.generationOptions });
    expect(forward.output.script).toContain('gf_Do(-1, 10, 2.5);');
  });

  it('legacy helper names do not impose semantics on a loaded action or expression', () => {
    const m = model(), value = m.formal('arbitrary', 'int');
    const action = m.template('UnrelatedAction', 'first(#PARAM(arbitrary)); second();', [value]);
    const operator = m.template('UnrelatedExpression', '#PARAM(arbitrary) * 2', [value], [], 'int');
    const actionCall = m.call(action, { arbitrary: '3' }), expressionCall = m.call(operator, { arbitrary: '5' });
    const library = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const ctx: any = { library, libId: library.id, allLibraries: new Map(), localVarIds: new Set(),
      autoVarDeclarations: [], subFuncTypeNames: new Map(), exprCache: new Map() };
    const call = library.elementsByType.FunctionCall[actionCall.id];
    const statement = convertWhileDo(call, ctx)!;
    expect(printNode(statement)).toContain('first(3);');
    expect(printNode(statement)).toContain('second();');
    expect(printNode(statement)).not.toContain('while');
    expect(printNode(convertWaitForCondition(call, ctx))).toBe(printNode(statement));
    expect(printNode(convertComparison(library.elementsByType.FunctionCall[expressionCall.id], ctx))).toBe('5 * 2');
  });

  it('preserves authored parameter expressions including writable member access', () => {
    const m = model(), lhs = m.formal('target', 'anyvariable'), rhs = m.formal('value', 'int');
    const action = m.template('UnrelatedWriter', '#PARAM(target) = #PARAM(value);', [lhs, rhs]);
    const target = m.add('Param', { parameterDef: lhs, customType: 'anyvariable', scriptCode: 'arbitrary.items[index + 1]' });
    const value = m.add('Param', { parameterDef: rhs, customType: 'int', scriptCode: 'CountThings() + 2' });
    m.run(m.add('FunctionCall', { functionDef: action, parameters: [target, value] }));
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    expect(parsed.elementsByType.Param[target.id]).toMatchObject({ customType: 'anyvariable', scriptCode: 'arbitrary.items[index + 1]' });
    expect(m.emit().script).toContain('arbitrary.items[index + 1] = (CountThings() + 2);');
  });

  it.each(['x; injected();', 'x = 1', 'x)'])('rejects statement injection or malformed parameter script: %s', scriptCode => {
    const m = model(), formal = m.formal('value', 'int'), action = m.template('Use', 'consume(#PARAM(value));', [formal]);
    m.run(m.add('FunctionCall', { functionDef: action, parameters: [m.add('Param', { parameterDef: formal, scriptCode })] }));
    expect(() => m.emit()).toThrow('PARAM_SCRIPT_SYNTAX');
  });

  it.each([['anypreset', 'int'], ['anyvariable', 'fixed']])('uses the declared runtime constraint of %s', (type, runtime) => {
    const m = model(), formal = m.formal('value', type);
    m.get(formal).paramType.variableType = runtime;
    const operator = m.add('FunctionDef', { name: 'UnrelatedConversion', flags: ['Operator', 'Call'], parameters: [formal], returnType: { type: runtime } });
    const arg = m.add('Param', { parameterDef: formal, value: '7', valueType: { type: runtime } });
    const call = m.add('FunctionCall', { functionDef: operator, parameters: [arg] });
    const useFormal = m.formal('value', runtime), use = m.template('Use', 'consume(#PARAM(value));', [useFormal]);
    m.run(m.add('FunctionCall', { functionDef: use, parameters: [m.add('Param', { parameterDef: useFormal, functionCall: call })] }));
    expect(parseTriggerXmlSync(m.xml()).get('TEST')!.elementsByType.ParamDef[formal.id]).toMatchObject({ paramType: { type, variableType: runtime } });
    expect(m.emit().script).toContain(runtime === 'fixed' ? 'consume((7.0));' : 'consume((7));');
  });

  it('specializes an abstract operator using the actual preset declaration', () => {
    const m = model(), formal = m.formal('operand', 'anypreset');
    const value = m.add('PresetValue', { value: '7' });
    m.add('Preset', { baseType: 'int', values: [value] });
    const operator = m.add('FunctionDef', { name: 'ArbitraryOperator', flags: ['Operator', 'Call'], parameters: [formal], returnType: { type: 'int' } });
    const nested = m.add('FunctionCall', { functionDef: operator, parameters: [m.add('Param', { parameterDef: formal, preset: value })] });
    const output = m.formal('output', 'int'), action = m.template('Consume', 'consume(#PARAM(output));', [output]);
    m.run(m.add('FunctionCall', { functionDef: action, parameters: [m.add('Param', { parameterDef: output, functionCall: nested })] }));
    expect(m.emit().script).toContain('consume(7);');
  });

  it('infers an auto-variable from a loaded global without a naming heuristic', () => {
    const m = model(), global = m.add('Variable', { name: 'savedValue', variableType: { type: 'fixed' } });
    m.library.items.push(global);
    const action = m.template('Save', '#AUTOVAR(snapshot) = libTEST_gv_savedValue; consume(#AUTOVAR(snapshot));');
    m.run(m.call(action));
    const source = m.emit().script;
    expect(source).toMatch(/fixed auto\w+_snapshot;/);
    expect(source).toMatch(/auto\w+_snapshot = libTEST_gv_savedValue;/);
  });

  it('parses a preset expression as AST rather than an identifier containing code', () => {
    const m = model(), formal = m.formal('value', 'int');
    const value = m.add('PresetValue', { value: '(CountThings() + 2)' });
    m.add('Preset', { baseType: 'int', values: [value] });
    const action = m.add('FunctionDef', { name: 'Consume', flags: ['Native', 'Action'], parameters: [formal] });
    m.run(m.add('FunctionCall', { functionDef: action, parameters: [m.add('Param', { parameterDef: formal, preset: value })] }));
    expect(m.emit().script).toContain('Consume((CountThings() + 2));');
  });

  it.each(['1; unexpected();', 'a = b; } void unexpected() { consume();'])('does not truncate statements or declarations embedded in a preset expression: %s', source => {
    const m = model(), formal = m.formal('value', 'int');
    const value = m.add('PresetValue', { value: source });
    m.add('Preset', { baseType: 'int', values: [value] });
    const action = m.template('Consume', 'consume(#PARAM(value));', [formal]);
    m.run(m.add('FunctionCall', { functionDef: action, parameters: [m.add('Param', { parameterDef: formal, preset: value })] }));
    expect(() => m.emit()).toThrow('PRESET_VALUE');
  });

  it('orders event arguments by declarations, independent of XML order', () => {
    const m = model(), first = m.formal('count', 'int'), second = m.formal('enabled', 'bool');
    const event = m.add('FunctionDef', { name: 'ArbitraryEvent', flags: ['Native', 'Event'], parameters: [first, second] });
    const call = m.add('FunctionCall', { functionDef: event, parameters: [
      m.add('Param', { parameterDef: second, value: 'true', valueType: { type: 'bool' } }),
      m.add('Param', { parameterDef: first, value: '3', valueType: { type: 'int' } }),
    ] });
    m.library.items.push(m.add('Trigger', { name: 'Entry', events: [call], actions: [], conditions: [] }));
    expect(m.emit().script).toContain('ArbitraryEvent(libTEST_gt_Entry, 3, true)');
  });

  it('reuses editor init_i and init_j only for global array initializers', () => {
    const m = model();
    const initial = m.add('Param', { value: '7', valueType: { type: 'int' } });
    const untouched = m.add('Variable', { name: 'untouched', variableType: { type: 'int' }, isArray: true,
      arraySizes: [{ dim: 0, value: '1' }] });
    const first = m.add('Variable', { name: 'first', variableType: { type: 'int' }, isArray: true,
      arraySizes: [{ dim: 0, value: '10' }], initialValue: initial });
    const grid = m.add('Variable', { name: 'grid', variableType: { type: 'int' }, isArray: true,
      arraySizes: [{ dim: 0, value: '2' }, { dim: 1, value: '3' }], initialValue: initial });
    const last = m.add('Variable', { name: 'last', variableType: { type: 'int' }, isArray: true,
      arraySizes: [{ dim: 0, value: '4' }], initialValue: initial });
    m.library.items.push(untouched, first, grid, last);
    const script = m.emit().script;
    expect(script.match(/int init_i;/gu)).toHaveLength(1);
    expect(script.match(/int init_j;/gu)).toHaveLength(1);
    expect(script).toContain('libTEST_gv_first[init_i] = 7;');
    expect(script).toContain('libTEST_gv_grid[init_i][init_j] = 7;');
    expect(script).toContain('libTEST_gv_last[init_i] = 7;');
    expect(script).not.toMatch(/gv_\w+_init_\d/u);
  });

  it('uses a distinct editor index for an array member nested in an array of structures', () => {
    const m = model();
    const value = m.add('Param', { value: 'Marine', valueType: { type: 'gamelink' } });
    const member = m.add('Variable', { name: 'unitType', variableType: { type: 'gamelink' }, isArray: true,
      arraySizes: [{ dim: 0, value: '2' }], initialValue: value });
    const structure = m.add('Structure', { name: 'Escort', variables: [member] });
    const outer = m.add('Variable', { name: 'escorts', variableType: { type: 'struct', typeElement: structure }, isArray: true,
      arraySizes: [{ dim: 0, value: '3' }] });
    m.library.items.push(structure, outer);
    const script = m.emit().script;
    expect(script).toContain('int init_i;');
    expect(script).toContain('int init_i1;');
    expect(script).toContain('libTEST_gv_escorts[init_i].lv_unitType[init_i1] = "Marine";');
  });

  it('preserves a direct runtime event registration with its explicit target trigger', () => {
    const m = model();
    const first = m.formal('first', 'int'), second = m.formal('second', 'int'), third = m.formal('third', 'int');
    const event = m.add('FunctionDef', { name: 'ArbitraryEvent', flags: ['Native', 'Event'], parameters: [first, second, third] });
    const target = m.add('Variable', { name: 'target', variableType: { type: 'trigger' } });
    m.library.items.push(target);
    const call = m.add('FunctionCall', { functionDef: event, parameters: [
      m.add('Param', { parameterDef: first, variable: target }),
      m.add('Param', { parameterDef: second, value: '1', valueType: { type: 'int' } }),
      m.add('Param', { parameterDef: third, value: '2', valueType: { type: 'int' } }),
      m.add('Param', { value: '3', valueType: { type: 'int' } }),
    ] });
    m.run(call);
    expect(m.emit().script).toContain('ArbitraryEvent(libTEST_gv_target, 1, 2, 3);');
  });

  it('requires an explicit selection for multi-library input', async () => {
    const xml = '<TriggerData><Library Id="FIRST"><Root/></Library><Library Id="SECOND"><Root/></Library></TriggerData>';
    await expect(convertTriggersToGalaxy(xml, {})).rejects.toThrow('supply libraryId explicitly');
    expect((await convertTriggersToGalaxy(xml, { libraryId: 'SECOND' })).output.libraryId).toBe('SECOND');
  });

  it.each([false, true])('preserves ordinal presets and uses Item order rather than IDs: %s', reverse => {
    const m = model(), first = m.add('PresetValue', { name: 'First' }), second = m.add('PresetValue', { name: 'Second' });
    const preset = m.add('Preset', { name: 'Choice', integer: true, baseType: 'int', values: reverse ? [second, first] : [first, second] });
    const formal = m.formal('value', 'int'), action = m.template('Use', 'consume(#PARAM(value));', [formal]);
    const arg = m.add('Param', { parameterDef: formal, preset: first });
    m.run(m.add('FunctionCall', { functionDef: action, parameters: [arg] }));
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    expect(parsed.elementsByType.Preset?.[preset.id].integer).toBe(true);
    const output = m.emit();
    expect(output.header).toContain(`const int libTEST_ge_Choice_First = ${reverse ? 1 : 0};`);
    expect(output.script).toContain('consume(libTEST_ge_Choice_First);');
  });

  it.each([['255,0,255,0', 'Color(0.00, 100.00, 0.00)'], ['128,255,0,0', 'ColorWithAlpha(100.00, 0.00, 0.00, 50.20)']])('emits a typed color from editor ARGB %s', (value, expected) => {
    const m = model(), formal = m.formal('value', 'color'), action = m.template('Paint', 'paint(#PARAM(value));', [formal]);
    m.run(m.call(action, { value }));
    expect(m.emit().script).toContain(expected);
  });

  it.each(['256,0,0,0', 'not a color'])('rejects an invalid color instead of emitting a string: %s', value => {
    const m = model(), formal = m.formal('value', 'color'), action = m.template('Paint', 'paint(#PARAM(value));', [formal]);
    m.run(m.call(action, { value }));
    expect(() => m.emit()).toThrow('COLOR_VALUE');
  });

  it.each(['filepath', 'gamelink'])('derives a representation-preserving operator for %s without a named rule', type => {
    const m = model(), formal = m.formal('value', 'string');
    const operator = m.add('FunctionDef', { name: 'UnrelatedOperatorName', flags: ['Operator', 'Call'], parameters: [formal], returnType: { type } });
    const result = m.call(operator, { value: 'ArbitraryAsset' });
    const arg = m.add('Param', { functionCall: result });
    const useFormal = m.formal('value', 'string'), use = m.template('Use', 'consume(#PARAM(value));', [useFormal]);
    m.get(arg).parameterDef = useFormal;
    m.run(m.add('FunctionCall', { functionDef: use, parameters: [arg] }));
    expect(m.emit().script).toContain('consume(("ArbitraryAsset"));');
  });

  it('does not guess a string-to-text conversion from an operator flag', () => {
    const m = model(), formal = m.formal('value', 'string');
    const operator = m.add('FunctionDef', { name: 'AmbiguousConversion', flags: ['Operator', 'Call'], parameters: [formal], returnType: { type: 'text' } });
    m.run(m.call(operator, { value: 'hello' }));
    expect(() => m.emit()).toThrow('OPERATOR_TEMPLATE');
  });

  // The editor compiles a unit filter into four bit masks over the `c_targetFilter*`
  // constants (03-DeadOfNight and every other COOP map), never into a string call.
  it("writes a unit filter as the editor's bit masks", async () => {
    const m = model();
    const preset = m.add('Preset', { name: 'TargetFilter', values: [] });
    const air = m.add('PresetValue', { name: 'Air', identifier: 'Air', value: 'c_targetFilterAir' });
    const dead = m.add('PresetValue', { name: 'Dead', identifier: 'Dead', value: 'c_targetFilterDead' });
    (m.get(preset) as any).values = [air, dead];
    const formal = m.formal('filter', 'unitfilter');
    const fn = m.add('FunctionDef', { name: 'Consume_filter', flags: ['Native', 'Action'], parameters: [formal], returnType: { type: 'void' } });
    const actual = m.add('Param', { parameterDef: formal, valueType: { type: 'unitfilter' }, value: 'Air;Dead' });
    m.run(m.add('FunctionCall', { functionDef: fn, parameters: [actual] }));
    const result = await convertTriggersToGalaxy(m.xml(), { galaxyDeclarations: [{ fileName: 'natives.galaxy',
      text: 'const int c_targetFilterAir = 5; const int c_targetFilterDead = 32; native void Consume_filter(int required1, int required2, int excluded1, int excluded2);' }] });
    expect(result.output.script).toContain('UnitFilter((1 << c_targetFilterAir), 0, 0, (1 << (c_targetFilterDead - 32)))');
    expect(result.output.script).not.toContain('UnitFilterStr');
  });

  it('uses native filter constants when the package has no filter PresetValues', async () => {
    const m = model();
    const formal = m.formal('filter', 'unitfilter');
    const fn = m.add('FunctionDef', { name: 'Consume_filter', flags: ['Native', 'Action'], parameters: [formal], returnType: { type: 'void' } });
    const actual = m.add('Param', { parameterDef: formal, valueType: { type: 'unitfilter' }, value: '-;User1' });
    m.run(m.add('FunctionCall', { functionDef: fn, parameters: [actual] }));
    const result = await convertTriggersToGalaxy(m.xml(), { galaxyDeclarations: [{ fileName: 'natives.galaxy',
      text: 'const int c_targetFilterUser1 = 7; native void Consume_filter(int required1, int required2, int excluded1, int excluded2);' }] });
    expect(result.output.script).toContain('UnitFilter(0, 0, (1 << c_targetFilterUser1), 0)');
  });

  it('checks loaded native signatures even without galaxyDeclarations', async () => {
    const m = model(), formal = m.formal('count', 'int');
    m.add('FunctionDef', { name: 'ObserveCount', flags: ['Native', 'Action'], returnType: { type: 'void' }, parameters: [formal] });
    const result = await convertGalaxyToTriggers({ libraryId: 'USER', header: '', script: 'void Run() { ObserveCount(true); }',
      dependencyLibraries: [{ triggerData: m.xml() }] });
    expect(result.fidelity.verification.galaxyValidation.errors).toBeGreaterThan(0);
    expect(result.fidelity.diagnostics.some((item: any) => item.code === 'sc2-triggers/galaxy-type-mismatch')).toBe(true);
  });

  it('uses supplied native declarations during full Galaxy round-trip verification', async () => {
    const m = model();
    m.library.id = 'Ntve';
    const formal = m.formal('control', 'control');
    m.add('FunctionDef', { name: 'ObserveControl', flags: ['Native', 'Action'], returnType: { type: 'void' }, parameters: [formal] });
    const result = await convertGalaxyToTriggers({
      libraryId: 'USER',
      header: 'int libUSER_gv_control; void libUSER_gf_Run();',
      script: 'void libUSER_gf_Run() { ObserveControl(libUSER_gv_control); }',
      dependencyLibraries: [{ triggerData: m.xml() }],
      galaxyDeclarations: [{ fileName: 'natives.galaxy', text: 'native void ObserveControl(int control);' }],
      verification: 'full',
    });
    expect(result.fidelity.verification.generatedTriggerDataReparsed).toBe(true);
    expect(result.fidelity.verification.galaxyValidation.errors).toBe(0);
  });

  it('keeps explicit resource budgets bounded and enforces the selected input budget', async () => {
    const xml = '<TriggerData><Library Id="TEST"><Root/></Library></TriggerData>';
    await expect(convertTriggersToGalaxy(xml, { limits: { maxInputBytes: 1 } })).rejects.toThrow('exceeds');
    await expect(convertTriggersToGalaxy(xml, { limits: { maxInputBytes: -1 } })).rejects.toThrow('Invalid conversion limit');
    await expect(convertTriggersToGalaxy(xml, { limits: { constructor: 1 } })).rejects.toThrow('Invalid conversion limit');
    await expect(convertTriggersToGalaxy(xml, { limits: { maxInputBytes: Number.MAX_SAFE_INTEGER } })).rejects.toThrow('Invalid conversion limit');
  });

  it('does not invent a void return for a native with incomplete GUI metadata', async () => {
    const m = model();
    m.add('FunctionDef', { name: 'ReadExternalCount', flags: ['Native', 'Action'], parameters: [] });
    const result = await convertGalaxyToTriggers({ libraryId: 'USER', header: '',
      script: 'int Read() { return ReadExternalCount(); }', dependencyLibraries: [{ triggerData: m.xml() }] });
    expect(result.fidelity.verification.galaxyValidation.errors).toBe(0);
    expect(result.fidelity.verification.galaxyValidation.status).toBe('incomplete');
  });

  it.each(['native', 'body'])('does not erase an operator implementation: %s', implementation => {
    const m = model(), formal = m.formal('value', 'string');
    const returnValue = m.template('ReturnWrittenValue', 'return #PARAM(value);', [formal]);
    const definition = m.add('FunctionDef', { name: 'RewritePath', parameters: [formal], returnType: { type: 'filepath' },
      flags: ['Operator', 'Call', ...(implementation === 'native' ? ['Native'] : [])],
      actions: implementation === 'body' ? [m.call(returnValue, { value: 'rewritten' })] : [] });
    m.run(m.call(definition, { value: 'original' }));
    const output = m.emit();
    expect(output.script).toContain('RewritePath("original")');
    if (implementation === 'body') expect(output.script).toContain('return "rewritten";');
  });

  it('rebuilds naming indexes when a library changes between conversions', () => {
    const m = model();
    const first = m.add('FunctionDef', { name: 'A-B', flags: ['Action'], parameters: [], actions: [] });
    const library = parseTriggerXmlSync(m.xml()).get('TEST')!;
    expect(convertTriggerLibraryToGalaxyFull(library).script).toContain('libTEST_gf_AB (');
    const second: any = { type: 'FunctionDef', id: '0000ABCD', library: 'TEST', name: 'AB', flags: ['Action'], parameters: [], actions: [] };
    library.elements[second.id] = second;
    library.elementsByType.FunctionDef![second.id] = second;
    const output = convertTriggerLibraryToGalaxyFull(library).script;
    expect(output).toContain(`libTEST_gf_AB_${first.id} (`);
    expect(output).toContain('libTEST_gf_AB_0000ABCD (');
  });

  it('uses the same color conversion inside a regular function expression', () => {
    const m = model(), color = m.formal('shade', 'color');
    const fn = m.add('FunctionDef', { name: 'GetShade', flags: ['Native', 'Call'], returnType: { type: 'color' }, parameters: [color] });
    const arg = m.add('Param', { parameterDef: color, value: '255,0,255,0', valueType: { type: 'color' } });
    const call = m.add('FunctionCall', { functionDef: fn, parameters: [arg] });
    const nested = m.add('Param', { functionCall: call, valueType: { type: 'color' } });
    const sink = m.template('OutputShade', 'consume(#PARAM(shade));', [color]);
    m.get(nested).parameterDef = color;
    m.run(m.add('FunctionCall', { functionDef: sink, parameters: [nested] }));
    expect(m.emit().script).toContain('GetShade(Color(0.00, 100.00, 0.00))');
  });

  it('counts each library separately from the aggregate element budget', async () => {
    const xml = '<TriggerData><Library Id="ONE"><Root/><Element Type="Comment" Id="00000001"/></Library><Library Id="TWO"><Root/><Element Type="Comment" Id="00000001"/></Library></TriggerData>';
    const options = { libraryId: 'ONE', limits: { maxLibraryElements: 1, maxTotalElements: 2 } };
    expect((await convertTriggersToGalaxy(xml, options)).output.libraryId).toBe('ONE');
    await expect(convertTriggersToGalaxy(xml, { ...options, limits: { ...options.limits, maxTotalElements: 1 } })).rejects.toThrow('maxTotalElements');
  });

  // Editor output: a variable's explicit script identifier is written as authored (70 of 70 in the
  // corpus packages with Triggers, EditorTest's lv_SoundIndex; 52-OperationBrainstorm's
  // gv_AITargetPlayer), a name with a lower-case initial (2238 of 2238). Restored with its name
  // alone, gv_AITargetPlayer came back as gv_aITargetPlayer in every function that used it.
  it('keeps a variable spelled as its explicit identifier and lowers one spelled as its name', async () => {
    const script = 'int gv_AITargetPlayer;\nint gv_attackWave;\nunitgroup gv_PerditionUnitGroup;\nvoid gf_Run () {\n    int lv_SoundIndex;\n    lv_SoundIndex = (gv_AITargetPlayer + gv_attackWave);\n    gv_PerditionUnitGroup = UnitGroupEmpty();\n}\n';
    const triggerStrings = ['Variable/Name/00000001=AITargetPlayer', 'Variable/Name/00000002=Attack Wave', 'Variable/Name/00000003=SoundIndex',
      'FunctionDef/Name/00000004=Run', 'Variable/Name/00000005=Perdition Unit Group'].join('\n');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script, header: '', triggerStrings });
    expect(reverse.output.triggerData).toContain('<Identifier>AITargetPlayer</Identifier>');
    expect(reverse.output.triggerData).toContain('<Identifier>SoundIndex</Identifier>');
    expect(reverse.output.triggerData).not.toMatch(/<Identifier>attackWave<\/Identifier>/u);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings, ...reverse.output.generationOptions,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program).toContain('int gv_AITargetPlayer;');
    expect(program).toContain('int gv_attackWave;');
    expect(program).toContain('lv_SoundIndex = (gv_AITargetPlayer + gv_attackWave);');
    // UEDFL_EP01M01: an identifier beside a name of other words ("Perdition Unit Group") failed the
    // exact reparse check while the model kept the name as the element's code name.
    expect(program).toContain('gv_PerditionUnitGroup = UnitGroupEmpty();');
    expect(reverse.fidelity.diagnostics.filter((item: any) => item.code === 'ROUNDTRIP_FAILED')).toEqual([]);
  });

  // NydusMod MMR Security: its authors named the elements in Russian, so the editor spelled their identifiers
  // from the ruRU names (hex of their UTF-8); from the enUS strings alone 22 names came back as hex. The
  // names and the texts are now read from every locale the document has, and every locale comes back.
  it('reads names and texts from every locale and writes each locale back', async () => {
    const hex = [...new TextEncoder().encode('Привет')].map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
    const script = [
      'text gv_greeting;', `trigger gt_${hex};`, 'trigger TriggerCreate (string name);', 'text StringExternal (string id);',
      `bool gt_${hex}_Func (bool testConds, bool runActions) {`, '    // Actions', '    if (!runActions) {', '        return true;', '    }',
      '    gv_greeting = StringExternal("Param/Value/1A2B3C4D");', '    return true;', '}',
      `void gt_${hex}_Init () {`, `    gt_${hex} = TriggerCreate("gt_${hex}_Func");`, '}',
    ].join('\n');
    const reverse = await convertGalaxyToTriggers({
      libraryId: 'Map', documentKind: 'map', script, header: '',
      localizedStrings: [
        { locale: 'enUS', triggerStrings: 'Trigger/Name/0A0A0A0A=Hello\nVariable/Name/0B0B0B0B=Greeting', gameStrings: 'Param/Value/1A2B3C4D=Hi there' },
        { locale: 'ruRU', triggerStrings: 'Trigger/Name/0A0A0A0A=Привет\nVariable/Name/0B0B0B0B=Приветствие', gameStrings: 'Param/Value/1A2B3C4D=Здравствуй' },
      ],
    });
    // The files begin with the byte order mark the editor writes.
    const byLocale = Object.fromEntries(reverse.output.localizedStrings.map((item: any) => [item.locale, {
      triggerStrings: item.triggerStrings.replace(/^\ufeff/u, ''), gameStrings: item.gameStrings.replace(/^\ufeff/u, ''),
    }]));
    expect(reverse.output.locale).toBe('enUS');
    expect(byLocale.enUS.triggerStrings).toMatch(/^Trigger\/Name\/\w+=Hello$/mu);
    expect(byLocale.enUS.triggerStrings).toMatch(/^Variable\/Name\/\w+=Greeting$/mu);
    expect(byLocale.enUS.gameStrings).toMatch(/^Param\/Value\/1A2B3C4D=Hi there$/mu);
    expect(byLocale.ruRU.triggerStrings).toMatch(/^Trigger\/Name\/\w+=Привет$/mu);
    expect(byLocale.ruRU.triggerStrings).toMatch(/^Variable\/Name\/\w+=Приветствие$/mu);
    expect(byLocale.ruRU.gameStrings).toMatch(/^Param\/Value\/1A2B3C4D=Здравствуй$/mu);
    // Named "Hello" in the primary locale, the trigger keeps the spelling of its ruRU name as its identifier.
    expect(reverse.output.triggerStrings.replace(/^\ufeff/u, '')).toBe(byLocale.enUS.triggerStrings);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings, gameStrings: reverse.output.gameStrings,
      ...reverse.output.generationOptions,
    });
    expect(forward.output.script).toContain(`bool gt_${hex}_Func (bool testConds, bool runActions)`);
  });

  // Cold expedition: the handle of a hand-written trigger stays a variable spelled `gt_Easy`, without a
  // script prefix. Its name was looked up with `gt_` cut off, found the map's variable "Easy"
  // (`gv_easy`), and 156 uses came back as the undeclared `Easy`.
  it('keeps the whole Galaxy spelling of an element without a script prefix', async () => {
    const script = [
      'trigger gt_Easy;', 'int gv_easy;', 'trigger TriggerCreate (string name);', 'int TriggerGetExecCount (trigger t);',
      'bool gt_Easy_Func (bool testConds, bool runActions) {', '    gv_easy = 1;', '    return true;', '}',
      'void gt_Easy_Init () {', '    gt_Easy = TriggerCreate("gt_Easy_Func");', '}',
      'void gf_Check () {', '    if ((TriggerGetExecCount(gt_Easy) == 1)) {', '        gv_easy = 2;', '    }', '}',
    ].join('\n');
    const triggerStrings = ['Trigger/Name/05ACBF0B=Easy', 'Variable/Name/3EC43992=Easy', 'FunctionDef/Name/00000004=Check'].join('\n');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', script, header: '', triggerStrings });
    expect(reverse.output.triggerData).not.toContain('<Identifier>Easy</Identifier>');
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, {
      libraryId: 'Map', documentKind: 'map', triggerStrings: reverse.output.triggerStrings, ...reverse.output.generationOptions,
    });
    const program = `${forward.output.header}\n${forward.output.script}`;
    expect(program).toMatch(/^trigger gt_Easy;$/mu);
    expect(program).toContain('TriggerGetExecCount(gt_Easy)');
    expect(program).not.toMatch(/\bEasy\b(?!_)/u);
  });

  // Editor output (EditorTest.SC2Mod LibCAI2): a library declares its structures under its own
  // prefix; kept in the structure's name, the prefix came back doubled (libCAI2_gs_LibCAI2_gs_AIData).
  it('names a library structure without the library prefix its Galaxy name carries', async () => {
    const header = 'struct libREFS_gs_AIData { int lv_wave; };\nlibREFS_gs_AIData[16] libREFS_gv_aI;';
    const result = await convertGalaxyToTriggers({ libraryId: 'REFS', header, script: 'void libREFS_gf_Reset(int lp_player) { libREFS_gv_aI[lp_player].lv_wave = 0; }' });
    expect(result.output.triggerData).not.toContain('libREFS_gs_');
    const forward = await convertTriggersToGalaxy(result.output.triggerData, { libraryId: 'REFS', triggerStrings: result.output.triggerStrings, ...result.output.generationOptions });
    expect(forward.output.header).toMatch(/struct libREFS_gs_AIData \{/u);
    expect(forward.output.header).toContain('libREFS_gs_AIData[16] libREFS_gv_aI;');
    expect(forward.fidelity.diagnostics.filter((item: any) => item.code === 'sc2-triggers/galaxy-signature-conflict')).toEqual([]);
  });

  it('converts the formerly unsupported reference parameter as a GUI structure parameter', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'REFS', header: '', script: 'struct Data { int value; }; void Write(structref<Data> data) { data.value = 1; }' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(forward.output.header).toContain('structref<libREFS_gs_Data> lp_data');
    expect(forward.output.script).toContain('lp_data.lv_value = 1');
  });

  it('preserves native handle types through the public round trip', async () => {
    const script = 'soundlink Echo(soundlink input) { return input; }';
    const result = await convertGalaxyToTriggers({ libraryId: 'HANDLES', script, header: '' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(forward.output.script).toContain('soundlink Echo (soundlink');
    expect(forward.fidelity.verification.galaxyValidation.errors).toBe(0);
  });

  it('emits integer preset constants for empty stored values', () => {
    const m = model(), first = m.add('PresetValue', { name: 'First', value: '' });
    m.add('Preset', { name: 'Choices', integer: true, generateConstants: true, baseType: 'int', values: [first] });
    expect(m.emit().header).toMatch(/const int [A-Za-z0-9_]+ = 0;/);
  });

  it('uses ordinal constants for integer presets with stale textual values', () => {
    const m = model();
    const empty = m.add('PresetValue', { name: 'Empty', value: 'Empty' });
    const locked = m.add('PresetValue', { name: 'Locked', value: 'Locked' });
    m.add('Preset', { name: 'State', integer: true, generateConstants: true, baseType: 'int', values: [empty, locked] });
    const header = m.emit().header;
    expect(header).toMatch(/const int [A-Za-z0-9_]+_Empty = 0;/);
    expect(header).toMatch(/const int [A-Za-z0-9_]+_Locked = 1;/);
    expect(header).not.toContain('= "Empty"');
  });

  it('emits disabled integer preset values as minus one without consuming an ordinal', () => {
    const m = model();
    const first = m.add('PresetValue', { name: 'First' });
    const removed = m.add('PresetValue', { name: 'Removed', disabled: true });
    const second = m.add('PresetValue', { name: 'Second' });
    m.add('Preset', { name: 'State', integer: true, generateConstants: true, baseType: 'int', values: [first, removed, second] });
    const header = m.emit().header;
    expect(header).toMatch(/const int [A-Za-z0-9_]+_First = 0;/);
    expect(header).toMatch(/const int [A-Za-z0-9_]+_Removed = -1;/);
    expect(header).toMatch(/const int [A-Za-z0-9_]+_Second = 1;/);
  });

  it('initializes a TriggerData constant handle at runtime as the editor does', () => {
    const m = model();
    const initial = m.add('Param', { scriptCode: 'PlayerGroupAll()', valueType: { type: 'playergroup' } });
    const variable = m.add('Variable', { name: 'allPlayers', variableType: { type: 'playergroup' },
      isConstant: true, initialValue: initial });
    m.library.items.push(variable);
    const output = m.emit();
    expect(output.header).toContain('playergroup libTEST_gv_allPlayers;');
    expect(output.header).not.toContain('const playergroup');
    expect(output.script).toContain('libTEST_gv_allPlayers = PlayerGroupAll();');
  });

  it('does not declare an unused InitGlobals stage for an implicit map without variables', () => {
    const library: any = { id: 'Map', implicit: true, items: [], elements: {}, elementsByType: {} };
    const output = convertTriggerLibraryToGalaxyFull(library);
    expect(output.header).not.toContain('InitGlobals');
    expect(output.script).not.toContain('void InitGlobals');
    expect(output.script).not.toContain('InitGlobals();');
  });

  it('does not infer an identity for an unresolved generic operator type', () => {
    const m = model(), formal = m.formal('value', 'any');
    const operator = m.add('FunctionDef', { name: 'GenericConversion', flags: ['Operator', 'Call'], parameters: [formal], returnType: { type: 'int' } });
    m.run(m.call(operator, { value: '1' }));
    expect(() => m.emit()).toThrow('OPERATOR_TEMPLATE');
  });

  it('erases an empty anypreset adapter when its declared runtime type matches the result', () => {
    const m = model(), formal = m.formal('value', 'anypreset');
    (m.get(formal) as any).paramType.variableType = 'string';
    const operator = m.add('FunctionDef', { name: 'PresetAsString', flags: ['Operator', 'Call'],
      parameters: [formal], returnType: { type: 'string' } });
    const sinkValue = m.formal('value', 'string');
    const sink = m.template('Observe', 'observe(#PARAM(value));', [sinkValue]);
    const adapted = m.call(operator, { value: 'choice' });
    const invocation = m.call(sink);
    m.get(invocation).parameters = [m.add('Param', { parameterDef: sinkValue, functionCall: adapted, valueType: { type: 'string' } })];
    m.run(invocation);
    const output = m.emit();
    expect(output.script).toContain('observe(("choice"));');
    expect(output.script).not.toContain('PresetAsString');
  });

  it('does not treat comments attached to an ordinary user call as executable subfunctions', () => {
    const m = model();
    const callee = m.add('FunctionDef', { name: 'RunTask', flags: ['Action'], parameters: [], actions: [] });
    const invocation = m.call(callee);
    m.get(invocation).subFunctions = [m.add('Comment', { comment: 'Editor parameter note',
      subFunctionType: { type: 'SubFuncType', library: 'Ntve', id: 'COMMENT' } })];
    m.run(invocation);
    expect(m.emit().script).toContain('libTEST_gf_RunTask();');
  });

  it('inlines a concrete unary operator when both loaded Galaxy types are identical', () => {
    const m = model();
    const value = m.formal('value', 'string');
    const returnFormal = m.template('ReturnFormal', 'return #PARAM(value);', [m.formal('value', 'string')]);
    const returnCall = m.call(returnFormal);
    m.get(returnCall).parameters = [m.add('Param', { parameterDef: m.get(returnFormal).parameters[0], scriptCode: 'lp_value' })];
    const adapter = m.add('FunctionDef', { name: 'AdaptString', flags: ['Call', 'Operator'],
      parameters: [value], returnType: { type: 'string' }, actions: [returnCall] });
    const adapted = m.call(adapter, { value: 'abc' });
    const sinkValue = m.formal('value', 'string');
    const sink = m.template('Observe', 'observe(#PARAM(value));', [sinkValue]);
    const invocation = m.call(sink);
    const nested = m.add('Param', { parameterDef: sinkValue, functionCall: adapted, valueType: { type: 'string' } });
    m.get(invocation).parameters = [nested];
    m.run(invocation);
    const output = m.emit();
    // The editor keeps the argument's parentheses: StringToText(("Kicker_Zerg")), StringToText((lp_hybrid)).
    expect(output.script).toContain('observe(("abc"));');
    expect(output.script).not.toContain('libTEST_gf_AdaptString');
    expect(output.header).not.toContain('libTEST_gf_AdaptString');
  });

  it.each([false, true])('distinguishes a native from a same-named wrapper with reordered parameters: %s', reverseOrder => {
    const m = model(), count = m.formal('count', 'int'), enabled = m.formal('enabled', 'bool');
    const native = { name: 'ApplyMode', flags: ['Action', 'Native'], parameters: [count, enabled] };
    const wrapper = { name: 'ApplyMode', flags: ['Action'], parameters: [enabled, count] };
    const refs = (reverseOrder ? [wrapper, native] : [native, wrapper]).map(values => m.add('FunctionDef', values));
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    const functions = buildFuncNameToFuncDefMap(parsed);
    expect(functions.get('ApplyMode')?.id).toBe(refs[reverseOrder ? 1 : 0].id);
    expect(functions.get('ApplyMode')?.parameters).toEqual([count, enabled]);
    expect(functions.get('libTEST_gf_ApplyMode')?.id).toBe(refs[reverseOrder ? 0 : 1].id);
    expect(functions.get('libTEST_gf_ApplyMode')?.parameters).toEqual([enabled, count]);
  });

  it.each(['Map', 'Utility'])('preserves global callback names and startup references when exporting the library %s', async libraryId => {
    const script = `trigger gt_Ready;
bool gt_Ready_Func(bool testConds, bool runActions) {
  if (!runActions) { return true; }
  return true;
}
void gt_Ready_Init() { gt_Ready = TriggerCreate("gt_Ready_Func"); }
void Launch() { gt_Ready_Init(); TriggerExecute(gt_Ready, true, false); }`;
    const reversed = await convertGalaxyToTriggers({ libraryId, script, header: '', entryPoint: 'Launch',
      galaxyDeclarations: [{ fileName: 'api.galaxy', text: 'native trigger TriggerCreate(string callback); native void TriggerExecute(trigger value, bool check, bool wait);' }] });
    expect(reversed.fidelity.verification.galaxyValidation.lostSourceBindings).toEqual([]);
    expect(reversed.fidelity.verification.galaxyValidation.errors).toBe(0);
    const output = await convertTriggersToGalaxy(reversed.output.triggerData, { libraryId, ...reversed.output.generationOptions });
    expect(output.output.script).toContain('void gt_Ready_Init ()');
    expect(output.output.script).toContain('gt_Ready_Init();');
    expect(output.output.script).toContain('TriggerCreate("gt_Ready_Func")');
    const library = parseTriggerXmlSync(reversed.output.triggerData).get(libraryId)!;
    expect(Object.values(library.elements).some((element: any) => element.type === 'CustomScript' || element.flags?.includes('CustomScript'))).toBe(false);
  });

  it.each(['0', '1.5'])('rejects an unrepresentable array length instead of silently changing it: %s', length => {
    return expect(convertGalaxyToTriggers({ libraryId: 'TEST', script: `void Run() { const int capacity = 7; int[${length}] values; }`, header: '' }))
      .rejects.toMatchObject({ context: { conversionCode: 'ARRAY_DIMENSION' } });
  });

  it.each([['capacity', '6'], ['capacity * 2', '13']])('folds a local constant length without growing the array: %s', async (length, upperBound) => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: `void Run() { const int capacity = 7; int[${length}] values; }`, header: '' });
    const parsed = parseTriggerXmlSync(result.output.triggerData).get('TEST')!;
    const array = Object.values(parsed.elementsByType.Variable).find(variable => variable.isArray)!;
    expect(array.arraySizes).toEqual([{ dim: 0, value: upperBound }]);
  });

  it('roundtrips empty strings, single indexes and symbolic local array dimensions through the public XML check', async () => {
    const script = 'void Run() { const int capacity = 7; string[capacity + 1][2] values; values[2][1] = ""; observe(values[2][1]); }';
    const reversed = await convertGalaxyToTriggers({ libraryId: 'TEST', script, header: '' });
    expect(reversed.fidelity.verification.semanticModelExact).toBe(true);
    const emitted = await convertTriggersToGalaxy(reversed.output.triggerData, { libraryId: 'TEST' });
    expect(parseGalaxySource(emitted.output.script).parseDiagnostics).toEqual([]);
    expect(emitted.output.script).toMatch(/const int (\w+) = 7;/u);
    const constant = /const int (\w+) = 7;/u.exec(emitted.output.script)![1];
    expect(emitted.output.script).toContain(`string[${constant} + 1][2]`);
    expect(emitted.output.script).toContain('= "";');
    expect(emitted.output.script).not.toContain('[]');
    const parsed = parseTriggerXmlSync(reversed.output.triggerData).get('TEST')!;
    expect(Object.values(parsed.elements).some((element: any) => element.type === 'Variable' && element.isArray && element.arraySizes.length === 2)).toBe(true);
  });

  it.each(['actor', 'actorscope', 'bitmask', 'bank', 'unitgroup'])('keeps the grammar-defined type %s', async type => {
    const reversed = await convertGalaxyToTriggers({ libraryId: 'TEST', script: `${type} identity(${type} input) { return input; }`, header: '' });
    const output = await convertTriggersToGalaxy(reversed.output.triggerData, { libraryId: 'TEST' });
    expect(output.output.script).toContain(`${type} identity (${type} lp_input)`);
    expect(output.output.header).toContain(`${type} identity (${type} lp_input)`);
  });

  it('preserves authored comments, including their roles and text, through XML and Galaxy', async () => {
    const m = model(), body = m.role('body');
    const comment = m.add('Comment', { comment: 'A comment\nwith a second line', subFunctionType: body });
    const action = m.template('Group', '{ #SUBFUNCS(body) }', [], [body]);
    m.run(m.call(action, {}, [comment]));
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    expect(parsed.elementsByType.Comment?.[comment.id]).toMatchObject({ comment: 'A comment\nwith a second line', subFunctionType: body });
    const output = m.emit();
    expect(output.script).toContain('// A comment');
    expect(output.script).toContain('// with a second line');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', ...output });
    expect(reverse.output.triggerData).toContain('with a second line');
  });

  it.each([false, true])('expands optional branches based on active subfunctions: %s', present => {
    const m = model(), yes = m.role('yes'), no = m.role('no');
    const branch = m.template('ArbitraryBranch', 'if (true) { #SUBFUNCS(yes) } #IFHAVESUBFUNCS(no,else {) #SUBFUNCS(no) #IFHAVESUBFUNCS(no,})', [], [yes, no]);
    const marker = m.template('Marker', 'mark();');
    const children = [m.call(marker, {}, [], yes)];
    if (present) children.push(m.call(marker, {}, [], no));
    else children.push(m.add('Comment', { comment: 'Not executable', subFunctionType: no }));
    m.run(m.call(branch, {}, children));
    const { script } = m.emit();
    expect(script.includes('else')).toBe(present);
  });

  it('joins conditional subfunctions before parsing and does not count comments or disabled cases as executable siblings', () => {
    const m = model(), cases = m.role('cases'), value = m.formal('value', 'int');
    const branch = m.template('Case', '#IFSUBFUNC(notfirst,else )if (#PARAM(value) == 1) { mark(); }', [value]);
    const group = m.template('Cases', '#SUBFUNCS(cases)', [], [cases]);
    const disabled = m.call(branch, { value: '0' }, [], cases);
    m.get(disabled).disabled = true;
    const children = [disabled, m.add('Comment', { comment: 'First', subFunctionType: cases }), m.call(branch, { value: '1' }, [], cases),
      m.add('Comment', { comment: 'Second', subFunctionType: cases }), m.call(branch, { value: '2' }, [], cases)];
    m.run(m.call(group, {}, children));
    const { script } = m.emit();
    expect(script.match(/else/gu)).toHaveLength(1);
    expect(script).not.toContain('elseif');
    expect(script).not.toContain('0 == 1');
  });

  it.each(['UnrelatedContainerName', 'SequenceOfCases'])('derives an implicit chain from the constrained child template: %s', name => {
    const m = model(), cases = m.role('choices'), value = m.formal('choice', 'int');
    const branch = m.template('UnrelatedChildName', '#IFSUBFUNC(notfirst,else )if (#PARAM(choice) == 1) { mark(); }', [value]);
    m.get(cases).functionDef = branch;
    const group = m.add('FunctionDef', { name, flags: ['Action', 'SubFunctions'], parameters: [], subFunctionTypes: [cases] });
    const disabled = m.call(branch, { choice: '0' }, [], cases);
    m.get(disabled).disabled = true;
    m.run(m.call(group, {}, [disabled, m.call(branch, { choice: '1' }, [], cases),
      m.add('Comment', { comment: 'Between branches', subFunctionType: cases }), m.call(branch, { choice: '2' }, [], cases)]));
    const parsed = parseTriggerXmlSync(m.xml()).get('TEST')!;
    expect(parsed.elementsByType.SubFuncType?.[cases.id]).toMatchObject({ functionDef: branch });
    const { script } = m.emit();
    const run = [...parseGalaxySource(script).statements].find((node: any) => node.name?.name === 'Run' && node.body) as any;
    expect(run.body.statements).toHaveLength(1);
    expect(run.body.statements[0].elseStatement).toBeDefined();
    expect(script.match(/else/gu)).toHaveLength(1);
    expect(script).toContain('// Between branches');
    expect(script).not.toContain('0 == 1');
  });

  it.each([['&&', 'true'], ['||', 'false']])('uses the neutral condition for an empty %s expression group', (operator, expected) => {
    const m = model(), conditions = m.role('conditions', false);
    const branch = m.template('Branch', `if (#SUBFUNCS(conditions," ${operator} ")) { mark(); }`, [], [conditions]);
    m.run(m.call(branch));
    expect(m.emit().script).toContain(`if (${expected})`);
  });

  it('expands an implicit chain with comments inside another template before syntax validation', () => {
    const m = model(), cases = m.role('cases'), body = m.role('body');
    const branch = m.template('Child', '#IFSUBFUNC(notfirst,else )if (true) { mark(); }');
    m.get(cases).functionDef = branch;
    const group = m.add('FunctionDef', { name: 'Container', flags: ['Action', 'SubFunctions'], parameters: [], subFunctionTypes: [cases] });
    const outer = m.template('Outer', 'while (true) { #SUBFUNCS(body) }', [], [body]);
    const inner = m.call(group, {}, [m.call(branch, {}, [], cases), m.add('Comment', { comment: 'Nested comment', subFunctionType: cases })], body);
    m.run(m.call(outer, {}, [inner]));
    const { script } = m.emit();
    expect(script).toContain('// Nested comment');
    expect(script).toContain('while (true)');
    expect(script).not.toContain('__mx_raw_script');
  });

  it.each(['unconstrained', 'ordinary-child', 'parameters', 'body'])('does not flatten an unproven implicit container: %s', variant => {
    const m = model(), cases = m.role('choices'), value = m.formal('choice', 'int');
    const code = variant === 'ordinary-child' ? 'mark();' : '#IFSUBFUNC(notfirst,else )if (true) { mark(); }';
    const branch = m.template('Child', code);
    if (variant !== 'unconstrained') m.get(cases).functionDef = branch;
    const group = m.add('FunctionDef', { name: 'Container', flags: ['Action', 'SubFunctions'],
      parameters: variant === 'parameters' ? [value] : [], subFunctionTypes: [cases],
      ...(variant === 'body' ? { actions: [m.call(branch)] } : {}) });
    m.run(m.call(group, { choice: '1' }, [m.call(branch, {}, [], cases)]));
    expect(() => m.emit()).toThrow('UNSUPPORTED_TEMPLATE');
  });

  it('rejects a child that violates the loaded role constraint', () => {
    const m = model(), cases = m.role('choices');
    const branch = m.template('Child', '#IFSUBFUNC(notfirst,else )if (true) { mark(); }');
    m.get(cases).functionDef = branch;
    const group = m.add('FunctionDef', { name: 'Container', flags: ['Action', 'SubFunctions'], parameters: [], subFunctionTypes: [cases] });
    const other = m.template('Other', 'mark();');
    m.run(m.call(group, {}, [m.call(other, {}, [], cases)]));
    expect(() => m.emit()).toThrow('TEMPLATE_SUBFUNCTION_DEFINITION');
  });

  it('gives nested initialized and inferred auto-variables independent storage', () => {
    const m = model(), count = m.formal('count', 'int'), body = m.role('body');
    const loop = m.template('LoopWithAnyName', '#INITAUTOVAR(limit,count) for (#AUTOVAR(index)=1; #AUTOVAR(index)<=#AUTOVAR(limit); #AUTOVAR(index)+=1) { #SUBFUNCS(body) }', [count], [body]);
    const inner = m.call(loop, { count: '2' }), outer = m.call(loop, { count: '3' }, [inner]);
    m.run(outer);
    const { script } = m.emit();
    for (const ref of [inner, outer]) {
      expect(script).toContain(`int auto${ref.id}_index;`);
      expect(script).toContain(`const int auto${ref.id}_limit = ${ref === inner ? 2 : 3};`);
    }
    expect(script).not.toMatch(new RegExp(`\\n\\s*auto${inner.id}_limit = 2;`));
    expect(script).not.toMatch(new RegExp(`\\n\\s*auto${outer.id}_limit = 3;`));
  });

  it('infers a temporary type from a loaded native declaration', () => {
    const m = model();
    m.add('FunctionDef', { name: 'CountThings', flags: ['Native', 'Call'], parameters: [], returnType: { type: 'int' } });
    const template = m.template('CountTemplate', '#AUTOVAR(total)=CountThings(); observe(#AUTOVAR(total));');
    const call = m.call(template); m.run(call);
    expect(m.emit().script).toContain(`int auto${call.id}_total;`);
  });

  it('selects ancestor scope by the identifier supplied by the loaded macro', () => {
    const m = model(), body = m.role('body');
    const outer = m.template('ContainerChosenByAuthor', '#AUTOVAR(value,int)=1; #SUBFUNCS(body)', [], [body]);
    const middle = m.template('Nested', '#AUTOVAR(value,int)=2; #SUBFUNCS(body)', [], [body]);
    const use = m.template('Use', 'observe(#AUTOVAR(value,parent),#AUTOVAR(value,ancestor:ContainerChosenByAuthor));');
    const middleCall = m.call(middle, {}, [m.call(use)]), outerCall = m.call(outer, {}, [middleCall]);
    m.run(outerCall);
    expect(m.emit().script).toContain(`observe(auto${middleCall.id}_value, auto${outerCall.id}_value);`);
  });

  it('preserves top-level custom code and invokes its declared initializers in authored order', async () => {
    const m = model();
    const first = m.add('CustomScript', { scriptCode: '// keep this\nvoid StartFirst(){ one(); }', initFunc: 'StartFirst' });
    const second = m.add('CustomScript', { scriptCode: 'void StartSecond(){ two(); }', initFunc: 'StartSecond' });
    const disabled = m.add('CustomScript', { disabled: true, scriptCode: 'void Disabled(){ bad(); }', initFunc: 'Disabled' });
    m.library.items = [m.add('Category', { name: 'Scripts', items: [second, first, disabled] })];
    const output = await convertTriggersToGalaxy(m.xml(), { libraryId: 'TEST' });
    expect(output.output.script).toContain('// keep this');
    expect(output.output.script).not.toContain('bad()');
    expect(output.output.script).toContain('StartSecond();\n    StartFirst();');
    // A library without triggers has no trigger stage (editor oracle: VictorMod
    // Lib97C4C1F1 calls InitLibraries and InitCustomScript alone).
    expect(output.output.script).toMatch(/libTEST_InitLibraries\(\);\s*libTEST_InitCustomScript\(\);\s*\}/u);
    expect(output.output.script).not.toContain('libTEST_InitTriggers');
    expect(output.fidelity.unsupported.count).toBe(0);
  });

  it('emits and invokes the editor custom-script aggregate even without an InitFunc', () => {
    const m = model();
    m.library.items = [m.add('CustomScript', { scriptCode: 'include "TriggerLibs/AI"' })];
    const script = m.emit().script;
    expect(script).toMatch(/void libTEST_InitCustomScript \(\)\s*\{\s*\}/u);
    expect(script).toMatch(/libTEST_InitLibraries\(\);\s*libTEST_InitCustomScript\(\);\s*\}/u);
    expect(script).not.toContain('libTEST_InitTriggers');
  });

  it('emits the editor preset identifier helper from PresetGenIdentFunc', () => {
    const m = model();
    const yellow = m.add('PresetValue', { name: 'Yellow' });
    const red = m.add('PresetValue', { name: 'Red' });
    m.library.items = [m.add('Preset', { name: 'Thresholds', integer: true, generateConstants: true,
      generateIdentifier: true, baseType: 'int', values: [yellow, red] })];
    expect(m.xml()).toContain('<PresetGenIdentFunc/>');
    const output = m.emit();
    expect(output.header).toContain('string libTEST_ge_Thresholds_Ident (int lp_val);');
    expect(output.script).toContain('string libTEST_ge_Thresholds_Ident (int lp_val)');
    expect(output.script).toContain('return "Yellow";');
    expect(output.script).toContain('return "Red";');
  });

  it('expands PRESETIDENT through the generated helper for the actual preset type', () => {
    const m = model();
    const yellow = m.add('PresetValue', { name: 'Yellow' });
    const thresholds = m.add('Preset', { name: 'Thresholds', integer: true, generateConstants: true,
      generateIdentifier: true, baseType: 'int', values: [yellow] });
    const anyPreset = m.formal('value', 'anypreset');
    const toIdentifier = m.template('ConvertPresetToIdentifier', '#PRESETIDENT(value)', [anyPreset], [], 'string');
    const presetArgument = m.add('Param', { parameterDef: anyPreset, preset: yellow });
    const conversion = m.add('FunctionCall', { functionDef: toIdentifier, parameters: [presetArgument] });
    const text = m.formal('text', 'string');
    const consume = m.add('FunctionDef', { name: 'Consume', flags: ['Native', 'Action'], parameters: [text] });
    const convertedArgument = m.add('Param', { parameterDef: text, functionCall: conversion });
    m.run(m.add('FunctionCall', { functionDef: consume, parameters: [convertedArgument] }));
    m.library.items.unshift(thresholds);

    const script = m.emit().script;
    expect(script).toContain('Consume(libTEST_ge_Thresholds_Ident(libTEST_ge_Thresholds_Yellow));');
  });

  it('avoids generated startup name collisions with raw top-level declarations', () => {
    const m = model();
    m.library.items = [m.add('CustomScript', { scriptCode: 'void libTEST_InitCustomScript() {}', initFunc: 'libTEST_InitCustomScript' })];
    const { script } = m.emit();
    expect(script).toContain('void libTEST_InitCustomScript_1 ()');
    expect(script.match(/void libTEST_InitCustomScript\(/gu)).toHaveLength(1);
  });

  it.each(['Comparison', 'NameChosenByPlugin', 'Unrelated'])('derives a binary operator from ordered declarations and Preset tokens, independent of name %s', name => {
    const m = model();
    const token = m.add('PresetValue', { name: 'LessOrEqual', value: '<=' });
    const preset = m.add('Preset', { name: 'Operators', baseType: 'int', values: [token] });
    const left = m.formal('first', 'int'), operator = m.formal('middle', 'preset'), right = m.formal('last', 'int');
    m.get(operator).paramType.typeElement = preset;
    const binary = m.add('FunctionDef', { name, parameters: [left, operator, right], returnType: { type: 'bool' }, flags: ['Operator'] });
    const expression = m.call(binary, { first: '2', last: '4' });
    const actual = m.get(m.get(expression).parameters[1]);
    actual.preset = token; delete actual.value;
    const input = m.formal('value', 'bool'), observe = m.template('Use', 'observe(#PARAM(value));', [input]);
    const invocation = m.call(observe);
    m.get(m.get(invocation).parameters[0]).functionCall = expression;
    m.run(invocation);
    const { script } = m.emit();
    expect(script).toContain('observe((2 <= 4));');
    expect(script).not.toContain(`${name}(2,`);
  });

  it('generates preset constants from their declared order and uses qualified symbols instead of raw IDs', () => {
    const m = model(), first = m.add('PresetValue', { name: 'First' }), second = m.add('PresetValue', { name: 'Second' });
    const preset = m.add('Preset', { name: 'Options', baseType: 'int', generateConstants: true, values: [first, second] });
    const input = m.formal('value', 'preset'); m.get(input).paramType.typeElement = preset;
    const observe = m.template('Use', 'observe(#PARAM(value));', [input]), invocation = m.call(observe);
    m.get(m.get(invocation).parameters[0]).preset = second;
    m.run(invocation);
    const { script, header } = m.emit();
    expect(header).toContain('const int libTEST_ge_Options_First = 0;');
    expect(header).toContain('const int libTEST_ge_Options_Second = 1;');
    expect(script).toContain('observe(libTEST_ge_Options_Second);');
  });

  // Ice Baneling: six integer presets extend one library preset (PresetExtends); the editor numbers
  // each of them from 10000, while a preset without the extension keeps 0-based ordinals.
  it('numbers an integer preset that extends another preset from 10000 through XML', () => {
    const m = model(), first = m.add('PresetValue', { name: 'First' }), second = m.add('PresetValue', { name: 'Second' });
    const base = m.add('Preset', { name: 'Objects', baseType: 'int', values: [] });
    m.add('Preset', { name: 'Zealots', baseType: 'int', integer: true, generateConstants: true, extends: base, values: [first, second] });
    expect(m.xml()).toContain(`<PresetExtends Type="Preset" Library="TEST" Id="${base.id}"/>`);
    const { header } = m.emit();
    expect(header).toContain('const int libTEST_ge_Zealots_First = 10000;');
    expect(header).toContain('const int libTEST_ge_Zealots_Second = 10001;');
  });

  it('retains complete identifiers for bodyless declarations with editor-like prefixes', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'void invoke(){ libTEST_gf_External(); }', header: 'void libTEST_gf_External();' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, {});
    expect(forward.output.header).toContain('void libTEST_gf_External ();');
    expect(forward.output.script).toContain('libTEST_gf_External();');
  });

  it('closes cross-library references against reconstructed identities on a second pass', async () => {
    const oldDependency = `<TriggerData><Library Id="A">
      <Element Type="ParamDef" Id="0A0A0A01"><Identifier>value</Identifier><ParameterType><Type Value="int"/></ParameterType></Element>
      <Element Type="FunctionDef" Id="0A0A0A02"><Identifier>Target</Identifier><FlagAction/><Parameter Type="ParamDef" Library="A" Id="0A0A0A01"/></Element>
    </Library></TriggerData>`;
    const a = await convertGalaxyToTriggers({
      libraryId: 'A', header: '', script: 'void libA_gf_Target(int lp_value) {}', verification: 'semantic',
    });
    const firstB = await convertGalaxyToTriggers({
      libraryId: 'B', header: '', script: 'void libB_gf_Run() { libA_gf_Target(7); }', verification: 'semantic',
      dependencyLibraries: [{ triggerData: oldDependency }],
    });
    const secondB = await convertGalaxyToTriggers({
      libraryId: 'B', header: '', script: 'void libB_gf_Run() { libA_gf_Target(7); }', verification: 'semantic',
      dependencyLibraries: [{ triggerData: a.output.triggerData, triggerStrings: a.output.triggerStrings }],
    });
    const aLibrary = parseTriggerXmlSync(a.output.triggerData).get('A')!;
    const firstBLibrary = parseTriggerXmlSync(firstB.output.triggerData).get('B')!;
    const secondBLibrary = parseTriggerXmlSync(secondB.output.triggerData).get('B')!;
    const calledDefinition = (library: TriggerLibraryJson) => Object.values(library.elements)
      .find((element: any) => element.type === 'FunctionCall' && element.functionDef?.library === 'A') as any;
    const rebuiltTarget = Object.values(aLibrary.elements)
      .find((element: any) => element.type === 'FunctionDef' && element.name === 'Target') as any;

    expect(calledDefinition(firstBLibrary).functionDef.id).toBe('0A0A0A02');
    expect(calledDefinition(secondBLibrary).functionDef.id).toBe(rebuiltTarget.id);
    expect(rebuiltTarget.id).not.toBe('0A0A0A02');
    expect(validateLibraryStructure([aLibrary, secondBLibrary], { skipOrphanCheck: true })
      .filter(finding => finding.code === 'E_BAD_REF')).toEqual([]);
  });

  it('resolves generated presets from a dependency in both direct and nested calls', async () => {
    const dep = model(), option = dep.add('PresetValue', { name: 'Enabled' });
    const preset = dep.add('Preset', { name: 'Options', baseType: 'int', generateConstants: true, values: [option] });
    const formal = dep.formal('choice', 'preset'); dep.get(formal).paramType.typeElement = preset;
    const query = dep.add('FunctionDef', { name: 'ReadOption', parameters: [formal], returnType: { type: 'bool' }, flags: ['Native', 'Call'] });
    const primary = `<TriggerData><Library Id="MAIN">
      <Element Type="FunctionDef" Id="RUN"><Identifier>Run</Identifier><FlagAction/><Action Type="FunctionCall" Library="MAIN" Id="NESTED"/><Action Type="FunctionCall" Library="MAIN" Id="QUERY"/></Element>
      <Element Type="FunctionDef" Id="OBSERVE"><Identifier>Observe</Identifier><FlagAction/><FlagTemplate/><ScriptCode>observe(#PARAM(input));</ScriptCode><Parameter Type="ParamDef" Library="MAIN" Id="INPUT"/></Element>
      <Element Type="ParamDef" Id="INPUT"><Identifier>input</Identifier><ParameterType><Type Value="bool"/></ParameterType></Element>
      <Element Type="FunctionCall" Id="NESTED"><FunctionDef Type="FunctionDef" Library="MAIN" Id="OBSERVE"/><Parameter Type="Param" Library="MAIN" Id="ARG"/></Element>
      <Element Type="Param" Id="ARG"><ParameterDef Type="ParamDef" Library="MAIN" Id="INPUT"/><FunctionCall Type="FunctionCall" Library="MAIN" Id="QUERY"/></Element>
      <Element Type="FunctionCall" Id="QUERY"><FunctionDef Type="FunctionDef" Library="TEST" Id="${query.id}"/><Parameter Type="Param" Library="MAIN" Id="CHOICE"/></Element>
      <Element Type="Param" Id="CHOICE"><ParameterDef Type="ParamDef" Library="TEST" Id="${formal.id}"/><Preset Type="PresetValue" Library="TEST" Id="${option.id}"/></Element>
    </Library></TriggerData>`;
    const result = await convertTriggersToGalaxy(primary, { libraryId: 'MAIN', dependencyLibraries: [{ triggerData: dep.xml() }] });
    expect(result.output.script).toContain('observe(ReadOption(libTEST_ge_Options_Enabled));');
    expect(result.output.script).toContain('\n    ReadOption(libTEST_ge_Options_Enabled);');
  });

  it('rejects a valueless preset instead of emitting its XML identity as Galaxy code', async () => {
    const m = model(), value = m.add('PresetValue', { name: 'Missing' });
    m.add('Preset', { name: 'Options', baseType: 'int', values: [value] });
    const input = m.formal('value', 'int'), observe = m.template('Observe', 'observe(#PARAM(value));', [input]);
    const call = m.call(observe); m.get(m.get(call).parameters[0]).preset = value; m.run(call);
    await expect(convertTriggersToGalaxy(m.xml(), {})).rejects.toMatchObject({ context: { conversionCode: 'PRESET_VALUE' } });
  });

  it('uses an explicitly declared preset scalar without requiring a generated dependency alias', () => {
    const m = model(), value = m.add('PresetValue', { name: 'Enabled', value: 'true' });
    m.add('Preset', { name: 'Options', baseType: 'bool', generateConstants: true, values: [value] });
    const input = m.formal('value', 'bool'), observe = m.template('Observe', 'observe(#PARAM(value));', [input]);
    const call = m.call(observe); m.get(m.get(call).parameters[0]).preset = value; m.run(call);
    const output = m.emit();
    expect(output.header).toContain('const bool libTEST_ge_Options_Enabled = true;');
    expect(output.script).toContain('observe(libTEST_ge_Options_Enabled);');
  });

  it('does not let editor-only operators shadow a callable native with the same identifier', () => {
    const m = model();
    const native = m.add('FunctionDef', { name: 'ConvertValue', flags: ['Native', 'Call'], parameters: [], returnType: { type: 'text' } });
    m.add('FunctionDef', { name: 'ConvertValue', flags: ['Operator', 'Call'], parameters: [], returnType: { type: 'actormsg' } });
    const library = parseTriggerXmlSync(m.xml()).get('TEST')!;
    expect(buildFuncNameToFuncDefMap(library).get('ConvertValue')?.id).toBe(native.id);
  });

  it('keeps an existing custom-script action inside a structured macro body', () => {
    const m = model(), body = m.role('body');
    const group = m.template('Group', 'if (true) { #SUBFUNCS(body) }', [], [body]);
    const custom = m.add('FunctionDef', { name: 'Raw', flags: ['Action', 'CustomScript'], parameters: [] });
    const action = m.add('FunctionCall', { functionDef: custom, scriptCode: 'if (ready()) { perform(); }' });
    m.run(m.call(group, {}, [action]));
    const { script } = m.emit();
    expect(script).toContain('ready()');
    expect(script).toContain('perform();');
    expect(script).not.toContain('__mx_raw_script');
  });
});


describe('compound values and declared reference types', () => {
  it.each(['-;Missile,Dead,Hidden', 'Biological;Structure', '-;-', 'NewEngineFlag;FutureExclusion'])('delegates filter names to the engine: %s', value => {
    expect(printNode(convertParamExpr({ type: 'Param', id: 'arbitrary', valueType: { type: 'unitfilter' }, value }, {} as any))).toBe(`UnitFilterStr("${value}")`);
  });
  it.each(['0', '1', '2'])('uses the command ID independently of selector category %s', valueTypeInfo => {
    expect(printNode(convertParamExpr({ type: 'Param', id: 'arbitrary', valueType: { type: 'abilcmd' }, value: 'AuthoredAbility', valueId: '7', valueTypeInfo }, {} as any))).toBe('AbilityCommand("AuthoredAbility", 7)');
    expect(printNode(convertParamExpr({ type: 'Param', id: 'arbitrary', valueType: { type: 'abilcmd' }, value: 'AuthoredAbility', valueTypeInfo }, {} as any))).toBe('AbilityCommand("AuthoredAbility", 0)');
  });
  it.each(['1', '3', '5', '7'])('keeps the path for editor resource category %s', valueTypeInfo => {
    expect(printNode(convertParamExpr({ type: 'Param', id: 'arbitrary', valueType: { type: 'filepath' }, value: 'custom/path.asset', valueTypeInfo }, {} as any))).toBe('"custom/path.asset"');
  });
  it('preserves arbitrary numeric filter expressions through a structured roundtrip', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: 'unitfilter Make(int authored){ return UnitFilter(2 << authored, 0x1234, 17, -1); }', header: 'native unitfilter UnitFilter(int a, int b, int c, int d);' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(forward.output.script).toContain('UnitFilter(2 << lp_authored, 4660, 17, -1)');
    expect(result.output.triggerData).not.toContain('FlagCustomScript');
    expect(forward.fidelity.verification.galaxyValidation.errors).toBe(0);
  });
  it.each(['structref<Data>', 'Alias'])('resolves parameter %s and preserves writes through its reference', async parameterType => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', header: 'struct Data { int value; }; typedef structref<Data> Base; typedef Base Alias;', script: `void Change(${parameterType} destination) { destination.value += 1; } Data original; void Run(){ Change(original); }` });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(forward.output.header).toContain('structref<libTEST_gs_Data> lp_destination');
    expect(forward.output.header).toContain('libTEST_gs_Data original;');
    expect(forward.output.script).toContain('lp_destination.lv_value += 1');
    expect(result.output.triggerData).not.toContain('FlagCustomScript');
    expect(forward.fidelity.verification.galaxyValidation.errors).toBe(0);
  });
  it('resolves structures declared after a function prototype and nested members', async () => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', header: 'void Change(structref<Outer> target); struct Outer { Inner nested; }; struct Inner { int value; };', script: 'void Change(structref<Outer> target){ target.nested.value = 4; }' });
    const forward = await convertTriggersToGalaxy(result.output.triggerData, result.output.generationOptions);
    expect(forward.output.script).toContain('lp_target.lv_nested.lv_value = 4');
    expect(forward.fidelity.verification.galaxyValidation.errors).toBe(0);
  });
  it('rejects a cyclic typedef instead of silently using int', async () => {
    await expect(convertGalaxyToTriggers({ libraryId: 'TEST', header: 'typedef B A; typedef A B;', script: 'void Run(){}' })).rejects.toThrow('Cyclic typedef');
  });
  it('does not silently turn a reference variable into value storage', async () => {
    await expect(convertGalaxyToTriggers({ libraryId: 'TEST', header: 'struct Data { int value; };', script: 'structref<Data> reference; void Run(){}' })).rejects.toThrow('Structure references require');
  });
});


describe('reference type validation', () => {
  it('keeps conversion validation aligned with core control-flow and logical-operand rules', () => {
    const validate = (text: string) => validateGalaxyPair([{ fileName: 'custom.galaxy', text }]);
    for (const text of [
      'bool f() { return 1 && 2; }',
      'void f() { break; }',
      'int f() { int x = 1; }',
      'int f() { return "changed"; }',
    ]) expect(validate(text).verification.status).toBe('failed');

    // The language core permits comparison of booleans; do not reject a valid
    // expression merely because conversion validation is intentionally small.
    expect(validate('bool f() { return true < false; }').verification.status).toBe('passed');
    expect(validate('void f() { while (true) { break; continue; } }').verification.status).toBe('passed');
  });

  it('rejects a value structure parameter instead of changing calling semantics', async () => {
    await expect(convertGalaxyToTriggers({ libraryId: 'TEST', header: '', script: 'struct Data { int value; }; void Change(Data value) { value.value = 2; }' })).rejects.toThrow('cannot be silently changed');
  });
  it('checks field writes and incompatible referenced structures through aliases', () => {
    const result = validateGalaxyPair([{ fileName: 'custom.galaxy', text: 'struct A { int field; }; struct B { int field; }; typedef structref<A> Ref; void Change(Ref arg){ arg.field = "wrong"; } B other; void Run(){ Change(other); }' }]);
    expect(result.diagnostics.filter(d => d.code === 'sc2-triggers/galaxy-type-mismatch')).toHaveLength(2);
  });
  it('diagnoses conflicting type aliases', () => {
    expect(() => validateGalaxyPair([{ fileName: 'custom.galaxy', text: 'typedef int Alias; typedef string Alias; void Run(){}' }])).toThrow('Conflicting typedef');
  });
});
describe('preset value metadata', () => {
  it('preserves DefinesDefault through parse and serialization', () => {
    const source = '<TriggerData><Library Id="TEST"><Element Type="PresetValue" Id="00000001"><DefinesDefault/><Value>c_invalidHandle</Value></Element></Library></TriggerData>';
    const parsed = parseTriggerXmlSync(source).get('TEST')!;
    expect(parsed.elementsByType.PresetValue['00000001'].definesDefault).toBe(true);
    expect(serializeTriggerLibrary(parsed)).toContain('<DefinesDefault/>');
  });
});

// EditorTest.SC2Map: a lone `;` after an if/else in an old Pick Each Player loop was a Custom Script
// action each time (161). It does nothing, so it becomes nothing.
describe('empty statements', () => {
  it('writes no action for a lone semicolon', async () => {
    const script = 'int gv_n;\nvoid gf_Count (int lp_x) {\n    if (lp_x > 0) {\n        gv_n = 1;\n    }\n    ;\n    gv_n = 2;\n}\n';
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', verification: 'semantic', script, header: '' });
    expect(reverse.output.triggerData).not.toMatch(/<ScriptCode>\s*;\s*<\/ScriptCode>/u);
  });
});

// AerialEvacuation's Triggers holds 161 Comment actions; the editor writes each as `// text` where it
// stands, and the conversion used to drop them all.
describe('comment actions', () => {
  it('reads the comments among statements back as Comment actions and writes them in place', async () => {
    const script = [
      'int gv_n;', '',
      'void gf_Count (int lp_x) {', '    // Implementation',
      '    // Count up the value', '    // in two lines', '    gv_n = 1;',
      '    if ((lp_x > 0)) {', '        // nested note', '        gv_n = 2;', '    }', '',
      '    // at the end', '}', '',
    ].join('\n');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', verification: 'semantic', script, header: '' });
    const comments = [...reverse.output.triggerData.matchAll(/<Comment>([\s\S]*?)<\/Comment>/gu)].map(match => match[1]);
    expect(comments).toEqual(['Count up the value\nin two lines', 'nested note', 'at the end']);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map', ...reverse.output.generationOptions });
    expect(forward.output.script).toContain('    // Implementation\n    // Count up the value\n    // in two lines\n    gv_n = 1;');
    expect(forward.output.script).toMatch(/\n    \/\/ at the end\n\}/u);
  });

  it('keeps the indentation of an If Then Else whose branch holds a comment', async () => {
    // The branch is written from the If Then Else ScriptCode as text; its tabs broke every line after the first (traynor01).
    const script = [
      'bool gv_a;', 'bool gv_b;', '',
      'void gf_Branch () {', '    // Implementation',
      '    if ((gv_a == true)) {', '        gv_b = true;', '        // a note', '        gv_a = false;', '    }',
      '    else {', '        gv_b = false;', '    }', '}', '',
    ].join('\n');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', verification: 'semantic', script, header: '' });
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map', ...reverse.output.generationOptions });
    expect(forward.output.script).toContain('    if ((gv_a == true)) {\n        gv_b = true;\n        // a note\n        gv_a = false;\n    }');
    expect(forward.output.script).not.toMatch(/\t|\n\s*\n\s*\/\/ a note/u);
  });

  it('writes a comment inside a statement group once, where it stands', async () => {
    // TriggerQueueEnter … TriggerQueueExit is read as a group, and the list around it wrote its comments again (traynor01).
    const script = [
      'int gv_n;', 'trigger gt_T;', '',
      'bool gt_T_Func (bool testConds, bool runActions) {', '    // Actions', '    if (!runActions) {', '        return true;', '    }', '',
      '    TriggerQueueEnter();', '    gv_n = 1;', '    // inside the queue', '    gv_n = 2;', '    TriggerQueueExit();', '    gv_n = 3;',
      '    return true;', '}', '',
      'void gt_T_Init () {', '    gt_T = TriggerCreate("gt_T_Func");', '}', '',
    ].join('\n');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', verification: 'semantic', script, header: '' });
    expect(reverse.output.triggerData.match(/<Comment>inside the queue<\/Comment>/gu)).toHaveLength(1);
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map', ...reverse.output.generationOptions });
    expect(forward.output.script.match(/\/\/ inside the queue/gu)).toHaveLength(1);
    expect(forward.output.script).toContain('    gv_n = 1;\n    // inside the queue\n    gv_n = 2;');
  });

  it('reads a line the editor writes for a comment-only action back as that action', async () => {
    // NativeLib's Transmission Comment (Sound) is `// Transmission - #PARAM(sound)`; TTosh1 has 21 and no such Comment.
    const m = model(), sound = m.formal('sound', 'soundlink');
    m.add('FunctionDef', { name: 'TransmissionCommentSound', scriptCode: '// Transmission - #PARAM(sound)', parameters: [sound],
      returnType: { type: 'void' }, flags: ['Action', 'Operator'] });
    const dependencyLibraries = [{ triggerData: m.xml() }];
    const script = ['int gv_n;', '', 'void gf_Talk () {', '    // Implementation',
      '    // Transmission - SoundLink("Line01", -1)', '    gv_n = 1;', '}', ''].join('\n');
    const reverse = await convertGalaxyToTriggers({ libraryId: 'Map', documentKind: 'map', verification: 'semantic', script, header: '', dependencyLibraries });
    expect(reverse.output.triggerData).not.toContain('<Comment>');
    expect(reverse.output.triggerData).toContain('<FunctionDef Type="FunctionDef" Library="TEST" Id="00000002"/>');
    const forward = await convertTriggersToGalaxy(reverse.output.triggerData, { libraryId: 'Map', documentKind: 'map', dependencyLibraries, ...reverse.output.generationOptions });
    expect(forward.output.script).toContain('    // Transmission - SoundLink("Line01", -1)\n    gv_n = 1;');
  });
});
