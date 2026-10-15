/**
 * Anchor constraint solver: `ResolvedFrame` tree → `Rect` per frame in UI-space
 * units. Semantics per `docs/tasks-active/layout-rendering/SPEC_LAYOUT_SEMANTICS.md`
 * §1/§3 (offset sign, pos points, closure priority) — `[verify]` items there are
 * the source of truth; this implements the pinned defaults.
 *
 * Solved per axis with memoised recursion (X and Y are independent — a
 * Left/Right anchor only reads the referenced frame's X extent, Top/Bottom its
 * Y). Cross-frame references (`$parent`, `$parent/Sibling`, `$ancestor`) are
 * followed on demand; a reference cycle is cut with an `anchor-cycle`
 * diagnostic and a parent-min + content-size fallback, so the solve always
 * terminates and never throws.
 */

import type { ResolvedFrame, ResolvedAnchor, AnchorSide } from '../resolve/types.js'
import type { Interval, Rect, Axis } from './rect.js'
import { pointAt, rectFrom } from './rect.js'
import { buildParentMap, resolveRef, type RefContext } from './refs.js'

export interface SolveOptions {
  /** Rect assigned to the passed root frame (its `$parent` is the screen). Default full canvas. */
  rootRect?: Rect
  /** Virtual canvas size when `rootRect` is omitted. Default 1600×1200 (4:3 UI space). */
  canvasWidth?: number
  canvasHeight?: number
  /**
   * Resolve a raw attribute value (offset / Width / Height) to a number,
   * following `#`-constants. Return undefined for an unresolved constant.
   * Default: parse plain numbers only (constants → unresolved diagnostic).
   */
  resolveValue?: (raw: string) => number | undefined
  /**
   * Content default size for a frame with only one anchored edge on an axis
   * (Image → texture px, Label → text metrics). Default 0.
   */
  contentSize?: (frame: ResolvedFrame, axis: Axis) => number | undefined
}

export type SolveDiagnosticCode =
  | 'anchor-cycle'
  | 'unresolved-ref'
  | 'unsupported-ref'
  | 'unresolved-constant'
  /** Anchor `relative` pointed at the anchored frame itself; ignored, as the game does. */
  | 'self-anchor'

export interface SolveDiagnostic {
  code: SolveDiagnosticCode
  message: string
  framePath: string[]
}

export interface SolveResult {
  rects: Map<ResolvedFrame, Rect>
  diagnostics: SolveDiagnostic[]
}

interface SolveCtx {
  ref: RefContext
  options: Required<Pick<SolveOptions, 'canvasWidth' | 'canvasHeight'>> & SolveOptions
  rootRect: Rect
  memo: { x: Map<ResolvedFrame, Interval>; y: Map<ResolvedFrame, Interval> }
  visiting: { x: Set<ResolvedFrame>; y: Set<ResolvedFrame> }
  diagnostics: SolveDiagnostic[]
}

const SIDES: Record<Axis, { min: AnchorSide; max: AnchorSide; size: string }> = {
  x: { min: 'Left', max: 'Right', size: 'width' },
  y: { min: 'Top', max: 'Bottom', size: 'height' },
}

export function solveLayout(root: ResolvedFrame, options: SolveOptions = {}): SolveResult {
  const canvasWidth = options.canvasWidth ?? 1600
  const canvasHeight = options.canvasHeight ?? 1200
  const rootRect = options.rootRect ?? { x: 0, y: 0, width: canvasWidth, height: canvasHeight }

  const ctx: SolveCtx = {
    ref: { root, parentOf: buildParentMap(root) },
    options: { ...options, canvasWidth, canvasHeight },
    rootRect,
    memo: { x: new Map(), y: new Map() },
    visiting: { x: new Set(), y: new Set() },
    diagnostics: [],
  }

  const rects = new Map<ResolvedFrame, Rect>()
  const walk = (frame: ResolvedFrame): void => {
    rects.set(frame, rectFrom(solveAxis(ctx, frame, 'x'), solveAxis(ctx, frame, 'y')))
    for (const child of frame.children) walk(child)
  }
  walk(root)

  return { rects, diagnostics: ctx.diagnostics }
}

function solveAxis(ctx: SolveCtx, frame: ResolvedFrame, axis: Axis): Interval {
  const memo = ctx.memo[axis]
  const cached = memo.get(frame)
  if (cached) return cached

  // Root's extent is fixed by the caller (its $parent is the screen).
  if (frame === ctx.ref.root) {
    const iv =
      axis === 'x'
        ? { min: ctx.rootRect.x, max: ctx.rootRect.x + ctx.rootRect.width }
        : { min: ctx.rootRect.y, max: ctx.rootRect.y + ctx.rootRect.height }
    memo.set(frame, iv)
    return iv
  }

  const visiting = ctx.visiting[axis]
  if (visiting.has(frame)) {
    ctx.diagnostics.push({
      code: 'anchor-cycle',
      message: `anchor cycle on ${axis} axis`,
      framePath: frame.path,
    })
    return fallbackInterval(ctx, frame, axis)
  }
  visiting.add(frame)
  const iv = computeAxis(ctx, frame, axis)
  visiting.delete(frame)
  memo.set(frame, iv)
  return iv
}

