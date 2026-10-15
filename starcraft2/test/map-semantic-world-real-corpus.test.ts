import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { createCandidateWorldSceneLease } from '@modkit/host'
import { inspectCandidateWorld } from '@modkit/ui/world'
import { materializeWorldToUvpMap, materializeWorldToUvw, openUvpMapBundle } from '@modkit/uv/world'

import { analyzeStarcraft2MapWorkspace } from '../modules/map/providers/semantic/runtime.js'
import { convertUvwToWarzoneMap } from '../../../modkit-extensions-warzone/src/uvw-map-converter.js'
import { parseWarzoneGameMap } from '../../../modkit-extensions-warzone/src/warzone2100-map/format.js'

const mapRoot = 'C:/Apps/StarCraft II/Maps/all-races-coop-maps/02-CradleOfDeath.SC2Map'

describe.skipIf(process.env.MODKIT_TEST_INSTALLED_CORPUS !== '1' || !existsSync(mapRoot))(
  'installed SC2 semantic world corpus',
  () => {
    it('opens CradleOfDeath terrain and publishes a bounded honest splat preview', async () => {
      const names = [
        'Objects',
        'Regions',
        't3HeightMap',
        't3Terrain.xml',
        't3SyncTextureInfo',
        't3TextureMasks',
        't3Water',
        't3SyncCliffLevel',
      ]
      const real = await analyzeStarcraft2MapWorkspace({
        schemaVersion: 1,
        workspaceId: 'installed-cradle-of-death',
        gameId: 'blizzard/starcraft-2',
        mapId: mapRoot,
        snapshotId: 'installed-cradle-of-death-snapshot',
        documents: names.map(path => ({
          path,
          bytes: new Uint8Array(readFileSync(`${mapRoot}/${path}`)),
        })),
        unresolvedRequirementIds: [],
        requiredRequirementIds: [],
        maxDocuments: 16,
        maxDocumentBytes: 32_000_000,
        maxTotalBytes: 64_000_000,
        maxObjects: 100_000,
        maxRegions: 10_000,
        maxTerrainCells: 4_194_304,
        maxTerrainSamples: 100_000,
        maxDepth: 128,
        maxDiagnostics: 1_000,
      })
      expect(real.semantic.terrain).toMatchObject({ width: 257, height: 257, cellCount: 66_049 })
      expect(
        real.terrainMaterials,
        real.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'),
      ).toMatchObject({
        width: 257,
        height: 257,
        cellCount: 66_049,
        exact: false,
        weightEncoding: 'normalized-exact',
        maskResolution: { width: 2_048, height: 2_048, layers: 8 },
      })
      expect(real.terrainMaterials?.samples).toHaveLength(66_049)
      expect(real.terrainMaterials?.weightRasters).toHaveLength(2)
      expect(real.terrainMaterials?.weightRasters?.map(raster => raster.materialIds)).toEqual([
        ['material-0', 'material-1', 'material-2', 'material-3'],
        ['material-4', 'material-5', 'material-6', 'material-7'],
      ])
      for (const raster of real.terrainMaterials?.weightRasters ?? []) {
        expect(raster).toMatchObject({
          width: 2_048,
          height: 2_048,
          encoding: 'rgba8-unorm',
          normalization: 'sum',
        })
        expect(raster.rgba).toHaveLength(2_048 * 2_048 * 4)
      }
      const mask = new Uint8Array(readFileSync(`${mapRoot}/t3TextureMasks`))
      const maskBody = mask.subarray(64)
      const blocksPerLayer = 32 * 32
      const nativeNibble = (layer: number, x: number, y: number) => {
        const block = layer * blocksPerLayer + Math.floor(y / 64) * 32 + Math.floor(x / 64)
        const value = maskBody[block * 2_048 + (y % 64) * 32 + ((x % 64) >> 1)]!
        return ((x % 64) & 1) === 0 ? (value >> 4) & 0x0f : value & 0x0f
      }
      for (const [layer, x, y] of [
        [0, 0, 0],
        [3, 63, 127],
        [4, 64, 1_024],
        [7, 2_047, 2_047],
      ] as const) {
        const raster = real.terrainMaterials!.weightRasters![Math.floor(layer / 4)]!
        expect(raster.rgba![(y * 2_048 + x) * 4 + (layer % 4)]).toBe(nativeNibble(layer, x, y) * 17)
      }
      expect(real.worldCandidate.unknownFacets).not.toContain('terrain-material-splat-weights')

      const world = createCandidateWorldSceneLease(real, [], 100_000)
      try {
        const info = await world.value.info()
        expect(info.facets.find(facet => facet.facet === 'terrain')).toMatchObject({
          state: 'available',
          itemCount: 66_049,
          lods: ['exact'],
        })
        expect(info.facets.find(facet => facet.facet === 'terrain-materials')).toMatchObject({
          state: 'available',
          itemCount: 66_049,
          lods: ['raster-exact', 'sampled'],
        })
        const preview = await inspectCandidateWorld(world.value, {
          maxLayers: 16,
          maxItemsPerLayer: 100_000,
          maxPageItems: 1_024,
        })
        expect(preview.layers.find(item => item.layer.kind === 'terrain')?.page.items).toHaveLength(
          66_049,
        )
        expect(
          preview.layers.find(item => item.layer.kind === 'terrain-materials')?.page.items,
        ).toHaveLength(66_049)
        const materialized = await materializeWorldToUvw(world.value, {
          maxPageItems: 100_000,
          maxTerrainItems: 100_000,
          maxFacetItems: 200_000,
          maxOutputBytes: 32_000_000,
        })
        if (materialized.state !== 'materialized') {
          throw new Error(JSON.stringify(materialized.refusals))
        }
        expect(materialized.state).toBe('materialized')
        expect(materialized.observedTerrainItems).toBe(66_049)
        expect(materialized.excludedFacetIds).not.toContain('world.terrain-materials')
        expect(materialized.excludedFacetIds).not.toContain('world.cliffs')
        expect(
          materialized.document.spaces[0]?.layers.find(layer => layer.kind === 'cliffs'),
        ).toMatchObject({ columns: 256, rows: 256, origin: [0, 0, -255] })
        const materialLayer = materialized.document.spaces[0]?.layers.find(
          layer => layer.kind === 'terrain-materials',
        )
        expect(materialLayer?.samples).toBeUndefined()
        expect(materialLayer?.weightRasters).toHaveLength(2)
        const heightfield = materialized.document.spaces[0]?.layers.find(
          layer => layer.kind === 'heightfield',
        )
        const objectLayer = materialized.document.spaces[0]?.layers.find(
          layer => layer.kind === 'objects',
        )
        if (
          materialLayer?.kind !== 'terrain-materials' ||
          heightfield?.kind !== 'heightfield' ||
          objectLayer?.kind !== 'objects'
        )
          throw new Error('real SC2 cross-game layers are incomplete')
        const sourceWeightRasters = real.terrainMaterials?.weightRasters ?? []
        const weightRasterPixels = new Map(
          materialLayer.weightRasters?.map((raster, index) => [
            raster.resourceId,
            sourceWeightRasters[index]?.rgba,
          ]) ?? [],
        )
        const heights = heightfield.samples.flat()
        const minimumHeight = Math.min(...heights)
        const maximumHeight = Math.max(...heights)
        const heightScale =
          maximumHeight === minimumHeight ? 1 : 400 / (maximumHeight - minimumHeight)
        const heightOffset = 50 - minimumHeight * heightScale
        const crossGameWarzone = convertUvwToWarzoneMap(materialized.document, {
          targetVersion: 40,
          maxNodes: 10_000_000,
          maxOutputBytes: 32_000_000,
          coordinateMapping: {
            sourceUnit: 'sc2-game-unit',
            targetUnit: 'warzone-world-unit',
            scale: 128,
          },
          heightMapping: { scale: heightScale, offset: heightOffset, quantization: 'round' },
          weightRasterPixels,
          materialMappings: Object.fromEntries(
            materialLayer.materials.map((material, index) => [
              material.id,
              { sourceIndex: index, classification: 'TER_SAND' },
            ]),
          ),
          objectMappings: Object.fromEntries(
            objectLayer.instances.map(instance => [
              `${instance.objectKind}:${instance.typeId ?? ''}`,
              { objectKind: 'feature', typeId: 'TreeSnow1' },
            ]),
          ),
          objectScalePolicy: 'discard',
          objectPositionPolicy: 'round',
          materialBlendPolicy: 'dominant',
          terrainBoundaryPolicy: 'drop-positive-edge',
        })
        expect(
          crossGameWarzone.state,
          crossGameWarzone.refusals.map(item => `${item.code}: ${item.message}`).join('\n'),
        ).toBe('converted')
        if (crossGameWarzone.state !== 'converted')
          throw new Error(JSON.stringify(crossGameWarzone.refusals))
        expect(crossGameWarzone).toMatchObject({
          profile: 'warzone-cross-game-geometry-v1',
          verification: {
            reopened: true,
            width: 256,
            height: 256,
            tileCount: 65_536,
            coordinateMapping: {
              sourceUnit: 'sc2-game-unit',
              targetUnit: 'warzone-world-unit',
              scale: 128,
            },
            heightMapping: {
              quantization: 'round',
            },
          },
        })
        expect(crossGameWarzone.verification.heightMapping.maximumAbsoluteError).toBeLessThanOrEqual(
          0.5,
        )
        expect(crossGameWarzone.losses).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              feature: 'layers.heightfield.samples',
              measurement: expect.objectContaining({ kind: 'absolute-error' }),
            }),
            expect.objectContaining({
              feature: 'layers.terrain-materials.samples.weights',
              measurement: expect.objectContaining({ kind: 'absolute-error' }),
            }),
            expect.objectContaining({
              feature: 'layers.heightfield.positive-edge',
            }),
          ]),
        )
        const crossGameMap = parseWarzoneGameMap(crossGameWarzone.documents[0].bytes, {
          maxInputBytes: 32_000_000n,
          maxScalarBytes: 32_000_000,
          maxNodes: 200_000,
        })
        expect(crossGameMap).toMatchObject({ width: 256, height: 256, tileCount: 65_536 })

        const portable = await materializeWorldToUvpMap(world.value, {
          packageId: 'blizzard/cradle-of-death-terrain',
          packageVersion: '1.0.0',
          maxPageItems: 100_000,
          maxTerrainItems: 100_000,
          maxFacetItems: 200_000,
          maxOutputBytes: 32_000_000,
          maxTextureBytes: 16 * 1024 * 1024,
          maxMediaBytes: 40 * 1024 * 1024,
        })
        if (portable.state !== 'materialized') throw new Error(JSON.stringify(portable.refusals))
        expect(portable.packagedTextureCount).toBe(2)
        expect(
          [...portable.entries.keys()].filter(path => path.startsWith('media/terrain/')),
        ).toHaveLength(2)
        expect(() =>
          JSON.parse(new TextDecoder().decode(portable.entries.get('world/main.uvw.json')!)),
        ).not.toThrow()
        const detached = await openUvpMapBundle(
          new Map([...portable.entries].map(([path, bytes]) => [path, bytes.slice()])),
          { snapshotId: 'detached-cradle-terrain' },
        )
        const detachedMaterials = detached.document.spaces[0]?.layers.find(
          layer => layer.kind === 'terrain-materials',
        )
        expect(detachedMaterials?.weightRasters?.map(raster => raster.resourceId)).toEqual([
          'terrain-media-0000',
          'terrain-media-0001',
        ])
        expect(detached.embeddedResources.size).toBe(2)
      } finally {
        await world.release()
      }
    }, 120_000)
  },
)
