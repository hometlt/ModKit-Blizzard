/**
 * Apply StateGroups to a resolved frame tree, in place, before solving. This is
 * the deterministic subset (spec §6 / U4): `DefaultState` plus the first
 * conditional state whose `When type="Property"` conditions all match the
 * caller's `stateInputs`. Handled actions: `SetProperty`, `SetAnchor`,
 * `CreateFromTemplate`. Unhandled `When`/`Action` kinds are recorded as
 * diagnostics rather than guessed.
 *
 * Runs on `ResolvedFrame`s (no rects) so it slots between resolve and solve.
 */

import type { DescIndex } from '../../../layout-engine/sc2-layout-core/core.js'
import type {
  ResolvedFrame,
  ResolvedProperty,
  ResolvedAnchor,
  AnchorSide,
  SourceRef,
} from '../resolve/types.js'
import { ANCHOR_SIDES } from '../resolve/types.js'
import { resolveFrameFromDesc } from '../resolve/resolve.js'
import { buildParentMap, resolveRef, type RefContext } from '../solve/refs.js'
import type { ResolvedState, ResolvedStateGroup, StateAction } from './types.js'

export interface ApplyStatesOptions {
  /** Property values that `When type="Property"` conditions read. Keys: `Prop` or `Frame.Prop`. */
  stateInputs?: Record<string, string>
  /** Needed to instantiate `CreateFromTemplate` templates. */
  index: DescIndex
}

export interface ApplyStatesDiagnostic {
  code: 'unresolved-state-frame' | 'unresolved-template' | 'unsupported-action' | 'no-state-matched'
  message: string
  framePath: string[]
}

export interface ApplyStatesResult {
  /** Active state name chosen per StateGroup, keyed `framePath#stateGroup`. */
  active: Map<string, string>
  diagnostics: ApplyStatesDiagnostic[]
}

/** Mutates `root` in place; returns which states were chosen + diagnostics. */
export function applyStateGroups(
  root: ResolvedFrame,
  options: ApplyStatesOptions,
): ApplyStatesResult {
  const parentOf = buildParentMap(root)
  // State actions authored on a selected root use $parent as that root's frame context.
  parentOf.set(root, root)
  const ctx: RefContext = { root, parentOf }
  // Attribute names are lower-cased by the XML scanner, so match inputs
  // case-insensitively (both the bare `Prop` and `Frame.Prop` forms).
  const inputs = lowerKeys(options.stateInputs ?? {})
  const result: ApplyStatesResult = { active: new Map(), diagnostics: [] }

  // Snapshot the frame list up-front: CreateFromTemplate appends children, and
  // those synthesised subtrees are not themselves state-evaluated in this pass.
  const frames: ResolvedFrame[] = []
  ;(function collect(f: ResolvedFrame) {
    frames.push(f)
    for (const c of f.children) collect(c)
  })(root)

  for (const frame of frames) {
    for (const sg of frame.stateGroups) {
      const state = selectState(sg, frame, ctx, inputs)
      if (!state) {
        if (sg.states.length > 0) {
          result.diagnostics.push({
            code: 'no-state-matched',
            message: `StateGroup "${sg.name}" has no active state`,
            framePath: frame.path,
          })
        }
        continue
      }
      result.active.set(`${frame.path.join('/')}#${sg.name}`, state.name)
      for (const action of state.actions) applyAction(action, frame, ctx, options, result)
    }
  }
  return result
}

/**
 * Active state = the first conditional state (declaration order) whose `When`s
 * all pass; else the `DefaultState`; else none.
 */
function selectState(
  sg: ResolvedStateGroup,
  frame: ResolvedFrame,
  ctx: RefContext,
  inputs: Record<string, string>,
): ResolvedState | undefined {
  const selected = inputs[sg.name.toLowerCase()]
  if (selected !== undefined) {
    const lower = selected.toLowerCase()
    return sg.states.find(state => state.name.toLowerCase() === lower)
  }
  for (const state of sg.states) {
    if (state.whens.length === 0) continue
    if (state.whens.every(w => matchesWhen(w, frame, ctx, inputs))) return state
  }
  if (sg.defaultState) {
    const lower = sg.defaultState.toLowerCase()
    return sg.states.find(s => s.name.toLowerCase() === lower)
  }
  return undefined
}

