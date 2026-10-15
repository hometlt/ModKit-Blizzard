/**
 * Anchor `relative` frame-reference resolution over a `ResolvedFrame` tree.
 * Covers the selectors the game UI actually uses in anchors: `$parent`,
 * `$this`, `$root`, `$ancestor[@name|@type|@oftype=…]`, `$sibling`, `$layer`,
 * `$parent/Child/Sub`, and bare relative paths. Exotic/unhandled selectors
 * return `{ frame: undefined, unsupported: true }` so the solver can emit a
 * precise diagnostic rather than guessing.
 *
 * Parent/ancestor navigation needs an upward link, which `ResolvedFrame`
 * deliberately doesn't carry (it stays an acyclic serialisable tree); the
 * caller supplies a `parentOf` map built once per solve.
 */

import type { ResolvedFrame } from '../resolve/types.js'

export interface RefContext {
  root: ResolvedFrame
  parentOf: ReadonlyMap<ResolvedFrame, ResolvedFrame>
}

export interface RefResult {
  frame?: ResolvedFrame | undefined
  /** True when the selector form isn't handled (vs. handled-but-not-found). */
  unsupported?: boolean | undefined
}

const ANCESTOR_RE = /^\$ancestor\[@(name|type|oftype)=([^\]]+)\]$/i
const SIBLING_RE = /^\$sibling(?:\[offset=(-?\d+)\])?$/i

export function resolveRef(node: ResolvedFrame, raw: string, ctx: RefContext): RefResult {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { unsupported: true }

  const segments = trimmed.split('/')
  let current: ResolvedFrame | undefined

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    if (segment.startsWith('$')) {
      // Selectors are valid at ANY position, not just the head. The base game's
      // tech tree wraps its arrows in a `TechTreeConnectorFrame` and reaches back
      // out with `$parent/$parent/Gateway/BuildingIconBackgroundImage`; treating a
      // non-leading `$parent` as a child NAME made every one of those anchors
      // unresolvable, so the arrows lost both edges and filled the whole panel.
      const from = i === 0 ? node : current
      if (from === undefined) return { frame: undefined }
      const r = resolveSelector(from, segment, ctx)
      if (r.unsupported) return r
      current = r.frame
    } else if (i === 0) {
      // Bare relative path: resolve the first segment as a sibling (child of the
      // node's parent), matching how the game roots un-prefixed anchor paths.
      current = childByName(ctx.parentOf.get(node) ?? ctx.root, segment)
    } else {
      if (current === undefined) return { frame: undefined }
      current = childByName(current, segment)
    }
    if (current === undefined) return { frame: undefined }
  }
  return { frame: current }
}

function resolveSelector(node: ResolvedFrame, selector: string, ctx: RefContext): RefResult {
  const lower = selector.toLowerCase()
  if (lower === '$this') return { frame: node }
  if (lower === '$parent') return { frame: ctx.parentOf.get(node) }
  if (lower === '$root') return { frame: ctx.root }
  if (lower === '$layer') return { frame: ctx.root } // layer ≈ top-level container; approximate as root

  const anc = ANCESTOR_RE.exec(selector)
  if (anc) {
    const key = anc[1]!.toLowerCase()
    const val = anc[2]!.toLowerCase()
    let cur = ctx.parentOf.get(node)
    while (cur) {
      if (key === 'name' && cur.name.toLowerCase() === val) return { frame: cur }
      if ((key === 'type' || key === 'oftype') && cur.type.toLowerCase() === val)
        return { frame: cur }
      cur = ctx.parentOf.get(cur)
    }
    return { frame: undefined }
  }

  const sib = SIBLING_RE.exec(selector)
  if (sib) {
    const parent = ctx.parentOf.get(node)
    if (!parent) return { frame: undefined }
    const idx = parent.children.indexOf(node)
    const offset = sib[1] ? parseInt(sib[1], 10) : -1 // default previous sibling
    const target = parent.children[idx + offset]
    return { frame: target }
  }

  return { unsupported: true }
}

function childByName(frame: ResolvedFrame, name: string): ResolvedFrame | undefined {
  const lower = name.toLowerCase()
  return frame.children.find(c => c.name.toLowerCase() === lower)
}

/** Build the parent map for a resolved tree (one pass). */
export function buildParentMap(root: ResolvedFrame): Map<ResolvedFrame, ResolvedFrame> {
  const map = new Map<ResolvedFrame, ResolvedFrame>()
  const walk = (frame: ResolvedFrame): void => {
    for (const child of frame.children) {
      map.set(child, frame)
      walk(child)
    }
  }
  walk(root)
  return map
}
