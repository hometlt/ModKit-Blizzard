/**
 * Authored SC2 cliff pieces for presentation: one M3 per occupied `<cliffCellList>` wall tile, per
 * wall on a tile boundary (centred on the tile corner) and per `<rampList>` corner frame.
 *
 * Built only from the shared sc2-map-core readers and tile rules (no parser of its own):
 * `parseTerrainXml` (cliff sets, cells, ramps, standardHeight, grid transform), `readSyncCliffLevel`
 * (CLIF) and `cliffTilesFromCells`/`rampCornerTiles`/`cliffModelCandidates` (corner code, level
 * height, rotated asset names).
 *
 * Verified against the shipped meshes through the M3 codec: pieces are 2x2 units centred on the
 * tile, Z up with the lowest level at z = 0, corner code counter-clockwise from (-x,-y); only one
 * rotation of each code ships, so a tile resolves by quarter-turn candidates.
 */
import {
  cliffLevelOffsetZ,
  cliffModelCandidates,
  cliffTilesFromCells,
  cliffVertexLevels,
  parseTerrainXml,
  rampCornerTiles,
  readHeightMap,
  readSyncCliffLevel,
} from './format/index.js'

/** The CCliffMesh a map cliff set draws with: `CCliff.CliffMesh` and `CCliffMesh.ModelPath`. */
export interface Sc2CliffMesh {
  readonly meshId: string
  /** Game-logical folder, e.g. `Assets\Cliffs\CliffNatural0\`. */
  readonly modelPath: string
  /** `CCliff.CliffMaterial`: the set's skin for the shared mesh family (its materials replace the mesh's). */
  readonly materialPath?: string
  /**
   * `CCliffMesh.CliffHeights[0]`: how far level A lies from the standard height (level B). Eight
   * below for most meshes; Korhal's city blocks (`CliffMade7`) are twenty tall below B, and
   * Tokyo_Rooftops' lava pits lie there. Absent: the ladder of `cliffLevelOffsetZ`.
   */
  readonly levelAHeight?: number
}

export interface Sc2CliffPieceCandidate {
  readonly requirement: {
    readonly id: string
    readonly logicalId: string
    readonly role: 'sidecar'
    readonly scopes: readonly string[]
  }
  /** Radians, counter-clockwise in the map-native horizontal plane. */
  readonly yaw: number
}

export interface Sc2CliffPieces {
  readonly pieceModels: readonly {
    readonly id: string
    readonly candidates: readonly Sc2CliffPieceCandidate[]
    readonly materialModel?: Sc2CliffPieceCandidate['requirement']
  }[]
  readonly pieces: readonly {
    readonly id: string
    readonly position: { readonly x: number; readonly y: number; readonly z: number }
    readonly modelId: string
    readonly ramp?: boolean
  }[]
  readonly diagnostics: readonly { readonly severity: 'information' | 'warning'; readonly code: string; readonly message: string }[]
}

const SCOPES = Object.freeze(['current-mount', 'enclosing-container', 'workspace-dependency-layer'])

function logicalAssetId(path: string) {
  const normalized = path.replace(/\\/gu, '/')
  return /^(base\.sc2assets|mods|campaigns|maps)\//iu.test(normalized)
    ? normalized
    : `base.sc2assets/${normalized}`
}

/** Map cliff set ids (`<cliffSetList>`), for the catalog queries that resolve their meshes. */
export function sc2CliffSetIds(terrainXml: string): readonly string[] {
  return (parseTerrainXml(terrainXml).cliffSets ?? []).filter(id => typeof id === 'string' && id.length > 0)
}

