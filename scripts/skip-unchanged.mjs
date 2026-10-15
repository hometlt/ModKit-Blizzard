#!/usr/bin/env node
/**
 * Runs a build step only when its inputs changed since it last succeeded.
 *
 *   node scripts/skip-unchanged.mjs --key <name> --inputs a,b --exclude x,y --outputs o -- <command...>
 *
 * Inputs are files or folders (repository-relative); the fingerprint is each file's path, size and
 * modification time (the evidence the incremental TypeScript projects leave untouched when nothing
 * changed), without the `--exclude` folders — a step's own outputs inside its inputs. The step runs
 * when the fingerprint differs from the recorded one or any `--outputs` path is missing, and the
 * fingerprint is recorded only after it succeeds. Records live in `node_modules/.cache/build-steps`
 * (outside every extension root); `build-cache-guard.mjs` drops them with a missing `dist`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const separator = process.argv.indexOf('--')
if (separator < 0 || separator === process.argv.length - 1) {
  throw new Error('skip-unchanged: a command must follow --')
}
const option = name => {
  const index = process.argv.indexOf(name)
  return index < 0 || index > separator ? [] : (process.argv[index + 1] ?? '').split(',').filter(Boolean)
}
const [key] = option('--key')
if (key === undefined || !/^[\w.-]+$/u.test(key)) throw new Error('skip-unchanged: --key <name> is required')
const inputs = option('--inputs').map(path => resolve(repositoryRoot, path))
const excluded = option('--exclude').map(path => resolve(repositoryRoot, path))
const outputs = option('--outputs').map(path => resolve(repositoryRoot, path))
const command = process.argv.slice(separator + 1)

const hash = createHash('sha256')
const visit = path => {
  if (excluded.some(item => path === item || path.startsWith(`${item}${sep}`))) return
  if (!existsSync(path)) {
    hash.update(`missing\0${relative(repositoryRoot, path)}\0`)
    return
  }
  const stat = statSync(path, { bigint: true })
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) visit(join(path, name))
    return
  }
  hash.update(`${relative(repositoryRoot, path)}\0${String(stat.size)}\0${String(stat.mtimeNs)}\0`)
}
hash.update(JSON.stringify(command))
for (const input of inputs) visit(input)
const fingerprint = hash.digest('hex')

const record = join(repositoryRoot, 'node_modules', '.cache', 'build-steps', `${key}.json`)
let previous
try {
  previous = JSON.parse(readFileSync(record, 'utf8')).fingerprint
} catch {
  previous = undefined
}
if (previous === fingerprint && outputs.every(path => existsSync(path))) {
  process.stdout.write(`skip-unchanged: ${key} inputs unchanged, step skipped\n`)
  process.exit(0)
}
const result = spawnSync(command[0], command.slice(1), {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result.status !== 0) process.exit(result.status ?? 1)
await mkdir(dirname(record), { recursive: true })
await writeFile(record, `${JSON.stringify({ fingerprint })}\n`)
