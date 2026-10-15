import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
const grant = { id: 'sc2-layout-m5-write', classes: ['read-source', 'write-source'] } as const
const xml = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <!--unknown-preserved-->
  <Frame type="Button" name="Close">
    <Shortcut val="@Button/Hotkey/Cancel"/>
  </Frame>
</Desc>
`
const show = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))

async function writerFor(host: Awaited<ReturnType<typeof createModkit>>) {
  if (host.services.serviceDefinitions === undefined) throw new Error('Missing service definitions')
  const resolver = createHostServiceResolver({
    inventory: host.services.inventory,
    target: host.services.target,
    executionBackends: host.services.executionBackends,
    definitions: host.services.serviceDefinitions,
    grant,
    budgets: budget,
  })
  return resolver.port.resolve({
    contract: 'common.edit/writer',
    major: 1,
    facet: {
      formatId: 'sc2-layout',
      representationId: 'source',
      mutationMode: 'mutate',
      minimumRoundTrip: 'byte-identical',
    },
  })
}

describe('SC2Layout native host and writer surface', () => {
  it('activates the compiled partial contribution through the minimal native host', async () => {
    const run = await runMinimalHost({
      extensionDirs: [extension],
      extensionExecution: { origin: 'installed', allowTrustedInProcess: true },
      request: {
        contract: { contract: 'common.document/flow-metadata', major: 1 },
        pin: { providerId: 'blizzard/sc2-layout' },
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      } as never,
      grant,
    })
    expect(run.result.state).toBe('resolved')
    expect(typeof run.activation.module['createCodec']).toBe('function')
  })

  it('opens, commits a byte-identical writer no-op and reopens through host routing', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-layout-m5-noop-'))
    const path = join(scratch, 'Base.SC2Data', 'UI', 'Layout', 'Test.SC2Layout')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, xml)
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
        if (result.state !== 'opened') throw new Error('SC2Layout did not open')
        expect(result.selected.contributionId).toBe('blizzard/sc2-layout')
        sessions.push(result.session)
        return result
      }
      const opened = await open()
      const original = new Uint8Array(readFileSync(path))
      const lease = await writerFor(host)
      try {
        const writer = lease.value as any
        expect(writer.offer.providerId).toBe('blizzard/sc2-authored-text-writers')
        const editing = createSubjectEditing({
          opened,
          grant,
          writer,
          backendFor: () => backend,
          evidenceFor: () => ({
            roundTrip: 'byte-identical',
            preservesUnknownData: true,
            evidenceId: 'sc2-layout-m5-host-noop',
            corpusId: 'sc2-layout-native-host',
            corpusDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
            conformanceProfile: 'modkit/codec-contribution-v1',
            writer: writer.identity,
            optionsFingerprint: 'sc2-layout-m5-no-op',
            inputClass: 'loose-sc2-layout-xml',
            provenAt: '2026-09-05T00:00:00Z',
          }) as never,
        })
        if (editing.session === undefined) throw new Error('Missing writer session')
        const target = editing.targets[0]!
        const change = {
          targets: editing.targets,
          edits: [
            {
              operation: 'replace',
              targetId: target.targetId,
              source: target.ownerSource,
              payload: { kind: 'inline', bytes: original },
            },
          ],
          semanticIntent: {
            kind: 'sc2-authored-text-save-v1',
            formatId: 'sc2-layout',
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
        expect(new Uint8Array(readFileSync(path))).toEqual(original)
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

  it('edits a complete snapshot, saves it atomically and reopens the changed layout', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-layout-m5-edit-'))
    const path = join(scratch, 'Base.SC2Data', 'UI', 'Layout', 'Test.SC2Layout')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, xml)
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
        if (result.state !== 'opened') throw new Error('SC2Layout did not open')
        sessions.push(result.session)
        return result
      }
      const opened = await open()
      const lease = await writerFor(host)
      try {
        const writer = lease.value as any
        const editedText = xml.replace('Cancel', 'Confirm')
        const editedBytes = new TextEncoder().encode(editedText)
        const editing = createSubjectEditing({
          opened,
          grant,
          writer,
          backendFor: () => backend,
          evidenceFor: () => ({
            roundTrip: 'byte-identical',
            preservesUnknownData: true,
            evidenceId: 'sc2-layout-m5-host-edit',
            corpusId: 'sc2-layout-native-host',
            corpusDigest: `sha256:${createHash('sha256').update(xml).digest('hex')}`,
            conformanceProfile: 'modkit/codec-contribution-v1',
            writer: writer.identity,
            optionsFingerprint: 'sc2-layout-m5-complete-snapshot',
            inputClass: 'loose-sc2-layout-xml',
            provenAt: '2026-09-05T00:00:00Z',
          }) as never,
        })
        if (editing.session === undefined) throw new Error('Missing writer session')
        const target = editing.targets[0]!
        const change = {
          targets: editing.targets,
          edits: [
            {
              operation: 'replace',
              targetId: target.targetId,
              source: target.ownerSource,
              payload: { kind: 'inline', bytes: editedBytes },
            },
          ],
          semanticIntent: {
            kind: 'sc2-authored-text-save-v1',
            formatId: 'sc2-layout',
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
        expect(readFileSync(path, 'utf8')).toBe(editedText)
        expect(readFileSync(path, 'utf8')).toContain('<!--unknown-preserved-->')

        const reopened = await open()
        const raw = await reopened.session.operations().invoke('export-raw', {})
        expect(raw.state).toBe('ok')
        if (raw.state === 'ok' && raw.output.kind === 'bytes') {
          expect(new TextDecoder().decode(raw.output.value)).toContain(
            '@Button/Hotkey/Confirm',
          )
        }
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
