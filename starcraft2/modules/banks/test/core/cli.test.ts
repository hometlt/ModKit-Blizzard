import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parseBank, verifyBankSignature } from '../../shared/core/index.js'
import { runBankCli } from '../../shared/core/cli.js'

function capture() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: (text: string) => { stdout += text },
      stderr: (text: string) => { stderr += text },
    },
    get stdout() { return stdout },
    get stderr() { return stderr },
  }
}

async function tempBankPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modkitx-bank-cli-'))
  const dir = join(root, 'Accounts', '123', '2-S2-1-98765', 'Banks', '2-S2-1-2355723')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'sample.SC2Bank')
  await writeFile(file, `<Bank version="1">
  <Section name="Stats">
    <Key name="Score">
      <Value int="75"/>
    </Key>
  </Section>
</Bank>
`, 'utf8')
  return file
}

describe('modkitx-bank CLI', () => {
  it('prints a readable bank summary', async () => {
    const file = await tempBankPath()
    const out = capture()

    const code = await runBankCli(['read', file], out.io)

    expect(code).toBe(0)
    expect(out.stdout).toContain('Bank: sample')
    expect(out.stdout).toContain('[Stats]')
    expect(out.stdout).toContain('Score (int) = 75')
    expect(out.stderr).toBe('')
  })

  it('sets a value and signs when path signature info is available', async () => {
    const file = await tempBankPath()
    const out = capture()

    const code = await runBankCli(['set', file, 'Stats', 'Score', 'int', '1000', '--sign'], out.io)

    expect(code).toBe(0)
    expect(out.stdout).toContain('Set Stats/Score (int)')
    const bank = parseBank(await readFile(file, 'utf8'))
    expect(bank.sections[0]!.keys[0]!.value).toEqual({ type: 'int', value: '1000' })
    expect(verifyBankSignature(bank, {
      bankName: 'sample',
      authorId: '2-S2-1-2355723',
      playerId: '2-S2-1-98765',
    })).toBe(true)
  })

  it('verifies a signed bank', async () => {
    const file = await tempBankPath()
    await runBankCli(['sign', file], capture().io)
    const out = capture()

    const code = await runBankCli(['verify', file], out.io)

    expect(code).toBe(0)
    expect(out.stdout).toBe('VALID\n')
  })

  it('lists BankList.xml entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modkitx-bank-list-cli-'))
    const file = join(root, 'BankList.xml')
    await writeFile(file, `<BankList>
  <Bank Name="A" Player="1"/>
  <Bank Name="B" Player="0"/>
</BankList>
`, 'utf8')
    const out = capture()

    const code = await runBankCli(['list-banklist', file], out.io)

    expect(code).toBe(0)
    expect(out.stdout).toContain('A player=1')
    expect(out.stdout).toContain('B player=0')
  })
})
