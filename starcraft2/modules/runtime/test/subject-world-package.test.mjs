import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUvwWorldSceneSource } from '@modkit/uv/world'
import { materializeUvmCore } from '@modkit/uv/model/materializer'
import { materializeSc2RuntimeWorld, Sc2RuntimeCompositionError } from '../services/subject-composition.js'

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const modelBytes = materializeUvmCore({
  info: { scenes: 1, nodes: 1, meshes: 1, primitives: 1,
    materials: 0, textures: 0, animations: 0, geometryAccess: 'decoded' },
  nodes: [{ id: 'body', childIds: [], meshIds: ['triangle'], transform: identity }],
  meshes: [{ id: 'triangle', primitiveIds: ['face'] }],
  primitives: [{ id: 'face', topology: 'triangles',
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
    indices: Uint32Array.of(0, 1, 2) }],
}, { scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
  profile: 'UVM/core@1.0', subjectRevision: 'test:sc2-world',
  options: { assetId: 'fixture/triangle', sourceFormat: 'fixture' } }).bytes

function worldSource(complete = true, withTexture = false) {
  const document = {
    uv: { format: 'UVW', version: '1.0', status: 'profile' },
    spaces: [{ id: 'main', topology: 'heightfield',
      basis: { handedness: 'right', upAxis: 'y', forwardAxis: '+z', unit: 'meter' },
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      layers: [
        { id: 'terrain', kind: 'heightfield', columns: 2, rows: 2,
          cellSize: 1, origin: [0, 0, 0], samples: [[0, 0], [0, 0]] },
        { schemaVersion: 1, id: 'objects', kind: 'objects', instances: [{ id: 'triangle',
          objectKind: 'doodad', position: [0.5, 0, 0.5], rotation: [0, 0, 0, 1],
          scale: [1, 1, 1], resourceIds: ['source-model'],
          modelComponents: [{ id: 'body', resourceId: 'source-model' }] }] },
        { schemaVersion: 1, id: 'resources', kind: 'resources',
          resources: [{ id: 'source-model', kind: 'uvm', uri: 'native/model.m3' }] },
      ] }],
    connections: [],
  }
  if (withTexture) {
    document.spaces[0].layers.push({ schemaVersion: 1, id: 'materials', kind: 'terrain-materials',
      columns: 2, rows: 2, cellSize: 1, origin: [0, 0, 0],
      materials: [{ id: 'ground', baseColorResourceId: 'ground-image' }],
      samples: Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => ({
        weights: [{ materialId: 'ground', weight: 1 }],
      }))) })
    document.spaces[0].layers.find(layer => layer.kind === 'resources').resources.push({
      id: 'ground-image', kind: 'media', uri: 'native/ground.dds',
    })
  }
  const source = createUvwWorldSceneSource(document, { snapshotId: 'sc2-fixture' })
  return { ...source,
    async texture() { throw new Error('this fixture has no textures') },
    async model(resourceId) {
      assert.equal(resourceId, 'uvw-resource:main/source-model')
      return complete
        ? { state: 'converted', sourceKey: 'fixture-model', uvmBytes: modelBytes,
          diagnostics: [], complete: true }
        : { state: 'unresolved', diagnostics: [] }
    },
  }
}

test('SC2 Runtime packages selected map UVM through the Core world writer', async () => {
  const result = await materializeSc2RuntimeWorld(worldSource(), { presentation: 'required' })
  assert.equal(result.models.length, 1)
  assert.deepEqual(result.models[0].bytes, modelBytes)
  assert.equal(result.worldReceipt.packagedModelCount, 1)
  const main = result.world.spaces[0]
  const resources = main.layers.find(layer => layer.kind === 'resources').resources
  assert.equal(resources.find(item => item.kind === 'uvm').uri, result.models[0].path)
})

test('SC2 Runtime refuses an object model that Core could not package', async () => {
  await assert.rejects(materializeSc2RuntimeWorld(worldSource(false), { presentation: 'required' }), error =>
    error instanceof Sc2RuntimeCompositionError
      && error.code === 'sc2-runtime/world-resource-unpackaged')
})

test('simulation retains exact world semantics without decoding optional textures or models', async () => {
  const source = worldSource(false, true)
  let resourceReads = 0
  const unavailable = { ...source,
    async texture() { resourceReads++; throw new Error('texture unavailable') },
    async model() { resourceReads++; throw new Error('model unavailable') },
  }
  const result = await materializeSc2RuntimeWorld(unavailable)
  assert.equal(resourceReads, 0)
  assert.equal(result.worldReceipt.presentation.state, 'deferred')
  assert.equal(result.world.spaces[0].layers.find(layer => layer.kind === 'objects').instances.length, 1)
  assert.deepEqual(result.world.spaces[0].layers.find(layer => layer.kind === 'heightfield').samples,
    [[0, 0], [0, 0]])
  assert.deepEqual(result.media, [])
  assert.deepEqual(result.models, [])
  assert.equal((await materializeSc2RuntimeWorld(source)).worldReceipt.artifactDigest,
    result.worldReceipt.artifactDigest)
  await assert.rejects(materializeSc2RuntimeWorld(unavailable, { presentation: 'required' }))
  assert.ok(resourceReads > 0)
})

test('simulation still refuses missing world geometry and propagates cancellation', async () => {
  await assert.rejects(materializeSc2RuntimeWorld({ ...worldSource(),
    async info() { throw new Error('geometry unreadable') },
  }), error => error instanceof Sc2RuntimeCompositionError && error.code === 'sc2-runtime/uvw-unresolved')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(materializeSc2RuntimeWorld(worldSource(), { signal: controller.signal }),
    { name: 'AbortError' })
})
