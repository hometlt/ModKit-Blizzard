/** Native scalar-domain admission through the compiled readonly WC3 provider, not reference defaults. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Lease } from '@modkit/sdk'
import type { DataCatalogDocument, ResolvedDataWorkspace } from '@modkit/sdk/data'
import { TRUSTED_IN_PROCESS_EXECUTION_BACKEND, buildInventory, createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry, createHostContributionContractRegistry, createHostServiceResolver,
  registerServiceDefinitionsOrThrow, serviceDefinitionSurfaces } from '@modkit/host'
import { createNodeWorkerBackend, loadExtensionDirectory } from '@modkit/host/node'
import { extension } from './war3-harness.js'

const { createProvider } = (await import(pathToFileURL(join(extension, 'providers', 'war3-data', 'runtime.js')).href)) as {
  createProvider(selection: { contract: string }): Lease<ResolvedDataWorkspace>
}
const cases = [
  { type: 'defenseType', sheet: 'UnitBalance', field: 'defType', id: 'udty', members: ['normal', 'small', 'medium', 'large', 'fort', 'hero', 'divine', 'none'] },
  { type: 'weaponType', sheet: 'UnitWeapons', field: 'weapTp1', id: 'ua1w', members: ['normal', 'instant', 'artillery', 'aline', 'missile', 'msplash', 'mbounce', 'mline'] },
  { type: 'attackType', sheet: 'UnitWeapons', field: 'atkType1', id: 'ua1t', members: ['unknown', 'normal', 'pierce', 'siege', 'spells', 'chaos', 'magic', 'hero'] },
  { type: 'attributeType', sheet: 'UnitBalance', field: 'Primary', id: 'upra', members: ['AGI', 'INT', 'STR'] },
  { type: 'regenType', sheet: 'UnitBalance', field: 'regenType', id: 'uhrt', members: ['none', 'always', 'blight', 'day', 'night'] },
] as const
type Domain = typeof cases[number]

/** Produce authored SYLK fixtures without duplicating the production parser. */
function sheet(rows: readonly (readonly string[])[]): string {
  return ['ID;PWXL;N;E', ...rows.flatMap((row, y) => row.map((value, x) =>
    `C;X${String(x + 1)}${x === 0 ? `;Y${String(y + 1)}` : ''};K"${value}"`)), 'E', ''].join('\r\n')
}
/** Keep each fixture's selected native domain and exact raw values separate. */
function documents(domain: Domain, values: readonly string[] = domain.members): DataCatalogDocument[] {
  return [
    { rootId: 'game', path: 'UI/UnitEditorData.txt', text: `[${domain.type}]\nNumValues=${domain.members.length}\n${domain.members.map((member, index) => `${String(index).padStart(2, '0')}=${member},WESTRING_LABEL`).join('\n')}\n` },
    { rootId: 'game', path: 'Units/UnitMetaData.slk', text: sheet([
      ['ID', 'field', 'slk', 'index', 'repeat', 'data', 'type', 'useSpecific', 'notSpecific'],
      [domain.id, domain.field, domain.sheet, '-1', '0', '0', domain.type, '', ''],
    ]) },
    { rootId: 'game', path: `Units/${domain.sheet}.slk`, text: sheet([['unitID', domain.field], ...values.map((value, index) => [`u${String(index).padStart(3, '0')}`, value])]) },
  ]
}
/** Exercise the existing provider snapshot; release the lease even when admission refuses. */
async function analyze(inputs: readonly DataCatalogDocument[]) {
  const lease = createProvider({ contract: 'common.data/resolved-workspace' })
  try {
    return await lease.value.analyze({ workspaceId: 'enums', gameId: 'blizzard/warcraft-3', documents: inputs,
      queries: [], maxDocuments: 32, maxTextBytes: 1_000_000, maxEntities: 100, maxDepth: 16,
      plannedDocumentCount: inputs.length, unresolvedRequirementIds: [] })
  } finally { await lease.release() }
}
/** Observe the canonical schema field, never an alternate enum registry. */
function fieldType(snapshot: Awaited<ReturnType<typeof analyze>>, domain: Domain) {
  return snapshot.schemas?.find(schema => schema.typeId === 'unit')?.fields.find(field => field.fieldId === `${domain.sheet}.${domain.field}`)?.type
}