function computeAxis(ctx: SolveCtx, frame: ResolvedFrame, axis: Axis): Interval {
  const { min: minSide, max: maxSide, size: sizeProp } = SIDES[axis]
  const minEdge = edgeValue(ctx, frame, frame.anchors[minSide], axis)
  const maxEdge = edgeValue(ctx, frame, frame.anchors[maxSide], axis)
  const size = numericProp(ctx, frame, sizeProp)

  // Closure priority. Per the SC2 layout tutorial, with BOTH edges anchored:
  //  - an explicit Width/Height → that size, CENTRED within the anchored span
  //    (not stretched); collapses to the `Anchor Left pos=Mid` + `Anchor Right
  //    pos=Mid` centering idiom when the span is a single point (tech-tree arrows);
  //  - no size, but a degenerate span + content (texture/text) → centre content;
  //  - otherwise stretch between the two edges.
  if (minEdge !== undefined && maxEdge !== undefined) {
    const centre = (minEdge + maxEdge) / 2
    if (size !== undefined) {
      const half = size / 2
      return { min: centre - half, max: centre + half }
    }
    if (Math.abs(maxEdge - minEdge) < 0.5) {
      const cs = contentSize(ctx, frame, axis)
      if (cs > 0) {
        const half = cs / 2
        return { min: centre - half, max: centre + half }
      }
    }
    return { min: minEdge, max: maxEdge }
  }
  if (minEdge !== undefined && size !== undefined) {
    return { min: minEdge, max: minEdge + size }
  }
  if (maxEdge !== undefined && size !== undefined) {
    return { min: maxEdge - size, max: maxEdge }
  }
  if (minEdge !== undefined) {
    return { min: minEdge, max: minEdge + contentSize(ctx, frame, axis) }
  }
  if (maxEdge !== undefined) {
    return { min: maxEdge - contentSize(ctx, frame, axis), max: maxEdge }
  }
  // No anchors on this axis.
  const parent = parentInterval(ctx, frame, axis)
  if (size !== undefined) {
    return { min: parent.min, max: parent.min + size } // positioned at parent min
  }
  return { min: parent.min, max: parent.max } // fill parent
}

/** Evaluate an anchor into an absolute edge coordinate, or undefined if absent/unresolved. */
function edgeValue(
  ctx: SolveCtx,
  frame: ResolvedFrame,
  anchor: ResolvedAnchor | undefined,
  axis: Axis,
): number | undefined {
  if (!anchor || anchor.relative === undefined) return undefined

  const ref = resolveRef(frame, anchor.relative, ctx.ref)
  if (!ref.frame) {
    ctx.diagnostics.push({
      code: ref.unsupported ? 'unsupported-ref' : 'unresolved-ref',
      message: `anchor ${anchor.side} → "${anchor.relative}" ${ref.unsupported ? 'not supported' : 'not found'}`,
      framePath: frame.path,
    })
    return undefined
  }

  // An anchor whose `relative` resolves to the anchored frame ITSELF cannot position
  // anything, and the game ignores it. Real layouts contain these (the tech-tree
  // `UnitListContainerFrame` anchors its Bottom to `$parent/UnitListContainerFrame`,
  // i.e. itself). Treating it as an edge instead sends it through the cycle fallback,
  // and a frame with a *both-edges* closure plus an explicit size then gets CENTRED on
  // a bogus span — which silently moved every production grid half its height off.
  if (ref.frame === frame) {
    ctx.diagnostics.push({
      code: 'self-anchor',
      message: `anchor ${anchor.side} → "${anchor.relative}" refers to the frame itself; ignored`,
      framePath: frame.path,
    })
    return undefined
  }

  const refIv = solveAxis(ctx, ref.frame, axis)
  const pos = normalizePos(anchor.pos, anchor.side)
  const offset = anchor.offset !== undefined ? (numericValue(ctx, frame, anchor.offset) ?? 0) : 0
  return pointAt(refIv, pos) + offset
}

function normalizePos(pos: string | undefined, side: AnchorSide): 'Min' | 'Mid' | 'Max' {
  if (pos) {
    const p = pos.toLowerCase()
    if (p === 'min') return 'Min'
    if (p === 'mid') return 'Mid'
    if (p === 'max') return 'Max'
  }
  // Default pos matches the side: Left/Top → Min, Right/Bottom → Max.
  return side === 'Left' || side === 'Top' ? 'Min' : 'Max'
}

function parentInterval(ctx: SolveCtx, frame: ResolvedFrame, axis: Axis): Interval {
  const parent = ctx.ref.parentOf.get(frame)
  return parent
    ? solveAxis(ctx, parent, axis)
    : axis === 'x'
      ? { min: ctx.rootRect.x, max: ctx.rootRect.x + ctx.rootRect.width }
      : { min: ctx.rootRect.y, max: ctx.rootRect.y + ctx.rootRect.height }
}

function fallbackInterval(ctx: SolveCtx, frame: ResolvedFrame, axis: Axis): Interval {
  const parent = parentInterval(ctx, frame, axis)
  return { min: parent.min, max: parent.min + contentSize(ctx, frame, axis) }
}

function contentSize(ctx: SolveCtx, frame: ResolvedFrame, axis: Axis): number {
  return ctx.options.contentSize?.(frame, axis) ?? 0
}

function numericProp(ctx: SolveCtx, frame: ResolvedFrame, propKey: string): number | undefined {
  const prop = frame.properties.get(propKey)
  if (!prop?.val) return undefined
  return numericValue(ctx, frame, prop.val)
}

function numericValue(ctx: SolveCtx, frame: ResolvedFrame, raw: string): number | undefined {
  const resolve = ctx.options.resolveValue ?? defaultResolveValue
  const n = resolve(raw)
  if (n === undefined || Number.isNaN(n)) {
    if (/^[#]/.test(raw.trim())) {
      ctx.diagnostics.push({
        code: 'unresolved-constant',
        message: `unresolved constant "${raw}"`,
        framePath: frame.path,
      })
    }
    return undefined
  }
  return n
}

function defaultResolveValue(raw: string): number | undefined {
  const n = Number.parseFloat(raw)
  return Number.isNaN(n) ? undefined : n
}
