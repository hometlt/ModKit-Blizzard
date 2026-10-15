import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  inferBankSignatureInfo,
  parseBank,
  parseBankList,
  SC2BankEditor,
  serializeBank,
  toSignatureInfo,
  validateBank,
} from '../../shared/core/core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('browser-safe core entrypoint', () => {
  it('exports parser, editor, BankList, validation, and path inference without Node IO helpers', () => {
    const bank = parseBank('<Bank><Section name="Stats"><Key name="Score"><Value int="75"/></Key></Section></Bank>')
    const editor = new SC2BankEditor(bank)
    editor.setString('Meta', 'Name', 'Test')

    expect(serializeBank(editor.bank)).toContain('Name')
    expect(validateBank(editor.bank).ok).toBe(true)
    expect(parseBankList('<BankList><Bank Name="A" Player="1"/></BankList>').banks[0]!.name).toBe('A')

    const inferred = inferBankSignatureInfo('Accounts/1/2-S2-1-9/Banks/2-S2-1-5/A.SC2Bank')
    expect(toSignatureInfo(inferred)).toEqual({
      bankName: 'A',
      authorId: '2-S2-1-5',
      playerId: '2-S2-1-9',
    })
  })

  it('does not import node built-ins from the core module graph', () => {
    const files = ['../../shared/core/core.ts', '../../shared/core/bank.ts', '../../shared/core/bank-list.ts', '../../shared/core/editor.ts', '../../shared/core/path-core.ts', '../../shared/core/validate.ts', '../../../../../../modkit-core/packages/codec-kit/src/crypto/sha1.ts', '../../shared/core/types.ts']
    for (const file of files) {
      const text = readFileSync(join(__dirname, file), 'utf8')
      expect(text, file).not.toMatch(/from ['"]node:/)
      expect(text, file).not.toMatch(/import\(['"]node:/)
    }
  })
})
