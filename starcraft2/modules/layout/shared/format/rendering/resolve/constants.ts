/**
 * Layout constant resolution (`#Name`, `##Name`, …) against a `DescIndex`.
 * Constants are indexed globally per desc index (matching the engine's
 * observed cross-file resolution — spec §4, `[verify]` items tracked there);
 * values may reference other constants, followed to a fixpoint with a cycle
 * guard.
 */

import {
  getAttrValueKind,
  isConstantValueKind,
  AttrValueKindOffset,
} from '../../../layout-engine/sc2-layout-core/core.js'
import type { DescIndex } from '../../../layout-engine/sc2-layout-core/core.js'

export interface ConstantResolution {
  /** Final resolved value; undefined when the chain breaks. */
  value?: string
  /** Constant names followed, in order. */
  chain: string[]
  /** The name that failed to resolve (missing constant or cycle cut-off). */
  missing?: string
}

const MAX_CHAIN = 16

/**
 * Resolve a property value that may be a constant reference. Returns
 * undefined when `raw` is not a constant reference at all.
 */
export function resolveConstant(index: DescIndex, raw: string): ConstantResolution | undefined {
  const kind = getAttrValueKind(raw)
  if (!isConstantValueKind(kind)) return undefined

  let name = raw.slice(offsetOf(kind))
  const chain: string[] = []
  for (let i = 0; i < MAX_CHAIN; i++) {
    if (chain.includes(name)) return { chain, missing: name } // cycle
    chain.push(name)
    const item = index.constants.get(name)
    if (!item) return { chain, missing: name }
    const value = item.value ?? ''
    const vKind = getAttrValueKind(value)
    if (!isConstantValueKind(vKind)) return { value, chain }
    name = value.slice(offsetOf(vKind))
  }
  return { chain, missing: name }
}

function offsetOf(kind: number): number {
  return (AttrValueKindOffset as Record<number, number>)[kind] ?? 0
}

/**
 * Convenience: substitute a whole-value constant reference, passing through
 * non-constant values unchanged. Broken chains yield undefined.
 */
export function resolvePropertyValue(index: DescIndex, raw: string): string | undefined {
  const res = resolveConstant(index, raw)
  if (res === undefined) return raw
  return res.value
}
