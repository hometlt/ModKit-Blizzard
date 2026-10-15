import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { analyzeGalaxySingleUnitSpawn, bindGalaxySingleUnitSpawn,
  lowerGalaxySingleUnitSpawn, projectGalaxySingleUnitSpawn,
  Sc2GalaxyRuntimeLoweringError } from '../services/galaxy-spawn-lowering.js'
import { prepareSc2RuntimeInputs, resolveSc2RuntimePlayerSlots } from '../services/subject-composition.js'
import { quantizeFixed64Decimal } from '../../../../../multiverse/specs/tools/uv-fixed-point.mjs'

const world = { spaces: [{ id: 'map/main', layers: [
  { id: 'terrain', kind: 'heightfield', columns: 4, rows: 4,
    cellSize: 1, origin: [0, 0, -3], samples: [
      [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1],
    ] },
  { id: 'objects', kind: 'objects', instances: [
    { id: 'instance-1900', objectKind: 'point', position: [1.25, 2.5, -2.5] },
    { id: 'instance-1901', objectKind: 'unit', position: [1, 1, -1] },
  ] },
] }] }
const lower = text => lowerGalaxySingleUnitSpawn({ text, world,
  fileName: 'MapScript.galaxy', functionName: 'Spawn', space: 'map/main',
  quantizeFixed64Decimal })

test('SC2 uses the authored slot-to-player mapping without copying slots into private handles', () => {
  const published = [{ slot: 0, address: 'sc2/player/neutral' }, { slot: 3, address: 'sc2/player/one', color: [1, 0, 0] }]
  const resolved = resolveSc2RuntimePlayerSlots(published)
  assert.deepEqual(resolved, [{ slot: '0', address: 'sc2/player/neutral' }, { slot: '3', address: 'sc2/player/one' }])
  assert.deepEqual(resolveSc2RuntimePlayerSlots(published, [...resolved].reverse()), resolved)
  published[1].address = 'spoof/player/one'
  assert.equal(resolved[1].address, 'sc2/player/one')
  assert.ok(Object.isFrozen(resolved) && Object.isFrozen(resolved[1]))
})

test('SC2 refuses a slot swap even when portable player identity sets are unchanged', () => {
  const published = [{ slot: 1, address: 'sc2/player/one' }, { slot: 3, address: 'sc2/player/three' }]
  for (const setup of [[{ slot: '3', address: 'sc2/player/one' }, { slot: '1', address: 'sc2/player/three' }],
    [{ slot: '1', address: 'sc2/player/one' }]])
    assert.throws(() => resolveSc2RuntimePlayerSlots(published, setup), error => error.code === 'sc2-runtime/player-roster-mismatch')
  for (const invalid of [null, [], [{ slot: -1, address: 'sc2/player/neutral' }],
    [{ slot: 1, address: 'sc2/player/one' }, { slot: 1, address: 'sc2/player/three' }]])
    assert.throws(() => resolveSc2RuntimePlayerSlots(invalid), error => error.code === 'sc2-runtime/player-roster-invalid')
})

test('older worlds retain explicit SC2 setup, while a missing roster gets a typed refusal', () => {
  const setup = [{ slot: '3', address: 'sc2/player/one' }]
  assert.deepEqual(resolveSc2RuntimePlayerSlots(undefined, setup), setup)
  assert.throws(() => resolveSc2RuntimePlayerSlots(undefined), error => error.code === 'sc2-runtime/player-roster-missing')
  assert.throws(() => resolveSc2RuntimePlayerSlots(undefined, [{ slot: '16', address: 'sc2/player/one' }]), TypeError)
})

