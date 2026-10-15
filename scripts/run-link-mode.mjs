import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveCoreRoot } from './core-link-config.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const coreRoot = resolveCoreRoot(repositoryRoot)
const register = pathToFileURL(resolve(repositoryRoot, 'scripts/core-link-register.mjs')).href

if (!existsSync(resolve(coreRoot, 'packages/core/package.json'))) {
  throw new Error(`MODKIT_CORE_ROOT is not a Modkit core checkout: ${coreRoot}`)
}

const [command, ...arguments_] = process.argv.slice(2)
if (command === undefined) throw new Error('usage: node scripts/run-link-mode.mjs <command> [...args]')
const pnpmEntrypoint = process.env.npm_execpath ?? join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
const executable = command === 'node' || (process.platform === 'win32' && command === 'pnpm') ? process.execPath : command
const executableArguments =
  process.platform === 'win32' && command === 'pnpm' ? [pnpmEntrypoint, ...arguments_] : arguments_
const result = spawnSync(executable, executableArguments, {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    MODKIT_CORE_ROOT: coreRoot,
    MODKIT_LINK_MODE: 'core',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${register}`.trim(),
  },
  stdio: 'inherit',
})

if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
