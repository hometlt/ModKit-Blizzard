/** Canonical native signatures and bootstrap/function call provenance for Runtime admission. */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { parseGalaxySource } from '@modkit/blizzard-starcraft2/galaxy/analysis/source.js'
import { galaxySourceToEngineModule } from '@modkit/blizzard-starcraft2/galaxy/analysis/to-engine.js'
import { analyzeGalaxyRuntimeClosure } from '../services/galaxy-runtime-closure.ts'
import type { EngineModule } from '@modkit/blizzard-starcraft2/galaxy/analysis/to-engine-types.js'

/** Parse the fixture with the Galaxy owner; the Runtime view adds no type or syntax model. */
function moduleFrom(text: string, fileName = 'MapScript.galaxy'): EngineModule {
  const parsed = parseGalaxySource(text, { fileName })
  assert.equal(parsed.parseDiagnostics.length, 0)
  return galaxySourceToEngineModule(parsed)
}

describe('Runtime native declaration and call-site witnesses', () => {
  it('retains canonical signatures and every initializer/function call origin', () => {
    const text = `
      native int ReadValue(fixed amount, int player);
      int unused = ReadValue(1.0, 2);
      int combined = ReadValue(2.0, 2) + ReadValue(3.0, 2);
      void Helper() { ReadValue(4.0, 2); }
      void InitMap() { ReadValue(5.0, 2); Helper(); ReadValue(6.0, 2); }
    `
    const module = moduleFrom(text)
    const result = analyzeGalaxyRuntimeClosure(module, 'InitMap')
    const [call] = result.externalCalls
    assert.ok(call)
    assert.equal(call.name, 'ReadValue')
    assert.equal(call.reason, 'unmapped-native')
    assert.equal(call.nativeDeclarations.length, 1)
    const [declaration] = call.nativeDeclarations
    assert.ok(declaration?.returnType)
    assert.equal(declaration, module.functions[0], 'Signatures remain canonical owner AST witnesses')
    assert.equal(declaration.returnType.name, 'int')
    assert.deepEqual(declaration.parameters.map(item => [item.name, item.type?.name]),
      [['amount', 'fixed'], ['player', 'int']])
    assert.equal(call.callSites.length, 6)
    assert.deepEqual(call.callSites.map(site => [site.origin, site.owner]), [
      ['global-initializer', 'unused'], ['global-initializer', 'combined'],
      ['global-initializer', 'combined'], ['function', 'InitMap'],
      ['function', 'Helper'], ['function', 'InitMap'],
    ])
    for (const site of call.callSites) {
      assert.equal(site.source?.fileName, 'MapScript.galaxy')
      assert.ok(site.span)
      assert.match(text.slice(site.span.start, site.span.end), /^ReadValue\(/u)
    }
    assert.deepEqual(call.source, call.callSites[0]?.source)
    assert.deepEqual(call.span, call.callSites[0]?.span)
    assert.ok(Object.isFrozen(call.nativeDeclarations))
    assert.ok(Object.isFrozen(call.callSites))
    assert.deepEqual(result.initializerCalls.map(site => [site.name, site.owner]), [
      ['ReadValue', 'unused'], ['ReadValue', 'combined'], ['ReadValue', 'combined'],
    ])
  })

  it('keeps conflicting declarations and repeated unknown calls without invented signatures', () => {
    const source = moduleFrom(`
      native int Known(int value);
      void InitMap() { Known(1); Missing(); Missing(); }
    `)
    const dependency = moduleFrom('native int Known(fixed value);', 'Shared.galaxy')
    const result = analyzeGalaxyRuntimeClosure(source, 'InitMap', { dependencies: [dependency] })
    const known = result.externalCalls.find(call => call.name === 'Known')
    assert.ok(known)
    assert.equal(known.reason, 'conflicting-native-signatures')
    assert.deepEqual(known.nativeDeclarations.map(declaration => [
      declaration.source?.fileName, declaration.returnType?.name,
      declaration.parameters.map(parameter => parameter.type?.name),
    ]), [['MapScript.galaxy', 'int', ['int']], ['Shared.galaxy', 'int', ['fixed']]])
    const missing = result.externalCalls.find(call => call.name === 'Missing')
    assert.ok(missing)
    assert.equal(missing.reason, 'unknown-call')
    assert.deepEqual(missing.nativeDeclarations, [])
    assert.equal(missing.callSites.length, 2)
    assert.ok(missing.callSites.every(site => site.origin === 'function' && site.owner === 'InitMap'))
  })

  it('keeps a helper invoked by an unused initializer even when no external call exists', () => {
    const result = analyzeGalaxyRuntimeClosure(moduleFrom(`
      int unused = InitializeValue();
      int inert = 7;
      int InitializeValue() { return 3; }
      void InitMap() {}
    `), 'InitMap')
    assert.deepEqual(result.externalCalls, [])
    assert.deepEqual(result.functions, ['InitMap', 'InitializeValue'])
    assert.deepEqual(result.initializerCalls.map(call => [call.name, call.owner, call.origin]),
      [['InitializeValue', 'unused', 'global-initializer']])
    assert.equal(result.initializerCalls[0]?.source?.fileName, 'MapScript.galaxy')
  })
})
