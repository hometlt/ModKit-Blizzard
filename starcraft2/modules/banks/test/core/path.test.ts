import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverBankFiles, inferBankSignatureInfo, toSignatureInfo } from '../../shared/core/index.js'

describe('bank path inference', () => {
  it('infers signature info from a local SC2 bank path', () => {
    const info = inferBankSignatureInfo(
      'C:\\Users\\Player\\Documents\\StarCraft II\\Accounts\\123456\\2-S2-1-98765\\Banks\\2-S2-1-2355723\\endofdreamsbank2.SC2Bank',
    )

    expect(info).toEqual({
      bankName: 'endofdreamsbank2',
      authorId: '2-S2-1-2355723',
      playerId: '2-S2-1-98765',
      bankPath: 'C:/Users/Player/Documents/StarCraft II/Accounts/123456/2-S2-1-98765/Banks/2-S2-1-2355723/endofdreamsbank2.SC2Bank',
      missing: [],
    })
    expect(toSignatureInfo(info)).toEqual({
      bankName: 'endofdreamsbank2',
      authorId: '2-S2-1-2355723',
      playerId: '2-S2-1-98765',
    })
  })

  it('reports missing author/player ids instead of guessing unsafe values', () => {
    const info = inferBankSignatureInfo('C:/tmp/endofdreamsbank2.SC2Bank')

    expect(info.bankName).toBe('endofdreamsbank2')
    expect(info.missing).toEqual(['authorId', 'playerId'])
    expect(toSignatureInfo(info)).toBeUndefined()
  })

  it('discovers bank files recursively', async () => {
    const root = join(tmpdir(), `modkitx-bank-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const bankDir = join(root, 'Accounts', '123456', '2-S2-1-98765', 'Banks', '2-S2-1-2355723')
    await mkdir(bankDir, { recursive: true })
    await writeFile(join(bankDir, 'endofdreamsbank2.SC2Bank'), '<Bank/>')
    await writeFile(join(bankDir, 'ignore.txt'), '')

    const discovered = await discoverBankFiles(root)

    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.info.bankName).toBe('endofdreamsbank2')
    expect(discovered[0]!.info.authorId).toBe('2-S2-1-2355723')
    expect(discovered[0]!.info.playerId).toBe('2-S2-1-98765')
  })
})
