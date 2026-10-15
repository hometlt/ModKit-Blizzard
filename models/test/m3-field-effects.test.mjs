// Intended for models/test; run with the existing Vitest setup after integration/build.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createM3FieldEffectsFixture } from './fixtures/m3-field-effects.fixture.mjs'
import { decodeM3Effects } from '../src/m3/runtime/effects.js'
import { decodeM3EffectSidecarBinding } from '../src/m3/uvm/effect-sidecar-source.ts'
import { bindM3EffectSidecars } from '../src/m3/uvm/effect-sidecar-binding.ts'
import { bindM3SequenceIndices } from '../src/m3/uvm/animation-binding.ts'
import { projectM3Effects } from '../src/m3/uvm/effects.ts'
import { DEFAULT_UVM_CONTAINER_BUDGET } from '@modkit/uv/model/container'

const budget = {
  ...DEFAULT_UVM_CONTAINER_BUDGET,
  maxInputBytes: 16 * 1024 * 1024,
  maxScalarBytes: 32 * 1024 * 1024,
  maxNodes: 100000,
  maxDepth: 96,
}
const track = sequenceIndex => ({
  sequenceIndex,
  track: {
    lineType: 1,
    globalSeqId: null,
    keys: [
      { frame: 0, vector: [2 + sequenceIndex] },
      { frame: 1, vector: [6 + sequenceIndex] },
    ],
  },
})
test('actual native FOR_/WRP_ keys augment active projection with complete local-second tracks', async () => {
  const bytes = await createM3FieldEffectsFixture(),
    before = bytes.slice()
  const decoded = await decodeM3Effects(bytes, budget)
  assert.deepEqual(bytes, before)
  for (const key of ['strength', 'width', 'height', 'length'])
    assert.deepEqual(decoded.effects.forces[0].sequenceAnimation[key], [track(0)])
  for (const key of ['radius', 'strength'])
    assert.deepEqual(decoded.effects.warps[0].sequenceAnimation[key], [track(0)])
  assert.deepEqual(Object.keys(decoded.effects.warps[0].sequenceAnimation).sort(), [
    'radius',
    'strength',
  ])
  assert.deepEqual(decoded.effects.projectors[0].sequenceAnimation.active, [
    {
      sequenceIndex: 0,
      track: {
        lineType: 0,
        globalSeqId: null,
        keys: [
          { frame: 0, vector: [1] },
          { frame: 1, vector: [0] },
        ],
      },
    },
  ])
  const mapped = projectM3Effects(
    decoded,
    new Set(['bone/0']),
    new Set(['material-0']),
    [{ source: 'base', nativeSequenceIndex: 0, combinedSequenceIndex: 4, clipId: 'base' }],
    budget,
  )
  assert.equal(mapped.effects.forces[0].nodeId, 'bone/0')
  assert.equal(mapped.effects.forces[0].sequenceAnimation.strength[0].sequenceIndex, 4)
})
test('same native field IDs bind independently through admitted M3A sequence context', async () => {
  const bytes = await createM3FieldEffectsFixture(),
    companion = await createM3FieldEffectsFixture({ sidecar: true })
  const base = await decodeM3Effects(bytes, budget)
  const side = await decodeM3EffectSidecarBinding(bytes, companion, 'Hero-Fields.m3a', budget)
  const sequences = bindM3SequenceIndices(
    { clips: [{ id: 'base' }], nativeSequenceIndices: [0] },
    [
      {
        logicalId: 'Hero-Fields.m3a',
        clips: [{ id: 'side0' }, { id: 'side1' }],
        nativeSequenceIndices: [0, 1],
      },
    ],
    budget,
  )
  const result = bindM3EffectSidecars(base, [side], sequences, budget)
  const expected = [track(0), { ...track(0), sequenceIndex: 1 }, { ...track(1), sequenceIndex: 2 }]
  assert.deepEqual(result.effects.forces[0].sequenceAnimation.strength, expected)
  assert.deepEqual(result.effects.warps[0].sequenceAnimation.radius, expected)
})
