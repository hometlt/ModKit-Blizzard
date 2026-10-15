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

const extensionRoot = join(import.meta.dirname, '..', '..')
const sc2Override = process.env.MODKITX_SC2_ROOT?.trim()
const mapRoot = 'campaigns/liberty.sc2campaign/base.sc2maps/maps/campaign/tarcade.sc2map'
const budget: ResourceBudget = {
  maxInputBytes: 536_870_912n,
  maxDepth: 128,
  maxNodes: 1_500_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 20_000,
}

describe.skipIf(process.platform !== 'win32')('installed SC2 resolved-data placeholders', () => {
  it('audits Talent defaults and tokenized links through the Modkit host', async ({ skip }) => {
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
      grant: { id: 'sc2-placeholders-discovery', classes: ['filesystem-read', 'process-launch'] },
      budgets: budget,
    })
    if (discovery.state !== 'resolved') {
      throw new Error(discovery.diagnostics.map(item => item.message).join('; '))
    }
    const data = await resolveResolvedDataWorkspace({
      services,
      gameId: 'blizzard/starcraft-2',
      grant: { id: 'sc2-placeholders-data', classes: [] },
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
      const installation = found.installations[0]
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
        grant: { id: 'sc2-placeholders-casc', classes: ['read-source'] },
        executionBackends,
        budget,
        serviceDefinitions,
      })
      if (casc.state !== 'opened') throw new Error(`SC2 CASC open failed: ${casc.reason}`)
      const namespaceLease = await casc.session.dataSource('common.view/namespace-entry-source', 1)
      const namespace = namespaceLease.value as NamespaceEntrySource
      const roots = [
        {
          rootId: 'retail:core.sc2mod',
          sourcePath: 'mods/core.sc2mod',
          files: ['sc2data.xml', 'talentdata.xml'],
        },
        {
          rootId: 'retail:liberty.sc2mod',
          sourcePath: 'mods/liberty.sc2mod',
          files: ['talentdata.xml'],
        },
        {
          rootId: 'retail:liberty.sc2campaign',
          sourcePath: 'campaigns/liberty.sc2campaign',
          files: ['talentdata.xml'],
        },
        { rootId: 'retail:tarcade.sc2map', sourcePath: mapRoot, files: ['talentdata.xml'] },
      ]
      const decoder = new TextDecoder()
      const documents: { rootId: string; path: string; text: string }[] = []
      try {
        for (const root of roots) {
          for (const file of root.files) {
            const path = `${root.sourcePath}/base.sc2data/gamedata/${file}`
            const page = await namespace.list(path, { limit: 1 })
            if (page.items[0]?.path !== path) continue
            const result = await casc.session
              .operations()
              .invoke('extract-entry', { entryId: path })
            if (result.state !== 'ok' || result.output.kind !== 'bytes') continue
            documents.push({ rootId: root.rootId, path, text: decoder.decode(result.output.value) })
          }
        }
      } finally {
        await namespaceLease.release()
      }
      expect(documents.length).toBeGreaterThan(0)
      const snapshot = await data.workspace.analyze({
        workspaceId: 'installed-sc2-placeholder-audit',
        gameId: 'blizzard/starcraft-2',
        documents,
        localizationDocuments: [],
        locales: [],
        localizationKeys: [],
        queries: [],
        plannedDocumentCount: documents.length,
        unresolvedRequirementIds: [],
        maxDocuments: 16,
        maxTextBytes: 64 * 1024 * 1024,
        maxEntities: 100_000,
        maxDepth: 128,
      })
      const commanderParents = snapshot.definitions.filter(
        entity =>
          entity.namespace === 'Talent' && entity.parentEntityId === 'CommanderDefaultSettings',
      )
      const tokenRelations = snapshot.relations.filter(
        relation => relation.to.entityId.includes('##') || relation.to.entityId.includes('$'),
      )
      console.info(
        JSON.stringify({
          installationPath: installation.installPath,
          documents: documents.length,
          complete: snapshot.complete,
          talents: snapshot.definitions.filter(entity => entity.namespace === 'Talent').length,
          commanderParents: commanderParents.length,
          tokenRelations: tokenRelations.length,
          realErrors: snapshot.diagnostics.filter(item => item.severity === 'error').length,
        }),
      )
      expect(commanderParents.length).toBeGreaterThan(400)
      expect(commanderParents.every(entity => entity.complete)).toBe(true)
      expect(
        snapshot.definitions.find(
          entity => entity.namespace === 'Talent' && entity.entityId === 'CommanderDefaultSettings',
        ),
      ).toMatchObject({
        typeId: 'CTalent',
        complete: true,
        fields: { Face: 'CommanderDefaultSettings' },
      })
      expect(
        snapshot.definitions
          .find(
            entity =>
              entity.namespace === 'Talent' && entity.entityId === 'CommanderDefaultSettings',
          )
          ?.sources.at(-1)?.path,
      ).toBe('mods/core.sc2mod/base.sc2data/gamedata/sc2data.xml')
      expect(commanderParents[0]?.fields.Face).toBe(commanderParents[0]?.entityId)
      expect(tokenRelations).toEqual([])
      expect(snapshot.diagnostics).not.toContainEqual(
        expect.objectContaining({
          code: 'common.data/entity-parent-unavailable',
          message: expect.stringContaining('CommanderDefaultSettings'),
        }),
      )
      expect(snapshot.complete).toBe(false)
      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'common.data/entity-parent-unavailable',
          message: expect.stringContaining('Model/'),
        }),
      )
    } finally {
      if (casc?.state === 'opened') await casc.session.dispose()
      await vfs.dispose()
      await data.release()
      await discovery.release()
    }
  }, 120_000)
})