test('the admitted UnitCreate call matches the Galaxy owner native signature', async () => {
  const api = JSON.parse(await readFile(new URL('../../galaxy/data/galaxy-script-api.v1.json',
    import.meta.url), 'utf8'))
  const native = api.functions.find(item => item.name === 'UnitCreate' && item.kind === 'native')
  assert.equal(native?.interface.returnType, 'unitgroup')
  assert.deepEqual(native.interface.parameters.map(item => item.type),
    ['int', 'string', 'int', 'int', 'point', 'fixed'])
  const last = api.functions.find(item => item.name === 'UnitLastCreated' && item.kind === 'native')
  assert.equal(last?.interface.returnType, 'unit')
  assert.deepEqual(last.interface.parameters, [])
})

test('Galaxy spawn keeps exact point, catalog ID, player and source span', () => {
  const text = 'void Spawn() { UnitCreate(1, "Marine", 0, 3, Point(1.25, 2.5), 0.0); }'
  const result = lower(text)
  assert.deepEqual(bindGalaxySingleUnitSpawn(analyzeGalaxySingleUnitSpawn({ text,
    fileName: 'MapScript.galaxy', functionName: 'Spawn', quantizeFixed64Decimal }),
  'map/main', world, quantizeFixed64Decimal), result)
  assert.throws(() => bindGalaxySingleUnitSpawn({ unitId: 'Marine' }, 'map/main'),
    /requires analyzed source/u)
  assert.equal(result.invocation.unit.entityId, 'Marine')
  assert.equal(result.invocation.playerId, '3')
  assert.deepEqual(result.invocation.pos, { space: 'map/main',
    x: '5368709120', y: '4294967296', z: '-10737418240' })
  assert.match(result.luau, /mv\.pos\("map\/main", mv\.fixed\.fromQuantum\("5368709120"\), mv\.fixed\.fromQuantum\("4294967296"\), mv\.fixed\.fromQuantum\("-10737418240"\)\)/u)
  assert.match(result.luau, /function spawn\(def: DefRef, owner: PlayerRef\): EntityGroup/u)
  assert.match(result.luau, /local entity: EntityRef = mv\.entity\.create\(def, owner, at\)/u)
  assert.match(result.luau, /mv\.require\(mv\.scenario\.setOptionalEntity\("sc2\.native\/state\/lastCreatedUnit", mv\.option\.entity\(entity\)\)\)/u)
  assert.match(result.luau, /mv\.group\.append\(mv\.group\.empty\(\), entity\)/u)
  assert.deepEqual(result.scenarios, [{ path: 'native-state.uvs.json', document: {
    uv: { format: 'UVS', version: '1.5' }, namespace: 'sc2.native', charts: [{
      name: 'state', initialState: 'idle',
      variables: [{ name: 'lastCreatedUnit', type: 'ref<entity>?', initial: null }],
      states: [{ name: 'idle', on: [] }],
    }],
  } }])
  result.scenarios[0].document.charts[0].variables[0].initial = '999'
  assert.equal(lower(text).scenarios[0].document.charts[0].variables[0].initial, null)
  assert.equal(result.sourceMap[0].nativeLine, 1)
  assert.equal(result.metadata.native, 'UnitCreate')
})

test('Galaxy spawn resolves an integer argument only from a source-declared const', () => {
  const source = 'const int owner = 3;\nvoid Spawn() { UnitCreate(1, "Marine", 0, owner, Point(1, 2), 0); }'
  const result = lower(source)
  assert.equal(result.invocation.playerId, '3')
  assert.equal(result.sourceMap[0].nativeLine, 2)
  for (const declaration of ['int owner = 3;', 'const int owner = 1 + 2;',
    'const string owner = "3";']) {
    assert.throws(() => lower(`${declaration}\nvoid Spawn() { UnitCreate(1, "Marine", 0, owner, Point(1, 2), 0); }`),
    error => error instanceof Sc2GalaxyRuntimeLoweringError
      && error.code === 'sc2-runtime/galaxy-profile')
  }
})