export function buildSc2CliffPieces(input: {
  readonly terrainXml: string
  readonly cliffLevel: Uint8Array
  /** `t3HeightMap`: its per-vertex cliff offsets are what the wall meshes are chosen from. */
  readonly heightMap: Uint8Array
  /** Mesh for a map cliff set id (`<cliffSet name>`), resolved from the catalog by the caller. */
  readonly meshForCliffSet: (cliffSetId: string) => Sc2CliffMesh | undefined
  readonly maxPieces: number
}): Sc2CliffPieces {
  const terrain = parseTerrainXml(input.terrainXml)
  const diagnostics: Sc2CliffPieces['diagnostics'][number][] = []
  const cells = terrain.cliffCells ?? []
  if (cells.length === 0) return { pieceModels: [], pieces: [], diagnostics }
  const level = readSyncCliffLevel(input.cliffLevel)
  const vertices = cliffVertexLevels(readHeightMap(input.heightMap), terrain)
  const transform = {
    originX: terrain.offsetX ?? 0,
    originY: terrain.offsetY ?? 0,
    originZ: terrain.offsetZ ?? 0,
    scaleX: terrain.scaleX ?? 1,
    scaleY: terrain.scaleY ?? 1,
    scaleZ: terrain.scaleZ ?? 1,
  }
  const walls = cliffTilesFromCells(vertices, cells, terrain.standardHeight, transform)
  const ramps = rampCornerTiles(level, terrain.ramps ?? [], terrain.standardHeight, transform)
  const tiles = {
    tiles: [
      ...walls.tiles.map(tile => ({ ...tile, id: `cliff-${tile.cellIndex}` })),
      ...ramps.tiles.map((tile, index) => ({ ...tile, id: `ramp-${index}` })),
    ],
    unsupported: walls.unsupported + ramps.unsupported,
  }
  if (tiles.unsupported > 0)
    diagnostics.push({
      severity: 'warning',
      code: 'blizzard.starcraft2/map-cliff-level-unsupported',
      message: `${tiles.unsupported} cliff tiles have levels above the D band or ramp corners off the grid and are not drawn`,
    })
  const models = new Map<string, Sc2CliffPieces['pieceModels'][number]>()
  const pieces: Sc2CliffPieces['pieces'][number][] = []
  const unresolvedSets = new Set<string>()
  for (const tile of tiles.tiles) {
    if (pieces.length >= input.maxPieces) {
      diagnostics.push({
        severity: 'warning',
        code: 'blizzard.starcraft2/map-cliff-piece-budget',
        message: `cliff pieces exceed ${input.maxPieces}; the rest are not drawn`,
      })
      break
    }
    const setId = terrain.cliffSets?.[tile.cliffSetIndex ?? 0]
    const mesh = setId === undefined ? undefined : input.meshForCliffSet(setId)
    if (mesh === undefined) {
      unresolvedSets.add(setId ?? `#${tile.cliffSetIndex ?? 0}`)
      continue
    }
    // One mesh family is skinned per cliff set, so the set is part of the model identity.
    const modelId = `${setId}:${mesh.meshId}:${tile.code}:${tile.variation}`
    if (!models.has(modelId))
      models.set(modelId, {
        id: modelId,
        ...(mesh.materialPath === undefined
          ? {}
          : {
              materialModel: {
                id: `sc2-cliff-material:${encodeURIComponent(mesh.materialPath)}`,
                logicalId: logicalAssetId(mesh.materialPath),
                role: 'sidecar' as const,
                scopes: SCOPES,
              },
            }),
        candidates: cliffModelCandidates(mesh.modelPath, mesh.meshId, tile.code, tile.variation).map(
          candidate => ({
            requirement: {
              id: `sc2-cliff:${encodeURIComponent(candidate.path)}`,
              logicalId: logicalAssetId(candidate.path),
              role: 'sidecar' as const,
              scopes: SCOPES,
            },
            yaw: candidate.rotation,
          }),
        ),
      })
    // A piece with a corner on level A stands on it, as deep as its mesh says level A lies (the
    // tile rule places it at the usual eight below B; Korhal's blocks at eight stood twelve above
    // their roofs).
    const deeper =
      mesh.levelAHeight !== undefined && tile.code.includes('A')
        ? (mesh.levelAHeight - cliffLevelOffsetZ(0)) * transform.scaleZ
        : 0
    pieces.push({
      id: tile.id,
      position: { x: tile.x, y: tile.y, z: tile.z + deeper },
      modelId,
      ...(tile.ramp === true ? { ramp: true } : {}),
    })
  }
  if (unresolvedSets.size > 0)
    diagnostics.push({
      severity: 'warning',
      code: 'blizzard.starcraft2/map-cliff-set-unresolved',
      message: `cliff sets without a resolved CCliffMesh: ${[...unresolvedSets].join(', ')}`,
    })
  return { pieceModels: [...models.values()], pieces, diagnostics }
}
