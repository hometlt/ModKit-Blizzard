import { describe, expect, it } from 'vitest';
import {
  analyzeGalaxyLanguage,
  formatGalaxySource,
  galaxyCompletionContextAt,
  galaxyCompletionSortText,
  galaxyCompletionsAt,
  galaxyDefinitionAt,
  galaxyHoverAt,
  galaxyReferencesAt,
  galaxySignatureAt,
} from '@modkit/blizzard-starcraft2/galaxy/analysis/language-service.js';
import * as compatibilityLanguageService from '../../language/language-service.js';
import type { TriggerLibraryJson } from '@modkit/blizzard-starcraft2/triggers/document/index.js';

const SAMPLE = `
include "NativeLib"

const int gv_count = 0;

struct Foo {
  int value;
};

int Add(int a, int b) {
  return a + b;
}

void Init() {
  int local = Add(gv_count, 2);
}
`;

describe('Galaxy language service', () => {
  it('keeps the public compatibility export pinned to the canonical analysis service', () => {
    expect(compatibilityLanguageService.analyzeGalaxyLanguage).toBe(analyzeGalaxyLanguage);
    expect(compatibilityLanguageService.formatGalaxySource).toBe(formatGalaxySource);
    expect(compatibilityLanguageService.galaxySignatureAt).toBe(galaxySignatureAt);
  });

  it('collects diagnostics from plaxtony parse errors', () => {
    const index = analyzeGalaxyLanguage('void Init(', 'bad.galaxy');
    expect(index.diagnostics.length).toBeGreaterThan(0);
  });

  it('collects checker diagnostics for type mismatches', () => {
    const index = analyzeGalaxyLanguage('void Init() { int x = "str"; }', 'bad-type.galaxy');
    expect(index.diagnostics.map((d) => d.message)).toContain("Type 'string' is not assignable to 'int'.");
  });

  it('indexes top-level declarations and struct members', () => {
    const index = analyzeGalaxyLanguage(SAMPLE, 'sample.galaxy');
    expect(index.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(['NativeLib', 'gv_count', 'Foo', 'Add', 'Init']));
    const foo = index.symbols.find((s) => s.name === 'Foo');
    expect(foo?.children?.[0]?.name).toBe('value');
  });

  it('offers keyword/type/snippet/declaration completions', () => {
    const completions = analyzeGalaxyLanguage(SAMPLE, 'sample.galaxy').completions;
    const labels = completions.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['for', 'int', 'return', 'Add', 'gv_count']));
    expect(completions.find((c) => c.label === 'Add')?.sortText).toBe(galaxyCompletionSortText({ kind: 'function', label: 'Add' }));
  });

  it('formats Galaxy source with conservative brace indentation', () => {
    const source = 'void Init(){\nint x = 1;\nif (x) {\nreturn;\n}\n}\n';
    expect(formatGalaxySource(source, { insertSpaces: true, tabSize: 2 })).toBe([
      'void Init(){',
      '  int x = 1;',
      '  if (x) {',
      '    return;',
      '  }',
      '}',
      '',
    ].join('\n'));
  });

  it('finds definitions, references, hover, and signature help', () => {
    const addUse = SAMPLE.indexOf('Add(gv_count');
    const def = galaxyDefinitionAt(SAMPLE, addUse, 'sample.galaxy');
    expect(def?.name).toBe('Add');
    expect(def?.start).toBe(SAMPLE.indexOf('int Add'));

    const refs = galaxyReferencesAt(SAMPLE, addUse);
    expect(refs.length).toBe(2);

    const hover = galaxyHoverAt(SAMPLE, addUse, 'sample.galaxy');
    expect(hover?.markdown).toContain('Add');

    const sig = galaxySignatureAt(SAMPLE, SAMPLE.lastIndexOf('gv_count'), 'sample.galaxy');
    expect(sig?.label).toContain('Add');
    expect(sig?.activeParameter).toBe(0);
  });

  it('promotes completions matching the expected argument type', () => {
    const code = `
unit gv_unit;
int gv_count;
void TakesUnit(unit u) {
}
void Init() {
  TakesUnit();
}
`;
    const offset = code.indexOf(');', code.indexOf('TakesUnit('));
    const context = galaxyCompletionContextAt(code, offset, 'context.galaxy');
    const completions = galaxyCompletionsAt(code, offset, 'context.galaxy');

    expect(context).toMatchObject({ activeFunction: 'TakesUnit', activeParameter: 0, expectedType: 'unit' });
    expect(completions[0]?.label).toBe('gv_unit');
    expect(completions.find(c => c.label === 'gv_count')?.sortText).not.toBe(completions[0]?.sortText);
  });

  it('uses TriggerLib metadata for completions, hover, and signature help', () => {
    const triggerLibrary: TriggerLibraryJson = {
      id: 'Ntve',
      items: [],
      elements: {},
      elementsByType: {
        FunctionDef: {
          'fn': {
            id: 'fn',
            type: 'FunctionDef',
            name: 'Unit Create',
            scriptCode: 'UnitCreate',
            parameters: [{ id: 'unitType' }],
            returnType: { type: 'unit' },
          },
        },
        ParamDef: {
          unitType: {
            id: 'unitType',
            type: 'ParamDef',
            name: 'unitType',
            paramType: { type: 'string' },
          },
        },
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
    const code = 'void Init() { UnitCreate("Marine"); }';

    const labels = analyzeGalaxyLanguage(code, 'trigger.galaxy', { triggerLibrary }).completions.map(item => item.label);
    expect(labels).toContain('UnitCreate');
    expect(galaxyHoverAt(code, code.indexOf('UnitCreate'), 'trigger.galaxy', { triggerLibrary })?.markdown).toContain('unit UnitCreate');
    expect(galaxySignatureAt(code, code.indexOf('"Marine"'), 'trigger.galaxy', { triggerLibrary })?.label).toBe('unit UnitCreate(string unitType)');
  });
});
