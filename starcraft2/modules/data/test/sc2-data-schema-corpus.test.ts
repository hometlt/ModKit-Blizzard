/**
 * Schema regression gate over the installed game's own catalogs (real tier).
 *
 * Every shipped GameData file of the melee chain, the campaigns, co-op and Warcraft co-op must
 * validate with zero schema diagnostics once path-scoped `<const>` aliases from its own dependency
 * chain are known (bar documented defects in the data itself), and the melee resolved-data
 * snapshot must apply root structure defaults (`<SCost>`, `<SAbilCmdButton>` …) per catalog.
 * See reports/SC2DATA_MODULE_SCHEMA_DISCREPANCIES_RU.md for how each rule was established.
 */
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
import { STARCRAFT2_CATALOG_FILES } from '../services/schema/full-data-schema.js'
import {
  catalogConstAliases,
  collectIssues,
} from '../shared/format/language/diagnostics.js'

const extensionRoot = join(import.meta.dirname, '..', '..', '..', '..')
const sc2Override = process.env.MODKITX_SC2_ROOT?.trim()
const budget: ResourceBudget = {
  maxInputBytes: 1_073_741_824n,
  maxDepth: 128,
  maxNodes: 4_000_000,
  maxScalarBytes: 536_870_912,
  maxDiagnostics: 20_000,
}
/** Melee dependency chain, in load order. */
const MELEE = ['core', 'liberty', 'swarm', 'void', 'voidmulti']
/** Blizzard's other shipped data, each validated with the constants of its own dependency chain. */
const GROUPS = [
  { name: 'campaigns', prefixes: ['campaigns/'], base: ['core', 'liberty', 'swarm', 'void'] },
  { name: 'co-op', prefixes: ['mods/starcoop/'], base: MELEE },
  { name: 'warcoop', prefixes: ['mods/warcoop/', 'mods/war3data.sc2mod/'], base: ['core'] },
]
/**
 * Defects in Blizzard's own data rather than the schema: `neutralHostile` is declared by no
 * `<const>` anywhere, while the same mod spells the filter `NeutralHostile` elsewhere.
 */
const KNOWN_DATA_DEFECTS = [/warclassicsystem\.sc2mod\/.*effectdata\.xml@\d+: Invalid flag 'neutralHostile'/u]
const CATALOG_FILES = new Set<string>(STARCRAFT2_CATALOG_FILES)
/** `<root>.sc2mod|.sc2campaign/base.sc2data/gamedata/<catalog>.xml`; maps inside campaigns do not match. */
const CATALOG_PATH = /^(.+?\.sc2(?:mod|campaign))\/base\.sc2data\/gamedata\/([^/]+)$/u
const SCHEMA_ISSUE =
  /^(Invalid value|Invalid flag|Invalid boolean|Invalid number|Expected an integer|Unknown field)/u

type CorpusDocument = { rootId: string; path: string; text: string }

function schemaIssues(documents: readonly CorpusDocument[], chain: readonly CorpusDocument[]) {
  const refs = { isConstAlias: catalogConstAliases(chain.map(item => item.text)) }
  return documents.flatMap(item =>
    collectIssues(item.text, undefined, undefined, item.path.split('/').at(-1), refs)
      .filter(issue => SCHEMA_ISSUE.test(issue.message))
      .map(issue => `${item.path}@${issue.start}: ${issue.message.slice(0, 160)}`),
  )
}

