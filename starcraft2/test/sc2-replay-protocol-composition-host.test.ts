import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
  registerServiceDefinitionsOrThrow,
} from '@modkit/host'
import { loadExtensionDirectory, openFileArtifactSource } from '@modkit/host/node'
import { readFile } from 'node:fs/promises'
import { readReplayDependencySet } from '../modules/replay/services/dependencies/cache-handles.js'

const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxScalarBytes: 8_388_608,
  maxDiagnostics: 100,
  deadlineMs: 30_000,
}

const replayCatalogAnalysis = {
  workspaceId: 'workspace:replay-catalog-enrichment',
  gameId: 'blizzard/starcraft-2',
  documents: [
    {
      rootId: 'workspace',
      path: 'Base.SC2Data/GameData/UnitData.xml',
      text: `<Catalog>
        <CUnit id="SCV"><FlagArray index="Worker" value="1"/><CostResource index="Minerals" value="50"/></CUnit>
        <CUnit id="Marine"><WeaponArray index="0" Link="GaussRifle"/><CostResource index="Minerals" value="50"/></CUnit>
        <CAbilMove id="Move"/>
      </Catalog>`,
      revision: 'sha256:replay-catalog-enrichment',
    },
  ],
  localizationDocuments: [],
  locales: [],
  localizationKeys: [],
  queries: [],
  maxDocuments: 4,
  maxTextBytes: 32_768,
  maxEntities: 64,
  maxDepth: 16,
  plannedDocumentCount: 1,
  unresolvedRequirementIds: [],
}

async function harness() {
  const roots = [
    join(import.meta.dirname, '..', '..', 'blizzard-common-formats'),
    join(import.meta.dirname, '..', '..', 'mpq'),
    join(import.meta.dirname, '..'),
  ]
  const extensions = await Promise.all(
    roots.map(async root => ({
      ...(await loadExtensionDirectory(root)),
      execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
    })),
  )
  const inventory = await buildInventory(extensions, createHostContributionContractRegistry())
  const serviceDefinitions = createBundledServiceDefinitionRegistry()
  await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
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
  const target = { environment: 'node' as const, operatingSystem: 'windows' as const, architecture: 'x64' as const }
  return { inventory, serviceDefinitions, executionBackends, target }
}

async function openReplayPath(
  path: string,
  name: string,
  extra: Pick<Parameters<typeof openSubject>[0], 'subjectCatalog'> = {},
) {
  const host = await harness()
  const opened = await openSubject({
    ...host,
    ...extra,
    source: await openFileArtifactSource(path),
    path,
    intent: 'full',
    target: host.target,
    grant: { id: `sc2-replay-protocol-${name}`, classes: ['read-source'] },
    budget,
  })
  if (opened.state !== 'opened') throw new Error(`${name} did not open: ${opened.reason}`)
  if (opened.selected.contributionId !== 'blizzard/sc2-replay') {
    await opened.session.dispose()
    throw new Error(`${name} selected ${opened.selected.contributionId}`)
  }
  return { ...opened, host }
}

async function openReplay(name: string) {
  return openReplayPath(
    join(import.meta.dirname, '..', '..', '..', 'references', 'replays', name),
    name,
  )
}

async function openFixtureReplay(name: string) {
  return openReplayPath(join(import.meta.dirname, 'fixtures', 'replays', 'early', name), name)
}

