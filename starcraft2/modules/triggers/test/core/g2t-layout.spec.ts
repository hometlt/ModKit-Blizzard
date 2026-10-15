import { describe, expect, it } from 'vitest';
import { restoreEditorLayout } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/editor-layout.js';

const ref = (type: string, id: string) => ({ type, library: 'Map', id });

describe('restoreEditorLayout', () => {
  it('groups raw reconstructed library roots into the standard editor folders', () => {
    const library: any = {
      id: 'Map', name: 'Map', elements: {
        CONST: { type: 'Variable', id: 'CONST', library: 'Map', isConstant: true },
        STRUCT: { type: 'Structure', id: 'STRUCT', library: 'Map' },
        VAR: { type: 'Variable', id: 'VAR', library: 'Map' },
        FUNC: { type: 'FunctionDef', id: 'FUNC', library: 'Map', flags: [] },
        ACTION: { type: 'FunctionDef', id: 'ACTION', library: 'Map', flags: ['Action'] },
        TRIGGER: { type: 'Trigger', id: 'TRIGGER', library: 'Map' },
      },
      items: [ref('Variable', 'CONST'), ref('Structure', 'STRUCT'), ref('Variable', 'VAR'), ref('FunctionDef', 'FUNC'), ref('FunctionDef', 'ACTION'), ref('Trigger', 'TRIGGER')],
    };
    const source: any = { text: 'void gf_f() {}', commentsLineMap: new Map(), statements: [] };

    restoreEditorLayout(source, library, new Map());

    const folders = library.items.map((item: any) => library.elements[item.id]);
    expect(folders.map((folder: any) => folder.name)).toEqual(['Constants', 'Structs', 'Variables', 'Functions', 'Actions', 'Triggers']);
    expect(folders.map((folder: any) => folder.displayName)).toEqual(['Constants', 'Structs', 'Variables', 'Functions', 'Actions', 'Triggers']);
    expect(folders.map((folder: any) => folder.items.map((item: any) => item.id))).toEqual([['CONST'], ['STRUCT'], ['VAR'], ['FUNC'], ['ACTION'], ['TRIGGER']]);
  });

  it('keeps an explicit editor layout marker instead of replacing it with standard folders', () => {
    const layout = { version: 1, items: [{ type: 'Category', name: 'Authored', items: [{ type: 'symbol', name: 'gf_f' }] }] };
    const encoded = Buffer.from(JSON.stringify(layout), 'utf8').toString('base64url');
    const text = `// @modkit-editor-layout ${encoded}\nvoid gf_f() {}`;
    const library: any = { id: 'Map', name: 'Map', elements: { FUNC: { type: 'FunctionDef', id: 'FUNC', library: 'Map' } }, items: [] };
    const source: any = { text, commentsLineMap: new Map([[0, { line: 0, pos: 0, end: text.indexOf('\n') }]]), statements: [] };

    restoreEditorLayout(source, library, new Map([['gf_f', ref('FunctionDef', 'FUNC')]]));

    expect(library.elements[library.items[0].id].name).toBe('Authored');
    expect(library.items).toHaveLength(1);
  });

  it('replaces generated section folders with the standard semantic folders', () => {
    const sourceText = '// Generated Map Script\n// ----------------\n// Library: Example\n// ----------------\nvoid gf_f() {}';
    const library: any = { id: 'Map', name: 'Map', elements: { FUNC: { type: 'FunctionDef', id: 'FUNC', library: 'Map' } }, items: [ref('FunctionDef', 'FUNC')] };
    const comments = new Map([[0, { line: 0, pos: 0, end: 23 }], [1, { line: 1, pos: 24, end: 42 }], [2, { line: 2, pos: 43, end: 62 }], [3, { line: 3, pos: 63, end: 81 }]]);
    const source: any = { text: sourceText, commentsLineMap: comments, statements: [{ name: { name: 'gf_f' }, pos: 82, end: sourceText.length, body: {} }] };

    restoreEditorLayout(source, library, new Map([['gf_f', ref('FunctionDef', 'FUNC')]]));

    expect(library.items.map((item: any) => library.elements[item.id].name)).toEqual(['Functions']);
    expect(library.elements[library.items[0].id].items).toEqual([ref('FunctionDef', 'FUNC')]);
    expect(Object.values(library.elements).some((element: any) => element.type === 'Category' && element.name === 'Library: Example')).toBe(false);
  });

  // A parsed source as restoreEditorLayout reads it: one comment per `//` line, one body per function line.
  const librarySource = (text: string) => {
    const comments = new Map<number, { line: number; pos: number; end: number }>();
    const statements: any[] = [];
    let pos = 0;
    text.split('\n').forEach((line, index) => {
      if (line.startsWith('//')) comments.set(index, { line: index, pos, end: pos + line.length });
      const fn = /^void (\w+)\(\) \{\}$/u.exec(line);
      if (fn) statements.push({ name: { name: fn[1] }, pos, end: pos + line.length, body: {} });
      pos += line.length + 1;
    });
    return { text, commentsLineMap: comments, statements } as any;
  };
  const libraryRef = (id: string) => ({ type: 'FunctionDef', library: 'LIB', id });

  // Lib<Id>.galaxy has no "Generated Map Script" banner; its "Library: <name>" banner is the evidence.
  it('treats a library script under the editor\'s Library banner as generated and makes no labels of its scaffolding', () => {
    const text = [
      'include "TriggerLibs/NativeLib"',
      '//--------------------------------------------------------------------------------------------------',
      '// Library: All Races',
      '//--------------------------------------------------------------------------------------------------',
      '// Presets',
      '// Functions',
      'void libLIB_gf_f() {}',
      '// Triggers',
    ].join('\n');
    const library: any = { id: 'LIB', name: 'LIB', elements: { FUNC: { type: 'FunctionDef', id: 'FUNC', library: 'LIB' } }, items: [libraryRef('FUNC')] };

    restoreEditorLayout(librarySource(text), library, new Map([['libLIB_gf_f', libraryRef('FUNC')]]));

    expect(Object.values(library.elements).filter((element: any) => element.type === 'Label')).toEqual([]);
    expect(Object.values(library.elements).some((element: any) => element.name === 'All Races' || element.name === 'Library: All Races')).toBe(false);
  });

  it('keeps the comments of a hand-written library script as labels', () => {
    const text = ['// execute attack', 'void libLIB_gf_f() {}'].join('\n');
    const library: any = { id: 'LIB', name: 'LIB', elements: { FUNC: { type: 'FunctionDef', id: 'FUNC', library: 'LIB' } }, items: [libraryRef('FUNC')] };

    restoreEditorLayout(librarySource(text), library, new Map([['libLIB_gf_f', libraryRef('FUNC')]]));

    expect(Object.values(library.elements).filter((element: any) => element.type === 'Label').map((element: any) => element.name)).toEqual(['execute attack']);
  });

  it('does not create empty standard folders', () => {
    const library: any = {
      id: 'Map', name: 'Map',
      elements: { TRIGGER: { type: 'Trigger', id: 'TRIGGER', library: 'Map' } },
      items: [ref('Trigger', 'TRIGGER')],
    };
    const source: any = { text: '', commentsLineMap: new Map(), statements: [] };

    restoreEditorLayout(source, library, new Map());

    expect(library.items.map((item: any) => library.elements[item.id].name)).toEqual(['Triggers']);
    expect(Object.values(library.elements).filter((element: any) => element.type === 'Category')).toHaveLength(1);
  });
});
