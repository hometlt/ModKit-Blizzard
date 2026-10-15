import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extension, fixturePath } from './war3-harness.js'

/**
 * Warcraft III draws each layer of a material as its own pass over the geoset (mdx-m3-viewer
 * `Layer`, WhiteoutFlakes `geoset_pass_bls.h`). The model here has the three cases that drew
 * wrong while the layers were folded into one opaque material: the classic team colour — an opaque
 * replaceable-1 layer under a skin blended by its own alpha — an additive, two-sided, faded glow,
 * and a geoset its geoset animation hides in one sequence and shows in another. One node is
 * billboarded, fully by default or by `billboardFlag` (0x10, 0x20, 0x40 lock X, Y, Z). With `teamGlow`
 * the glow's texture is the replaceable team glow.
 */
export async function layeredModelBytes(billboardFlag = 0x8, teamGlow = false): Promise<Uint8Array> {
  const { parseWar3Mdx, generateWar3Mdx } = (await import(
    pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
  )) as {
    parseWar3Mdx(bytes: Uint8Array): Record<string, unknown[]>
    generateWar3Mdx(model: unknown): Uint8Array
  }
  const model = parseWar3Mdx(new Uint8Array(await readFile(fixturePath))) as Record<string, unknown[]>
  model['Textures']!.push(
    { Image: '', ReplaceableId: 1, Flags: 0 },
    { Image: 'Textures\\Skin.blp', Flags: 0 },
    // Wraps in U only: a texture without flag 2 clamps V.
    teamGlow ? { Image: '', ReplaceableId: 2, Flags: 1 } : { Image: 'Textures\\Glow.blp', Flags: 1 },
  )
  model['Materials']!.push(
    {
      PriorityPlane: 0,
      RenderMode: 0,
      Layers: [
        { FilterMode: 0, Shading: 1, TextureID: 0, CoordId: 0, Alpha: 1 },
        { FilterMode: 2, Shading: 0, TextureID: 1, CoordId: 0, Alpha: 1 },
      ],
    },
    {
      PriorityPlane: -2,
      RenderMode: 0,
      Layers: [{ FilterMode: 3, Shading: 0x10 | 0x1, TextureID: 2, CoordId: 0, Alpha: 0.75 }],
    },
  )
  const sequence = (Name: string, start: number, end: number) => ({
    Name,
    Interval: Uint32Array.from([start, end]),
    NonLooping: false,
    MinimumExtent: Float32Array.from([-1, -1, 0]),
    MaximumExtent: Float32Array.from([1, 1, 1]),
    BoundsRadius: 2,
    MoveSpeed: 0,
    Rarity: 0,
  })
  model['Sequences']!.push(sequence('Stand', 0, 1000), sequence('Death', 2000, 3000))
  const geoset = (MaterialID: number) => ({
    Vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    Normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    TVertices: [Float32Array.from([0, 0, 1, 0, 0, 1])],
    VertexGroup: Uint8Array.from([0, 0, 0]),
    Faces: Uint16Array.from([0, 1, 2]),
    Groups: [[0]],
    TotalGroupsCount: 1,
    MinimumExtent: Float32Array.from([0, 0, 0]),
    MaximumExtent: Float32Array.from([1, 1, 0]),
    BoundsRadius: 1,
    Anims: [],
    MaterialID,
    SelectionGroup: 0,
    Unselectable: false,
  })
  model['Geosets']!.push(geoset(0), geoset(1))
  // Hidden throughout Stand, shown from the start of Death: how gore and decay parts come and go.
  model['GeosetAnims']!.push({
    GeosetId: 1,
    Alpha: {
      LineType: 0,
      GlobalSeqId: null,
      Keys: [
        { Frame: 0, Vector: Float32Array.from([0]) },
        { Frame: 2000, Vector: Float32Array.from([1]) },
      ],
    },
    Color: Float32Array.from([1, 1, 1]),
    Flags: 0,
  })
  const bone = {
    Name: 'Bone_Glow',
    ObjectId: 0,
    Parent: null,
    PivotPoint: Float32Array.from([0, 0, 0]),
    // Bone | Billboarded (or one of its axis-locked kinds)
    Flags: 0x100 | billboardFlag,
    GeosetId: 0,
    GeosetAnimId: -1,
  }
  model['Bones']!.push(bone)
  model['Nodes']!.push(bone)
  model['PivotPoints']!.push(Float32Array.from([0, 0, 0]))
  return generateWar3Mdx(model)
}
