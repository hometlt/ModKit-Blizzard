/**
 * Property-bind expression + TextFormatFrame evaluation (spec §5).
 *
 * Two coupled mechanisms the tech-tree fixture uses for every unit tooltip:
 *  - a `TextFormatFrame`'s virtual `@Text` = its `FormatText` with `%N%`
 *    placeholders filled from indexed `<Replacement>`s;
 *  - a `{frame-ref/@Property}` binding on another frame (e.g. an icon's
 *    `Tooltip val="{$parent/FormatTooltip/@Text}"`) that reads that value.
 *
 * Bindings reuse the anchor selector resolver (`$parent`, `$parent/Child`, …).
 * `@Key` string refs are resolved through an injected `resolveString` callback
 * (the L5 GameStrings pipeline); without it, `@Key`s pass through unresolved.
 * Evaluation is pure over the resolved tree and guards against binding cycles.
 */

import type { ResolvedFrame } from '../resolve/types.js'
import { buildParentMap, resolveRef, type RefContext } from '../solve/refs.js'
import { expandFormatText } from './format.js'

export interface EvaluateExpressionsOptions {
  /** Resolve an `@Key` string reference (GameStrings). Unresolved → passthrough. */
  resolveString?: (key: string) => string | undefined
}

export interface EffectiveText {
  /** Computed display text (Label text / TextFormatFrame `@Text`), fully resolved. */
  text?: string
  /** Computed tooltip text (bindings + strings resolved). */
  tooltip?: string
}

export interface ExpressionResult {
  byFrame: Map<ResolvedFrame, EffectiveText>
}

interface EvalCtx {
  ref: RefContext
  resolveString: (key: string) => string | undefined
  /** Guards `@Text`/binding recursion (keyed frame+property). */
  visiting: Set<string>
}

const TEXT_FORMAT_TYPE = 'textformatframe'

/** Compute effective text/tooltip for every text-bearing frame in the tree. */
export function evaluateExpressions(root: ResolvedFrame, options: EvaluateExpressionsOptions = {}): ExpressionResult {
  const ctx: EvalCtx = {
    ref: { root, parentOf: buildParentMap(root) },
    resolveString: options.resolveString ?? (() => undefined),
    visiting: new Set(),
  }

  const byFrame = new Map<ResolvedFrame, EffectiveText>()
  const walk = (frame: ResolvedFrame): void => {
    const eff: EffectiveText = {}
    if (frame.type.toLowerCase() === TEXT_FORMAT_TYPE || frame.properties.has('text')) {
      const text = effectiveProperty(frame, 'text', ctx)
      if (text !== undefined) eff.text = text
    }
    if (frame.properties.has('tooltip')) {
      const tip = effectiveProperty(frame, 'tooltip', ctx)
      if (tip !== undefined) eff.tooltip = tip
    }
    if (eff.text !== undefined || eff.tooltip !== undefined) byFrame.set(frame, eff)
    for (const child of frame.children) walk(child)
  }
  walk(root)
  return { byFrame }
}

/**
 * Effective value of a frame property, following `{…}` bindings, `@Key` string
 * refs, and the TextFormatFrame virtual `@Text`.
 */
export function effectiveProperty(frame: ResolvedFrame, propName: string, ctx: EvalCtx): string | undefined {
  const key = `${frame.path.join('/')}@${propName.toLowerCase()}`
  if (ctx.visiting.has(key)) return undefined // binding cycle
  ctx.visiting.add(key)
  try {
    // Virtual @Text of a TextFormatFrame is computed, not a literal element.
    if (propName.toLowerCase() === 'text' && frame.type.toLowerCase() === TEXT_FORMAT_TYPE) {
      return computeFormatText(frame, ctx)
    }
    const raw = frame.properties.get(propName.toLowerCase())?.val
    if (raw === undefined) return undefined
    return resolveValue(frame, raw, ctx)
  } finally {
    ctx.visiting.delete(key)
  }
}

function computeFormatText(frame: ResolvedFrame, ctx: EvalCtx): string | undefined {
  const format = frame.properties.get('formattext')?.val
  if (format === undefined) return undefined
  return expandFormatText(format, (index) => {
    const raw = frame.properties.get(`replacement[${index}]`)?.val
    return raw !== undefined ? resolveValue(frame, raw, ctx) : undefined
  })
}

/** Resolve one raw value: binding → target property, `@Key` → string, else literal. */
function resolveValue(frame: ResolvedFrame, raw: string, ctx: EvalCtx): string {
  const binding = parseBinding(raw)
  if (binding) {
    const target = resolveRef(frame, binding.ref, ctx.ref).frame
    if (!target) return ''
    return effectiveProperty(target, binding.property, ctx) ?? ''
  }
  if (raw.startsWith('@')) {
    const key = raw.replace(/^@+/, '')
    return ctx.resolveString(key) ?? raw
  }
  return raw
}

interface Binding {
  ref: string
  property: string
}

/** Parse `{frame-ref/@Property}` (property may carry an index suffix we ignore). */
export function parseBinding(raw: string): Binding | undefined {
  const value = raw.trim()
  if (!value.startsWith('{') || !value.endsWith('}')) return undefined
  const inner = value.slice(1, -1)
  const at = inner.lastIndexOf('/@')
  if (at === -1) return undefined
  const ref = inner.slice(0, at)
  const property = inner.slice(at + 2).replace(/\[.*\]$/, '')
  if (ref.length === 0 || property.length === 0) return undefined
  return { ref, property }
}
