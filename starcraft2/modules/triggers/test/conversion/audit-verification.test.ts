import { describe, expect, it } from 'vitest'
import { Parser, TypeChecker, bindSourceFile } from '@modkit/blizzard-starcraft2/galaxy/language-core'
import { compareGalaxyPrograms, convertGalaxyToTriggers, convertTriggersToGalaxy } from '../../../../dist/modules/triggers/services/galaxy-conversion/index.js'
import { validateGalaxyPair } from '../../../../dist/modules/triggers/services/galaxy-conversion/validation.js'
import { resolveGalaxyTypeAliases } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-type-resolution.js'
import { parseGalaxySource, convertGalaxyToTriggerLibrary, resetGalaxyToTriggerIdCounter } from '../../../../dist/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.js'
import { serializeTriggerLibrary } from '../../../../dist/modules/triggers/shared/trigger-document/trigger-xml.js'

const parse = (text: string) => new Parser().parseFile('file:///audit.galaxy', text)
function coreErrors(text: string) {
  const ast = parse(text)
  expect(ast.parseDiagnostics).toEqual([])
  const host = {
    documents: new Map([[ast.fileName, ast]]), qualifiedDocuments: new Map(),
    resolveGlobalSymbol: (name: string) => ast.symbol?.members?.get(name),
  }
  bindSourceFile(ast, host)
  return new TypeChecker(host).checkSourceFile(ast)!.filter(d => d.category === 1)
}
const validate = (text: string) => validateGalaxyPair([{ fileName: 'audit.galaxy', text }])
const forward = (script: string) => {
  const id = '00000001'
  const library: any = {
    id: 'TEST', items: [{ type: 'CustomScript', id, library: 'TEST' }],
    elements: { [id]: { type: 'CustomScript', id, library: 'TEST', scriptCode: script } }, elementsByType: {},
  }
  return convertTriggersToGalaxy(serializeTriggerLibrary(library), {
    libraryId: 'TEST', galaxyDeclarations: [{ fileName: 'native.galaxy', text: 'void libNtve_InitVariables();' }],
  })
}

