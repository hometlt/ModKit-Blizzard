import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSubjectEditing, createHostServiceResolver } from '@modkit/host'
import { createFileEditingBackend, createModkit, openFileArtifactSource } from '@modkit/host/node'
import { runMinimalHost } from '@modkit/testkit'

const extension = resolve(import.meta.dirname, '..', '..', '..')
const original = new TextEncoder().encode('\ufeff// comment\r\nA=One\r\n')
const changed = new TextEncoder().encode('\ufeff// comment\r\nA=Two\r\n')
const budget = { maxInputBytes: 4_000_000n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 4_000_000, maxDiagnostics: 1_000 }
const grant = { id: 'sc2-strings-m5-write', classes: ['read-source', 'write-source'] } as const

describe('SC2 strings native host and writer surface', () => {
  let scratch = ''
  let sourcePath = ''
  let host: Awaited<ReturnType<typeof createModkit>>
  let backend: ReturnType<typeof createFileEditingBackend>

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'sc2-strings-m5-'))
    sourcePath = join(scratch, 'Test.SC2Mod', 'enUS.SC2Data', 'LocalizedData', 'GameStrings.txt')
    mkdirSync(dirname(sourcePath), { recursive: true })
    writeFileSync(sourcePath, original)
    host = await createModkit({ extensions: [extension], roots: [scratch] })
    backend = createFileEditingBackend({ roots: [scratch] })
  })

  afterAll(async () => {
    await backend.dispose()
    await host.close()
    rmSync(scratch, { recursive: true, force: true })
  })

  async function open() {
    const result = await host.services.open({ source: await openFileArtifactSource(sourcePath), path: sourcePath, intent: 'full', grant, budget })
    expect(result.state).toBe('opened')
    if (result.state !== 'opened') throw new Error('SC2 strings did not open')
    expect(result.selected.contributionId).toBe('blizzard/sc2-strings')
    return result
  }

  async function commit(opened: any, operation: any, evidenceId: string) {
    if (operation.state !== 'ok' || operation.output.kind !== 'edit-plan') throw new Error('SC2 strings edit did not yield an edit plan')
    if (host.services.serviceDefinitions === undefined) throw new Error('writer definitions missing')
    const resolver = createHostServiceResolver({ inventory: host.services.inventory, target: host.services.target, executionBackends: host.services.executionBackends, definitions: host.services.serviceDefinitions, grant, budgets: budget })
    const lease = await resolver.port.resolve({ contract: 'common.edit/writer', major: 1, facet: { formatId: 'sc2-strings', representationId: 'source', mutationMode: 'mutate', minimumRoundTrip: 'byte-identical' } })
    try {
      const editing = createSubjectEditing({
        opened, grant, writer: lease.value as any, backendFor: () => backend,
        evidenceFor: () => ({ roundTrip: 'byte-identical', preservesUnknownData: true, evidenceId, corpusId: 'sc2-strings-native-host', corpusDigest: `sha256:${createHash('sha256').update(readFileSync(sourcePath)).digest('hex')}`, conformanceProfile: 'modkit/codec-contribution-v1', writer: (lease.value as any).identity, optionsFingerprint: evidenceId, inputClass: 'localized-data', provenAt: '2026-09-05T00:00:00Z' }) as never,
      })
      const prepared = await editing.coordinator.prepare(editing.planFromOperation(operation.output), { grant: editing.grantSnapshot })
      expect(prepared.state).toBe('ready')
      if (prepared.state !== 'ready') throw new Error('SC2 strings writer did not prepare')
      expect((await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })).state).toBe('committed')
    } finally { await lease.release() }
  }

  it('activates the compiled contribution through the installed minimal host', async () => {
    const minimal = await runMinimalHost({ extensionDirs: [extension], extensionExecution: { origin: 'installed', allowTrustedInProcess: true }, request: { contract: { contract: 'common.document/flow-metadata', major: 1 }, pin: { providerId: 'blizzard/sc2-strings' }, target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } } as never, grant })
    expect(minimal.result.state).toBe('resolved')
    expect(typeof minimal.activation.module['createCodec']).toBe('function')
  })

  it('routes and commits the lossless changed edit', async () => {
    const opened = await open()
    try {
      await commit(opened, await opened.session.operations().invoke('edit-strings', { action: 'set', key: 'A', value: 'Two' }), 'sc2-strings-m5-change')
      expect(new Uint8Array(readFileSync(sourcePath))).toEqual(changed)
    } finally { await opened.session.dispose() }
  })

  it('commits a byte-identical no-op through the resolved writer', async () => {
    const opened = await open()
    try {
      await commit(opened, await opened.session.operations().invoke('edit-strings', { action: 'set', key: 'A', value: 'Two' }), 'sc2-strings-m5-no-op')
      expect(new Uint8Array(readFileSync(sourcePath))).toEqual(changed)
    } finally { await opened.session.dispose() }
  })

  it('reopens the source after the no-op writer commit', async () => {
    const reopened = await open()
    try {
      expect(await reopened.session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { entries: 1 } } })
    } finally { await reopened.session.dispose() }
  })
})
