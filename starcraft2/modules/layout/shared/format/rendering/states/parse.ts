/**
 * Parse a `StateGroup` desc (from `@modkitx/layout-lang`) into the
 * {@link ResolvedStateGroup} model. StateGroup children aren't bound as descs,
 * so we read `State`/`DefaultState`/`When`/`Action` straight from the XML.
 * Multiple contributing declarations (template + override) merge by state name,
 * later declarations winning (the deterministic subset — spec §6).
 */

import type {
  DescNamespace,
  XMLElement,
  XMLDocument,
} from '../../../layout-engine/sc2-layout-core/core.js'
import type { SourceRef } from '../resolve/types.js'
import type { ResolvedState, ResolvedStateGroup, StateAction, StateCondition } from './types.js'

/** Attributes handled structurally on a `<When>`/`<Action>` (not treated as property conditions/values). */
const WHEN_META = new Set(['type', 'frame'])
const ACTION_META = new Set(['type', 'frame', 'side', 'relative', 'pos', 'offset', 'template'])

export function parseStateGroup(desc: DescNamespace): ResolvedStateGroup {
  const out: ResolvedStateGroup = { name: desc.name, states: [] }
  const byName = new Map<string, ResolvedState>()

  for (const decl of desc.xDecls) {
    const el = decl as XMLElement
    if (!el.children) continue
    for (const child of el.children) {
      const tag = child.tag?.toLowerCase()
      if (tag === 'defaultstate') {
        const v = attr(child, 'val')
        if (v !== undefined) out.defaultState = v
      } else if (tag === 'state') {
        const state = parseState(child)
        const existing = byName.get(state.name.toLowerCase())
        if (existing) {
          // Later declaration overrides whens/actions wholesale for this state.
          existing.whens = state.whens
          existing.actions = state.actions
        } else {
          byName.set(state.name.toLowerCase(), state)
          out.states.push(state)
        }
      }
    }
  }
  return out
}

function parseState(el: XMLElement): ResolvedState {
  const state: ResolvedState = { name: attr(el, 'name') ?? '', whens: [], actions: [] }
  for (const child of el.children ?? []) {
    const tag = child.tag?.toLowerCase()
    if (tag === 'when') state.whens.push(parseWhen(child))
    else if (tag === 'action') state.actions.push(parseAction(child))
  }
  return state
}

function parseWhen(el: XMLElement): StateCondition {
  return {
    type: attr(el, 'type') ?? 'Property',
    frame: attr(el, 'frame') ?? '$this',
    props: otherAttrs(el, WHEN_META),
  }
}

function parseAction(el: XMLElement): StateAction {
  const type = (attr(el, 'type') ?? '').toLowerCase()
  const frame = attr(el, 'frame') ?? '$this'
  const source = sourceOf(el)

  if (type === 'setproperty') {
    return {
      kind: 'setProperty',
      frame,
      props: otherAttrs(el, ACTION_META),
      ...(source ? { source } : {}),
    }
  }
  if (type === 'setanchor') {
    return {
      kind: 'setAnchor',
      frame,
      side: attr(el, 'side') ?? '',
      ...opt('relative', attr(el, 'relative')),
      ...opt('pos', attr(el, 'pos')),
      ...opt('offset', attr(el, 'offset')),
      ...(source ? { source } : {}),
    }
  }
  if (type === 'createfromtemplate') {
    return {
      kind: 'createFromTemplate',
      frame,
      template: attr(el, 'template') ?? '',
      ...(source ? { source } : {}),
    }
  }
  return {
    kind: 'other',
    actionType: attr(el, 'type') ?? '',
    frame,
    attrs: otherAttrs(el, ACTION_META),
    ...(source ? { source } : {}),
  }
}

function attr(el: XMLElement, name: string): string | undefined {
  const a = el.attributes?.[name]
  return a?.startValue !== undefined ? a.value : undefined
}

function otherAttrs(el: XMLElement, meta: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(el.attributes ?? {})) {
    if (meta.has(name.toLowerCase())) continue
    const a = el.attributes[name]
    if (a?.startValue !== undefined && a.value !== undefined) out[name] = a.value
  }
  return out
}

function opt(key: string, val: string | undefined): Record<string, string> {
  return val !== undefined ? { [key]: val } : {}
}

function sourceOf(el: XMLElement): SourceRef | undefined {
  const doc = el.getDocument() as XMLDocument
  const uri = doc?.lang?.tdoc?.uri
  if (uri === undefined) return undefined
  return { uri, start: el.start, end: el.end, contribution: { descFqn: '', origin: 'state' } }
}
