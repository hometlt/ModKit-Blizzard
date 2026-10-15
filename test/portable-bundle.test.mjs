import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { portableBundleBytes, traceDependencies } from '../scripts/produce-portable-bundle.mjs'

const repository = JSON.parse(
  readFileSync(new URL('../modkit.repository.json', import.meta.url), 'utf8'),
)
const expectedIds = repository.extensions.map(entry => entry.id)
const requiredLicenses = [
  'licenses/GALAXY-LANGUAGE-NOTICE.md',
  'licenses/GPL-2.0-only.txt',
  'licenses/MIT.txt',
  'licenses/THIRD-PARTY-NOTICES.md',
]
const producer = fileURLToPath(new URL('../scripts/produce-portable-bundle.mjs', import.meta.url))

function bundle(bytes) {
  return JSON.parse(bytes.toString('utf8'))
}

function manifest(files, path) {
  const value = files[path]
  assert.equal(typeof value, 'string', `missing ${path}`)
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
}

/** Contribution globs cover one directory; Node package-export stars can include nested slashes. */
function filesMatchingManifestPattern(files, pattern, packageExport = false) {
  const normalized = pattern.replace(/^\.\//u, '')
  const expression = normalized
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join(packageExport ? '.*' : '[^/]+')
  const matcher = new RegExp(`^${expression}$`, 'u')
  return Object.keys(files).filter(path => matcher.test(path))
}

/** Runtime export conditions must name shipped code; declarations remain developer-only inputs. */
function runtimeExportTargets(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(runtimeExportTargets)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([condition, target]) =>
    condition === 'types' ? [] : runtimeExportTargets(target),
  )
}

test('package export patterns admit nested addons without widening contribution globs', () => {
  const files = { 'examples/jsm/controls/OrbitControls.js': '', 'examples/jsm/Addons.js': '' }
  assert.deepEqual(filesMatchingManifestPattern(files, './examples/jsm/*'), ['examples/jsm/Addons.js'])
  assert.deepEqual(filesMatchingManifestPattern(files, './examples/jsm/*', true), Object.keys(files))
})