test('source functions and globals cannot be executed as same-named Galaxy natives', () => {
  for (const name of ['UnitCreate', 'Point', 'PointFromId']) {
    for (const isGlobal of [false, true]) {
      const functionName = isGlobal ? 'Spawn' : name
      const point = name === 'PointFromId' ? 'PointFromId(1900)' : 'Point(1, 2)'
      const text = `${isGlobal ? `const int ${name} = 0;\n` : ''}`
        + `void ${functionName}() { UnitCreate(1, "Marine", 0, 1, ${point}, 0); }`
      const request = { text, functionName, fileName: 'MapScript.galaxy',
        world, space: 'map/main', quantizeFixed64Decimal }
      assert.throws(() => lowerGalaxySingleUnitSpawn(request), error =>
        error instanceof Sc2GalaxyRuntimeLoweringError
          && error.code === 'sc2-runtime/native-binding-shadowed'
          && error.span?.end > error.span?.start
          && text.slice(error.span.start, error.span.end).includes(name))
      const projection = projectGalaxySingleUnitSpawn(request)
      assert.equal(projection.loweredUnits, 0)
      assert.equal(projection.refusals[0].rule, 'native-binding-shadowed')
      assert.ok(projection.refusals[0].fragment.includes(name))
    }
  }
})

test('shadowed native bindings refuse before expensive Data and Map resolution', async () => {
  const context = new Proxy({}, { get() { assert.fail('context must not be read') } })
  await assert.rejects(prepareSc2RuntimeInputs({ context, services: {}, budgets: {},
    unit: { namespace: 'Unit', entityId: 'Marine' }, quantizeFixed64Decimal,
    galaxy: { text: 'const int UnitCreate = 0;\nvoid Spawn() { UnitCreate(1, "Marine", 0, 1, Point(1, 2), 0); }',
      fileName: 'MapScript.galaxy', functionName: 'Spawn' },
    playerSlots: [{ slot: '1', address: 'sc2/player/one' }],
  }), error => error instanceof Sc2GalaxyRuntimeLoweringError
    && error.code === 'sc2-runtime/native-binding-shadowed')
})

test('PointFromId uses the existing UVW ObjectPoint position and rejects wrong or missing IDs', () => {
  const point = id => `void Spawn() { UnitCreate(1, "Marine", 0, 3, PointFromId(${id}), 0.0); }`
  assert.deepEqual(lower(point(1900)).invocation.pos, { space: 'map/main',
    x: '5368709120', y: '10737418240', z: '-10737418240' })
  for (const id of [1901, 1902]) assert.throws(() => lower(point(id)), error =>
    error instanceof Sc2GalaxyRuntimeLoweringError
      && error.code === 'sc2-runtime/point-id-unresolved'
      && error.span?.end > error.span?.start)
})

test('literal Point samples the canonical UVW ground height with Q32.32 interpolation', () => {
  const interpolated = structuredClone(world)
  interpolated.spaces[0].layers[0].samples[0][0] = 1
  interpolated.spaces[0].layers[0].samples[0][1] = 2
  interpolated.spaces[0].layers[0].samples[1][0] = 3
  interpolated.spaces[0].layers[0].samples[1][1] = 4
  const text = 'void Spawn() { UnitCreate(1, "Marine", 0, 3, Point(0.5, 2.5), 0.0); }'
  assert.deepEqual(lowerGalaxySingleUnitSpawn({ text, world: interpolated,
    fileName: 'MapScript.galaxy', functionName: 'Spawn', space: 'map/main',
    quantizeFixed64Decimal }).invocation.pos, { space: 'map/main',
    x: '2147483648', y: '10737418240', z: '-10737418240' })
  assert.throws(() => lowerGalaxySingleUnitSpawn({ text, world: undefined,
    fileName: 'MapScript.galaxy', functionName: 'Spawn', space: 'map/main',
    quantizeFixed64Decimal }), error => error.code === 'sc2-runtime/world-unavailable')
  const missing = structuredClone(world)
  missing.spaces[0].layers[0].noDataValue = -99
  missing.spaces[0].layers[0].samples[0][1] = -99
  const at = x => `void Spawn() { UnitCreate(1, "Marine", 0, 3, Point(${x}, 3), 0.0); }`
  assert.equal(lowerGalaxySingleUnitSpawn({ text: at(0), world: missing,
    fileName: 'MapScript.galaxy', functionName: 'Spawn', space: 'map/main',
    quantizeFixed64Decimal }).invocation.pos.y, '4294967296')
  assert.throws(() => lowerGalaxySingleUnitSpawn({ text: at(1), world: missing,
    fileName: 'MapScript.galaxy', functionName: 'Spawn', space: 'map/main',
    quantizeFixed64Decimal }), error => error.code === 'sc2-runtime/heightfield-unavailable')
})

