import type { InspectionContext, InspectionResult } from '@modkit/codec-kit'
import type { SC2Bank } from './core/core.js'

/** Existing richer MK3 projection; parsing/operation truth comes from the canonical document. */
export const definition: {
  inspect(bytes: Uint8Array, context: InspectionContext, bank?: SC2Bank): Promise<InspectionResult>
}
