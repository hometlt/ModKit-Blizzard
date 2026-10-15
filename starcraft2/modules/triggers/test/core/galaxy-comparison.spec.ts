import { describe, expect, it } from 'vitest';
import { parseGalaxySource } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/galaxy-to-trigger.js';
import { compareGalaxyPrograms } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/galaxy-comparison.js';

describe('compareGalaxyPrograms', () => {
  it('ignores inert block semicolons but keeps empty control-flow bodies', () => {
    const baseline = parseGalaxySource('void f(bool x) { ping(); }');
    const inert = parseGalaxySource('void f(bool x) { ping(); ; }');
    const emptyBody = parseGalaxySource('void f(bool x) { if (x) ; ping(); }');
    expect(compareGalaxyPrograms(baseline, inert).exact).toBe(true);
    expect(compareGalaxyPrograms(baseline, emptyBody).exact).toBe(false);
  });

  it('treats an explicit empty else as semantically empty', () => {
    const expected = parseGalaxySource('int f(int x) { if (x > 0) { return 1; } else {} return 0; }');
    const actual = parseGalaxySource('int f(int x) { if (x > 0) { return 1; } return 0; }');
    expect(compareGalaxyPrograms(expected, actual)).toMatchObject({ exact: true });
  });

  it('reports changed bodies, signatures, globals, calls and duplicate definitions', () => {
    const expected = parseGalaxySource('int value; int f(int x) { ping(1); return x; }');
    const actual = parseGalaxySource('fixed value; bool f(int x) { ping(2); return true; } bool f(int x) { return false; }');
    const comparison = compareGalaxyPrograms(expected, actual);
    expect(comparison.exact).toBe(false);
    expect(comparison.functions.differing).toEqual(['f']);
    expect(comparison.functions.duplicateActual).toEqual(['f']);
    expect(comparison.signatures.differing).toEqual(['f']);
    expect(comparison.declarations.differing).toEqual(['value']);
    expect(comparison.calls).toMatchObject({ exact: false, missingCount: 1, addedCount: 1 });
    expect(comparison.functions.differenceSamples[0]).toMatchObject({ name: 'f', path: expect.stringContaining('$') });
  });

  it('compares trigger registrations independently from other calls', () => {
    const expected = parseGalaxySource('void f() { TriggerAddEventTimePeriodic(gt_Run, 1.0, c_timeGame); ping(1); }');
    const actual = parseGalaxySource('void f() { TriggerAddEventTimePeriodic(gt_Run, 2.0, c_timeGame); ping(1); }');
    expect(compareGalaxyPrograms(expected, actual).triggerRegistrations)
      .toMatchObject({ exact: false, missingCount: 1, addedCount: 1 });
  });

  it('reports call-name inventory separately from argument differences', () => {
    const expected = parseGalaxySource('void f() { ping(1); pong(); }');
    const changedArgument = parseGalaxySource('void f() { ping(2); pong(); }');
    const missingOperation = parseGalaxySource('void f() { ping(1); }');
    expect(compareGalaxyPrograms(expected, changedArgument)).toMatchObject({
      calls: { exact: false }, callees: { exact: true },
    });
    expect(compareGalaxyPrograms(expected, missingOperation)).toMatchObject({
      callees: { exact: false, missingCount: 1, addedCount: 0 },
    });
  });

  it('canonicalizes only the proven map trigger namespace', () => {
    const expected = parseGalaxySource('bool libMap_gt_Run_Func(bool a, bool b) { return true; }');
    const actual = parseGalaxySource('bool gt_Run_Func(bool a, bool b) { return true; }');
    expect(compareGalaxyPrograms(expected, actual, { implicitLibrary: true })).toMatchObject({ exact: true });
  });

  it('preserves names belonging to other libraries in implicit map documents', () => {
    const expected = parseGalaxySource('void libMap_gt_Run() { libOther_gt_Target(); }');
    const wrongLibrary = parseGalaxySource('void libMap_gt_Run() { libAnother_gt_Target(); }');
    expect(compareGalaxyPrograms(expected, wrongLibrary, { implicitLibrary: true }).exact).toBe(false);
  });

  it('canonicalizes parameter and local spelling without hiding a wrong binding', () => {
    const expected = parseGalaxySource('void f(int t) { int left; int right; left = t; ping(left); }');
    const renamed = parseGalaxySource('void f(int eventTarget) { int first; int second; first = eventTarget; ping(first); }');
    const wrong = parseGalaxySource('void f(int eventTarget) { int first; int second; first = eventTarget; ping(second); }');
    expect(compareGalaxyPrograms(expected, renamed)).toMatchObject({
      functions: { differing: [] }, calls: { exact: true }, exact: true,
    });
    expect(compareGalaxyPrograms(expected, wrong)).toMatchObject({
      functions: { differing: ['f'] }, calls: { exact: false }, exact: false,
    });
  });

  it('matches named locals when editor auto variables move between declaration sections', () => {
    const expected = parseGalaxySource(`
      void f(int sourceId) {
        int left;
        int right;
        left = sourceId;
        right = sourceId;
        TriggerEnable(right, false);
      }
    `);
    const reordered = parseGalaxySource(`
      void f(int actorId) {
        int right;
        int left;
        left = actorId;
        right = actorId;
        TriggerEnable(right, false);
      }
    `);
    const wrong = parseGalaxySource(`
      void f(int actorId) {
        int right;
        int left;
        left = actorId;
        right = actorId;
        TriggerEnable(left, false);
      }
    `);
    expect(compareGalaxyPrograms(expected, reordered)).toMatchObject({
      functions: { differing: [] }, triggerRegistrations: { exact: true }, exact: true,
    });
    expect(compareGalaxyPrograms(expected, wrong)).toMatchObject({
      triggerRegistrations: { exact: false }, exact: false,
    });
  });

  it('pairs regenerated auto loop variables by use rather than declaration order', () => {
    const expected = parseGalaxySource('void f() { int autoAAAA_g; int autoBBBB_g; autoBBBB_g = 1; ping(autoBBBB_g); autoAAAA_g = 2; ping(autoAAAA_g); }');
    const renamed = parseGalaxySource('void f() { int autoXXXX_g; int autoYYYY_g; autoXXXX_g = 1; ping(autoXXXX_g); autoYYYY_g = 2; ping(autoYYYY_g); }');
    const wrong = parseGalaxySource('void f() { int autoXXXX_g; int autoYYYY_g; autoXXXX_g = 1; ping(autoYYYY_g); autoYYYY_g = 2; ping(autoXXXX_g); }');
    expect(compareGalaxyPrograms(expected, renamed).exact).toBe(true);
    expect(compareGalaxyPrograms(expected, wrong).exact).toBe(false);
  });

  it('folds boolean literal negation without hiding non-literal negation', () => {
    const expected = parseGalaxySource('bool f() { return false; } bool g(bool x) { return x; }');
    const folded = parseGalaxySource('bool f() { return !true; } bool g(bool x) { return x; }');
    const changed = parseGalaxySource('bool f() { return !true; } bool g(bool x) { return !x; }');
    expect(compareGalaxyPrograms(expected, folded)).toMatchObject({ exact: true });
    expect(compareGalaxyPrograms(expected, changed)).toMatchObject({
      functions: { differing: ['g'] }, exact: false,
    });
  });

  it('folds literal boolean comparisons but not variable comparisons', () => {
    const expected = parseGalaxySource('bool f(bool x) { if (true) { return x; } return false; }');
    const literal = parseGalaxySource('bool f(bool x) { if (true == true) { return x; } return false; }');
    const variable = parseGalaxySource('bool f(bool x) { if (x == true) { return x; } return false; }');
    expect(compareGalaxyPrograms(expected, literal).exact).toBe(true);
    expect(compareGalaxyPrograms(expected, variable).exact).toBe(false);
  });

  it('matches integral fixed Color arguments without erasing arithmetic type differences', () => {
    const expected = parseGalaxySource('void f() { Color(0, 0, 0); ColorWithAlpha(0, 0, 0, 1); }');
    const formatted = parseGalaxySource('void f() { Color(0.00, 0.00, 0.00); ColorWithAlpha(0.00, 0.00, 0.00, 1.00); }');
    const arithmetic = parseGalaxySource('void f() { Color(0.00 / 2.00, 0.00, 0.00); ColorWithAlpha(0.00, 0.00, 0.00, 1.00); }');
    const genericInteger = parseGalaxySource('void g() { ping(0); }');
    const genericFixed = parseGalaxySource('void g() { ping(0.00); }');
    expect(compareGalaxyPrograms(expected, formatted).exact).toBe(true);
    expect(compareGalaxyPrograms(expected, arithmetic).exact).toBe(false);
    expect(compareGalaxyPrograms(genericInteger, genericFixed).exact).toBe(false);
  });
});
