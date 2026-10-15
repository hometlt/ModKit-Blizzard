import { verifyBankSignature } from './bank.js'
import type {
  BankValidationFinding,
  BankValidationOptions,
  BankValidationReport,
  SC2Bank,
  SC2BankKey,
  SC2BankSection,
  SC2BankValue,
} from './types.js'

const KNOWN_VALUE_TYPES = new Set(['int', 'fixed', 'string', 'flag', 'text', 'point'])
const INT_RE = /^-?\d+$/
const FIXED_RE = /^-?(?:\d+|\d*\.\d+)$/

export function validateBank(bank: SC2Bank, options: BankValidationOptions = {}): BankValidationReport {
  const findings: BankValidationFinding[] = []
  validateSections(bank, findings, options)
  validateSignature(bank, findings, options)
  return {
    ok: findings.every(finding => finding.severity !== 'error'),
    findings,
  }
}

function validateSections(
  bank: SC2Bank,
  findings: BankValidationFinding[],
  options: BankValidationOptions,
): void {
  const sectionNames = new Set<string>()
  for (let sectionIndex = 0; sectionIndex < bank.sections.length; sectionIndex++) {
    const section = bank.sections[sectionIndex]!
    const sectionPath = `/Section[${sectionIndex}]`
    if (section.name.length === 0) {
      add(findings, 'error', 'empty-section-name', 'Section name is empty', sectionPath)
    }
    if (sectionNames.has(section.name)) {
      add(findings, 'error', 'duplicate-section', `Duplicate section "${section.name}"`, sectionPath)
    }
    sectionNames.add(section.name)
    validateKeys(section, sectionPath, findings, options)
  }
}

function validateKeys(
  section: SC2BankSection,
  sectionPath: string,
  findings: BankValidationFinding[],
  options: BankValidationOptions,
): void {
  const keyNames = new Set<string>()
  for (let keyIndex = 0; keyIndex < section.keys.length; keyIndex++) {
    const key = section.keys[keyIndex]!
    const keyPath = `${sectionPath}/Key[${keyIndex}]`
    if (key.name.length === 0) {
      add(findings, 'error', 'empty-key-name', `Key name is empty in section "${section.name}"`, keyPath)
    }
    if (keyNames.has(key.name)) {
      add(findings, 'error', 'duplicate-key', `Duplicate key "${key.name}" in section "${section.name}"`, keyPath)
    }
    keyNames.add(key.name)
    validateKey(key, keyPath, findings, options)
  }
}

function validateKey(
  key: SC2BankKey,
  keyPath: string,
  findings: BankValidationFinding[],
  options: BankValidationOptions,
): void {
  if (key.value !== undefined && key.nodes !== undefined && key.nodes.length > 0) {
    add(findings, 'warning', 'mixed-value-and-nodes', `Key "${key.name}" has both a Value and node children`, keyPath)
  }
  if (key.value !== undefined) validateValue(key.value, `${keyPath}/Value`, findings, options)
  for (let nodeIndex = 0; nodeIndex < (key.nodes?.length ?? 0); nodeIndex++) {
    const node = key.nodes![nodeIndex]!
    if (node.type.length === 0) {
      add(findings, 'error', 'empty-node-type', `Node "${node.name}" has an empty value attribute type`, `${keyPath}/${node.name}[${nodeIndex}]`)
    }
  }
}

function validateValue(
  value: SC2BankValue,
  path: string,
  findings: BankValidationFinding[],
  options: BankValidationOptions,
): void {
  if (value.type.length === 0) {
    add(findings, 'error', 'empty-value-type', 'Value type is empty', path)
    return
  }
  if (!KNOWN_VALUE_TYPES.has(value.type) && options.allowUnknownValueTypes !== true) {
    add(findings, 'warning', 'unknown-value-type', `Unknown bank value type "${value.type}"`, path)
  }
  switch (value.type) {
    case 'int':
      if (!INT_RE.test(value.value)) add(findings, 'error', 'invalid-int', `Invalid int value "${value.value}"`, path)
      break
    case 'fixed':
      if (!FIXED_RE.test(value.value)) add(findings, 'error', 'invalid-fixed', `Invalid fixed value "${value.value}"`, path)
      break
    case 'flag':
      if (!['0', '1', 'true', 'false'].includes(value.value.toLowerCase())) {
        add(findings, 'error', 'invalid-flag', `Invalid flag value "${value.value}"`, path)
      }
      break
    case 'point':
      validatePoint(value.value, path, findings)
      break
  }
}

function validatePoint(value: string, path: string, findings: BankValidationFinding[]): void {
  const parts = value.split(',')
  if (parts.length !== 2 || !FIXED_RE.test(parts[0] ?? '') || !FIXED_RE.test(parts[1] ?? '')) {
    add(findings, 'error', 'invalid-point', `Invalid point value "${value}"`, path)
  }
}

function validateSignature(
  bank: SC2Bank,
  findings: BankValidationFinding[],
  options: BankValidationOptions,
): void {
  if (bank.signature === undefined) {
    add(
      findings,
      options.requireSignature === true ? 'error' : 'warning',
      'missing-signature',
      'Bank has no Signature element',
      '/Signature',
    )
    return
  }
  if (options.signatureInfo === undefined) {
    add(findings, 'warning', 'missing-signature-info', 'Signature exists but no signatureInfo was provided for verification', '/Signature')
    return
  }
  if (verifyBankSignature(bank, options.signatureInfo)) {
    add(findings, 'info', 'valid-signature', 'Bank signature is valid', '/Signature')
  } else {
    add(findings, 'error', 'invalid-signature', 'Bank signature does not match provided signatureInfo', '/Signature')
  }
}

function add(
  findings: BankValidationFinding[],
  severity: BankValidationFinding['severity'],
  code: BankValidationFinding['code'],
  message: string,
  path: string,
): void {
  findings.push({ severity, code, message, path })
}
