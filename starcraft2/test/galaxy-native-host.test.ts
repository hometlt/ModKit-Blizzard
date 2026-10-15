import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSubjectEditing, createHostServiceResolver } from '@modkit/host'
import { createFileEditingBackend, createModkit, openFileArtifactSource } from '@modkit/host/node'
import { runMinimalHost } from '@modkit/testkit'
import {
  createExtensionPackageSnapshot,
  type ExtensionPackageSnapshot,
} from './extension-package-snapshot.js'

const extensionSource = resolve(import.meta.dirname, '..')
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}
const grant = { id: 'galaxy-m5-write', classes: ['read-source', 'write-source'] } as const
const source = 'int Add(int a, int b) { return a + b; }\n'
const show = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))

describe('Galaxy native host and writer surface', () => {
  let extensionSnapshot: ExtensionPackageSnapshot
  let extension = ''

  beforeAll(() => {
    extensionSnapshot = createExtensionPackageSnapshot(extensionSource, 'galaxy-extension-')
    extension = extensionSnapshot.path
  })

  afterAll(() => extensionSnapshot.dispose())

  it('activates the compiled partial contribution through the minimal installed host', async () => {
    const run = await runMinimalHost({
      extensionDirs: [extension],
      extensionExecution: { origin: 'installed', allowTrustedInProcess: true },
      request: {
        contract: { contract: 'common.document/flow-metadata', major: 1 },
        pin: { providerId: 'blizzard/galaxy' },
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      } as never,
      grant,
    })
    expect(run.result.state).toBe('resolved')
    expect(typeof run.activation.module['createCodec']).toBe('function')
  })

  it('routes, validates, commits a resolved writer no-op and reopens byte-identically', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'galaxy-m5-'))
    const path = join(scratch, 'MapScript.galaxy')
    writeFileSync(path, source)
    const host = await createModkit({ extensions: [extension], roots: [scratch] })
    const backend = createFileEditingBackend({ roots: [scratch] })
    const sessions: { dispose(): Promise<void> }[] = []
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
        if (result.state !== 'opened') throw new Error('Galaxy did not open')
        expect(result.selected.contributionId).toBe('blizzard/galaxy')
        sessions.push(result.session)
        return result
      }
      const opened = await open()
      expect(await opened.session.operations().invoke('validate', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json' },
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
          formatId: 'galaxy',
          representationId: 'source',
          mutationMode: 'mutate',
          minimumRoundTrip: 'byte-identical',
        },
      })
      try {
        const writer = lease.value as any
        expect(writer.offer.providerId).toBe('blizzard/sc2-authored-text-writers')
        const editing = createSubjectEditing({
          opened,
          grant,
          writer,
          backendFor: () => backend,
          evidenceFor: () =>
            ({
              roundTrip: 'byte-identical',
              preservesUnknownData: true,
              evidenceId: 'galaxy-m5-host-fixture',
              corpusId: 'galaxy-native-host',
              corpusDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
              conformanceProfile: 'modkit/codec-contribution-v1',
              writer: writer.identity,
              optionsFingerprint: 'galaxy-m5-no-op',
              inputClass: 'loose-galaxy-source',
              provenAt: '2026-09-05T00:00:00Z',
            }) as never,
        })
        if (editing.session === undefined) throw new Error('Missing writer session')
        const target = editing.targets[0]!
        const bytes = new Uint8Array(readFileSync(path))
        const change = {
          targets: editing.targets,
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
            formatId: 'galaxy',
            sourceComplete: true,
            unknownDataPolicy: 'preserve-from-complete-snapshot',
          },
        } as const
        expect(await editing.session.propose(change)).toMatchObject({ valid: true })
        const plan = await editing.session.plan(change)
        const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
        expect(prepared.state, show(prepared)).toBe('ready')
        if (prepared.state !== 'ready') throw new Error('Writer did not prepare')
        expect(
          (await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot }))
            .state,
        ).toBe('committed')
        expect(new Uint8Array(readFileSync(path))).toEqual(bytes)
        const reopened = await open()
        expect(reopened.descriptor.metadata).toEqual(opened.descriptor.metadata)
      } finally {
        await lease.release()
      }
    } finally {
      for (const session of sessions) await session.dispose()
      await backend.dispose()
      await host.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
