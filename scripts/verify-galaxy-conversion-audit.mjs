// Independent review probes. Exits nonzero if an audited invariant regresses.
// The same findings are also covered by the normal audit-verification suite.
import assert from 'node:assert/strict'
import { Parser, TypeChecker, bindSourceFile } from '@modkit/blizzard-starcraft2/galaxy/language-core'
import { compareGalaxyPrograms, convertGalaxyToTriggers, convertTriggersToGalaxy } from '../starcraft2/dist/modules/triggers/services/galaxy-conversion/index.js'
import { validateGalaxyPair } from '../starcraft2/dist/modules/triggers/services/galaxy-conversion/validation.js'
import { resolveGalaxyTypeAliases } from '../starcraft2/dist/modules/triggers/services/galaxy-conversion/internal/galaxy-type-resolution.js'
import { parseGalaxySource, convertGalaxyToTriggerLibrary, resetGalaxyToTriggerIdCounter } from '../starcraft2/dist/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.js'
import { serializeTriggerLibrary } from '../starcraft2/dist/modules/triggers/shared/trigger-document/trigger-xml.js'

let passed = 0, failed = 0
async function check(name, action) {
  try { await action(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`) }
}
const parse = text => new Parser().parseFile('file:///audit.galaxy', text)
function coreErrors(text) {
  const ast = parse(text)
  assert.equal(ast.parseDiagnostics.length, 0)
  const host = {
    documents: new Map([[ast.fileName, ast]]), qualifiedDocuments: new Map(),
    resolveGlobalSymbol: name => ast.symbol?.members?.get(name),
  }
  bindSourceFile(ast, host)
  return new TypeChecker(host).checkSourceFile(ast).filter(d => d.category === 1)
}
const validation = text => validateGalaxyPair([{ fileName: 'audit.galaxy', text }])
async function forward(script) {
  const id = '00000001'
  const library = {
    id: 'TEST', items: [{ type: 'CustomScript', id, library: 'TEST' }],
    elements: { [id]: { type: 'CustomScript', id, library: 'TEST', scriptCode: script } },
    elementsByType: {},
  }
  return convertTriggersToGalaxy(serializeTriggerLibrary(library), {
    libraryId: 'TEST', galaxyDeclarations: [{ fileName: 'native.galaxy', text: 'void libNtve_InitVariables();' }],
  })
}

for (const script of ['bool f(){return 1 && 2;}', 'void f(){break;}', 'void f(){continue;}', 'int f(){int x;}', 'int f(){return "changed";}']) {
  await check(`original invalid case: ${script}`, async () => {
    assert.ok(coreErrors(script).length > 0)
    assert.equal(validation(script).verification.status, 'failed')
    assert.equal((await forward(script)).fidelity.completeness, 'partial')
  })
}
await check('bool relational comparison agrees with core', () => {
  const script = 'bool f(){return true < false;}'
  assert.equal(coreErrors(script).length, 0)
  assert.equal(validation(script).verification.status, 'passed')
})
await check('include and initializer mutations are rejected', () => {
  assert.equal(compareGalaxyPrograms(parse('include "One"'), parse('include "Two"')).exact, false)
  const a = 'native int Next(); int a=Next(); int b=Next();'
  const b = 'native int Next(); int b=Next(); int a=Next();'
  assert.equal(compareGalaxyPrograms(parse(a), parse(b)).exact, false)
})
await check('unused, self, and wrapped alias cycles remain diagnosed', () => {
  for (const text of ['typedef B A;typedef A B;', 'typedef A A;', 'typedef B[1] A;typedef A B;']) {
    const ast = parse(text)
    assert.equal(ast.parseDiagnostics.length, 0)
    assert.throws(() => resolveGalaxyTypeAliases(ast.statements), /Cyclic typedef/)
  }
})
await check('alias conflicts remain diagnosed', () => {
  assert.throws(() => resolveGalaxyTypeAliases(parse('typedef int A;typedef string A;').statements), /Conflicting typedef/)
})
await check('wide aliases and shared-tail references resolve once', () => {
  const text = 'typedef int Base;' + Array.from({ length: 200 }, (_, i) => `typedef Base A${i};A${i} value${i};`).join('')
  const ast = parse(text)
  assert.equal(ast.parseDiagnostics.length, 0)
  const stats = resolveGalaxyTypeAliases(ast.statements)
  assert.equal(stats.aliasesResolved, 201)
  assert.ok(stats.aliasLookups < 1000)
})
await check('late error survives diagnostic cap in completeness', async () => {
  const r = await forward('int f(){' + Array.from({ length: 1001 }, (_, i) => `Missing${i}();`).join('') + 'return "wrong";}')
  assert.equal(r.fidelity.unsupported.count, 0)
  assert.equal(r.fidelity.dropped.count, 0)
  assert.equal(r.fidelity.diagnostics.filter(d => d.severity === 'error').length, 0)
  assert.equal(r.fidelity.verification.galaxyValidation.errors, 1)
  assert.equal(r.fidelity.completeness, 'partial')
})

for (const script of ['bool f(){return 1 == "a";}', 'bool f(){return true + false;}', 'bool f(){return !1;}', 'void f(){int x=1;x%= "s";}']) {
  await check(`validator rejects core-invalid operator: ${script}`, async () => {
    assert.ok(coreErrors(script).length > 0)
    const r = await forward(script)
    assert.equal(r.fidelity.verification.galaxyValidation.status, 'failed')
    assert.equal(r.fidelity.completeness, 'partial')
    if (!script.includes('%=')) {
      const reverse = await convertGalaxyToTriggers({ libraryId: 'TEST', script, header: '' })
      assert.equal(reverse.fidelity.verification.sourceGalaxyValidation.status, 'failed')
      assert.equal(reverse.fidelity.verification.galaxyValidation.status, 'failed')
      assert.equal(reverse.fidelity.completeness, 'partial')
    }
  })
}
for (const script of ['byte f(){return 1;}', 'int f(){if(1){return 1;}else{return 2;}}']) {
  await check(`validator accepts core-valid source: ${script}`, async () => {
    assert.equal(coreErrors(script).length, 0)
    assert.equal((await forward(script)).fidelity.verification.galaxyValidation.status, 'passed')
  })
}
await check('null is not assignable to int', async () => {
  const script = 'int f(){return null;}'
  assert.ok(coreErrors(script).length > 0)
  assert.equal((await forward(script)).fidelity.verification.galaxyValidation.status, 'failed')
  assert.equal((await convertGalaxyToTriggers({ libraryId: 'TEST', script, header: '' })).fidelity.verification.sourceGalaxyValidation.status, 'failed')
})
await check('typedef type mutation is not exact', () => {
  assert.equal(compareGalaxyPrograms(parse('typedef int T; T x;'), parse('typedef string T; T x;')).exact, false)
})
await check('parse errors cannot produce exact verification', () => {
  assert.equal(compareGalaxyPrograms(parse('int f(){return 1;}'), parse('int f(){return 1;} @')).exact, false)
})
await check('long alias input does not overflow public converter', async () => {
  const length = 12800
  const script = Array.from({ length }, (_, i) => i === length - 1 ? `typedef int A${i};` : `typedef A${i + 1} A${i};`).join('\n') + '\nvoid Run(){}'
  await convertGalaxyToTriggers({ libraryId: 'TEST', script, header: '' })
})
await check('wrapped aliases have linear structural traversal work', () => {
  const visits = length => {
    const ast = parse(Array.from({ length }, (_, i) => i === length - 1 ? `typedef int A${i};` : `typedef A${i + 1}[1] A${i};`).join('\n'))
    assert.equal(ast.parseDiagnostics.length, 0)
    const stats = resolveGalaxyTypeAliases(ast.statements)
    assert.ok(Number.isInteger(stats.syntaxNodesVisited), 'resolver must count actual normalization work')
    console.log(JSON.stringify({ length, typeResolutions: stats.typeResolutions, structuralVisits: stats.syntaxNodesVisited }))
    return stats.syntaxNodesVisited
  }
  const small = visits(200), large = visits(400)
  assert.ok(large <= small * 2.3, `doubling input caused ${(large / small).toFixed(2)}x structural visits`)
})

const input = { libraryId: 'TEST', script: 'int f(int x){int a=1;int b=2;a+=b;return a+x;}', header: '' }
const baseline = await convertGalaxyToTriggers(input)
await check('12 concurrent public conversions are deterministic', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => convertGalaxyToTriggers(input)))
  assert.ok(results.every(r => r.output.triggerData === baseline.output.triggerData))
})
await check('public progress reentry is deterministic', async () => {
  let nested
  const outer = await convertGalaxyToTriggers({ ...input, onProgress: e => {
    if (!nested && e.phase === 'reconstruct') nested = convertGalaxyToTriggers(input)
  } })
  assert.equal(outer.output.triggerData, baseline.output.triggerData)
  assert.equal((await nested).output.triggerData, baseline.output.triggerData)
})
await check('synchronous internal progress reentry does not change outer IDs', async () => {
  let fired = false
  const outer = await convertGalaxyToTriggers({ ...input, onProgress: e => {
    if (!fired && e.phase === 'reconstruct' && e.stage === 'bodies') {
      fired = true
      resetGalaxyToTriggerIdCounter()
      convertGalaxyToTriggerLibrary(parseGalaxySource(input.script), parseGalaxySource(''), { libraryId: 'NEST' })
    }
  } })
  assert.ok(fired)
  assert.ok(outer.output.triggerData === baseline.output.triggerData, 'outer TriggerData IDs changed')
})
console.log(`\n${passed} passed; ${failed} failed`)
process.exitCode = failed ? 1 : 0