describe.sequential('SC2 replay protocol service through MPQ composition', () => {
  it('exports the whole decoded replay as one JSON document', async () => {
    const path = join(import.meta.dirname, 'fixtures', 'replays', 'Gresvan-LE.SC2Replay')
    const opened = await openReplayPath(path, 'export-json')
    try {
      const exported = await opened.session.operations().invoke('export-convert', {})
      expect(exported.state).toBe('ok')
      if (exported.state !== 'ok' || exported.output.kind !== 'json') throw new Error('export failed')
      const value = exported.output.value as {
        header: unknown
        details: { players: unknown[] }
        timeline: unknown
        streams: { trackerEvents: number }
        dependencies: { dependencies: unknown[] }
      }
      expect(value).toMatchObject({ schemaVersion: 1, codecId: 'blizzard/sc2-replay' })
      expect(value.header).toBeDefined()
      expect(value.details.players.length).toBeGreaterThan(0)
      expect(value.timeline).not.toBeNull()
      expect(value.streams.trackerEvents).toBeGreaterThan(0)
      expect(value.dependencies.dependencies).toHaveLength(12)
    } finally {
      await opened.session.dispose()
    }
  })

  it('asks for the units it fielded and prices them from the mod context the host opens', async () => {
    const path = join(import.meta.dirname, 'fixtures', 'replays', 'Gresvan-LE.SC2Replay')
    const targets: unknown[] = []
    const asked: string[] = []
    let disposed = 0
    // The replay's mod context as the game's loader answers it: every unit costs 50 minerals, and
    // the SCV, Probe and Drone are workers.
    const contentSources = {
      async openModContext(request: { readonly target: unknown }) {
        targets.push(request.target)
        return {
          query: async (question: { readonly refs: readonly { namespace: string; entityId: string }[] }) => ({
            entities: question.refs.map(ref => {
              asked.push(ref.entityId)
              return {
                namespace: ref.namespace,
                entityId: ref.entityId,
                complete: true,
                fields: {
                  CostResource: [{ index: 'Minerals', value: 50 }],
                  ...(['SCV', 'Probe', 'Drone'].includes(ref.entityId)
                    ? { FlagArray: [{ index: 'Worker', value: 1 }] }
                    : {}),
                },
              }
            }),
          }),
          dispose: async () => {
            disposed += 1
          },
        }
      },
    }
    const opened = await openReplayPath(path, 'catalog-questions', {
      subjectCatalog: { contentSources: async () => contentSources as never },
    })
    try {
      const analyzed = await opened.session.operations().invoke('analyze', {})
      expect(analyzed.state).toBe('ok')
      if (analyzed.state !== 'ok' || analyzed.output.kind !== 'json') throw new Error('analysis failed')
      const value = analyzed.output.value as {
        catalogEnrichment?: { units: number; pricedUnits: number }
        catalogQueries?: unknown
      }
      expect(targets).toEqual([path.replaceAll('\\', '/')])
      expect(asked.length).toBeGreaterThan(0)
      expect(value.catalogQueries).toBeUndefined()
      expect(value.catalogEnrichment).toMatchObject({ units: asked.length, pricedUnits: asked.length })
    } finally {
      await opened.session.dispose()
    }
    expect(disposed).toBe(1)
  })
  it('selects the exact protocol and decodes all build-specific streams', async () => {
    const opened = await openReplay('Tokamak LE (9).SC2Replay')
    try {
      const inspected = await opened.session.operations().invoke('inspect', {})
      expect(inspected.state).toBe('ok')
      if (inspected.state !== 'ok' || inspected.output.kind !== 'json')
        throw new Error('inspect failed')
      expect(inspected.output.value).toMatchObject({
        format: 'sc2-replay',
        build: 95299,
        baseBuild: 95299,
        protocolBuild: 95299,
        initDataDecoded: true,
        gameEvents: expect.any(Number),
        messageEvents: expect.any(Number),
        loadInfoWords: expect.any(Number),
        contentDependencies: expect.any(Number),
      })
      expect((inspected.output.value as { contentDependencies: number }).contentDependencies).toBeGreaterThan(0)
      // The mod loader reads the same cache handles to open a replay inside its archives.
      const dependencies = await readReplayDependencySet(
        new Uint8Array(await readFile(join(import.meta.dirname, '..', '..', '..', 'references', 'replays', 'Tokamak LE (9).SC2Replay'))),
      )
      expect(dependencies).toMatchObject({
        schemaVersion: 1,
        gameId: 'blizzard/starcraft-2',
        complete: true,
        dependencies: expect.arrayContaining([
          expect.objectContaining({
            kind: 'content-archive',
            required: true,
            state: 'unresolved',
            handle: expect.objectContaining({ type: 's2ma', region: 'US' }),
          }),
        ]),
        diagnostics: [],
      })
      const loadInfo = await opened.session.operations().invoke('decode-stream', {
        stream: 'replay.load.info',
      })
      expect(loadInfo.state).toBe('ok')
      if (loadInfo.state !== 'ok' || loadInfo.output.kind !== 'json') {
        throw new Error('load-info decode failed')
      }
      expect(loadInfo.output.value).toMatchObject({
        values: expect.any(Array),
        playerSlots: expect.any(Array),
        extraValues: expect.any(Array),
        trailingBytes: expect.any(Array),
        isEmpty: expect.any(Boolean),
      })
      const analyzed = await opened.session.operations().invoke('analyze', {})
      expect(analyzed.state).toBe('ok')
      if (analyzed.state !== 'ok' || analyzed.output.kind !== 'json')
        throw new Error('analysis failed')
      expect(analyzed.output.value).toMatchObject({
        map: expect.any(String),
        durationGameloops: expect.any(Number),
        durationSeconds: expect.any(Number),
        players: expect.any(Array),
        timeline: expect.any(Array),
        chat: expect.any(Array),
        engagements: expect.any(Array),
      })
      expect((analyzed.output.value as { players: unknown[] }).players.length).toBeGreaterThan(0)
      const playerState = await opened.session.operations().invoke('player-state', {
        playerId: 1,
        loop: 0,
      })
      expect(playerState.state).toBe('ok')
      if (playerState.state !== 'ok' || playerState.output.kind !== 'json') {
        throw new Error('player state failed')
      }
      expect(playerState.output.value).toMatchObject({
        playerId: 1,
        loop: 0,
        selectionAvailable: expect.any(Boolean),
        selection: expect.any(Array),
        diagnostics: expect.any(Array),
      })
      const commandIntents = await opened.session.operations().invoke('command-intents', {
        maxIntents: 10_000,
        semantic: {
          stableIds: { Abilities: [{ id: 42, index: 0, name: 'Move' }] },
          resolvedData: {
            analysis: replayCatalogAnalysis,
            maxAbilities: 8,
            maxDefinitions: 16,
          },
        },
      })
      expect(commandIntents.state).toBe('ok')
      if (commandIntents.state !== 'ok' || commandIntents.output.kind !== 'json') {
        throw new Error('command intent normalization failed')
      }
      expect(commandIntents.output.value).toMatchObject({
        intents: expect.any(Array),
        commands: expect.any(Array),
        diagnostics: expect.any(Array),
        semanticContext: {
          stableAbilityCount: 1,
          catalogAbilityCount: 1,
        },
      })
      const enriched = await opened.session.operations().invoke('analyze', {
        resolvedData: { analysis: replayCatalogAnalysis, maxUnits: 8, maxDefinitions: 16 },
      })
      expect(enriched.state).toBe('ok')
      if (enriched.state !== 'ok' || enriched.output.kind !== 'json') {
        throw new Error('catalog-enriched analysis failed')
      }
      expect(enriched.output.value).toMatchObject({
        catalogEnrichment: {
          units: 2,
          completeUnits: 2,
          pricedUnits: 2,
          complete: true,
        },
      })
      const descriptor = await opened.session.descriptor()
      expect(descriptor.dataSources).toEqual(
        expect.arrayContaining([
          { contract: 'common.view/transport-source', major: 1 },
          { contract: 'common.view/world-scene-source', major: 1 },
        ]),
      )
      expect(descriptor.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'media.seek',
            handlerId: 'transport-seek',
            state: 'available',
          }),
          expect.objectContaining({
            id: 'blizzard/sc2-replay.analyze',
            handlerId: 'analyze',
            state: 'available',
          }),
        ]),
      )
      const transportLease = await opened.session.dataSource('common.view/transport-source', 1)
      const worldLease = await opened.session.dataSource('common.view/world-scene-source', 1)
      try {
        const initialTransport = await transportLease.value.snapshot()
        const initialWorld = await worldLease.value.info()
        expect(initialTransport).toMatchObject({ state: 'paused', positionMs: 0, seekable: true })
        expect(initialWorld.facets).toContainEqual(
          expect.objectContaining({
            facet: 'objects',
            layerId: 'replay-units',
            state: 'available',
          }),
        )
        const positionMs = Math.max(1, Math.floor(Number(initialTransport.durationMs) / 2))
        const seek = await opened.session.operations().invoke('transport-seek', { positionMs })
        expect(seek.state).toBe('ok')
        expect(await transportLease.value.snapshot()).toMatchObject({ positionMs })
        const movedWorld = await worldLease.value.info()
        expect(movedWorld.snapshotId).not.toBe(initialWorld.snapshotId)
        const page = await worldLease.value.page({
          facet: 'objects',
          layerId: 'replay-units',
          lod: 'sampled',
          limit: 32,
        })
        expect(page).toMatchObject({
          snapshotId: movedWorld.snapshotId,
          facet: 'objects',
          state: 'available',
        })
        expect(page.items.length).toBeGreaterThan(0)
      } finally {
        await Promise.all([transportLease.release(), worldLease.release()])
      }
    } finally {
      await opened.session.dispose()
    }
  })

  it('selects the current exact protocol and decodes all build-specific streams', async () => {
    const opened = await openReplay('Goldenaura LE (60).SC2Replay')
    try {
      const inspected = await opened.session.operations().invoke('inspect', {})
      expect(inspected.state).toBe('ok')
      if (inspected.state !== 'ok' || inspected.output.kind !== 'json')
        throw new Error('inspect failed')
      expect(inspected.output.value).toMatchObject({
        format: 'sc2-replay',
        build: 97425,
        baseBuild: 97425,
        protocolBuild: 97425,
        initDataDecoded: true,
        gameEvents: expect.any(Number),
        messageEvents: expect.any(Number),
      })
      expect((await opened.session.descriptor()).diagnostics).not.toContainEqual(
        expect.objectContaining({ code: 'blizzard/sc2-replay-protocol-unavailable' }),
      )
    } finally {
      await opened.session.dispose()
    }
  })

  it('decodes an early Wings of Liberty replay with its exact protocol', async () => {
    const opened = await openFixtureReplay('Wings-of-Liberty-1.1.0.SC2Replay')
    try {
      const inspected = await opened.session.operations().invoke('inspect', {})
      expect(inspected.state).toBe('ok')
      if (inspected.state !== 'ok' || inspected.output.kind !== 'json')
        throw new Error('inspect failed')
      expect(inspected.output.value).toMatchObject({
        format: 'sc2-replay',
        build: 16561,
        baseBuild: 16561,
        protocolBuild: 16561,
        initDataDecoded: true,
        gameEvents: expect.any(Number),
        messageEvents: expect.any(Number),
      })
      expect((await opened.session.descriptor()).diagnostics).not.toContainEqual(
        expect.objectContaining({ code: 'blizzard/sc2-replay-protocol-unavailable' }),
      )
    } finally {
      await opened.session.dispose()
    }
  })

  it.each([
    ['../old-modkit-ts/-temp/Persephone.SC2Replay', 94137, 94137, false],
    ['Odyssey LE (4).SC2Replay', 95299, 95299, true],
    ['Nod vs Protoss (1).SC2Replay', 96592, 95841, false],
    ['[HypONE] [FFA] Lost on the Horizon (2).SC2Replay', 96883, 96883, false],
  ] as const)(
    'classifies every decoded stream for corpus replay %s',
    async (name, build, baseBuild, exactProtocol) => {
      const opened = await openReplay(name)
      try {
        const inspected = await opened.session.operations().invoke('inspect', {})
        expect(inspected.state).toBe('ok')
        if (inspected.state !== 'ok' || inspected.output.kind !== 'json') {
          throw new Error(`${name} inspect failed`)
        }
        const corpusDescriptor = await opened.session.descriptor()
        expect(inspected.output.value).toMatchObject({
          format: 'sc2-replay',
          build,
          baseBuild,
          knownStreams: 7,
          title: expect.any(String),
          players: expect.any(Number),
          trackerEvents: expect.any(Number),
          attributes: expect.any(Number),
          loadInfoWords: expect.any(Number),
        })
        if (exactProtocol) {
          expect(inspected.output.value).toMatchObject({
            protocolBuild: baseBuild,
            initDataDecoded: true,
            gameEvents: expect.any(Number),
            messageEvents: expect.any(Number),
          })
        } else {
          expect(inspected.output.value).toMatchObject({ initDataDecoded: false })
          expect(inspected.output.value).not.toHaveProperty('protocolBuild')
          expect(corpusDescriptor.diagnostics).toContainEqual(
            expect.objectContaining({ code: 'blizzard/sc2-replay-protocol-unavailable' }),
          )
        }
      } finally {
        await opened.session.dispose()
      }
    },
  )
})
