import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'
import { canonicalJsonStringify } from '@modkit/core'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  analyzeResolvedDataWorkspace,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createModContextDataWorkspaceInputs,
  registerServiceDefinitionsOrThrow,
  resolveGameInstallationDiscovery,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { openRuntimeSession } from '@modkit/host/runtime'
import { proves } from '@modkit/testkit'
import type {
  ArtifactByteSource,
  ArtifactSource,
  InputSearchScope,
  Lease,
  ResolvedDataWorkspaceSnapshot,
  ResourceBudget,
  RuntimeEvent,
} from '@modkit/sdk'
import { revisionId } from '@modkit/sdk'
import type { RuntimeSessionV2, RuntimeSnapshot } from '@modkit/sdk/runtime'
import type { ContentSources } from '@modkit/vfs/content-sources'

import type {
  CompanionOrigin,
  CompanionOriginEntry,
} from './support/input-resolution.js'
import { createResourceSession } from './support/resource-session.js'

const repoRoot = join(import.meta.dirname, '..', '..')
const extensionRoot = join(repoRoot, 'starcraft2')
const mapRoot = 'campaigns/liberty.sc2campaign/base.sc2maps/maps/campaign/tarcade.sc2map'
const runtimeId = 'blizzard.starcraft2.playable-subset-v1'
const decoder = new TextDecoder()
const activationBudget: ResourceBudget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 750_000,
  maxScalarBytes: 134_217_728,
  maxDiagnostics: 100,
}
const sessionBudget = { maxWallTimeMs: 100, maxTicks: 1_000, maxMemoryBytes: 1_000_000 }

interface Sc2PlayableCatalogBridgeModule {
  createSc2PlayableCatalogDefinition(
    snapshot: ResolvedDataWorkspaceSnapshot,
    request: { readonly unitIds: readonly string[]; readonly randomSeed: number },
  ): {
    readonly bytes: Uint8Array
    readonly receipt: {
      readonly units: readonly {
        readonly usedFields: readonly {
          readonly sources: readonly { readonly rootId: string; readonly path: string }[]
        }[]
      }[]
    }
  }
}

async function createServices() {
  const directories = ['starcraft2', 'casc']
  const inputs = await Promise.all(
    directories.map(directory => loadExtensionDirectory(join(repoRoot, directory))),
  )
  const inventory = await buildInventory(
    inputs.map(input => ({
      ...input,
      execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
    })),
    createHostContributionContractRegistry(),
  )
  const serviceDefinitions = createBundledServiceDefinitionRegistry()
  await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
  return {
    inventory,
    target: {
      environment: 'node' as const,
      operatingSystem: 'windows' as const,
      architecture: 'x64' as const,
    },
    executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
    serviceDefinitions,
  }
}

function definitionOrigin(bytes: Uint8Array): CompanionOrigin {
  const logicalId = 'ResolvedMarinePlayable.json'
  const digest = createHash('sha256').update(bytes).digest('hex')
  return Object.freeze({
    primaryLogicalId: logicalId,
    caseSensitivity: 'sensitive',
    scopes: Object.freeze(['current-mount'] as const),
    async *enumerate(
      scope: InputSearchScope,
      options: { readonly prefix: string },
    ): AsyncIterable<CompanionOriginEntry> {
      if (scope === 'current-mount' && logicalId.startsWith(options.prefix)) {
        yield { logicalId, size: BigInt(bytes.byteLength) }
      }
    },
    async open(requested: string): Promise<Lease<ArtifactSource>> {
      if (requested !== logicalId) throw new Error(`missing definition ${requested}`)
      const source: ArtifactByteSource = Object.freeze({
        kind: 'bytes',
        ref: {
          id: 'memory://sc2-live-runtime/definition',
          uri: 'memory://sc2-live-runtime/definition',
        },
        revision: revisionId(`content-hash.sha256:${digest}`),
        size: BigInt(bytes.byteLength),
        async read(offset: bigint, length: number) {
          return bytes.slice(Number(offset), Number(offset) + length)
        },
        async *stream() {
          yield bytes
        },
      })
      return Object.freeze({
        value: source,
        async release() {
          return undefined
        },
      })
    },
  })
}

async function openPlayable(
  services: Awaited<ReturnType<typeof createServices>>,
  bytes: Uint8Array,
  sessionId: string,
) {
  const resources = createResourceSession({
    origin: definitionOrigin(bytes),
    revision: revisionId(`content-hash.sha256:${createHash('sha256').update(bytes).digest('hex')}`),
    sessionId: `${sessionId}-resources`,
  })
  const resolution = await openRuntimeSession({
    services,
    runtimeId,
    sessionId,
    budget: sessionBudget,
    grant: { id: sessionId, classes: [] },
    activationBudget,
    providerInvocation: {
      resources,
      inputs: [
        {
          id: 'resolved-marine-catalog',
          kind: 'definition',
          logicalId: 'ResolvedMarinePlayable.json',
          scopes: ['current-mount'],
          maxBytes: 64 * 1024,
        },
      ],
    },
  })
  if (resolution.state !== 'resolved') {
    await resources.dispose()
    throw new Error(resolution.diagnostics.map(item => item.message).join('; '))
  }
  return { resources, resolution, session: resolution.session as RuntimeSessionV2 }
}

