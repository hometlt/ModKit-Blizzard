import type { BuiltVertex } from '../types.js'
import type { M3StructureData } from '../binary/structures.js'

interface Vec2 {
  x: number
  y: number
}
interface Vec3 {
  x: number
  y: number
  z: number
}
interface Col {
  r: number
  g: number
  b: number
  a: number
}

const NORM_DIV = 1 / 255
const UV_DIV = 1 / 32768

/** Convert a Uint8 VEC3 to normalized float [-1, 1]. */
function vector3AsUint8ToFloat(vec: Record<string, number>): [number, number, number] {
  return [vec.x * NORM_DIV * 2 - 1, vec.y * NORM_DIV * 2 - 1, vec.z * NORM_DIV * 2 - 1]
}

/** Convert M3 UV coords to Three.js UV space. */
function toThreeUv(uv: Record<string, number>, multiply: number, offset: number): [number, number] {
  const scale = multiply * UV_DIV
  return [uv.x * scale + offset, uv.y * scale + offset]
}

/** Convert a parsed M3 vertex into a plain object ready for Three.js geometry construction. */
export function buildVertexObject(
  vertex: M3StructureData,
  uvMultiply: number,
  uvOffset: number,
): BuiltVertex {
  const v = vertex as Record<string, unknown>
  const pos = v.pos as Vec3
  const result: BuiltVertex = { position: [pos.x, pos.y, pos.z] }

  if (v.normalf) {
    const n = v.normalf as Vec3
    result.normal = [n.x, n.y, n.z]
  } else if (v.normal) {
    result.normal = vector3AsUint8ToFloat(v.normal as Record<string, number>)
  }

  // Bitangent handedness rides the sign byte next to the packed normal
  // ("Normal. w is the handiness" — model.fx); 255 → +1, 0 → -1.
  const handedness = typeof v.sign === 'number' ? (v.sign as number) * NORM_DIV * 2 - 1 : 1
  if (v.tanf) {
    const t = v.tanf as Vec3
    result.tangent = [t.x, t.y, t.z, handedness]
  } else if (v.tan) {
    const t = vector3AsUint8ToFloat(v.tan as Record<string, number>)
    result.tangent = [t[0], t[1], t[2], handedness]
  }

  for (let uvIndex = 0; uvIndex < 5; uvIndex += 1) {
    const uvVal = v[`uv${uvIndex}`]
    if (uvVal)
      (result as Record<string, unknown>)[`uv${uvIndex}`] = toThreeUv(
        uvVal as Record<string, number>,
        uvMultiply,
        uvOffset,
      )
  }

  for (let uvIndex = 0; uvIndex < 4; uvIndex += 1) {
    const fuvVal = v[`fuv${uvIndex}`]
    if (fuvVal) {
      const fuv = fuvVal as Vec2
      ;(result as Record<string, unknown>)[`fuv${uvIndex}`] = [fuv.x, fuv.y]
    }
  }

  if (v.col) {
    const c = v.col as Col
    result.color = [c.r * NORM_DIV, c.g * NORM_DIV, c.b * NORM_DIV, c.a * NORM_DIV]
  }

  const weights: number[] = []
  const lookups: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const w = v[`weight${i}`]
    const l = v[`lookup${i}`]
    if (w !== undefined) weights.push((w as number) * NORM_DIV)
    if (l !== undefined) lookups.push(l as number)
  }
  if (weights.length) result.weights = weights
  if (lookups.length) result.boneIndices = lookups

  return result
}
