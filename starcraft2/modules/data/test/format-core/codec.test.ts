/**
 * (a) The `sc2-data` `GameArtifactCodec` adapter: structural detection, descriptor
 * serializability, stable operation IDs, and registry routing.
 */

import { describe, expect, it } from 'vitest'
import {
  createMemoryAssetSource,
  findDanglingDiagnosticIds,
  isSerializableDescriptor,
  isWellFormedCapabilityId,
  operationHandlerId,
  referencedDiagnosticIds,
  resolveContributions,
} from '@modkit/codec-kit/legacy/assets'
import { createSc2DataCodec, detectSc2Data } from '../../shared/format/codec.js'
import {
  SC2_DATA_OPERATIONS,
  SINGLE_SOURCE_DIAGNOSTIC_ID,
  UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID,
} from '../../shared/format/describe.js'
import { detectSc2DataBytes } from '../../shared/format/detect.js'
import { SC2_DATA_CODEC_ID } from '../../shared/format/identity.js'
import { DATA_OPERATION_IDS } from '../../shared/catalog-engine/operations'
import {
  CHAINED_BASE_XML,
  CHAINED_LEAF_XML,
  FOREIGN_CATALOG_XML,
  SELF_CONTAINED_XML,
  UNRELATED_XML,
  fixtureSource,
} from './fixtures.js'

const codec = createSc2DataCodec()

const openSelfContained = () => codec.open(fixtureSource(SELF_CONTAINED_XML), {})

describe('sc2-data detection', () => {
  it('keeps the compatibility source wrapper equivalent to the owned-bytes detector', async () => {
    const source = fixtureSource(SELF_CONTAINED_XML, {
      parentArtifactIds: ['sc2-mod'],
      gameId: 'starcraft-2',
    })
    const bytes = await source.read()

    await expect(detectSc2Data(source, {})).resolves.toEqual(
      detectSc2DataBytes(bytes, source.descriptor, {}),
    )
  })

  it('recognizes a Catalog-rooted GameData document structurally', async () => {
    const result = await detectSc2Data(
      fixtureSource(SELF_CONTAINED_XML, { parentArtifactIds: ['sc2-mod'], gameId: 'starcraft-2' }),
      {},
    )
    expect(result.pluginId).toBe(SC2_DATA_CODEC_ID)
    expect(result.confidence).toBeGreaterThan(0.7)

    const kinds = result.evidence.map(evidence => evidence.kind)
    expect(kinds).toContain('structure')
    expect(kinds).toContain('path')
    expect(kinds).toContain('context')
    // The structural evidence names the manifest's xmlRoot and the classes it actually found.
    expect(result.evidence.some(e => e.detail?.includes('root element Catalog'))).toBe(true)
    expect(result.evidence.some(e => e.detail?.includes('CUnit'))).toBe(true)
    // Detection is bounded: it declares the single header range it read.
    expect(result.requiredRanges).toHaveLength(1)
    expect(result.requiredRanges[0]?.offset).toBe(0)
  })

  it('rejects ordinary XML that merely has the .xml extension', async () => {
    const result = await detectSc2Data(
      fixtureSource(UNRELATED_XML, { parentArtifactIds: ['sc2-mod'] }),
      {},
    )
    expect(result.confidence).toBe(0)
    expect(result.evidence.some(e => e.kind === 'structure' && e.polarity === 'negative')).toBe(
      true,
    )
  })

  it('rejects a Catalog root whose children name no known catalog class', async () => {
    const result = await detectSc2Data(
      fixtureSource(FOREIGN_CATALOG_XML, { parentArtifactIds: ['sc2-mod'] }),
      {},
    )
    // A `Catalog` root alone is not enough — this is the structural half of section 5.8's rule.
    expect(result.confidence).toBe(0)
    const negative = result.evidence.find(e => e.polarity === 'negative')
    expect(negative?.kind).toBe('structure')
    expect(negative?.detail).toContain('Product')
  })

  it('does not claim a valid catalog that has no SC2 artifact or GameData context', async () => {
    const withContext = await detectSc2Data(
      fixtureSource(SELF_CONTAINED_XML, { parentArtifactIds: ['sc2-map'] }),
      {},
    )
    const withoutContext = await detectSc2Data(
      fixtureSource(SELF_CONTAINED_XML, { path: 'scratch/notes.xml' }),
      {},
    )

    // Structurally identical documents, but "arbitrary XML outside those contexts is not
    // claimed by sc2-data" (section 5.8): it stays an Open With route, capped well below the
    // in-context score, and says why.
    expect(withoutContext.confidence).toBeLessThan(withContext.confidence)
    expect(withoutContext.confidence).toBeLessThanOrEqual(0.35)
    expect(
      withoutContext.evidence.some(e => e.kind === 'context' && e.polarity === 'negative'),
    ).toBe(true)
    // It is a soft signal, not a structural rejection — the document really is a catalog.
    expect(
      withoutContext.evidence.some(e => e.kind === 'structure' && e.polarity === 'negative'),
    ).toBe(false)
  })

  it('claims a catalog in a folder under GameData or anywhere in a package folder (plan 1.25)', async () => {
    const nested = await detectSc2Data(
      fixtureSource(SELF_CONTAINED_XML, { path: 'Base.SC2Data/GameData/Custom/MyData.xml' }),
      {},
    )
    const inPackage = await detectSc2Data(
      fixtureSource(SELF_CONTAINED_XML, { path: 'Mods/Test.SC2Mod/Custom/MyData.xml' }),
      {},
    )
    const loose = await detectSc2Data(fixtureSource(SELF_CONTAINED_XML, { path: 'scratch/notes.xml' }), {})
    for (const result of [nested, inPackage]) {
      expect(result.confidence).toBeGreaterThan(loose.confidence)
      expect(result.evidence.some(e => e.kind === 'context' && e.polarity === 'negative')).toBe(false)
    }
    expect(inPackage.evidence).toContainEqual({ kind: 'context', detail: 'inside Test.SC2Mod' })
  })

  it('accepts a truncated document, because detection reads a bounded header', async () => {
    const truncated = SELF_CONTAINED_XML.slice(0, 120)
    const result = await detectSc2Data(
      fixtureSource(truncated, { parentArtifactIds: ['sc2-mod'] }),
      {},
    )
    expect(result.confidence).toBeGreaterThan(0.5)
  })
})