test('traced dependency metadata keeps shipped ESM, CommonJS and nested addon entrypoints', () => {
  const prefix = 'node_modules/three/'
  const native = {
    name: 'three', version: '1.2.3', type: 'module', license: 'MIT',
    main: './build/three.cjs', module: './build/unused.js', types: './types/index.d.ts',
    exports: {
      '.': { import: './build/three.module.js', require: './build/three.cjs' },
      './addons': './examples/jsm/Addons.js',
      './addons/*': './examples/jsm/*',
      './absent/*': './absent/*',
      './conditional': { browser: './missing.js', default: './src/value.js' },
      './fallback': ['./missing.js', './src/value.js'],
      './package.json': './package.json',
      './blocked': null,
    },
  }
  const cjs = Buffer.from('exports.value = 7;\n')
  const files = new Map([
    ['dist/index.js', Buffer.from("import 'three'; import 'three/addons/controls/OrbitControls.js';")],
    [`${prefix}package.json`, Buffer.from(JSON.stringify(native))],
    [`${prefix}LICENSE`, Buffer.from('license bytes')],
    [`${prefix}build/three.module.js`, Buffer.from("export { value } from '../src/value.js';")],
    [`${prefix}build/three.cjs`, cjs],
    [`${prefix}src/value.js`, Buffer.from('export const value = 7;')],
    [`${prefix}examples/jsm/controls/OrbitControls.js`, Buffer.from('export const nested = 9;')],
    [`${prefix}examples/jsm/Addons.js`, Buffer.from('export const unused = true;')],
    [`${prefix}build/unused.js`, Buffer.from('export const unused = true;')],
  ])
  traceDependencies(files, new Map([['three', { manifest: native }]]))
  const packed = JSON.parse(files.get(`${prefix}package.json`).toString('utf8'))
  assert.deepEqual(packed.exports, {
    '.': native.exports['.'], './addons/*': native.exports['./addons/*'],
    './conditional': { default: './src/value.js' }, './fallback': ['./src/value.js'],
    './package.json': './package.json', './blocked': null,
  })
  assert.equal(packed.version, native.version)
  assert.equal(packed.license, native.license)
  assert.equal(packed.main, native.main)
  assert.equal(packed.module, undefined)
  assert.equal(packed.types, undefined)
  assert.equal(files.has(`${prefix}examples/jsm/Addons.js`), false)
  assert.equal(files.has(`${prefix}build/unused.js`), false)
  assert.deepEqual(files.get(`${prefix}build/three.cjs`), cjs)
  assert.equal(files.get(`${prefix}LICENSE`).toString('utf8'), 'license bytes')
  const directory = mkdtempSync(join(tmpdir(), 'modkit-traced-package-'))
  try {
    for (const [path, bytes] of files) {
      const target = join(directory, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    }
    const consumed = spawnSync(process.execPath, ['--input-type=module', '--eval',
      'import assert from "node:assert/strict"; import {createRequire} from "node:module"; import {value} from "three"; import {nested} from "three/addons/controls/OrbitControls.js"; assert.equal(value,7); assert.equal(nested,9); assert.equal(createRequire(import.meta.url)("three").value,7); await assert.rejects(import("three/addons"),{code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});',
    ], { cwd: directory, encoding: 'utf8' })
    assert.equal(consumed.status, 0, `${consumed.stdout}${consumed.stderr}`)
  } finally {
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('portable Blizzard bundle is deterministic, self-contained and covers the repository roots', async () => {
  let first = await portableBundleBytes()
  const firstLength = first.byteLength
  const firstDigest = createHash('sha256').update(first).digest('hex')
  first = undefined
  const second = await portableBundleBytes()
  const digest = createHash('sha256').update(second).digest('hex')
  assert.equal(second.byteLength, firstLength)
  assert.equal(digest, firstDigest)
  assert.match(digest, /^[0-9a-f]{64}$/u)

  const document = bundle(second)
  assert.equal(document.schemaVersion, 1)
  assert.deepEqual(
    document.extensions.map(entry => entry.id),
    expectedIds,
  )
  for (const entry of document.extensions) {
    const files = entry.files
    assert.ok(files !== null && typeof files === 'object' && !Array.isArray(files))
    for (const path of Object.keys(files)) {
      assert.doesNotMatch(path, /^(?:[a-z]:)?[\\/]|(?:^|[\\/])\.\.(?:[\\/]|$)/iu)
      assert.ok(path.split('/').every(Boolean), `uncanonical path ${path}`)
      assert.doesNotMatch(
        path,
        /(?:^|\/)(?:tests?|__tests__|node_modules\/node_modules)(?:\/|$)|\.(?:ts|mts|cts|map|tsbuildinfo)$/u,
      )
    }
    for (const license of requiredLicenses) assert.equal(typeof files[license], 'string', license)
    assert.ok(
      !Object.keys(files).some(path => path.startsWith('vendor/')),
      'runtime dependencies are materialized; development vendor archives must not be duplicated',
    )
    assert.ok(
      !Object.keys(files).some(path => path.startsWith('dist/dist/')),
      'stale nested compiler output must not be shipped',
    )

    const root = manifest(files, 'package.json')
    assert.equal(`${root.modkit.publisher}/${root.modkit.id}`, entry.id)
    const contributionFiles = new Set()
    for (const pattern of root.modkit.contributionManifests ?? []) {
      const matches = filesMatchingManifestPattern(files, pattern)
      for (const path of matches) contributionFiles.add(path)
    }
    assert.ok(contributionFiles.size > 0, `${entry.id} has no contribution manifests`)
    for (const path of contributionFiles) {
      const contribution = JSON.parse(Buffer.from(files[path], 'base64').toString('utf8'))
      for (const variant of contribution.runtimeVariants ?? []) {
        const entrypoint = variant.entrypoint.replace(/^\.\//u, '')
        assert.equal(typeof files[entrypoint], 'string', `${entry.id}: ${path} -> ${entrypoint}`)
      }
    }
    if (typeof root.modkit.contentSources === 'string') {
      const entrypoint = root.modkit.contentSources.replace(/^\.\//u, '')
      assert.equal(typeof files[entrypoint], 'string', `${entry.id}: contentSources -> ${entrypoint}`)
    }

    for (const path of Object.keys(files).filter(
      path => path === 'package.json' || path.endsWith('/package.json'),
    )) {
      const packageManifest = manifest(files, path)
      const directory = path.slice(0, -'package.json'.length)
      for (const target of runtimeExportTargets(packageManifest.exports)) {
        assert.ok(target.startsWith('./'), `${path} has non-local export ${target}`)
        assert.ok(
          filesMatchingManifestPattern(files, `${directory}${target.slice(2)}`, true).length > 0,
          `${entry.id}: ${path} declares missing runtime export ${target}`,
        )
      }
      assert.doesNotMatch(
        JSON.stringify(packageManifest),
        /(?:file|link|workspace):|(?:^|[^a-z])[a-z]:[\\/]|\.\.[\\/]/iu,
        `${path} retains a checkout dependency`,
      )
      for (const name of Object.keys({
        ...packageManifest.dependencies,
        ...packageManifest.optionalDependencies,
        ...packageManifest.peerDependencies,
      })) {
        assert.equal(
          typeof files[`node_modules/${name}/package.json`],
          'string',
          `${path} -> ${name}`,
        )
      }
      if (typeof packageManifest.main === 'string') {
        const declared = packageManifest.main.replace(/^\.\//u, '')
        const candidates = [declared, `${declared}.js`, `${declared}.json`, `${declared}/index.js`]
        assert.ok(
          candidates.some(candidate => typeof files[`${directory}${candidate}`] === 'string'),
          `${path} declares missing runtime main ${packageManifest.main}`,
        )
      }
    }
  }
})

test('portable bundle preserves CommonJS dependency exports in a native ESM consumer', async () => {
  const document = bundle(await portableBundleBytes())
  const files = document.extensions.find(entry => entry.id === 'blizzard/starcraft2').files
  const prefix = 'node_modules/jsonc-parser/'
  const directory = mkdtempSync(join(tmpdir(), 'modkit-blizzard-cjs-consumer-'))
  try {
    for (const [path, encoded] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue
      const target = join(directory, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(encoded, 'base64'))
    }
    const consumer = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'import assert from "node:assert/strict"; import { parseTree, printParseErrorCode } from "jsonc-parser"; assert.equal(parseTree("{\\"answer\\":42}").type, "object"); assert.equal(printParseErrorCode(1), "InvalidSymbol");',
      ],
      { cwd: directory, encoding: 'utf8' },
    )
    assert.equal(consumer.status, 0, `${consumer.stdout}${consumer.stderr}`)
    const host = createRequire(new URL('../starcraft2/package.json', import.meta.url)).resolve(
      '@modkit/host/node',
    )
    const canonical = createRequire(host).resolve('jsonc-parser')
    assert.deepEqual(
      Buffer.from(files[`${prefix}lib/umd/main.js`], 'base64'),
      readFileSync(canonical),
      'published dependency entrypoint bytes must remain unchanged',
    )
  } finally {
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('portable-bundle CLI stages atomically and refuses an existing output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'modkit-extensions-blizzard-portable-'))
  const output = join(directory, 'nested', 'bundle.json')
  const stages = () =>
    existsSync(dirname(output))
      ? readdirSync(dirname(output)).filter(name => name.startsWith(`.${basename(output)}.stage-`))
      : []
  try {
    const created = spawnSync(process.execPath, [producer, '--out', output], { encoding: 'utf8' })
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`)
    assert.ok(existsSync(output))
    assert.deepEqual(stages(), [])
    const original = readFileSync(output)

    const refused = spawnSync(process.execPath, [producer, '--out', output], { encoding: 'utf8' })
    assert.notEqual(refused.status, 0)
    assert.match(`${refused.stdout}${refused.stderr}`, /refusing to overwrite existing artifact/u)
    assert.deepEqual(readFileSync(output), original)
    assert.deepEqual(stages(), [])
  } finally {
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('portable-bundle CLI executes through a repository link and protects an existing output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'modkit-blizzard-linked-producer-'))
  const linkedRepository = join(directory, 'repository')
  const output = join(directory, 'existing.json')
  const original = Buffer.from('retained artifact\n')
  try {
    symlinkSync(
      dirname(dirname(producer)),
      linkedRepository,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    writeFileSync(output, original)
    const refused = spawnSync(
      process.execPath,
      [join(linkedRepository, 'scripts', 'produce-portable-bundle.mjs'), '--out', output],
      { encoding: 'utf8' },
    )
    assert.notEqual(
      refused.status,
      0,
      'linked invocation must execute the producer instead of silently succeeding',
    )
    assert.match(`${refused.stdout}${refused.stderr}`, /refusing to overwrite existing artifact/u)
    assert.deepEqual(readFileSync(output), original)
  } finally {
    // Unlink first: fixture cleanup must never recurse into the real repository.
    if (existsSync(linkedRepository)) unlinkSync(linkedRepository)
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()))
    rmSync(directory, { recursive: true, force: true })
  }
})
