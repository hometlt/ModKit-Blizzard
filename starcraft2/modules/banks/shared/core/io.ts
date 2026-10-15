import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseBank, serializeBank } from './bank.js'
import { SC2BankEditor } from './editor.js'
import { inferBankSignatureInfo, toSignatureInfo } from './path.js'
import { validateBank } from './validate.js'
import type {
  InferredBankSignatureInfo,
  LoadBankFileOptions,
  BankValidationReport,
  SaveBankFileOptions,
  SC2Bank,
  SC2BankSignatureInfo,
} from './types.js'

export interface LoadedBankFile {
  path: string
  xml: string
  bank: SC2Bank
  editor: SC2BankEditor
  inferredInfo: InferredBankSignatureInfo
  signatureInfo?: SC2BankSignatureInfo
  validation: BankValidationReport
}

export async function loadBankFile(path: string, options: LoadBankFileOptions = {}): Promise<LoadedBankFile> {
  const xml = await readFile(path, 'utf8')
  const bank = parseBank(xml)
  const inferredInfo = inferBankSignatureInfo(path)
  const signatureInfo = options.signatureInfo ?? toSignatureInfo(inferredInfo)
  const editor = new SC2BankEditor(bank, signatureInfo)
  const validation = options.validate === false
    ? { ok: true, findings: [] }
    : validateBank(bank, signatureInfo !== undefined ? { signatureInfo } : {})

  return {
    path,
    xml,
    bank,
    editor,
    inferredInfo,
    ...(signatureInfo !== undefined ? { signatureInfo } : {}),
    validation,
  }
}

export async function saveBankFile(
  path: string,
  bankOrEditor: SC2Bank | SC2BankEditor,
  options: SaveBankFileOptions = {},
): Promise<string> {
  if (options.createDirs === true) await mkdir(dirname(path), { recursive: true })

  const bank = bankOrEditor instanceof SC2BankEditor ? bankOrEditor.bank : bankOrEditor
  const editorInfo = bankOrEditor instanceof SC2BankEditor ? bankOrEditor.signatureInfo : undefined
  const inferredInfo = inferBankSignatureInfo(path)
  const signatureInfo: SC2BankSignatureInfo | undefined = options.signatureInfo ?? editorInfo ?? toSignatureInfo(inferredInfo)
  const shouldSign = options.sign === true || (options.sign !== false && signatureInfo !== undefined)

  const xml = serializeBank(bank, {
    ...options,
    signature: shouldSign && signatureInfo !== undefined ? signatureInfo : false,
  })
  await writeFile(path, xml, 'utf8')
  return xml
}