describe('WC3 native scalar domains', () => {
  it.each(cases)('publishes all native $type members with original lexemes and no writer', async domain => {
    const inputs = documents(domain)
    const before = JSON.stringify(inputs)
    const snapshot = await analyze(inputs)
    expect(fieldType(snapshot, domain)).toEqual({ kind: 'enum', members: domain.members.map(id => ({ id })) })
    for (const [index, member] of domain.members.entries()) {
      expect(snapshot.definitions.find(entity => entity.entityId === `u${String(index).padStart(3, '0')}`)?.fields[`${domain.sheet}.${domain.field}`]).toBe(member)
    }
    expect(JSON.stringify(inputs)).toBe(before)
  })

  it.each(cases)('retains authored unset strings outside the $type members', async domain => {
    const snapshot = await analyze(documents(domain, ['_', '-', '', domain.members[0]]))
    expect(fieldType(snapshot, domain)).toEqual({ kind: 'enum', members: domain.members.map(id => ({ id })), unknown: 'Native unset value' })
    expect(snapshot.definitions.find(entity => entity.entityId === 'u000')?.fields[`${domain.sheet}.${domain.field}`]).toBe('_')
  })

  for (const domain of cases) {
    for (const invalid of ['bogus', `${domain.members[0]},${domain.members[1]}`, ` ${domain.members[0]} `,
      domain.type === 'attributeType' ? 'agi' : domain.members[0].toUpperCase(),
      ...(domain.type === 'weaponType' ? ['none'] : domain.type === 'defenseType' ? ['heavy'] : domain.type === 'attackType' ? ['seige'] : [])]) {
      it.each([false, true])(`keeps ${domain.type} raw ${JSON.stringify(invalid)} untyped in either patch order (%s)`, async reversed => {
        // A later valid authored row must not resurrect a field rejected for a different entity.
        const snapshot = await analyze(documents(domain, reversed ? [invalid, domain.members[0]] : [domain.members[0], invalid]))
        expect(fieldType(snapshot, domain)).toBeUndefined()
        expect(snapshot.definitions.some(entity => entity.fields[`${domain.sheet}.${domain.field}`] === invalid)).toBe(true)
        expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'blizzard.warcraft3/data-enum-value-unqualified' }))
      })
    }
  }

  for (const domain of cases) {
    it.each(['index', 'repeat', 'data', 'useSpecific', 'notSpecific', 'conflict'])('retains the %s metadata guard for '+domain.type, async guard => {
      const inputs = documents(domain, [domain.members[0]])
      const row = [domain.id, domain.field, domain.sheet, '-1', '0', '0', domain.type, '', '']
      const slot = ['ID', 'field', 'slk', 'index', 'repeat', 'data', 'type', 'useSpecific', 'notSpecific'].indexOf(guard)
      if (guard !== 'conflict') row[slot] = guard === 'useSpecific' || guard === 'notSpecific' ? 'hfoo' : '1'
      inputs[1] = { rootId: 'game', path: 'Units/UnitMetaData.slk', text: sheet([
        ['ID', 'field', 'slk', 'index', 'repeat', 'data', 'type', 'useSpecific', 'notSpecific'], row,
        ...(guard === 'conflict' ? [['uoth', domain.field, domain.sheet, '-1', '0', '0', 'string', '', '']] : []),
      ]) }
      expect(fieldType(await analyze(inputs), domain)).toBeUndefined()
    })
    it.each(['NumValues=999\n00=normal,Label', 'NumValues=1\n00=normal,Label\n00=normal,Duplicate', 'NumValues=1\n00=normal,Label\nNumValues=1'])('does not resurrect a malformed winning '+domain.type+' domain (%s)', async body => {
      const inputs = documents(domain, [domain.members[0]])
      inputs.push({ rootId: 'map', path: 'UI/UnitEditorData.txt', text: `[${domain.type}]\n${body}\n` })
      expect(fieldType(await analyze(inputs), domain)).toBeUndefined()
    })
  }

  it.each(['trusted-node', 'portable'] as const)('publishes the readonly native enum through actual Host %s', async variant => {
    const inventory = await buildInventory([{ ...(await loadExtensionDirectory(extension)), execution: { origin: 'bundled', allowTrustedInProcess: variant === 'trusted-node' } }], createHostContributionContractRegistry())
    const definitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, definitions)
    const resolver = createHostServiceResolver({ inventory, definitions,
      target: { environment: variant === 'trusted-node' ? 'node' : 'node-worker', operatingSystem: 'windows', architecture: 'x64' },
      executionBackends: createExecutionBackendRegistry([variant === 'trusted-node' ? TRUSTED_IN_PROCESS_EXECUTION_BACKEND : createNodeWorkerBackend({ foreignSurfaces: () => serviceDefinitionSurfaces(definitions) })]),
      grant: { id: 'wc3-scalar-enums', classes: [] }, budgets: { maxInputBytes: 4_000_000n, maxScalarBytes: 4_000_000, maxDepth: 64, maxNodes: 100_000, maxDiagnostics: 100 } })
    try {
      const lease = await resolver.port.resolve({ contract: 'common.data/resolved-workspace', major: 1, facet: { gameId: 'blizzard/warcraft-3' } })
      try {
        for (const domain of cases) {
          const inputs = documents(domain, [domain.members[0], '_'])
          const snapshot = await lease.value.analyze({ workspaceId: 'host-enums', gameId: 'blizzard/warcraft-3', documents: inputs, queries: [], maxDocuments: 16, maxTextBytes: 1_000_000, maxEntities: 100, maxDepth: 16, plannedDocumentCount: inputs.length, unresolvedRequirementIds: [] })
          expect(fieldType(snapshot, domain)).toEqual({ kind: 'enum', members: domain.members.map(id => ({ id })), unknown: 'Native unset value' })
        }
        expect(lease.value.planEdit).toBeUndefined()
        expect(resolver.activationFacts).toContainEqual(expect.objectContaining({ providerId: 'blizzard/war3-resolved-data', runtimeVariant: variant, executionProfile: variant === 'trusted-node' ? 'trusted-in-process' : 'worker-brokered' }))
      } finally { await lease.release() }
    } finally { await resolver.release() }
  })
})
