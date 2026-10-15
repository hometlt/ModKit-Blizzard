// Destination models/test. Uses the existing Vitest/native runtime; not run during draft preparation.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createM3EffectSplinesFixture } from './fixtures/m3-effect-splines.fixture.mjs'
import { decodeM3Effects } from '../src/m3/runtime/effects.js'
import { projectM3Effects } from '../src/m3/uvm/effects.ts'
import { DEFAULT_UVM_CONTAINER_BUDGET } from '@modkit/uv/model/container'
const budget = {
  ...DEFAULT_UVM_CONTAINER_BUDGET,
  maxInputBytes: 16 * 1024 * 1024,
  maxScalarBytes: 32 * 1024 * 1024,
  maxNodes: 100000,
  maxDepth: 96,
}
test('actual PAR_/SVC3 and RIB_/SRIB project authored defaults, complete keys and nested mapped node identities', async () => {
  const bytes = await createM3EffectSplinesFixture(),
    before = bytes.slice()
  const decoded = await decodeM3Effects(bytes, budget)
  assert.deepEqual(bytes, before)
  const particle = decoded.effects.particles[0],
    cutout = decoded.effects.particles[1],
    ribbon = decoded.effects.ribbons[0]
  assert.equal(particle.emitShape, 'spline')
  assert.deepEqual(particle.emitShapePoints, [
    [1, 2, 3],
    [4, 2, 3],
  ])
  assert.deepEqual(particle.emitShapePointSequenceAnimations, [
    [
      {
        sequenceIndex: 0,
        track: {
          lineType: 1,
          globalSeqId: null,
          keys: [
            { frame: 0, vector: [1, 2, 3] },
            { frame: 1, vector: [1, 5, 3] },
          ],
        },
      },
    ],
    [],
  ])
  assert.equal(cutout.emitShapeCutout, true)
  assert.equal(cutout.emitShapeCutoutRadius, 0.5)
  assert.deepEqual(cutout.emitShapeCutoutSize, [0.25, 0.5, 0.75])
  assert.equal(ribbon.divisions, 4)
  const endpoint = ribbon.splineEndpoints[0]
  assert.deepEqual(endpoint.emissionOffset, [4, 0, 0])
  assert.deepEqual(endpoint.emissionVector, [0, 1, 0])
  assert.equal(endpoint.velocityBaseFactor, 0.5)
  assert.equal(endpoint.velocityEndFactor, 1.5)
  assert.deepEqual(endpoint.sequenceAnimation.velocity[0].track.keys, [
    { frame: 0, vector: [1] },
    { frame: 1, vector: [3] },
  ])
  assert.deepEqual(endpoint.sequenceAnimation.yaw[0].track.keys, [
    { frame: 0, vector: [0] },
    { frame: 1, vector: [45] },
  ])
  const mapped = projectM3Effects(
    decoded,
    new Set(['bone/0']),
    new Set(['material-0']),
    [{ source: 'base', nativeSequenceIndex: 0, combinedSequenceIndex: 3, clipId: 'base' }],
    budget,
  )
  // Bones below the emitter are node ids too; the materializer turns every one into an index.
  const effects = mapped.effects
  assert.equal(effects.ribbons[0].splineEndpoints[0].nodeId, 'bone/0')
  assert.equal(effects.ribbons[0].splineEndpoints[0].boneIndex, undefined)
  assert.equal(effects.ribbons[0].splineEndpoints[0].sequenceAnimation.velocity[0].sequenceIndex, 3)
  assert.equal(effects.particles[0].emitShapePointSequenceAnimations[0][0].sequenceIndex, 3)
  assert.deepEqual(effects.particles[0].emitShapePoints, particle.emitShapePoints)
})
