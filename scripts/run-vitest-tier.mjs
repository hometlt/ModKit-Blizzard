import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tier = process.argv[2]
if (!['quick', 'owner', 'real'].includes(tier)) {
  throw new Error('usage: node scripts/run-vitest-tier.mjs <quick|owner|real>')
}

await import('../models/build.mjs')

const result = spawnSync(
  process.platform === 'win32' ? process.execPath : 'pnpm',
  process.platform === 'win32'
    ? [
        join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
        'exec',
        'vitest',
        'run',
        '--config',
        './test/vitest.config.mjs',
      ]
    : ['exec', 'vitest', 'run', '--config', './test/vitest.config.mjs'],
  {
  cwd: dirname(fileURLToPath(new URL('../package.json', import.meta.url))),
  env: { ...process.env, MODKIT_TEST_TIER: tier },
    stdio: 'inherit',
  },
)

if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