describe('independent Galaxy conversion audit regressions', () => {
  it.each([
    'bool f(){return 1 == "a";}', 'bool f(){return true + false;}',
    'bool f(){return !1;}', 'void f(){int x=1;x%= "s";}',
    'void f(){int x=1;x&= "s";}', 'void f(){int x=1;x|= "s";}',
    'void f(){int x=1;x^= "s";}', 'void f(){int x=1;x<<= "s";}',
    'void f(){int x=1;x>>= "s";}', 'int f(){return null;}',
    'bool f(){return 1 && 2;}', 'void f(){break;}', 'void f(){continue;}',
    'int f(){int x;}', 'int f(){return "changed";}',
  ])('rejects core-invalid source through production: %s', async script => {
    expect(coreErrors(script).length).toBeGreaterThan(0)
    expect(validate(script).verification.status).toBe('failed')
    const result = await forward(script)
    expect(result.fidelity.verification.galaxyValidation.status).toBe('failed')
    expect(result.fidelity.completeness).toBe('partial')
  })

  it.each(['bool f(){return 1 == "a";}', 'bool f(){return true + false;}', 'bool f(){return !1;}', 'int f(){return null;}'])('retains source and output validation failures through reverse conversion: %s', async script => {
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script, header: '' })
    expect(result.fidelity.verification.sourceGalaxyValidation.status).toBe('failed')
    expect(result.fidelity.verification.galaxyValidation.status).toBe('failed')
    expect(result.fidelity.completeness).toBe('partial')
  })

  it.each([
    'byte f(){return 1;}', 'int f(byte value){return value;}',
    'fixed f(byte value){return value;}', 'byte f(int value){return value;}',
    'int f(){if(1){return 1;}else{return 2;}}',
    'void f(){while(1){break;}for(;1;){continue;}do{}while(0);}',
    'bool f(){return true < false;}', 'int f(){return !1;}',
    'string f(){return !"a";}', 'string f(){return "a"+"b";}',
    'bool f(){return (true && false) || true;}', 'string f(){return null;}',
  ])('accepts core-valid source through production: %s', async script => {
    expect(coreErrors(script)).toEqual([])
    expect(validate(script).verification.status).toBe('passed')
    const result = await forward(script)
    expect(result.fidelity.verification.galaxyValidation.status).toBe('passed')
    expect(result.fidelity.completeness).toBe('complete')
  })

  it.each(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '==', '!=', '<', '<=', '>', '>=', '&&', '||'])('matches the core for operator %s', operator => {
    const result = ['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(operator) ? 'bool' : 'int'
    for (const [left, right] of [['1', '2'], ['1', '"s"'], ['true', 'false'], ['1.5', '2']]) {
      const script = `${result} f(){return (${left}) ${operator} (${right});}`
      expect(validate(script).verification.status === 'failed', script).toBe(coreErrors(script).length > 0)
    }
  })

  it('retains validation failure after displayed diagnostics are capped', async () => {
    const result = await forward('int f(){' + Array.from({ length: 1001 }, (_, i) => `Missing${i}();`).join('') + 'return "wrong";}')
    expect(result.fidelity.unsupported.count).toBe(0)
    expect(result.fidelity.dropped.count).toBe(0)
    expect(result.fidelity.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    expect(result.fidelity.verification.galaxyValidation).toMatchObject({ status: 'failed', errors: 1, diagnosticsOmitted: 2 })
    expect(result.fidelity.completeness).toBe('partial')
  })

  it('rejects typedef mutations and syntactically invalid exact comparisons', () => {
    expect(compareGalaxyPrograms(parse('typedef int T;T x;'), parse('typedef int T;T x;')).exact).toBe(true)
    expect(compareGalaxyPrograms(parse('typedef int T;T x;'), parse('typedef string T;T x;')).exact).toBe(false)
    expect(compareGalaxyPrograms(parse('typedef int T;'), parse('')).exact).toBe(false)
    const result = compareGalaxyPrograms(parse('int f(){return 1;}'), parse('int f(){return 1;} @'))
    expect(result.syntaxValid).toBe(false)
    expect(result.exact).toBe(false)
  })

  it('handles a long alias chain through the public converter without a stack overflow', async () => {
    const length = 12800
    const script = Array.from({ length }, (_, i) => i === length - 1 ? `typedef int A${i};` : `typedef A${i + 1} A${i};`).join('\n') + '\nvoid Run(){}'
    const result = await convertGalaxyToTriggers({ libraryId: 'TEST', script, header: '' })
    expect(result.fidelity.verification.sourceGalaxyValidation.errors).toBe(0)
    expect(result.fidelity.verification.generatedTriggerDataReparsed).toBe(true)
  })

  it('counts actual normalization work for shared, wrapped alias chains', () => {
    for (const length of [100, 200, 400, 800, 1600]) {
      const ast = parse(Array.from({ length }, (_, i) => i === length - 1 ? `typedef int A${i};` : `typedef A${i + 1}[1] A${i};`).join('\n'))
      expect(ast.parseDiagnostics).toEqual([])
      const stats = resolveGalaxyTypeAliases(ast.statements)
      expect(stats.aliasesResolved).toBe(length)
      expect(stats.syntaxNodesVisited).toBeLessThanOrEqual(length * 6)
      expect(stats.typeResolutions).toBeLessThanOrEqual(length * 4)
    }
  })

  it.each(['typedef B A;typedef A B;', 'typedef A A;', 'typedef B[1] A;typedef A B;'])('preserves unused/cyclic alias diagnosis: %s', text => {
    expect(() => resolveGalaxyTypeAliases(parse(text).statements)).toThrow('Cyclic typedef')
  })

  const input = { libraryId: 'TEST', script: 'int f(int x){int a=1;int b=2;a+=b;return a+x;}', header: '' }
  it('keeps concurrent and progress-reentrant public conversions deterministic', async () => {
    const baseline = await convertGalaxyToTriggers(input)
    const results = await Promise.all(Array.from({ length: 12 }, () => convertGalaxyToTriggers(input)))
    expect(results.every(r => r.output.triggerData === baseline.output.triggerData)).toBe(true)
    let nested: ReturnType<typeof convertGalaxyToTriggers> | undefined
    const outer = await convertGalaxyToTriggers({ ...input, onProgress: event => {
      if (!nested && event.phase === 'reconstruct') nested = convertGalaxyToTriggers(input)
    } })
    expect(outer.output.triggerData).toBe(baseline.output.triggerData)
    expect((await nested!).output.triggerData).toBe(baseline.output.triggerData)
  })

  it.each([false, true])('isolates synchronous internal reentry, including callback failure=%s', async throwAfterNested => {
    const baseline = await convertGalaxyToTriggers(input)
    let fired = false
    const result = await convertGalaxyToTriggers({ ...input, onProgress: event => {
      if (!fired && event.phase === 'reconstruct' && event.stage === 'bodies') {
        fired = true
        resetGalaxyToTriggerIdCounter()
        convertGalaxyToTriggerLibrary(parseGalaxySource(input.script), parseGalaxySource(''), { libraryId: 'NEST' })
        if (throwAfterNested) throw new Error('telemetry failure')
      }
    } })
    expect(fired).toBe(true)
    expect(result.output.triggerData).toBe(baseline.output.triggerData)
    expect(result.output.triggerStrings).toBe(baseline.output.triggerStrings)
  })
})
