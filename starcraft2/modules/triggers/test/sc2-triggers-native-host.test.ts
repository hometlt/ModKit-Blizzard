import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHostServiceResolver, createSubjectEditing } from '@modkit/host'
import { createFileEditingBackend, createModkit, openFileArtifactSource } from '@modkit/host/node'
import { runMinimalHost } from '@modkit/testkit'
import {
  createExtensionPackageSnapshot,
  type ExtensionPackageSnapshot,
} from '../../../test/extension-package-snapshot.js'

const extensionSource = resolve(import.meta.dirname, '..', '..', '..')
const original = new TextEncoder().encode(`<TriggerData>
  <Standard Id="TEST"/>
  <Element Type="Param" Id="UNIT">
    <Value>Marine</Value>
    <ValueType Type="gamelink"/>
    <ValueGameType Type="Unit"/>
  </Element>
</TriggerData>
`)
const changed = new TextEncoder().encode(new TextDecoder().decode(original).replace('Marine', 'Marauder'))
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}
const grant = { id: 'sc2-triggers-m5-write', classes: ['read-source', 'write-source'] } as const

describe('SC2 TriggerData installed host and writer surface', () => {
  let scratch = ''
  let extensionSnapshot: ExtensionPackageSnapshot
  let extension = ''
  let sourcePath = ''
  let host: Awaited<ReturnType<typeof createModkit>>
  let backend: ReturnType<typeof createFileEditingBackend>

  beforeAll(async () => {
    // The host intentionally rejects an artifact whose files change after inventory. Test the
    // installed shape from an immutable package snapshot instead of the live checkout: unrelated
    // tests and parallel agents are allowed to edit that checkout while this suite is running.
    extensionSnapshot = createExtensionPackageSnapshot(extensionSource, 'sc2-triggers-extension-')
    extension = extensionSnapshot.path

    scratch = mkdtempSync(join(tmpdir(), 'sc2-triggers-m5-'))
    sourcePath = join(scratch, 'Test.SC2Mod', 'Triggers')
    mkdirSync(dirname(sourcePath), { recursive: true })
    writeFileSync(sourcePath, original)
    host = await createModkit({ extensions: [extension], roots: [scratch] })
    backend = createFileEditingBackend({ roots: [scratch] })
  })

  afterAll(async () => {
    await backend.dispose()
    await host.close()
    rmSync(scratch, { recursive: true, force: true })
    extensionSnapshot.dispose()
  })

  beforeEach(() => {
    writeFileSync(sourcePath, original)
  })

  async function open() {
    const result = await host.services.open({
      source: await openFileArtifactSource(sourcePath),
      path: sourcePath,
      intent: 'full',
      grant,
      budget,
    })
    expect(result.state, `SC2 TriggerData open result: ${JSON.stringify(result)}`).toBe('opened')
    if (result.state !== 'opened') throw new Error('SC2 TriggerData did not open')
    expect(result.selected.contributionId).toBe('blizzard/sc2-triggers')
    return result
  }

  async function commit(
    opened: any,
    operation: any,
    evidenceId: string,
    expected: 'committed' | 'conflict' = 'committed',
  ) {
    if (operation.state !== 'ok' || operation.output.kind !== 'edit-plan') {
      throw new Error('SC2 TriggerData edit did not yield an edit plan')
    }
    if (host.services.serviceDefinitions === undefined) throw new Error('writer definitions missing')
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
        formatId: 'sc2-triggers',
        representationId: 'source',
        mutationMode: 'mutate',
        minimumRoundTrip: 'byte-identical',
      },
    })
    try {
      const editing = createSubjectEditing({
        opened,
        grant,
        writer: lease.value as any,
        backendFor: () => backend,
        evidenceFor: () => ({
          roundTrip: 'byte-identical',
          preservesUnknownData: true,
          evidenceId,
          corpusId: 'sc2-triggers-native-host',
          corpusDigest: `sha256:${createHash('sha256').update(readFileSync(sourcePath)).digest('hex')}`,
          conformanceProfile: 'modkit/codec-contribution-v1',
          writer: (lease.value as any).identity,
          optionsFingerprint: evidenceId,
          inputClass: 'authored-trigger-data',
          provenAt: '2026-09-05T00:00:00Z',
        }) as never,
      })
      const prepared = await editing.coordinator.prepare(
        editing.planFromOperation(operation.output),
        { grant: editing.grantSnapshot },
      )
      if (expected === 'conflict') {
        expect(prepared.state).toBe('conflict')
        return
      }
      expect(prepared.state).toBe('ready')
      if (prepared.state !== 'ready') throw new Error('SC2 TriggerData writer did not prepare')
      expect(
        (await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })).state,
      ).toBe('committed')
    } finally {
      await lease.release()
    }
  }

  it('commits the revision-pinned changed edit and reopens its semantic value', async () => {
    const opened = await open()
    try {
      await commit(opened, await opened.session.operations().invoke('rename-gamelinks', {
        renames: [{ catalog: 'Unit', oldId: 'Marine', newId: 'Marauder' }],
      }), 'sc2-triggers-m5-change')
      expect(new Uint8Array(readFileSync(sourcePath))).toEqual(changed)
    } finally {
      await opened.session.dispose()
    }
    const reopened = await open()
    try {
      expect(await reopened.session.operations().invoke('search', { query: 'Marauder' }))
        .toMatchObject({ state: 'ok', output: { kind: 'json' } })
    } finally {
      await reopened.session.dispose()
    }
  })

  it('commits a byte-identical no-op and reopens with identical bytes', async () => {
    writeFileSync(sourcePath, changed)
    const before = new Uint8Array(readFileSync(sourcePath))
    const opened = await open()
    try {
      await commit(opened, await opened.session.operations().invoke('rename-gamelinks', {
        renames: [{ catalog: 'Unit', oldId: 'Marine', newId: 'Marauder' }],
      }), 'sc2-triggers-m5-no-op')
    } finally {
      await opened.session.dispose()
    }
    expect(new Uint8Array(readFileSync(sourcePath))).toEqual(before)
    const reopened = await open()
    try {
      const raw = await reopened.session.operations().invoke('export-raw', {})
      expect(raw).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: before } })
    } finally {
      await reopened.session.dispose()
    }
  })

  it('commits a structural parameter update through the registered MK3 writer', async () => {
    const opened = await open()
    try {
      await commit(opened, await opened.session.operations().invoke('parameter-update', {
        element: { id: 'UNIT', type: 'Param' },
        value: 'Marauder',
      }), 'sc2-triggers-m5-parameter-update')
      expect(new Uint8Array(readFileSync(sourcePath))).toEqual(changed)
    } finally {
      await opened.session.dispose()
    }
    const reopened = await open()
    try {
      expect(await reopened.session.operations().invoke('element-get', { id: 'UNIT', type: 'Param' }))
        .toMatchObject({ state: 'ok', output: { kind: 'json', value: {
          source: expect.stringContaining('<Value>Marauder</Value>'),
        } } })
    } finally {
      await reopened.session.dispose()
    }
  })

  it('rejects a revision-pinned edit after the source changes outside the session', async () => {
    const opened = await open()
    const operation = await opened.session.operations().invoke('rename-gamelinks', {
      renames: [{ catalog: 'Unit', oldId: 'Marine', newId: 'Marauder' }],
    })
    const externallyChanged = new TextEncoder().encode(
      new TextDecoder().decode(original).replace('Marine', 'Zergling'),
    )
    writeFileSync(sourcePath, externallyChanged)
    try {
      await commit(opened, operation, 'sc2-triggers-m5-stale-revision', 'conflict')
      expect(new Uint8Array(readFileSync(sourcePath))).toEqual(externallyChanged)
    } finally {
      await opened.session.dispose()
    }
  })

  it('activates the compiled contribution through the installed minimal host', async () => {
    const minimal = await runMinimalHost({
      extensionDirs: [extension],
      extensionExecution: { origin: 'installed', allowTrustedInProcess: true },
      request: {
        contract: { contract: 'common.document/flow-metadata', major: 1 },
        pin: { providerId: 'blizzard/sc2-triggers' },
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      } as never,
      grant,
    })
    expect(minimal.result.state).toBe('resolved')
    expect(typeof minimal.activation.module['createCodec']).toBe('function')
  })
})
