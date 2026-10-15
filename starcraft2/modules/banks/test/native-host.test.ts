import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSubjectEditing, createHostServiceResolver } from '@modkit/host'
import { createFileEditingBackend, createModkit, openFileArtifactSource } from '@modkit/host/node'
import { runMinimalHost } from '@modkit/testkit'

const extension = resolve(import.meta.dirname, '..', '..', '..')
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}
const grant = { id: 'bank-m2-write', classes: ['read-source', 'write-source'] } as const
const show = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))
const original =
  '<Bank version="1">\r\n<!-- untouched --><Section name="S"><Key name="K"><Value int=\'7\'/></Key></Section>\r\n</Bank>'

describe('SC2 bank native host routing and persistence', () => {
  it('activates the published bank contribution through the minimal native host', async () => {
    const run = await runMinimalHost({
      extensionDirs: [extension],
      extensionExecution: { origin: 'installed', allowTrustedInProcess: true },
      request: {
        contract: { contract: 'common.document/flow-metadata', major: 1 },
        pin: { providerId: 'blizzard/sc2-bank' },
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      } as never,
      grant,
    })
    expect(run.result.state).toBe('resolved')
    expect(typeof run.activation.module['createCodec']).toBe('function')
  })

  it('commits native edit.content through the file backend, then commits a resolved writer no-op and reopens both', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-bank-m2-'))
    const path = join(scratch, 'Progress.SC2Bank')
    writeFileSync(path, original)
    const host = await createModkit({ extensions: [extension], roots: [scratch] })
    const backend = createFileEditingBackend({ roots: [scratch] })
    const live: { dispose(): Promise<void> }[] = []
    try {
      const open = async () => {
        const result = await host.services.open({
          source: await openFileArtifactSource(path),
          path,
          intent: 'full',
          grant,
          budget,
        })
        expect(result.state, show(result)).toBe('opened')
        if (result.state !== 'opened') throw new Error('Bank did not open')
        expect(result.selected.contributionId).toBe('blizzard/sc2-bank')
        live.push(result.session)
        return result
      }
      const opened = await open()
      const evidenceFor = (identity: any) =>
        ({
          roundTrip: 'byte-identical',
          preservesUnknownData: true,
          evidenceId: 'sc2-bank-m2-host-fixture',
          corpusId: 'sc2-bank-native-host',
          corpusDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
          conformanceProfile: 'modkit/codec-contribution-v1',
          writer: identity,
          optionsFingerprint: 'bank-m2-raw-preserving',
          inputClass: 'unsigned-sc2-bank',
          provenAt: '2026-09-04T00:00:00Z',
        }) as const
      const editing = createSubjectEditing({
        opened,
        grant,
        backendFor: () => backend,
        evidenceFor: () =>
          evidenceFor({
            providerId: 'blizzard/sc2-bank',
            providerVersion: '1.0.0',
            artifactDigest: host.services.inventory.extensions[0]?.contributions.find(
              item => item.manifest?.id === 'blizzard/sc2-bank',
            )?.record?.artifactDigest,
            formatId: 'sc2-bank',
            representationId: 'source',
          }) as never,
      })
      const invocation = await opened.session
        .operations()
        .invoke('patch-value', { section: 'S', key: 'K', type: 'int', value: '42' })
      expect(invocation.state, show(invocation)).toBe('ok')
      if (invocation.state !== 'ok') throw new Error('Native patch did not run')
      const plan = editing.planFromOperation(invocation.output)
      const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      expect(prepared.state, show(prepared)).toBe('ready')
      if (prepared.state !== 'ready') throw new Error('Patch did not prepare')
      expect(
        (await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot }))
          .state,
      ).toBe('committed')
      expect(readFileSync(path, 'utf8')).toBe(original.replace("int='7'", "int='42'"))
      const reopened = await open()
      const raw = await reopened.session.operations().invoke('export-raw', {})
      expect(raw).toMatchObject({
        state: 'ok',
        output: { kind: 'bytes', value: new Uint8Array(readFileSync(path)) },
      })

      if (host.services.serviceDefinitions === undefined)
        throw new Error('Missing service definitions')
      const resolver = createHostServiceResolver({
        inventory: host.services.inventory,
        target: host.services.target,
        executionBackends: host.services.executionBackends,
        definitions: host.services.serviceDefinitions,
        grant,
        budgets: budget,
      })
      const lease = await resolver.port.resolve({
        contract: 'common.edit/writer',
        major: 1,
        facet: {
          formatId: 'sc2-bank',
          representationId: 'source',
          mutationMode: 'mutate',
          minimumRoundTrip: 'byte-identical',
        },
      })
      try {
        const writer = lease.value as any
        expect(writer.offer.providerId).toBe('blizzard/sc2-authored-text-writers')
        const writerEditing = createSubjectEditing({
          opened: reopened,
          grant,
          writer,
          backendFor: () => backend,
          evidenceFor: () => evidenceFor(writer.identity) as never,
        })
        if (writerEditing.session === undefined) throw new Error('Missing writer session')
        const target = writerEditing.targets[0]!
        const bytes = new Uint8Array(readFileSync(path))
        const change = {
          targets: writerEditing.targets,
          edits: [
            {
              operation: 'replace',
              targetId: target.targetId,
              source: target.ownerSource,
              payload: { kind: 'inline', bytes },
            },
          ],
          semanticIntent: {
            kind: 'sc2-authored-text-save-v1',
            formatId: 'sc2-bank',
            sourceComplete: true,
            unknownDataPolicy: 'preserve-from-complete-snapshot',
            originalSignaturePresent: false,
          },
        } as const
        expect(await writerEditing.session.propose(change)).toMatchObject({ valid: true })
        const writerPlan = await writerEditing.session.plan(change)
        const noop = await writerEditing.coordinator.prepare(writerPlan, {
          grant: writerEditing.grantSnapshot,
        })
        expect(noop.state, show(noop)).toBe('ready')
        if (noop.state !== 'ready') throw new Error('Writer did not prepare')
        expect(
          (
            await writerEditing.coordinator.commit(noop.prepared, {
              grant: writerEditing.grantSnapshot,
            })
          ).state,
        ).toBe('committed')
        expect(new Uint8Array(readFileSync(path))).toEqual(bytes)
        expect((await open()).descriptor.metadata).toEqual(reopened.descriptor.metadata)
      } finally {
        await lease.release()
      }
    } finally {
      for (const session of live) await session.dispose()
      await backend.dispose()
      await host.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 30_000)
})
