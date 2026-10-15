import { expect, it } from 'vitest'
import { mapM3AttachmentVolumes, type M3AttachmentVolume } from '../dist/m3/uvm/volumes.js'
import { m3AttachmentMeshFixture } from './m3-uvm-mesh-fixture.js'

const source: M3AttachmentVolume = {
  index: 0,
  shape: 0,
  boneIndex: 7,
  bone1: 7,
  bone2: 7,
  vertices: 0,
  faces: 0,
  matrix4: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1],
  size0: 2,
  size1: 3,
  size2: 4,
}
it('maps native analytic ATVL conventions without applying the global frame twice', () => {
  const result = mapM3AttachmentVolumes(
    [0, 1, 2, 3].map(shape => ({ ...source, shape, index: shape })),
    new Set(['bone/7']),
  )
  expect(result.map(item => item.shape)).toEqual([
    { kind: 'box', size: [4, 6, 8], matrix: source.matrix4 },
    { kind: 'sphere', radius: 2, matrix: source.matrix4 },
    { kind: 'capsule', radius: 2, height: 3, axis: 'z', matrix: source.matrix4 },
    { kind: 'cylinder', radius: 2, height: 3, axis: 'z', matrix: source.matrix4 },
  ])
  expect(result.map(item => item.nodeId)).toEqual(['bone/7', 'bone/7', 'bone/7', 'bone/7'])
  expect(result.every(item => item.role === 'effect')).toBe(true)
})
it('refuses unrepresented native payloads and unresolved bone semantics explicitly', () => {
  for (const patch of [
    { shape: 4 },
    { vertices: 1 },
    { faces: 3 },
    { bone1: 8 },
    { bone2: 8 },
    { boneIndex: 999 },
    { matrix4: [1] },
    { matrix4: source.matrix4.map((value, i) => (i === 3 ? 1 : value)) },
  ])
    expect(() => mapM3AttachmentVolumes([{ ...source, ...patch }], new Set(['bone/7']))).toThrow()
})

it('refuses malformed native mesh references and indices before publishing UVM geometry', async () => {
  const { decodeM3UvmSource } = (await import(
    new URL('../src/m3/geometry.node.js', import.meta.url).href
  )) as {
    decodeM3UvmSource(
      bytes: Uint8Array,
      budget: { maxDepth: number; maxNodes: number; maxScalarBytes: number },
    ): Promise<unknown>
  }
  const budget = { maxDepth: 128, maxNodes: 1_000_000, maxScalarBytes: 268_435_456 }
  await expect(
    decodeM3UvmSource(await m3AttachmentMeshFixture('bad-index'), budget),
  ).rejects.toThrow(/index exceeds vertices/)
  await expect(
    decodeM3UvmSource(await m3AttachmentMeshFixture('bad-reference'), budget),
  ).rejects.toThrow(/invalid VEC3\/U16 references/)
})
