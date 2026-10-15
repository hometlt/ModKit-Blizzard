import { describe, expect, it } from 'vitest';
import { parseGalaxySource } from '../../services/analysis/source.js';
import { galaxySourceToEngineModule, galaxySourceToEngineProgram } from '../../services/analysis/to-engine.js';

describe('function body presence', () => {
  it('distinguishes an empty implementation from a declaration', () => {
    const source = parseGalaxySource('void Empty() {} void Declared();', 'test.galaxy');
    const module = galaxySourceToEngineModule(source);
    expect(module.functions.map((func) => [func.name, func.flags.hasBody, func.body.length]))
      .toEqual([['Empty', true, 0], ['Declared', false, 0]]);
  });
});

describe('galaxySourceToEngineProgram', () => {
  it('converts Galaxy AST to EngineAst', () => {
    const sourceFile = parseGalaxySource(`
      int gv_count = 0;
      int Add(int a, int b) {
        gv_count = a + b;
        return gv_count;
      }
    `, 'test.galaxy');

    const program = galaxySourceToEngineProgram(sourceFile, { moduleId: 'TestGalaxy' });
    const module = program.modules[0];
    expect(module?.id).toBe('TestGalaxy');
    expect(module?.globals[0]?.name).toBe('gv_count');
    expect(module?.functions[0]?.name).toBe('Add');
    expect(module?.functions[0]?.parameters.map((p) => p.name)).toEqual(['a', 'b']);
    expect(module?.functions[0]?.body.map((stmt) => stmt.kind)).toEqual([
      'EngineAssignmentStatement',
      'EngineReturnStatement',
    ]);
  });
});

describe('control-flow lowering', () => {
  it('keeps parenthesized Galaxy expressions in the typed tree with their inner source spans', () => {
    const text = `void Run() {
      if ((CatalogFieldValueGet(0, "Zergling", "FlagArray", 1) == "1")) {}
      UnitCreate((1), "Zergling", 0, 1, Point(0.0, 0.0), 0.0);
    }`;
    const source = parseGalaxySource(text, 'grouped.galaxy');
    const module = galaxySourceToEngineModule(source);
    const condition = (module.functions[0]?.body[0] as any)?.condition;
    expect(condition.kind).toBe('EngineBinaryExpression');
    expect(condition.left.callee.name).toBe('CatalogFieldValueGet');
    expect(text.slice(condition.source.span.start, condition.source.span.end))
      .toBe('CatalogFieldValueGet(0, "Zergling", "FlagArray", 1) == "1"');
    const count = (module.functions[0]?.body[1] as any)?.expression?.args?.[0];
    expect(count.kind).toBe('EngineLiteralExpression');
    expect(text.slice(count.source.span.start, count.source.span.end)).toBe('1');
  });

  it('lowers for loop to init + EngineWhileStatement', () => {
    // Galaxy for-loops use pre-declared vars; the initializer is an assignment expression.
    const src = parseGalaxySource(`
      int SumN(int n) {
        int total;
        int i;
        for (i = 1; i <= n; i += 1) {
          total += i;
        }
        return total;
      }
    `, 'test.galaxy');
    const prog = galaxySourceToEngineProgram(src, { moduleId: 'T' });
    const body = prog.modules[0]?.functions[0]?.body ?? [];
    const kinds = body.map((s) => s.kind);
    expect(kinds).toContain('EngineWhileStatement');
    const whileIdx = kinds.indexOf('EngineWhileStatement');
    expect(whileIdx).toBeGreaterThan(0); // init assignment precedes while
    const whileStmt = body[whileIdx] as any;
    expect(whileStmt.condition.kind).toBe('EngineBinaryExpression');
    // Last statement in body should be the increment
    expect(whileStmt.body.at(-1)?.kind).toBe('EngineAssignmentStatement');
  });

  it('lowers do-while to one loop with a bottom condition check', () => {
    const src = parseGalaxySource(`
      int CountUp() {
        int i = 0;
        do {
          i += 1;
        } while (i < 3);
        return i;
      }
    `, 'test.galaxy');
    const prog = galaxySourceToEngineProgram(src, { moduleId: 'T' });
    const body = prog.modules[0]?.functions[0]?.body ?? [];
    const kinds = body.map((s) => s.kind);
    expect(kinds).not.toContain('EngineBlockStatement');
    expect(kinds).toContain('EngineWhileStatement');
    const whileIdx = kinds.indexOf('EngineWhileStatement');
    const whileStmt = body[whileIdx] as any;
    expect(whileStmt.condition).toMatchObject({ kind: 'EngineLiteralExpression', value: true });
    expect(whileStmt.body.at(-1)).toMatchObject({ kind: 'EngineIfStatement',
      condition: { kind: 'EngineBinaryExpression' }, then: [],
      else: [{ kind: 'EngineBreakStatement' }] });
  });

  it('for loop with no init or incrementor emits bare while', () => {
    const src = parseGalaxySource(`
      void Spin(bool flag) {
        for (;flag;) { }
      }
    `, 'test.galaxy');
    const prog = galaxySourceToEngineProgram(src, { moduleId: 'T' });
    const body = prog.modules[0]?.functions[0]?.body ?? [];
    expect(body).toHaveLength(1);
    expect(body[0]?.kind).toBe('EngineWhileStatement');
    expect((body[0] as any).body).toHaveLength(0);
  });
});

/** Existing owner AST is the subject; these checks assert loop boundaries, not VM execution. */
function loopFixture(text: string) {
  const parsed = parseGalaxySource(text, 'loops.galaxy');
  expect(parsed.parseDiagnostics).toHaveLength(0);
  const body = galaxySourceToEngineModule(parsed).functions[0].body;
  return body.find((statement: { kind: string }) => statement.kind === 'EngineWhileStatement');
}

