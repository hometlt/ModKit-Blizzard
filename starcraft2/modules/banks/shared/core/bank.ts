import { XMLParser } from 'fast-xml-parser'
import { sha1Hex } from '@modkit/codec-kit/crypto/sha1'
import type {
  BankPrimitiveValue,
  SC2Bank,
  SC2BankKey,
  SC2BankNode,
  SC2BankSection,
  SC2BankSignatureInfo,
  SC2BankValue,
  SC2BankValueType,
  SerializeBankOptions,
} from './types.js'

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  allowBooleanAttributes: true,
})

const DEFAULT_INDENT = '\t'
const VALUE_TYPES = new Set(['int', 'fixed', 'string', 'flag', 'text', 'point'])

export function parseBank(xmlText: string): SC2Bank {
  const raw = XML_PARSER.parse(xmlText) as Record<string, unknown>
  const bankRoot = findBankRoot(raw)
  const bank: SC2Bank = {
    sections: [],
    ...(attr(bankRoot, 'version') !== undefined ? { version: attr(bankRoot, 'version')! } : {}),
    ...(readSignature(bankRoot) !== undefined ? { signature: readSignature(bankRoot)! } : {}),
  }

  for (const sectionNode of toArray(bankRoot['Section'])) {
    const section = parseSection(sectionNode)
    if (section) bank.sections.push(section)
  }
  return bank
}

export function serializeBank(bank: SC2Bank, options: SerializeBankOptions = {}): string {
  const indent = options.indent ?? DEFAULT_INDENT
  const working = options.sort ? sortBank(bank) : cloneBank(bank)
  if (options.signature !== false && options.signature !== undefined) {
    working.signature = calculateBankSignature(working, options.signature)
  }

  let out = options.xmlHeader === false ? '' : '<?xml version="1.0" encoding="utf-8"?>\n'
  out += `<Bank${working.version !== undefined ? ` version="${escapeAttr(working.version)}"` : ''}>\n`
  for (const section of working.sections) {
    out += `${indent}<Section name="${escapeAttr(section.name)}">\n`
    for (const key of section.keys) {
      out += `${indent}${indent}<Key name="${escapeAttr(key.name)}">\n`
      if (key.value !== undefined) {
        out += `${indent}${indent}${indent}<Value ${key.value.type}="${escapeAttr(key.value.value)}"/>\n`
      }
      for (const node of key.nodes ?? []) {
        out += `${indent}${indent}${indent}<${node.name}`
        const attrs = { ...node.attrs, [node.type]: node.value }
        for (const [name, value] of Object.entries(attrs)) out += ` ${name}="${escapeAttr(value)}"`
        out += '/>\n'
      }
      out += `${indent}${indent}</Key>\n`
    }
    out += `${indent}</Section>\n`
  }
  if (working.signature !== undefined) {
    out += `${indent}<Signature value="${escapeAttr(working.signature)}"/>\n`
  }
  out += '</Bank>'
  return out
}

export function calculateBankSignature(bank: SC2Bank, info: SC2BankSignatureInfo): string {
  let payload = `${info.authorId}${info.playerId}${info.bankName}`
  for (const section of bank.sections) {
    payload += section.name
    for (const key of section.keys) {
      payload += key.name
      if (key.nodes !== undefined && key.nodes.length > 0) {
        for (const node of key.nodes) {
          payload += node.name + node.type
          if (node.type !== 'text') payload += node.value
        }
      } else if (key.value !== undefined) {
        payload += 'Value' + key.value.type
        if (key.value.type !== 'text') payload += key.value.value
      }
    }
  }
  return sha1Hex(payload).toUpperCase()
}

export function verifyBankSignature(bank: SC2Bank, info: SC2BankSignatureInfo): boolean {
  if (bank.signature === undefined) return false
  return bank.signature.toUpperCase() === calculateBankSignature(bank, info)
}

export function sortBank(bank: SC2Bank): SC2Bank {
  const sections = bank.sections
    .map(section => ({
      name: section.name,
      keys: section.keys
        .map(key => ({
          ...key,
          ...(key.nodes !== undefined ? { nodes: [...key.nodes].sort(compareNodes) } : {}),
        }))
        .sort((a, b) => compareAscii(a.name, b.name)),
    }))
    .sort((a, b) => compareAscii(a.name, b.name))
  return {
    ...(bank.version !== undefined ? { version: bank.version } : {}),
    sections,
    ...(bank.signature !== undefined ? { signature: bank.signature } : {}),
  }
}

export function getBankSection(bank: SC2Bank, sectionName: string): SC2BankSection | undefined {
  return bank.sections.find(section => section.name === sectionName)
}

