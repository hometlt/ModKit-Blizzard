import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGalaxySource } from '@modkit/blizzard-starcraft2/galaxy/analysis/source.js'
import { galaxySourceToEngineModule } from '@modkit/blizzard-starcraft2/galaxy/analysis/to-engine.js'
import { analyzeGalaxyRuntimeClosure } from '../services/galaxy-runtime-closure.ts'

const analyze = (text, entry = 'InitMap') => {
  const parsed = parseGalaxySource(text, { fileName: 'MapScript.galaxy' })
  assert.equal(parsed.parseDiagnostics.length, 0)
  return analyzeGalaxyRuntimeClosure(galaxySourceToEngineModule(parsed), entry)
}

test('runtime closure keeps reachable calls, globals and module initialization', () => {
  const result = analyze(`
    include "Lib.galaxy";
    int unused = NativeInit();
    int counter;
    void Extra() { NativeExtra(); }
    void Callback() { Extra(); }
    void StringCallback() { NativeStringCallback(); }
    void Step() { counter = counter + ExternalValue; NativeTick(counter); }
    void InitMap() { Step(); Register(Callback); TriggerCreate("StringCallback"); }
  `)
  assert.deepEqual(result.functions, ['Callback', 'Extra', 'InitMap', 'Step', 'StringCallback'])
  assert.deepEqual(result.globals, ['counter'])
  assert.deepEqual(result.functionReferences.map(item => item.name),
    ['Callback', 'StringCallback'])
  assert.deepEqual(result.functionReferences.map(item => item.via), ['identifier', 'string'])
  assert.deepEqual(result.initializedGlobals, ['unused'])
  assert.deepEqual(result.externalCalls.map(item => item.name),
    ['NativeExtra', 'NativeInit', 'NativeStringCallback', 'NativeTick', 'Register', 'TriggerCreate'])
  assert.ok(result.externalCalls.every(item => item.reason === 'unknown-call'))
  assert.deepEqual(result.externalSymbols.map(item => item.name), ['ExternalValue'])
  assert.deepEqual(result.imports.map(item => item.moduleId), ['Lib.galaxy'])
  assert.ok(result.externalCalls[0].span.end > result.externalCalls[0].span.start)
  assert.ok(result.inspectedNodes > 0)
})

test('recursive calls terminate and unsupported declarations cannot silently resolve', () => {
  const result = analyze(`
    void External();
    void Loop() { Loop(); External(); }
    void InitMap() { Loop(); }
  `)
  assert.deepEqual(result.functions, ['InitMap', 'Loop'])
  assert.deepEqual(result.externalCalls.map(item => item.name), ['External'])
  assert.throws(() => analyze('void Other() {}'), /no unique implementation/u)
  assert.throws(() => analyzeGalaxyRuntimeClosure({ kind: 'EngineModule',
    functions: [{ name: 'InitMap', body: [{ kind: 'EngineRawStatement' }],
      parameters: [], locals: [] }] }, 'InitMap', { maxNodes: 1 }), /exceeds/u)
  assert.throws(() => analyzeGalaxyRuntimeClosure({ kind: 'EngineModule',
    functions: [{ name: 'InitMap', body: [{ kind: 'EngineBlockStatement',
      statements: [{ kind: 'EngineRawStatement' }] }], parameters: [], locals: [] }] },
  'InitMap', { maxDepth: 1 }), /Engine levels/u)
})

test('runtime closure resolves implementations in supplied canonical Galaxy modules', () => {
  const primary = galaxySourceToEngineModule(parseGalaxySource(`
    include "TriggerLibs/Shared";
    void Helper();
    void InitMap() { Helper(); }
  `, { fileName: 'MapScript.galaxy' }))
  const dependency = galaxySourceToEngineModule(parseGalaxySource(`
    int dependencyCounter = 1;
    native void NativeCall();
    void Helper() { dependencyCounter = dependencyCounter + 1; NativeCall(); }
  `, { fileName: 'Shared.galaxy' }))
  const result = analyzeGalaxyRuntimeClosure(primary, 'InitMap',
    { dependencies: [dependency] })
  assert.equal(result.suppliedModules, 2)
  assert.deepEqual(result.functions, ['Helper', 'InitMap'])
  assert.deepEqual(result.globals, ['dependencyCounter'])
  assert.deepEqual(result.externalCalls.map(item => item.name), ['NativeCall'])
  assert.deepEqual(result.externalCalls.map(item => item.reason), ['unmapped-native'])
  assert.equal(result.externalCalls[0].declaration.fileName, 'Shared.galaxy')
  assert.deepEqual(result.imports.map(item => item.moduleId), ['TriggerLibs/Shared'])
  const duplicate = analyzeGalaxyRuntimeClosure(primary, 'InitMap',
    { dependencies: [dependency, dependency] })
  assert.deepEqual(duplicate.ambiguousFunctions, ['Helper'])
  assert.deepEqual(duplicate.ambiguousGlobals, ['dependencyCounter'])
  assert.deepEqual(duplicate.externalCalls.map(item => item.name), ['Helper'])
  assert.deepEqual(duplicate.externalCalls.map(item => item.reason), ['ambiguous-implementation'])
})

