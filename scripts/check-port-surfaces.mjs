import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const profiles = Object.freeze({
  'galaxy:m5': Object.freeze({
    codec: 'galaxy',
    codecId: 'blizzard/galaxy',
    scope: 'm5',
    tests: Object.freeze([
      Object.freeze({ path: 'starcraft2/modules/galaxy/test/codec-native.test.ts', count: 4 }),
      Object.freeze({ path: 'starcraft2/test/galaxy-native-host.test.ts', count: 2 }),
    ]),
    inputs: Object.freeze([
      'starcraft2/dist/modules/galaxy/codecs/galaxy/codec.js',
      'starcraft2/modules/galaxy/codecs/galaxy/codec.json',
      'starcraft2/modules/galaxy/providers/language/provider.json',
      'starcraft2/modules/galaxy/language/provider.js',
      'starcraft2/modules/galaxy/data/galaxy-script-api.v1.json',
    ]),
  }),
  'sc2-bank:m2': Object.freeze({
    codec: 'sc2-bank',
    codecId: 'blizzard/sc2-bank',
    scope: 'm2',
    tests: Object.freeze([
      Object.freeze({ path: 'starcraft2/modules/banks/test/native.test.ts', count: 6 }),
      Object.freeze({ path: 'starcraft2/modules/banks/test/native-host.test.ts', count: 2 }),
    ]),
    inputs: Object.freeze([
      'starcraft2/dist/modules/banks/codecs/bank/src/codec.js',
      'starcraft2/modules/banks/codecs/bank/codec.json',
    ]),
  }),
  'sc2-data:m5': Object.freeze({
    codec: 'sc2-data',
    codecId: 'blizzard/sc2-data',
    scope: 'm5',
    tests: Object.freeze([
      Object.freeze({ path: 'starcraft2/modules/data/test/sc2-data-native.test.ts', count: 5 }),
      Object.freeze({ path: 'starcraft2/modules/data/test/sc2-data-native-host.test.ts', count: 2 }),
      /*
       * The adaptation tests belong in the receipt: they are what proves the provider routes to the
       * ported library rather than re-deriving it, which is the whole subject of this change.
       */
      Object.freeze({ path: 'starcraft2/modules/data/test/sc2-data-language.test.ts', count: 16 }),
    ]),
    inputs: Object.freeze([
      'starcraft2/modules/data/shared/format/language/index.ts',
      'starcraft2/modules/data/providers/language/src/language.ts',
      'starcraft2/dist/modules/data/codecs/sc2data/src/codec.js',
      'starcraft2/modules/data/codecs/sc2data/codec.json',
      'starcraft2/contributions/subject-kind-sc2-data.json',
    ]),
  }),
  'sc2-layout:m5': Object.freeze({
    codec: 'sc2-layout',
    codecId: 'blizzard/sc2-layout',
    scope: 'm5',
    tests: Object.freeze([
      Object.freeze({ path: 'starcraft2/modules/layout/test/sc2-layout-native.test.ts', count: 5 }),
      Object.freeze({ path: 'starcraft2/modules/layout/test/sc2-layout-native-host.test.ts', count: 3 }),
    ]),
    inputs: Object.freeze([
      'starcraft2/dist/modules/layout/codecs/layout/src/codec.js',
      'starcraft2/dist/modules/layout/shared/runtime.js',
      'starcraft2/dist/modules/layout/codecs/layout/portable/codec.mjs',
      'starcraft2/dist/modules/layout/shared/generated/sc2layout-schema-data.json',
      'starcraft2/modules/layout/codecs/layout/codec.json',
      'starcraft2/modules/layout/providers/language/provider.json',
      'starcraft2/contributions/subject-kind-sc2-layout.json',
      'starcraft2/shared/editing/providers/authored-text/provider.json',
    ]),
  }),
  'sc2-document-metadata:m5': Object.freeze({
    codec: 'sc2-document-metadata',
    codecId: 'blizzard/sc2-document-metadata',
    scope: 'm5',
    tests: Object.freeze([
      Object.freeze({ path: 'starcraft2/modules/mod/test/sc2-document-metadata-native.test.ts', count: 4 }),
      Object.freeze({ path: 'starcraft2/modules/mod/test/sc2-document-metadata-native-host.test.ts', count: 2 }),
    ]),
    inputs: Object.freeze([
      'starcraft2/dist/modules/mod/codecs/document-metadata/codec.js',
      'starcraft2/dist/modules/mod/codecs/document-metadata/dependencies.js',
      'starcraft2/dist/modules/mod/codecs/document-metadata/core/document-header.js',
      'starcraft2/dist/modules/mod/codecs/document-metadata/core/document-info.js',
      'starcraft2/dist/modules/mod/codecs/document-metadata/core/index.js',
      'starcraft2/dist/modules/mod/codecs/document-metadata/core/types.js',
      'starcraft2/dist/modules/mod/codecs/document-metadata/core/version-file.js',
      'starcraft2/modules/mod/codecs/document-metadata/codec.json',
      'starcraft2/contributions/subject-kind-sc2-document-metadata.json',
    ]),
  }),
  'sc2-strings:m5': Object.freeze({
    codec: 'sc2-strings',
    codecId: 'blizzard/sc2-strings',
    scope: 'm5',
    tests: Object.freeze([
      Object.freeze({ path: 'starcraft2/modules/strings/test/native.test.ts', count: 2 }),
      Object.freeze({ path: 'starcraft2/modules/strings/test/native-host.test.ts', count: 4 }),
      /*
       * The adaptation tests belong in the receipt, not beside it. They are what proves the adapter
       * routes to the ported library rather than re-deriving it, and a receipt that omits them
       * would attest to a surface while saying nothing about where its behaviour comes from.
       */
      Object.freeze({ path: 'starcraft2/modules/strings/test/adapted.test.ts', count: 12 }),
      Object.freeze({ path: 'starcraft2/test/catalog-resolver.test.ts', count: 7 }),
    ]),
    inputs: Object.freeze([
      'starcraft2/dist/modules/strings/codecs/strings/src/codec.js',
      'starcraft2/modules/strings/codecs/strings/codec.json',
      // The ported library the adapter now runs on, and the bridge that feeds it resolved data.
      'starcraft2/modules/strings/shared/core/index.ts',
      'starcraft2/shared/language/catalog-resolver.ts',
    ]),
  }),
  'sc2-triggers:m5': Object.freeze({
    codec: 'sc2-triggers',
    codecId: 'blizzard/sc2-triggers',
    scope: 'm5',
    tests: Object.freeze([
      Object.freeze({ path: 'starcraft2/modules/triggers/test/sc2-triggers-native.test.ts', count: 3 }),
      Object.freeze({ path: 'starcraft2/modules/triggers/test/sc2-triggers-native-host.test.ts', count: 4 }),
    ]),
    inputs: Object.freeze([
      'starcraft2/dist/modules/triggers/codecs/triggers/src/codec.js',
      'starcraft2/modules/triggers/codecs/triggers/codec.json',
      'starcraft2/modules/triggers/providers/language/provider.json',
      'starcraft2/modules/triggers/providers/language/runtime.js',
    ]),
  }),
  'm3:m6': Object.freeze({
    codec: 'm3',
    codecId: 'blizzard/m3',
    scope: 'm6',
    tests: Object.freeze([
      Object.freeze({ path: 'models/test/m3-writer.test.ts', count: 5 }),
      Object.freeze({ path: 'models/test/m3-writer-host.test.ts', count: 2 }),
      Object.freeze({ path: 'models/test/m3-attachments-sidecar.test.ts', count: 7 }),
    ]),
    inputs: Object.freeze([
      'models/src/m3/codec.js',
      'models/src/m3/writer.js',
      'models/codecs/m3/codec.json',
      'models/providers/m3-writer/provider.json',
    ]),
  }),
})
const usage =
  'usage: surfaces:check --codec <galaxy|sc2-bank|sc2-data|sc2-document-metadata|sc2-layout|sc2-strings|sc2-triggers|m3> --scope <m2|m5|m6> --out <directory>'