describe('loop-local break and continue lowering', () => {
  it.each([
    ['for body local', 'void Run() { int i; for (i=0; i<3; i+=1) { int i=10; continue; } }'],
    ['for branch parameter', 'void Run(int i) { for (i=0; i<3; i+=1) { if (true) { int i=10; continue; } } }'],
    ['for nested while global', 'int i=0; void Run() { for (i=0; i<3; i+=1) { while (true) { int i=10; continue; } } }'],
    ['do body local', 'void Run() { bool again=true; do { bool again=false; continue; } while (again); }'],
    ['do branch global', 'bool again=true; void Run() { do { if (true) { bool again=false; continue; } } while (again); }'],
    ['do nested for global', 'bool again=true; void Run() { int i; do { for (i=0; i<2; i+=1) { bool again=false; continue; } } while (again); }'],
  ])('rejects %s shadowing before executable admission', (_scope, text) => {
    const source = parseGalaxySource(text, 'invalid-scope.galaxy');
    expect(source.parseDiagnostics.map(diagnostic => diagnostic.messageText)).toEqual([
      'Local variables must be declared at the begining of function block',
    ]);
  });

  it('places the for increment before a conditional continue and retains its source span', () => {
    const text = 'void Run() { int i; for (i = 0; i < 3; i += 1) { if (i == 1) { continue; } } }';
    const loop = loopFixture(text);
    const branch = loop.body[0].then;
    expect(branch.map((statement: { kind: string }) => statement.kind))
      .toEqual(['EngineAssignmentStatement', 'EngineContinueStatement']);
    expect(branch[0].target.name).toBe('i');
    expect(text.slice(branch[0].source.span.start, branch[0].source.span.end)).toBe('i += 1');
    expect(loop.body.at(-1).target.name).toBe('i');
  });

  it('excludes the outer for increment from an inner while continue', () => {
    const loop = loopFixture(`void Run() { int i;
      for (i = 0; i < 3; i += 1) { while (Inner()) { continue; } if (Skip()) { continue; } }
    }`);
    expect(loop.body[0].body.map((statement: { kind: string }) => statement.kind))
      .toEqual(['EngineContinueStatement']);
    expect(loop.body[1].then.map((statement: { kind: string }) => statement.kind))
      .toEqual(['EngineAssignmentStatement', 'EngineContinueStatement']);
    expect(loop.body[1].then[0].target.name).toBe('i');
  });

  it('uses only the innermost for increment at its continue site', () => {
    const loop = loopFixture(`void Run() { int i; int j;
      for (i = 0; i < 3; i += 1) { for (j = 0; j < 2; j += 1) { continue; } }
    }`);
    const inner = loop.body.find((statement: { kind: string }) => statement.kind === 'EngineWhileStatement');
    expect(inner.body.slice(0, 2).map((statement: { kind: string }) => statement.kind))
      .toEqual(['EngineAssignmentStatement', 'EngineContinueStatement']);
    expect(inner.body[0].target.name).toBe('j');
    expect(loop.body.at(-1).target.name).toBe('i');
  });

  it('keeps a first-iteration do break inside its loop before evaluating the condition', () => {
    const text = 'void Run() { do { break; } while (Again()); }';
    const loop = loopFixture(text);
    expect(loop.condition).toMatchObject({ kind: 'EngineLiteralExpression', value: true });
    expect(loop.body[0].kind).toBe('EngineBreakStatement');
    expect(text.slice(loop.body[0].source.span.start, loop.body[0].source.span.end)).toBe('break;');
    expect(loop.body.at(-1)).toMatchObject({ kind: 'EngineIfStatement',
      condition: { callee: { name: 'Again' } }, then: [], else: [{ kind: 'EngineBreakStatement' }] });
  });

  it('checks the do condition before continue and keeps the ordinary bottom check', () => {
    const text = 'void Run() { do { if (Skip()) { continue; } Step(); } while (Again()); }';
    const loop = loopFixture(text);
    const branch = loop.body[0].then;
    expect(branch.map((statement: { kind: string }) => statement.kind))
      .toEqual(['EngineIfStatement', 'EngineContinueStatement']);
    expect(branch[0]).toMatchObject({ condition: { callee: { name: 'Again' } }, then: [],
      else: [{ kind: 'EngineBreakStatement' }] });
    expect(loop.body.at(-1)).toEqual(branch[0]);
    expect(text.slice(branch[0].condition.source.span.start, branch[0].condition.source.span.end))
      .toBe('Again()');
  });

  it('does not apply an outer do condition to inner while or for continuation', () => {
    const loop = loopFixture(`void Run() { int i;
      do { while (Inner()) { continue; } for (i = 0; i < 2; i += 1) { continue; } continue; } while (Outer());
    }`);
    expect(loop.body[0].kind).toBe('EngineWhileStatement');
    expect(loop.body[0].body.map((statement: { kind: string }) => statement.kind))
      .toEqual(['EngineContinueStatement']);
    const innerFor = loop.body.find((statement: { kind: string }) => statement.kind === 'EngineWhileStatement'
      && statement !== loop.body[0]);
    expect(innerFor.body[0].target.name).toBe('i');
    expect(innerFor.body[1].kind).toBe('EngineContinueStatement');
    expect(loop.body.at(-3)).toMatchObject({ kind: 'EngineIfStatement',
      condition: { callee: { name: 'Outer' } } });
    expect(loop.body.at(-2).kind).toBe('EngineContinueStatement');
  });
});
