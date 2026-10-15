import { describe, expect, it, vi } from 'vitest'
import { catalogFieldValue, commaSeparatedVector, projectCatalogLight, resolvedFieldRecord } from '../../../src/ts-lane/catalog-light.js'

// The production bridge deliberately loads compiled JS; isolate map parity without rebuilding shared dist.
vi.mock('../../../shared/catalog-light.js', async () => import('../../../src/ts-lane/catalog-light.js'))

const light = {
  entityId: 'BelShirLight',
  fields: {
    ToDInfoArray: [
      { index: '0', AmbientColor: '0.1,0.1,0.1', DirectionalLight: [
        { index: 'Key', value: { Direction: '0,0,-1' } },
      ] },
      { value: { index: '1', AmbientColor: { value: '0.2,0.3,0.4' },
        AmbientEnvironmentMultiplier: '0.75', DirectionalLight: [
          { index: 'Fill', value: { Color: '0.3,0.4,0.5', Direction: '-0.8,-0.1,-0.3' } },
          { index: 'Key', value: { Color: '1,0.9,0.8', ColorMultiplier: '1.25',
            SpecularColor: '0.7,0.6,0.5', SpecColorMultiplier: '0.4',
            Direction: '0.4,-0.6,-0.7' } },
        ], Param: [{ index: 'HDRExposure', value: 1.55 }, { index: 'HDRWhitePoint', value: 1.85 },
          { index: 'ColorizationContrast', value: 1.17 }, { index: 'TerrainSpecularExp', value: 24 }] } },
    ],
  },
}

