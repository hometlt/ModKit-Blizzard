export interface TypeScriptLaneEvidence {
  readonly status: TypeScriptLaneStatus
  readonly code: number
}

export const enum TypeScriptLaneStatus {
  Verified = 'verified',
}
