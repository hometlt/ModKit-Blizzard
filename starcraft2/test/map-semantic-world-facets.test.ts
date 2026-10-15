import { describe, expect, it } from 'vitest'
import { createCandidateWorldSceneLease } from '@modkit/host'
import { drawCandidateWorld, inspectCandidateWorld } from '@modkit/ui/world'
import {
  createUvwWorldSceneSource,
  materializeWorldToUvpMap,
  materializeWorldToUvw,
  parseUvwProfile,
  serializeUvwProfile,
} from '@modkit/uv/world'
import { readNativeMpqSnapshot } from '../../mpq/src/mpq/native-preserving.js'
import {
  analyzeStarcraft2MapWorkspace,
  planStarcraft2Map,
} from '../modules/map/providers/semantic/runtime.js'
import { convertUvwToStarcraft2Map } from '../modules/map/codecs/package/src/uvw-map-converter.js'
import {
  readMapInfo,
  writeMapInfo,
} from '../modules/map/shared/format/formats/map-info.js'
import { readWater } from '../modules/map/shared/format/formats/water.js'

const encoder = new TextEncoder()

function hmap(width = 3, height = 3): Uint8Array {
  const bytes = new Uint8Array(32 + width * height * 6)
  bytes.set(encoder.encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, width, true)
  view.setUint32(12, height, true)
  for (let index = 0; index < width * height; index += 1) {
    view.setUint16(32 + index * 6, 100 + index, true)
    view.setUint16(34 + index * 6, index === 4 ? 0x9000 : 0, true)
  }
  return bytes
}