describe.skipIf(process.platform !== 'win32')('installed SC2 data schema corpus', () => {
  it('validates every shipped catalog against the schema and applies structure defaults', async ({
    skip,
  }) => {
    const inputs = await Promise.all(
      ['starcraft2', 'casc'].map(directory => loadExtensionDirectory(join(extensionRoot, directory))),
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
      grant: { id: 'sc2-schema-corpus-discovery', classes: ['filesystem-read', 'process-launch'] },
      budgets: budget,
    })
    if (discovery.state !== 'resolved') {
      throw new Error(discovery.diagnostics.map(item => item.message).join('; '))
    }
    const data = await resolveResolvedDataWorkspace({
      services,
      gameId: 'blizzard/starcraft-2',
      grant: { id: 'sc2-schema-corpus-data', classes: [] },
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
        grant: { id: 'sc2-schema-corpus-casc', classes: ['read-source'] },
        executionBackends,
        budget,
        serviceDefinitions,
      })
      if (casc.state !== 'opened') throw new Error(`SC2 CASC open failed: ${casc.reason}`)
      const namespaceLease = await casc.session.dataSource('common.view/namespace-entry-source', 1)
      const decoder = new TextDecoder()
      const session = casc.session
      const extract = async (path: string): Promise<CorpusDocument> => {
        const result = await session.operations().invoke('extract-entry', { entryId: path })
        if (result.state !== 'ok' || result.output.kind !== 'bytes') {
          throw new Error(`CASC extraction failed for ${path}`)
        }
        return {
          rootId: `retail:${CATALOG_PATH.exec(path)?.[1] ?? path}`,
          path,
          text: decoder.decode(result.output.value),
        }
      }
      const documents: CorpusDocument[] = []
      const groups = new Map<string, CorpusDocument[]>()
      try {
        const namespace = namespaceLease.value as NamespaceEntrySource
        // Listing is recursive by string prefix, so collect catalog paths page by page.
        const catalogPaths = async (prefix: string) => {
          const paths: string[] = []
          let cursor: string | undefined
          do {
            const page = await namespace.list(prefix, { limit: 256, ...(cursor ? { cursor } : {}) })
            for (const item of page.items) {
              const match = CATALOG_PATH.exec(item.path)
              if (item.kind === 'file' && match && CATALOG_FILES.has(match[2]!)) paths.push(item.path)
            }
            cursor = page.nextCursor
          } while (cursor !== undefined)
          return paths.sort()
        }
        for (const name of MELEE) {
          for (const path of await catalogPaths(`mods/${name}.sc2mod/`)) documents.push(await extract(path))
        }
        for (const group of GROUPS) {
          const items: CorpusDocument[] = []
          for (const prefix of group.prefixes) {
            for (const path of await catalogPaths(prefix)) items.push(await extract(path))
          }
          groups.set(group.name, items)
        }
      } finally {
        await namespaceLease.release()
      }
      expect(documents.length).toBeGreaterThan(100)
      expect(schemaIssues(documents, documents).slice(0, 20)).toEqual([])
      const byRoot = (names: readonly string[]) =>
        documents.filter(item => names.some(name => item.path.startsWith(`mods/${name}.sc2mod/`)))
      const groupIssues: string[] = []
      for (const group of GROUPS) {
        const items = groups.get(group.name) ?? []
        expect(items.length, `${group.name} has no installed catalog documents`).toBeGreaterThan(0)
        groupIssues.push(...schemaIssues(items, [...byRoot(group.base), ...items]))
      }
      const unexpected = groupIssues.filter(issue => !KNOWN_DATA_DEFECTS.some(known => known.test(issue)))
      expect(unexpected.slice(0, 20), `${unexpected.length} schema diagnostics`).toEqual([])

      const snapshot = await data.workspace.analyze({
        workspaceId: 'installed-sc2-schema-corpus',
        gameId: 'blizzard/starcraft-2',
        documents,
        localizationDocuments: [],
        locales: [],
        localizationKeys: [],
        queries: [],
        plannedDocumentCount: documents.length,
        unresolvedRequirementIds: [],
        maxDocuments: 1_024,
        maxTextBytes: 536_870_912,
        maxEntities: 100_000,
        maxDepth: 128,
      })
      const unsupported = snapshot.diagnostics.find(
        item => item.code === 'blizzard.starcraft2/data-catalog-element-unsupported',
      )
      expect(unsupported?.message ?? '').not.toMatch(/\bS[A-Z]\w+/u)
      // core AbilData.xml: <SCost><Charge Link="Abil/##id##"/>…; BehaviorData.xml: Behavior/##id##.
      const chargeLink = (value: unknown) =>
        (value as { Charge?: { Link?: unknown } } | undefined)?.Charge?.Link
      const withDefault = (namespace: string, fieldId: string) => {
        const holders = snapshot.definitions.filter(
          item => item.namespace === namespace && item.fields[fieldId] !== undefined,
        )
        const own = holders.filter(
          item => chargeLink(item.fields[fieldId]) === `${namespace}/${item.entityId}`,
        )
        return { holders: holders.length, own: own.length }
      }
      const interruptCost = withDefault('Abil', 'InterruptCost')
      const behaviorCost = withDefault('Behavior', 'Cost')
      // Explicit shared-charge links may override the default; most entities keep their own.
      expect(interruptCost.holders).toBeGreaterThan(100)
      expect(interruptCost.own * 2).toBeGreaterThan(interruptCost.holders)
      expect(behaviorCost.holders).toBeGreaterThan(100)
      expect(behaviorCost.own * 2).toBeGreaterThan(behaviorCost.holders)
      console.info(
        `[sc2-schema-corpus] documents=${documents.length}; definitions=${snapshot.definitions.length}; groups=${JSON.stringify([...groups].map(([name, items]) => [name, items.length]))}; knownDataDefects=${groupIssues.length - unexpected.length}; interruptCost=${JSON.stringify(interruptCost)}; behaviorCost=${JSON.stringify(behaviorCost)}`,
      )
    } finally {
      if (casc?.state === 'opened') await casc.session.dispose()
      await vfs.dispose()
      await data.release()
      await discovery.release()
    }
  }, 600_000)
})
