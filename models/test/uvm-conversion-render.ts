import { expect } from 'vitest'
import type { SceneRendererPrimitive } from '@modkit/sdk/renderer'
import { renderHeadless } from '@modkit/scene/render/headless'
import { encodeRgbaPng } from '@modkit/scene/output/png'

function at(values: ArrayLike<number>, index: number): number {
  const value = values[index]
  if (value === undefined) throw new Error('missing render proof component')
  return value
}

/** Test-only isometric camera, fitted to actual transformed vertices. */
export function camera(primitives: readonly SceneRendererPrimitive[]) {
  const axes = [
    [0.70710678, 0, -0.70710678],
    [-0.40824829, 0.81649658, -0.40824829],
    [0.57735027, 0.57735027, 0.57735027],
  ]
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (const primitive of primitives) {
    const matrix = primitive.transform
    for (let offset = 0; offset < primitive.positions.length; offset += 3) {
      const position = [0, 1, 2].map(axis => at(primitive.positions, offset + axis))
      const point =
        matrix === undefined
          ? position
          : [0, 1, 2].map(
              axis =>
                at(matrix, axis) * at(position, 0) +
                at(matrix, axis + 4) * at(position, 1) +
                at(matrix, axis + 8) * at(position, 2) +
                at(matrix, axis + 12),
            )
      for (const [axis, basis] of axes.entries()) {
        const value = basis.reduce((sum, weight, index) => sum + weight * at(point, index), 0)
        min[axis] = Math.min(at(min, axis), value)
        max[axis] = Math.max(at(max, axis), value)
      }
    }
  }
  if (!min.every(Number.isFinite))
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  const scale = [0, 1, 2].map(axis => 1.7 / Math.max(0.001, at(max, axis) - at(min, axis)))
  scale[0] = scale[1] = Math.min(at(scale, 0), at(scale, 1))
  const view = new Float32Array(16)
  for (const [axis, basis] of axes.entries()) {
    for (const [column, value] of basis.entries()) view[column * 4 + axis] = value * at(scale, axis)
    view[12 + axis] = -(at(min, axis) + at(max, axis)) * 0.5 * at(scale, axis)
  }
  view[15] = 1
  return view
}

export async function renderConversionProof(
  native: readonly SceneRendererPrimitive[],
  converted: readonly SceneRendererPrimitive[],
  frame: readonly number[],
) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const expected = native.map(primitive => {
    if (primitive.transform !== undefined) expect(Array.from(primitive.transform)).toEqual(identity)
    return { ...primitive, transform: new Float32Array(frame) }
  })
  const viewProjection = camera(converted)
  const render = (primitives: readonly SceneRendererPrimitive[]) =>
    renderHeadless({
      outputKind: 'rgba8',
      viewport: { width: 160, height: 120 },
      camera: { viewProjection },
      clearColor: [0.025, 0.025, 0.04, 1],
      scene: {
        primitives: primitives.map(primitive => ({ ...primitive, materialId: 'neutral' })),
        materials: [{ id: 'neutral', baseColor: [0.7, 0.78, 0.9, 1], doubleSided: true }],
      },
    })
  const original = await render(expected),
    actual = await render(converted)
  expect(actual.diagnostics).toEqual([])
  expect(actual.statistics.primitives).toBe(converted.length)
  if (converted.length > 0) expect(actual.statistics.fragments).toBeGreaterThan(0)
  else expect(actual.statistics.fragments).toBe(0)
  expect(actual.rgba).toEqual(original.rgba)
  return { frame: actual, png: await encodeRgbaPng(actual) }
}

/** An actual shared-renderer overlay frame. Native ATVL did not publish a pixel oracle. */
export async function renderCollisionProof(primitives: readonly SceneRendererPrimitive[]) {
  const frame = await renderHeadless({
    outputKind: 'rgba8',
    viewport: { width: 160, height: 120 },
    camera: { viewProjection: camera(primitives) },
    clearColor: [0.025, 0.025, 0.04, 1],
    scene: {
      primitives,
      materials: [
        { id: 'uvm-collision-overlay', baseColor: [0.9, 0.65, 0.15, 1], doubleSided: true },
      ],
    },
  })
  expect(frame.diagnostics).toEqual([])
  expect(frame.statistics.fragments).toBeGreaterThan(0)
  return { frame, png: await encodeRgbaPng(frame) }
}
