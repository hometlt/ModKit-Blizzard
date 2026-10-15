// Intended models/test, existing Vitest configuration; not run as draft.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createM3FieldEffectsFixture } from './fixtures/m3-field-effects.fixture.mjs'
import { decodeM3Effects } from '../src/m3/runtime/effects.js'
import { decodeM3EffectSidecarBinding } from '../src/m3/uvm/effect-sidecar-source.ts'
import { bindM3EffectSidecars } from '../src/m3/uvm/effect-sidecar-binding.ts'
import { bindM3SequenceIndices } from '../src/m3/uvm/animation-binding.ts'
import { DEFAULT_UVM_CONTAINER_BUDGET } from '@modkit/uv/model/container'
const budget = {
  ...DEFAULT_UVM_CONTAINER_BUDGET,
  maxInputBytes: 16777216,
  maxScalarBytes: 33554432,
  maxNodes: 100000,
  maxDepth: 96,
}
const active = sequenceIndex => ({
  sequenceIndex,
  track: {
    lineType: 0,
    globalSeqId: null,
    keys: [
      { frame: 0, vector: [1] },
      { frame: 1, vector: [0] },
    ],
  },
})
test('actual PROJ/SDU3 bytes bind sparse discrete activity into every combined M3A clip', async () => {
  const bytes = await createM3FieldEffectsFixture(),
    sidecar = await createM3FieldEffectsFixture({ sidecar: true })
  const original = bytes.slice(),
    companion = sidecar.slice(),
    base = await decodeM3Effects(bytes, budget)
  assert.deepEqual(base.effects.projectors[0].sequenceAnimation.active, [active(0)])
  const side = await decodeM3EffectSidecarBinding(bytes, sidecar, 'Hero-Fields.m3a', budget)
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
  assert.deepEqual(result.effects.projectors[0].sequenceAnimation.active, [
    active(0),
    active(1),
    active(2),
  ])
  assert.deepEqual(bytes, original)
  assert.deepEqual(sidecar, companion)
})