function textureInfo(): Uint8Array {
  const names = encoder.encode('BelShirGrass\0BelShirDirt\0')
  const bytes = new Uint8Array(16 + names.length + 9 * 4)
  bytes.set(encoder.encode('RTXT'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 2, true)
  view.setUint32(8, 3, true)
  view.setUint32(12, 3, true)
  bytes.set(names, 16)
  for (let index = 0; index < 9; index += 1) {
    view.setUint32(16 + names.length + index * 4, index % 2, true)
  }
  return bytes
}

function textureMasks(width = 3, height = 3): Uint8Array {
  const layers = 2
  const tilesX = Math.ceil(width / 64)
  const tilesY = Math.ceil(height / 64)
  const blocksPerLayer = tilesX * tilesY
  const bytes = new Uint8Array(64 + layers * blocksPerLayer * 2048)
  bytes.set(encoder.encode('MASK'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 1, true)
  view.setUint32(12, width, true)
  view.setUint32(16, height, true)
  const setWeight = (layer: number, x: number, y: number, weight: number) => {
    const tileX = Math.floor(x / 64)
    const tileY = Math.floor(y / 64)
    const block = layer * blocksPerLayer + tileY * tilesX + tileX
    const offset = 64 + block * 2048 + (y % 64) * 32 + ((x % 64) >> 1)
    const current = bytes[offset] ?? 0
    bytes[offset] = (x & 1) === 0 ? (current & 0x0f) | (weight << 4) : (current & 0xf0) | weight
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const first = (x + y) % 2 === 0 ? 12 : 3
      setWeight(0, x, y, first)
      setWeight(1, x, y, 15 - first)
    }
  }
  return bytes
}

function waterZones(templateIds: readonly string[]): Uint8Array {
  const bytes = new Uint8Array(32 + templateIds.length * 56)
  bytes.set(encoder.encode('WATR'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 1, true)
  view.setUint32(8, templateIds.length, true)
  templateIds.forEach((templateId, index) => {
    const offset = 32 + index * 56
    bytes.set(encoder.encode(templateId), offset)
    view.setFloat32(offset + 40, 0.5 + index * 0.25, true)
    view.setFloat32(offset + 44, 0.5 + index * 0.25, true)
    view.setFloat32(offset + 48, 2.5 + index * 0.25, true)
    view.setFloat32(offset + 52, 2.5 + index * 0.25, true)
  })
  return bytes
}

function water(): Uint8Array {
  return waterZones(['BelShirWater'])
}

function cliffs(): Uint8Array {
  const bytes = new Uint8Array(32 + 9 * 2)
  bytes.set(encoder.encode('CLIF'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 1, true)
  view.setUint32(8, 3, true)
  view.setUint32(12, 3, true)
  for (let index = 0; index < 9; index += 1)
    view.setUint16(32 + index * 2, index % 3 > 0 ? 16 : 0, true)
  return bytes
}

const request = {
  schemaVersion: 1 as const,
  workspaceId: 'fixture-workspace',
  gameId: 'blizzard/starcraft-2',
  mapId: 'fixture.SC2Map',
  snapshotId: 'fixture-snapshot',
  documents: [
    {
      path: 'Objects',
      bytes: encoder.encode(
        '<PlacedObjects><ObjectUnit Id="1" UnitType="Marine" Position="0.5,0.5,0"/><ObjectUnit Id="2" UnitType="Marine" Position="2,2,0" Rotation="1.5"/></PlacedObjects>',
      ),
    },
    {
      path: 'Regions',
      bytes: encoder.encode(
        '<Regions><region id="1"><name value="center"/><shape type="circle"><center value="1,1"/><radius value="0.5"/></shape></region></Regions>',
      ),
    },
    { path: 't3HeightMap', bytes: hmap() },
    {
      path: 't3Terrain.xml',
      bytes: encoder.encode(
        '<terrain version="1"><heightMap tileSet="BelShir" dim="3 3" offset="0 0 0" scale="1 1 1"><vertData quantizeBias="0" quantizeScale="0.01" standardHeight="0"/></heightMap><textureList><texture i="0" name="BelShirGrass"/><texture i="1" name="BelShirDirt"/></textureList></terrain>',
      ),
    },
    { path: 't3SyncTextureInfo', bytes: textureInfo() },
    { path: 't3TextureMasks', bytes: textureMasks() },
    { path: 't3Water', bytes: water() },
    {
      path: 'Base.SC2Data/GameData/WaterData.xml',
      bytes: encoder.encode(
        '<Catalog><CWater id="BelShirWater" TextureKey="Assets/Textures/DefaultWater.dds" TilingFreq="0.125,0.125,0.125,0.125" ScrollVectors="0.03,0.03,-0.03,-0.03" CausticsTilingFreq="0.225,0.225" CausticsFPS="15" ReceiveShadows="1"><State index="0" Height="9.25" Color="0.12,0.3,0.45,0.55" ColorFallOff="0.1" Specularity="32" SpecularScaler="0.25" ReflectivityPower="8"/></CWater></Catalog>',
      ),
    },
    { path: 't3SyncCliffLevel', bytes: cliffs() },
  ],
  unresolvedRequirementIds: [],
  requiredRequirementIds: [],
  maxDocuments: 16,
  maxDocumentBytes: 1_000_000,
  maxTotalBytes: 2_000_000,
  maxObjects: 100,
  maxRegions: 100,
  maxTerrainCells: 100,
  maxTerrainSamples: 100,
  maxDepth: 32,
  maxDiagnostics: 100,
  catalog: {
    schemaVersion: 1,
    workspaceId: 'fixture-workspace',
    gameId: 'blizzard/starcraft-2',
    snapshotId: 'catalog-snapshot',
    entities: [],
    // Resolved-workspace enrichment publishes the complete catalog through `definitions` while
    // `entities` remains the explicit-query result slice.
    definitions: [
      {
        namespace: 'Unit',
        typeId: 'CUnit',
        entityId: 'Marine',
        inheritanceChain: [],
        fields: {},
        sources: [],
        complete: true,
      },
      {
        namespace: 'Actor',
        typeId: 'CActorUnit',
        entityId: 'MarineActor',
        inheritanceChain: [],
        fields: {
          unitName: 'Marine',
          Model: 'MarineModel',
          On: [{ Terms: 'UnitBirth.Marine', Send: 'Create' }],
        },
        sources: [],
        complete: true,
      },
      {
        namespace: 'Model',
        typeId: 'CModel',
        entityId: 'MarineModel',
        inheritanceChain: [],
        fields: { Model: 'Assets/Units/Terran/Marine/Marine.m3' },
        sources: [],
        complete: true,
      },
      {
        namespace: 'TerrainTex',
        typeId: 'CTerrainTex',
        entityId: 'BelShirGrass',
        inheritanceChain: [],
        fields: {
          Texture: 'Assets/Terrain/BelShirGrass.dds',
          Normalmap: 'Assets/Terrain/BelShirGrass_N.dds',
        },
        sources: [],
        complete: true,
      },
      {
        namespace: 'TerrainTex',
        typeId: 'CTerrainTex',
        entityId: 'BelShirDirt',
        inheritanceChain: [],
        fields: { Texture: 'Assets/Terrain/BelShirDirt.dds' },
        sources: [],
        complete: true,
      },
      {
        namespace: 'Water',
        typeId: 'CWater',
        entityId: 'BelShirWater',
        inheritanceChain: [],
        fields: {
          TextureKey: 'Assets/Textures/DefaultWater.dds',
          TilingFreq: '0.125,0.125,0.125,0.125',
          ScrollVectors: '0.03,0.03,-0.03,-0.03',
          CausticsTilingFreq: '0.225,0.225',
          CausticsFPS: 15,
          ReceiveShadows: 1,
          State: [
            {
              Height: 9.25,
              Color: '0.12,0.3,0.45,0.55',
              ColorFallOff: 0.1,
              Specularity: 32,
              SpecularScaler: 0.25,
              ReflectivityPower: 8,
            },
          ],
        },
        sources: [],
        complete: true,
      },
      {
        namespace: 'Terrain',
        typeId: 'CTerrain',
        entityId: 'BelShir',
        inheritanceChain: [],
        fields: { Lighting: 'BelShirLight' },
        sources: [],
        complete: true,
      },
      {
        namespace: 'Light',
        typeId: 'CLight',
        entityId: 'BelShirLight',
        inheritanceChain: [],
        fields: {
          ToDInfoArray: [
            {
              index: '0',
              AmbientColor: '0.2,0.3,0.4',
              AmbientEnvironmentMultiplier: '0.75',
              DirectionalLight: [
                {
                  index: 'Key',
                  value: {
                    Color: '1,0.9,0.8',
                    ColorMultiplier: '1.25',
                    Direction: '0.4,-0.6,-0.7',
                  },
                },
                {
                  index: 'Fill',
                  value: {
                    Color: '0.3,0.4,0.5',
                    ColorMultiplier: '0.5',
                    Direction: '-0.8,-0.1,-0.3',
                  },
                },
              ],
            },
          ],
        },
        sources: [],
        complete: true,
      },
    ],
  },
}

describe('SC2 resolved world facets', () => {
  it('publishes authored HDR exposure and white point through the resolved lighting facet', async () => {
    const definitions = request.catalog.definitions.map(entity => entity.namespace !== 'Light' ? entity : {
      ...entity,
      fields: { ...entity.fields, ToDInfoArray: entity.fields.ToDInfoArray.map(state => ({
        ...state,
        Param: [{ index: 'HDRExposure', value: 1.55 }, { index: 'HDRWhitePoint', value: 1.85 }],
      })) },
    })
    const result = await analyzeStarcraft2MapWorkspace({ ...request, catalog: { ...request.catalog, definitions } })
    expect(result.lighting.toneMapping).toMatchObject({ operator: 'reinhard', exposure: 1.55, whitePoint: 1.85, contrast: 1 })
  })
  it('tones with ColorizationContrast, the only contrast SC2 lighting has', async () => {
    const definitions = request.catalog.definitions.map(entity => entity.namespace !== 'Light' ? entity : {
      ...entity,
      fields: { ...entity.fields, ToDInfoArray: entity.fields.ToDInfoArray.map(state => ({
        ...state,
        Param: [
          { index: 'HDRExposure', value: 1.55 },
          { index: 'HDRWhitePoint', value: 1.85 },
          { index: 'ColorizationContrast', value: 1.17 },
        ],
      })) },
    })
    const result = await analyzeStarcraft2MapWorkspace({ ...request, catalog: { ...request.catalog, definitions } })
    // PSTonemap.fx raises luminance to p_fContrast before exposure; the editor sets it from this parameter.
    expect(result.lighting.toneMapping).toMatchObject({ exposure: 1.55, whitePoint: 1.85, contrast: 1.17 })
  })
  it('publishes the tileset height fog, its colour read as A,R,G,B bytes', async () => {
    const withFog = (fields: Record<string, string>) => request.catalog.definitions.map(entity =>
      entity.namespace !== 'Terrain' ? entity : { ...entity, fields: { ...entity.fields, ...fields } })
    const fog = { FogEnabled: '1', FogColor: '255,3,65,114', FogDensity: '0.05', FogFalloff: '0.3', FogStartingHeight: '3.4' }
    const result = await analyzeStarcraft2MapWorkspace({ ...request, catalog: { ...request.catalog, definitions: withFog(fog) } })
    // Shaders/Common.fx FogDensity reads density, falloff and starting height as authored.
    expect(result.lighting.fog).toEqual({ color: [3 / 255, 65 / 255, 114 / 255], density: 0.05, falloff: 0.3, startingHeight: 3.4 })
    const disabled = await analyzeStarcraft2MapWorkspace({
      ...request, catalog: { ...request.catalog, definitions: withFog({ ...fog, FogEnabled: '0' }) },
    })
    expect(disabled.lighting.fog).toBeUndefined()
  })
  it('bounds shadows by the game camera ShadowClip and asks the catalog for that camera', async () => {
    const withoutCamera = await analyzeStarcraft2MapWorkspace(request)
    // No resolved camera yet: the map names it, and shadows stay unbounded until it is answered.
    expect(withoutCamera.lighting.shadowRange).toBeUndefined()
    expect(withoutCamera.semantic.catalogQueries).toContainEqual(expect.objectContaining({ namespace: 'Camera', entityId: 'Dflt' }))
    const camera = {
      namespace: 'Camera', typeId: 'CCamera', entityId: 'Dflt',
      fields: { ParamInitial: [
        { index: 'FieldOfView', value: 27.799999 }, { index: 'NearClip', value: 0.1 },
        { index: 'ShadowClip', value: 75 }, { index: 'Distance', value: 34 },
      ] },
      inheritanceChain: [], sources: [], complete: true,
    }
    const result = await analyzeStarcraft2MapWorkspace({
      ...request, catalog: { ...request.catalog, definitions: [...request.catalog.definitions, camera as never] },
    })
    expect(result.lighting.shadowRange).toEqual({ distance: 75, fieldOfViewDegrees: 27.799999 })
  })
  it('keeps the main unit model when a child decal also creates on UnitBirth', async () => {
    const definitions = request.catalog.definitions.map(entity => entity.entityId === 'MarineActor'
      ? { ...entity, fields: { ...entity.fields, On: [] } } : entity)
    definitions.push({ namespace: 'Actor', typeId: 'CActorModel', entityId: 'MarineSplat',
      fields: { Model: 'Decal', On: [{ Terms: 'UnitBirth.Marine', Send: 'Create' }] },
      inheritanceChain: [], sources: [], complete: true } as never)
    definitions.push({ namespace: 'Model', typeId: 'CModel', entityId: 'Decal',
      fields: { Model: 'Assets/Decal.m3' }, inheritanceChain: [], sources: [], complete: true } as never)
    const result = await analyzeStarcraft2MapWorkspace({ ...request, catalog: { ...request.catalog, definitions } })
    expect(result.semantic.objects[0].modelResource.logicalId).toContain('Marine.m3')
  })
  it('resolves CTerrain lighting through the effective catalog and maps it into UVW space', async () => {
    const discovery = await analyzeStarcraft2MapWorkspace({ ...request, catalog: undefined })
    expect(discovery.semantic.catalogQueries).toEqual(
      expect.arrayContaining([{ namespace: 'Terrain', entityId: 'BelShir' }]),
    )
    expect(discovery.worldCandidate.unknownFacets).toContain('lighting')

    const result = await analyzeStarcraft2MapWorkspace(request)

    expect(result.lighting).toMatchObject({
      coordinateSpaceId: 'uvw-canonical',
      ambientColor: [0.2, 0.3, 0.4],
      ambientIntensity: 0.75,
      directional: [
        {
          id: 'BelShirLight:Key',
          direction: [0.4, -0.7, 0.6],
          color: [1, 0.9, 0.8],
          intensity: 1.25,
        },
        {
          id: 'BelShirLight:Fill',
          direction: [-0.8, -0.3, 0.1],
          color: [0.3, 0.4, 0.5],
          intensity: 0.5,
        },
      ],
    })
    expect(result.worldCandidate.unknownFacets).not.toContain('lighting')
    expect(result.semantic.catalogQueries).toEqual(
      expect.arrayContaining([
        { namespace: 'Terrain', entityId: 'BelShir' },
        { namespace: 'Light', entityId: 'BelShirLight' },
      ]),
    )
  })

  it('keeps a valid terrain/object map complete when optional Regions is absent', async () => {
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.filter(document => document.path !== 'Regions'),
    })

    expect(result.complete).toBe(true)
    expect(result.semantic.regions).toEqual([])
    expect(result.semantic.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'information',
        code: 'blizzard.starcraft2/map-optional-document-missing',
      }),
    )
  })

  it('names the world edit the opened map declares, and none when it declares neither', async () => {
    const route = async (subjectOperationIds?: readonly string[]) =>
      (
        await analyzeStarcraft2MapWorkspace({
          ...request,
          ...(subjectOperationIds === undefined ? {} : { subjectOperationIds }),
        })
      ).worldCandidate?.edit
    // A folder map's codec names its operations after itself.
    expect(await route(['view.inspect', 'blizzard/sc2-map-directory.edit-world'])).toEqual({
      operationId: 'blizzard/sc2-map-directory.edit-world',
      moveObjectKind: 'object.update',
    })
    expect(await route(['blizzard/sc2-map.edit-world'])).toMatchObject({ operationId: 'blizzard/sc2-map.edit-world' })
    expect(await route(['view.inspect'])).toBeUndefined()
    // Documents analyzed without an opened subject keep the packed map's name.
    expect(await route()).toMatchObject({ operationId: 'blizzard/sc2-map.edit-world' })
  })

  it('publishes a doodad TintColor as its presentation tint', async () => {
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.map(document =>
        document.path === 'Objects'
          ? {
              ...document,
              bytes: encoder.encode(
                '<PlacedObjects><ObjectDoodad Id="1" Type="Elsecaro_Small_Props" Position="1,1,0" TintColor="139,177,241"/><ObjectDoodad Id="2" Type="Elsecaro_Small_Props" Position="2,2,0"/></PlacedObjects>',
              ),
            }
          : document,
      ),
    })
    const [tinted, plain] = result.semantic.objects
    // The editor's umbrellas are blue: TintColor multiplies the model, as the texture's own 0..255.
    expect(tinted?.presentationTint).toEqual([139 / 255, 177 / 255, 241 / 255])
    expect(plain).not.toHaveProperty('presentationTint')
  })

  it("loads a model's declared textures in its TileSet's TextureProp variant, the map's by default", async () => {
    const decalModel = {
      namespace: 'Model', typeId: 'CModel', entityId: 'DecalProtoss',
      fields: {
        Model: 'Assets/Doodads/DecalProtoss/DecalProtoss.m3',
        VariationCount: '6',
        TextureDeclares: [
          { index: '0', value: { Prefix: 'DecalProtoss00_', Adaptions: [{ index: '0', value: { TriggerOnSubstring: '_Diffuse', Slot: 'main' } }] } },
          { index: '1', value: { Prefix: 'DecalProtoss01_', Adaptions: [{ index: '0', value: { TriggerOnSubstring: '_Diffuse', Slot: 'generic01' } }] } },
          // Without TriggerOnSubstring the adaption takes every texture of the prefix (CModel Bush: bush_).
          { index: '2', value: { Prefix: 'DecalProtoss02_', Adaptions: [{ index: '0', value: { Slot: 'generic02' } }] } },
        ],
      },
      inheritanceChain: [], sources: [], complete: true,
    }
    const terrain = (entityId: string, fields: Record<string, string>) => ({
      namespace: 'Terrain', typeId: 'CTerrain', entityId, fields, inheritanceChain: [], sources: [], complete: true,
    })
    const definitions = [
      ...request.catalog.definitions.map(entity => entity.namespace === 'Terrain' && entity.entityId === 'BelShir'
        ? { ...entity, fields: { ...entity.fields, TextureProp: 'belshir' } } : entity),
      decalModel, terrain('MonlythEx1', { TextureProp: 'monlyth' }), terrain('Monlyth', {}),
    ]
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      catalog: { ...request.catalog, definitions: definitions as never },
      documents: request.documents.map(document =>
        document.path === 'Objects'
          ? {
              ...document,
              bytes: encoder.encode(
                '<PlacedObjects><ObjectDoodad Id="1" Type="DecalProtoss" Variation="2" Position="1,1,0" TileSet="MonlythEx1"/><ObjectDoodad Id="2" Type="DecalProtoss" Position="2,2,0"/><ObjectDoodad Id="3" Type="DecalProtoss" Position="2,1,0" TileSet="Monlyth"/></PlacedObjects>',
              ),
            }
          : document,
      ),
    })
    const [sanctuary, mapDefault, withoutProp] = result.semantic.objects
    const names = [
      { prefix: 'DecalProtoss00_', contains: '_Diffuse' },
      { prefix: 'DecalProtoss01_', contains: '_Diffuse' },
      { prefix: 'DecalProtoss02_', contains: '' },
    ]
    // Sanctuary's expansion plates: TileSet MonlythEx1 (TextureProp monlyth) loads DecalProtoss00_Diffuse_monlyth.dds.
    expect(sanctuary?.modelTextureVariant).toEqual({ suffix: '_monlyth', names })
    expect(sanctuary?.modelResource).toMatchObject({
      id: 'sc2-map-model:DecalProtoss:DecalProtoss:variation-02:textures_monlyth',
      logicalId: expect.stringContaining('DecalProtoss_02.m3'),
    })
    expect(mapDefault?.modelTextureVariant).toEqual({ suffix: '_belshir', names })
    // A Wings of Liberty tileset has no TextureProp: the model keeps its textures as named.
    expect(withoutProp).not.toHaveProperty('modelTextureVariant')
    expect(withoutProp?.modelResource?.id).not.toContain('textures')
    for (const object of result.semantic.objects) expect(object).not.toHaveProperty('tileSet')
    const unanswered = await analyzeStarcraft2MapWorkspace({
      ...request,
      catalog: { ...request.catalog, definitions: [...request.catalog.definitions, decalModel] as never },
      documents: request.documents.map(document =>
        document.path === 'Objects'
          ? { ...document, bytes: encoder.encode('<PlacedObjects><ObjectDoodad Id="1" Type="DecalProtoss" Position="1,1,0" TileSet="MonlythEx1"/></PlacedObjects>') }
          : document,
      ),
    })
    // The placement's tileset is asked of the catalog like any other entity it needs.
    expect(unanswered.semantic.catalogQueries).toContainEqual({ namespace: 'Terrain', entityId: 'MonlythEx1' })
  })

  it('reads an HDR TintColor and leaves out only an object it cannot read', async () => {
    // mission-nod.SC2Map: the editor's HDR tint writes a brightness after the colour; one such doodad
    // used to fail the whole Objects document, and the world showed no object at all.
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.map(document =>
        document.path === 'Objects'
          ? {
              ...document,
              bytes: encoder.encode(
                '<PlacedObjects><ObjectDoodad Id="1" Type="TyphonTree" Position="1,1,0" TintColor="169,198,83 2.100000"/><ObjectDoodad Id="2" Type="TyphonTree" Position="2,2,0" TintColor="red"/><ObjectDoodad Id="3" Type="TyphonTree" Position="3,3,0"/></PlacedObjects>',
              ),
            }
          : document,
      ),
    })
    expect(result.semantic.objects.map(object => object.objectId)).toEqual([1, 3])
    const [tint] = result.semantic.objects
    expect(tint?.presentationTint?.map(value => Number(value.toFixed(6)))).toEqual([169, 198, 83].map(value => Number(((value / 255) * 2.1).toFixed(6))))
    expect(result.semantic.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', code: 'blizzard.starcraft2/map-object-invalid', message: expect.stringContaining('1 placed object(s) left out') }),
    ]))
  })

  it('plans native terrain material, water and cliff documents through host-owned reads', async () => {
    const result = await planStarcraft2Map({
      workspace: {
        schemaVersion: 1,
        workspaceId: 'fixture-workspace',
        gameId: 'blizzard/starcraft-2',
        activeRootId: 'map',
        loadOrder: [{ rootId: 'map', kind: 'map', sourcePath: 'fixture.SC2Map' }],
      },
      maxRequirements: 13,
    })
    expect(result.complete).toBe(true)
    expect(result.requirements).toHaveLength(13)
    expect(result.requirements.map(item => item.path)).toEqual(
      expect.arrayContaining([
        'fixture.SC2Map/t3synctextureinfo',
        'fixture.SC2Map/t3texturemasks',
        'fixture.SC2Map/t3water',
        'base.sc2data/gamedata/waterdata.xml',
        'fixture.SC2Map/t3syncclifflevel',
        'fixture.SC2Map/t3vertcol',
        'fixture.SC2Map/t3cellflags',
      ]),
    )
  })

  it('cuts the cells t3CellFlags marks 3 where the ground falls into cliff level A', async () => {
    // LFCT v102 over the 2x2 cells of the 3x3 height grid. The vertices of column 0 lie on level A
    // (heightAdjustment 0 at bias 8: eight below B), the void below Lockdown's platform; the rest on B.
    // Cut cells with a corner on A are not drawn; the cut cell (1, 0), all on B, stands under a wall
    // the renderer cuts by the piece itself.
    const flags = new Uint8Array(32 + 4)
    flags.set(encoder.encode('LFCT'))
    const view = new DataView(flags.buffer)
    view.setUint32(4, 102, true)
    view.setUint32(24, 2, true)
    view.setUint32(28, 2, true)
    flags.set([3, 3, 3, 2], 32)
    const heights = hmap()
    const heightView = new DataView(heights.buffer)
    for (let index = 0; index < 9; index += 1)
      heightView.setUint16(34 + index * 6, index % 3 === 0 ? 0 : 16, true)
    const decoder = new TextDecoder()
    const documents = request.documents.map(document =>
      document.path === 't3HeightMap'
        ? { ...document, bytes: heights }
        : document.path === 't3Terrain.xml'
          ? {
              ...document,
              bytes: encoder.encode(
                decoder
                  .decode(document.bytes)
                  .replace('quantizeBias="0" quantizeScale="0.01"', 'quantizeBias="8" quantizeScale="0.5"'),
              ),
            }
          : document,
    )
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: [...documents, { path: 't3CellFlags', bytes: flags }],
    })
    const hidden = result.semantic.terrain?.samples
      .filter(sample => (sample as { presentationCellHidden?: true }).presentationCellHidden === true)
      .map(sample => [sample.x, sample.y])
    expect(hidden).toEqual([
      [0, 0],
      [0, 1],
    ])
    const whole = await analyzeStarcraft2MapWorkspace({ ...request, documents })
    expect(whole.semantic.terrain?.samples.some(sample => 'presentationCellHidden' in sample)).toBe(false)
  })

  it('reads uvtiling as texture repeats across the map, not units per repeat', async () => {
    // Every shipped campaign map has (dim - 1) / uvtiling = 32/3 units per repeat, so a 3x3 grid
    // (two units across) tiles 0.1875 times: scale = 0.1875 / 2 = 1 / 10.667 repeats per unit.
    const decoder = new TextDecoder()
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.map(document =>
        document.path === 't3Terrain.xml'
          ? {
              ...document,
              bytes: encoder.encode(
                decoder
                  .decode(document.bytes)
                  .replace('dim="3 3"', 'dim="3 3" uvtiling="0.187500 0.187500 0.000000 0.000000"'),
              ),
            }
          : document,
      ),
    })

    const uvTransform = result.terrainMaterials?.materials?.[0]?.uvTransform
    expect(uvTransform?.scale[0]).toBeCloseTo(0.09375, 6)
    expect(uvTransform?.scale[1]).toBeCloseTo(-0.09375, 6)
    // V flips, as shaders/terrainblend.fx does.
    expect(uvTransform?.offset).toEqual([0, 1])
  })

  it('reads water State values spelled as child elements, as every shipped WaterData.xml does', async () => {
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.map(document => {
        if (document.path === 't3Water') return { ...document, bytes: waterZones(['Avernus']) }
        if (document.path === 'Base.SC2Data/GameData/WaterData.xml')
          return {
            ...document,
            bytes: encoder.encode(
              '<Catalog><CWater id="Avernus"><State index="0"><Height value="9.000000"/><Color value="0.09,0.35,0.35,1.0"/><ColorFallOff value="0.1"/></State></CWater></Catalog>',
            ),
          }
        return document
      }),
    })
    expect(result.water?.zones[0]?.elevation).toBe(9)
    expect(result.water?.materials[0]?.color).toEqual([0.09, 0.35, 0.35, 1])
    expect(result.water?.allTemplateElevationsResolved).toBe(true)
  })

  it('publishes the caustics flip-book of a state with CausticsFallOff, and none without it', async () => {
    const analyze = (state: string) =>
      analyzeStarcraft2MapWorkspace({
        ...request,
        documents: request.documents.map(document => {
          if (document.path === 't3Water') return { ...document, bytes: waterZones(['Avernus']) }
          if (document.path === 'Base.SC2Data/GameData/WaterData.xml')
            return {
              ...document,
              bytes: encoder.encode(
                `<Catalog><CWater id="Avernus"><TextureKey value="Assets/Textures/DefaultWater.dds"/><CausticsFPS value="15"/><State index="0"><Height value="9"/><Color value="0.09,0.35,0.35,1.0"/>${state}</State></CWater></Catalog>`,
              ),
            }
          return document
        }),
      })
    const material = (await analyze('<CausticsFallOff value="1.56"/>')).water?.materials[0]
    expect(material?.causticsFalloff).toBe(1.56)
    const frames = material?.causticsFrameResources ?? []
    expect(frames).toHaveLength(32)
    expect(frames[0]?.logicalId).toBe('base.sc2assets/Assets/Textures/DefaultWaterCaustics_001.dds')
    expect(frames[31]?.logicalId).toBe('base.sc2assets/Assets/Textures/DefaultWaterCaustics_032.dds')
    expect(material?.causticsFrameResourceIds).toEqual(frames.map(frame => frame.id))
    expect(material?.causticsResourceId).toBe(frames[0]?.id)
    const plain = (await analyze('')).water?.materials[0]
    expect(plain).not.toHaveProperty('causticsFrameResourceIds')
    expect(plain).not.toHaveProperty('causticsFalloff')
    // The wave normals come from the same stem whatever the state.
    expect(plain?.normalResource?.logicalId).toBe('base.sc2assets/Assets/Textures/DefaultWaterNormal.dds')
    expect(plain?.normalResourceId).toBe(plain?.normalResource?.id)
  })

  it('assigns collision-free deterministic material ids to water template slugs', async () => {
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.map(document => {
        if (document.path === 't3Water') return { ...document, bytes: waterZones(['A-B', 'A_B']) }
        if (document.path === 'Base.SC2Data/GameData/WaterData.xml')
          return {
            ...document,
            bytes: encoder.encode(
              '<Catalog><CWater id="A-B"><State index="0" Height="1" Color="0.1,0.2,0.3,0.4"/></CWater><CWater id="A_B"><State index="0" Height="2" Color="0.2,0.3,0.4,0.5"/></CWater></Catalog>',
            ),
          }
        return document
      }),
    })
    expect(result.water?.zones.map(zone => zone.materialId)).toEqual([
      'water-a-b--412d42',
      'water-a-b--415f42',
    ])
    expect(result.water?.materials.map(material => material.materialId)).toEqual([
      'water-a-b--412d42',
      'water-a-b--415f42',
    ])
  })

  it('resolves dependency-merged water templates from the enriched catalog', async () => {
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.filter(
        document => document.path !== 'Base.SC2Data/GameData/WaterData.xml',
      ),
    })
    expect(result.water).toMatchObject({
      allTemplateElevationsResolved: true,
      allTemplateMaterialsResolved: true,
      zones: [{ templateId: 'BelShirWater', elevation: 9.25, materialId: 'water-belshirwater' }],
      materials: [
        {
          materialId: 'water-belshirwater',
          color: [0.12, 0.3, 0.45, 0.55],
        },
      ],
    })
    // TextureKey names the surface's normal-map flip-book, not a colour: no base colour image.
    expect(result.water?.materials[0]).not.toHaveProperty('baseColorResource')
  })

  it('keeps catalog assets game-logical for dependency-overlay resolution', async () => {
    const source = (root: string, family: string) => ({
      rootId: root,
      path: `mods/${root}.sc2mod/base.sc2data/gamedata/${family}data.xml`,
      documentIndex: 0,
    })
    const lateEntityPatch = source('map-patch', 'actor')
    const definitions = request.catalog.definitions.map(entity => {
      if (entity.namespace === 'Model') {
        return {
          ...entity,
          sources: [source('core', 'model'), lateEntityPatch],
          fieldSources: { Model: source('core', 'model') },
        }
      }
      if (entity.namespace === 'TerrainTex' && entity.entityId === 'BelShirGrass') {
        return {
          ...entity,
          sources: [source('core', 'terraintex'), lateEntityPatch],
          fieldSources: {
            Texture: source('core', 'terraintex'),
            Normalmap: source('liberty', 'terraintex'),
          },
        }
      }
      if (entity.namespace === 'Water') {
        return {
          ...entity,
          fields: { ...entity.fields, TextureKey: 'Assets/Textures/CatalogWater.dds' },
          sources: [source('liberty', 'water'), lateEntityPatch],
          fieldSources: { TextureKey: source('liberty', 'water') },
        }
      }
      return entity
    })
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      catalog: { ...request.catalog, definitions },
    })

    expect(result.semantic.objects[0]?.modelResource?.logicalId).toBe(
      'base.sc2assets/Assets/Units/Terran/Marine/Marine.m3',
    )
    expect(result.terrainMaterials?.materials?.[0]).toMatchObject({
      baseColorResource: {
        logicalId: 'base.sc2assets/Assets/Terrain/BelShirGrass.dds',
      },
      normalResource: {
        logicalId: 'base.sc2assets/Assets/Terrain/BelShirGrass_N.dds',
      },
    })
    expect(result.water?.materials[0]).not.toHaveProperty('baseColorResource')
  })

  it('prefers standing actors, their game model over the editor one, and resolves implicit same-id doodad and tokenized unit models', async () => {
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.map(document =>
        document.path === 'Objects'
          ? {
              ...document,
              bytes: encoder.encode(
                '<PlacedObjects><ObjectUnit Id="1" UnitType="MineralField" Position="1,1,0" Variation="3"/><ObjectDoodad Id="2" Type="CrystalDoodad" Position="2,2,0" Variation="2"><Flag Index="HeightAbsolute" Value="1"/></ObjectDoodad><ObjectUnit Id="3" UnitType="VespeneGeyser" Position="3,3,0"/><ObjectDoodad Id="4" Type="Aiur_Temple_BrickGroup" Position="4,4,0"/></PlacedObjects>',
              ),
            }
          : document,
      ),
      catalog: {
        ...request.catalog,
        definitions: [
          ...request.catalog.definitions,
          // One variation: the model is the file its path names, no `_00` added (Blackrock LE's
          // 198 brick groups name Elsecaro_Small_Props_00.m3; `_00_00` does not exist).
          {
            namespace: 'Actor',
            typeId: 'CActorDoodad',
            entityId: 'Aiur_Temple_BrickGroup',
            inheritanceChain: [],
            fields: {},
            sources: [],
            complete: true,
          },
          {
            namespace: 'Model',
            typeId: 'CModel',
            entityId: 'Aiur_Temple_BrickGroup',
            inheritanceChain: [],
            fields: { Model: 'Assets/Doodads/Elsecaro_Small_Props/Elsecaro_Small_Props_00.m3', VariationCount: '1' },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Unit',
            typeId: 'CUnit',
            entityId: 'MineralField',
            inheritanceChain: [],
            fields: {},
            sources: [],
            complete: true,
          },
          {
            namespace: 'Actor',
            typeId: 'CActorModel',
            entityId: 'AA_MineralDeathActor',
            inheritanceChain: [],
            fields: {
              unitName: 'MineralField',
              Model: 'MineralDeathModel',
              On: [{ Terms: 'UnitDeath.MineralField', Send: 'Create' }],
            },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Actor',
            typeId: 'CActorUnit',
            entityId: 'MineralStandingActor',
            inheritanceChain: [],
            fields: {
              unitName: 'MineralField',
              EditorModel: 'MineralEditorModel',
              Model: 'MineralGameModel',
              On: [{ Terms: 'UnitBirth.MineralField', Send: 'Create' }],
            },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Model',
            typeId: 'CModel',
            entityId: 'MineralDeathModel',
            inheritanceChain: [],
            fields: { Model: 'Assets/Minerals/Death.m3' },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Model',
            typeId: 'CModel',
            entityId: 'MineralEditorModel',
            inheritanceChain: [],
            fields: { Model: 'Assets/Minerals/Editor.m3', VariationCount: '10' },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Model',
            typeId: 'CModel',
            entityId: 'MineralGameModel',
            inheritanceChain: [],
            fields: { Model: 'Assets/Minerals/Game.m3', VariationCount: '10' },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Actor',
            typeId: 'CActorDoodad',
            entityId: 'CrystalDoodad',
            inheritanceChain: [],
            fields: {},
            sources: [],
            complete: true,
          },
          {
            namespace: 'Unit',
            typeId: 'CUnit',
            entityId: 'VespeneGeyser',
            inheritanceChain: [],
            fields: {},
            sources: [],
            complete: true,
          },
          {
            namespace: 'Actor',
            typeId: 'CActorUnit',
            entityId: 'VespeneGeyser',
            inheritanceChain: [],
            fields: {
              unitName: '##unitName##',
              Model: '##unitName##',
              On: [{ Terms: 'UnitBirth.##unitName##', Send: 'Create' }],
            },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Model',
            typeId: 'CModel',
            entityId: 'VespeneGeyser',
            inheritanceChain: [],
            fields: { Model: 'Assets/Vespene/VespeneGeyser.m3' },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Model',
            typeId: 'CModel',
            entityId: 'CrystalDoodad',
            inheritanceChain: [],
            fields: { Model: 'Assets/Doodads/CrystalDoodad.m3', VariationCount: '4' },
            sources: [],
            complete: true,
          },
        ],
      },
    })

    expect(result.semantic.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unit',
          presentationTeamColor: [1, 1, 1],
          presentationTeamColorIntensity: 0,
          // EditorModel is what only the editor draws.
          modelResource: expect.objectContaining({
            logicalId: 'base.sc2assets/Assets/Minerals/Game_03.m3',
            id: 'sc2-map-model:MineralField:MineralGameModel:variation-03',
          }),
        }),
        expect.objectContaining({
          kind: 'doodad',
          heightReference: 'absolute',
          presentationTeamColor: [1, 1, 1],
          presentationTeamColorIntensity: 0,
          modelResource: expect.objectContaining({
            logicalId: 'base.sc2assets/Assets/Doodads/CrystalDoodad_02.m3',
            id: 'sc2-map-model:CrystalDoodad:CrystalDoodad:variation-02',
          }),
        }),
        expect.objectContaining({
          kind: 'unit',
          typeId: 'VespeneGeyser',
          modelResource: expect.objectContaining({
            logicalId: 'base.sc2assets/Assets/Vespene/VespeneGeyser.m3',
            id: 'sc2-map-model:VespeneGeyser:VespeneGeyser',
          }),
        }),
        expect.objectContaining({
          kind: 'doodad',
          typeId: 'Aiur_Temple_BrickGroup',
          modelResource: expect.objectContaining({
            logicalId: 'base.sc2assets/Assets/Doodads/Elsecaro_Small_Props/Elsecaro_Small_Props_00.m3',
            id: 'sc2-map-model:Aiur_Temple_BrickGroup:Aiur_Temple_BrickGroup',
          }),
        }),
      ]),
    )
  })

  it('binds fluff doodads to the CModel their terrain texture names, not to an actor', async () => {
    // DLFT: two positions painted with texture 0 (BelShirGrass), whose DoodadEntry names a CModel.
    const fluff = new Uint8Array(28 + 2 * 9)
    fluff.set(encoder.encode('DLFT'))
    const view = new DataView(fluff.buffer)
    view.setUint32(24, 2, true)
    for (const [index, at] of [0.5, 1.5].entries()) {
      view.setFloat32(28 + index * 9, at, true)
      view.setFloat32(32 + index * 9, at, true)
    }
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: [...request.documents, { path: 't3FluffDoodad', bytes: fluff }],
      catalog: {
        ...request.catalog,
        definitions: [
          ...request.catalog.definitions.map(entity =>
            entity.namespace === 'TerrainTex' && entity.entityId === 'BelShirGrass'
              ? {
                  ...entity,
                  fields: {
                    ...entity.fields,
                    DoodadEntry: [{ index: 0, value: { Model: 'GrassTuft', Probability: '1' } }],
                  },
                }
              : entity,
          ),
          {
            namespace: 'Model',
            typeId: 'CModel',
            entityId: 'GrassTuft',
            inheritanceChain: [],
            fields: { Model: 'Assets/Doodads/GrassTuft.m3' },
            sources: [],
            complete: true,
          },
        ],
      },
    })
    const tufts = result.semantic.objects.filter(object => object.typeId === 'GrassTuft')
    expect(tufts).toHaveLength(2)
    for (const tuft of tufts) {
      expect(tuft).toMatchObject({
        catalog: { ref: { namespace: 'Model', entityId: 'GrassTuft' }, entity: { entityId: 'GrassTuft' } },
        modelResource: { logicalId: 'base.sc2assets/Assets/Doodads/GrassTuft.m3' },
      })
    }
    // Asking for an actor named after a CModel only produced "entity unresolved" errors.
    expect(result.semantic.catalogQueries).not.toContainEqual({ namespace: 'Actor', entityId: 'GrassTuft' })
    expect(result.semantic.diagnostics.map(item => item.code)).not.toContain(
      'blizzard.starcraft2/map-catalog-entity-unresolved',
    )
  })

  it('lines the waterline with the water template shoreline models, turned up the ground', async () => {
    // Ground rising one unit per column (0, 1, 2) under a water surface at 0.5: the waterline runs
    // through the middle of the first column of cells. The top row stands a cliff level higher.
    const ground = new Uint8Array(32 + 9 * 6)
    ground.set(encoder.encode('HMAP'))
    const groundView = new DataView(ground.buffer)
    groundView.setUint32(4, 101, true)
    groundView.setUint32(8, 3, true)
    groundView.setUint32(12, 3, true)
    for (let index = 0; index < 9; index += 1) groundView.setUint16(32 + index * 6, (index % 3) * 100, true)
    const levels = new Uint8Array(32 + 9 * 2)
    levels.set(encoder.encode('CLIF'))
    const levelView = new DataView(levels.buffer)
    levelView.setUint32(4, 1, true)
    levelView.setUint32(8, 3, true)
    levelView.setUint32(12, 3, true)
    for (let index = 6; index < 9; index += 1) levelView.setUint16(32 + index * 2, 16, true)
    const model = (entityId: string) => ({
      namespace: 'Model',
      typeId: 'CModel',
      entityId,
      inheritanceChain: [],
      fields: { Model: `Assets/Water/ShoreLines/${entityId}.m3` },
      sources: [],
      complete: true,
    })
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.map(document => {
        if (document.path === 't3HeightMap') return { ...document, bytes: ground }
        if (document.path === 't3SyncCliffLevel') return { ...document, bytes: levels }
        if (document.path === 't3Water') return { ...document, bytes: waterZones(['Coast']) }
        return document
      }),
      catalog: {
        ...request.catalog,
        definitions: [
          ...request.catalog.definitions,
          {
            namespace: 'Water',
            typeId: 'CWater',
            entityId: 'Coast',
            inheritanceChain: [],
            fields: {
              State: [{ index: 0, value: { Height: '0.5', Color: '0.1,0.2,0.3,0.4' } }],
              BeachShoreline: 'Surf',
              CliffShoreline: 'CliffSurf',
            },
            sources: [],
            complete: true,
          },
          model('Surf'),
          model('CliffSurf'),
        ],
      },
    })
    const shore = result.semantic.objects.filter(object => object.typeId === 'Surf' || object.typeId === 'CliffSurf')
    expect(shore.map(object => [object.typeId, object.position.x, object.position.y, object.position.z])).toEqual([
      ['Surf', 0.5, 0.5, 0.5],
      ['CliffSurf', 0.5, 1.5, 0.5],
    ])
    for (const object of shore) {
      // +X of the model runs up the ground, here along map-native +X.
      expect(object.rotation).toBeCloseTo(0, 9)
      expect(object).toMatchObject({
        kind: 'doodad',
        nativeRotationUnit: 'radians',
        heightReference: 'absolute',
        presentationAnimation: { name: 'Stand', loop: true, randomStart: true },
        catalog: { ref: { namespace: 'Model', entityId: object.typeId } },
        modelResource: { logicalId: `base.sc2assets/Assets/Water/ShoreLines/${object.typeId}.m3` },
      })
    }
    expect(result.semantic.catalogQueries).toContainEqual({ namespace: 'Water', entityId: 'Coast' })
    expect(result.semantic.catalogQueries).not.toContainEqual({ namespace: 'Actor', entityId: 'Surf' })
  })

  it('tiles a lava zone with its lava model, as SC2 draws lava instead of a water surface', async () => {
    const result = await analyzeStarcraft2MapWorkspace({
      ...request,
      documents: request.documents.map(document =>
        document.path === 't3Water' ? { ...document, bytes: waterZones(['Magma']) } : document,
      ),
      catalog: {
        ...request.catalog,
        definitions: [
          ...request.catalog.definitions,
          {
            namespace: 'Water',
            typeId: 'CWater',
            entityId: 'Magma',
            inheritanceChain: [],
            // No LavaModel of its own: Core's CWater default names DefaultLava.
            fields: { State: [{ index: 0, value: { Height: '0.5', Color: '0.8,0.3,0.1,0.3' } }], IsLava: '1' },
            sources: [],
            complete: true,
          },
          {
            namespace: 'Model',
            typeId: 'CModel',
            entityId: 'DefaultLava',
            inheritanceChain: [],
            fields: { Model: 'Assets/Water/Lavas/CharLavaPlane/CharLavaPlane.m3' },
            sources: [],
            complete: true,
          },
        ],
      },
    })
    const lava = result.semantic.objects.filter(object => object.typeId === 'DefaultLava')
    // The zone (0.5..2.5) lies in one tile of the 8-unit lattice, laid at its centre on the surface.
    expect(lava.map(object => [object.position.x, object.position.y, object.position.z])).toEqual([[4, 4, 0.5]])
    expect(lava[0]).toMatchObject({
      presentationAnimation: { name: 'Stand', loop: true },
      modelResource: { logicalId: 'base.sc2assets/Assets/Water/Lavas/CharLavaPlane/CharLavaPlane.m3' },
    })
    // The tiles flow in step.
    expect(lava[0]?.presentationAnimation).not.toHaveProperty('randomStart')
  })

  it('publishes exact native facets and an intent-only edit route', async () => {
    const result = await analyzeStarcraft2MapWorkspace(request)
    expect(result.terrainMaterials).toMatchObject({ width: 3, height: 3, exact: true })
    expect(result.terrainMaterials?.textureNames).toEqual(['BelShirGrass', 'BelShirDirt'])
    expect(result.terrainMaterials?.weightEncoding).toBe('normalized-exact')
    expect(result.terrainMaterials?.samples[0]?.weights).toEqual([
      { materialId: 'material-0', weight: 0.8 },
      { materialId: 'material-1', weight: 0.2 },
    ])
    expect(result.terrainMaterials?.materials?.[0]).toMatchObject({
      materialId: 'material-0',
      baseColorResourceId: 'sc2-terrain-texture:BelShirGrass',
      baseColorResource: {
        logicalId: 'base.sc2assets/Assets/Terrain/BelShirGrass.dds',
        role: 'texture',
      },
      normalResourceId: 'sc2-terrain-normal:BelShirGrass',
      normalResource: {
        logicalId: 'base.sc2assets/Assets/Terrain/BelShirGrass_N.dds',
        role: 'texture',
      },
      // Terrain normal maps are DXN-swizzled; a renderer cannot guess that from the pixels.
      normalEncoding: 'xy-in-alpha-green',
    })
    expect(result.water?.zones).toEqual([
      {
        zoneId: 0,
        templateId: 'BelShirWater',
        minimum: { x: 0.5, y: 0.5 },
        maximum: { x: 2.5, y: 2.5 },
        elevation: 9.25,
        materialId: 'water-belshirwater',
      },
    ])
    expect(result.water?.materials).toEqual([
      {
        materialId: 'water-belshirwater',
        label: 'BelShirWater',
        classification: 'water',
        shorelineMode: 'terrain-clipped',
        color: [0.12, 0.3, 0.45, 0.55],
        uvScale: [0.125, 0.125, 0.125, 0.125],
        scroll: [0.03, 0.03, -0.03, -0.03],
        colorFalloff: 0.1,
        specularity: 32,
        specularScale: 0.25,
        reflectivityPower: 8,
        causticsScale: [0.225, 0.225],
        causticsFramesPerSecond: 15,
        normalResourceId: 'sc2-water-normal:base.sc2assets%2FAssets%2FTextures%2FDefaultWaterNormal.dds',
        normalResource: {
          id: 'sc2-water-normal:base.sc2assets%2FAssets%2FTextures%2FDefaultWaterNormal.dds',
          logicalId: 'base.sc2assets/Assets/Textures/DefaultWaterNormal.dds',
          role: 'texture',
          scopes: ['current-mount', 'enclosing-container', 'workspace-dependency-layer'],
        },
        receiveShadows: true,
      },
    ])
    expect(result.cliffs).toMatchObject({ width: 3, height: 3, exact: true })
    expect(result.cliffs?.samples[1]).toMatchObject({ x: 1, y: 0, level: 1 })
    // Levels come in bands of four; a level between bands is ramp ground.
    expect(result.cliffs?.samples[1]?.ramp).toBe(true)
    expect(
      result.cliffs?.samples.filter(sample => sample.level % 4 === 0).every(sample => sample.ramp === undefined),
    ).toBe(true)
    expect(result.worldCandidate.edit).toEqual({
      operationId: 'blizzard/sc2-map.edit-world',
      moveObjectKind: 'object.update',
    })
    expect(result.semantic.objects[0]?.modelResource).toEqual({
      id: 'sc2-map-model:Marine:MarineModel',
      logicalId: 'base.sc2assets/Assets/Units/Terran/Marine/Marine.m3',
      role: 'sidecar',
      scopes: ['current-mount', 'enclosing-container', 'workspace-dependency-layer'],
    })
    expect(result.semantic.objects[0]?.heightReference).toBe('terrain-surface')
    expect(result.worldCandidate.unknownFacets).not.toContain('water')
    expect(result.worldCandidate.unknownFacets).not.toContain('water-template-elevation')
    expect(result.worldCandidate.unknownFacets).not.toContain('water-template-material')
    let acquisitions = 0
    const modelResources = {
      async acquire(input: { requirement: { logicalId: string } }) {
        acquisitions += 1
        expect(input.requirement.logicalId).toBe(
          'base.sc2assets/Assets/Units/Terran/Marine/Marine.m3',
        )
        return {
          value: {
            result: {
              state: 'converted' as const,
              bytes: new Uint8Array([1]),
              sourceKey: 'marine-m3',
              diagnostics: [],
            },
            async meshes() {
              return { items: [{ id: 'marine', primitiveIds: ['body'] }] }
            },
            async primitive() {
              return {
                id: 'body',
                topology: 'triangles' as const,
                positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
              }
            },
            async acquire() {
              throw new Error('not used')
            },
            async readRaster() {
              throw new Error('not used')
            },
          },
          async release() {},
        }
      },
    }
    const rasterResources = {
      async read(input: { requirement: { logicalId: string } }) {
        // The terrain layers, and the water's wave normals (TextureKey stem + `Normal`).
        expect(input.requirement.logicalId).toMatch(
          /^base\.sc2assets\/Assets\/(?:Terrain\/BelShir(?:Grass(?:_N)?|Dirt)|Textures\/DefaultWaterNormal)\.dds$/u,
        )
        return {
          state: 'decoded' as const,
          info: { width: 1, height: 1, orientation: 'top-left' as const },
          region: {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            rowStride: 4,
            pixels: Uint8Array.of(42, 96, 31, 255),
          },
          diagnostics: [],
        }
      },
    }
    const world = createCandidateWorldSceneLease(
      result,
      [],
      100,
      modelResources as never,
      undefined,
      rasterResources as never,
    )
    try {
      const model = await inspectCandidateWorld(world.value, {
        maxLayers: 16,
        maxItemsPerLayer: 100,
      })
      const secondUnit = model.layers
        .flatMap(layer => layer.page.items)
        .find(item => item.facet === 'objects' && item.objectId === 2)
      expect(secondUnit).toMatchObject({
        facet: 'objects',
        position: { x: 2, y: 2, z: 0 },
        mapNativePresentationPosition: { x: 2, y: 2, z: 1.08 },
        uvwPosition: { x: 2, y: 1.08, z: -2 },
      })
      const context = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        clearRect() {},
        fillRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        fill() {},
        stroke() {},
        arc() {},
      }
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
      } as unknown as HTMLCanvasElement
      expect(drawCandidateWorld(canvas, model)).toMatchObject({
        terrainTriangles: 8,
        // This fixture intentionally supplies only a 2D fallback context; the
        // WebGL terrain-texture route is asserted in the common scene suite.
        terrainTexturedTriangles: 0,
        waterPolygons: 1,
        objectInstances: 2,
        modelTriangles: 2,
        diagnosticPlaceholders: 0,
      })
      expect([...(model.terrainTextures?.keys() ?? [])].sort()).toEqual([
        'sc2-terrain-normal:BelShirGrass',
        'sc2-terrain-splat:0',
        'sc2-terrain-texture:BelShirDirt',
        'sc2-terrain-texture:BelShirGrass',
        'sc2-water-normal:base.sc2assets%2FAssets%2FTextures%2FDefaultWaterNormal.dds',
      ])
      const normal = await world.value.texture?.('sc2-terrain-normal:BelShirGrass', {
        maxBytes: 1_000_000,
      })
      expect(normal).toMatchObject({ state: 'decoded', texture: { width: 1, height: 1 } })
      const { model: _model, ...terrainOnlySource } = world.value
      const portable = await materializeWorldToUvpMap(terrainOnlySource, {
        packageId: 'blizzard/sc2-terrain-normal-fixture',
        packageVersion: '1.0.0',
        title: 'SC2 terrain normal fixture',
        maxPageItems: 100,
        maxTerrainItems: 100,
        maxFacetItems: 100,
        maxOutputBytes: 1_000_000,
        maxTextureBytes: 1_000_000,
        maxMediaBytes: 1_000_000,
      })
      // Terrain colour, normal and splat images; the water publishes no image (TextureKey is a normal map).
      expect(portable).toMatchObject({ state: 'materialized', packagedTextureCount: 4 })
      if (portable.state !== 'materialized') throw new Error(JSON.stringify(portable.refusals))
      expect(
        [...portable.entries.keys()].filter(path => path.startsWith('media/terrain/')),
      ).toHaveLength(4)
      expect(
        [...portable.entries.keys()].filter(path => path.startsWith('media/water/')),
      ).toHaveLength(0)
      expect(acquisitions).toBe(1)
    } finally {
      await world.release()
    }
  })

  it('downsamples oversized SC2 splat rasters onto the bounded height preview grid', async () => {
    const oversized = await analyzeStarcraft2MapWorkspace({
      ...request,
      snapshotId: 'oversized-mask-snapshot',
      documents: request.documents.map(document =>
        document.path === 't3TextureMasks'
          ? { ...document, bytes: textureMasks(128, 128) }
          : document,
      ),
      maxTerrainCells: 100,
      maxTerrainSamples: 100,
    })
    expect(oversized.terrainMaterials).toMatchObject({
      width: 3,
      height: 3,
      cellCount: 9,
      exact: false,
      maskResolution: { width: 128, height: 128, layers: 2 },
    })
    expect(oversized.terrainMaterials?.samples).toHaveLength(9)
    expect(oversized.terrainMaterials?.weightRasters).toMatchObject([
      {
        width: 128,
        height: 128,
        materialIds: ['material-0', 'material-1'],
        encoding: 'rgba8-unorm',
        normalization: 'sum',
      },
    ])
    expect(oversized.terrainMaterials?.weightRasters?.[0]?.rgba).toHaveLength(128 * 128 * 4)
    expect(oversized.worldCandidate.unknownFacets).not.toContain('terrain-material-splat-weights')
  })

  it('emits an empty map trigger component without donor gameplay through production UVW', async () => {
    const result = await analyzeStarcraft2MapWorkspace(request)
    const world = createCandidateWorldSceneLease(result, [], 100)
    try {
      const materialized = await materializeWorldToUvw(world.value, {
        maxPageItems: 2, maxTerrainItems: 100, maxFacetItems: 100, maxOutputBytes: 1_000_000,
      })
      if (materialized.state !== 'materialized') throw new Error(JSON.stringify(materialized.refusals))
      const fresh = await convertUvwToStarcraft2Map(materialized.bytes, {
        quantizeScale: 0.01, waterTemplateId: 'BelShirWater', maxOutputBytes: 2_000_000,
      })
      if (fresh.state !== 'converted') throw new Error(JSON.stringify(fresh.refusals))
      const triggerBytes = fresh.documents.find(entry => entry.path === 'Triggers')!.bytes
      const triggerXml = new TextDecoder().decode(triggerBytes)
      expect(triggerXml).toMatch(/<TriggerData>\s*<Root>\s*<\/Root>\s*<\/TriggerData>/u)
      expect(triggerXml).not.toMatch(/<Library|<Element|<Standard/u)
      expect(fresh.documents.some(entry => entry.path === 'MapScript.galaxy' || entry.path.endsWith('TriggerStrings.txt'))).toBe(false)
      expect(fresh.losses).toEqual(expect.arrayContaining([expect.objectContaining({
        feature: 'Triggers/GameData scenario', replacement: 'empty map trigger component; gameplay logic omitted',
      })]))
      expect(fresh.receipt.verification.targetLoaded).toBe(false)
      const archive = await readNativeMpqSnapshot({ sourceBytes: fresh.bytes })
      expect(archive.entries.find(entry => entry.path === 'Triggers')!.bytes).toEqual(triggerBytes)
    } finally {
      await world.release()
    }
  })

  it('materializes SC2 terrain, materials, cliffs and water through production UVW', async () => {
    const result = await analyzeStarcraft2MapWorkspace(request)
    const world = createCandidateWorldSceneLease(result, [], 100)
    try {
      const materialized = await materializeWorldToUvw(world.value, {
        maxPageItems: 2,
        maxTerrainItems: 100,
        maxFacetItems: 100,
        maxOutputBytes: 1_000_000,
      })
      if (materialized.state !== 'materialized') {
        throw new Error(`UVW materialization refused: ${JSON.stringify(materialized.refusals)}`)
      }

      expect(parseUvwProfile(materialized.bytes)).toEqual(materialized.document)
      expect(materialized.excludedFacetIds).toEqual(
        expect.arrayContaining(['world.navigation', 'world.resources']),
      )
      expect(materialized.excludedFacetIds).not.toEqual(
        expect.arrayContaining(['world.objects', 'world.regions', 'world.lighting']),
      )

      const space = materialized.document.spaces[0]
      expect(space?.layers.map(layer => layer.kind)).toEqual([
        'cliffs',
        'lighting',
        'objects',
        'regions',
        'terrain-materials',
        'resources',
        'water',
        'heightfield',
      ])
      expect(space?.layers.find(layer => layer.kind === 'lighting')).toMatchObject({
        ambientColor: [0.2, 0.3, 0.4],
        ambientIntensity: 0.75,
        directional: [
          {
            id: 'light-0000-source-key',
            direction: [0.4, -0.7, 0.6],
            color: [1, 0.9, 0.8],
            intensity: 1.25,
          },
          {
            id: 'light-0001-source-fill',
            direction: [-0.8, -0.3, 0.1],
            color: [0.3, 0.4, 0.5],
            intensity: 0.5,
          },
        ],
      })
      const materials = space?.layers.find(layer => layer.kind === 'terrain-materials')
      expect(materials).toMatchObject({
        columns: 3,
        rows: 3,
        materials: [
          { id: 'material-0', label: 'BelShirGrass' },
          { id: 'material-1', label: 'BelShirDirt' },
        ],
      })
      if (materials?.kind === 'terrain-materials') {
        expect(materials.weightRasters).toMatchObject([
          {
            resourceId: 'terrain-weight-0000',
            width: 3,
            height: 3,
            materialIds: ['material-0', 'material-1'],
          },
        ])
        expect(materials.samples?.[0]?.map(sample => sample.weights)).toEqual([
          [
            { materialId: 'material-0', weight: 0.8 },
            { materialId: 'material-1', weight: 0.2 },
          ],
          [
            { materialId: 'material-0', weight: 0.2 },
            { materialId: 'material-1', weight: 0.8 },
          ],
          [
            { materialId: 'material-0', weight: 0.8 },
            { materialId: 'material-1', weight: 0.2 },
          ],
        ])
      }
      const waterLayer = space?.layers.find(layer => layer.kind === 'water')
      expect(waterLayer).toMatchObject({
        zones: [
          {
            id: 'zone-0',
            minimum: [0.5, -2.5],
            maximum: [2.5, -0.5],
            elevation: 9.25,
          },
        ],
      })
      const objectsLayer = space?.layers.find(layer => layer.kind === 'objects')
      expect(objectsLayer).toMatchObject({
        instances: [
          {
            id: 'instance-1',
            position: [0.5, 93.17999999999999, -0.5],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          {
            id: 'instance-2',
            position: [2, 1.08, -2],
            scale: [1, 1, 1],
          },
        ],
      })
      const regionsLayer = space?.layers.find(layer => layer.kind === 'regions')
      expect(regionsLayer).toMatchObject({
        regions: [
          {
            id: 'region-1',
            name: 'center',
            shapes: [{ kind: 'circle', center: [1, -1], radius: 0.5 }],
          },
        ],
      })

      const reopened = createUvwWorldSceneSource(materialized.document, {
        snapshotId: 'reopened-sc2-uvw',
        mapId: 'fixture.uvw',
        maxPageSize: 2,
      })
      const reopenedInfo = await reopened.info()
      expect(reopenedInfo.facets.map(facet => facet.facet)).toEqual(
        expect.arrayContaining([
          'terrain',
          'terrain-materials',
          'cliffs',
          'water',
          'objects',
          'regions',
        ]),
      )
      expect(reopenedInfo.canonicalArtifact?.format).toBe('UVW')

      const unsupportedProfile = await convertUvwToStarcraft2Map(materialized.bytes, {
        profile: 'native-authored-map',
      })
      expect(unsupportedProfile).toMatchObject({
        state: 'refused',
        requestedProfile: 'native-authored-map',
        refusalCodes: ['conversion-profile-unsupported'],
        receipt: {
          schemaVersion: 1,
          status: 'refused',
          requestedProfile: 'native-authored-map',
          target: { gameId: 'blizzard/starcraft-2', artifactKind: 'sc2map' },
        },
      })

      const missingWaterMapping = await convertUvwToStarcraft2Map(materialized.bytes, {
        quantizeScale: 0.01,
        maxOutputBytes: 2_000_000,
      })
      expect(missingWaterMapping).toMatchObject({
        state: 'refused',
        refusalCodes: ['water-template-mapping-missing'],
      })

      const fresh = await convertUvwToStarcraft2Map(materialized.bytes, {
        quantizeScale: 0.01,
        waterTemplateId: 'BelShirWater',
        maxOutputBytes: 2_000_000,
      })
      expect(fresh).toMatchObject({
        state: 'converted',
        profile: 'sc2-spatial-geometry-v1',
        requestedProfile: 'geometry',
        receipt: {
          schemaVersion: 1,
          requestedProfile: 'geometry',
          achievedProfile: 'geometry',
          status: 'converted',
          target: { gameId: 'blizzard/starcraft-2', artifactKind: 'sc2map' },
          verification: { targetLoaded: false },
        },
        verification: {
          archiveReopened: true,
          columns: 3,
          rows: 3,
          objectCount: 2,
          regionCount: 1,
        },
      })
      if (fresh.state !== 'converted') throw new Error(JSON.stringify(fresh.refusals))
      const nativeWaterBytes = fresh.documents.find(entry => entry.path === 't3Water')!.bytes
      const nativeWater = readWater(nativeWaterBytes)
      expect(nativeWater.version).toBe(110)
      expect(new DataView(nativeWaterBytes.buffer, nativeWaterBytes.byteOffset).getUint32(12, true)).toBe(0)
      expect(nativeWaterBytes.length).toBe(32 + nativeWater.zones.length * 56)
      expect(nativeWater.zones[0]).toMatchObject({ templateId: 'BelShirWater', startX: 0.5, startY: 0.5, endX: 2.5, endY: 2.5 })
      const unicodeWater = await convertUvwToStarcraft2Map(materialized.bytes, {
        quantizeScale: 0.01, waterTemplateId: 'EauÉ', maxOutputBytes: 2_000_000,
      })
      if (unicodeWater.state !== 'converted') throw new Error(JSON.stringify(unicodeWater.refusals))
      const unicodeBytes = unicodeWater.documents.find(entry => entry.path === 't3Water')!.bytes
      expect(unicodeBytes.subarray(32, 32 + encoder.encode('EauÉ').length)).toEqual(encoder.encode('EauÉ'))
      expect(fresh.documents.map(entry => entry.path)).toEqual(
        expect.arrayContaining([
          'Base.SC2Data/GameData/LightData.xml',
          'Base.SC2Data/GameData/TerrainData.xml',
        ]),
      )
      const doodadDocument = {
        ...materialized.document,
        spaces: materialized.document.spaces.map(spaceEntry => ({
          ...spaceEntry,
          layers: spaceEntry.layers.map(layerEntry =>
            layerEntry.kind === 'objects'
              ? {
                  ...layerEntry,
                  instances: layerEntry.instances.map((instance, index) =>
                    index === 1 ? { ...instance, objectKind: 'doodad' as const } : instance,
                  ),
                }
              : layerEntry,
          ),
        })),
      }
      const freshWithDoodad = await convertUvwToStarcraft2Map(
        serializeUvwProfile(doodadDocument),
        {
          quantizeScale: 0.01,
          waterTemplateId: 'BelShirWater',
          maxOutputBytes: 2_000_000,
        },
      )
      if (freshWithDoodad.state !== 'converted')
        throw new Error(JSON.stringify(freshWithDoodad.refusals))
      const freshObjects = freshWithDoodad.documents.find(entry => entry.path === 'Objects')
      expect(new TextDecoder().decode(freshObjects?.bytes)).toContain(
        '<Flag Index="HeightAbsolute" Value="1"/>',
      )
      const targetMapInfo = writeMapInfo({
        version: 39,
        width: 64,
        height: 96,
        unknown1: 11,
        unknown2: 22,
        body: Uint8Array.of(1, 2, 3, 4),
        strings: [],
      })
      const targetDocumentInfo = `<?xml version="1.0" encoding="utf-8"?>
<DocInfo><Dependencies><Value>bnet:Void (Mod)/0.0/999,file:Mods\\Void.SC2Mod</Value></Dependencies></DocInfo>`
      const withTargetMetadata = await convertUvwToStarcraft2Map(materialized.bytes, {
        quantizeScale: 0.01,
        waterTemplateId: 'BelShirWater',
        maxOutputBytes: 2_000_000,
        targetMetadataPreset: {
          id: 'test/void-map-metadata-v1',
          mapInfoBytes: targetMapInfo,
          documentInfo: targetDocumentInfo,
        },
      })
      expect(withTargetMetadata).toMatchObject({
        state: 'converted',
        verification: {
          targetMetadataPreset: 'test/void-map-metadata-v1',
          dependencyCount: 1,
          dependencies: ['bnet:Void (Mod)/0.0/999,file:Mods\\Void.SC2Mod'],
        },
      })
      if (withTargetMetadata.state !== 'converted')
        throw new Error(JSON.stringify(withTargetMetadata.refusals))
      expect(withTargetMetadata.losses.map(loss => loss.feature)).not.toContain(
        'MapInfo/DocumentInfo',
      )
      const mapInfoDocument = withTargetMetadata.documents.find(entry => entry.path === 'MapInfo')
      const documentInfoDocument = withTargetMetadata.documents.find(
        entry => entry.path === 'DocumentInfo',
      )
      if (mapInfoDocument === undefined || documentInfoDocument === undefined)
        throw new Error('target metadata documents were omitted from the fresh map')
      expect(readMapInfo(mapInfoDocument.bytes)).toMatchObject({
        version: 39,
        width: 2,
        height: 2,
        unknown1: 11,
        unknown2: 22,
        body: Uint8Array.of(1, 2, 3, 4),
      })
      expect(new TextDecoder().decode(documentInfoDocument.bytes)).toBe(targetDocumentInfo)
      const boundaryBody = new Uint8Array(18 + 5 + 7 + 16 + 3)
      boundaryBody.set(new TextEncoder().encode('Void\0Korhal\0'), 18)
      const boundaryOffset = 18 + 5 + 7
      const boundaryView = new DataView(
        boundaryBody.buffer,
        boundaryBody.byteOffset + boundaryOffset,
        16,
      )
      boundaryView.setUint32(0, 8, true)
      boundaryView.setUint32(4, 12, true)
      boundaryView.setUint32(8, 56, true)
      boundaryView.setUint32(12, 84, true)
      const boundaryMapInfo = writeMapInfo({
        version: 39,
        width: 64,
        height: 96,
        unknown1: 11,
        unknown2: 22,
        body: boundaryBody,
        strings: [],
      })
      const withPlayableBoundary = await convertUvwToStarcraft2Map(materialized.bytes, {
        quantizeScale: 0.01,
        waterTemplateId: 'BelShirWater',
        maxOutputBytes: 2_000_000,
        targetMetadataPreset: {
          id: 'test/full-playable-boundary-v1',
          mapInfoBytes: boundaryMapInfo,
          documentInfo: targetDocumentInfo,
          playableBoundary: 'full-map',
        },
      })
      expect(withPlayableBoundary).toMatchObject({
        state: 'converted',
        verification: {
          playableBoundary: { left: 0, bottom: 0, right: 2, top: 2 },
        },
      })
      if (withPlayableBoundary.state !== 'converted')
        throw new Error(JSON.stringify(withPlayableBoundary.refusals))
      const rewrittenBoundaryDocument = withPlayableBoundary.documents.find(
        entry => entry.path === 'MapInfo',
      )
      if (rewrittenBoundaryDocument === undefined) throw new Error('rewritten MapInfo is missing')
      expect(readMapInfo(rewrittenBoundaryDocument.bytes).boundary).toEqual({
        left: 0,
        bottom: 0,
        right: 2,
        top: 2,
      })
      const boundaryWithoutPolicy = await convertUvwToStarcraft2Map(materialized.bytes, {
        quantizeScale: 0.01,
        waterTemplateId: 'BelShirWater',
        maxOutputBytes: 2_000_000,
        targetMetadataPreset: {
          id: 'test/missing-playable-boundary-policy-v1',
          mapInfoBytes: boundaryMapInfo,
          documentInfo: targetDocumentInfo,
        },
      })
      expect(boundaryWithoutPolicy).toMatchObject({
        state: 'refused',
        refusalCodes: ['target-metadata-preset-invalid'],
      })
      const invalidTargetMetadata = await convertUvwToStarcraft2Map(materialized.bytes, {
        quantizeScale: 0.01,
        waterTemplateId: 'BelShirWater',
        maxOutputBytes: 2_000_000,
        targetMetadataPreset: {
          id: 'invalid',
          mapInfoBytes: targetMapInfo,
          documentInfo: '<DocInfo><Dependencies>',
        },
      })
      expect(invalidTargetMetadata).toMatchObject({
        state: 'refused',
        refusalCodes: ['target-metadata-preset-invalid'],
      })
      const warzoneScaled = {
        ...materialized.document,
        spaces: materialized.document.spaces.map(candidate => ({
          ...candidate,
          basis: { ...candidate.basis, sourceUnit: 'warzone-world-unit', unitsPerCell: 128 },
          bounds: {
            min: candidate.bounds.min.map(value => value * 128),
            max: candidate.bounds.max.map(value => value * 128),
          },
          layers: candidate.layers.flatMap(layer => {
            if (layer.kind === 'cliffs') return []
            if (layer.kind === 'heightfield')
              return [
                {
                  ...layer,
                  cellSize: layer.cellSize * 128,
                  origin: layer.origin.map(value => value * 128),
                  samples: layer.samples.map(row => row.map(value => value * 128)),
                },
              ]
            if (layer.kind === 'terrain-materials')
              return [
                {
                  ...layer,
                  cellSize: layer.cellSize * 128,
                  origin: layer.origin.map(value => value * 128),
                },
              ]
            if (layer.kind === 'objects')
              return [
                {
                  ...layer,
                  instances: layer.instances.map(instance => ({
                    ...instance,
                    typeId: 'ConstructorDroid',
                    position: instance.position.map(value => value * 128),
                  })),
                },
              ]
            if (layer.kind === 'regions')
              return [
                {
                  ...layer,
                  regions: layer.regions.map(region => ({
                    ...region,
                    shapes: region.shapes.map(shape =>
                      shape.kind === 'circle'
                        ? {
                            ...shape,
                            center: shape.center.map(value => value * 128),
                            radius: shape.radius * 128,
                          }
                        : shape.kind === 'rectangle'
                          ? {
                              ...shape,
                              minimum: shape.minimum.map(value => value * 128),
                              maximum: shape.maximum.map(value => value * 128),
                            }
                          : {
                              ...shape,
                              points: shape.points.map(point => point.map(value => value * 128)),
                            },
                    ),
                  })),
                },
              ]
            if (layer.kind === 'water')
              return [
                {
                  ...layer,
                  zones: layer.zones.map(zone => ({
                    ...zone,
                    minimum: zone.minimum.map(value => value * 128),
                    maximum: zone.maximum.map(value => value * 128),
                    elevation: zone.elevation * 128,
                  })),
                },
              ]
            return [layer]
          }),
        })),
      }
      const crossMapping = {
        sourceUnit: 'warzone-world-unit',
        targetUnit: 'sc2-game-unit',
        scale: 1 / 128,
      }
      const crossUnmapped = await convertUvwToStarcraft2Map(warzoneScaled, {
        coordinateMapping: crossMapping,
        quantizeScale: 0.01,
        waterTemplateId: 'BelShirWater',
        maxOutputBytes: 2_000_000,
      })
      expect(crossUnmapped).toMatchObject({ state: 'refused' })
      expect(crossUnmapped.refusalCodes).toEqual(
        expect.arrayContaining(['material-mapping-missing', 'object-mapping-missing']),
      )
      const crossGame = await convertUvwToStarcraft2Map(warzoneScaled, {
        coordinateMapping: crossMapping,
        materialMappings: {
          'material-0': { sourceIndex: 0, label: 'BelShirGrass' },
          'material-1': { sourceIndex: 1, label: 'BelShirDirt' },
        },
        objectMappings: {
          'unit:ConstructorDroid': { objectKind: 'unit', typeId: 'Marine' },
        },
        quantizeScale: 0.01,
        waterTemplateId: 'BelShirWater',
        maxOutputBytes: 2_000_000,
      })
      expect(crossGame).toMatchObject({
        state: 'converted',
        profile: 'sc2-cross-game-geometry-v1',
        verification: { coordinateMapping: crossMapping },
      })
      expect(fresh.losses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ feature: 'MapInfo/DocumentInfo' }),
          expect.objectContaining({ feature: 'Triggers/GameData scenario' }),
        ]),
      )
      expect(fresh.receipt.losses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            feature: 'MapInfo/DocumentInfo',
            measurement: {
              kind: 'not-measured',
              reason: 'the converter did not provide a numeric error bound',
            },
          }),
        ]),
      )
      const archive = await readNativeMpqSnapshot({ sourceBytes: fresh.bytes })
      const semantic = await analyzeStarcraft2MapWorkspace({
        ...request,
        snapshotId: 'fresh-sc2-map',
        documents: archive.entries,
        catalog: {
          ...request.catalog,
          definitions: [
            ...request.catalog.definitions,
            {
              namespace: 'Terrain',
              typeId: 'CTerrain',
              entityId: 'UVWGeneratedTerrain',
              inheritanceChain: [],
              fields: { Lighting: 'UVWGeneratedLight' },
              sources: [],
              complete: true,
            },
            {
              namespace: 'Light',
              typeId: 'CLight',
              entityId: 'UVWGeneratedLight',
              inheritanceChain: [],
              fields: {
                ToDInfoArray: [
                  {
                    index: '0',
                    AmbientColor: '0.2,0.3,0.4',
                    AmbientEnvironmentMultiplier: '0.75',
                    DirectionalLight: [
                      {
                        index: 'Key',
                        Color: '1,0.9,0.8',
                        ColorMultiplier: '1.25',
                        Direction: '0.4,-0.6,-0.7',
                      },
                      {
                        index: 'Fill',
                        Color: '0.3,0.4,0.5',
                        ColorMultiplier: '0.5',
                        Direction: '-0.8,-0.1,-0.3',
                      },
                    ],
                  },
                ],
              },
              sources: [],
              complete: true,
            },
          ],
        },
      })
      expect(semantic.semantic.terrain).toMatchObject({ width: 3, height: 3, cellCount: 9 })
      expect(semantic.terrainMaterials).toMatchObject({
        width: 3,
        height: 3,
        exact: true,
        weightEncoding: 'normalized-exact',
      })
      expect(semantic.terrainMaterials?.samples[0]?.weights).toEqual([
        { materialId: 'material-0', weight: 0.8 },
        { materialId: 'material-1', weight: 0.2 },
      ])
      expect(semantic.semantic.objects.map(item => [item.objectId, item.typeId])).toEqual([
        [1, 'Marine'],
        [2, 'Marine'],
      ])
      expect(semantic.semantic.regions).toMatchObject([{ regionId: 1, name: 'center' }])
      expect(semantic.water?.zones).toMatchObject([{ templateId: 'BelShirWater', elevation: 9.25 }])
      const freshWorld = createCandidateWorldSceneLease(semantic, [], 100)
      try {
        const roundTrip = await materializeWorldToUvw(freshWorld.value, {
          maxPageItems: 2,
          maxTerrainItems: 100,
          maxFacetItems: 100,
          maxOutputBytes: 1_000_000,
        })
        expect(roundTrip).toMatchObject({ state: 'materialized' })
        if (roundTrip.state !== 'materialized') throw new Error(JSON.stringify(roundTrip.refusals))
        expect(roundTrip.document).toEqual(materialized.document)
      } finally {
        await freshWorld.release()
      }
    } finally {
      await world.release()
    }
  })
})
