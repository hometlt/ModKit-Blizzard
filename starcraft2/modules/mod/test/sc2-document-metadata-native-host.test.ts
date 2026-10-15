import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSubjectEditing } from '@modkit/host'
import { createFileEditingBackend, createModkit, openFileArtifactSource } from '@modkit/host/node'
import { runMinimalHost } from '@modkit/testkit'
import { writeDocumentHeader } from '../../../dist/modules/mod/codecs/document-metadata/core/document-header.js'

const extension = resolve(import.meta.dirname, '../../..')
const budget = { maxInputBytes: 4_000_000n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 4_000_000, maxDiagnostics: 1_000 }
const grant = { id: 'sc2-document-metadata-m5-write', classes: ['read-source', 'write-source'] } as const
const show = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))

describe('SC2 document metadata M5 native host routing and persistence', () => {
  let scratch = ''
  let path = ''
  let original = new Uint8Array()
  let host: Awaited<ReturnType<typeof createModkit>>
  let backend: ReturnType<typeof createFileEditingBackend>
  let initialOpened: any
  const sessions: { dispose(): Promise<void> }[] = []

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'sc2-document-metadata-m5-'))
    path = join(scratch, 'Test.SC2Mod', 'DocumentHeader')
    original = writeDocumentHeader({ flags: 0x0501, headerSize: 958, timestamp1: 95_841, timestamp2: 95_841, unknown3: 2, hash1: 1, hash2: 2, dependencies: ['file:Mods/Liberty.SC2Mod'], entries: [{ key: 'DocInfo/Name', type: 'SUne', value: 'Fixture' }] })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, original)
    host = await createModkit({ extensions: [extension], roots: [scratch] })
    backend = createFileEditingBackend({ roots: [scratch] })
    const opened = await host.services.open({ source: await openFileArtifactSource(path), path, intent: 'full', grant, budget })
    if (opened.state !== 'opened') throw new Error(`SC2 document metadata did not open during native host setup: ${show(opened)}`)
    expect(opened.selected.contributionId).toBe('blizzard/sc2-document-metadata')
    initialOpened = opened
    sessions.push(opened.session)
  }, 60_000)

  afterAll(async () => {
    for (const session of sessions) await session.dispose()
    await backend.dispose()
    await host.close()
    rmSync(scratch, { recursive: true, force: true })
  })

  it('activates the compiled contribution through the minimal native host', async () => {
    const run = await runMinimalHost({
      extensionDirs: [extension],
      extensionExecution: { origin: 'installed', allowTrustedInProcess: true },
      request: { contract: { contract: 'common.document/flow-metadata', major: 1 }, pin: { providerId: 'blizzard/sc2-document-metadata' }, target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } } as never,
      grant,
    })
    expect(run.result.state).toBe('resolved')
    expect(typeof run.activation.module['createCodec']).toBe('function')
  })

  it('routes, validates, commits dependency replacement and no-op, then reopens', async () => {
    const open = async () => {
        const result = await host.services.open({ source: await openFileArtifactSource(path), path, intent: 'full', grant, budget })
        expect(result.state).toBe('opened')
        if (result.state !== 'opened') throw new Error('SC2 document metadata did not open')
        expect(result.selected.contributionId).toBe('blizzard/sc2-document-metadata')
        sessions.push(result.session)
        return result
      }
    const opened = initialOpened
      expect(await opened.session.operations().invoke('validate', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: [] } })
      const invocation = await opened.session.operations().invoke('replace-dependencies', { dependencies: ['file:Mods/Swarm.SC2Mod'] })
      expect(invocation.state).toBe('ok')
      if (invocation.state !== 'ok') throw new Error('Document metadata edit did not run')
      const editing = createSubjectEditing({
        opened,
        grant,
        backendFor: () => backend,
        evidenceFor: () => ({
          roundTrip: 'semantic', preservesUnknownData: true,
          evidenceId: 'sc2-document-metadata-m5-host-fixture',
          corpusId: 'sc2-document-metadata-native-host',
          corpusDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
          conformanceProfile: 'modkit/codec-contribution-v1',
          writer: {
            providerId: 'blizzard/sc2-document-metadata',
            providerVersion: '1.0.0',
            artifactDigest: host.services.inventory.extensions[0]?.contributions.find(
              item => item.manifest?.id === 'blizzard/sc2-document-metadata',
            )?.record?.artifactDigest,
            formatId: 'sc2-document-metadata',
            representationId: 'source',
          },
          optionsFingerprint: 'dependency-replacement', inputClass: 'document-header',
          provenAt: '2026-09-05T00:00:00Z',
        }) as never,
      })
    const prepared = await editing.coordinator.prepare(editing.planFromOperation(invocation.output), { grant: editing.grantSnapshot })
    expect(prepared.state, show(prepared)).toBe('ready')
      if (prepared.state !== 'ready') throw new Error('Document metadata edit did not prepare')
      expect((await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })).state).toBe('committed')
    const replaced = new Uint8Array(readFileSync(path))
      expect(replaced).not.toEqual(original)
    const reopened = await open()
    const noOpInvocation = await reopened.session.operations().invoke('replace-dependencies', { dependencies: ['file:Mods/Swarm.SC2Mod'] })
    expect(noOpInvocation.state, show(noOpInvocation)).toBe('ok')
    if (noOpInvocation.state !== 'ok') throw new Error('Document metadata no-op edit did not run')
    const noOpEditing = createSubjectEditing({
      opened: reopened,
      grant,
      backendFor: () => backend,
      evidenceFor: () => ({
        roundTrip: 'semantic', preservesUnknownData: true,
        evidenceId: 'sc2-document-metadata-m5-host-no-op',
        corpusId: 'sc2-document-metadata-native-host',
        corpusDigest: `sha256:${createHash('sha256').update(replaced).digest('hex')}`,
        conformanceProfile: 'modkit/codec-contribution-v1',
        writer: {
          providerId: 'blizzard/sc2-document-metadata',
          providerVersion: '1.0.0',
          artifactDigest: host.services.inventory.extensions[0]?.contributions.find(
            item => item.manifest?.id === 'blizzard/sc2-document-metadata',
          )?.record?.artifactDigest,
          formatId: 'sc2-document-metadata',
          representationId: 'source',
        },
        optionsFingerprint: 'dependency-replacement-no-op', inputClass: 'document-header',
        provenAt: '2026-09-05T00:00:00Z',
      }) as never,
    })
    const noOpPrepared = await noOpEditing.coordinator.prepare(noOpEditing.planFromOperation(noOpInvocation.output), { grant: noOpEditing.grantSnapshot })
    expect(noOpPrepared.state, show(noOpPrepared)).toBe('ready')
    if (noOpPrepared.state !== 'ready') throw new Error('Document metadata no-op edit did not prepare')
    expect((await noOpEditing.coordinator.commit(noOpPrepared.prepared, { grant: noOpEditing.grantSnapshot })).state).toBe('committed')
    expect(new Uint8Array(readFileSync(path))).toEqual(replaced)
    const reopenedNoOp = await open()
    expect(await reopenedNoOp.session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { dependencies: ['file:Mods/Swarm.SC2Mod'] } } })

    const unrelatedVersionPath = join(scratch, 'Empty.version')
    writeFileSync(unrelatedVersionPath, new Uint8Array())
    const unrelated = await host.services.open({ source: await openFileArtifactSource(unrelatedVersionPath), path: unrelatedVersionPath, intent: 'full', grant, budget })
    expect(unrelated.state).toBe('unresolved')
    if (unrelated.state === 'unresolved') {
      expect(unrelated.descriptor.candidates).toContainEqual(expect.objectContaining({
        codecId: 'blizzard/sc2-document-metadata',
        confidence: 0,
      }))
    }
  }, 60_000)
})
