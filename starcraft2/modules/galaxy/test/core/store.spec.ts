import { describe, expect, it } from 'vitest';
import { GalaxyStore } from '@modkit/blizzard-starcraft2/galaxy/analysis/store.js';

describe('GalaxyStore', () => {
  it('resolves cross-file definitions and references through unique declarations', () => {
    const store = new GalaxyStore();
    store.updateFile('a.galaxy', 'int Add(int a, int b) { return a + b; }');
    store.updateFile('b.galaxy', 'void Init() { int x = Add(1, 2); }');

    const use = store.getFile('b.galaxy')!.code.indexOf('Add(1');
    const def = store.definitionAt('b.galaxy', use);
    const refs = store.referencesAt('b.galaxy', use);

    expect(def?.fileName).toBe('a.galaxy');
    expect(def?.symbol.name).toBe('Add');
    expect(refs.map((r) => `${r.fileName}:${r.name}`)).toEqual(['a.galaxy:Add', 'b.galaxy:Add']);
  });

  it('feeds cross-file declarations into checker diagnostics and completions', () => {
    const store = new GalaxyStore();
    store.updateFile('math.galaxy', 'int Add(int a, int b) { return a + b; }');
    store.updateFile('main.galaxy', 'void Init() { int x = Add(1); }');

    const file = store.getFile('main.galaxy')!;
    expect(file.index.diagnostics.map((d) => d.message)).toContain("Function 'Add' expects 2 argument(s), got 1.");
    expect(store.completions('main.galaxy').map((item) => item.label)).toContain('Add');
  });

  it('does not rename ambiguous declarations', () => {
    const store = new GalaxyStore();
    store.updateFile('a.galaxy', 'void Reset() {}');
    store.updateFile('b.galaxy', 'void Reset() {}');
    store.updateFile('main.galaxy', 'void Init() { Reset(); }');

    const use = store.getFile('main.galaxy')!.code.indexOf('Reset(');
    expect(store.definitionAt('main.galaxy', use)).toBeUndefined();
    expect(store.renameEdits('main.galaxy', use)).toEqual([]);
  });
});