async function captured(session: RuntimeSessionV2): Promise<RuntimeSnapshot> {
  const result = await session.snapshot()
  if (result.outcome !== 'captured') throw new Error(`snapshot refused: ${result.reason}`)
  return result.snapshot
}

async function hashed(session: RuntimeSessionV2): Promise<string> {
  const result = await session.stateHash()
  if (result.outcome !== 'hashed') throw new Error(`hash refused: ${result.reason}`)
  return result.stateHash
}

async function events(session: RuntimeSessionV2): Promise<readonly RuntimeEvent[]> {
  const result: RuntimeEvent[] = []
  for await (const event of session.events()) result.push(event)
  return result
}

async function runPinnedScenario(
  services: Awaited<ReturnType<typeof createServices>>,
  bytes: Uint8Array,
  suffix: string,
) {
  const opened = await openPlayable(services, bytes, `sc2-live-playable-${suffix}`)
  try {
    const commands = [
      {
        player: -1,
        seq: 0,
        atTick: 0,
        command: { kind: 'spawn', unitType: 'Marine', owner: 1, x: 0, y: 0 },
      },
      {
        player: 1,
        seq: 0,
        atTick: 1,
        command: { kind: 'move', unitIds: ['unit1'], x: 1, y: 0 },
      },
    ] as const
    for (const command of commands) {
      const executed = await opened.session.execute({
        entrypoint: 'sc2.simulation.issue-command',
        arguments: [command],
        resources: { wallTimeMs: 1, ticks: 0, memoryBytes: 0 },
      })
      expect(executed).toMatchObject({ state: 'completed' })
    }
    await expect(opened.session.step(4)).resolves.toMatchObject({ outcome: 'stepped' })
    const checkpoint = await captured(opened.session)
    await expect(opened.session.step(5)).resolves.toMatchObject({ outcome: 'stepped' })
    const firstHash = await hashed(opened.session)
    const firstEvents = await events(opened.session)
    const firstFinal = await captured(opened.session)

    await expect(opened.session.restore(checkpoint)).resolves.toMatchObject({
      outcome: 'restored',
    })
    await expect(opened.session.step(5)).resolves.toMatchObject({ outcome: 'stepped' })
    expect(await hashed(opened.session)).toBe(firstHash)
    expect(await events(opened.session)).toEqual(firstEvents)
    expect((await captured(opened.session)).bytes).toEqual(firstFinal.bytes)

    const state = JSON.parse(decoder.decode(firstFinal.bytes)) as {
      readonly units: Readonly<
        Record<
          string,
          {
            readonly unitType: string
            readonly life: { readonly current: number; readonly max: number }
            readonly speed: number
            readonly food: number
            readonly x: number
            readonly y: number
          }
        >
      >
    }
    expect(state.units.unit1).toEqual(
      expect.objectContaining({
        unitType: 'Marine',
        life: { current: 45, max: 45 },
        speed: 2.25,
        food: -1,
        x: 1,
        y: 0,
      }),
    )
    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        tick: 9,
        kind: 'SimUnitArrived',
        data: { unit: 'unit1', x: 1, y: 0 },
      }),
    )
    return Object.freeze({
      checkpointDigest: checkpoint.identity.contentDigest,
      finalHash: firstHash,
      finalBytes: firstFinal.bytes,
      events: firstEvents,
    })
  } finally {
    await opened.resolution.release()
    await opened.resources.dispose()
  }
}

function forgedSnapshot(
  snapshot: ResolvedDataWorkspaceSnapshot,
  transform: (
    marine: ResolvedDataWorkspaceSnapshot['definitions'][number],
  ) => ResolvedDataWorkspaceSnapshot['definitions'][number],
): ResolvedDataWorkspaceSnapshot {
  return {
    ...snapshot,
    definitions: snapshot.definitions.map(entity =>
      entity.namespace === 'Unit' && entity.entityId === 'Marine' ? transform(entity) : entity,
    ),
  }
}

const configuredSc2Root = process.env.MODKITX_SC2_ROOT?.trim() || 'C:\\Apps\\StarCraft II'
const installedSc2CorpusAvailable =
  process.env.MODKIT_TEST_INSTALLED_CORPUS !== '0' &&
  process.platform === 'win32' &&
  existsSync(join(configuredSc2Root, '.build.info'))

