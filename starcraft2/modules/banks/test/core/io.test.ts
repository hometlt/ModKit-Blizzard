import { describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadBankFile, saveBankFile, SC2BankEditor } from '../../shared/core/index.js'

describe('bank file IO helpers', () => {
  it('saves, infers signature info, loads, validates, and edits a bank file', async () => {
    const root = join(tmpdir(), `modkitx-bank-io-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const filePath = join(root, 'Accounts', '123456', '2-S2-1-10', 'Banks', '2-S2-1-20', 'Bank.SC2Bank')
    await mkdir(dirname(filePath), { recursive: true })

    const editor = new SC2BankEditor({ sections: [] })
    editor.setInt('Stats', 'Score', 7)
    await saveBankFile(filePath, editor, { createDirs: true })

    const loaded = await loadBankFile(filePath)
    expect(loaded.signatureInfo).toEqual({ bankName: 'Bank', authorId: '2-S2-1-20', playerId: '2-S2-1-10' })
    expect(loaded.validation.ok).toBe(true)
    expect(loaded.validation.findings.map(finding => finding.code)).toEqual(['valid-signature'])
    expect(loaded.editor.getInt('Stats', 'Score')).toBe(7)

    loaded.editor.setInt('Stats', 'Score', 8)
    await saveBankFile(filePath, loaded.editor)

    const reloaded = await loadBankFile(filePath)
    expect(reloaded.editor.getInt('Stats', 'Score')).toBe(8)
    expect(reloaded.validation.ok).toBe(true)
  })
})
