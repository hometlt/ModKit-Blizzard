import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'

import { configPath, getActiveBuild, parseBuildInfo, parseConfig } from '../src/casc/config.js'
import { CascReader } from '../src/casc/reader.js'

const MAX_ACCEPTANCE_INPUT_BYTES = 536_870_912n
const budget = Object.freeze({
  maxInputBytes: MAX_ACCEPTANCE_INPUT_BYTES,
  maxDepth: 128,
  maxNodes: 750_000,
  maxScalarBytes: 134_217_728,
  maxDiagnostics: 1_000,
})
const markerPaths = Object.freeze([
  ['.build.info', 'file'],
  ['SC2Data/config', 'directory'],
  ['SC2Data/data', 'directory'],
  ['SC2Data/indices', 'directory'],
])

function usage() {
  return 'Usage: node casc/test/run-installation-acceptance.mjs --root <SC2 installation root>\n' +
    '   or: MODKITX_SC2_ROOT=<SC2 installation root> node casc/test/run-installation-acceptance.mjs'
}

function rootFromArgs(argv, environment) {
  let root
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--root') throw new Error(`Unknown argument: ${argument}\n${usage()}`)
    if (root !== undefined || index + 1 >= argv.length) throw new Error(`Invalid --root argument\n${usage()}`)
    root = argv[index + 1]
    index += 1
  }
  const selected = root ?? environment.MODKITX_SC2_ROOT
  if (typeof selected !== 'string' || selected.trim() === '') {
    throw new Error(`A non-empty installation root is required\n${usage()}`)
  }
  return resolve(selected.trim())
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function portable(path) {
  return path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
}

function fileSource(root) {
  const rooted = relativePath => {
    const normalized = portable(relativePath)
    if (!normalized || normalized.includes('\0') || normalized.split('/').some(part => part === '..')) {
      throw new Error(`Invalid CASC source path: ${String(relativePath)}`)
    }
    const candidate = resolve(root, ...normalized.split('/'))
    const relation = relative(root, candidate)
    if (relation === '..' || relation.startsWith(`..${sep}`)) {
      throw new Error(`CASC source path escapes installation root: ${String(relativePath)}`)
    }
    return candidate
  }
  return Object.freeze({
    async list(path) {
      return (await readdir(rooted(path), { withFileTypes: true }))
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort()
    },
    async get(path) {
      return new Uint8Array(await readFile(rooted(path)))
    },
    async getRange(path, offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
        throw new Error(`Invalid CASC source range for ${path}`)
      }
      const bytes = await readFile(rooted(path))
      if (offset > bytes.byteLength || length > bytes.byteLength - offset) {
        throw new Error(`CASC source range is outside ${path}`)
      }
      return new Uint8Array(bytes.subarray(offset, offset + length))
    },
    async exists(path) {
      try {
        await lstat(rooted(path))
        return true
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') return false
        throw error
      }
    },
  })
}

async function requireMarkers(root) {
  const observed = []
  for (const [path, expectedKind] of markerPaths) {
    const state = await lstat(resolve(root, ...path.split('/')))
    const actualKind = state.isDirectory() ? 'directory' : state.isFile() ? 'file' : 'other'
    if (actualKind !== expectedKind) {
      throw new Error(`Required CASC marker ${path} is ${actualKind}, expected ${expectedKind}`)
    }
    observed.push(Object.freeze({ path, kind: actualKind }))
  }
  return Object.freeze(observed)
}

async function directCascEvidence(root, buildInfoBytes) {
  const source = fileSource(root)
  const activeBuild = getActiveBuild(parseBuildInfo(new TextDecoder().decode(buildInfoBytes)))
  const dataRoot = 'SC2Data'
  const buildConfigPath = configPath(dataRoot, activeBuild.buildKey)
  const buildConfigBytes = await source.get(buildConfigPath)
  const config = parseConfig(new TextDecoder().decode(buildConfigBytes))
  const rootPair = config.getKeyPair('root')
  if (rootPair === undefined) throw new Error('SC2 build config has no root key pair')

  const reader = await CascReader.open(source)
  const rootEncodingKey = reader.encoding.getEncodingKey(rootPair.contentKey) ?? rootPair.encodingKey
  const decodedRootBytes = await reader.storage.readEncodingKey(rootEncodingKey)
  let remoteRefusal
  try {
    await reader.storage.readEncodingKey('00000000000000000000000000000000')
    throw new Error('The reserved remote encoding key unexpectedly resolved locally')
  } catch (error) {
    if (error?.code !== 'x3.casc/encoding-key-not-local') throw error
    remoteRefusal = error.code
  }
  return Object.freeze({
    activeBuild: Object.freeze({
      branch: activeBuild.branch,
      product: activeBuild.product,
      version: activeBuild.version,
      buildKey: activeBuild.buildKey,
    }),
    buildInfo: Object.freeze({ path: '.build.info', digest: sha256(buildInfoBytes) }),
    buildConfig: Object.freeze({ path: buildConfigPath, digest: sha256(buildConfigBytes) }),
    root: Object.freeze({
      contentKey: rootPair.contentKey,
      encodingKey: rootEncodingKey,
      decodedDigest: sha256(decodedRootBytes),
      entries: reader.entryIndex.size,
      format: 'mndx',
    }),
    remoteEncodingKeyRefusal: remoteRefusal,
  })
}

