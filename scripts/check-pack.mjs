import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'modkit-extensions-blizzard-pack-'))
try {
  const pnpmArguments = ['pack', '--pack-destination', temporaryDirectory]
  const command = process.platform === 'win32' ? process.execPath : 'pnpm'
  const arguments_ =
    process.platform === 'win32'
      ? [
          join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
          ...pnpmArguments,
        ]
      : pnpmArguments
  const packed = spawnSync(command, arguments_, {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout)
  const archives = (await readdir(temporaryDirectory)).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  const listed = spawnSync('tar', ['-tf', join(temporaryDirectory, archives[0])], {
    encoding: 'utf8',
  })
  if (listed.status !== 0) throw new Error(listed.stderr || listed.stdout)
  const files = listed.stdout.split(/\r?\n/u).filter(Boolean)
  for (const license of [
    'GALAXY-LANGUAGE-NOTICE.md',
    'GPL-2.0-only.txt',
    'MIT.txt',
    'README.md',
    'THIRD-PARTY-NOTICES.md',
    'TRADEMARKS.md',
    'plaxtony-MIT.txt',
    'sax-BlueOak-1.0.0.md',
  ]) {
    assert.ok(files.includes(`package/licenses/${license}`), license)
  }
  assert.equal(
    files.some(file => /MK2-CONVERSION|MIGRATION/iu.test(file)),
    false,
  )
  for (const root of ['blizzard-common-formats', 'blizzard-diablo', 'blizzard-warcraft-3']) {
    assert.ok(files.includes(`package/${root}/package.json`), root)
  }
  const sc2 = JSON.parse(await readFile(new URL('../starcraft2/package.json', import.meta.url), 'utf8'))
  for (const condition of ['default', 'types']) {
    const target = sc2.exports['./ts-lane'][condition]
    assert.equal(typeof target, 'string', `TypeScript lane ${condition} export`)
    assert.ok(target.startsWith('./'), `TypeScript lane export must be package-local: ${target}`)
    const path = `package/starcraft2/${target.slice(2)}`
    assert.ok(files.includes(path), `TypeScript publish output: ${path}`)
  }
  assert.ok(
    files.includes('package/vendor/modkit-testkit-0.1.0.tgz'),
    'standalone Testkit artifact',
  )
  process.stdout.write(`Blizzard distribution pack verified: ${files.length} files\n`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
