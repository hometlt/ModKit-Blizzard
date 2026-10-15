import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { uint64 } from '@modkit/core'
import {
  artifactNamespaceSourceFromVfsMount,
  codecFidelityEvidenceRecords,
  createEvidenceRegistry,
  createHostServiceResolver,
  createSubjectEditing,
  openSubject,
  serviceProviderFidelityEvidenceRecord,
  type ExtensionInput,
} from '@modkit/host'
import {
  createFileEditingBackend,
  createNodeSubjectServices,
  loadExtensionDirectory,
  nodeRuntimeTargetBase,
  nodeWorkerLinks,
  nodeWorkerRealmProfile,
  openFileArtifactSource,
  workerBackendPolicy,
} from '@modkit/host/node'
import { createHostTopology, type PermissionGrant, type Writer } from '@modkit/sdk'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { invokeContainerPack } from '../../../modkit-core/packages/host/dist/index.js'
import {
  revisionId as coreRevisionId,
  type ContainerPackInputV1,
} from '../../../modkit-core/packages/sdk/dist/index.js'
import {
  encodeFreshMpq,
  snapshotFreshMpq,
  snapshotNativePreservingMpq,
} from '../src/mpq/fresh-writer.js'

const extensionRoot = join(import.meta.dirname, '..')
const starcraft2ExtensionRoot = join(import.meta.dirname, '..', '..', 'starcraft2')
const scratch = mkdtempSync(join(tmpdir(), 'x3-native-mpq-'))
const HOST = 'org.example.app/native-mpq-host'
const WORKERS = 'org.example.app/native-mpq-workers'
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 10_000,
  maxScalarBytes: 16_777_216,
  maxDiagnostics: 100,
}
const READ: PermissionGrant = { id: 'native-mpq-read', classes: ['read-source'] }
const WRITE: PermissionGrant = {
  id: 'native-mpq-write',
  classes: ['read-source', 'write-source'],
}
const topology = createHostTopology({
  schemaVersion: 1,
  topologyId: 'org.example.app/native-mpq',
  realms: [
    {
      schemaVersion: 1,
      realmId: HOST,
      revision: '1',
      target: nodeRuntimeTargetBase(),
      facilities: ['filesystem.read-random', 'filesystem.atomic-replace', 'worker.module'],
      budgets: {
        maxConcurrentTasks: 2,
        maxWorkerCount: 1,
        maxResidentBytes: uint64('536870912'),
        maxTransferBytes: uint64('67108864'),
        defaultDeadlineMs: 60_000,
      },
      policy: { id: 'org.example.policy/native-mpq', revision: '1' },
    },
    nodeWorkerRealmProfile({
      realmId: WORKERS,
      budgets: {
        maxConcurrentTasks: 1,
        maxWorkerCount: 0,
        maxResidentBytes: uint64('268435456'),
        maxTransferBytes: uint64('67108864'),
        defaultDeadlineMs: 60_000,
      },
      policy: { id: 'org.example.policy/native-mpq-worker', revision: '1' },
    }),
  ],
  links: [...nodeWorkerLinks(HOST, WORKERS)],
})
const explicitSc2Root = process.env.MODKITX_SC2_ROOT?.trim()
const installedSc2Root = explicitSc2Root || 'C:\\Apps\\StarCraft II'
const installedMapPath = join(installedSc2Root, 'Maps', 'ex', 'WTE70_Madlibrarian.SC2Map')
const EVIDENCE_ID = 'mpq-native-preserving-writer-v1'
const EVIDENCE_CORPUS = 'installed-starcraft-2:Maps/ex/WTE70_Madlibrarian.SC2Map'
const EVIDENCE_DIGEST = 'sha256:f654e212dcff3ffe3e1090e383b7b25fac4def2a723b4eda408c1b5cdfb2a305'
const EVIDENCE_OPTIONS = 'fixed-slot-native-save-as-v1'
const EVIDENCE_INPUT_CLASS = 'mpq-v0-v1-fixed-slot-complete-source-stored-or-single-unit-zlib'
const WTE70_RECEIPT_PATH =
  process.env.MODKITX_WTE70_SAVE_AS_RECEIPT?.trim() ||
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'artifacts',
    'ga-recovery-wave2a',
    'baseline-wte70',
    'wte70-save-as-profile.receipt.json',
  )
const PUBLIC_PACK_RECEIPT_PATH = process.env.MODKIT_M4_MPQ_PUBLIC_PACK_RECEIPT?.trim()
const PUBLIC_PACK_ORACLE_VECTOR = 'mpq-writer-cross-direction'
const PUBLIC_PACK_ORACLE_BINDINGS = {
  named: {
    caseId: 'real:mpq-writer-cross-direction:nonempty:container.pack',
    vectorCase: 'nonempty',
    vectorResultDigest: 'bd57614dfbbb7f8ef472760dbef4280cb0900ee5049321e878e8ad9d993de1d4',
    reopenedPayloadDigest: 'a267c5ab910ff32b0f55235810a47ca49910e4e9c430413467e1f73542c19420',
    materializedArchive: {
      bytes: 543,
      sha256: 'bceeadd4f289d0870f64f2f41decf676ea984b857e1d3c14ed6783c54c003a5e',
    },
  },
  empty: {
    caseId: 'real:mpq-writer-cross-direction:empty:container.pack',
    vectorCase: 'empty',
    vectorResultDigest: 'e86e8739c0f3d5bc86d6e127becb5102fe553b85a76c2c3face7d7871d9ce2c3',
    reopenedPayloadDigest: 'de63fd47f8a56c405a4e4aa1cc1b6dd11d34506e11d653848cbb1241089885b0',
    materializedArchive: {
      bytes: 114,
      sha256: '6091ae8a6da2e3b20bb915b6a6e609f6e4e8c4879405a063ab992fcb2d7e58a2',
    },
  },
} as const

