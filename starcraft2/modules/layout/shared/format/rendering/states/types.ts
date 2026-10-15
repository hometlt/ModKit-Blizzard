/**
 * StateGroup model — the deterministic subset the static renderer evaluates
 * (`docs/tasks-active/layout-rendering/SPEC_LAYOUT_SEMANTICS.md` §6 + the U4
 * task in `TASKS_INGAME_UI.md`). Full `When` evaluation needs live game data;
 * we evaluate `When type="Property"` conditions against a caller-supplied
 * `stateInputs` map and apply the active state's actions into the resolved
 * tree before solving.
 */

import type { SourceRef } from '../resolve/types.js'

export interface StateCondition {
  /** Condition kind, e.g. `Property`. Unknown kinds never match. */
  type: string
  /** Target frame the condition reads (`$this`, a sibling name, …). */
  frame: string
  /** Remaining attributes: property name → expected value (usually one). */
  props: Record<string, string>
}

export type StateAction =
  | { kind: 'setProperty'; frame: string; props: Record<string, string>; source?: SourceRef }
  | { kind: 'setAnchor'; frame: string; side: string; relative?: string; pos?: string; offset?: string; source?: SourceRef }
  | { kind: 'createFromTemplate'; frame: string; template: string; source?: SourceRef }
  | { kind: 'other'; actionType: string; frame: string; attrs: Record<string, string>; source?: SourceRef }

export interface ResolvedState {
  name: string
  whens: StateCondition[]
  actions: StateAction[]
}

export interface ResolvedStateGroup {
  name: string
  /** Fallback state name when no conditional state matches. */
  defaultState?: string
  states: ResolvedState[]
}
