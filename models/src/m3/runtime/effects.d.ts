import type { M3EffectsSource } from '../uvm/effects.js'
export interface M3EffectsBudget {
  readonly maxInputBytes: number
  readonly maxScalarBytes: number
  readonly maxNodes: number
  readonly maxDepth: number
}
export interface M3EffectsPrimitive {
  readonly id: string
  readonly topology: string
  readonly positions: Float32Array
  readonly indices: Uint16Array | Uint32Array
}
export declare function projectM3Effects(
  sections: unknown,
  primitives: readonly M3EffectsPrimitive[],
  budget: M3EffectsBudget,
  signal?: AbortSignal,
): M3EffectsSource
export declare function decodeM3Effects(
  bytes: Uint8Array,
  budget: M3EffectsBudget,
  signal?: AbortSignal,
  primitives?: readonly M3EffectsPrimitive[],
): Promise<M3EffectsSource>