test('unsupported selected MapScript refuses before Data and Map resolution', async () => {
  const context = new Proxy({}, { get() { assert.fail('context must not be read') } })
  await assert.rejects(prepareSc2RuntimeInputs({ context, services: {}, budgets: {},
    unit: { namespace: 'Unit', entityId: 'Marine' }, quantizeFixed64Decimal,
    galaxy: { text: 'void Spawn() { TriggerSleepAction(1); }',
      fileName: 'MapScript.galaxy', functionName: 'Spawn' },
    playerSlots: [{ slot: '1', address: 'sc2/player/one' }],
  }), error => error instanceof Sc2GalaxyRuntimeLoweringError
    && error.code === 'sc2-runtime/native-unsupported')
})

test('unsupported Galaxy effects are refused with a precise native span', () => {
  for (const [text, code] of [
    ['void Spawn() { UnitCreate(2, "Marine", 0, 1, Point(0, 0), 0); }',
      'sc2-runtime/unit-count-unsupported'],
    ['void Spawn() { UnitCreate(1, "Marine", 1, 1, Point(0, 0), 0); }',
      'sc2-runtime/create-style-unsupported'],
    ['void Spawn() { UnitCreate(1, "Marine", 0, 1, Point(0, 0), 90); }',
      'sc2-runtime/facing-unsupported'],
    ['void Spawn() { UnitCreate(1, "Marine", 0, 1, Point(0, 0), 0); TriggerSleepAction(1); }',
      'sc2-runtime/galaxy-profile'],
    ['void Spawn() { UnitCreate(1, "Marine", 0, 1, Point(0, 0), 0); } int sideEffect;',
      'sc2-runtime/galaxy-profile'],
    ['void Spawn() { UnitCreate(1, "Marine", 0, 1, Point(0, 0), 0); broken; }',
      'sc2-runtime/galaxy-syntax'],
  ]) assert.throws(() => lower(text), error =>
    error instanceof Sc2GalaxyRuntimeLoweringError && error.code === code
      && error.span?.end > error.span?.start)
  const source = 'void Spawn() { UnitCreate(2, "Marine", 0, 1, Point(0, 0), 0); }'
  const projected = projectGalaxySingleUnitSpawn({ text: source,
    fileName: 'MapScript.galaxy', functionName: 'Spawn', space: 'map/main', world,
    quantizeFixed64Decimal })
  assert.equal(projected.loweredUnits, 0)
  assert.equal(projected.refusals[0].rule, 'unit-count-unsupported')
  assert.equal(projected.refusals[0].fragment, '2')
})

test('selected multi-function Galaxy reports the observed dependency slice', () => {
  assert.throws(() => lower(`
    int counter = NativeInit();
    void Extra() { NativeExtra(); }
    void Spawn() { Extra(); UnitCreate(1, "Marine", 0, 1, Point(0, 0), 0); }
  `), error => error instanceof Sc2GalaxyRuntimeLoweringError
    && error.code === 'sc2-runtime/galaxy-profile'
    && error.message.includes('2 functions, 1 globals, 0 includes, 4 external calls'))
})
