import { describe, expect, it } from 'vitest';
import { parseGalaxySource } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.js';
import { parseTriggerXmlSync } from '../../../../dist/modules/triggers/shared/trigger-document/sax-reader.js';
import { convertTriggerLibraryToGalaxyFull } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/trigger-to-galaxy.js';
import { serializeTriggerLibrary, normalizeTriggerLibrary } from '../../../../dist/modules/triggers/shared/trigger-document/trigger-xml.js';
import { convertGalaxyToTriggers } from '../../../../dist/modules/triggers/services/galaxy-conversion/index.js';
import { lookupElement } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/conversion-model.js';
import { syntaxShape } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/script-template.js';
import type { ElementJson, ElementRefJson, ParameterTypeJson, TriggerLibraryJson } from '../../../../dist/modules/triggers/shared/trigger-document/types.js';

function templateLibrary(code: string, options: {
  id?: string; name?: string; result?: string; parameters?: Record<string, string | ParameterTypeJson>; roles?: Record<string, boolean>; inline?: boolean;
} = {}) {
  const id = options.id ?? 'EXT', result = options.result ?? 'void';
  const elements: ElementJson[] = [];
  const add = (type: string, values: object): ElementRefJson => {
    const key = (elements.length + 1).toString(16).padStart(8, '0').toUpperCase();
    elements.push({ type, id: key, library: id, ...values } as ElementJson);
    return { type, id: key, library: id };
  };
  const parameters = Object.entries(options.parameters ?? {}).map(([name, type]) => add('ParamDef', { name, paramType: typeof type === 'string' ? { type } : type }));
  const roles = Object.entries(options.roles ?? {}).map(([name, isAction]) => add('SubFuncType', { name, isAction }));
  const definition = add('FunctionDef', { name: options.name ?? 'DefinitionFromDependency', scriptCode: code,
    parameters, subFunctionTypes: roles, returnType: { type: result },
    isFuncAction: result === 'void', isFuncCall: result !== 'void', isSubFunction: roles.length > 0,
    flags: [...(options.inline === false ? [] : ['Template']), result === 'void' ? 'Action' : 'Call', ...(roles.length ? ['SubFunctions'] : [])] });
  const library = normalizeTriggerLibrary({ id, items: [], elements: Object.fromEntries(elements.map(element => [element.id, element])), elementsByType: {} }) as TriggerLibraryJson;
  const named = Object.fromEntries(Object.keys(options.parameters ?? {}).map((name, index) => [name, parameters[index]]));
  return { library, definition, parameters: named };
}

async function convert(source: string, dependencies: TriggerLibraryJson[]) {
  const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script: source, header: '',
    dependencyLibraries: dependencies.map(library => ({ triggerData: serializeTriggerLibrary(library) })) });
  expect(result.fidelity.verification.semanticModelExact).toBe(true);
  const library = parseTriggerXmlSync(result.output.triggerData).get('TEST')!;
  expect(Object.values(library.elements).some((element: any) => element.flags?.includes('CustomScript'))).toBe(false);
  const output = convertTriggerLibraryToGalaxyFull(library, undefined, new Map(dependencies.map(library => [library.id, library])));
  expect(parseGalaxySource(output.script).parseDiagnostics).toEqual([]);
  const calls = (ref: ElementRefJson) => Object.values(library.elements).filter((element: any) => element.type === 'FunctionCall' &&
    element.functionDef?.library === ref.library && element.functionDef?.id === ref.id) as any[];
  return { ...output, library, calls };
}

function body(source: string, name: string): any[] {
  const fn = [...parseGalaxySource(source).statements].find((node: any) => node.name?.name === name && node.body) as any;
  expect(fn).toBeDefined();
  return [...fn.body.statements];
}

function expectExpression(script: string, expected: string) {
  const actual = body(script, 'compute').at(-1).expression;
  const wanted = body(`bool wanted() { return ${expected}; }`, 'wanted')[0].expression;
  expect(syntaxShape(actual)).toEqual(syntaxShape(wanted));
}

