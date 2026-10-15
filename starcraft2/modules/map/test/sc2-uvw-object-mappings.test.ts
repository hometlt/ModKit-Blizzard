import { expect, it } from 'vitest'
import { toSc2ObjectMappings } from '../codecs/package/src/uvw-map-converter.js'

const snapshot = (bindingId: string) => ({
  bindingId,
  role: 'dependency',
  subjectUri: `memory:${bindingId}`,
  revision: `${bindingId}-1`,
  compositionFingerprint: `composition:${bindingId}`,
})

it('projects only an accepted exact plan while every reacquired snapshot still matches', () => {
  const snapshots = [snapshot('world'), snapshot('source'), snapshot('target')]
  const plan = {
    accepted: true,
    refusals: [],
    snapshots,
    writerBindings: [
      {
        sourceWriterKey: 'structure:A0ResourceExtractor',
        target: { ref: { namespace: 'Unit', entityId: 'WZOilDerrick' } },
      },
    ],
  }
  expect(toSc2ObjectMappings(plan, snapshots)['structure:A0ResourceExtractor']).toEqual({
    objectKind: 'unit',
    typeId: 'WZOilDerrick',
  })
  expect(() =>
    toSc2ObjectMappings(plan, [
      snapshots[0]!,
      snapshots[1]!,
      { ...snapshots[2]!, revision: 'target-2' },
    ]),
  ).toThrow(/target changed/)
  expect(() => toSc2ObjectMappings(plan, snapshots.slice(0, 2))).toThrow(/bindings changed/)
  expect(() => toSc2ObjectMappings({ ...plan, accepted: false }, snapshots)).toThrow(/No accepted/)
  expect(() =>
    toSc2ObjectMappings(
      {
        ...plan,
        writerBindings: [
          {
            ...plan.writerBindings[0]!,
            target: { ref: { namespace: 'Actor', entityId: 'WZOilDerrick' } },
          },
        ],
      },
      snapshots,
    ),
  ).toThrow(/SC2 Unit/)
})
