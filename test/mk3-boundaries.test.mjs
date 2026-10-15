import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkLegacyBaseline, checkDynamicImports, legacyImportInventory, legacyTarget } from '../scripts/check-mk3-boundaries.mjs'

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'modkit-boundaries-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'modkit.repository.json'), JSON.stringify({ extensions: [{ path: 'game' }] }))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

test('AST gate detects static, type, reexport, dynamic and CommonJS dependencies without comment false positives', async t => {
  const root = await fixture(t, {
    'game/modules/data/main.ts': `
      // import ignored from '@modkit/codec-kit/legacy/comment'
      const documentation = "import('@modkit/codec-kit/legacy/documentation')";
      import '@modkit/codec-kit/legacy/side-effect';
      import type { Raw } from '@modkit/codec-kit/legacy/xml';
      import equals = require('@modkit/codec-kit/legacy/assets');
      export { parse } from '../../src/lib/mk2/parser.js';
      export type { Model } from '@modkit/codec-kit/legacy/xml';
      type Query = import('@modkit/codec-kit/legacy/xml').Raw;
      const legacy = '@modkit/codec-kit/' + 'legacy/core';
      void import(legacy);
      require('@modkit/codec-kit/legacy/required');
      require.resolve('@modkit/codec-kit/legacy/resolve');
    `,
    'game/shared/main.js': '/** @type {import("@modkit/codec-kit/legacy/xml").Raw} */\nexport let value;',
    'game/modules/data/test/oracle.ts': "import '@modkit/codec-kit/legacy/ignored-test'",
    'game/modules/data/main.spec.ts': "import '@modkit/codec-kit/legacy/ignored-test'",
    'game/modules/data/scripts/generate.mjs': "import '@modkit/codec-kit/legacy/ignored-tool'",
  })
  const result = await legacyImportInventory(root)
  assert.deepEqual(result.errors, [])
  assert.equal(result.scannedFiles, 2)
  assert.equal(result.imports.length, 10)
  assert.equal(result.imports.some(entry => /comment|documentation|ignored/.test(entry.specifier)), false)
  assert.deepEqual(new Set(result.imports.map(entry => entry.kind)), new Set(['import', 'import-type', 'import-equals', 'export', 'export-type', 'type-query', 'dynamic-import', 'require', 'require-resolve']))
})

test('computed module specifiers cannot silently bypass the boundary', async t => {
  const root = await fixture(t, {
    'game/modules/data/main.ts': `
      const packageName = '@modkit/codec-kit/legacy/core';
      void import(packageName);
      function runtime(packageName: string) { return import(packageName); }
      const prefix = '@modkit/codec-kit';
      void import(\`\${prefix}/legacy/xml\`);
    `,
  })
  const result = await legacyImportInventory(root)
  assert.equal(result.imports.length, 2)
  assert.deepEqual(result.errors, [])
  assert.equal(result.dynamicImports.length, 1)
  assert.match(checkDynamicImports(result.dynamicImports)[0], /cannot statically resolve dynamic-import: packageName/)
  const reviewed = [{ ...result.dynamicImports[0], owner: 'fixture', reason: 'Reviewed fixture only' }]
  assert.deepEqual(checkDynamicImports(result.dynamicImports, reviewed), [])
  assert.notDeepEqual(checkDynamicImports([{ ...result.dynamicImports[0], sha256: 'changed-source' }], reviewed), [])
  assert.notDeepEqual(checkDynamicImports([], reviewed), [])
})

test('baseline rejects new imports, growth, removed entries, malformed allowances and duplicates', () => {
  const entry = { file: 'game/modules/data/main.ts', specifier: '@modkit/codec-kit/legacy/xml', kind: 'import', count: 1 }
  const baseline = { schemaVersion: 1, imports: [{ ...entry, owner: 'data', replacement: 'public XML and Data owner APIs' }] }
  assert.deepEqual(checkLegacyBaseline([entry], baseline), [])
  assert.match(checkLegacyBaseline([{ ...entry, specifier: '@modkit/codec-kit/legacy/core' }], baseline).join('\n'), /new legacy/)
  assert.match(checkLegacyBaseline([{ ...entry, count: 2 }], baseline).join('\n'), /new legacy imports are forbidden/)
  assert.match(checkLegacyBaseline([], baseline).join('\n'), /stale baseline/)
  assert.match(checkLegacyBaseline([entry], { ...baseline, imports: [{ ...baseline.imports[0], count: 2 }] }).join('\n'), /shrink the reviewed baseline/)
  for (const patch of [{ file: 'game/**' }, { owner: '' }, { replacement: '' }, { count: 0 }, { specifier: '@modkit/sdk' }]) {
    assert.match(checkLegacyBaseline([], { ...baseline, imports: [{ ...baseline.imports[0], ...patch }] }).join('\n'), /invalid exact baseline/)
  }
  assert.match(checkLegacyBaseline([entry], { ...baseline, imports: [baseline.imports[0], baseline.imports[0]] }).join('\n'), /duplicate entry/)
})

test('legacy path detection normalizes segments without matching similarly named public paths', () => {
  assert.equal(legacyTarget('game/modules/data/main.ts', '../../src/lib/tmp/../mk2/parser.js'), true)
  assert.equal(legacyTarget('game/modules/data/main.ts', '@modkit/codec-kit/legacy/xml'), true)
  assert.equal(legacyTarget('game/modules/data/main.ts', '@modkit/codec-kit/legacy-public/xml'), false)
  assert.equal(legacyTarget('game/modules/data/main.ts', './mk2-format-name.js'), false)
})
