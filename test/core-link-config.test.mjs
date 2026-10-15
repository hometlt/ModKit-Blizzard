import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { resolveCoreRoot } from '../scripts/core-link-config.mjs'

test('workspace core source is used and an explicit environment root takes precedence', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'modkit-link-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'modkit.workspace.json')
  await writeFile(config, JSON.stringify({ schemaVersion: 1, sources: [{ id: 'core', uri: './custom-core' }] }))
  assert.equal(resolveCoreRoot(path.join(root, 'blizzard'), {}), path.join(root, 'custom-core'))
  assert.equal(resolveCoreRoot(root, { MODKIT_CORE_ROOT: path.join(root, 'override'), MODKIT_WORKSPACE_CONFIG: config }), path.join(root, 'override'))
})

test('missing core export fails instead of silently loading a vendor package', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'modkit-link-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'packages/core'), { recursive: true })
  await writeFile(path.join(root, 'packages/core/package.json'), JSON.stringify({ exports: { '.': './dist/missing.js' } }))
  const result = spawnSync(process.execPath, ['--import', new URL('../scripts/core-link-register.mjs', import.meta.url).href, '--input-type=module', '-e', "await import('@modkit/core')"], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', MODKIT_LINK_MODE: 'core', MODKIT_CORE_ROOT: root } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /core link export is missing or unbuilt/u)
})
