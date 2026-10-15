import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { JsonObject, JsonValue } from '@modkit/sdk'
import { createM3aEffectBindingFixture, effectFixtureIds } from './fixtures/m3a-effect-binding.js'
import { decodeM3EffectSidecarBinding } from '../src/m3/uvm/effect-sidecar-source.js'
import { bindM3EffectSidecars } from '../src/m3/uvm/effect-sidecar-binding.js'
import { bindM3SequenceIndices } from '../src/m3/uvm/animation-binding.js'
import { projectM3Effects, type M3EffectsSource } from '../src/m3/uvm/effects.js'
import { DEFAULT_UVM_CONTAINER_BUDGET } from '@modkit/uv/model/container'

const budget = {
  maxInputBytes: 16 * 1024 * 1024,
  maxScalarBytes: 32 * 1024 * 1024,
  maxNodes: 100000,
  maxDepth: 96,
}
function object(value: JsonValue | undefined): JsonObject {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as JsonObject
}
function tracks(emitter: JsonObject, property: string): JsonObject[] {
  const value = object(emitter['sequenceAnimation'])[property]
  assert(Array.isArray(value))
  return value.map(object)
}
function mode(emitter: JsonObject): number[] {
  return tracks(emitter, 'squirt').map(entry => {
    const keys = object(entry['track'])['keys']
    assert(Array.isArray(keys))
    const vector = object(keys[0])['vector']
    assert(Array.isArray(vector))
    const value = vector[0]
    assert.equal(typeof value, 'number')
    return Number(value)
  })
}
async function decode(bytes: Uint8Array): Promise<M3EffectsSource> {
  const runtime = (await import(new URL('../src/m3/runtime/effects.js', import.meta.url).href)) as {
    decodeM3Effects(bytes: Uint8Array, settings: typeof budget): Promise<M3EffectsSource>
  }
  return runtime.decodeM3Effects(bytes, budget)
}

test('actual descriptor-free M3A IDs bind parent and PARC tracks to distinct combined clips', async () => {
  const baseBytes = await createM3aEffectBindingFixture()
  const sideBytes = await createM3aEffectBindingFixture({ sidecar: true })
  const base = await decode(baseBytes)
  const side = await decodeM3EffectSidecarBinding(baseBytes, sideBytes, 'side-effects', budget)
  assert.equal(side.nativeSequenceCount, 2)
  assert(
    side.proof.some(
      item =>
        item['animId'] === effectFixtureIds.count &&
        item['nativeSequenceIndex'] === 0 &&
        item['sdField'] === 'sds6',
    ),
  )
  assert(
    side.proof.some(
      item =>
        item['animId'] === effectFixtureIds.copyCount &&
        item['nativeSequenceIndex'] === 1 &&
        item['nativePath']?.toString().startsWith('PARC'),
    ),
  )
  const sequences = bindM3SequenceIndices(
    { clips: [{ id: 'base-0' }], nativeSequenceIndices: [0] },
    [
      {
        logicalId: 'side-effects',
        clips: [{ id: 'side-0' }, { id: 'side-1' }],
        nativeSequenceIndices: [0, 1],
      },
    ],
    budget,
  )
  const before = JSON.stringify({ base, side })
  const result = bindM3EffectSidecars(base, [side], sequences, budget)
  assert.equal(
    JSON.stringify({ base, side }),
    before,
    'the binding must own output and preserve source inputs',
  )
  assert.equal(result.sequenceIndexSpace, 'combined')
  assert.deepEqual(result.emissionMeshes, base.emissionMeshes)
  const published = projectM3Effects(
    result,
    new Set(['bone/0']),
    new Set(['material-0']),
    sequences,
    { ...DEFAULT_UVM_CONTAINER_BUDGET, ...budget },
  )
  assert(published !== undefined)
  const extension = published.effects as JsonObject
  assert.deepEqual(object(published.mapping['sidecarBinding'])['sequences'], sequences)
  const publishedParticles = extension['particles']
  assert(Array.isArray(publishedParticles))
  assert.deepEqual(mode(object(publishedParticles[0])), [0, 1, 0])
  assert.deepEqual(mode(object(publishedParticles[1])), [0, 0, 1])
  const particles = result.effects['particles']
  assert(Array.isArray(particles))
  assert.equal(particles.length, 2)
  const parent = object(particles[0]),
    copy = object(particles[1])
  assert.deepEqual(mode(parent), [0, 1, 0])
  assert.deepEqual(mode(copy), [0, 0, 1])
  assert.deepEqual(
    tracks(parent, 'emitCount').map(item => item['sequenceIndex']),
    [1],
  )
  assert.deepEqual(
    tracks(copy, 'emitCount').map(item => item['sequenceIndex']),
    [2],
  )
  for (const emitter of [parent, copy]) {
    assert.deepEqual(
      tracks(emitter, 'emissionRate').map(item => item['sequenceIndex']),
      [0, 1, 2],
    )
    assert.deepEqual(
      tracks(emitter, 'speed').map(item => item['sequenceIndex']),
      [0, 1, 2],
    )
  }
  assert.deepEqual(
    tracks(copy, 'speed'),
    tracks(parent, 'speed'),
    'PARC keeps native inherited speed transforms',
  )
  const keys = object(tracks(copy, 'speed')[1]?.['track'])['keys']
  assert(Array.isArray(keys))
  assert.deepEqual(
    keys.map(item => object(item)['frame']),
    [0, 1],
    'native tick offset and seconds transformation reused',
  )
})

test('actual byte bindings reject duplicate native IDs and incompatible SD types', async () => {
  const base = await createM3aEffectBindingFixture()
  const side = await createM3aEffectBindingFixture({ sidecar: true })
  await assert.rejects(
    decodeM3EffectSidecarBinding(
      await createM3aEffectBindingFixture({ duplicateBaseId: true }),
      side,
      'side',
      budget,
    ),
    /ambiguous M3 base effect animation id/,
  )
  await assert.rejects(
    decodeM3EffectSidecarBinding(
      base,
      await createM3aEffectBindingFixture({ sidecar: true, duplicateStcId: true }),
      'side',
      budget,
    ),
    /ambiguous M3A STC/,
  )
  await assert.rejects(
    decodeM3EffectSidecarBinding(
      base,
      await createM3aEffectBindingFixture({ sidecar: true, incompatibleSdType: true }),
      'side',
      budget,
    ),
    /incompatible M3A effect SD type/,
  )
})

test('effect sidecar captures bytes before asynchronous parse and rejects budgets before copying', async () => {
  const base = await createM3aEffectBindingFixture(),
    side = await createM3aEffectBindingFixture({ sidecar: true })
  await assert.rejects(
    decodeM3EffectSidecarBinding(base, side, 'side', {
      ...budget,
      maxInputBytes: base.length + side.length - 1,
    }),
    /aggregate sources/,
  )
  const pending = decodeM3EffectSidecarBinding(base, side, 'side', budget)
  base.fill(0)
  side.fill(0)
  assert((await pending).proof.length > 0)
})
