import {
  calculateBankSignature,
  coerceBankValue,
  getBankKey,
  getBankSection,
  getBankValue,
  makeBankValue,
  parseBank,
  serializeBank,
  sortBank,
  verifyBankSignature,
} from './bank.js'
import type {
  BankPrimitiveValue,
  SC2Bank,
  SC2BankKey,
  SC2BankSection,
  SC2BankSignatureInfo,
  SC2BankValue,
  SC2BankValueType,
  SerializeBankOptions,
} from './types.js'

export class SC2BankEditor {
  readonly bank: SC2Bank
  signatureInfo?: SC2BankSignatureInfo

  constructor(bank: SC2Bank, signatureInfo?: SC2BankSignatureInfo) {
    this.bank = bank
    if (signatureInfo !== undefined) this.signatureInfo = signatureInfo
  }

  static parse(xmlText: string, signatureInfo?: SC2BankSignatureInfo): SC2BankEditor {
    return new SC2BankEditor(parseBank(xmlText), signatureInfo)
  }

  get(sectionName: string, keyName: string): SC2BankValue | undefined {
    return getBankValue(this.bank, sectionName, keyName)
  }

  getAny(sectionName: string, keyName: string): BankPrimitiveValue | undefined {
    const value = this.get(sectionName, keyName)
    return value !== undefined ? coerceBankValue(value) : undefined
  }

  getString(sectionName: string, keyName: string, fallback?: string): string | undefined {
    const value = this.get(sectionName, keyName)
    return value !== undefined ? String(coerceBankValue(value)) : fallback
  }

  getInt(sectionName: string, keyName: string, fallback?: number): number | undefined {
    const value = this.get(sectionName, keyName)
    if (value === undefined) return fallback
    const coerced = coerceBankValue(value)
    return typeof coerced === 'number' ? Math.trunc(coerced) : parseInt(String(coerced), 10)
  }

  getFixed(sectionName: string, keyName: string, fallback?: number): number | undefined {
    const value = this.get(sectionName, keyName)
    if (value === undefined) return fallback
    const coerced = coerceBankValue(value)
    return typeof coerced === 'number' ? coerced : parseFloat(String(coerced))
  }

  getFlag(sectionName: string, keyName: string, fallback?: boolean): boolean | undefined {
    const value = this.get(sectionName, keyName)
    if (value === undefined) return fallback
    return coerceBankValue(value) === true
  }

  set(sectionName: string, keyName: string, type: SC2BankValueType, value: BankPrimitiveValue): this {
    const section = this.ensureSection(sectionName)
    const key = this.ensureKey(section, keyName)
    key.value = makeBankValue(type, value)
    delete key.nodes
    return this
  }

  setInt(sectionName: string, keyName: string, value: number): this {
    return this.set(sectionName, keyName, 'int', value)
  }

  setFixed(sectionName: string, keyName: string, value: number): this {
    return this.set(sectionName, keyName, 'fixed', value)
  }

  setString(sectionName: string, keyName: string, value: string): this {
    return this.set(sectionName, keyName, 'string', value)
  }

  setText(sectionName: string, keyName: string, value: string): this {
    return this.set(sectionName, keyName, 'text', value)
  }

  setFlag(sectionName: string, keyName: string, value: boolean): this {
    return this.set(sectionName, keyName, 'flag', value)
  }

  setPoint(sectionName: string, keyName: string, value: { x: number, y: number }): this {
    return this.set(sectionName, keyName, 'point', value)
  }

  removeKey(sectionName: string, keyName: string): boolean {
    const section = getBankSection(this.bank, sectionName)
    if (section === undefined) return false
    const before = section.keys.length
    section.keys = section.keys.filter(key => key.name !== keyName)
    return section.keys.length !== before
  }

  removeSection(sectionName: string): boolean {
    const before = this.bank.sections.length
    this.bank.sections = this.bank.sections.filter(section => section.name !== sectionName)
    return this.bank.sections.length !== before
  }

  sort(): this {
    const sorted = sortBank(this.bank)
    this.bank.sections = sorted.sections
    if (sorted.version !== undefined) this.bank.version = sorted.version
    else delete this.bank.version
    if (sorted.signature !== undefined) this.bank.signature = sorted.signature
    else delete this.bank.signature
    return this
  }

  sign(signatureInfo: SC2BankSignatureInfo = this.requireSignatureInfo()): string {
    this.signatureInfo = signatureInfo
    this.bank.signature = calculateBankSignature(this.bank, signatureInfo)
    return this.bank.signature
  }

  verify(signatureInfo: SC2BankSignatureInfo = this.requireSignatureInfo()): boolean {
    return verifyBankSignature(this.bank, signatureInfo)
  }

  serialize(options: SerializeBankOptions = {}): string {
    return serializeBank(this.bank, {
      ...options,
      ...(options.signature === undefined && this.signatureInfo !== undefined ? { signature: this.signatureInfo } : {}),
    })
  }

  private ensureSection(sectionName: string): SC2BankSection {
    const existing = getBankSection(this.bank, sectionName)
    if (existing !== undefined) return existing
    const section: SC2BankSection = { name: sectionName, keys: [] }
    this.bank.sections.push(section)
    return section
  }

  private ensureKey(section: SC2BankSection, keyName: string): SC2BankKey {
    const existing = getBankKey(this.bank, section.name, keyName)
    if (existing !== undefined) return existing
    const key: SC2BankKey = { name: keyName }
    section.keys.push(key)
    return key
  }

  private requireSignatureInfo(): SC2BankSignatureInfo {
    if (this.signatureInfo === undefined) {
      throw new Error('SC2BankEditor requires signatureInfo to sign or verify')
    }
    return this.signatureInfo
  }
}
