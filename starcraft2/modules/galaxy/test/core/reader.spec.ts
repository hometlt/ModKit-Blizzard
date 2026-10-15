import { describe, it, expect } from 'vitest';
import { analyzeGalaxyScript } from '@modkit/blizzard-starcraft2/galaxy/analysis/reader.js';
import { parseGalaxySource, printGalaxySource } from '@modkit/blizzard-starcraft2/galaxy/analysis/source.js';

describe('analyzeGalaxyScript', () => {
  it('parses empty file', () => {
    const result = analyzeGalaxyScript('test.galaxy', '');
    expect(result.fileName).toBe('test.galaxy');
    expect(result.functions).toHaveLength(0);
    expect(result.variables).toHaveLength(0);
    expect(result.catalogRefs).toHaveLength(0);
  });

  it('parses and prints Galaxy source through the public AST helpers', () => {
    const sourceFile = parseGalaxySource('int Add(int a, int b) { return a + b; }', 'test.galaxy');
    expect(sourceFile.fileName).toBe('test.galaxy');
    expect(printGalaxySource(sourceFile)).toContain('Add');
  });

  it('finds functions', () => {
    const code = `
      void Init() {
        int x = 0;
      }
      int Add(int a, int b) {
        return a + b;
      }
    `;
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.functions).toHaveLength(2);
    expect(result.functions[0].name).toBe('Init');
    expect(result.functions[0].returnType).toBe('void');
    expect(result.functions[1].name).toBe('Add');
    expect(result.functions[1].returnType).toBe('int');
    expect(result.functions[1].parameters).toHaveLength(2);
    expect(result.functions[1].parameters[0].name).toBe('a');
    expect(result.functions[1].parameters[0].type).toBe('int');
  });

  it('finds native functions', () => {
    const code = `native int UnitCreate(int player, string unitType, int preset, bool check);`;
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0].name).toBe('UnitCreate');
    expect(result.functions[0].isNative).toBe(true);
  });

  it('finds global variables', () => {
    const code = `
      int gv_count = 0;
      const string gv_name = "test";
    `;
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.variables).toHaveLength(2);
    expect(result.variables[0].name).toBe('gv_count');
    expect(result.variables[0].type).toBe('int');
    expect(result.variables[1].name).toBe('gv_name');
    expect(result.variables[1].isConst).toBe(true);
  });

  it('finds structs', () => {
    const code = `
      struct SPoint {
        int x;
        int y;
      };
    `;
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.structs).toHaveLength(1);
    expect(result.structs[0].name).toBe('SPoint');
    expect(result.structs[0].members).toHaveLength(2);
  });

  it('finds include directives', () => {
    const code = `include "libDPAN.galaxy";`;
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.includes).toHaveLength(1);
    expect(result.includes[0]).toBe('libDPAN.galaxy');
  });

  it('extracts Unit catalog refs', () => {
    const code = `void Spawn() { UnitCreate(1, "Marine", 0, true); }`;
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.catalogRefs).toHaveLength(1);
    expect(result.catalogRefs[0].catalog).toBe('Unit');
    expect(result.catalogRefs[0].entry).toBe('Marine');
  });

  it('extracts Abil catalog refs', () => {
    const code = `void Research() { TechTreeAbilityAdd(1, "Stimpack"); }`;
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.catalogRefs).toHaveLength(1);
    expect(result.catalogRefs[0].catalog).toBe('Abil');
    expect(result.catalogRefs[0].entry).toBe('Stimpack');
  });

  it('extracts Race catalog refs', () => {
    const code = `void SetRace() { PlayerSetRace(1, "Terr"); }`;
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.catalogRefs).toHaveLength(1);
    expect(result.catalogRefs[0].catalog).toBe('Race');
    expect(result.catalogRefs[0].entry).toBe('Terr');
  });

  it('handles parse errors gracefully', () => {
    const code = `void Init(`; // invalid syntax
    const result = analyzeGalaxyScript('test.galaxy', code);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
