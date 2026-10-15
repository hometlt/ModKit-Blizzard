import { describe, expect, it } from 'vitest'
import { buildSc2CliffPieces, sc2CliffSetIds } from '../modules/map/shared/cliffs.js'

function clif(heights: number[], sizeX: number, sizeY: number) {
  const bytes = new Uint8Array(32 + heights.length * 2)
  const view = new DataView(bytes.buffer)
  bytes.set([...'CLIF'].map(char => char.charCodeAt(0)), 0)
  view.setUint32(4, 0, true)
  view.setUint32(8, sizeX, true)
  view.setUint32(12, sizeY, true)
  heights.forEach((value, index) => view.setUint16(32 + index * 2, value, true))
  return bytes
}

/** `t3HeightMap` with the given per-vertex adjustments (world units), quantized at scale 0.5, bias 8. */
function heightMap(adjustments: number[], sizeX: number, sizeY: number) {
  const bytes = new Uint8Array(32 + adjustments.length * 6)
  const view = new DataView(bytes.buffer)
  bytes.set([...'HMAP'].map(char => char.charCodeAt(0)), 0)
  view.setUint32(4, 0, true)
  view.setUint32(8, sizeX, true)
  view.setUint32(12, sizeY, true)
  adjustments.forEach((value, index) => {
    view.setUint16(32 + index * 6, 16, true)
    view.setUint16(34 + index * 6, (value + 8) * 2, true)
  })
  return bytes
}

const terrainXml = `<terrain><heightMap dim="3 3"/>
<vertData quantizeBias="8" quantizeScale="0.5" standardHeight="6" name="t3HeightMap"/>
<cliffSetList><cliffSet i="0" name="ShakurasCliff0"/></cliffSetList>
<cliffCellList num="1" numOccupied="1"><cc i="0" f="1" cid="0" cvar="2"/></cliffCellList></terrain>`
const flatCells = clif([64, 64, 64, 64], 2, 2)
// Vertex (0,0) is level A, the other eight are B.
const cornerLow = heightMap([-8, 0, 0, 0, 0, 0, 0, 0, 0], 3, 3)

describe('SC2 authored cliff pieces', () => {
  it('places the authored tile with its mesh, variation and quarter-turn candidates', () => {
    expect(sc2CliffSetIds(terrainXml)).toEqual(['ShakurasCliff0'])
    const result = buildSc2CliffPieces({
      terrainXml,
      cliffLevel: flatCells,
      heightMap: cornerLow,
      meshForCliffSet: id =>
        id === 'ShakurasCliff0'
          ? {
              meshId: 'CliffNatural0',
              modelPath: 'Assets\\Cliffs\\CliffNatural0\\',
              materialPath: 'Assets\\Cliffs\\ShakurasCliff0_Material\\ShakurasCliff0_Material.m3',
            }
          : undefined,
      maxPieces: 16,
    })
    expect(result.diagnostics).toEqual([])
    // The piece sits at the centre of its cell, coded from the cell's corner vertices. Level A is
    // eight units below standardHeight.
    expect(result.pieces).toEqual([
      {
        id: 'cliff-0',
        position: { x: 1, y: 1, z: -2 },
        modelId: 'ShakurasCliff0:CliffNatural0:ABBB:2',
      },
    ])
    const [model] = result.pieceModels
    // The set's skin replaces the shared mesh family's materials.
    expect(model?.materialModel?.logicalId).toBe(
      'base.sc2assets/Assets/Cliffs/ShakurasCliff0_Material/ShakurasCliff0_Material.m3',
    )
    // ABBB is already the shipped smallest rotation: authored variation, then _00.
    expect(
      model?.candidates.map(candidate => [candidate.requirement.logicalId, candidate.yaw]),
    ).toEqual([
      ['base.sc2assets/Assets/Cliffs/CliffNatural0/CliffNatural0_ABBB_02.m3', 0],
      ['base.sc2assets/Assets/Cliffs/CliffNatural0/CliffNatural0_ABBB_00.m3', 0],
    ])
  })

  it('stands a piece on level A as deep as its mesh says level A lies', () => {
    // Korhal's city blocks (CCliffMesh CliffMade7) set CliffHeights[0] to -20: level A is twenty
    // below standardHeight, not eight, and Tokyo_Rooftops' lava pits lie there.
    const pieces = (levelAHeight?: number) =>
      buildSc2CliffPieces({
        terrainXml,
        cliffLevel: flatCells,
        // The corner is level A either way; where it stands is the mesh's.
        heightMap: cornerLow,
        meshForCliffSet: () => ({
          meshId: 'CliffMade7',
          modelPath: 'Assets\\Cliffs\\CliffMade7\\',
          ...(levelAHeight === undefined ? {} : { levelAHeight }),
        }),
        maxPieces: 16,
      }).pieces.map(piece => piece.position.z)
    expect(pieces(-20)).toEqual([6 - 20])
    // Without the mesh's heights the ladder keeps A eight below.
    expect(pieces()).toEqual([6 - 8])
  })

  it('reports cliff sets whose mesh the catalog does not resolve', () => {
    const result = buildSc2CliffPieces({
      terrainXml,
      cliffLevel: flatCells,
      heightMap: cornerLow,
      meshForCliffSet: () => undefined,
      maxPieces: 16,
    })
    expect(result.pieces).toEqual([])
    expect(result.diagnostics.map(item => item.code)).toEqual([
      'blizzard.starcraft2/map-cliff-set-unresolved',
    ])
  })
})
