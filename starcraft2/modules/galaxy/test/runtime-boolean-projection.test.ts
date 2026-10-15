import { describe, expect, it } from 'vitest'
import { projectGalaxyBooleanSource } from '../services/runtime/boolean-projection.js'

describe('Galaxy Runtime projection', () => {
  it('uses the existing parser and keeps original symbol and source line', () => {
    const lowered = projectGalaxyBooleanSource('bool Flip(bool enabled) {\n  return !enabled;\n}')
    expect(lowered.state).toBe('lowered')
    if (lowered.state !== 'lowered') return
    expect(lowered.symbols).toEqual([{ galaxy: 'Flip', uvb: 'g466c6970', line: 1 }])
    expect(lowered.luau).toContain('return (not p0)')
    expect(lowered.sourceMap).toEqual([
      { luauLine: 1, nativeLine: 1 }, { luauLine: 2, nativeLine: 2 },
    ])
  })

  it('refuses the whole file when one function needs unavailable semantics', () => {
    const lowered = projectGalaxyBooleanSource(`bool Flip(bool x) { return !x; }
int Inc(int x) { return x + 1; }`)
    expect(lowered.state).toBe('refused')
    if (lowered.state !== 'refused') return
    expect(lowered.refusals).toMatchObject([{ rule: 'unsupported-type', unit: 'Inc', line: 2 }])
    expect(lowered.refusals[0]?.fragment).toContain('int Inc')
  })

  it('maps each projected function back to its own Galaxy lines', () => {
    const lowered = projectGalaxyBooleanSource(`bool First(bool x) { return x; }
bool Second(bool y) {
  return !y;
}`)
    expect(lowered.state).toBe('lowered')
    if (lowered.state !== 'lowered') return
    expect(lowered.sourceMap).toEqual([
      { luauLine: 1, nativeLine: 1 }, { luauLine: 2, nativeLine: 1 },
      { luauLine: 5, nativeLine: 2 }, { luauLine: 6, nativeLine: 3 },
    ])
  })

  it('projects typed locals, early returns and calls with native source lines', () => {
    const lowered = projectGalaxyBooleanSource([
      '// 🌍',
      'bool Flip(bool value) { return !value; }',
      'bool Choose(bool enabled) {',
      '  bool chosen = enabled;',
      '  if (chosen) { return Flip(chosen); }',
      '  chosen = Flip(chosen);',
      '  return chosen;',
      '}',
    ].join('\r\n'))
    expect(lowered.state).toBe('lowered')
    if (lowered.state !== 'lowered') return
    expect(lowered.symbols.map(symbol => [symbol.galaxy, symbol.line]))
      .toEqual([['Flip', 2], ['Choose', 3]])
    expect(lowered.luau).toContain('local l1: boolean = p0')
    expect(lowered.luau).toContain('return g466c6970(l1)')
    const assignment = lowered.luau.split('\n').findIndex(line => line.trim() === 'l1 = g466c6970(l1)') + 1
    expect(lowered.sourceMap).toContainEqual({ luauLine: assignment, nativeLine: 6 })
  })

  it.each([
    'bool Run(bool value) { bool again = true; for (again = true; again; again = false) { continue; } return value; }',
    'bool Run(bool value) { do { break; } while (value); return value; }',
    'bool Run(bool value) { do { value = false; continue; } while (value); return value; }',
    'bool Run(bool value) { while (value) { value = false; if (!value) { continue; } break; } return value; }',
  ])('uses the canonical loop normalization: %s', source => {
    expect(projectGalaxyBooleanSource(source).state).toBe('lowered')
  })

  it.each([
    ['bool Run(bool value) { bool missing; return missing; }', 'unsupported-body'],
    ['bool Run(bool value) { return unknown; }', 'unsupported-expression'],
    ['bool Run(bool value) { return 1; }', 'unsupported-expression'],
    ['bool Run(bool value) { value += true; return value; }', 'unsupported-body'],
    ['bool Run(bool value) { const bool copy = true; copy = false; return copy; }', 'unsupported-body'],
    ['bool Run(bool value) { value == true; return value; }', 'galaxy-parse'],
    ['bool Run(bool value) { break; return value; }', 'unsupported-body'],
    ['bool Run(bool value) { continue; return value; }', 'unsupported-body'],
    ['native bool Native(bool value);', 'unsupported-body'],
    ['bool Helper(bool value) { return value; } bool Run(bool Helper) { return Helper(true); }', 'unsupported-expression'],
    ['bool Helper(bool value) { return value; } bool Run(bool value) { return Helper(); }', 'unsupported-expression'],
  ])('retains a typed refusal for unavailable semantics: %s', (source, rule) => {
    const result = projectGalaxyBooleanSource(source)
    expect(result.state).toBe('refused')
    expect(result.refusals.some(refusal => refusal.rule === rule && refusal.fragment.length > 0)).toBe(true)
  })

  it('discards a failed function emission without corrupting later source mappings', () => {
    const result = projectGalaxyBooleanSource(`bool Bad(bool x) { bool copy = x; copy = missing; return copy; }
bool Good(bool x) { return x; }`)
    expect(result.state).toBe('refused')
    expect(result.loweredUnits).toBe(1)
    expect(result.luau).not.toContain('local')
    expect(result.sourceMap).toEqual([
      { luauLine: 1, nativeLine: 2 }, { luauLine: 2, nativeLine: 2 },
    ])
    expect(result.refusals[0]).toMatchObject({ unit: 'Bad', fragment: 'missing' })
  })

  it('does not drop unsupported code after an early return', () => {
    const result = projectGalaxyBooleanSource('bool Run(bool x) { return x; x = missing; return false; }')
    expect(result.state).toBe('refused')
    expect(result.loweredUnits).toBe(0)
    expect(result.refusals[0]).toMatchObject({ rule: 'unsupported-expression', fragment: 'missing' })
  })
})