type Wte70PhaseReceipt = {
  readonly name: string
  readonly durationMs: number
  readonly verdict: 'pass' | 'fail'
  readonly error?: string
}

type Wte70SourceReadReceipt = {
  calls: number
  bytes: number
  operations: { kind: 'read' | 'stream'; bytes: number }[]
}

type Wte70SaveAsReceipt = {
  schemaVersion: 1
  kind: 'wte70-native-save-as-profile-v1'
  corpus: {
    id: string
    relativePath: 'Maps/ex/WTE70_Madlibrarian.SC2Map'
    expectedSha256: string
    size?: number
    sha256?: string
  }
  phases: Wte70PhaseReceipt[]
  artifactSourceReads: Record<string, Wte70SourceReadReceipt>
  destination?: {
    archiveName: string
    bytes: number
    sha256: string
  }
  nativeExport?: unknown
  reopened?: {
    semantic?: {
      contributionId: string
      summaryMatchesSource: boolean
      summary: unknown
    }
    codec?: {
      contributionId: string
      extractedEntries: Record<string, { bytes: number; sha256: string; matchesExpected: boolean }>
    }
  }
  sourceUnchanged?: {
    size: number
    sha256: string
    matchesOriginal: boolean
  }
  undo?: {
    removedDestination: boolean
  }
  totalDurationMs?: number
  verdict?: 'pass' | 'fail'
  error?: string
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const linked = async (root = extensionRoot): Promise<ExtensionInput> => ({
  ...(await loadExtensionDirectory(root)),
  execution: { origin: 'linked', allowTrustedInProcess: false },
})

let cachedServices: ReturnType<typeof createNodeSubjectServices> | undefined
const subjectServices = () =>
  (cachedServices ??= (async () =>
    createNodeSubjectServices({
      topology,
      realms: { host: HOST, workers: WORKERS },
      extensions: [await linked()],
      policy: workerBackendPolicy({ loadDeadlineMs: 15_000, defaultCallDeadlineMs: 30_000 }),
    }))())

let cachedSc2Services: ReturnType<typeof createNodeSubjectServices> | undefined
const sc2SubjectServices = () =>
  (cachedSc2Services ??= (async () =>
    createNodeSubjectServices({
      topology,
      realms: { host: HOST, workers: WORKERS },
      extensions: [await linked(), await linked(starcraft2ExtensionRoot)],
      policy: workerBackendPolicy({ loadDeadlineMs: 15_000, defaultCallDeadlineMs: 30_000 }),
    }))())

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const normalizePublicPath = (path: string) =>
  path.replace(/\\/gu, '/').replace(/^\/+/, '').normalize('NFC')

function canonical(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.normalize('NFC')
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return { bytes: value.byteLength, sha256: sha256(value) }
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key.normalize('NFC'), canonical(entry)]),
    )
  }
  return String(value)
}

const canonicalText = (value: unknown) => JSON.stringify(canonical(value))
const canonicalDigest = (value: unknown) =>
  createHash('sha256').update(canonicalText(value)).digest('hex')