describe.skipIf(!installedSc2CorpusAvailable)('installed SC2 catalog to playable runtime bridge', () => {
  it('runs a real dependency-merged Marine scenario repeatably through the runtime host', async () => {
    const services = await createServices()
    const serviceGrant = {
      id: 'sc2-runtime-catalog-real-services',
      classes: ['filesystem-read', 'process-launch'] as const,
    }
    const discoveryResolution = await resolveGameInstallationDiscovery({
      services,
      gameId: 'blizzard/starcraft-2',
      grant: serviceGrant,
      budgets: activationBudget,
    })
    if (discoveryResolution.state !== 'resolved') {
      throw new Error(
        `SC2 discovery service unavailable: ${discoveryResolution.diagnostics.map(item => item.message).join('; ')}`,
      )
    }
    const configuredPath = process.env.MODKITX_SC2_ROOT?.trim()
    const discovered = await discoveryResolution.discovery.discover({
      gameId: 'blizzard/starcraft-2',
      ...(configuredPath === undefined ? {} : { configuredPaths: [configuredPath] }),
      maxCandidates: 16,
    })
    const normalizedConfigured = configuredPath
      ?.replace(/\\/gu, '/')
      .replace(/\/+$/gu, '')
      .toLowerCase()
    const installation =
      normalizedConfigured === undefined
        ? discovered.installations[0]
        : discovered.installations.find(
            candidate => candidate.normalizedPath.toLowerCase() === normalizedConfigured,
          )
    if (installation === undefined) {
      await discoveryResolution.release()
      throw new Error('installed SC2 corpus is required for the live runtime bridge proof')
    }
    const buildInfoPath = join(installation.installPath, '.build.info')
    if (!existsSync(buildInfoPath)) {
      await discoveryResolution.release()
      throw new Error(`SC2 corpus sentinel is missing: ${buildInfoPath}`)
    }
    const before = statSync(buildInfoPath)
    const contentModule = (await import(pathToFileURL(join(
      extensionRoot, 'dist', 'modules', 'game', 'battlenet', 'content-sources', 'local-content-sources.js',
    )).href)) as { createContentSources(options: Record<string, unknown>): Promise<ContentSources> }
    const contentSources = await contentModule.createContentSources({
      installationDirectory: installation.installPath,
    })
    try {
      if (contentSources.openModContext === undefined) throw new Error('SC2 content source has no mod context loader')
      const context = await contentSources.openModContext({
        schemaVersion: 1,
        target: { sourceId: 'local:casc', path: mapRoot },
      })
      try {
        const { workspace, resources } = createModContextDataWorkspaceInputs(context)
        expect(workspace.complete).toBe(true)
        expect(workspace.loadOrder.map(root => root.displayName.toLowerCase())).toEqual(
          expect.arrayContaining(['core.sc2mod', 'liberty.sc2mod']),
        )
        const liveData = await analyzeResolvedDataWorkspace({
          services,
          grant: { id: 'sc2-runtime-catalog-real-data', classes: [] },
          budgets: activationBudget,
          workspace,
          resources,
          locales: ['enUS'],
          queries: [{ namespace: 'Unit', entityId: 'Marine' }],
          localizationKeys: [],
          limits: {
            maxRequirements: 512,
            maxDocumentBytes: 16_777_216,
            maxTextBytes: 268_435_456,
            maxEntities: 100_000,
            maxDepth: 128,
            maxPageSize: 128,
          },
        })
        if (liveData.state !== 'resolved') {
          await resources.dispose()
          throw new Error(
            liveData.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'),
          )
        }
        try {
          const bridgeModule = (await import(
            pathToFileURL(join(extensionRoot, 'modules', 'runtime', 'services', 'catalog-definition.js')).href
          )) as unknown as Sc2PlayableCatalogBridgeModule
          const bridged = bridgeModule.createSc2PlayableCatalogDefinition(liveData.snapshot, {
            unitIds: ['Marine'],
            randomSeed: 7,
          })
          expect(
            liveData.snapshot.complete,
            liveData.snapshot.diagnostics
              .filter(item => item.severity === 'error')
              .slice(0, 32)
              .map(item => `${item.code}: ${item.message}`)
              .join('\n'),
          ).toBe(true)
          const unitSliceModule = (await import(pathToFileURL(join(
            extensionRoot, 'dist', 'modules', 'data', 'services', 'uvd', 'unit-slice.js',
          )).href)) as {
            lowerSc2UnitSlice: (
              snapshot: ResolvedDataWorkspaceSnapshot,
              ref: { namespace: string; entityId: string },
              quantize: (decimal: string) => string,
            ) => {
              definitions: { definitions: { fields: Record<string, unknown> }[] }
              receipt: { snapshotId: string; fieldSources?: Record<string, { rootId: string; path: string }>;
                omittedNativeFields: readonly string[]; completeCatalogExport: false }
            }
          }
          const marineQuanta: Record<string, string> = {
            '45': '193273528320', '2.25': '9663676416',
          }
          const unitSlice = unitSliceModule.lowerSc2UnitSlice(
            liveData.snapshot, { namespace: 'Unit', entityId: 'Marine' },
            decimal => {
              const quantum = marineQuanta[decimal]
              if (quantum === undefined) throw new Error(`unexpected Marine numeric value ${decimal}`)
              return quantum
            },
          )
          expect(unitSlice.definitions.definitions[0]?.fields).toMatchObject({
            healthMax: '193273528320', movementSpeed: '9663676416',
          })
          expect(unitSlice.receipt.snapshotId).toBe(liveData.snapshot.snapshotId)
          expect(unitSlice.receipt.fieldSources?.LifeMax).toMatchObject({
            path: 'mods/liberty.sc2mod/base.sc2data/gamedata/unitdata.xml',
          })
          expect(unitSlice.receipt.omittedNativeFields.length).toBeGreaterThan(0)
          expect(unitSlice.receipt.completeCatalogExport).toBe(false)
          expect(bridged.receipt).toMatchObject({
            gameId: 'blizzard/starcraft-2',
            snapshotId: liveData.snapshot.snapshotId,
            workspaceStatus: 'complete',
            spawnSemantics: 'full-life-from-LifeMax',
            units: [
              {
                unitId: 'Marine',
                typeId: 'CUnit',
                entityComplete: true,
                usedFields: [
                  { fieldId: 'LifeMax', value: 45 },
                  { fieldId: 'Speed', value: 2.25 },
                  { fieldId: 'Food', value: -1 },
                ],
              },
            ],
          })
          const marineReceipt = bridged.receipt.units[0]
          if (marineReceipt === undefined) throw new Error('Marine runtime receipt is missing')
          for (const field of marineReceipt.usedFields) {
              expect(field.sources).toContainEqual(
              expect.objectContaining({
                path: 'mods/liberty.sc2mod/base.sc2data/gamedata/unitdata.xml',
              }),
            )
          }
          const definitionText = decoder.decode(bridged.bytes)
          expect(definitionText).toBe(canonicalJsonStringify(JSON.parse(definitionText)))
          expect(JSON.parse(definitionText)).toEqual({
            catalog: { 'Unit/Marine': { Food: -1, LifeMax: 45, Speed: 2.25 } },
            profile: 'modkit.sc2/playable-subset-v1',
            randomSeed: 7,
            schemaVersion: 1,
            tickRate: 16,
          })

          for (const fieldId of ['LifeMax', 'Speed', 'Food']) {
            const withoutField = forgedSnapshot(liveData.snapshot, marine => ({
              ...marine,
              fields: Object.fromEntries(
                Object.entries(marine.fields).filter(([key]) => key !== fieldId),
              ),
            }))
            expect(() =>
              bridgeModule.createSc2PlayableCatalogDefinition(withoutField, {
                unitIds: ['Marine'],
                randomSeed: 7,
              }),
            ).toThrowError(
              expect.objectContaining({
                code: 'sc2-runtime.catalog/field-missing',
                subject: `Unit/Marine.${fieldId}`,
              }),
            )
          }
          const withoutProvenance = forgedSnapshot(liveData.snapshot, marine => ({
            ...marine,
            sources: [],
          }))
          expect(() =>
            bridgeModule.createSc2PlayableCatalogDefinition(withoutProvenance, {
              unitIds: ['Marine'],
              randomSeed: 7,
            }),
          ).toThrowError(
            expect.objectContaining({
              code: 'sc2-runtime.catalog/provenance-missing',
              subject: 'Unit/Marine',
            }),
          )

          const first = await runPinnedScenario(services, bridged.bytes, 'first')
          const second = await runPinnedScenario(services, bridged.bytes, 'second')
          expect(second).toEqual(first)
          proves({
            capabilityId: 'vertical/starcraft-2/deterministic-playable-subset',
            operation: 'inspect',
            test: 'packages/testkit/test/sc2-runtime-catalog-real.test.ts',
            note: 'installed dependency-merged Marine catalog data drives the bounded spawn/move/fixed-step/arrival runtime with exact snapshot continuation',
          })
        } finally {
          await liveData.release()
          await resources.dispose()
        }
      } finally {
        await context.dispose()
      }
    } finally {
      await contentSources.dispose()
      await discoveryResolution.release()
    }
    const after = statSync(buildInfoPath)
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({
      size: before.size,
      mtimeMs: before.mtimeMs,
    })
  }, 300_000)
})