function matchesWhen(
  when: { type: string; frame: string; props: Record<string, string> },
  frame: ResolvedFrame,
  ctx: RefContext,
  inputs: Record<string, string>,
): boolean {
  if (when.type.toLowerCase() !== 'property') return false
  const targetName = frameKey(when.frame, frame, ctx)
  for (const [prop, expected] of Object.entries(when.props)) {
    const got = lookupInput(inputs, targetName, prop)
    if (got === undefined || got.toLowerCase() !== expected.toLowerCase()) return false
  }
  return true
}

/** Resolve a `When`/`Action` `frame` ref to a stable key for input lookup. */
function frameKey(ref: string, frame: ResolvedFrame, ctx: RefContext): string | undefined {
  const r = resolveRef(frame, ref, ctx)
  return r.frame?.name
}

function lookupInput(
  inputs: Record<string, string>,
  frameName: string | undefined,
  prop: string,
): string | undefined {
  const p = prop.toLowerCase()
  if (frameName !== undefined) {
    const qualified = inputs[`${frameName.toLowerCase()}.${p}`]
    if (qualified !== undefined) return qualified
  }
  return inputs[p]
}

function lowerKeys(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) out[k.toLowerCase()] = v
  return out
}

function applyAction(
  action: StateAction,
  frame: ResolvedFrame,
  ctx: RefContext,
  options: ApplyStatesOptions,
  result: ApplyStatesResult,
): void {
  const target = resolveRef(frame, action.frame, ctx).frame
  if (!target) {
    result.diagnostics.push({
      code: 'unresolved-state-frame',
      message: `action target "${action.frame}" not found`,
      framePath: frame.path,
    })
    return
  }

  switch (action.kind) {
    case 'setProperty': {
      for (const [name, val] of Object.entries(action.props)) {
        const prev = target.properties.get(name.toLowerCase())
        const prop: ResolvedProperty = {
          tag: name,
          attrs: { val },
          val,
          source: action.source ?? syntheticSource(),
          overridden: prev ? [...prev.overridden, { ...prev, overridden: [] }] : [],
        }
        target.properties.set(name.toLowerCase(), prop)
      }
      break
    }
    case 'setAnchor': {
      const side = normalizeSide(action.side)
      if (!side) break
      const anchor: ResolvedAnchor = {
        side,
        implicitSide: false,
        ...(action.relative !== undefined ? { relative: action.relative } : {}),
        ...(action.pos !== undefined ? { pos: action.pos } : {}),
        ...(action.offset !== undefined ? { offset: action.offset } : {}),
        source: action.source ?? syntheticSource(),
      }
      target.anchors[side] = anchor
      break
    }
    case 'createFromTemplate': {
      const tplDesc = options.index.rootNs.getDeep(action.template)
      if (!tplDesc) {
        result.diagnostics.push({
          code: 'unresolved-template',
          message: `template "${action.template}" not found`,
          framePath: frame.path,
        })
        break
      }
      const created = resolveFrameFromDesc(options.index, tplDesc)
      rebasePath(created, target.path)
      if (!target.children.some(c => c.name.toLowerCase() === created.name.toLowerCase())) {
        target.children.push(created)
      }
      break
    }
    case 'other':
      result.diagnostics.push({
        code: 'unsupported-action',
        message: `action "${action.actionType}" not supported`,
        framePath: frame.path,
      })
      break
  }
}

/** Re-root a synthesised subtree's `path`s under `parentPath`. */
function rebasePath(frame: ResolvedFrame, parentPath: string[]): void {
  frame.path = [...parentPath, frame.name]
  for (const child of frame.children) rebasePath(child, frame.path)
}

function normalizeSide(raw: string): AnchorSide | undefined {
  const s = raw.toLowerCase()
  return ANCHOR_SIDES.find(k => k.toLowerCase() === s)
}

function syntheticSource(): SourceRef {
  return { uri: '', start: 0, end: 0, contribution: { descFqn: '', origin: 'state' } }
}
