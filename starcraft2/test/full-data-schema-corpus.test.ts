import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
  registerServiceDefinitionsOrThrow,
  resolveGameInstallationDiscovery,
  resolveResolvedDataWorkspace,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import type { NamespaceEntrySource, ResourceBudget } from '@modkit/sdk'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { STARCRAFT2_CATALOG_FILES } from '../modules/data/services/schema/full-data-schema.js'

const extensionRoot = join(import.meta.dirname, '..', '..')
const sc2Override = process.env.MODKITX_SC2_ROOT?.trim()
const mapRoot = 'campaigns/liberty.sc2campaign/base.sc2maps/maps/campaign/tarcade.sc2map'
const budget: ResourceBudget = {
  maxInputBytes: 536_870_912n,
  maxDepth: 128,
  maxNodes: 1_500_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1_024,
}
const preferredCatalogFiles = [
  'abildata.xml',
  'actordata.xml',
  'behaviordata.xml',
  'buttondata.xml',
  'effectdata.xml',
  'modeldata.xml',
  'sounddata.xml',
  'unitdata.xml',
  'upgradedata.xml',
  'weapondata.xml',
]

describe.skipIf(process.platform !== 'win32')('installed SC2 full-data provider corpus', () => {
  it('loads SC2Mod, SC2Campaign and SC2Map catalog bytes through CASC and the Modkit provider', async ({
    skip,
  }) => {
    const inputs = await Promise.all(
      ['starcraft2', 'casc'].map(directory =>
        loadExtensionDirectory(join(extensionRoot, directory)),
      ),
    )
    const inventory = await buildInventory(
      inputs.map(input => ({
        ...input,
        execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
      })),
      createHostContributionContractRegistry(),
    )
    const executionBackends = createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND])
    const serviceDefinitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
    const target = {
      environment: 'node' as const,
      operatingSystem: 'windows' as const,
      architecture: 'x64' as const,
    }
    const services = { inventory, target, executionBackends, serviceDefinitions }
    const discovery = await resolveGameInstallationDiscovery({
      services,
      gameId: 'blizzard/starcraft-2',
      grant: {
        id: 'sc2-full-data-corpus-discovery',
        classes: ['filesystem-read', 'process-launch'],
      },
      budgets: budget,
    })
    if (discovery.state !== 'resolved') {
      throw new Error(discovery.diagnostics.map(item => item.message).join('; '))
    }
    const data = await resolveResolvedDataWorkspace({
      services,
      gameId: 'blizzard/starcraft-2',
      grant: { id: 'sc2-full-data-corpus-provider', classes: [] },
      budgets: budget,
    })
    if (data.state !== 'resolved') {
      await discovery.release()
      throw new Error(data.diagnostics.map(item => item.message).join('; '))
    }
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    let casc: Awaited<ReturnType<typeof openSubject>> | undefined
    try {
      const found = await discovery.discovery.discover({
        gameId: 'blizzard/starcraft-2',
        ...(sc2Override === undefined ? {} : { configuredPaths: [sc2Override] }),
        maxCandidates: 16,
      })
      const normalizedOverride = sc2Override
        ?.replace(/\\/gu, '/')
        .replace(/\/+$/gu, '')
        .toLowerCase()
      const installation =
        normalizedOverride === undefined
          ? found.installations[0]
          : found.installations.find(
              candidate => candidate.normalizedPath.toLowerCase() === normalizedOverride,
            )
      if (installation === undefined) {
        if (sc2Override !== undefined) {
          throw new Error(`MODKITX_SC2_ROOT did not resolve to an SC2 installation: ${sc2Override}`)
        }
        skip()
        return
      }
      if (!existsSync(join(installation.installPath, '.build.info'))) {
        throw new Error(`discovered SC2 installation has no .build.info: ${installation.installPath}`)
      }
      const mount = await vfs.openMount(pathToFileURL(installation.installPath).href)
      casc = await openSubject({
        inventory,
        source: artifactNamespaceSourceFromVfsMount(mount),
        path: 'StarCraft II',
        intent: 'full',
        target,
        grant: { id: 'sc2-full-data-corpus-casc', classes: ['read-source'] },
        executionBackends,
        budget,
        serviceDefinitions,
      })
      if (casc.state !== 'opened') throw new Error(`SC2 CASC open failed: ${casc.reason}`)
      const namespaceLease = await casc.session.dataSource('common.view/namespace-entry-source', 1)
      try {
        const namespace = namespaceLease.value as NamespaceEntrySource
        const roots = [
          { rootId: 'retail:core.sc2mod', sourcePath: 'mods/core.sc2mod', kind: 'SC2Mod' },
          {
            rootId: 'retail:liberty.sc2campaign',
            sourcePath: 'campaigns/liberty.sc2campaign',
            kind: 'SC2Campaign',
          },
          { rootId: 'retail:tarcade.sc2map', sourcePath: mapRoot, kind: 'SC2Map' },
        ]
        const decoder = new TextDecoder()
        const documents: { rootId: string; path: string; text: string }[] = []
        const sourceKinds = new Map<string, string>()
        for (const root of roots) {
          const candidates = [
            ...preferredCatalogFiles,
            ...STARCRAFT2_CATALOG_FILES.filter(file => !preferredCatalogFiles.includes(file)),
          ]
          const existing: string[] = []
          for (const file of candidates) {
            const path = `${root.sourcePath}/base.sc2data/gamedata/${file}`
            const page = await namespace.list(path, { limit: 1 })
            if (page.items[0]?.path === path) existing.push(path)
            if (existing.length >= 16) break
          }
          expect(
            existing.length,
            `${root.kind} has no installed GameData corpus document`,
          ).toBeGreaterThan(0)
          sourceKinds.set(root.rootId, root.kind)
          for (const path of existing) {
            const result = await casc.session
              .operations()
              .invoke('extract-entry', { entryId: path })
            if (result.state !== 'ok' || result.output.kind !== 'bytes') {
              throw new Error(`CASC extraction failed for ${path}`)
            }
            documents.push({ rootId: root.rootId, path, text: decoder.decode(result.output.value) })
          }
        }
        const snapshot = await data.workspace.analyze({
          workspaceId: 'installed-sc2-full-data-corpus',
          gameId: 'blizzard/starcraft-2',
          documents,
          localizationDocuments: [],
          locales: [],
          localizationKeys: [],
          queries: [],
          plannedDocumentCount: documents.length,
          unresolvedRequirementIds: [],
          maxDocuments: 64,
          maxTextBytes: 268_435_456,
          maxEntities: 100_000,
          maxDepth: 128,
        })
        const coveredKinds = new Set(
          snapshot.definitions.flatMap(definition =>
            definition.sources.map(source => sourceKinds.get(source.rootId)).filter(Boolean),
          ),
        )
        expect(coveredKinds).toEqual(new Set(['SC2Mod', 'SC2Campaign', 'SC2Map']))
        expect(snapshot.definitions.length).toBeGreaterThan(1_000)
        expect(snapshot.namespaces.length).toBeGreaterThan(8)
        expect(snapshot.typeIds).toContain('CModel')
        expect(snapshot.definitions.some(definition => definition.typeId === 'CModel')).toBe(true)
        expect(snapshot.definitions.some(definition => definition.typeId.startsWith('CAbil'))).toBe(
          true,
        )
        expect(
          snapshot.definitions.some(definition => definition.typeId.startsWith('CActor')),
        ).toBe(true)
        expect(snapshot.relations.length).toBeGreaterThan(1_000)
        expect(snapshot.relations.map(edge => edge.to.namespace)).toEqual(
          expect.arrayContaining(['Unit', 'Abil', 'Button', 'Effect', 'Actor', 'Model', 'Sound']),
        )
        expect(snapshot.diagnostics.map(item => item.code)).not.toContain(
          'blizzard.starcraft2/data-schema-slice-partial',
        )
        expect(snapshot.diagnostics).toContainEqual(
          expect.objectContaining({
            code: 'blizzard.starcraft2/data-schema-full-coverage',
          }),
        )
        console.info(
          `[sc2-full-data] documents=${documents.length}; definitions=${snapshot.definitions.length}; types=${new Set(snapshot.definitions.map(item => item.typeId)).size}; namespaces=${snapshot.namespaces.length}; relations=${snapshot.relations.length}; sources=${[...coveredKinds].join(',')}`,
        )
      } finally {
        await namespaceLease.release()
      }
    } finally {
      if (casc?.state === 'opened') await casc.session.dispose()
      await vfs.dispose()
      await data.release()
      await discovery.release()
    }
  }, 120_000)
})