describe('resolved CLight static projection', () => {
  it('selects the last Key state and preserves map UVW lighting, order, multipliers and HDR', () => {
    const projection = projectCatalogLight(light)
    expect(projection.status).toBe('ok')
    if (projection.status !== 'ok') throw new Error('fixture has no static lighting')
    expect(projection.hasTimeOfDayStates).toBe(true)
    expect(projection.stateCount).toBe(2)
    expect(projection.lighting).toMatchObject({
      coordinateSpaceId: 'uvw-canonical', ambientColor: [0.2, 0.3, 0.4], ambientIntensity: 0.75,
      terrain: { specularExponent: 24, diffuseMultiplier: 1, specularMultiplier: 1 },
      directional: [
        { id: 'BelShirLight:Key', direction: [0.4, -0.7, 0.6], color: [1, 0.9, 0.8],
          intensity: 1.25, specularColor: [0.7, 0.6, 0.5], specularIntensity: 0.4,
          useAmbientOcclusion: true },
        { id: 'BelShirLight:Fill', direction: [-0.8, -0.3, 0.1], color: [0.3, 0.4, 0.5] },
      ],
      toneMapping: { operator: 'reinhard', exposure: 1.55, whitePoint: 1.85, contrast: 1.17 },
    })
    expect(Object.isFrozen(projection.lighting.directional[0])).toBe(true)
  })

  it('keeps the map parser behavior for bare and resolved field records and vectors', () => {
    expect(catalogFieldValue({ value: 'Interior' })).toBe('Interior')
    expect(catalogFieldValue('Exterior')).toBe('Exterior')
    expect(resolvedFieldRecord({ value: { index: 'Key' } })).toEqual({ index: 'Key' })
    expect(commaSeparatedVector(' 0.1, 0.2, 0.3 ', 3, 'native vector')).toEqual([0.1, 0.2, 0.3])
    expect(() => commaSeparatedVector('1,NaN,3', 3, 'native vector')).toThrow('native vector must contain 3 finite')
  })

  it('retains unavailability and invalid authored-field refusals', () => {
    expect(projectCatalogLight({ entityId: 'Empty', fields: {} })).toMatchObject({ status: 'no-static-key' })
    expect(projectCatalogLight({ entityId: 'Dark', fields: { ToDInfoArray: {
      DirectionalLight: [{ index: 'Key', Direction: '0,1,0' }],
    } } })).toMatchObject({ status: 'no-ambient' })
    expect(() => projectCatalogLight({ entityId: 'Zero', fields: { ToDInfoArray: {
      AmbientColor: '0,0,0', DirectionalLight: [{ index: 'Key', Direction: '0,0,0' }],
    } } })).toThrow('must be non-zero')
    expect(() => projectCatalogLight({ entityId: 'Negative', fields: { ToDInfoArray: {
      AmbientColor: '0,0,0', DirectionalLight: [{ index: 'Key', Direction: '0,1,0', ColorMultiplier: '-1' }],
    } } })).toThrow('must be non-negative')
  })

  it('keeps HDR absent until both valid exposure and white point are authored', () => {
    const projection = projectCatalogLight({ entityId: 'Plain', fields: { ToDInfoArray: {
      AmbientColor: '0,0,0', DirectionalLight: [{ index: 'Key', Direction: '0,1,0' }],
      Param: [{ index: 'HDRExposure', value: 1.5 }],
    } } })
    expect(projection.status).toBe('ok')
    if (projection.status !== 'ok') throw new Error('fixture has no static lighting')
    expect(projection.lighting.toneMapping).toBeUndefined()
    expect(projection.hasTimeOfDayStates).toBe(false)
  })

  it('keeps CTerrain lookup and map-only fog/shadow projection in the map resolver', async () => {
    const { analyzeStarcraft2MapWorkspace } = await import('../providers/semantic/runtime.js')
    const request = {
      schemaVersion: 1, workspaceId: 'lighting-fixture', gameId: 'blizzard/starcraft-2',
      mapId: 'lighting.SC2Map', snapshotId: 'lighting-snapshot',
      documents: [{ path: 't3Terrain.xml', bytes: new TextEncoder().encode(
        '<terrain version="1"><heightMap tileSet="BelShir" dim="1 1" offset="0 0 0" scale="1 1 1"/></terrain>') }],
      unresolvedRequirementIds: [], requiredRequirementIds: [], maxDocuments: 16,
      maxDocumentBytes: 1_000_000, maxTotalBytes: 2_000_000, maxObjects: 100, maxRegions: 100,
      maxTerrainCells: 100, maxTerrainSamples: 100, maxDepth: 32, maxDiagnostics: 100,
      catalog: { schemaVersion: 1, workspaceId: 'lighting-fixture', gameId: 'blizzard/starcraft-2',
        snapshotId: 'catalog-snapshot', entities: [], definitions: [
          { namespace: 'Terrain', typeId: 'CTerrain', entityId: 'BelShir',
            fields: { Lighting: 'BelShirLight', FogEnabled: '1', FogColor: '255,3,65,114',
              FogDensity: '0.05', FogFalloff: '0.3', FogStartingHeight: '3.4' } },
          { namespace: 'Light', typeId: 'CLight', ...light },
          { namespace: 'Camera', typeId: 'CCamera', entityId: 'Dflt',
            fields: { ParamInitial: [{ index: 'FieldOfView', value: 27.799999 },
              { index: 'ShadowClip', value: 75 }] } },
        ] },
    }
    const result = await analyzeStarcraft2MapWorkspace(request)
    expect(result.lighting).toMatchObject({
      ambientColor: [0.2, 0.3, 0.4], directional: [
        { id: 'BelShirLight:Key' }, { id: 'BelShirLight:Fill' },
      ],
      fog: { color: [3 / 255, 65 / 255, 114 / 255], density: 0.05, falloff: 0.3, startingHeight: 3.4 },
      shadowRange: { distance: 75, fieldOfViewDegrees: 27.799999 },
    })
    expect(result.semantic.catalogQueries).toEqual(expect.arrayContaining([
      { namespace: 'Terrain', entityId: 'BelShir' }, { namespace: 'Light', entityId: 'BelShirLight' },
    ]))
    const unavailable = await analyzeStarcraft2MapWorkspace({ ...request,
      catalog: { ...request.catalog, definitions: request.catalog.definitions.map(entity =>
        entity.namespace === 'Light' ? { ...entity, fields: {} } : entity) } })
    expect(unavailable.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'information', code: 'blizzard.starcraft2/map-lighting-state-unavailable',
        message: 'CLight BelShirLight has no static state with a Key direction', path: 't3Terrain.xml' }),
    ]))
    expect(unavailable.worldCandidate.unknownFacets).toContain('lighting')
  })
})