export function getBankKey(bank: SC2Bank, sectionName: string, keyName: string): SC2BankKey | undefined {
  return getBankSection(bank, sectionName)?.keys.find(key => key.name === keyName)
}

export function getBankValue(bank: SC2Bank, sectionName: string, keyName: string): SC2BankValue | undefined {
  return getBankKey(bank, sectionName, keyName)?.value
}

export function coerceBankValue(value: SC2BankValue): BankPrimitiveValue {
  switch (value.type) {
    case 'int':
      return parseInt(value.value, 10)
    case 'fixed':
      return parseFloat(value.value)
    case 'flag':
      return value.value === '1' || value.value.toLowerCase() === 'true'
    case 'point': {
      const [x = '0', y = '0'] = value.value.split(',')
      return { x: parseFloat(x), y: parseFloat(y) }
    }
    default:
      return value.value
  }
}

export function makeBankValue(type: SC2BankValueType, value: BankPrimitiveValue): SC2BankValue {
  if (type === 'flag') return { type, value: value === true || value === 1 ? '1' : '0' }
  if (type === 'point' && typeof value === 'object' && 'x' in value && 'y' in value) {
    return { type, value: `${formatFixed(value.x)},${formatFixed(value.y)}` }
  }
  return { type, value: String(value) }
}

function parseSection(node: unknown): SC2BankSection | undefined {
  const name = attr(node, 'name')
  if (name === undefined) return undefined
  const section: SC2BankSection = { name, keys: [] }
  if (!isRecord(node)) return section
  for (const keyNode of toArray(node['Key'])) {
    const key = parseKey(keyNode)
    if (key) section.keys.push(key)
  }
  return section
}

function parseKey(node: unknown): SC2BankKey | undefined {
  const name = attr(node, 'name')
  if (name === undefined) return undefined
  const key: SC2BankKey = { name }
  if (!isRecord(node)) return key

  const valueNode = first(node['Value'])
  if (valueNode !== undefined) {
    const value = parseValue(valueNode)
    if (value) key.value = value
  }

  const nodes: SC2BankNode[] = []
  for (const [tag, child] of Object.entries(node)) {
    if (tag === 'Value' || tag === '#text' || tag.startsWith('@_') || tag.startsWith('?')) continue
    for (const item of toArray(child)) {
      const parsed = parseNode(tag, item)
      if (parsed) nodes.push(parsed)
    }
  }
  if (nodes.length > 0) key.nodes = nodes
  return key
}

function parseValue(node: unknown): SC2BankValue | undefined {
  const attrs = attrsOf(node)
  const [type, value] = Object.entries(attrs)[0] ?? []
  if (type === undefined || value === undefined) return undefined
  return { type, value }
}

function parseNode(name: string, node: unknown): SC2BankNode | undefined {
  const attrs = attrsOf(node)
  const firstTyped = Object.entries(attrs).find(([key]) => !VALUE_TYPES.has(key.toLowerCase()))
    ?? Object.entries(attrs)[0]
  if (firstTyped === undefined) return undefined
  const [type, value] = firstTyped
  return { name, type, value, attrs }
}

function findBankRoot(raw: Record<string, unknown>): Record<string, unknown> {
  const root = raw['Bank']
  if (isRecord(root)) {
    const nested = root['Bank']
    return isRecord(nested) ? nested : root
  }
  throw new Error('SC2Bank XML must contain a <Bank> root')
}

function readSignature(root: Record<string, unknown>): string | undefined {
  return attr(first(root['Signature']), 'value')
}

function cloneBank(bank: SC2Bank): SC2Bank {
  return {
    ...(bank.version !== undefined ? { version: bank.version } : {}),
    sections: bank.sections.map(section => ({
      name: section.name,
      keys: section.keys.map(key => ({
        name: key.name,
        ...(key.value !== undefined ? { value: { ...key.value } } : {}),
        ...(key.nodes !== undefined ? { nodes: key.nodes.map(node => ({ ...node, attrs: { ...node.attrs } })) } : {}),
      })),
    })),
    ...(bank.signature !== undefined ? { signature: bank.signature } : {}),
  }
}

function compareNodes(a: SC2BankNode, b: SC2BankNode): number {
  return compareAscii(a.name, b.name)
}

function compareAscii(a: string, b: string): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const diff = a.charCodeAt(i) - b.charCodeAt(i)
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

function formatFixed(value: number): string {
  return (Math.floor(value * 10000 + 0.1) / 10000).toString()
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function attr(node: unknown, name: string): string | undefined {
  if (!isRecord(node)) return undefined
  const value = node[`@_${name}`]
  return value !== undefined ? String(value) : undefined
}

function attrsOf(node: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(node)) return out
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) out[key.slice(2)] = String(value)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
