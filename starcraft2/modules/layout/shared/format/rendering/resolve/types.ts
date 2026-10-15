/**
 * Resolved-frame model: the output of merging a frame's desc contributions
 * (template chain, own declaration, `file=` hookup extensions) into one node.
 * Precedence and merge rules are specified in
 * `docs/tasks-active/layout-rendering/SPEC_LAYOUT_SEMANTICS.md` §2–3.
 */

import type { ResolvedStateGroup } from '../states/types.js'

export type ContributionOrigin = 'own' | 'template' | 'hookup' | 'state'

export interface Contribution {
  /** Fully-qualified name of the contributing desc, e.g. `TechTreePanel_CNC/TTSFT_Crimson`. */
  descFqn: string
  origin: ContributionOrigin
  /** The `template=` reference that pulled this contribution in (origin `template`). */
  via?: string
}

/** Where a merged value came from: document + XML element range + contribution. */
export interface SourceRef {
  uri: string
  start: number
  end: number
  contribution: Contribution
}

export interface ResolvedProperty {
  /** Element tag as written, e.g. `Texture`, `Width`. */
  tag: string
  attrs: Record<string, string>
  /** Convenience accessor for the `val` attribute. */
  val?: string
  source: SourceRef
  /** Declarations this one overrode, weakest first. */
  overridden: ResolvedProperty[]
}

export type AnchorSide = 'Left' | 'Top' | 'Right' | 'Bottom'
export const ANCHOR_SIDES: readonly AnchorSide[] = ['Left', 'Top', 'Right', 'Bottom']

export interface ResolvedAnchor {
  side: AnchorSide
  /** True when set by a side-less `<Anchor relative=…/>` (fill-parent shorthand). */
  implicitSide: boolean
  relative?: string
  pos?: string
  offset?: string
  source: SourceRef
}

export type ResolveDiagnosticCode =
  | 'missing-template'
  | 'template-kind-mismatch'
  | 'not-a-frame'

export interface ResolveDiagnostic {
  code: ResolveDiagnosticCode
  message: string
  /** Desc the diagnostic is attached to. */
  descFqn: string
}

export interface ResolvedFrame {
  name: string
  /** Frame type from the strongest declaration carrying a `type` attribute. */
  type: string
  /** Frame-name path from the resolution root (the root itself is `[name]`). */
  path: string[]
  /**
   * Source range of the frame's strongest `<Frame>` element (the most-derived
   * declaration — click-to-source lands here). May be a hookup in another file.
   * Undefined only for synthetic frames with no XML declaration.
   */
  source?: SourceRef
  /**
   * Source range of the frame's strongest OWN-origin `<Frame>` declaration
   * (excludes template/hookup/state contributions). This is the instance the
   * editor materialises property overrides into. Undefined when the frame
   * exists only through a template/hookup (materialising needs a new instance).
   */
  ownSource?: SourceRef
  /** Contributing descs, weakest first — the merge order. */
  contributions: Contribution[]
  /**
   * Merged scalar properties keyed by lower-cased tag; elements repeatable by
   * an `index` attribute (e.g. `Replacement`) are keyed `tag[index]`.
   * Strongest declaration wins; the override trail is on each property.
   */
  properties: Map<string, ResolvedProperty>
  /** Per-side anchor slots after per-side override merging (spec §2/§3). */
  anchors: Partial<Record<AnchorSide, ResolvedAnchor>>
  /** Animation desc names contributed by any declaration. */
  animations: string[]
  /** StateGroups contributed by any declaration (parsed; deterministic subset). */
  stateGroups: ResolvedStateGroup[]
  children: ResolvedFrame[]
  diagnostics: ResolveDiagnostic[]
}
