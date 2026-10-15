import { describe, expect, it } from 'vitest';
import { GalaxyWorkspaceIndex } from '@modkit/blizzard-starcraft2/galaxy/analysis/workspace-index.js';

describe('GalaxyWorkspaceIndex', () => {
  it('resolves a unique top-level declaration across indexed files', () => {
    const ws = new GalaxyWorkspaceIndex();
    ws.updateFile('a.galaxy', 'int Add(int a, int b) { return a + b; }');
    ws.updateFile('b.galaxy', 'void Init() { int x = Add(1, 2); }');

    const use = ws.getFile('b.galaxy')!.code.indexOf('Add(1');
    const def = ws.definitionAt('b.galaxy', use);

    expect(def?.fileName).toBe('a.galaxy');
    expect(def?.symbol.name).toBe('Add');
  });

  it('finds references for a unique top-level declaration across files', () => {
    const ws = new GalaxyWorkspaceIndex();
    ws.updateFile('a.galaxy', 'int Add(int a, int b) { return a + b; }');
    ws.updateFile('b.galaxy', 'void Init() { int x = Add(1, 2); }');

    const use = ws.getFile('b.galaxy')!.code.indexOf('Add(1');
    const refs = ws.referencesAt('b.galaxy', use);

    expect(refs.map((r) => `${r.fileName}:${r.name}`)).toEqual(['a.galaxy:Add', 'b.galaxy:Add']);
  });

  it('does not resolve ambiguous top-level names across files', () => {
    const ws = new GalaxyWorkspaceIndex();
    ws.updateFile('a.galaxy', 'void Reset() {}');
    ws.updateFile('b.galaxy', 'void Reset() {}');
    ws.updateFile('c.galaxy', 'void Init() { Reset(); }');

    const use = ws.getFile('c.galaxy')!.code.indexOf('Reset(');

    expect(ws.definitionAt('c.galaxy', use)).toBeUndefined();
    expect(ws.referencesAt('c.galaxy', use)).toEqual([]);
  });
});
