import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  buildInventory,
  createEvidenceRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createRawWriter,
  createSubjectEditing,
  openSubject,
} from '@modkit/host'
import {
  createFileEditingBackend,
  loadExtensionDirectory,
  openFileArtifactSource,
} from '@modkit/host/node'
import { revisionId, type ArtifactByteSource } from '@modkit/sdk'
import { createCodec as createMpqCodec } from '../../mpq/src/mpq/codec.js'
import { encodeFreshMpq } from '../../mpq/src/mpq/fresh-writer.js'

const encoder = new TextEncoder()
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 10_000,
  maxScalarBytes: 8_388_608,
  maxDiagnostics: 100,
  deadlineMs: 10_000,
}

function heightGrid() {
  const bytes = new Uint8Array(32 + 4 * 6)
  bytes.set(encoder.encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  for (let index = 0; index < 4; index += 1) view.setUint16(32 + index * 6, 100 + index, true)
  return bytes
}

function sourceFor(bytes: Uint8Array, name: string, revisionLabel: string): ArtifactByteSource {
  const uri = `memory://sc2-container-composition/${name}`
  return Object.freeze({
    kind: 'bytes' as const,
    ref: Object.freeze({ id: uri, uri }),
    revision: revisionId(revisionLabel),
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  })
}

function inputFor(source: ArtifactByteSource) {
  return {
    originKind: 'single' as const,
    bindings: [
      {
        sourceKind: 'candidate' as const,
        bindingId: 'content',
        role: 'content',
        ownership: 'owned' as const,
        source: source.ref,
        revision: source.revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision: source.revision,
      bindings: [{ bindingId: 'content', revision: source.revision }],
      compositionFingerprint: `sc2-composition:${source.revision}`,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

async function buildHostHarness() {
  const roots = [join(import.meta.dirname, '..', '..', 'mpq'), join(import.meta.dirname, '..')]
  const extensions = await Promise.all(
    roots.map(async root => ({
      ...(await loadExtensionDirectory(root)),
      execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
    })),
  )
  const inventory = await buildInventory(extensions, createHostContributionContractRegistry())
  const executionBackends = createExecutionBackendRegistry([
    {
      profile: 'trusted-in-process',
      supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
      async activate(context) {
        return {
          module: (await import(context.entrypoint.href)) as Record<string, unknown>,
          release: async () => undefined,
        }
      },
    },
  ])
  return { inventory, executionBackends }
}

let cachedHost: ReturnType<typeof buildHostHarness> | undefined
const hostHarness = () => (cachedHost ??= buildHostHarness())

describe('host-composed packed SC2 map', () => {
  it('selects all packed SC2 aliases through their MPQ namespaces', async () => {
    const cases = [
      {
        name: 'Package.SC2Mod',
        contributionId: 'blizzard/sc2-mod',
        formatId: 'sc2-mod',
        entries: [
          { path: 'ComponentList.SC2Components', bytes: encoder.encode('<Components/>') },
          { path: 'DocumentHeader', bytes: encoder.encode('<Header/>') },
          { path: 'DocumentInfo', bytes: encoder.encode('<DocInfo/>') },
          { path: 'Base.SC2Data/GameData/UnitData.xml', bytes: encoder.encode('<Catalog/>') },
        ],
      },
      {
        name: 'Story.SC2Campaign',
        contributionId: 'blizzard/sc2-campaign',
        formatId: 'sc2-campaign',
        entries: [
          { path: 'ComponentList.SC2Components', bytes: encoder.encode('<Components/>') },
          { path: 'CampaignData', bytes: encoder.encode('<Campaign/>') },
          { path: 'Base.SC2Maps/MapA.SC2Map', bytes: encoder.encode('nested-map') },
        ],
      },
      {
        name: 'Match.SC2Replay',
        contributionId: 'blizzard/sc2-replay',
        formatId: 'sc2-replay',
        entries: [
          { path: 'replay.details', bytes: encoder.encode('details') },
          { path: 'replay.initData', bytes: encoder.encode('init') },
          { path: 'replay.attributes.events', bytes: encoder.encode('attributes') },
          { path: 'replay.game.events', bytes: encoder.encode('game') },
          { path: 'replay.message.events', bytes: encoder.encode('message') },
          { path: 'replay.tracker.events', bytes: encoder.encode('tracker') },
        ],
      },
    ]
    const host = await hostHarness()
    for (const item of cases) {
      const bytes = encodeFreshMpq(item.entries)
      const source = sourceFor(
        bytes,
        item.name,
        `content-hash.sha256:sc2-container-composition-${item.formatId}`,
      )
      const opened = await openSubject({
        ...host,
        source,
        path: item.name,
        intent: 'full',
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
        grant: { id: 'sc2-container-composition-read', classes: ['read-source'] },
        budget,
      })
      if (opened.state !== 'opened') {
        throw new Error(`${item.name} composition did not open: ${opened.reason}`)
      }
      try {
        expect(opened.selected.contributionId).toBe(item.contributionId)
        expect(opened.descriptor).toMatchObject({
          origin: { kind: 'namespace' },
          identity: { formatId: item.formatId },
        })
        const inspected = await opened.session.operations().invoke('inspect', {})
        expect(inspected.state).toBe('ok')
        const exported = await opened.session.operations().invoke('export-raw', null)
        expect(exported.state).toBe('ok')
        if (exported.state !== 'ok' || exported.output.kind !== 'bytes') {
          throw new Error(`${item.name} export.raw did not return bytes`)
        }
        expect(exported.output.value).toEqual(bytes)
      } finally {
        await opened.session.dispose()
      }
    }
  })

  it('selects the namespace alias, delegates raw export, and packs an entry edit', async () => {
    const original = encodeFreshMpq([
      { path: 'MapInfo', bytes: encoder.encode('<MapInfo/>') },
      { path: 'Objects', bytes: encoder.encode('<PlacedObjects/>') },
      { path: 'Regions', bytes: encoder.encode('<Regions/>') },
      { path: 't3HeightMap', bytes: heightGrid() },
    ])
    const source = sourceFor(
      original,
      'Portable.SC2Map',
      'content-hash.sha256:sc2-container-composition-source',
    )
    const host = await hostHarness()
    const opened = await openSubject({
      ...host,
      source,
      path: 'Portable.SC2Map',
      intent: 'full',
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'sc2-container-composition', classes: ['read-source', 'write-source'] },
      budget,
    })
    if (opened.state !== 'opened') {
      throw new Error(`SC2 map composition did not open: ${opened.reason}`)
    }
    try {
      expect(opened.selected.contributionId).toBe('blizzard/sc2-map')
      expect(opened.descriptor).toMatchObject({
        origin: { kind: 'namespace' },
        identity: { formatId: 'sc2-map' },
      })

      const exported = await opened.session.operations().invoke('export-raw', null)
      expect(exported.state).toBe('ok')
      if (exported.state !== 'ok' || exported.output.kind !== 'bytes') {
        throw new Error('composed export.raw did not return bytes')
      }
      expect(exported.output.value).toEqual(original)

      const preview = await opened.session.operations().invoke('thumbnail', { layer: 'height' })
      expect(preview.state).toBe('ok')
      if (preview.state !== 'ok' || preview.output.kind !== 'bytes') {
        throw new Error('composed map preview did not return bytes')
      }
      expect([...preview.output.value.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10,
      ])

      const edited = await opened.session.operations().invoke('edit-world', {
        expectedSourceRevision: String(source.revision),
        edits: [{ kind: 'terrain.cell.set', x: 1, y: 0, heightBase: 444 }],
      })
      expect(edited.state).toBe('ok')
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') {
        throw new Error('composed map edit did not return the outer plan')
      }
      expect(edited.output.plan.edits).toHaveLength(1)
      const outerEdit = edited.output.plan.edits[0]
      expect(outerEdit).toMatchObject({ operation: 'replace', source: source.ref })
      if (outerEdit.operation !== 'replace' || outerEdit.payload.kind !== 'inline') {
        throw new Error('composed map edit did not contain inline outer bytes')
      }

      const outputSource = sourceFor(
        outerEdit.payload.bytes,
        'Output.SC2Map',
        'content-hash.sha256:sc2-container-composition-output',
      )
      const mpq = await (await createMpqCodec()).open(inputFor(outputSource), 'full', budget)
      try {
        const extracted = await mpq.operations().invoke('extract-entry', {
          entryId: 't3HeightMap',
        })
        expect(extracted.state).toBe('ok')
        if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
          throw new Error('packed map output did not reopen')
        }
        expect(new DataView(extracted.output.value.buffer).getUint16(32 + 6, true)).toBe(444)
      } finally {
        await mpq.dispose()
      }
    } finally {
      await opened.session.dispose()
    }
  })

  it('commits a raw-writer no-op byte-identically, then atomically saves and reopens a semantic change', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-map-composed-host-'))
    const path = join(scratch, 'Atomic.SC2Map')
    const original = encodeFreshMpq([
      { path: 'MapInfo', bytes: encoder.encode('<MapInfo/>') },
      {
        path: 'Objects',
        bytes: encoder.encode(
          '<PlacedObjects><ObjectUnit Id="1" UnitType="Marine" Position="1,2,3"/></PlacedObjects>',
        ),
      },
      { path: 'Regions', bytes: encoder.encode('<Regions/>') },
      { path: 'Preload', bytes: encoder.encode('<Preload><Unit id="Marine"/></Preload>') },
      { path: 't3HeightMap', bytes: heightGrid() },
    ])
    writeFileSync(path, original)
    const backend = createFileEditingBackend({ roots: [scratch] })
    const sessions: { dispose(): Promise<void> }[] = []
    const host = await hostHarness()
    const grant = {
      id: 'sc2-container-composition-persistence',
      classes: ['read-source', 'write-source'],
    } as const
    try {
      const open = async () => {
        const source = await openFileArtifactSource(path)
        const opened = await openSubject({
          ...host,
          source,
          path,
          intent: 'full',
          target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
          grant,
          budget,
        })
        if (opened.state !== 'opened') {
          throw new Error(`SC2 map persistence fixture did not open: ${opened.reason}`)
        }
        expect(opened.selected.contributionId).toBe('blizzard/sc2-map')
        sessions.push(opened.session)
        return { source, opened }
      }
      const commit = async (
        opened: Awaited<ReturnType<typeof open>>['opened'],
        output: Parameters<ReturnType<typeof createSubjectEditing>['planFromOperation']>[0],
      ) => {
        const editing = createSubjectEditing({
          opened,
          grant,
          backendFor: () => backend,
          evidenceFor: () => ({
            roundTrip: 'semantic',
            preservesUnknownData: true,
            evidenceId: 'sc2-map-composed-host-persistence-v1',
            corpusId: 'sc2-packed-container-composition-host',
            corpusDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
            conformanceProfile: 'modkit/codec-contribution-v1',
            writer: {
              providerId: 'blizzard/sc2-map',
              providerVersion: '1.0.0',
              artifactDigest: 'x3:blizzard/sc2-map@composed-host-proof',
              formatId: 'sc2-map',
              representationId: 'archive-namespace',
            },
            optionsFingerprint: 'semantic-world-composed-host-v1',
            inputClass: 'complete-named-mpq-v0-map',
            provenAt: '2026-09-05T00:00:00Z',
          }) as never,
        })
        const prepared = await editing.coordinator.prepare(editing.planFromOperation(output), {
          grant: editing.grantSnapshot,
        })
        expect(prepared.state).toBe('ready')
        if (prepared.state !== 'ready') throw new Error('Composed host plan did not prepare')
        const committed = await editing.coordinator.commit(prepared.prepared, {
          grant: editing.grantSnapshot,
        })
        expect(committed.state).toBe('committed')
        if (committed.state !== 'committed') throw new Error('Composed host plan did not commit')
        return committed.receipt
      }

      const first = await open()
      const outerContainer = await (await createMpqCodec()).open(inputFor(first.source), 'full', budget)
      sessions.push(outerContainer)
      const rawWriter = createRawWriter()
      const rawEvidence = createEvidenceRegistry()
      const noOpEditing = createSubjectEditing({
        opened: { descriptor: await outerContainer.descriptor() } as never,
        grant,
        writer: rawWriter,
        backendFor: () => backend,
        evidenceFor: plan => rawEvidence.evidenceFor(plan, rawWriter.identity),
      })
      if (noOpEditing.session === undefined) throw new Error('Raw no-op writer session is missing')
      const noOpTarget = noOpEditing.targets[0]
      if (noOpTarget === undefined) throw new Error('Raw no-op writer target is missing')
      const noOpChange = {
        targets: noOpEditing.targets,
        edits: [
          {
            operation: 'replace',
            targetId: noOpTarget.targetId,
            source: noOpTarget.ownerSource,
            payload: { kind: 'inline', bytes: original },
          },
        ],
      } as const
      expect(await noOpEditing.session.propose(noOpChange)).toMatchObject({ valid: true })
      const noOpPlan = await noOpEditing.session.plan(noOpChange)
      const noOpPrepared = await noOpEditing.coordinator.prepare(noOpPlan, {
        grant: noOpEditing.grantSnapshot,
      })
      expect(
        noOpPrepared.state,
        JSON.stringify(noOpPrepared, (_key, value) =>
          typeof value === 'bigint' ? String(value) : value,
        ),
      ).toBe('ready')
      if (noOpPrepared.state !== 'ready') throw new Error('Raw no-op writer did not prepare')
      const noOpCommitted = await noOpEditing.coordinator.commit(noOpPrepared.prepared, {
        grant: noOpEditing.grantSnapshot,
      })
      expect(noOpCommitted.state).toBe('committed')
      if (noOpCommitted.state !== 'committed') throw new Error('Raw no-op writer did not commit')
      const noOpReceipt = noOpCommitted.receipt
      expect(noOpReceipt.commitGuarantee).toBe('atomic')
      expect(new Uint8Array(readFileSync(path))).toEqual(original)

      const second = await open()
      const changedContainer = await (await createMpqCodec()).open(
        inputFor(second.source),
        'full',
        budget,
      )
      sessions.push(changedContainer)
      const changed = await second.opened.session.operations().invoke('edit-world', {
        expectedSourceRevision: String(second.source.revision),
        edits: [{ kind: 'terrain.cell.set', x: 1, y: 0, heightBase: 444 }],
      })
      expect(changed.state).toBe('ok')
      if (changed.state !== 'ok' || changed.output.kind !== 'edit-plan') {
        throw new Error('Composed host changed edit did not return edit-plan')
      }
      expect(changed.output.plan.edits).toHaveLength(1)
      const changedReceipt = await commit(
        { descriptor: await changedContainer.descriptor() } as never,
        changed.output,
      )
      expect(changedReceipt.commitGuarantee).toBe('atomic')
      expect(new Uint8Array(readFileSync(path))).not.toEqual(original)

      const third = await open()
      const extracted = await third.opened.session.operations().invoke('extract-entry', {
        entryId: 't3HeightMap',
      })
      expect(extracted.state).toBe('ok')
      if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
        throw new Error('Composed host changed map did not reopen')
      }
      expect(new DataView(extracted.output.value.buffer).getUint16(32 + 6, true)).toBe(444)
    } finally {
      for (const session of sessions) await session.dispose()
      await backend.dispose()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