describe('sc2-data descriptor', () => {
  it('produces a serializable descriptor with stable, non-empty operation IDs', async () => {
    const document = await openSelfContained()
    const descriptor = await codec.describe(document, {})

    expect(isSerializableDescriptor(descriptor)).toBe(true)
    expect(descriptor.schemaVersion).toBe(1)
    expect(descriptor.identity.pluginId).toBe(SC2_DATA_CODEC_ID)
    expect(descriptor.identity.formatId).toBe(SC2_DATA_CODEC_ID)
    expect(descriptor.identity.categories).toContain('semantic-game-asset')
    expect(descriptor.identity.confidence).toBe(document.detection.confidence)
    expect(descriptor.identity.detection.length).toBeGreaterThan(0)

    expect(descriptor.operations.length).toBe(SC2_DATA_OPERATIONS.length)
    for (const operation of descriptor.operations) {
      expect(operation.id.length).toBeGreaterThan(0)
      expect(operationHandlerId(operation)).toBe(`${SC2_DATA_CODEC_ID}.${operation.id}`)
      // "Disabled operations include a reason" (ASSET_CAPABILITIES.md section 5).
      if (operation.state !== 'available') expect(operation.reason).toBeDefined()
    }

    // IDs are unique and cover every verb of section 9's Data row.
    const ids = descriptor.operations.map(operation => operation.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of Object.values(DATA_OPERATION_IDS)) expect(ids).toContain(id)
  })

  it('reports honestly which section 9 verbs are wired and which are not', async () => {
    const document = await openSelfContained()
    const descriptor = await codec.describe(document, {})
    const state = (id: string): string | undefined =>
      descriptor.operations.find(operation => operation.id === id)?.state

    // Backed by catalog and the codec-owned GameData language core.
    expect(state(DATA_OPERATION_IDS.inspect)).toBe('available')
    expect(state(DATA_OPERATION_IDS.query)).toBe('available')
    expect(state(DATA_OPERATION_IDS.resolveInheritance)).toBe('available')
    expect(state(DATA_OPERATION_IDS.references)).toBe('available')
    expect(state(DATA_OPERATION_IDS.diagnostics)).toBe('available')

    // Consolidated from @modkitx/ops and @modkitx/export in Phase D item 3.
    expect(state(DATA_OPERATION_IDS.edit)).toBe('available')
    expect(state(DATA_OPERATION_IDS.export)).toBe('available')
    // Still owned by @modkitx/wiki — declared, disabled, and explained.
    expect(state(DATA_OPERATION_IDS.entityCards)).toBe('disabled')
    // Needs the dependency chain, which this codec never resolves.
    expect(state(DATA_OPERATION_IDS.compare)).toBe('disabled')
    const compare = descriptor.operations.find(o => o.id === DATA_OPERATION_IDS.compare)
    expect(compare?.reason?.diagnosticIds).toContain(SINGLE_SOURCE_DIAGNOSTIC_ID)
  })

  it('declares only traits that are true for the loaded document', async () => {
    const document = await openSelfContained()
    const descriptor = await codec.describe(document, {})
    const traits = new Map(descriptor.traits.map(trait => [trait.id, trait]))

    for (const trait of descriptor.traits) {
      expect(isWellFormedCapabilityId(String(trait.id))).toBe(true)
      expect(trait.version).toBe(1)
      if (trait.state !== 'available') expect(trait.diagnosticIds?.length).toBeGreaterThan(0)
    }

    expect(traits.get('game.catalog')?.parameters).toEqual({
      types: document.stats.rootTypes.length,
      namespaces: document.stats.namespaces.length,
      entities: document.stats.entityCount,
    })
    // Every ancestor is in-file, so the hierarchy is fully walkable.
    expect(traits.get('structure.hierarchy')?.state).toBe('available')
    expect(traits.get('code.source')?.parameters).toEqual({ language: 'xml', encoding: 'utf-8' })
    // The fixture declares no <const>, so the token-source trait must be absent.
    expect(traits.has('content.styles')).toBe(false)
  })

  it('degrades inheritance traits when the dependency chain was not supplied', async () => {
    const document = await codec.open(fixtureSource(CHAINED_LEAF_XML), {})
    const descriptor = await codec.describe(document, {})
    const traits = new Map(descriptor.traits.map(trait => [trait.id, trait]))

    // `Marauder` inherits from `StandardTerranUnit`, which lives in a dependency mod.
    expect(document.stats.unresolvedParents).toEqual([
      { namespace: 'Unit', id: 'Marauder', parent: 'StandardTerranUnit' },
    ])
    expect(traits.get('structure.hierarchy')?.state).toBe('partial')
    expect(traits.get('structure.hierarchy')?.diagnosticIds).toContain(
      UNRESOLVED_INHERITANCE_DIAGNOSTIC_ID,
    )
    expect(traits.get('source.dependencies')?.state).toBe('dependency-required')
    expect(descriptor.constraints.unsupportedFeatures).toContain('dependency-chain-resolution')
    expect(isSerializableDescriptor(descriptor)).toBe(true)

    // The operation still runs; it just tells the caller the merge was incomplete.
    const resolved = codec.resolveInheritance(document, 'Unit', 'Marauder')
    expect(resolved?.partial).toBe(true)
    expect(resolved?.fields['LifeMax']).toBe('125')
    // Nothing from the missing ancestor made it in.
    expect(resolved?.fields['Radius']).toBeUndefined()
  })

  it('resolves the full chain once the dependency file is supplied', async () => {
    const document = await codec.openCatalogFiles([
      fixtureSource(CHAINED_BASE_XML, { path: 'Mods/Base.SC2Mod/GameData/UnitData.xml' }),
      fixtureSource(CHAINED_LEAF_XML, { path: 'Mods/Leaf.SC2Mod/GameData/UnitData.xml' }),
    ])
    const descriptor = await codec.describe(document, {})
    const traits = new Map(descriptor.traits.map(trait => [trait.id, trait]))

    expect(document.stats.unresolvedParents).toEqual([])
    expect(traits.get('structure.hierarchy')?.state).toBe('available')
    expect(traits.get('source.dependencies')?.state).toBe('available')
    // The <const> in the base file is now a usable token source.
    expect(traits.get('content.styles')?.state).toBe('available')

    const resolved = codec.resolveInheritance(document, 'Unit', 'Marauder')
    expect(resolved?.partial).toBe(false)
    expect(resolved?.chain).toEqual(['StandardTerranUnit', 'Marauder'])
    // Child wins on LifeMax; Radius is inherited from the ancestor that was missing before.
    expect(resolved?.fields['LifeMax']).toBe('125')
    expect(resolved?.fields['Radius']).toBe('0.75')
  })

  it('references only diagnostics it also declares', async () => {
    for (const document of [
      await openSelfContained(),
      await codec.open(fixtureSource(CHAINED_LEAF_XML), {}),
    ]) {
      const descriptor = await codec.describe(document, {})
      expect(
        findDanglingDiagnosticIds(descriptor.diagnostics, [...referencedDiagnosticIds(descriptor)]),
      ).toEqual([])
    }
  })

  it('serves browse data through contributions instead of a private webview', async () => {
    const document = await openSelfContained()
    const descriptor = await codec.describe(document, {})
    const resolution = resolveContributions({
      traits: descriptor.traits,
      operations: descriptor.operations,
      contributions: descriptor.contributions,
      hostId: 'vscode',
    })
    expect(resolution.selected.map(contribution => contribution.id)).toEqual([
      'sc2-data.entities',
      'sc2-data.entity-fields',
      'sc2-data.source',
      'sc2-data.diagnostics',
    ])
    // The browse content itself is plain metadata, not markup.
    expect(descriptor.metadata.map(group => group.id)).toEqual([
      'identity',
      'catalog',
      'resolution',
    ])
  })
})

