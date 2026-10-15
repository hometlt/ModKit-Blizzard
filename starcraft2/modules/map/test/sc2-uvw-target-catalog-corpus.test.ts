import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  analyzeResolvedDataWorkspace,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createModContextDataWorkspaceInputs,
  planDataWorkspace,
  registerServiceDefinitionsOrThrow,
  resolveResolvedDataWorkspace,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { Sc2DesktopContentSources } from '../../game/battlenet/content-sources/local-content-sources.js'

const installation = process.env['MODKITX_SC2_ROOT'] ?? 'C:/Apps/StarCraft II'
const modPath = process.env['MODKIT_SC2_WARZONE_MOD_PATH']
const enabled =
  process.env['MODKIT_TEST_TIER'] === 'real' &&
  modPath !== undefined &&
  existsSync(modPath) &&
  existsSync(join(installation, '.build.info'))
const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')

describe.skipIf(!enabled)('WarZone.SC2Mod complete target catalog for SC2 map conversion', () => {
  it(
    'plans every dependency root and resolves complete target Unit definitions',
    { timeout: 600_000 },
    async () => {
      const inputs = await Promise.all(
        ['starcraft2', 'casc'].map(directory => loadExtensionDirectory(join(repoRoot, directory))),
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
      const services = {
        inventory,
        target: {
          environment: 'node' as const,
          operatingSystem: 'windows' as const,
          architecture: 'x64' as const,
        },
        executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
        serviceDefinitions,
      }
      const sources = new Sc2DesktopContentSources({
        installationDirectory: installation,
        documentsDirectory:
          process.env['MODKIT_SC2_DOCUMENTS_ROOT'] ?? dirname(dirname(dirname(modPath!))),
      })
      let context: Awaited<ReturnType<typeof sources.openModContext>> | undefined
      let resources: ReturnType<typeof createModContextDataWorkspaceInputs>['resources'] | undefined
      try {
        context = await sources.openModContext({
          schemaVersion: 1,
          target: modPath!,
          locales: ['enUS'],
        })
        expect(context.unresolved).toEqual([])
        expect(context.layers.map(layer => layer.displayName.toLowerCase())).toEqual([
          'core.sc2mod',
          'liberty.sc2mod',
          'swarm.sc2mod',
          'void.sc2mod',
          'warzone-assets.sc2mod',
          'warzone.sc2mod',
        ])
        const prepared = createModContextDataWorkspaceInputs(context)
        resources = prepared.resources
        expect(prepared.workspace.workspaceId).toBe(context.contextId)
        const pinnedContextId = context.contextId
        const listedRoots = new Set<string>()
        const listFiles: typeof prepared.listFiles = async (...args) => {
          const listing = await prepared.listFiles(...args)
          expect(listing.complete).toBe(true)
          listedRoots.add(args[0])
          return listing
        }
        const grant = { id: 'sc2-uvw-target-catalog', classes: [] }
        const budgets = {
          maxInputBytes: 268_435_456n,
          maxDepth: 128,
          maxNodes: 2_000_000,
          maxScalarBytes: 134_217_728,
          maxDiagnostics: 200,
        }
        const limits = {
          maxRequirements: 16_384,
          maxDocumentBytes: 16_777_216,
          maxTextBytes: 268_435_456,
          maxEntities: 100_000,
          maxDepth: 128,
          maxPageSize: 1_000,
        }
        let pinnedSnapshotId = ''
        const resolution = await resolveResolvedDataWorkspace({
          services,
          gameId: prepared.workspace.gameId,
          grant,
          budgets,
        })
        if (resolution.state !== 'resolved') throw new Error(JSON.stringify(resolution.diagnostics))
        try {
          // 16,384 is the provider's declared ceiling. Plan-only discovery establishes the actual
          // requirements before any catalog documents are analyzed.
          const plan = await planDataWorkspace(
            resolution.workspace,
            {
              workspace: prepared.workspace,
              locales: ['enUS'],
              maxRequirements: 16_384,
            },
            listFiles,
          )
          expect(plan.complete).toBe(true)
          expect(plan.diagnostics.map(item => item.code)).not.toContain(
            'blizzard.starcraft2/data-plan-full-catalog-budget-unavailable',
          )
          expect(listedRoots).toEqual(
            new Set(prepared.workspace.loadOrder.map(root => root.rootId)),
          )
          for (const root of prepared.workspace.loadOrder)
            expect(
              plan.requirements.some(
                item => item.rootId === root.rootId && item.kind === 'catalog',
              ),
            ).toBe(true)
          expect(plan.requirements.length).toBeGreaterThan(0)
          expect(plan.requirements.length).toBeLessThan(16_384)

          const analyzed = await analyzeResolvedDataWorkspace({
            services,
            grant,
            budgets,
            workspace: prepared.workspace,
            resources,
            listFiles,
            locales: ['enUS'],
            queries: [
              { namespace: 'Unit', entityId: 'WZOilDerrick' },
              { namespace: 'Unit', entityId: 'WZHeadquarters' },
            ],
            limits,
          })
          if (analyzed.state !== 'resolved') throw new Error(JSON.stringify(analyzed.diagnostics))
          try {
            expect(analyzed.plan.complete).toBe(true)
            expect(analyzed.plan.requirements).toEqual(plan.requirements)
            expect(analyzed.plan.diagnostics.map(item => item.code)).not.toContain(
              'blizzard.starcraft2/data-plan-full-catalog-budget-unavailable',
            )
            expect(analyzed.snapshot.complete).toBe(true)
            expect(analyzed.snapshot.snapshotId).toBeTruthy()
            pinnedSnapshotId = analyzed.snapshot.snapshotId
            expect(
              analyzed.snapshot.definitions.filter(item => item.namespace === 'Unit').length,
            ).toBeGreaterThan(264)
            for (const entityId of ['WZOilDerrick', 'WZHeadquarters']) {
              const definition = analyzed.snapshot.definitions.find(
                item => item.namespace === 'Unit' && item.entityId === entityId,
              )
              expect(definition).toMatchObject({ namespace: 'Unit', entityId, complete: true })
              expect(definition?.sources.length).toBeGreaterThan(0)
              expect(definition?.fieldSources).toBeDefined()
            }
          } finally {
            await analyzed.release()
          }
        } finally {
          await resolution.release()
        }
        await resources.dispose()
        resources = undefined
        await context.dispose()
        context = undefined
        await sources.refresh('host')
        context = await sources.openModContext({
          schemaVersion: 1,
          target: modPath!,
          locales: ['enUS'],
        })
        expect(context.unresolved).toEqual([])
        expect(context.contextId).toBe(pinnedContextId)
        const current = createModContextDataWorkspaceInputs(context)
        resources = current.resources
        const refreshed = await analyzeResolvedDataWorkspace({
          services,
          grant,
          budgets,
          workspace: current.workspace,
          resources,
          listFiles: current.listFiles,
          locales: ['enUS'],
          queries: [],
          limits,
        })
        if (refreshed.state !== 'resolved') throw new Error(JSON.stringify(refreshed.diagnostics))
        try {
          expect(refreshed.plan.complete).toBe(true)
          expect(refreshed.snapshot.complete).toBe(true)
          expect(refreshed.snapshot.snapshotId).toBe(pinnedSnapshotId)
        } finally {
          await refreshed.release()
        }
      } finally {
        await resources?.dispose()
        await context?.dispose()
        await sources.dispose()
      }
    },
  )
})
