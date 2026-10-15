import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const output = new URL('../starcraft2/dist/src/ts-lane/index.js', import.meta.url)
const declarations = new URL('../starcraft2/dist/src/ts-lane/index.d.ts', import.meta.url)

test('the TypeScript lane emits a runtime enum and preserves a type-only declaration edge', async () => {
  const module = await import(output.href)
  assert.deepEqual(module.createTypeScriptLaneEvidence(), {
    status: module.TypeScriptLaneStatus.Verified,
    code: 1,
  })
  assert.equal(module.TypeScriptLaneStatus.Verified, 'verified')
  assert.match(await readFile(declarations, 'utf8'), /import type/u)
})