describe('sc2-data operations', () => {
  it('queries the catalog through TypedCatalog', async () => {
    const document = await openSelfContained()
    expect(codec.query(document, { namespace: 'Unit' }).map(entity => entity.id)).toEqual([
      'BaseUnit',
      'Marine',
    ])
    expect(codec.query(document, { id: 'mar' }).map(entity => entity.id)).toEqual(['Marine'])
    expect(codec.query(document, { class: 'CWeapon' }).map(entity => entity.id)).toEqual([
      'GaussRifle',
    ])
    expect(codec.query(document, { limit: 1 })).toHaveLength(1)
    // Declaration sites survive the adapter, so a host can open the right file and line.
    expect(codec.query(document, { id: 'Marine' })[0]?.sources[0]?.file).toBe('TestData.xml')
  })

  it('finds references through the codec language core', async () => {
    const document = await openSelfContained()
    const kinds = codec.references(document, 'Unit', 'BaseUnit').map(match => match.kind)
    // `BaseUnit` is declared once and referenced once as a parent.
    expect(kinds).toContain('definition')
    expect(kinds).toContain('parent')
    expect(codec.references(document, 'Unit', 'BaseUnit', false).map(m => m.kind)).toEqual([
      'parent',
    ])
    expect(codec.allReferences(document).length).toBeGreaterThanOrEqual(kinds.length)
  })

  it('validates through collectIssues with the loaded catalog as the reference oracle', async () => {
    const document = await openSelfContained()
    // The self-contained fixture references only entities it declares.
    expect(codec.validate(document)).toEqual([])

    const dangling = await codec.open(fixtureSource(CHAINED_LEAF_XML), {})
    // `PunisherGrenades` resolves nowhere in this single file — a real unresolved reference.
    const messages = codec.validate(dangling).map(issue => issue.message)
    expect(messages.some(message => message.includes('PunisherGrenades'))).toBe(true)
  })

  it('passes the real file name through, so file-category checks still fire', async () => {
    // Same bytes, but named as a standard data file: the language core then enforces that
    // `UnitData.xml` holds only Unit classes. The adapter must not swallow that.
    const named = await codec.open(
      fixtureSource(SELF_CONTAINED_XML, { path: 'Mods/Test.SC2Mod/GameData/UnitData.xml' }),
      {},
    )
    const issues = codec.validate(named)
    expect(issues.map(issue => issue.message)).toEqual([
      "'CWeapon' is a Weapon class and does not belong in Mods/Test.SC2Mod/GameData/UnitData.xml — expected a Unit class",
    ])
    expect(issues[0]?.severity).toBe('warning')
  })

  it('refuses a source that cannot be read as a catalog', async () => {
    const empty = createMemoryAssetSource(new Uint8Array(), {
      path: 'Mods/Test.SC2Mod/GameData/Empty.xml',
    })
    // Detection rejects it outright rather than throwing.
    const detection = await codec.detect(empty, {})
    expect(detection.confidence).toBe(0)
  })
})

