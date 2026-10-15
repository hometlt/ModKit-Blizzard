/**
 * Edit planning (L7): map an editing intent on a resolved frame to concrete,
 * format-preserving XML text edits, honouring the write-back contract in
 * `docs/tasks-active/layout-rendering/EDITING_AND_CONVERSION.md`:
 *
 *  - a value declared in the frame's OWN editable declaration → edit in place;
 *  - a value inherited from a template/hookup/state, or in a read-only
 *    (CASC/dependency) file → **materialise an override** in the frame's own
 *    instance declaration (never silently edit a template/base file);
 *  - no editable own instance → `blocked` with a reason (the host offers
 *    "create an instance override").
 *
 * Pure: takes the document text + an editability predicate, returns edits the
 * host applies as a `WorkspaceEdit`. Works for property `val` edits and anchor
 * attribute edits (drag-to-offset).
 */

import type { ResolvedFrame, ContributionOrigin, SourceRef, AnchorSide } from '../resolve/types.js'
import { setAttribute, insertFirstChild, type RawEdit } from './xml-edit.js'

export interface PlanEditContext {
  /** True for on-disk mod files the user may write; false for CASC/dependency sources. */
  isEditable: (uri: string) => boolean
  /** Full text of a document by uri (for offset-precise edits). */
  getText: (uri: string) => string | undefined
}

export interface TextEdit extends RawEdit {
  uri: string
}

export type EditActionKind = 'replace-value' | 'insert-override' | 'blocked'

export interface EditPlan {
  action: EditActionKind
  edits: TextEdit[]
  /** Where the current (pre-edit) value came from — for the inspector. */
  currentOrigin?: ContributionOrigin
  currentValue?: string
  /** Present when `blocked`, or a note about materialisation. */
  reason?: string
}

/** Plan setting a frame property's `val` to `newValue`. */
export function planPropertyEdit(frame: ResolvedFrame, propName: string, newValue: string, ctx: PlanEditContext): EditPlan {
  const prop = frame.properties.get(propName.toLowerCase())
  const current = prop?.val
  const origin = prop?.source.contribution.origin

  // In-place: the value lives in the frame's own declaration in an editable file.
  if (prop && origin === 'own' && ctx.isEditable(prop.source.uri)) {
    const text = ctx.getText(prop.source.uri)
    if (text !== undefined) {
      return withOrigin({ action: 'replace-value', edits: withUri(prop.source.uri, setAttribute(text, prop.source.start, 'val', newValue)) }, origin, current)
    }
  }

  // Otherwise materialise an override element in the frame's own instance.
  return materialise(frame, `<${propTag(prop, propName)} val="${escapeAttr(newValue)}"/>`, ctx, origin, current)
}

/** Plan changing one or more attributes of a frame's anchor on `side` (e.g. drag → `offset`). */
export function planAnchorEdit(frame: ResolvedFrame, side: AnchorSide, changes: { relative?: string; pos?: string; offset?: string }, ctx: PlanEditContext): EditPlan {
  const anchor = frame.anchors[side]
  const origin = anchor?.source.contribution.origin
  const entries = Object.entries(changes).filter(([, v]) => v !== undefined) as [string, string][]

  // In-place: the anchor is declared with an explicit side in the frame's own editable file.
  if (anchor && !anchor.implicitSide && origin === 'own' && ctx.isEditable(anchor.source.uri)) {
    const text = ctx.getText(anchor.source.uri)
    if (text !== undefined) {
      const edits: RawEdit[] = []
      for (const [attr, val] of entries) edits.push(...setAttribute(text, anchor.source.start, attr, val))
      return withOrigin({ action: 'replace-value', edits: withUri(anchor.source.uri, edits) }, origin, anchor.offset)
    }
  }

  // Materialise a full <Anchor side=…> override carrying the current values plus changes.
  const attrs: Record<string, string> = { side }
  if (anchor?.relative !== undefined) attrs['relative'] = anchor.relative
  if (anchor?.pos !== undefined) attrs['pos'] = anchor.pos
  if (anchor?.offset !== undefined) attrs['offset'] = anchor.offset
  for (const [attr, val] of entries) attrs[attr] = val
  const anchorXml = `<Anchor ${Object.entries(attrs).map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(' ')}/>`
  return materialise(frame, anchorXml, ctx, origin, anchor?.offset)
}

function materialise(frame: ResolvedFrame, childXml: string, ctx: PlanEditContext, origin: ContributionOrigin | undefined, current: string | undefined): EditPlan {
  const own = frame.ownSource
  if (!own) {
    return withOrigin({ action: 'blocked', edits: [], reason: `"${frame.name}" has no own declaration to override — create an instance first (it exists only through a template/hookup).` }, origin, current)
  }
  if (!ctx.isEditable(own.uri)) {
    return withOrigin({ action: 'blocked', edits: [], reason: `"${frame.name}" is declared in a read-only source (${own.uri}); copy it into an editable mod to override.` }, origin, current)
  }
  const text = ctx.getText(own.uri)
  if (text === undefined) {
    return withOrigin({ action: 'blocked', edits: [], reason: `source text for ${own.uri} unavailable.` }, origin, current)
  }
  return withOrigin({ action: 'insert-override', edits: withUri(own.uri, insertFirstChild(text, own.start, childXml)) }, origin, current)
}

function propTag(prop: { tag: string } | undefined, propName: string): string {
  return prop?.tag ?? capitalize(propName)
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s
}

function withUri(uri: string, edits: RawEdit[]): TextEdit[] {
  return edits.map((e) => ({ ...e, uri }))
}

function withOrigin(plan: EditPlan, origin: ContributionOrigin | undefined, current: string | undefined): EditPlan {
  return {
    ...plan,
    ...(origin !== undefined ? { currentOrigin: origin } : {}),
    ...(current !== undefined ? { currentValue: current } : {}),
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

// SourceRef re-export kept for host typing convenience.
export type { SourceRef }