function optionsFrom(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      !['--codec', '--scope', '--out'].includes(key) ||
      options[key] !== undefined ||
      value === undefined ||
      value.trim() === '' ||
      value.startsWith('--')
    ) {
      throw Object.assign(new Error(usage), { exitCode: 2 })
    }
    options[key] = value
  }
  const profile = profiles[`${options['--codec']}:${options['--scope']}`]
  if (profile === undefined || options['--out'] === undefined) {
    throw Object.assign(new Error(`${usage}; unsupported codec/scope pair`), { exitCode: 2 })
  }
  return { out: resolve(options['--out']), profile }
}

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const normalized = path => resolve(path).replaceAll('\\', '/').toLowerCase()
const inputs = profile =>
  [
    ...profile.tests.map(test => test.path),
    ...profile.inputs,
    'test/vitest.config.mjs',
    'scripts/check-port-surfaces.mjs',
    'package.json',
  ].map(path => ({ path, sha256: sha256(resolve(cwd, path)) }))

function checkedTests(report, profile) {
  const expectedTotal = profile.tests.reduce((total, test) => total + test.count, 0)
  if (
    report.success !== true ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== profile.tests.length
  ) {
    throw new Error(
      `Expected a successful JSON report containing exactly ${profile.tests.length} scoped test files`,
    )
  }
  const cases = []
  for (const test of profile.tests) {
    const path = test.path
    const matches = report.testResults.filter(
      result => normalized(result.name) === normalized(resolve(cwd, path)),
    )
    if (matches.length !== 1) throw new Error(`Test discovery did not select ${path} exactly once`)
    const result = matches[0]
    if (result.status !== 'passed' || result.assertionResults?.length !== test.count) {
      throw new Error(`${path} must execute all ${test.count} existing scoped tests`)
    }
    for (const assertion of result.assertionResults) {
      if (assertion.status !== 'passed')
        throw new Error(`${path}: ${assertion.title} is ${assertion.status}`)
      cases.push({
        id: `${path}::${assertion.title}`,
        file: path,
        title: assertion.title,
        status: assertion.status,
      })
    }
  }
  if (
    cases.length !== expectedTotal ||
    report.numTotalTests !== expectedTotal ||
    report.numPassedTests !== expectedTotal ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    (report.numPendingTestSuites ?? 0) !== 0 ||
    (report.numFailedTestSuites ?? 0) !== 0
  ) {
    throw new Error(
      `Scoped surfaces require ${expectedTotal} passed tests and zero failed, pending, skipped or todo tests`,
    )
  }
  return cases
}