// The registry-identity case that used to open this block moved to
// `packages/data-processing/test/semantic-facade.test.ts`: it asserts that the *facade*
// re-exports `@modkitx/semantic/data` by identity, which is a claim about that package and
// became vacuous here once this suite started importing the registry from semantic directly.
describe('sc2-data MK3 host seam', () => {
  it('opens a generic session and dispatches by descriptor handler ID', async () => {
    const source = fixtureSource(SELF_CONTAINED_XML, {
      parentArtifactIds: ['sc2-mod'],
      gameId: 'starcraft-2',
    })
    const context = { gameId: 'starcraft-2' }
    const document = await codec.open(source, context)
    const descriptor = await codec.describe(document, context)
    const session = await codec.createSession(document, context, descriptor, {
      grantedPermissions: ['read-source'],
    })
    const query = descriptor.operations.find(operation => operation.id === DATA_OPERATION_IDS.query)
    expect(query).toBeDefined()
    if (query === undefined) return

    await expect(session.invoke(operationHandlerId(query), { namespace: 'Unit' })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: 'Unit', id: 'Marine', class: 'CUnit' }),
      ]),
    )

    const compare = descriptor.operations.find(
      operation => operation.id === DATA_OPERATION_IDS.compare,
    )
    expect(compare).toBeDefined()
    if (compare === undefined) return
    await expect(session.invoke(operationHandlerId(compare))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      context: { state: 'disabled' },
    })
  })

  it('publishes enough structural evidence and metadata for MK3 host routing', async () => {
    const detection = await codec.detect(
      fixtureSource(SELF_CONTAINED_XML, { parentArtifactIds: ['sc2-mod'] }),
      { gameId: 'starcraft-2' },
    )
    expect(detection.pluginId).toBe(SC2_DATA_CODEC_ID)
    expect(detection.confidence).toBeGreaterThan(0.7)
    expect(codec.id).toBe(SC2_DATA_CODEC_ID)
    expect(codec.kind).toBe('data')
    expect(codec.operations.map(operation => operation.id)).toEqual(
      SC2_DATA_OPERATIONS.map(operation => operation.id),
    )
  })

  it('returns zero confidence for unrelated XML', async () => {
    const detection = await codec.detect(fixtureSource(UNRELATED_XML), {})
    expect(detection.confidence).toBe(0)
  })

  it('declares only the source kinds that the MK3 host may route to it', () => {
    expect(codec.sourceKinds).toContain('file')
    expect(codec.sourceKinds).not.toContain('directory')
  })
})
