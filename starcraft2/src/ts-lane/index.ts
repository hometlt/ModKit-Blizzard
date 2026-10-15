import { TypeScriptLaneStatus } from './evidence.js'
import type { TypeScriptLaneEvidence } from './evidence.js'

export { TypeScriptLaneStatus } from './evidence.js'
export type { TypeScriptLaneEvidence } from './evidence.js'

export function createTypeScriptLaneEvidence(): TypeScriptLaneEvidence {
  return Object.freeze({ status: TypeScriptLaneStatus.Verified, code: 1 })
}
