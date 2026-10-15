import { spawnSync } from 'node:child_process'

const arguments_ = process.argv.slice(2)
if (arguments_.length === 0) throw new Error('usage: node scripts/run-vendor-test.mjs <node-test-args>')

const nodeOptions = (process.env.NODE_OPTIONS ?? '')
  .split(/\s+/u)
  .filter(option => !option.includes('core-link-register.mjs'))
  .filter(Boolean)
if (!nodeOptions.some(option => option.startsWith('--max-old-space-size='))) {
  // The deterministic bundle test intentionally holds two complete eight-root artifacts while it
  // compares them. The copied SC2 family makes that proof larger than Node's default test-worker
  // heap, so give the proof enough memory without changing its assertions or output.
  nodeOptions.push('--max-old-space-size=4096')
}

const environment = { ...process.env }
delete environment.MODKIT_LINK_MODE
environment.NODE_OPTIONS = nodeOptions.join(' ')

const result = spawnSync(process.execPath, arguments_, { env: environment, stdio: 'inherit' })
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
