/** Axis-aligned rectangle in UI-space units (top-left origin, +x right, +y down). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One axis's solved edge coordinates. `min` = left/top, `max` = right/bottom. */
export interface Interval {
  min: number
  max: number
}

export type Axis = 'x' | 'y'

/** Read a point on an interval: `Min` = min edge, `Max` = max edge, `Mid` = centre. */
export function pointAt(iv: Interval, pos: 'Min' | 'Mid' | 'Max'): number {
  switch (pos) {
    case 'Min': return iv.min
    case 'Max': return iv.max
    case 'Mid': return (iv.min + iv.max) / 2
  }
}

export function rectFrom(x: Interval, y: Interval): Rect {
  return { x: x.min, y: y.min, width: x.max - x.min, height: y.max - y.min }
}

export function xInterval(r: Rect): Interval { return { min: r.x, max: r.x + r.width } }
export function yInterval(r: Rect): Interval { return { min: r.y, max: r.y + r.height } }
