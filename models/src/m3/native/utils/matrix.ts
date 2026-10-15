import type { M3StructureData } from '../types.js'

interface M3Matrix4 {
  x: { x: number; y: number; z: number; w: number }
  y: { x: number; y: number; z: number; w: number }
  z: { x: number; y: number; z: number; w: number }
  w: { x: number; y: number; z: number; w: number }
}

/** Convert a parsed M3 Matrix44 to a flat 16-element column-major number array. */
export function m3MatrixToArray(m: M3StructureData | M3Matrix4): number[] {
  const mat = m as M3Matrix4
  return [
    mat.x?.x ?? 0,
    mat.x?.y ?? 0,
    mat.x?.z ?? 0,
    mat.x?.w ?? 0,
    mat.y?.x ?? 0,
    mat.y?.y ?? 0,
    mat.y?.z ?? 0,
    mat.y?.w ?? 0,
    mat.z?.x ?? 0,
    mat.z?.y ?? 0,
    mat.z?.z ?? 0,
    mat.z?.w ?? 0,
    mat.w?.x ?? 0,
    mat.w?.y ?? 0,
    mat.w?.z ?? 0,
    mat.w?.w ?? 0,
  ]
}

/** Invert a column-major affine transform. Returns null for invalid/singular matrices. */
export function invertAffineMatrix4(matrix: ArrayLike<number>): Float32Array | null {
  const a00 = matrix[0] ?? 0
  const a01 = matrix[4] ?? 0
  const a02 = matrix[8] ?? 0
  const a10 = matrix[1] ?? 0
  const a11 = matrix[5] ?? 0
  const a12 = matrix[9] ?? 0
  const a20 = matrix[2] ?? 0
  const a21 = matrix[6] ?? 0
  const a22 = matrix[10] ?? 0
  const b01 = a22 * a11 - a12 * a21
  const b11 = -a22 * a10 + a12 * a20
  const b21 = a21 * a10 - a11 * a20
  const determinant = a00 * b01 + a01 * b11 + a02 * b21
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null

  const inverseDeterminant = 1 / determinant
  const i00 = b01 * inverseDeterminant
  const i01 = (-a22 * a01 + a02 * a21) * inverseDeterminant
  const i02 = (a12 * a01 - a02 * a11) * inverseDeterminant
  const i10 = b11 * inverseDeterminant
  const i11 = (a22 * a00 - a02 * a20) * inverseDeterminant
  const i12 = (-a12 * a00 + a02 * a10) * inverseDeterminant
  const i20 = b21 * inverseDeterminant
  const i21 = (-a21 * a00 + a01 * a20) * inverseDeterminant
  const i22 = (a11 * a00 - a01 * a10) * inverseDeterminant
  const tx = matrix[12] ?? 0
  const ty = matrix[13] ?? 0
  const tz = matrix[14] ?? 0

  const inverse = new Float32Array([
    i00,
    i10,
    i20,
    0,
    i01,
    i11,
    i21,
    0,
    i02,
    i12,
    i22,
    0,
    -(i00 * tx + i01 * ty + i02 * tz),
    -(i10 * tx + i11 * ty + i12 * tz),
    -(i20 * tx + i21 * ty + i22 * tz),
    1,
  ])
  return inverse.every(Number.isFinite) ? inverse : null
}
