/**
 * Resolved Data of a real mod context through the host (V4), installed game only.
 *
 * Liberty is opened from CASC by the one mod loader and analyzed once by the host's resolved-data
 * workspace. Two checks read that snapshot: the entity card built from it, and the parity of the
 * two Data inheritance resolvers the owner decided must become one — the host provider's and
 * catalog-engine's, reading the same layers.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  analyzeResolvedDataWorkspace,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createModContextDataWorkspaceInputs,
  registerServiceDefinitionsOrThrow,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { relationGraphNeighbourhood, type ResolvedDataWorkspaceSnapshot } from '@modkit/sdk'
import type { ModContext } from '@modkit/vfs/content-sources'
import { Sc2DesktopContentSources } from '../../game/battlenet/content-sources/local-content-sources.js'
import { readChainMod } from '../../mod/services/resources/src/effective-tree.js'
import {
  cardSourceOfSnapshot,
  entitySubjectId,
  entitySubjects,
  rawFieldsOfDefinition,
} from '../codecs/sc2data/src/entity-cards.js'

const installation = process.env['MODKITX_SC2_ROOT'] ?? 'C:/Apps/StarCraft II'
const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')
const enabled = process.env['MODKIT_TEST_TIER'] === 'real' && existsSync(join(installation, '.build.info'))

async function createServices() {
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
  return {
    inventory,
    target: { environment: 'node' as const, operatingSystem: 'windows' as const, architecture: 'x64' as const },
    executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
    serviceDefinitions,
  }
}

/*
 * One spelling for what both resolvers mean alike, so the report lists meaning, not notation:
 * `1` and `1.000000` are one number, and a positional item's numeric `index` (or its lone `value`
 * wrapper) is where it sits, not data. Named indices stay — there the index is the data.
 */
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return normalized(item)
      const { index, ...rest } = item as Record<string, unknown>
      const positional = typeof index === 'string' && /^\d+$/u.test(index)
      const kept = positional ? rest : item as Record<string, unknown>
      return positional && Object.keys(kept).length === 1 && 'value' in kept
        ? normalized(kept['value'])
        : normalized(kept)
    })
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]))
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return value
}

/** Arity is the projection's job (the schema says list or scalar), not the resolver's. */
function withoutArity(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 1 ? withoutArity(value[0]) : value.map(withoutArity)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutArity(item)]))
  }
  return value
}

/** `token`: the host left `##name##` unsubstituted; `arity`: only list-versus-scalar; else `value`. */
function differenceClass(host: unknown, engine: unknown): 'token' | 'arity' | 'value' {
  if (JSON.stringify(host ?? null).includes('##')) return 'token'
  return JSON.stringify(withoutArity(normalized(host))) === JSON.stringify(withoutArity(normalized(engine)))
    ? 'arity' : 'value'
}

/** Where two normalized values first part: the path and the two values there. */
function divergence(left: unknown, right: unknown, path = ''): { path: string; host: string; engine: string } {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return { path: `${path} length ${left.length}/${right.length}`, host: JSON.stringify(left).slice(0, 400), engine: JSON.stringify(right).slice(0, 400) }
    }
    for (let index = 0; index < left.length; index += 1) {
      if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return divergence(left[index], right[index], `${path}[${index}]`)
    }
  } else if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const l = (left as Record<string, unknown>)[key]
      const r = (right as Record<string, unknown>)[key]
      if (JSON.stringify(l) !== JSON.stringify(r)) return divergence(l, r, `${path}.${key}`)
    }
  }
  return { path, host: JSON.stringify(left)?.slice(0, 400) ?? 'undefined', engine: JSON.stringify(right)?.slice(0, 400) ?? 'undefined' }
}

function canonical(value: unknown): string {
  return JSON.stringify(normalized(value))
}

