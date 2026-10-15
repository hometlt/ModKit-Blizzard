#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  coerceBankValue,
  discoverBankFiles,
  loadBankFile,
  matchBankListToDiscovered,
  parseBankList,
  saveBankFile,
  validateBank,
  verifyBankSignature,
} from './index.js'
import type { BankPrimitiveValue, SC2BankSignatureInfo, SC2BankValueType } from './types.js'
import type { DiscoverBanksOptions, LoadBankFileOptions } from './types.js'

export interface BankCliIO {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

interface ParsedArgs {
  positionals: string[]
  options: Map<string, string | boolean>
}

const VALUE_TYPES = new Set(['int', 'fixed', 'string', 'flag', 'text', 'point'])

export async function runBankCli(args: string[], io: BankCliIO = defaultIO): Promise<number> {
  const parsed = parseArgs(args)
  const command = parsed.positionals[0]

  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout(usage())
        return 0
      case 'read':
        return await cmdRead(parsed, io)
      case 'validate':
        return await cmdValidate(parsed, io)
      case 'verify':
        return await cmdVerify(parsed, io)
      case 'sign':
        return await cmdSign(parsed, io)
      case 'set':
        return await cmdSet(parsed, io)
      case 'list-banklist':
        return await cmdListBankList(parsed, io)
      case 'discover':
        return await cmdDiscover(parsed, io)
      default:
        io.stderr(`Unknown command: ${command}\n\n${usage()}`)
        return 2
    }
  } catch (error) {
    io.stderr(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`)
    return 1
  }
}

async function cmdRead(parsed: ParsedArgs, io: BankCliIO): Promise<number> {
  const file = requirePos(parsed, 1, 'read <file.SC2Bank>')
  const loaded = await loadBankFile(file, loadOptions(parsed))
  if (parsed.options.has('json')) {
    io.stdout(`${JSON.stringify(loaded.bank, null, 2)}\n`)
    return 0
  }

  io.stdout(`Bank: ${loaded.inferredInfo.bankName}\n`)
  io.stdout(`Sections: ${loaded.bank.sections.length}\n`)
  for (const section of loaded.bank.sections) {
    io.stdout(`\n[${section.name}]\n`)
    for (const key of section.keys) {
      if (key.value !== undefined) {
        io.stdout(`${key.name} (${key.value.type}) = ${formatPrimitive(coerceBankValue(key.value))}\n`)
      } else {
        io.stdout(`${key.name} = <${key.nodes?.length ?? 0} custom nodes>\n`)
      }
    }
  }
  if (loaded.bank.signature !== undefined) io.stdout(`\nSignature: ${loaded.bank.signature}\n`)
  return 0
}

async function cmdValidate(parsed: ParsedArgs, io: BankCliIO): Promise<number> {
  const file = requirePos(parsed, 1, 'validate <file.SC2Bank>')
  const loaded = await loadBankFile(file, loadOptions(parsed))
  const requireSignature = parsed.options.has('require-signature')
  const report = validateBank(loaded.bank, {
    ...(loaded.signatureInfo !== undefined ? { signatureInfo: loaded.signatureInfo } : {}),
    requireSignature,
  })

  if (report.findings.length === 0) {
    io.stdout('OK: no findings\n')
    return 0
  }
  for (const finding of report.findings) {
    io.stdout(`${finding.severity.toUpperCase()} ${finding.code} ${finding.path}: ${finding.message}\n`)
  }
  return report.ok ? 0 : 1
}

async function cmdVerify(parsed: ParsedArgs, io: BankCliIO): Promise<number> {
  const file = requirePos(parsed, 1, 'verify <file.SC2Bank>')
  const loaded = await loadBankFile(file, loadOptions(parsed, false))
  const signatureInfo = loaded.signatureInfo
  if (signatureInfo === undefined) {
    io.stderr('Cannot verify: missing signature info. Provide --bank-name, --author-id, and --player-id or use a standard SC2 bank path.\n')
    return 2
  }
  const valid = verifyBankSignature(loaded.bank, signatureInfo)
  io.stdout(valid ? 'VALID\n' : 'INVALID\n')
  return valid ? 0 : 1
}

async function cmdSign(parsed: ParsedArgs, io: BankCliIO): Promise<number> {
  const file = requirePos(parsed, 1, 'sign <file.SC2Bank>')
  const loaded = await loadBankFile(file, loadOptions(parsed, false))
  const signatureInfo = loaded.signatureInfo
  if (signatureInfo === undefined) {
    io.stderr('Cannot sign: missing signature info. Provide --bank-name, --author-id, and --player-id or use a standard SC2 bank path.\n')
    return 2
  }
  loaded.editor.sign(signatureInfo)
  const outPath = stringOption(parsed, 'out') ?? file
  const xml = await saveBankFile(outPath, loaded.editor, { signatureInfo, sign: true, createDirs: parsed.options.has('create-dirs') })
  io.stdout(`Signed ${outPath}\nSignature: ${loaded.editor.bank.signature ?? ''}\n`)
  if (parsed.options.has('print')) io.stdout(xml)
  return 0
}

async function cmdSet(parsed: ParsedArgs, io: BankCliIO): Promise<number> {
  const file = requirePos(parsed, 1, 'set <file.SC2Bank> <section> <key> <type> <value>')
  const section = requirePos(parsed, 2, 'set <file.SC2Bank> <section> <key> <type> <value>')
  const key = requirePos(parsed, 3, 'set <file.SC2Bank> <section> <key> <type> <value>')
  const type = requirePos(parsed, 4, 'set <file.SC2Bank> <section> <key> <type> <value>') as SC2BankValueType
  const rawValue = requirePos(parsed, 5, 'set <file.SC2Bank> <section> <key> <type> <value>')

  if (!VALUE_TYPES.has(type)) {
    io.stderr(`Warning: unknown value type "${type}", preserving it as a custom scalar type.\n`)
  }

  const loaded = await loadBankFile(file, loadOptions(parsed, false))
  loaded.editor.set(section, key, type, parsePrimitiveForType(type, rawValue))

  const shouldSign = parsed.options.has('sign') || !parsed.options.has('no-sign')
  const outPath = stringOption(parsed, 'out') ?? file
  const xml = await saveBankFile(outPath, loaded.editor, {
    ...(loaded.signatureInfo !== undefined ? { signatureInfo: loaded.signatureInfo } : {}),
    sign: shouldSign,
    createDirs: parsed.options.has('create-dirs'),
  })

  io.stdout(`Set ${section}/${key} (${type}) in ${outPath}\n`)
  if (shouldSign && loaded.signatureInfo === undefined) {
    io.stdout('Not signed: signature info was not available.\n')
  }
  if (parsed.options.has('print')) io.stdout(xml)
  return 0
}

async function cmdListBankList(parsed: ParsedArgs, io: BankCliIO): Promise<number> {
  const file = requirePos(parsed, 1, 'list-banklist <BankList.xml>')
  const xml = await readFile(file, 'utf8')
  const list = parseBankList(xml)
  const discoverRoot = stringOption(parsed, 'discover')
  if (parsed.options.has('json')) {
    if (discoverRoot !== undefined) {
      const discovered = await discoverBankFiles(discoverRoot, discoverOptions(parsed))
      io.stdout(`${JSON.stringify(matchBankListToDiscovered(list, discovered), null, 2)}\n`)
    } else {
      io.stdout(`${JSON.stringify(list, null, 2)}\n`)
    }
    return 0
  }

  if (discoverRoot !== undefined) {
    const discovered = await discoverBankFiles(discoverRoot, discoverOptions(parsed))
    for (const match of matchBankListToDiscovered(list, discovered)) {
      io.stdout(`${match.entry.name} player=${match.entry.player} matches=${match.discovered.length}\n`)
      for (const found of match.discovered) io.stdout(`  ${found.path}\n`)
    }
  } else {
    for (const entry of list.banks) io.stdout(`${entry.name} player=${entry.player}\n`)
  }
  return 0
}

async function cmdDiscover(parsed: ParsedArgs, io: BankCliIO): Promise<number> {
  const root = requirePos(parsed, 1, 'discover <rootPath>')
  const files = await discoverBankFiles(root, discoverOptions(parsed))
  if (parsed.options.has('json')) {
    io.stdout(`${JSON.stringify(files, null, 2)}\n`)
  } else {
    for (const file of files) {
      io.stdout(`${file.info.bankName} ${file.path}\n`)
    }
  }
  return 0
}

function signatureInfoFromOptions(parsed: ParsedArgs): SC2BankSignatureInfo | undefined {
  const bankName = stringOption(parsed, 'bank-name')
  const authorId = stringOption(parsed, 'author-id')
  const playerId = stringOption(parsed, 'player-id')
  if (bankName === undefined && authorId === undefined && playerId === undefined) return undefined
  if (bankName === undefined || authorId === undefined || playerId === undefined) {
    throw new Error('Signature options require all of --bank-name, --author-id, and --player-id')
  }
  return { bankName, authorId, playerId }
}

function loadOptions(parsed: ParsedArgs, validate?: boolean): LoadBankFileOptions {
  const signatureInfo = signatureInfoFromOptions(parsed)
  return {
    ...(signatureInfo !== undefined ? { signatureInfo } : {}),
    ...(validate !== undefined ? { validate } : {}),
  }
}

function discoverOptions(parsed: ParsedArgs): DiscoverBanksOptions {
  const maxDepth = numberOption(parsed, 'max-depth')
  return maxDepth !== undefined ? { maxDepth } : {}
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = []
  const options = new Map<string, string | boolean>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      options.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const name = arg.slice(2)
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--') && optionTakesValue(name)) {
      options.set(name, next)
      i++
    } else {
      options.set(name, true)
    }
  }
  return { positionals, options }
}

function optionTakesValue(name: string): boolean {
  return ['out', 'bank-name', 'author-id', 'player-id', 'discover', 'max-depth'].includes(name)
}

function requirePos(parsed: ParsedArgs, index: number, syntax: string): string {
  const value = parsed.positionals[index]
  if (value === undefined) throw new Error(`Usage: modkitx-bank ${syntax}`)
  return value
}

function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name)
  return typeof value === 'string' ? value : undefined
}

function numberOption(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringOption(parsed, name)
  if (value === undefined) return undefined
  const parsedValue = Number(value)
  if (!Number.isInteger(parsedValue) || parsedValue < 0) throw new Error(`--${name} must be a non-negative integer`)
  return parsedValue
}

function parsePrimitiveForType(type: SC2BankValueType, value: string): BankPrimitiveValue {
  switch (type) {
    case 'int':
      return parseInt(value, 10)
    case 'fixed':
      return parseFloat(value)
    case 'flag':
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
    case 'point': {
      const [x, y] = value.split(',').map(part => Number(part.trim()))
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('Point values must use "x,y" syntax')
      }
      return { x, y }
    }
    default:
      return value
  }
}

function formatPrimitive(value: BankPrimitiveValue): string {
  return typeof value === 'object' ? `${value.x},${value.y}` : String(value)
}

function usage(): string {
  return `modkitx-bank <command> [args]

Commands:
  read <file.SC2Bank> [--json]
  validate <file.SC2Bank> [--require-signature] [--bank-name N --author-id ID --player-id ID]
  verify <file.SC2Bank> [--bank-name N --author-id ID --player-id ID]
  sign <file.SC2Bank> [--out file] [--bank-name N --author-id ID --player-id ID]
  set <file.SC2Bank> <section> <key> <type> <value> [--out file] [--sign|--no-sign]
  list-banklist <BankList.xml> [--json] [--discover root]
  discover <rootPath> [--json] [--max-depth N]

Types: int, fixed, string, flag, text, point
`
}

const defaultIO: BankCliIO = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = await runBankCli(process.argv.slice(2))
  process.exitCode = code
}