function normalizeReopenedUserPayload(entries: Array<{ path: string; bytes: Uint8Array }>) {
  return {
    opened: true,
    internalEntryPolicy: 'exclude-(listfile)',
    namedPayloads: entries
      .filter(entry => normalizePublicPath(entry.path).toLowerCase() !== '(listfile)')
      .map(entry => ({
        path: normalizePublicPath(entry.path),
        size: entry.bytes.byteLength,
        sha256: sha256(entry.bytes),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
  }
}

function writePublicPackReceipt(receipt: unknown): void {
  if (PUBLIC_PACK_RECEIPT_PATH === undefined) return
  mkdirSync(dirname(PUBLIC_PACK_RECEIPT_PATH), { recursive: true })
  writeFileSync(PUBLIC_PACK_RECEIPT_PATH, `${JSON.stringify(canonical(receipt), null, 2)}\n`)
}

function createWte70Receipt(): Wte70SaveAsReceipt {
  return {
    schemaVersion: 1,
    kind: 'wte70-native-save-as-profile-v1',
    corpus: {
      id: EVIDENCE_CORPUS,
      relativePath: 'Maps/ex/WTE70_Madlibrarian.SC2Map',
      expectedSha256: EVIDENCE_DIGEST,
    },
    phases: [],
    artifactSourceReads: {},
  }
}

async function profiled<T>(
  receipt: Wte70SaveAsReceipt,
  name: string,
  action: () => T | Promise<T>,
): Promise<T> {
  const started = nowMs()
  try {
    const value = await action()
    receipt.phases.push({
      name,
      durationMs: Number((nowMs() - started).toFixed(3)),
      verdict: 'pass',
    })
    return value
  } catch (error) {
    receipt.phases.push({
      name,
      durationMs: Number((nowMs() - started).toFixed(3)),
      verdict: 'fail',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function recordArtifactSourceRead(
  receipt: Wte70SaveAsReceipt,
  label: string,
  kind: 'read' | 'stream',
  bytes: number,
): void {
  const target =
    receipt.artifactSourceReads[label] ??
    (receipt.artifactSourceReads[label] = {
      calls: 0,
      bytes: 0,
      operations: [],
    })
  target.calls += 1
  target.bytes += bytes
  target.operations.push({ kind, bytes })
}

async function countedArtifactSource(
  receipt: Wte70SaveAsReceipt,
  label: string,
  path: string,
): Promise<Awaited<ReturnType<typeof openFileArtifactSource>>> {
  const source = await openFileArtifactSource(path)
  return Object.freeze({
    kind: source.kind,
    ref: source.ref,
    revision: source.revision,
    size: source.size,
    async read(offset: bigint, length: number, signal?: AbortSignal) {
      const bytes = await source.read(offset, length, signal)
      recordArtifactSourceRead(receipt, label, 'read', bytes.byteLength)
      return bytes
    },
    async *stream(
      range?: { readonly offset: bigint; readonly length?: bigint },
      signal?: AbortSignal,
    ) {
      for await (const chunk of source.stream(range, signal)) {
        recordArtifactSourceRead(receipt, label, 'stream', chunk.byteLength)
        yield chunk
      }
    },
  })
}

function writeWte70Receipt(receipt: Wte70SaveAsReceipt, startedMs?: number): void {
  receipt.totalDurationMs ??= Number(
    (startedMs === undefined
      ? receipt.phases.reduce((total, phase) => total + phase.durationMs, 0)
      : nowMs() - startedMs
    ).toFixed(3),
  )
  mkdirSync(dirname(WTE70_RECEIPT_PATH), { recursive: true })
  writeFileSync(WTE70_RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(
    `[wte70-save-as-profile] receipt=${WTE70_RECEIPT_PATH} verdict=${receipt.verdict ?? 'partial'} totalMs=${receipt.totalDurationMs}`,
  )
}

describe('Block 15 native MPQ durable workflow', () => {
  it('creates and reopens MPQs through inventory, the published operation, and the ordinary materializer', async () => {
    const services = await subjectServices()
    const evidence = codecFidelityEvidenceRecords(services.inventory, {
      codecId: 'blizzard/mpq',
      formatId: 'mpq',
      acceptedOrigins: ['linked'],
    }).find(record => record.evidenceId === 'mpq-container-pack-create-v1')
    if (evidence === undefined) throw new Error('fresh MPQ codec evidence did not materialize')
    expect(evidence).toMatchObject({
      claim: { roundTrip: 'semantic', preservesUnknownData: false },
      corpusId: 'm4-packed-oracle:mpq-writer-cross-direction',
      corpusDigest: 'sha256:7350cf9dfdbc6bb01eb2b01a144a43126f22117fc441b0de59d89c6761a61f27',
    })
    const evidenceRegistry = createEvidenceRegistry([evidence])
    const backend = createFileEditingBackend({ roots: [scratch] })
    const publicCases: Array<Record<string, unknown>> = []
    try {
      for (const vector of [
        {
          id: 'named',
          files: [
            {
              name: 'Alpha.txt',
              bytesBase64: Buffer.from('alpha', 'utf8').toString('base64'),
            },
            {
              name: 'Data/Repeated.bin',
              bytesBase64: Buffer.from('SC2'.repeat(100), 'utf8').toString('base64'),
            },
          ],
          expected: [
            ['Alpha.txt', new TextEncoder().encode('alpha')],
            ['Data/Repeated.bin', new TextEncoder().encode('SC2'.repeat(100))],
          ] as const,
        },
        {
          id: 'empty',
          files: [],
          expected: [['(listfile)', new TextEncoder().encode('\r\n')]] as const,
        },
      ] as const) {
        const targetPath = join(scratch, `Public-${vector.id}.mpq`)
        writeFileSync(targetPath, new Uint8Array())
        const source = await openFileArtifactSource(targetPath)
        const opened = await services.open({
          source,
          path: targetPath,
          intent: 'full',
          grant: WRITE,
          budget,
        })
        if (opened.state !== 'opened') throw new Error(`empty .mpq did not open: ${opened.reason}`)
        expect(opened.selected.contributionId).toBe('blizzard/mpq')
        const publicOperation = opened.descriptor.operations.find(
          operation => operation.id === 'container.pack',
        )
        expect(publicOperation).toMatchObject({
          id: 'container.pack',
          handlerId: 'pack-container',
          state: 'available',
        })
        if (publicOperation === undefined) throw new Error('container.pack descriptor operation is absent')
        expect(
          opened.descriptor.operations.filter(operation => operation.state === 'available').map(
            operation => operation.id,
          ),
        ).toEqual(['container.pack'])
        const request = {
          schemaVersion: 1,
          mode: 'create',
          expectedContainerRevision: coreRevisionId(String(source.revision)),
          files: vector.files,
        } as const satisfies ContainerPackInputV1
        const invoked = await invokeContainerPack(opened, request)
        if (invoked.state !== 'ok') throw new Error('container.pack creation was rejected')
        const editing = createSubjectEditing({
          opened,
          grant: WRITE,
          backendFor: () => backend,
          evidenceFor: plan => evidenceRegistry.evidenceFor(plan),
        })
        const plan = editing.planFromOperation(invoked.output)
        expect(plan.targets).toEqual(editing.targets)
        expect(plan.edits).toHaveLength(1)
        expect(plan.edits[0]).toMatchObject({
          operation: 'replace',
          source: source.ref,
          range: { kind: 'bytes', offset: 0n, length: 0n },
        })
        const prepared = await editing.coordinator.prepare(plan, {
          grant: editing.grantSnapshot,
        })
        if (prepared.state !== 'ready') {
          throw new Error(`fresh MPQ plan was not ready: ${prepared.reason}`)
        }
        const committed = await editing.coordinator.commit(prepared.prepared, {
          grant: editing.grantSnapshot,
        })
        expect(committed.state).toBe('committed')
        await opened.session.dispose()
        const materialized = new Uint8Array(readFileSync(targetPath))
        const oracleBinding = PUBLIC_PACK_ORACLE_BINDINGS[vector.id]
        expect({ bytes: materialized.byteLength, sha256: sha256(materialized) }).toEqual(
          oracleBinding.materializedArchive,
        )

        const reopened = await services.open({
          source: await openFileArtifactSource(targetPath),
          path: targetPath,
          intent: 'full',
          grant: READ,
          budget,
        })
        if (reopened.state !== 'opened') throw new Error('materialized MPQ did not reopen')
        const reopenedEntries: Array<{ path: string; bytes: Uint8Array }> = []
        try {
          expect(reopened.selected.contributionId).toBe('blizzard/mpq')
          for (const [entryId, bytes] of vector.expected) {
            const extracted = await reopened.session.operations().invoke('extract-entry', { entryId })
            expect(extracted).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: bytes } })
            if (extracted.state === 'ok' && extracted.output.kind === 'bytes') {
              reopenedEntries.push({ path: entryId, bytes: extracted.output.value })
            }
          }
        } finally {
          await reopened.session.dispose()
        }
        const userPayload = normalizeReopenedUserPayload(reopenedEntries)
        expect(canonicalDigest(userPayload)).toBe(oracleBinding.reopenedPayloadDigest)
        publicCases.push({
          id: oracleBinding.caseId,
          requestClass: 'ContainerPackCreateInputV1',
          publicOperation: {
            id: publicOperation.id,
            handlerId: publicOperation.handlerId,
            state: publicOperation.state,
          },
          materializedArchive: {
            bytes: materialized.byteLength,
            sha256: sha256(materialized),
          },
          reopenedUserPayload: {
            projection: userPayload,
            digest: canonicalDigest(userPayload),
          },
          oracleBinding: {
            vectorId: PUBLIC_PACK_ORACLE_VECTOR,
            vectorCase: oracleBinding.vectorCase,
            vectorCaseResultDigest: oracleBinding.vectorResultDigest,
            comparison: 'matched',
          },
          verdict: 'pass',
        })
      }

      for (const [name, bytes] of [
        ['Empty.SC2Map', new Uint8Array()],
        ['Malformed.mpq', new Uint8Array([0x4d, 0x50, 0x51, 0x00])],
      ] as const) {
        const targetPath = join(scratch, name)
        writeFileSync(targetPath, bytes)
        const result = await services.open({
          source: await openFileArtifactSource(targetPath),
          path: targetPath,
          intent: 'full',
          grant: WRITE,
          budget,
        })
        expect(result.state).toBe('unresolved')
        if (result.state === 'opened') await result.session.dispose()
      }
    } finally {
      await backend.dispose()
    }
    const receiptBase = {
      schemaVersion: 1,
      evidenceKind: 'm4-public-container-pack',
      route: 'public',
      requestClass: 'ContainerPackCreateInputV1',
      publicOperation: {
        id: 'container.pack',
        handlerId: 'pack-container',
        state: 'available',
      },
      caseIds: publicCases.map(item => item.id),
      cases: publicCases,
      oracleComparison: 'matched',
      verdict: 'pass',
    }
    const receipt = { ...receiptBase, resultDigest: canonicalDigest(receiptBase) }
    writePublicPackReceipt(receipt)
    console.log(
      `[mpq-public-pack] ${JSON.stringify({ verdict: receipt.verdict, caseIds: receipt.caseIds, resultDigest: receipt.resultDigest })}`,
    )
  }, 60_000)

  it('resolves fresh-writer evidence and commits an empty loose namespace Save As', async () => {
    const services = await subjectServices()
    if (services.serviceDefinitions === undefined) throw new Error('no MPQ writer definitions')
    const destination = join(scratch, 'fresh-empty-save-as')
    mkdirSync(destination)
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(destination).href)
    const destinationUri = pathToFileURL(destination).href
    const opened = await openSubject({
      inventory: services.inventory,
      source: artifactNamespaceSourceFromVfsMount(mount, {
        ref: { id: destinationUri, uri: destinationUri },
      }),
      path: destination,
      intent: 'full',
      target: services.target,
      grant: WRITE,
      executionBackends: services.executionBackends,
      budget,
    })
    if (opened.state !== 'unresolved') throw new Error('fresh Save As target must be a namespace')
    const port = createHostServiceResolver({
      inventory: services.inventory,
      target: services.target,
      executionBackends: services.executionBackends,
      definitions: services.serviceDefinitions,
      grant: WRITE,
      budgets: budget,
    })
    const writerLease = await port.port.resolve({
      contract: 'common.edit/writer',
      major: 1,
      facet: {
        formatId: 'mpq',
        representationId: 'source',
        mutationMode: 'export-only',
        minimumRoundTrip: 'semantic',
      },
    })
    const writer = writerLease.value as Writer
    const evidence = serviceProviderFidelityEvidenceRecord(services.inventory, {
      writer,
      offerId: 'mpq-fresh-archive-v1',
      acceptedOrigins: ['linked'],
    })
    if (evidence === undefined) throw new Error('fresh MPQ writer evidence did not materialize')
    expect(evidence).toMatchObject({
      evidenceId: 'mpq-fresh-archive-writer-v1',
      corpusId: 'm4-packed-oracle:mpq-writer-cross-direction',
      corpusDigest: 'sha256:7350cf9dfdbc6bb01eb2b01a144a43126f22117fc441b0de59d89c6761a61f27',
      optionsFingerprint: 'm4-named-payloads-exclude-generated-listfile-v1',
      inputClass: 'nonempty-and-empty-complete-explicit-named-payload-sets',
    })
    const backend = createFileEditingBackend({ roots: [destination] })
    try {
      const editing = createSubjectEditing({
        opened,
        grant: WRITE,
        backendFor: () => backend,
        evidenceFor: plan => createEvidenceRegistry([evidence]).evidenceFor(plan, writer.identity),
        expectedWriter: writer.identity,
        expectedEvidenceContext: {
          optionsFingerprint: evidence.optionsFingerprint,
          inputClass: evidence.inputClass,
        },
        writer,
      })
      const target = editing.targets[0]
      if (target === undefined) throw new Error('fresh Save As target is absent')
      const sourceRevision = 'content-hash.sha256:empty-loose-namespace'
      const change = await snapshotFreshMpq({
        source: {
          revision: sourceRevision,
          async currentRevision() {
            return sourceRevision
          },
          async list() {
            return { items: [] }
          },
          async read() {
            throw new Error('empty loose namespace has no readable entry')
          },
        },
        sourcePrefix: 'Root',
        sourceMode: 'loose-namespace',
        target,
        archiveName: 'Empty.mpq',
      })
      expect(change.semanticIntent).toMatchObject({ entryCount: 0, completeSnapshot: true })
      expect(await writer.validate(change)).toEqual({ valid: true, diagnostics: [] })
      const plan = await writer.plan(change)
      const prepared = await editing.coordinator.prepare(plan, {
        grant: editing.grantSnapshot,
      })
      if (prepared.state !== 'ready') throw new Error(`fresh Save As was not ready: ${prepared.reason}`)
      const committed = await editing.coordinator.commit(prepared.prepared, {
        grant: editing.grantSnapshot,
      })
      expect(committed.state).toBe('committed')
      const outputPath = join(destination, 'Empty.mpq')
      const reopened = await services.open({
        source: await openFileArtifactSource(outputPath),
        path: outputPath,
        intent: 'full',
        grant: READ,
        budget,
      })
      if (reopened.state !== 'opened') throw new Error('empty fresh Save As did not reopen')
      try {
        const listfile = await reopened.session.operations().invoke('extract-entry', {
          entryId: '(listfile)',
        })
        expect(listfile).toMatchObject({
          state: 'ok',
          output: { kind: 'bytes', value: new TextEncoder().encode('\r\n') },
        })
      } finally {
        await reopened.session.dispose()
      }
    } finally {
      await backend.dispose()
      await writerLease.release()
      await port.release()
      await mount.dispose()
    }
  }, 60_000)

  it('resolves, validates, confines, atomically writes, reopens, compares and undoes', async () => {
    const source = encodeFreshMpq([
      { path: 'MapScript.galaxy', bytes: new TextEncoder().encode('void Before() {}\r\n') },
      { path: 'Opaque.bin', bytes: new Uint8Array([0, 255, 1, 2, 3, 254]) },
    ])
    const sourcePath = join(scratch, 'Original.SC2Map')
    writeFileSync(sourcePath, source)
    const destination = join(scratch, 'export')
    mkdirSync(destination)
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(destination).href)
    const services = await subjectServices()
    const destinationUri = pathToFileURL(destination).href
    const opened = await openSubject({
      inventory: services.inventory,
      source: artifactNamespaceSourceFromVfsMount(mount, {
        ref: { id: destinationUri, uri: destinationUri },
      }),
      path: destination,
      intent: 'full',
      target: services.target,
      grant: WRITE,
      executionBackends: services.executionBackends,
      budget,
    })
    if (opened.state !== 'unresolved') throw new Error(`unexpected target state ${opened.state}`)
    if (services.serviceDefinitions === undefined) throw new Error('no MPQ writer definitions')
    const port = createHostServiceResolver({
      inventory: services.inventory,
      target: services.target,
      executionBackends: services.executionBackends,
      definitions: services.serviceDefinitions,
      grant: WRITE,
      budgets: budget,
    })
    const writerLease = await port.port.resolve({
      contract: 'common.edit/writer',
      major: 1,
      facet: {
        formatId: 'mpq',
        representationId: 'native-source',
        mutationMode: 'export-only',
        minimumRoundTrip: 'semantic',
      },
    })
    const writer = writerLease.value as Writer
    const backend = createFileEditingBackend({ roots: [destination] })
    try {
      expect(writer.offer).toMatchObject({
        fidelityEvidenceId: 'mpq-native-preserving-writer-v1',
        representationId: 'native-source',
      })
      expect(writer.identity).toMatchObject({
        providerId: 'blizzard/mpq-fresh-writer',
        providerVersion: expect.any(String),
        artifactDigest: expect.any(String),
        formatId: 'mpq',
        representationId: 'native-source',
      })
      const evidence = serviceProviderFidelityEvidenceRecord(services.inventory, {
        writer,
        offerId: 'mpq-native-preserving-v1',
        acceptedOrigins: ['linked'],
      })
      if (evidence === undefined) throw new Error('native MPQ writer evidence did not materialize')
      expect(evidence).toMatchObject({
        claim: { roundTrip: 'semantic', preservesUnknownData: true },
        evidenceId: EVIDENCE_ID,
        corpusId: EVIDENCE_CORPUS,
        corpusDigest: EVIDENCE_DIGEST,
        conformanceProfile: 'common.edit/writer-v1',
        writer: writer.identity,
        optionsFingerprint: EVIDENCE_OPTIONS,
        inputClass: EVIDENCE_INPUT_CLASS,
        provenAt: '2026-08-28T00:00:00Z',
      })
      const evidenceRegistry = createEvidenceRegistry([evidence])
      const editing = createSubjectEditing({
        opened,
        grant: WRITE,
        backendFor: () => backend,
        evidenceFor: plan => evidenceRegistry.evidenceFor(plan),
        expectedWriter: writer.identity,
        expectedEvidenceContext: {
          optionsFingerprint: EVIDENCE_OPTIONS,
          inputClass: EVIDENCE_INPUT_CLASS,
        },
        writer,
      })
      const target = editing.targets[0]
      if (target === undefined) throw new Error('no native MPQ destination target')
      const changed = new TextEncoder().encode('void After_() {}\r\n')
      const change = await snapshotNativePreservingMpq({
        sourceBytes: source,
        replacements: [{ path: 'MapScript.galaxy', bytes: changed }],
        target,
        archiveName: 'Changed.SC2Map',
      })
      expect(await writer.validate(change)).toEqual({ valid: true, diagnostics: [] })
      const plan = await writer.plan(change)
      const prepared = await editing.coordinator.prepare(plan, {
        grant: editing.grantSnapshot,
      })
      expect(prepared.state).toBe('ready')
      if (prepared.state !== 'ready') return
      const committed = await editing.coordinator.commit(prepared.prepared, {
        grant: editing.grantSnapshot,
      })
      expect(committed).toMatchObject({
        state: 'committed',
        receipt: {
          mutationMode: 'export-only',
          commitGuarantee: 'atomic',
          fidelity: {
            roundTrip: 'semantic',
            preservesUnknownData: true,
            evidenceId: EVIDENCE_ID,
            writer: writer.identity,
            optionsFingerprint: EVIDENCE_OPTIONS,
            inputClass: EVIDENCE_INPUT_CLASS,
          },
        },
      })
      if (committed.state !== 'committed') return

      expect([...readFileSync(sourcePath)]).toEqual([...source])
      const outputPath = join(destination, 'Changed.SC2Map')
      const reopened = await services.open({
        source: await openFileArtifactSource(outputPath),
        path: outputPath,
        intent: 'full',
        grant: READ,
        budget,
      })
      if (reopened.state !== 'opened') throw new Error(`native output did not reopen`)
      try {
        expect(reopened.selected.contributionId).toBe('blizzard/mpq')
        for (const [entryId, expected] of [
          ['MapScript.galaxy', changed],
          ['Opaque.bin', new Uint8Array([0, 255, 1, 2, 3, 254])],
        ] as const) {
          const extracted = await reopened.session.operations().invoke('extract-entry', { entryId })
          expect(extracted.state).toBe('ok')
          if (extracted.state === 'ok' && extracted.output.kind === 'bytes') {
            expect([...extracted.output.value]).toEqual([...expected])
          }
        }
      } finally {
        await reopened.session.dispose()
      }
      expect(
        await editing.coordinator.undo(committed.receipt.transactionId, {
          grant: editing.grantSnapshot,
        }),
      ).toMatchObject({ state: 'committed' })
      expect(() => readFileSync(outputPath)).toThrow()
    } finally {
      await backend.dispose()
      await writerLease.release()
      await port.release()
      await mount.dispose()
    }
  }, 60_000)

  it.skipIf(!existsSync(installedMapPath))(
    'runs the ordinary semantic Save As workflow on the installed WTE70 SC2Map',
    async () => {
      const receipt = createWte70Receipt()
      const receiptStarted = nowMs()
      try {
        expect(
          existsSync(installedMapPath),
          `installed SC2 proof corpus is required at ${installedMapPath}`,
        ).toBe(true)
        const installedBytes = await profiled(
          receipt,
          'read-installed-corpus',
          () => new Uint8Array(readFileSync(installedMapPath)),
        )
        const sourceDigest = sha256(installedBytes)
        receipt.corpus = {
          ...receipt.corpus,
          size: installedBytes.byteLength,
          sha256: `sha256:${sourceDigest}`,
        }
        expect(installedBytes.byteLength).toBe(22_703)
        expect(`sha256:${sourceDigest}`).toBe(EVIDENCE_DIGEST)

        const semanticServices = await profiled(receipt, 'create-semantic-services', () =>
          sc2SubjectServices(),
        )
        const installed = await profiled(receipt, 'semantic-open-installed-sc2map', async () =>
          semanticServices.open({
            source: await countedArtifactSource(
              receipt,
              'installed-semantic-open',
              installedMapPath,
            ),
            path: installedMapPath,
            intent: 'full',
            grant: READ,
            budget,
          }),
        )
        if (installed.state !== 'opened')
          throw new Error('installed SC2Map did not open semantically')
        let source: Uint8Array
        let beforeSummary: unknown
        try {
          expect(installed.selected.contributionId).toBe('blizzard/sc2-map')
          const inspected = await profiled(receipt, 'semantic-inspect-installed-sc2map', () =>
            installed.session.operations().invoke('inspect', {}),
          )
          expect(inspected.state).toBe('ok')
          if (inspected.state !== 'ok' || inspected.output.kind !== 'json') {
            throw new Error('installed SC2Map inspection did not return JSON')
          }
          beforeSummary = inspected.output.value
          expect(beforeSummary).toMatchObject({
            format: 'sc2-map',
            mpqVersion: 1,
            mpqEntries: 32,
            entries: 36,
            mapDocuments: expect.arrayContaining(['mapinfo', 'objects', 't3terrain.xml']),
          })
          const exported = await profiled(receipt, 'semantic-export-installed-raw', () =>
            installed.session.operations().invoke('export-raw', {}),
          )
          expect(exported.state).toBe('ok')
          if (exported.state !== 'ok' || exported.output.kind !== 'bytes') {
            throw new Error('installed SC2Map raw export did not return bytes')
          }
          source = exported.output.value
          expect([...source]).toEqual([...installedBytes])
        } finally {
          await installed.session.dispose()
        }

        const mpqServices = await profiled(receipt, 'create-mpq-services', () => subjectServices())
        const sourceMpq = await profiled(receipt, 'mpq-open-installed-sc2map', async () =>
          mpqServices.open({
            source: await countedArtifactSource(receipt, 'installed-mpq-open', installedMapPath),
            path: installedMapPath,
            intent: 'full',
            grant: READ,
            budget,
          }),
        )
        if (sourceMpq.state !== 'opened') throw new Error('installed SC2Map did not open as MPQ')
        let mapInfoBefore: Uint8Array
        try {
          expect(sourceMpq.selected.contributionId).toBe('blizzard/mpq')
          const extracted = await profiled(receipt, 'mpq-extract-installed-mapinfo', () =>
            sourceMpq.session.operations().invoke('extract-entry', {
              entryId: 'MapInfo',
            }),
          )
          expect(extracted.state).toBe('ok')
          if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
            throw new Error('installed MapInfo did not extract')
          }
          mapInfoBefore = extracted.output.value
        } finally {
          await sourceMpq.session.dispose()
        }

        const destination = join(scratch, 'installed-save-as')
        await profiled(receipt, 'create-save-as-destination', () => mkdirSync(destination))
        const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
        const mount = await profiled(receipt, 'open-destination-vfs-mount', () =>
          vfs.openMount(pathToFileURL(destination).href),
        )
        const destinationUri = pathToFileURL(destination).href
        const targetSubject = await profiled(receipt, 'open-destination-namespace-target', () =>
          openSubject({
            inventory: semanticServices.inventory,
            source: artifactNamespaceSourceFromVfsMount(mount, {
              ref: { id: destinationUri, uri: destinationUri },
            }),
            path: destination,
            intent: 'full',
            target: semanticServices.target,
            grant: WRITE,
            executionBackends: semanticServices.executionBackends,
            budget,
          }),
        )
        if (targetSubject.state !== 'unresolved') {
          throw new Error(`unexpected native Save As target state ${targetSubject.state}`)
        }
        if (semanticServices.serviceDefinitions === undefined) {
          throw new Error('no native MPQ writer definitions')
        }
        const port = createHostServiceResolver({
          inventory: semanticServices.inventory,
          target: semanticServices.target,
          executionBackends: semanticServices.executionBackends,
          definitions: semanticServices.serviceDefinitions,
          grant: WRITE,
          budgets: budget,
        })
        const writerLease = await profiled(receipt, 'resolve-native-mpq-writer', () =>
          port.port.resolve({
            contract: 'common.edit/writer',
            major: 1,
            facet: {
              formatId: 'mpq',
              representationId: 'native-source',
              mutationMode: 'export-only',
              minimumRoundTrip: 'semantic',
            },
          }),
        )
        const writer = writerLease.value as Writer
        const evidence = serviceProviderFidelityEvidenceRecord(semanticServices.inventory, {
          writer,
          offerId: 'mpq-native-preserving-v1',
          acceptedOrigins: ['linked'],
        })
        if (evidence === undefined) throw new Error('installed MPQ evidence did not materialize')
        expect(evidence).toMatchObject({
          evidenceId: EVIDENCE_ID,
          corpusId: EVIDENCE_CORPUS,
          corpusDigest: EVIDENCE_DIGEST,
          writer: writer.identity,
          optionsFingerprint: EVIDENCE_OPTIONS,
          inputClass: EVIDENCE_INPUT_CLASS,
        })
        const evidenceRegistry = createEvidenceRegistry([evidence])
        const backend = createFileEditingBackend({ roots: [destination] })
        try {
          const editing = createSubjectEditing({
            opened: targetSubject,
            grant: WRITE,
            backendFor: () => backend,
            evidenceFor: plan => evidenceRegistry.evidenceFor(plan),
            expectedWriter: writer.identity,
            expectedEvidenceContext: {
              optionsFingerprint: EVIDENCE_OPTIONS,
              inputClass: EVIDENCE_INPUT_CLASS,
            },
            writer,
          })
          if (editing.session === undefined) throw new Error('native MPQ editing session is absent')
          const target = editing.targets[0]
          if (target === undefined) throw new Error('native MPQ destination target is absent')
          const changed = new TextEncoder().encode(
            `void NativePreservingProof() {\r\n${'    // fixed-slot zlib proof\r\n'.repeat(40)}}\r\n`,
          )
          const archiveName = 'WTE70_Madlibrarian.NativeProof.SC2Map'
          const change = await profiled(receipt, 'snapshot-native-preserving-mpq', () =>
            snapshotNativePreservingMpq({
              sourceBytes: source,
              replacements: [{ path: 'MapScript.galaxy', bytes: changed }],
              target,
              archiveName,
            }),
          )
          receipt.nativeExport = change.semanticIntent.nativeExportReceipt
          expect(change.semanticIntent.nativeExportReceipt).toMatchObject({
            source: {
              version: 1,
              archiveBytes: 20_143,
              userDataBytes: 2_252,
              prefixBytes: 2_560,
              hashSlots: 64,
              blockSlots: 32,
            },
            changed: [
              {
                path: 'MapScript.galaxy',
                blockIndex: 10,
                flags: '0x81000200',
                method: 'zlib',
                sourceBytes: 2_244,
                zeroFilledSlackBytes: expect.any(Number),
              },
            ],
            opaque: {
              changedEntrySlack: 'zero-filled-no-source-payload-retained',
              sourceArchive: 'not-mutated',
            },
          })
          expect(
            await profiled(receipt, 'editing-propose', () => editing.session!.propose(change)),
          ).toEqual({
            valid: true,
            diagnostics: [],
          })
          const plan = await profiled(receipt, 'editing-plan', () => editing.session!.plan(change))
          expect(plan).toMatchObject({
            semantics: { mutationMode: 'export-only', minimumGuarantee: 'atomic' },
            fidelity: { roundTrip: 'semantic', preservesUnknownData: true },
          })
          const prepared = await profiled(receipt, 'editing-prepare', () =>
            editing.coordinator.prepare(plan, {
              grant: editing.grantSnapshot,
            }),
          )
          expect(prepared.state).toBe('ready')
          if (prepared.state !== 'ready')
            throw new Error(`prepare failed with state ${prepared.state}`)
          const committed = await profiled(receipt, 'editing-commit', () =>
            editing.coordinator.commit(prepared.prepared, {
              grant: editing.grantSnapshot,
            }),
          )
          expect(committed).toMatchObject({
            state: 'committed',
            receipt: {
              mutationMode: 'export-only',
              commitGuarantee: 'atomic',
              fidelity: {
                roundTrip: 'semantic',
                preservesUnknownData: true,
                evidenceId: EVIDENCE_ID,
                writer: writer.identity,
                optionsFingerprint: EVIDENCE_OPTIONS,
                inputClass: EVIDENCE_INPUT_CLASS,
              },
            },
          })
          if (committed.state !== 'committed')
            throw new Error(`commit failed with state ${committed.state}`)

          const outputPath = join(destination, archiveName)
          const outputBytes = await profiled(
            receipt,
            'read-save-as-destination',
            () => new Uint8Array(readFileSync(outputPath)),
          )
          receipt.destination = {
            archiveName,
            bytes: outputBytes.byteLength,
            sha256: `sha256:${sha256(outputBytes)}`,
          }
          const semanticReopen = await profiled(receipt, 'semantic-reopen-saved-sc2map', async () =>
            semanticServices.open({
              source: await countedArtifactSource(receipt, 'saved-semantic-reopen', outputPath),
              path: outputPath,
              intent: 'full',
              grant: READ,
              budget,
            }),
          )
          if (semanticReopen.state !== 'opened') throw new Error('saved SC2Map did not reopen')
          try {
            expect(semanticReopen.selected.contributionId).toBe('blizzard/sc2-map')
            const inspected = await profiled(receipt, 'semantic-inspect-saved-sc2map', () =>
              semanticReopen.session.operations().invoke('inspect', {}),
            )
            expect(inspected.state).toBe('ok')
            if (inspected.state !== 'ok' || inspected.output.kind !== 'json') {
              throw new Error('saved SC2Map inspection did not return JSON')
            }
            expect(inspected.output.value).toEqual({
              ...(beforeSummary as Record<string, unknown>),
              semanticBytesRead: changed.byteLength,
            })
            receipt.reopened = {
              ...receipt.reopened,
              semantic: {
                contributionId: semanticReopen.selected.contributionId,
                summaryMatchesSource: true,
                summary: inspected.output.value,
              },
            }
          } finally {
            await semanticReopen.session.dispose()
          }

          const mpqReopen = await profiled(receipt, 'mpq-reopen-saved-sc2map', async () =>
            mpqServices.open({
              source: await countedArtifactSource(receipt, 'saved-mpq-reopen', outputPath),
              path: outputPath,
              intent: 'full',
              grant: READ,
              budget,
            }),
          )
          if (mpqReopen.state !== 'opened') throw new Error('saved SC2Map did not reopen as MPQ')
          const extractedEntries: Record<
            string,
            { bytes: number; sha256: string; matchesExpected: boolean }
          > = {}
          try {
            expect(mpqReopen.selected.contributionId).toBe('blizzard/mpq')
            for (const [entryId, expected] of [
              ['MapScript.galaxy', changed],
              ['MapInfo', mapInfoBefore],
            ] as const) {
              const extracted = await profiled(receipt, `mpq-extract-saved-${entryId}`, () =>
                mpqReopen.session.operations().invoke('extract-entry', {
                  entryId,
                }),
              )
              expect(extracted.state).toBe('ok')
              if (extracted.state === 'ok' && extracted.output.kind === 'bytes') {
                const matchesExpected = sha256(extracted.output.value) === sha256(expected)
                expect([...extracted.output.value]).toEqual([...expected])
                extractedEntries[entryId] = {
                  bytes: extracted.output.value.byteLength,
                  sha256: `sha256:${sha256(extracted.output.value)}`,
                  matchesExpected,
                }
              }
            }
            receipt.reopened = {
              ...receipt.reopened,
              codec: {
                contributionId: mpqReopen.selected.contributionId,
                extractedEntries,
              },
            }
          } finally {
            await mpqReopen.session.dispose()
          }
          const sourceUnchangedBytes = await profiled(
            receipt,
            'read-installed-corpus-after-save-as',
            () => new Uint8Array(readFileSync(installedMapPath)),
          )
          receipt.sourceUnchanged = {
            size: sourceUnchangedBytes.byteLength,
            sha256: `sha256:${sha256(sourceUnchangedBytes)}`,
            matchesOriginal: sha256(sourceUnchangedBytes) === sourceDigest,
          }
          expect(receipt.sourceUnchanged.matchesOriginal).toBe(true)
          expect(
            await profiled(receipt, 'editing-undo-save-as', () =>
              editing.coordinator.undo(committed.receipt.transactionId, {
                grant: editing.grantSnapshot,
              }),
            ),
          ).toMatchObject({ state: 'committed' })
          expect(() => readFileSync(outputPath)).toThrow()
          receipt.undo = { removedDestination: true }
        } finally {
          await backend.dispose()
          await writerLease.release()
          await port.release()
          await mount.dispose()
        }
        receipt.totalDurationMs = Number((nowMs() - receiptStarted).toFixed(3))
        expect(receipt.totalDurationMs).toBeLessThan(60_000)
        receipt.verdict = 'pass'
      } catch (error) {
        receipt.verdict = 'fail'
        receipt.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        writeWte70Receipt(receipt, receiptStarted)
      }
    },
    60_000,
  )
})