async function hostEvidence(root) {
  const cascRoot = resolve(dirname(import.meta.dirname))
  const extension = await loadExtensionDirectory(cascRoot)
  const inventory = await buildInventory(
    [{ ...extension, execution: { origin: 'bundled', allowTrustedInProcess: true } }],
    createHostContributionContractRegistry(),
  )
  const executionBackends = createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND])
  const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
  const mount = await vfs.openMount(pathToFileURL(root).href)
  const opened = await openSubject({
    inventory,
    source: artifactNamespaceSourceFromVfsMount(mount),
    path: 'StarCraft II',
    intent: 'full',
    target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
    grant: { id: 'casc-m4-installation-acceptance', classes: ['read-source'] },
    executionBackends,
    budget,
  })
  if (opened.state !== 'opened') throw new Error(`CASC host open failed: ${opened.reason}`)
  if (opened.selected.contributionId !== 'blizzard/casc') {
    await opened.session.dispose()
    throw new Error(`Expected blizzard/casc, opened ${opened.selected.contributionId}`)
  }

  let namespaceReleased = false
  let sessionDisposed = false
  let namespaceLease
  let evidence
  try {
    const descriptor = await opened.session.descriptor()
    if (descriptor.identity.formatId !== 'casc') throw new Error('CASC descriptor formatId is not casc')
    const inspected = await opened.session.operations().invoke('inspect', {})
    if (inspected.state !== 'ok' || inspected.output.kind !== 'json') {
      throw new Error('CASC inspect did not return JSON')
    }
    if (inspected.output.value.rootFormat !== 'mndx') {
      throw new Error(
        `CASC inspect did not prove an MNDX root: ${JSON.stringify(inspected.output.value)}`,
      )
    }

    namespaceLease = await opened.session.dataSource('common.view/namespace-entry-source', 1)
    const namespace = namespaceLease.value
    if (typeof namespace.children !== 'function') {
      throw new Error('CASC namespace does not publish hierarchical children')
    }
    const rootChildren = await namespace.children('', { limit: 16 })
    const rootNames = rootChildren.items.map(item => item.name.toLowerCase())
    if (!rootNames.includes('mods') || !rootNames.includes('campaigns')) {
      throw new Error(`CASC root is missing Mods or Campaigns: ${rootNames.join(', ')}`)
    }
    const modsChildren = await namespace.children('Mods', { limit: 64 })
    if (!modsChildren.items.some(item => item.name.toLowerCase().endsWith('.sc2mod'))) {
      throw new Error('CASC Mods contains no SC2Mod directories')
    }
    const listed = await namespace.list('mods/', { limit: 5 })
    if (listed.items.length === 0) throw new Error('Bounded CASC mods/ listing is empty')
    const searched = await namespace.search(
      { kind: 'basename-any', basenames: ['unitdata.xml', 'mapinfo'], caseSensitive: false },
      { limit: 2 },
    )
    if (searched.items.length === 0) throw new Error('Bounded CASC basename search found no SC2 samples')
    const extractedEntry = searched.items[0]
    const extracted = await opened.session.operations().invoke('extract-entry', {
      entryId: extractedEntry.id,
    })
    if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes' || extracted.output.value.byteLength === 0) {
      throw new Error(`CASC extraction failed for ${extractedEntry.path}`)
    }
    evidence = Object.freeze({
      contributionId: opened.selected.contributionId,
      descriptorFormatId: descriptor.identity.formatId,
      inspect: Object.freeze({
        entries: inspected.output.value.entries,
        rootContentKey: inspected.output.value.rootContentKey,
        rootFormat: inspected.output.value.rootFormat,
      }),
      children: Object.freeze({
        root: Object.freeze(rootChildren.items.map(item => item.name)),
        mods: Object.freeze(modsChildren.items.map(item => item.name)),
      }),
      list: Object.freeze({
        prefix: 'mods/',
        limit: 5,
        items: Object.freeze(listed.items.map(item => Object.freeze({ path: item.path, size: String(item.size) }))),
        hasNextCursor: listed.nextCursor !== undefined,
      }),
      search: Object.freeze({
        kind: 'basename-any',
        basenames: Object.freeze(['unitdata.xml', 'mapinfo']),
        limit: 2,
        items: Object.freeze(searched.items.map(item => Object.freeze({ path: item.path, size: String(item.size) }))),
        hasNextCursor: searched.nextCursor !== undefined,
      }),
      extract: Object.freeze({
        entryId: extractedEntry.id,
        path: extractedEntry.path,
        bytes: extracted.output.value.byteLength,
        digest: sha256(extracted.output.value),
      }),
    })
  } finally {
    if (namespaceLease !== undefined) {
      await namespaceLease.release()
      namespaceReleased = true
    }
    await opened.session.dispose()
    sessionDisposed = true
    if (!sessionDisposed || (namespaceLease !== undefined && !namespaceReleased)) {
      throw new Error('CASC acceptance lifecycle did not complete')
    }
  }
  return Object.freeze({
    ...evidence,
    lifecycle: Object.freeze({
      namespaceLeaseReleased: namespaceReleased,
      sessionDisposed,
    }),
  })
}

async function main() {
  const root = rootFromArgs(process.argv.slice(2), process.env)
  const rootState = await lstat(root)
  if (!rootState.isDirectory()) throw new Error(`CASC installation root is not a directory: ${root}`)
  const markers = await requireMarkers(root)
  const buildInfoBytes = new Uint8Array(await readFile(resolve(root, '.build.info')))
  const direct = await directCascEvidence(root, buildInfoBytes)
  const host = await hostEvidence(root)
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'blizzard-casc-m4-installation-acceptance-v1',
        installationRoot: root,
        markers,
        ...direct,
        host,
      },
      null,
      2,
    )}\n`,
  )
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