describe.skipIf(!enabled)('installed SC2 resolved Data through the host', () => {
  let scratch = ''
  let sources: Sc2DesktopContentSources | undefined
  let context: ModContext | undefined
  let snapshot: ResolvedDataWorkspaceSnapshot | undefined
  let analysis: Extract<Awaited<ReturnType<typeof analyzeResolvedDataWorkspace>>, { state: 'resolved' }> | undefined
  let dispose: (() => Promise<void>) | undefined

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'sc2-card-'))
    sources = new Sc2DesktopContentSources({
      installationDirectory: installation,
      documentsDirectory: scratch,
      battleNetCacheDirectory: scratch,
      sc2MapsCacheDirectory: scratch,
    })
    const services = await createServices()
    context = await sources.openModContext({ schemaVersion: 1, target: {
      sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod',
    } })
    const { workspace, resources } = createModContextDataWorkspaceInputs(context)
    dispose = () => resources.dispose()
    const analyzed = await analyzeResolvedDataWorkspace({
      services,
      grant: { id: 'sc2-card-host-route', classes: [] },
      budgets: { maxInputBytes: 268_435_456n, maxDepth: 128, maxNodes: 750_000, maxScalarBytes: 134_217_728, maxDiagnostics: 100 },
      workspace,
      resources,
      locales: ['enUS'],
      queries: [{ namespace: 'Unit', entityId: 'Marine' }],
      localizationKeys: [],
      limits: { maxRequirements: 512, maxDocumentBytes: 16_777_216, maxTextBytes: 268_435_456,
        maxEntities: 100_000, maxDepth: 128, maxPageSize: 128 },
    })
    if (analyzed.state !== 'resolved') {
      throw new Error(JSON.stringify(analyzed.diagnostics).slice(0, 2000))
    }
    snapshot = analyzed.snapshot
    analysis = analyzed
  }, 600_000)

  /*
   * Parity plan 5.18: the graph a view draws from a root is the host's resolved relations walked by
   * the one traversal. Its pages are larger than the source's (128 here), which the source serves a
   * page at a time (core 7a4d1670) instead of refusing.
   */
  it('walks the resolved relations two edges out from Marine', { timeout: 300_000 }, async () => {
    const around = await relationGraphNeighbourhood(analysis!.facets.relations.value, {
      roots: ['Unit/Marine'],
      depth: 2,
      direction: 'outgoing',
      maxNodes: 5_000,
      maxEdges: 20_000,
      scanLimit: 4_000_000,
    })
    const ids = new Set(around.nodes.map(node => node.id))
    expect(ids.has('Unit/Marine')).toBe(true)
    // One edge out: the weapon and the ability; two: what the weapon's effect is.
    const first = new Set(around.edges.filter(edge => edge.from === 'Unit/Marine').map(edge => edge.to))
    const weapon = [...first].find(id => id.startsWith('Weapon/'))
    expect(weapon).toBeDefined()
    expect(around.edges.some(edge => edge.from === weapon && edge.to.startsWith('Effect/'))).toBe(true)
    expect(around.capped).toBe(false)
    expect(around.scanned.edges.exhausted).toBe(true)
  })

  /*
   * Parity plan 5.2: a card's source opens the declaration — the layer file in CASC
   * (`content-source://local:casc/…`) at the entity's opening tag.
   */
  it('gives the Marine card sources their file address and declaring line', { timeout: 300_000 }, async () => {
    const lease = await analysis!.openSubjectFacts!({
      subject: { namespace: 'Unit', entityId: 'Marine' },
      maxEntities: 100_000,
      maxRelations: 1_000_000,
      maxCalculations: 64,
      maxPageSize: 128,
    })
    try {
      const stats = (await lease.value.facts('stats', { limit: 64 })).items
      const life = stats.find(item => item.id === 'life')
      const declared = life?.provenance?.find(item => item.source !== undefined)
      expect(declared?.source?.uri).toMatch(/^content-source:\/\/local%3Acasc\/mods\/liberty\.sc2mod\/.*unitdata\.xml$/iu)
      expect(declared?.range).toMatchObject({ line: expect.any(Number), column: expect.any(Number) })
      expect((declared?.range as { line: number }).line).toBeGreaterThan(0)
    } finally {
      await lease.release()
    }
  })

  afterAll(async () => {
    await dispose?.()
    await context?.dispose()
    await sources?.dispose()
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  it('builds the Marine card from the snapshot', { timeout: 300_000 }, async () => {
    const marine = snapshot!.definitions.find(item => item.namespace === 'Unit' && item.entityId === 'Marine')!
    // The chain is the loader's: Marine's own values come from Liberty over Core.
    expect(marine.fieldSources?.['LifeMax']?.path).toMatch(/liberty\.sc2mod\/.*unitdata\.xml$/iu)

    const selector = entitySubjects(cardSourceOfSnapshot(snapshot!), {
      snapshotId: snapshot!.snapshotId,
      source: { id: 'sc2-card-host-route', uri: 'memory://sc2-card-host-route' },
    })
    const lease = await selector.openFacts(entitySubjectId('Unit', 'Marine'))
    try {
      const values = async (group: string) =>
        (await lease.value.facts(group, { limit: 200 })).items.map(fact => fact.value)
      expect(await values('stats')).toEqual(expect.arrayContaining([45, 50]))
      expect(await values('weapons')).toContainEqual(expect.objectContaining({ damage: 6 }))
      expect(await values('command-card')).toContainEqual(expect.objectContaining({
        face: 'Stim', ability: entitySubjectId('Abil', 'Stimpack'),
      }))
      expect(await values('producers')).toContainEqual(
        expect.arrayContaining([expect.stringMatching(/^Barracks → /u)]),
      )
      expect((await lease.value.relations({ limit: 200 })).items).toContainEqual(
        expect.objectContaining({ role: 'Produced by', subjectId: entitySubjectId('Unit', 'Barracks') }),
      )
    } finally {
      await lease.release()
    }
  })

  /*
   * S1 of the one-resolver decision: where the host provider and catalog-engine disagree about the
   * same layers. The report is the work list; the assertion only pins that both read the chain.
   */
  it('compares the two Data resolvers over the same layers', { timeout: 600_000 }, async () => {
    const layers = context!.layers.map(layer => layer.id)
    const lists = await Promise.all(layers.map(async layerId => {
      const paths: string[] = []
      let cursor: string | undefined
      do {
        const page = await context!.files(layerId, { limit: 10_000, ...(cursor === undefined ? {} : { cursor }) })
        paths.push(...page.items)
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return paths
    }))
    const { mod } = await readChainMod(layers, lists,
      (layerId, path) => context!.read(layerId, path, 64 * 1024 * 1024),
      { bytes: new Map(), parsed: new Map() })

    const byField = new Map<string, { count: number; sample: { entity: string; host: string; engine: string } }>()
    const byClass = { token: 0, arity: 0, value: 0 }
    const valueFields = new Map<string, { count: number; samples: Record<string, string>[] }>()
    const missingInEngine: string[] = []
    let compared = 0
    let equal = 0
    const hostKeys = new Set<string>()
    for (const definition of snapshot!.definitions) {
      const key = `${definition.namespace}/${definition.entityId}`
      hostKeys.add(key)
      const engine = mod.getResolved(definition.namespace, definition.entityId) as Record<string, unknown> | undefined
      if (engine === undefined) {
        missingInEngine.push(key)
        continue
      }
      const host = rawFieldsOfDefinition(definition)
      let same = true
      for (const field of new Set([...Object.keys(host), ...Object.keys(engine)])) {
        const left = canonical(host[field])
        const right = canonical(engine[field])
        if (left === right) continue
        same = false
        const id = `${definition.namespace}.${field}`
        const kind = differenceClass(host[field], engine[field])
        byClass[kind] += 1
        if (kind === 'value') {
          const entry = valueFields.get(id) ?? { count: 0, samples: [] }
          entry.count += 1
          if (entry.samples.length < 4) {
            const at = divergence(normalized(host[field]), normalized(engine[field]))
            entry.samples.push({ entity: key, ...at,
              hostSource: JSON.stringify(definition.fieldSources?.[field] ?? null),
              engineSource: JSON.stringify(mod.getResolvedSources(definition.namespace, definition.entityId)?.[field] ?? null),
              hostChain: JSON.stringify(definition.inheritanceChain ?? definition.parentEntityId ?? null),
              engineChain: (() => {
                const chain: string[] = []
                let cursor = mod.get(definition.namespace, definition.entityId)
                while (cursor !== undefined && chain.length < 16) {
                  chain.push(`${cursor.class}:${cursor.id}`)
                  cursor = cursor.parent === undefined ? undefined : mod.get(definition.namespace, cursor.parent)
                }
                return chain.join(' <- ')
              })() })
          }
          valueFields.set(id, entry)
        }
        const known = byField.get(id)
        if (known === undefined) {
          byField.set(id, { count: 1, sample: { entity: key, host: left?.slice(0, 400) ?? 'undefined', engine: right?.slice(0, 400) ?? 'undefined' } })
        } else known.count += 1
      }
      compared += 1
      if (same) equal += 1
    }
    const missingInHost = mod.namespaces().flatMap(namespace =>
      mod.all(namespace).map(entity => `${namespace}/${entity.id}`).filter(key => !hostKeys.has(key)))
    const fields = [...byField].sort((left, right) => right[1].count - left[1].count)
    const perNamespace = (keys: readonly string[]) => Object.fromEntries(Object.entries(
      keys.reduce<Record<string, number>>((counts, key) => {
        const namespace = key.slice(0, key.indexOf('/'))
        counts[namespace] = (counts[namespace] ?? 0) + 1
        return counts
      }, {})).sort((left, right) => right[1] - left[1]))
    const report = {
      layers: context!.layers.map(layer => layer.sourcePath),
      hostDefinitions: snapshot!.definitions.length,
      compared,
      equal,
      missingInEngine: { count: missingInEngine.length, byNamespace: perNamespace(missingInEngine),
        sample: missingInEngine.slice(0, 20) },
      missingInHost: { count: missingInHost.length, byNamespace: perNamespace(missingInHost),
        byFile: Object.fromEntries(Object.entries(missingInHost.reduce<Record<string, number>>((counts, key) => {
          const slash = key.indexOf('/')
          const file = mod.get(key.slice(0, slash), key.slice(slash + 1))?.source?.file ?? '?'
          counts[file] = (counts[file] ?? 0) + 1
          return counts
        }, {})).sort((left, right) => right[1] - left[1]).slice(0, 30)),
        defaults: missingInHost.filter(key => key.endsWith('/')).length,
        sample: missingInHost.filter(key => !key.endsWith('/') && !key.startsWith('Const/')).slice(0, 20) },
      differingFields: fields.length,
      byClass,
      valueFields: [...valueFields].sort((left, right) => right[1].count - left[1].count)
        .map(([id, value]) => ({ id, ...value })),
      fields: fields.map(([id, value]) => ({ id, ...value })),
    }
    const out = process.env['MODKIT_RESOLVER_PARITY_OUT']
    if (out !== undefined) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ ...report, fields: report.fields.slice(0, 40), valueFields: report.valueFields.slice(0, 40) }, null, 1))
    expect(compared).toBeGreaterThan(1_000)
  })
})
