export type SC2BankValueType = 'int' | 'fixed' | 'string' | 'flag' | 'text' | 'point' | string

export interface SC2BankValue {
  type: SC2BankValueType
  value: string
}

export interface SC2BankNode {
  name: string
  type: string
  value: string
  attrs: Record<string, string>
}

export interface SC2BankKey {
  name: string
  value?: SC2BankValue
  nodes?: SC2BankNode[]
}

export interface SC2BankSection {
  name: string
  keys: SC2BankKey[]
}

export interface SC2Bank {
  version?: string
  sections: SC2BankSection[]
  signature?: string
}

export interface SC2BankSignatureInfo {
  bankName: string
  authorId: string
  playerId: string
}

export interface InferredBankSignatureInfo {
  bankName: string
  authorId?: string
  playerId?: string
  bankPath: string
  missing: Array<'authorId' | 'playerId'>
}

export interface DiscoveredBankFile {
  path: string
  info: InferredBankSignatureInfo
}

export interface DiscoverBanksOptions {
  maxDepth?: number
}

export type BankValidationSeverity = 'error' | 'warning' | 'info'

export type BankValidationCode =
  | 'duplicate-section'
  | 'duplicate-key'
  | 'missing-signature'
  | 'missing-signature-info'
  | 'invalid-signature'
  | 'valid-signature'
  | 'empty-section-name'
  | 'empty-key-name'
  | 'empty-value-type'
  | 'invalid-int'
  | 'invalid-fixed'
  | 'invalid-flag'
  | 'invalid-point'
  | 'unknown-value-type'
  | 'mixed-value-and-nodes'
  | 'empty-node-type'

export interface BankValidationFinding {
  severity: BankValidationSeverity
  code: BankValidationCode
  message: string
  path: string
}

export interface BankValidationOptions {
  signatureInfo?: SC2BankSignatureInfo
  requireSignature?: boolean
  allowUnknownValueTypes?: boolean
}

export interface BankValidationReport {
  ok: boolean
  findings: BankValidationFinding[]
}

export interface LoadBankFileOptions {
  signatureInfo?: SC2BankSignatureInfo
  validate?: boolean
}

export interface SaveBankFileOptions extends SerializeBankOptions {
  signatureInfo?: SC2BankSignatureInfo
  sign?: boolean
  createDirs?: boolean
}

export interface BankListMatch {
  entry: SC2BankListEntry
  discovered: DiscoveredBankFile[]
}

export interface SerializeBankOptions {
  xmlHeader?: boolean
  indent?: string
  signature?: false | SC2BankSignatureInfo
  sort?: boolean
}

export interface SC2BankListEntry {
  name: string
  player: string
  attrs: Record<string, string>
}

export interface SC2BankList {
  banks: SC2BankListEntry[]
}

export type BankPrimitiveValue =
  | string
  | number
  | boolean
  | { x: number, y: number }