describe('loaded ScriptCode reconstruction', () => {
  it.each([undefined, { library: 'Gone', id: 'Missing' }])('preserves single-role comments with obsolete metadata %j', role => {
    const dependency = templateLibrary('if (true) {\n#SUBFUNCS(body)\n}', { roles: { body: true } });
    const elements: any[] = [
      { type: 'FunctionDef', id: 'Run', library: 'TEST', name: 'Run', returnType: { type: 'void' }, actions: [{ type: 'FunctionCall', id: 'Call', library: 'TEST' }] },
      { type: 'FunctionCall', id: 'Call', library: 'TEST', functionDef: dependency.definition, parameters: [], subFunctions: [{ type: 'Comment', id: 'Note', library: 'TEST' }] },
      { type: 'Comment', id: 'Note', library: 'TEST', comment: 'Keep this exact location', subFunctionType: role },
    ];
    const library = normalizeTriggerLibrary({ id: 'TEST', items: [elements[0]], elements: Object.fromEntries(elements.map(e => [e.id, e])), elementsByType: {} }) as TriggerLibraryJson;
    const result = convertTriggerLibraryToGalaxyFull(library, undefined, new Map([[dependency.library.id, dependency.library]]));
    expect(result.script).toMatch(/if\s*\(true\)\s*\{\s*\/\/ Keep this exact location/);
  });

  it('expands a loaded call template whose expression already ends in a semicolon', () => {
    const dependency = templateLibrary('Match(#PARAM(unit), Filter((1 << c_flag), 0));', { name: 'IsVisible', result: 'bool', parameters: { unit: 'unit' } });
    const elements: any[] = [
      { type: 'FunctionDef', id: 'Run', library: 'TEST', name: 'Run', returnType: { type: 'void' }, actions: [{ type: 'FunctionCall', id: 'Call', library: 'TEST' }] },
      { type: 'FunctionCall', id: 'Call', library: 'TEST', functionDef: dependency.definition,
        parameters: [{ type: 'Param', id: 'Arg', library: 'TEST' }] },
      { type: 'Param', id: 'Arg', library: 'TEST', parameterDef: dependency.parameters!.unit, value: 'null', valueType: { type: 'unit' } },
    ];
    const library = normalizeTriggerLibrary({ id: 'TEST', items: [elements[0]], elements: Object.fromEntries(elements.map(e => [e.id, e])), elementsByType: {} }) as TriggerLibraryJson;
    const result = convertTriggerLibraryToGalaxyFull(library, undefined, new Map([[dependency.library.id, dependency.library]]));
    expect(result.script).toContain('Filter((1 << c_flag), 0))');
    expect(result.script).toMatch(/Match\([^;]*, Filter\(\(1 << c_flag\), 0\)\);/);
  });

  it('treats a one-parameter operator as an identity when nothing describes one of its types', () => {
    // The editor has no body, no ScriptCode and no native for such a definition,
    // so it prints the argument; a type the loaded data never explains is no
    // evidence of a conversion.
    const host = templateLibrary('Note(#PARAM(value));', { id: 'HOST', name: 'Note', parameters: { value: 'string' } });
    const cast = templateLibrary('', { id: 'CAST', name: 'TagToString', result: 'string', parameters: { tag: 'conversationtag' } });
    const definition = cast.library.elements[cast.definition.id] as any;
    definition.flags = ['Call', 'Operator'];
    delete definition.scriptCode;
    const elements: any[] = [
      { type: 'FunctionDef', id: 'Run', library: 'TEST', name: 'Run', returnType: { type: 'void' }, actions: [{ type: 'FunctionCall', id: 'Call', library: 'TEST' }] },
      { type: 'FunctionCall', id: 'Call', library: 'TEST', functionDef: host.definition, parameters: [{ type: 'Param', id: 'Outer', library: 'TEST' }] },
      { type: 'Param', id: 'Outer', library: 'TEST', parameterDef: host.parameters!.value, functionCall: { type: 'FunctionCall', id: 'Inner', library: 'TEST' } },
      { type: 'FunctionCall', id: 'Inner', library: 'TEST', functionDef: cast.definition, parameters: [{ type: 'Param', id: 'Arg', library: 'TEST' }] },
      { type: 'Param', id: 'Arg', library: 'TEST', parameterDef: cast.parameters!.tag, value: 'Protoss', valueType: { type: 'conversationtag' } },
    ];
    const library = normalizeTriggerLibrary({ id: 'TEST', items: [elements[0]], elements: Object.fromEntries(elements.map(e => [e.id, e])), elementsByType: {} }) as TriggerLibraryJson;
    const result = convertTriggerLibraryToGalaxyFull(library, undefined, new Map([[host.library.id, host.library], [cast.library.id, cast.library]]));
    expect(result.script).toContain('Note("Protoss")');
    expect(result.script).not.toContain('TagToString');
  });

  it('expands a CustomScript body that carries template macros instead of printing them', () => {
    const host = templateLibrary('Note(#PARAM(value));', { id: 'HOST', name: 'Note', parameters: { value: 'bool' } });
    const custom = templateLibrary('(#PARAM(left) == #PARAM(right))', { id: 'CUST', name: 'SameValue', result: 'bool', parameters: { left: 'int', right: 'int' } });
    (custom.library.elements[custom.definition.id] as any).flags = ['Call', 'Operator', 'CustomScript'];
    const elements: any[] = [
      { type: 'FunctionDef', id: 'Run', library: 'TEST', name: 'Run', returnType: { type: 'void' }, actions: [{ type: 'FunctionCall', id: 'Call', library: 'TEST' }] },
      { type: 'FunctionCall', id: 'Call', library: 'TEST', functionDef: host.definition, parameters: [{ type: 'Param', id: 'Outer', library: 'TEST' }] },
      { type: 'Param', id: 'Outer', library: 'TEST', parameterDef: host.parameters!.value, functionCall: { type: 'FunctionCall', id: 'Inner', library: 'TEST' } },
      { type: 'FunctionCall', id: 'Inner', library: 'TEST', functionDef: custom.definition,
        parameters: [{ type: 'Param', id: 'L', library: 'TEST' }, { type: 'Param', id: 'R', library: 'TEST' }] },
      { type: 'Param', id: 'L', library: 'TEST', parameterDef: custom.parameters!.left, value: '1', valueType: { type: 'int' } },
      { type: 'Param', id: 'R', library: 'TEST', parameterDef: custom.parameters!.right, value: '2', valueType: { type: 'int' } },
    ];
    const library = normalizeTriggerLibrary({ id: 'TEST', items: [elements[0]], elements: Object.fromEntries(elements.map(e => [e.id, e])), elementsByType: {} }) as TriggerLibraryJson;
    const result = convertTriggerLibraryToGalaxyFull(library, undefined, new Map([[host.library.id, host.library], [custom.library.id, custom.library]]));
    expect(result.script).not.toContain('#PARAM');
    expect(result.script).toContain('(1 == 2)');
  });

  it('places a comment that names no role ahead of the call, in none of its branches', () => {
    const dependency = templateLibrary('if (true) {\n#SUBFUNCS(yes)\n} else {\n#SUBFUNCS(no)\n}', { roles: { yes: true, no: true } });
    const elements: any[] = [
      { type: 'FunctionDef', id: 'Run', library: 'TEST', name: 'Run', returnType: { type: 'void' }, actions: [{ type: 'FunctionCall', id: 'Call', library: 'TEST' }] },
      { type: 'FunctionCall', id: 'Call', library: 'TEST', functionDef: dependency.definition, parameters: [], subFunctions: [{ type: 'Comment', id: 'First', library: 'TEST' }, { type: 'Comment', id: 'Second', library: 'TEST' }] },
      { type: 'Comment', id: 'First', library: 'TEST', comment: 'Which branch?' },
      { type: 'Comment', id: 'Second', library: 'TEST', comment: 'Also unplaced' },
    ];
    const library = normalizeTriggerLibrary({ id: 'TEST', items: [elements[0]], elements: Object.fromEntries(elements.map(e => [e.id, e])), elementsByType: {} }) as TriggerLibraryJson;
    const result = convertTriggerLibraryToGalaxyFull(library, undefined, new Map([[dependency.library.id, dependency.library]]));
    expect(result.script).toMatch(/\/\/ Which branch\?\s*\n\s*\/\/ Also unplaced\s*\n\s*if \(true\)/);
  });

  it('reports an executable subfunction that names no role rather than dropping it', () => {
    const dependency = templateLibrary('if (true) {\n#SUBFUNCS(yes)\n} else {\n#SUBFUNCS(no)\n}', { roles: { yes: true, no: true } });
    const action = templateLibrary('DoThing();', { id: 'ACT', name: 'DoThing' });
    const elements: any[] = [
      { type: 'FunctionDef', id: 'Run', library: 'TEST', name: 'Run', returnType: { type: 'void' }, actions: [{ type: 'FunctionCall', id: 'Call', library: 'TEST' }] },
      { type: 'FunctionCall', id: 'Call', library: 'TEST', functionDef: dependency.definition, parameters: [], subFunctions: [{ type: 'FunctionCall', id: 'Child', library: 'TEST' }] },
      { type: 'FunctionCall', id: 'Child', library: 'TEST', functionDef: action.definition, parameters: [] },
    ];
    const library = normalizeTriggerLibrary({ id: 'TEST', items: [elements[0]], elements: Object.fromEntries(elements.map(e => [e.id, e])), elementsByType: {} }) as TriggerLibraryJson;
    expect(() => convertTriggerLibraryToGalaxyFull(library, undefined, new Map([[dependency.library.id, dependency.library], [action.library.id, action.library]]))).toThrow(/names no role/);
  });
  it.each(['ArbitraryName', 'Comparison', 'WhileDo'])('reconstructs expression subfunctions without using the display name %s', async name => {
    const dependency = templateLibrary('#SUBFUNCS(terms," && ")', { name, result: 'bool', roles: { terms: false } });
    const { script, calls } = await convert('bool compute(bool a, bool b) { return a && false && (b || a); }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(1);
    expect(calls(dependency.definition)[0].subFunctions).toHaveLength(3);
    expectExpression(script, 'lp_a && false && (lp_b || lp_a)');
  });

  it.each([
    ['a - b - c', 'lp_a - lp_b - lp_c', 3],
    ['a - (b - c)', 'lp_a - (lp_b - lp_c)', 2],
  ])('preserves grouping when reconstructing %s', async (expression, expected, children) => {
    const dependency = templateLibrary('#SUBFUNCS(operands," - ")', { result: 'int', roles: { operands: false } });
    const { script, library, calls } = await convert(`int compute(int a, int b, int c) { return ${expression}; }`, [dependency.library]);
    const matched = calls(dependency.definition);
    const nestedIds = new Set(matched.flatMap(call => call.subFunctions.map((ref: ElementRefJson) => ref.id)));
    const outer = matched.find(call => !nestedIds.has(call.id));
    expect(outer.subFunctions).toHaveLength(children);
    for (const ref of outer.subFunctions) expect(lookupElement([library], ref, library.id)).toBeDefined();
    expectExpression(script, expected);
  });

  it('keeps stateful calls in their original order inside a reconstructed expression list', async () => {
    const dependency = templateLibrary('#SUBFUNCS(values," && ")', { result: 'bool', roles: { values: false } });
    const { script, calls } = await convert('bool first(); bool second(); bool third(); bool compute() { return first() && (second() || third()); }', [dependency.library]);
    expect(calls(dependency.definition)[0].subFunctions).toHaveLength(2);
    expectExpression(script, 'first() && (second() || third())');
  });

  it.each(['2, 3', ''])('reconstructs a whole call argument list including the empty case: %s', async args => {
    const dependency = templateLibrary('Collect(#SUBFUNCS(arguments,", "))', { result: 'int', roles: { arguments: false } });
    const { script, calls } = await convert(`int compute() { return Collect(${args}); }`, [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(1);
    expect(calls(dependency.definition)[0].subFunctions ?? []).toHaveLength(args ? 2 : 0);
    expectExpression(script, `Collect(${args})`);
  });

  it('captures arguments between fixed prefix and suffix arguments', async () => {
    const dependency = templateLibrary('Collect(1, #SUBFUNCS(arguments,", "), 9)', { result: 'int', roles: { arguments: false } });
    const { script, calls } = await convert('int compute() { return Collect(1, 2, 3, 9); }', [dependency.library]);
    expect(calls(dependency.definition)[0].subFunctions).toHaveLength(2);
    expectExpression(script, 'Collect(1, 2, 3, 9)');
  });

  it('declines an empty argument capture that would expand to an invalid comma sequence', async () => {
    const dependency = templateLibrary('Collect(1, #SUBFUNCS(arguments,", "), 9)', { result: 'int', roles: { arguments: false } });
    const { script, calls } = await convert('int compute() { return Collect(1, 9); }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(0);
    expectExpression(script, 'Collect(1, 9)');
  });

  it.each(['touch();', ''])('reconstructs an anchored multi-statement template with body: %s', async inner => {
    const dependency = templateLibrary('begin(#PARAM(value)); #SUBFUNCS(body) end(#PARAM(value));', { parameters: { value: 'int' }, roles: { body: true } });
    const { script, calls } = await convert(`void begin(int value); void end(int value); void touch(); void compute(int x) { begin(x); ${inner} end(x); return; }`, [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(1);
    expect(calls(dependency.definition)[0].subFunctions ?? []).toHaveLength(inner ? 1 : 0);
    expect(syntaxShape(body(script, 'compute'))).toEqual(syntaxShape(body(`void wanted(){begin(lp_x);${inner}end(lp_x);return;}`, 'wanted')));
  });

  it('keeps adjacent groups separate and leaves following statements in place', async () => {
    const dependency = templateLibrary('begin(#PARAM(value)); #SUBFUNCS(body) end(#PARAM(value));', { parameters: { value: 'int' }, roles: { body: true } });
    const { script, calls } = await convert('void compute(int x) { begin(x); end(x); begin(x); touch(); end(x); finish(); }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(2);
    expect(syntaxShape(body(script, 'compute'))).toEqual(syntaxShape(body('void wanted(){begin(lp_x);end(lp_x);begin(lp_x);touch();end(lp_x);finish();}', 'wanted')));
  });

  it('does not merge statements whose repeated parameter bindings differ', async () => {
    const dependency = templateLibrary('begin(#PARAM(value)); #SUBFUNCS(body) end(#PARAM(value));', { parameters: { value: 'int' }, roles: { body: true } });
    const { script, calls } = await convert('void compute(int x, int y) { begin(x); touch(); end(y); }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(0);
    expect(syntaxShape(body(script, 'compute'))).toEqual(syntaxShape(body('void wanted(){begin(lp_x);touch();end(lp_y);}', 'wanted')));
  });

  it('reconstructs a fixed statement sequence inside an ordinary branch', async () => {
    const dependency = templateLibrary('first(#PARAM(value)); second(#PARAM(value));', { parameters: { value: 'int' } });
    const { script, calls } = await convert('void compute(bool condition, int x) { if(condition) { first(x); second(x); } third(); }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(1);
    expect(syntaxShape(body(script, 'compute'))).toEqual(syntaxShape(body('void wanted(){if(lp_condition){first(lp_x);second(lp_x);}third();}', 'wanted')));
  });

  it('rejects transparent expression and statement templates without recursion', async () => {
    const expression = templateLibrary('#PARAM(value)', { id: 'EXPR', result: 'bool', parameters: { value: 'bool' } });
    const statement = templateLibrary('#SUBFUNCS(body)', { id: 'STMT', roles: { body: true } });
    const { script, calls } = await convert('bool compute(bool value) { observe(); return !value; }', [expression.library, statement.library]);
    expect(calls(expression.definition)).toHaveLength(0);
    expect(calls(statement.definition)).toHaveLength(0);
    expectExpression(script, '!lp_value');
  });

  it('does not use an ordinary function body as an inline action template', async () => {
    const dependency = templateLibrary('return;', { inline: false });
    const { script, calls } = await convert('void compute() { return; }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(0);
    expect(syntaxShape(body(script, 'compute'))).toEqual(syntaxShape(body('void wanted(){return;}', 'wanted')));
  });

  it('chooses a loaded template with the correct result type', async () => {
    const wrong = templateLibrary('#PARAM(left) + #PARAM(right)', { id: 'WRONG', result: 'bool', parameters: { left: 'int', right: 'int' } });
    const right = templateLibrary('#PARAM(left) + #PARAM(right)', { id: 'RIGHT', result: 'int', parameters: { left: 'int', right: 'int' } });
    const { script, calls } = await convert('int compute(int x) { return x + 2; }', [wrong.library, right.library]);
    expect(calls(wrong.definition)).toHaveLength(0);
    expect(calls(right.definition)).toHaveLength(1);
    expectExpression(script, 'lp_x + 2');
  });

  it('uses declared structure-member types when selecting templates', async () => {
    const wrong = templateLibrary('!#PARAM(value)', { id: 'WRONG', result: 'bool', parameters: { value: 'int' } });
    const right = templateLibrary('!#PARAM(value)', { id: 'RIGHT', result: 'bool', parameters: { value: 'bool' } });
    const { script, calls } = await convert('struct Item { bool enabled; }; Item item; bool compute() { return !item.enabled; }', [wrong.library, right.library]);
    expect(calls(wrong.definition)).toHaveLength(0);
    expect(calls(right.definition)).toHaveLength(1);
    expectExpression(script, '!item.lv_enabled');
  });

  it('retains structure identity in generated parameter definitions', async () => {
    const { library, header } = await convert('struct Item { int value; }; Item first; Item second; void compute() { first = second; }', []);
    const structure = Object.values(library.elements).find(element => element.type === 'Structure')!;
    const generated = Object.values(library.elements).filter((element: any) => element.type === 'ParamDef' && element.paramType.type === 'struct') as any[];
    expect(generated.length).toBeGreaterThan(0);
    for (const parameter of generated) expect(parameter.paramType.typeElement).toMatchObject({ type: 'Structure', library: 'TEST', id: structure.id });
    expect(header).toContain('gs_Item');
  });

  it.each(['scratch', 'savedBound', 'autoABCD_var'])('reconstructs a private AUTOVAR independently of its source name: %s', async name => {
    const dependency = templateLibrary('#AUTOVAR(limit,int) = #PARAM(count); while (#AUTOVAR(limit) > 0) { #SUBFUNCS(body) #AUTOVAR(limit) -= 1; }', {
      parameters: { count: 'int' }, roles: { body: true },
    });
    const { script, library, calls } = await convert(`void compute(int count) { int ${name}; ${name}=count; while(${name}>0) { touch(); ${name}-=1; } }`, [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(1);
    const statements = body(script, 'compute');
    const temporary = statements[0].name.name;
    expect(syntaxShape(statements)).toEqual(syntaxShape(body(`void wanted() { int ${temporary}; ${temporary}=lp_count; while(${temporary}>0) { touch(); ${temporary}-=1; } }`, 'wanted')));
    expect(Object.values(library.elements).filter(element => element.type === 'Variable')).toHaveLength(0);
  });

  it('infers a private AUTOVAR type from its assigned formal parameter', async () => {
    const dependency = templateLibrary('#AUTOVAR(limit) = #PARAM(count); while (#AUTOVAR(limit) > 0) { #SUBFUNCS(body) #AUTOVAR(limit) -= 1; }', {
      parameters: { count: 'fixed' }, roles: { body: true },
    });
    const { script, calls } = await convert('void compute(fixed count) { fixed scratch; scratch=count; while(scratch>0) { touch(); scratch-=1; } }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(1);
    const statements = body(script, 'compute'), temporary = statements[0].name.name;
    expect(syntaxShape(statements)).toEqual(syntaxShape(body(`void wanted() { fixed ${temporary}; ${temporary}=lp_count; while(${temporary}>0) { touch(); ${temporary}-=1; } }`, 'wanted')));
  });

  it('uses an explicit ancestor accessor to select the semantic parent over a matching legacy implementation', async () => {
    const legacy = templateLibrary('begin(#PARAM(group)); while (more()) { #SUBFUNCS(actions) } end();', {
      id: 'OLD', name: 'LegacyParent', parameters: { group: 'int' }, roles: { actions: true },
    });
    const current = templateLibrary('#AUTOVAR(cursor,int) = #PARAM(group); while (#AUTOVAR(cursor) > 0) { #SUBFUNCS(actions) #AUTOVAR(cursor) -= 1; }', {
      id: 'NEW', name: 'CurrentParent', parameters: { group: 'int' }, roles: { actions: true },
    });
    const accessor = templateLibrary('#AUTOVAR(cursor,ancestor:CurrentParent)', {
      id: 'GET', name: 'CurrentValue', result: 'int',
    });
    const use = templateLibrary('use(#PARAM(value));', {
      id: 'USE', name: 'UseValue', parameters: { value: 'int' },
    });
    const { script, calls } = await convert(
      'void compute(int group) { begin(group); while (more()) { use(CurrentValue()); } end(); }',
      [legacy.library, current.library, accessor.library, use.library],
    );
    expect(calls(legacy.definition)).toHaveLength(0);
    expect(calls(current.definition)).toHaveLength(1);
    expect(calls(accessor.definition)).toHaveLength(1);
    expect(script).not.toContain('CurrentValue()');
    expect(script).toContain('use(auto');
  });

  it.each([
    ['outside use', 'void compute(int count) { int scratch; scratch=count; while(scratch>0) { touch(); scratch-=1; } observe(scratch); }'],
    ['earlier use', 'void compute(int count) { int scratch; observe(scratch); scratch=count; while(scratch>0) { touch(); scratch-=1; } }'],
    ['captured child use', 'void compute(int count) { int scratch; scratch=count; while(scratch>0) { touch(scratch); scratch-=1; } }'],
    ['captured argument use', 'void compute(int count) { int scratch; scratch=scratch+count; while(scratch>0) { touch(); scratch-=1; } }'],
    ['global storage', 'int scratch; void compute(int count) { scratch=count; while(scratch>0) { touch(); scratch-=1; } }'],
    ['parameter storage', 'void compute(int count, int scratch) { scratch=count; while(scratch>0) { touch(); scratch-=1; } }'],
    ['side-effectful initializer', 'void compute(int count) { int scratch=sideEffect(); scratch=count; while(scratch>0) { touch(); scratch-=1; } }'],
    ['different declared type', 'void compute(int count) { fixed scratch; scratch=count; while(scratch>0) { touch(); scratch-=1; } }'],
    ['another action shares storage', 'void compute(int count) { int scratch; scratch=count; while(scratch>0) { touch(); scratch-=1; } scratch=count; while(scratch>0) { touch(); scratch-=1; } }'],
  ])('preserves ordinary structured syntax when an AUTOVAR has %s', async (_reason, source) => {
    const dependency = templateLibrary('#AUTOVAR(limit,int) = #PARAM(count); while (#AUTOVAR(limit) > 0) { #SUBFUNCS(body) #AUTOVAR(limit) -= 1; }', {
      parameters: { count: 'int' }, roles: { body: true },
    });
    const { script, library, calls } = await convert(source, [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(0);
    expect(script).toContain('while (');
    expect(script).toContain('touch(');
    if (source.includes('sideEffect()')) expect(script.match(/sideEffect\(\)/gu)).toHaveLength(1);
    if (!source.includes('int scratch)')) expect(Object.values(library.elements).some(element => element.type === 'Variable')).toBe(true);
  });

  it('does not collapse two independent macro variables onto the same source local', async () => {
    const dependency = templateLibrary('#AUTOVAR(first,int)=#PARAM(value); #AUTOVAR(second,int)=#PARAM(value); observe(#AUTOVAR(first),#AUTOVAR(second));', {
      parameters: { value: 'int' },
    });
    const { script, calls } = await convert('void compute(int value) { int scratch; scratch=value; scratch=value; observe(scratch,scratch); }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(0);
    const statements = body(script, 'compute'), temporary = statements[0].name.name;
    expect(syntaxShape(statements)).toEqual(syntaxShape(body(`void wanted() { int ${temporary}; ${temporary}=lp_value; ${temporary}=lp_value; observe(${temporary},${temporary}); }`, 'wanted')));
  });

  it('keeps distinct storage when nested reconstructed loops use the same inferred macro name', async () => {
    const dependency = templateLibrary('#AUTOVAR(limit) = #PARAM(count); while (#AUTOVAR(limit) > 0) { #SUBFUNCS(body) #AUTOVAR(limit) -= 1; }', {
      parameters: { count: 'int' }, roles: { body: true },
    });
    const { script, calls } = await convert('void compute(int count) { int outer; int inner; outer=count; while(outer>0) { inner=count; while(inner>0) { touch(); inner-=1; } outer-=1; } }', [dependency.library]);
    expect(calls(dependency.definition)).toHaveLength(1);
    const statements = syntaxShape(body(script, 'compute'));
    const loops = statements.filter(statement => statement.statement);
    const outerName = loops[0].expression.left.name;
    const innerLoop = [...loops[0].statement.statements].find((statement: any) => statement.statement);
    const innerName = innerLoop.expression.left.name;
    expect(outerName).not.toBe(innerName);
    expect(statements.filter(statement => statement.name).map(statement => statement.name.name).sort()).toEqual([outerName, innerName].sort());
    const assignments = statements.filter(statement => statement.expression?.left);
    expect(assignments[0].expression.left.name).toBe(outerName);
    expect(loops[0].statement.statements[0].expression.left.name).toBe(innerName);
  });
});

describe('ScriptCode serialization', () => {
  const scriptCodeOf = (xml: string) => (Object.values(parseTriggerXmlSync(xml).get('TEST')!.elements).find((element: any) => element.type === 'FunctionDef') as any).scriptCode;
  const definition = (scriptCode: string) => `<TriggerData><Library Id="TEST"><Element Type="FunctionDef" Id="00000001"><Identifier>Raw</Identifier><FlagAction/><FlagOperator/>${scriptCode}</Element></Library></TriggerData>`;

  // Probe map in SC2 Editor 5.0.16: code on the <ScriptCode> tag line loaded as empty
  // (a Custom Script compiled to nothing, an Operator definition to `(0.21)`), while
  // the editor's own block layout expanded with any parameter type or identifier.
  it('writes the editor block layout and reads it back exactly', () => {
    const code = 'if (a < b && c > d) {\n    Say("]]>");\n\n}';
    const written = serializeTriggerLibrary(parseTriggerXmlSync(definition(`<ScriptCode>${code.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</ScriptCode>`)).get('TEST')!);
    expect(written).not.toContain('CDATA');
    expect(written).toContain('      <ScriptCode>\n          if (a &lt; b &amp;&amp; c &gt; d) {\n              Say("]]&gt;");\n          \n          }\n      </ScriptCode>');
    expect(scriptCodeOf(written)).toBe(code);
  });

  it('reads an editor-authored block without its layout', () => {
    expect(scriptCodeOf(definition('\r\n        <ScriptCode>\r\n            #PARAM(set) = Add(#PARAM(set),#PARAM(entry));\r\n            if (x) {\r\n                y();\r\n            }\r\n        </ScriptCode>\r\n')))
      .toBe('#PARAM(set) = Add(#PARAM(set),#PARAM(entry));\nif (x) {\n    y();\n}');
  });
});