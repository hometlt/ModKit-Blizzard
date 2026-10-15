import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { gitDiffStrings, collectToStaging, stageChangedStrings } from '../../shared/core/node.js'

const run = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', ['-C', cwd, ...args])
}

describe('gitDiffStrings + staging (real temp repo)', () => {
  it('reports key-level changes between commits and stages them', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'modkit-git-'))
    try {
      await git(repo, 'init', '-q')
      await git(repo, 'config', 'user.email', 't@t.t')
      await git(repo, 'config', 'user.name', 'T')
      const file = path.join(repo, 'GameStrings.txt')
      await fs.writeFile(file, 'A=1\nB=2\n', 'utf-8')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-qm', 'v1')

      await fs.writeFile(file, 'A=1\nB=9\nC=3\n', 'utf-8') // B modified, C added (working tree)

      const changes = await gitDiffStrings({ cwd: repo, file: 'GameStrings.txt', fromRef: 'HEAD' })
      const byKey = Object.fromEntries(changes.map((c) => [c.key, c.kind]))
      expect(byKey).toEqual({ B: 'modified', C: 'added' })

      const staged = await stageChangedStrings({ cwd: repo, file: 'GameStrings.txt', fromRef: 'HEAD', outDir: path.join(repo, '.stage') })
      const out = await fs.readFile(staged.file, 'utf-8')
      expect(out).toContain('B=9')
      expect(out).toContain('C=3')
      expect(out).not.toContain('A=1') // unchanged keys are not staged
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  it('collectToStaging writes a key=value file and creates dirs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modkit-stage-'))
    try {
      const outFile = path.join(dir, 'sub', 'out.txt')
      await collectToStaging({ entries: [{ key: 'X', value: 'hi' }, { key: 'Y', value: 'yo' }], outFile })
      expect(await fs.readFile(outFile, 'utf-8')).toBe('X=hi\nY=yo\n')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