function claimsFrom(cases, profile) {
  const proof = (id, title, extra = {}) => {
    const matches = cases.filter(item => item.title === title)
    if (matches.length !== 1) throw new Error(`Missing unique successful test for ${id}`)
    return { id, state: 'passed', successfulCaseIds: [matches[0].id], ...extra }
  }
  if (profile.codec === 'galaxy') {
    const manifest = 'publishes a valid partial manifest with the executable operation table'
    const projection =
      'projects exact parser/checker symbols through text, tree and byte-range sources'
    const operations =
      'executes symbols, references, completion, format, validation, raw and EngineProgram export'
    const edit =
      'returns a revision-pinned whole-source rename plan without changing other text'
    const activation =
      'activates the compiled partial contribution through the minimal installed host'
    const host =
      'routes, validates, commits a resolved writer no-op and reopens byte-identically'
    const contributionId = profile.codecId
    return [
      ...[
        ['text', 'common.view/text-data-source'],
        ['tree', 'common.view/tree-data-source'],
        ['byte-range', 'common.view/byte-range-source'],
      ].map(([name, contract]) => proof(`data-source.${name}`, projection, { contract })),
      proof('operation.view.inspect', projection, {
        contributionId,
        legacyOperationId: 'view.inspect',
        nativeOperationId: 'view.inspect',
        nativeHandlerId: 'inspect',
      }),
      ...[
        ['script.symbols', 'script.symbols', 'symbols'],
        ['script.references', 'script.references', 'references'],
        ['script.completion', 'script.completion', 'completion'],
        ['script.format', 'script.format', 'format'],
        ['asset.validate', 'asset.validate', 'validate'],
        ['export.convert', 'export.convert', 'export-convert'],
        ['galaxy.to-engine', 'blizzard/galaxy.to-engine', 'to-engine'],
        ['export.raw', 'export.raw', 'export-raw'],
      ].map(([legacyOperationId, nativeOperationId, nativeHandlerId]) =>
        proof(`operation.${legacyOperationId}`, operations, {
          contributionId,
          legacyOperationId,
          nativeOperationId,
          nativeHandlerId,
        }),
      ),
      proof('operation.edit.structure', edit, {
        contributionId,
        legacyOperationId: 'edit.structure',
        nativeOperationId: 'edit.structure',
        nativeHandlerId: 'rename',
      }),
      proof('manifest.native-operation-declarations', manifest),
      proof('host.minimal-activation', activation),
      proof('host.route-operation-writer-no-op-reopen', host),
      proof('writer.galaxy-no-op-commit-reopen', host, {
        contributionId: 'blizzard/sc2-authored-text-writers',
        contract: 'common.edit/writer',
      }),
    ]
  }
  if (profile.codec === 'm3') {
    const contributionId = profile.codecId
    return [
      proof(
        'operation.model.write',
        'publishes bounded JSON model authoring through the ordinary codec session',
        {
          contributionId,
          legacyOperationId: 'model.write',
          nativeOperationId: 'blizzard/m3.model.write',
          nativeHandlerId: 'model-write',
        },
      ),
      proof(
        'host.edit-commit-reopen-undo',
        'opens, proposes, deterministically plans, atomically commits, reopens and undoes',
      ),
      proof(
        'encoder.semantic-authoring',
        'ports the complete legacy semantic encoder without a Modkit runtime dependency',
      ),
      proof(
        'encoder.semantic-family-closure',
        'retains the legacy scene, effects, collision and physics authoring families',
      ),
      proof(
        'writer.preservation',
        'is deterministic, byte-identical for no-op, and reopens scale/sequence/texture edits',
        {
          contributionId: 'blizzard/m3-preserving-writer',
          contract: 'common.edit/writer',
        },
      ),
      proof(
        'writer.m3a-preservation',
        'preserves all original M3A sections and reopens a sequence rename',
      ),
      proof(
        'writer.fail-closed',
        'retains the old preserving API and fails closed on bounds, paths and cancellation',
      ),
      proof(
        'attachment.identity',
        'pins stable attachment identity and exact native source names',
      ),
      proof(
        'attachment.identity-multiplicity',
        'does not overwrite or coalesce multiple attachment identities sharing one bone',
      ),
      proof(
        'sidecar.resource-session',
        'exercises algorithmic E1 binding only through ResourceSessionPort',
      ),
      proof(
        'sidecar.discovery-admission',
        'admits fully discovered candidates through revision and compatibility gates',
      ),
      proof(
        'sidecar.refusal',
        'does not open resources after refused or empty discovery',
      ),
      proof(
        'sidecar.diagnostics',
        'names missing, wrong-hash and stale sidecars without attaching them',
      ),
      proof(
        'sidecar.bounds-cancellation',
        'fails closed on cancellation and names byte-budget exhaustion',
      ),
    ]
  }
  if (profile.codec === 'sc2-data') {
    const manifest =
      'publishes valid codec and subject-kind manifests with the executable operation table'
    const projection =
      'projects catalog metadata, text, table, tree and per-document operation state'
    const reads =
      'invokes inspect, query, inheritance, references, validation and byte-exact export handlers'
    const edit = 'adapts an entity rename to a semantic MK3 edit plan over the selected source'
    const activation =
      'activates the published GameData contribution through the minimal native host'
    const host = 'opens through routing, executes search, commits a resolved writer no-op and reopens'
    const contributionId = profile.codecId
    return [
      ...[
        ['text', 'common.view/text-data-source'],
        ['table', 'common.view/table-data-source'],
        ['tree', 'common.view/tree-data-source'],
        ['byte-range', 'common.view/byte-range-source'],
      ].map(([name, contract]) => proof(`data-source.${name}`, projection, { contract })),
      ...[
        ['view.inspect', 'inspect'],
        ['asset.search', 'search'],
        ['sc2-data.resolve-inheritance', 'resolve-inheritance'],
        ['sc2-data.references', 'references'],
        ['asset.validate', 'validate'],
        ['export.convert', 'export-catalog'],
      ].map(([legacyOperationId, nativeHandlerId]) =>
        proof(`operation.${legacyOperationId}`, reads, {
          contributionId,
          legacyOperationId,
          nativeHandlerId,
          nativeOperationId:
            legacyOperationId.startsWith('sc2-data.')
              ? `blizzard/${legacyOperationId}`
              : legacyOperationId,
        }),
      ),
      proof('operation.edit.content', edit, {
        contributionId,
        legacyOperationId: 'edit.content',
        nativeOperationId: 'edit.content',
        nativeHandlerId: 'rename-entity',
      }),
      proof('manifest.native-operation-declarations', manifest),
      proof('host.minimal-activation', activation),
      proof('host.route-operation-writer-commit-reopen', host),
      proof('writer.sc2-data-no-op-commit-reopen', host, {
        contributionId: 'blizzard/sc2-authored-text-writers',
        contract: 'common.edit/writer',
      }),
    ]
  }
  if (profile.codec === 'sc2-layout') {
    const manifest =
      'publishes valid partial manifests with the complete executable operation table'
    const mapping = 'maps every admitted legacy and M5 operation to one native handler'
    const projection = 'projects metadata plus text, bytes, table and tree data sources'
    const reads =
      'executes every read handler across parse, schema, resolve, render, language and export'
    const edit =
      'adapts the pinned raw-preserving catalog-reference rename to an MK3 edit plan'
    const activation =
      'activates the compiled partial contribution through the minimal native host'
    const noOp =
      'opens, commits a byte-identical writer no-op and reopens through host routing'
    const changed =
      'edits a complete snapshot, saves it atomically and reopens the changed layout'
    const contributionId = profile.codecId
    return [
      ...[
        ['text', 'common.view/text-data-source'],
        ['table', 'common.view/table-data-source'],
        ['tree', 'common.view/tree-data-source'],
        ['byte-range', 'common.view/byte-range-source'],
      ].map(([name, contract]) => proof(`data-source.${name}`, projection, { contract })),
      ...[
        ['sc2-layout.parse', 'blizzard/sc2-layout.parse', 'parse'],
        ['sc2-layout.resolve', 'blizzard/sc2-layout.resolve', 'resolve'],
        ['selector.resolve', 'blizzard/sc2-layout.selector-resolve', 'selector-resolve'],
        ['view.render', 'view.render', 'render-structural'],
        ['sc2-layout.render-visual', 'blizzard/sc2-layout.render-visual', 'render-visual'],
        ['view.inspect', 'view.inspect', 'inspect'],
        ['asset.validate', 'asset.validate', 'validate'],
        [
          'sc2-layout.language-features',
          'blizzard/sc2-layout.language-features',
          'language-features',
        ],
        ['export.convert', 'export.convert', 'export-html'],
        ['export.raw', 'export.raw', 'export-raw'],
        ['view.template', 'view.template', 'game-template-preview'],
        [
          'blizzard/sc2-layout.preview',
          'blizzard/sc2-layout.preview',
          'layout-preview',
        ],
        [
          'blizzard/sc2-layout.tech-tree',
          'blizzard/sc2-layout.tech-tree',
          'tech-tree-preview',
        ],
      ].map(([legacyOperationId, nativeOperationId, nativeHandlerId]) =>
        proof(`operation.${legacyOperationId}`, reads, {
          contributionId,
          legacyOperationId,
          nativeOperationId,
          nativeHandlerId,
        }),
      ),
      proof('operation.edit.structure', edit, {
        contributionId,
        legacyOperationId: 'edit.structure',
        nativeOperationId: 'edit.content',
        nativeHandlerId: 'rename-reference',
      }),
      proof('operation-map.one-to-one', mapping),
      proof('manifest.native-operation-declarations', manifest),
      proof('host.minimal-activation', activation),
      proof('writer.sc2-layout-no-op-commit-reopen', noOp, {
        contributionId: 'blizzard/sc2-authored-text-writers',
        contract: 'common.edit/writer',
      }),
      proof('host.route-operation-edit-commit-reopen', changed),
    ]
  }
  if (profile.codec === 'sc2-document-metadata') {
    const native =
      'uses the authoritative three-format parser, type tags and marker validation'
    const manifest =
      'publishes valid codec and subject-kind manifests with the executable operation table'
    const edit =
      'serializes and revision-pins ordered dependency edits, then structurally reopens the output'
    const activation = 'activates the compiled contribution through the minimal native host'
    const host = 'routes, validates, commits dependency replacement and no-op, then reopens'
    const contributionId = profile.codecId
    return [
      ...[
        ['tree', 'common.view/tree-data-source'],
        ['byte-range', 'common.view/byte-range-source'],
      ].map(([name, contract]) => proof(`data-source.${name}`, native, { contract })),
      ...[
        ['view.inspect', 'inspect', native],
        ['asset.validate', 'validate', native],
        ['export.raw', 'export-raw', native],
        ['export.convert', 'export-convert', native],
        ['edit.content', 'replace-dependencies', edit],
      ].map(([legacyOperationId, nativeHandlerId, title]) =>
        proof(`operation.${legacyOperationId}`, title, {
          contributionId,
          legacyOperationId,
          nativeOperationId: legacyOperationId,
          nativeHandlerId,
        }),
      ),
      proof('manifest.native-operation-declarations', manifest),
      proof('host.minimal-activation', activation),
      proof('host.route-operation-edit-commit-reopen', host),
      proof('editor.document-metadata-no-op-commit-reopen', host, {
        contributionId,
        contract: 'common.edit/transactional-edit',
      }),
    ]
  }
  if (profile.codec === 'sc2-strings') {
    const native =
      'uses canonical lossless model, exposes data sources, and executes every M5 operation'
    const manifest = 'publishes the compiled partial contribution with every executable operation'
    const activation = 'activates the compiled contribution through the installed minimal host'
    const changed = 'routes and commits the lossless changed edit'
    const noOp = 'commits a byte-identical no-op through the resolved writer'
    const reopen = 'reopens the source after the no-op writer commit'
    const contributionId = profile.codecId
    return [
      ...[
        ['text', 'common.view/text-data-source'],
        ['table', 'common.view/table-data-source'],
        ['tree', 'common.view/tree-data-source'],
        ['byte-range', 'common.view/byte-range-source'],
      ].map(([name, contract]) => proof(`data-source.${name}`, native, { contract })),
      ...[
        ['view.inspect', 'view.inspect', 'inspect'],
        ['asset.validate', 'asset.validate', 'validate'],
        ['export.raw', 'export.raw', 'export-raw'],
        ['export.convert', 'export.convert', 'export-convert'],
        ['edit.content', 'edit.content', 'edit-strings'],
        ['sc2-strings.references', 'blizzard/sc2-strings.references', 'references'],
        ['sc2-strings.resolve-fallback', 'blizzard/sc2-strings.resolve-fallback', 'resolve-fallback'],
        ['asset.compare', 'asset.compare', 'compare-locales'],
      ].map(([legacyOperationId, nativeOperationId, nativeHandlerId]) =>
        proof(`operation.${legacyOperationId}`, native, {
          contributionId,
          legacyOperationId,
          nativeOperationId,
          nativeHandlerId,
        }),
      ),
      proof('manifest.native-operation-declarations', manifest),
      proof('host.minimal-activation', activation),
      proof('host.route-operation-edit-commit', changed),
      proof('writer.sc2-strings-no-op-commit', noOp, {
        contributionId: 'blizzard/sc2-authored-text-writers',
        contract: 'common.edit/writer',
      }),
      proof('host.reopen-after-no-op', reopen),
    ]
  }
  if (profile.codec === 'sc2-triggers') {
    const manifest = 'publishes a validated compiled manifest with every executable operation'
    const sources = 'leases real text, tree and byte-range sources from the exact source index'
    const operations =
      'executes source-index, validation, search, conversion, edit and data-only Engine AST operations'
    const activation = 'activates the compiled contribution through the installed minimal host'
    const changed = 'commits the revision-pinned changed edit and reopens its semantic value'
    const noOp = 'commits a byte-identical no-op and reopens with identical bytes'
    const contributionId = profile.codecId
    return [
      ...[
        ['text', 'common.view/text-data-source'],
        ['tree', 'common.view/tree-data-source'],
        ['byte-range', 'common.view/byte-range-source'],
      ].map(([name, contract]) => proof(`data-source.${name}`, sources, { contract })),
      proof('operation.view.inspect', sources, {
        contributionId,
        legacyOperationId: 'view.inspect',
        nativeOperationId: 'view.inspect',
        nativeHandlerId: 'inspect',
      }),
      ...[
        ['script.symbols', 'script.symbols', 'symbols'],
        ['script.references', 'script.references', 'references'],
        ['asset.validate', 'asset.validate', 'validate'],
        ['asset.search', 'asset.search', 'search'],
        ['asset.compare', 'asset.compare', 'compare'],
        ['edit.content', 'edit.content', 'rename-gamelinks'],
        ['export.convert', 'export.convert', 'export-convert'],
        ['sc2-triggers.to-engine', 'blizzard/sc2-triggers.to-engine', 'to-engine'],
        ['export.raw', 'export.raw', 'export-raw'],
        [
          'sc2-triggers.trigger-to-galaxy',
          'blizzard/sc2-triggers.trigger-to-galaxy',
          'trigger-to-galaxy',
        ],
        [
          'sc2-triggers.galaxy-to-triggers',
          'blizzard/sc2-triggers.galaxy-to-triggers',
          'galaxy-to-triggers',
        ],
      ].map(([legacyOperationId, nativeOperationId, nativeHandlerId]) =>
        proof(`operation.${legacyOperationId}`, operations, {
          contributionId,
          legacyOperationId,
          nativeOperationId,
          nativeHandlerId,
        }),
      ),
      proof('manifest.native-operation-declarations', manifest),
      proof('host.minimal-activation', activation),
      proof('host.route-operation-edit-commit-reopen', changed),
      proof('writer.sc2-triggers-no-op-commit-reopen', noOp, {
        contributionId: 'blizzard/sc2-authored-text-writers',
        contract: 'common.edit/writer',
      }),
    ]
  }
  const inspect =
    'invokes exact legacy inspect/validate products and retains native facts, hierarchy and raw bytes'
  const patch =
    'patches same-type values without touching comments, quotes, CRLF or other keys and preserves no-op bytes'
  const sign =
    'disables signing when identity is missing and enables explicit identity with verify after reopen'
  const host =
    'commits native edit.content through the file backend, then commits a resolved writer no-op and reopens both'
  const contributionId = 'blizzard/sc2-bank'
  return [
    proof('data-source.subject-facts', inspect, { contract: 'common.view/subject-facts-source' }),
    ...[
      ['view.inspect', 'inspect', inspect],
      ['asset.validate', 'validate', inspect],
      ['export.raw', 'export-raw', inspect],
      ['edit.content', 'patch-value', patch],
      ['source.save-as', 'save-as', patch],
      ['save.sign', 'sign', sign],
    ].map(([legacyOperationId, nativeHandlerId, title]) =>
      proof(`operation.${legacyOperationId}`, title, {
        contributionId,
        legacyOperationId,
        nativeHandlerId,
        nativeOperationId:
          legacyOperationId === 'save.sign' ? 'blizzard/sc2-bank.sign' : legacyOperationId,
      }),
    ),
    proof('operation.verify', sign, {
      contributionId,
      nativeOperationId: 'blizzard/sc2-bank.verify',
      nativeHandlerId: 'verify',
    }),
    proof('host.edit-commit-reopen', host),
    proof('writer.unsigned-no-op-commit-reopen', host, {
      contributionId: 'blizzard/sc2-authored-text-writers',
      contract: 'common.edit/writer',
    }),
    proof(
      'manifest.native-operation-declarations',
      'publishes the actual native operation mapping and validates both manifests',
    ),
    proof(
      'host.minimal-activation',
      'activates the published bank contribution through the minimal native host',
    ),
  ]
}