test('runtime closure exposes only used source-declared literal int constants', () => {
  const parsed = parseGalaxySource(`
    const int player = 2;
    const int unused = 9;
    int mutablePlayer = 3;
    const int computed = 1 + 2;
    void InitMap() { NativeCreate(player); NativeCreate(mutablePlayer); NativeCreate(computed); }
  `, { fileName: 'MapScript.galaxy' })
  assert.equal(parsed.parseDiagnostics.length, 0)
  const result = analyzeGalaxyRuntimeClosure(galaxySourceToEngineModule(parsed), 'InitMap')
  assert.deepEqual(result.globals, ['computed', 'mutablePlayer', 'player'])
  assert.deepEqual(result.literalIntGlobals.map(item => [item.name, item.value]), [['player', 2]])
  assert.equal(result.literalIntGlobals[0].declaration.fileName, 'MapScript.galaxy')
  assert.ok(result.literalIntGlobals[0].initializer.span.end
    > result.literalIntGlobals[0].initializer.span.start)
  const duplicate = galaxySourceToEngineModule(parseGalaxySource('const int player = 2;',
    { fileName: 'Other.galaxy' }))
  assert.deepEqual(analyzeGalaxyRuntimeClosure(galaxySourceToEngineModule(parsed), 'InitMap',
    { dependencies: [duplicate] }).literalIntGlobals, [])
})

test('runtime closure distinguishes native signatures, prototypes and unknown calls', () => {
  const source = galaxySourceToEngineModule(parseGalaxySource(`
    native int Known(int value);
    void Prototype();
    void InitMap() { Known(1); Prototype(); Missing(); }
  `, { fileName: 'MapScript.galaxy' }))
  const conflict = galaxySourceToEngineModule(parseGalaxySource(`
    native int Known(fixed value);
  `, { fileName: 'Other.galaxy' }))
  const single = analyzeGalaxyRuntimeClosure(source, 'InitMap')
  assert.deepEqual(single.externalCalls.map(item => [item.name, item.reason]), [
    ['Known', 'unmapped-native'], ['Missing', 'unknown-call'],
    ['Prototype', 'no-executable-body'],
  ])
  const combined = analyzeGalaxyRuntimeClosure(source, 'InitMap', { dependencies: [conflict] })
  assert.equal(combined.externalCalls.find(item => item.name === 'Known').reason,
    'conflicting-native-signatures')
})

test('runtime closure admits an explicit empty body but not a prototype', () => {
  const module = { kind: 'EngineModule', globals: [], imports: [], functions: [
    { name: 'Empty', flags: { hasBody: true }, body: [], parameters: [], locals: [] },
    { name: 'Prototype', flags: { hasBody: false }, body: [], parameters: [], locals: [] },
    { name: 'InitMap', flags: { hasBody: true }, body: [
      { kind: 'EngineCallExpression', callee: { name: 'Empty' }, args: [] },
      { kind: 'EngineCallExpression', callee: { name: 'Prototype' }, args: [] },
    ], parameters: [], locals: [] },
  ] }
  const result = analyzeGalaxyRuntimeClosure(module, 'InitMap')
  assert.deepEqual(result.functions, ['Empty', 'InitMap'])
  assert.deepEqual(result.externalCalls.map(item => [item.name, item.reason]),
    [['Prototype', 'no-executable-body']])
})

test('raw Galaxy syntax retains its function or module-initializer origin', () => {
  const module = { kind: 'EngineModule', imports: [], structs: [], globals: [
    { name: 'initial', initialValue: { kind: 'EngineRawExpression' } },
  ], functions: [{ name: 'Run', flags: { hasBody: true }, parameters: [], locals: [],
    body: [{ kind: 'EngineRawStatement' }] }] }
  const closure = analyzeGalaxyRuntimeClosure(module, 'Run')
  assert.deepEqual(closure.rawNodes.map(({ kind, origin, owner }) => ({ kind, origin, owner })), [
    { kind: 'EngineRawExpression', origin: 'global-initializer', owner: 'initial' },
    { kind: 'EngineRawStatement', origin: 'function', owner: 'Run' },
  ])
})
