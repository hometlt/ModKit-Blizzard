/** Generated cliff models are UVW presentation; W3E regenerates terrain, not extra DOO objects. */
import { expect, it } from 'vitest'
import { serializeUvwProfile, type UvwProfileDocument } from '@modkit/uv/world'
import { encodeWar3Map } from '../src/war3-map/encoder.js'

it('does not turn derived cliff presentation into authored Warcraft III doodads', () => {
  const document: UvwProfileDocument = {
    uv: { format: 'UVW', version: '1.0', status: 'profile' }, connections: [],
    spaces: [{ id: 'main', topology: 'heightfield',
      basis: { handedness: 'right', upAxis: 'y', forwardAxis: '+z', unit: 'source-unit',
        sourceUnit: 'warcraft3-world-unit', unitsPerCell: 128 },
      bounds: { min: [0, 0, 0], max: [128, 1, 128] },
      layers: [
        { id: 'ground', kind: 'heightfield', columns: 2, rows: 2, cellSize: 128,
          origin: [0, 0, 0], samples: [[0, 0], [0, 0]] },
        { schemaVersion: 1, id: 'objects', kind: 'objects', instances: [{
          id: 'footman', objectKind: 'unit', typeId: 'hfoo', position: [32, 0, 32],
          rotation: [0, 0, 0, 1], scale: [1, 1, 1], resourceIds: [],
        }] },
      ],
    }],
  }
  const marked: UvwProfileDocument = { ...document, spaces: document.spaces.map(space => ({ ...space,
    layers: space.layers.map(layer => layer.kind !== 'objects' ? layer : { ...layer,
      instances: [...layer.instances, { id: 'cliff-preview', objectKind: 'doodad' as const,
        derivedFrom: 'cliffs' as const, typeId: 'LTlt', position: [64, 0, 64] as const,
        rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const, resourceIds: [] }],
    }),
  })) }
  const baseline = encodeWar3Map(serializeUvwProfile(document))
  const result = encodeWar3Map(serializeUvwProfile(marked))
  expect(result.bytes).toEqual(baseline.bytes)
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: 'blizzard.war3/map-derived-cliff-presentation', severity: 'warning',
  }))
})