function run({ out, profile }) {
  const testFiles = profile.tests.map(test => test.path)
  const expectedTotal = profile.tests.reduce((total, test) => total + test.count, 0)
  mkdirSync(out, { recursive: true })
  const runId = randomUUID()
  const reportPath = resolve(out, `vitest-${runId}.json`)
  const receiptPath = resolve(out, 'receipt.json')
  const command = [
    process.execPath,
    resolve(cwd, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    './test/vitest.config.mjs',
    ...testFiles,
    // Surface receipts combine host activation, writes and reopen checks from several files.
    // Running those files in parallel lets independent host instances race while scanning the
    // same extension root; the fallback text codec can win before the requested contribution is
    // activated. A receipt is a deterministic conformance proof, so execute its bounded file set
    // serially while individual tests inside each file keep Vitest's normal ordering.
    '--fileParallelism=false',
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ]
  const receipt = {
    schemaVersion: 1,
    stage: 'scoped-surfaces',
    codec: profile.codec,
    codecId: profile.codecId,
    scope: profile.scope,
    verdict: 'running',
    runId,
    startedAt: new Date().toISOString(),
    cwd,
    command: [
      process.execPath,
      resolve(cwd, 'scripts/check-port-surfaces.mjs'),
      '--codec',
      profile.codec,
      '--scope',
      profile.scope,
      '--out',
      out,
    ],
    testCommand: command,
    testEnvironment: { MODKIT_TEST_TIER: 'quick' },
    reportPath,
    inputs: inputs(profile),
    claims: [],
    full: false,
    pending: [
      {
        scope: 'full',
        milestone: 'M7/M8',
        requirements: Array.from({ length: 15 }, (_, index) => `S${index + 1}`),
        reason: `This ${profile.scope.toUpperCase()} receipt proves only the listed executable scoped claims; full S1-S15 surface acceptance remains pending.`,
      },
    ],
    ledgerApplied: false,
  }
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  save()
  try {
    const execution = spawnSync(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, MODKIT_TEST_TIER: 'quick' },
      stdio: 'inherit',
    })
    receipt.exitCode = execution.status ?? 1
    if (execution.error !== undefined) throw execution.error
    if (execution.status !== 0)
      throw new Error(`Scoped test runner exited ${execution.status ?? execution.signal}`)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const cases = checkedTests(report, profile)
    if (JSON.stringify(inputs(profile)) !== JSON.stringify(receipt.inputs))
      throw new Error('Scoped inputs changed during test execution')
    receipt.counts = {
      filesDiscovered: testFiles.length,
      filesExecuted: testFiles.length,
      testsDiscovered: expectedTotal,
      testsExecuted: expectedTotal,
      passed: expectedTotal,
      failed: 0,
      pending: 0,
      skipped: 0,
      todo: 0,
    }
    receipt.tests = cases
    receipt.claims = claimsFrom(cases, profile)
    receipt.reportSha256 = sha256(reportPath)
    receipt.verdict = 'pass'
    receipt.completedAt = new Date().toISOString()
    save()
    console.log(
      `surfaces:check ${profile.codec} ${profile.scope}: pass (${testFiles.length} files, ${expectedTotal} tests); full S1-S15 pending; receipt ${receiptPath}`,
    )
  } catch (error) {
    receipt.verdict = 'fail'
    receipt.exitCode = receipt.exitCode || 1
    receipt.claims = []
    receipt.error = error instanceof Error ? error.message : String(error)
    receipt.completedAt = new Date().toISOString()
    save()
    throw error
  }
}

try {
  run(optionsFrom(process.argv.slice(2)))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = error?.exitCode ?? 1
}
