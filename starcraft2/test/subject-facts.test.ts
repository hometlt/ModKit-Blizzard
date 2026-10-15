import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  openStarcraft2DataSource,
  openStarcraft2SubjectFactsSource,
} from '../modules/data/services/projections/data-sources.js'
import { starcraft2DeclaringTypeForField } from '../modules/data/services/schema/full-data-schema.js'
import { STARCRAFT2_DATA_SCHEMA_REVISION } from '../modules/data/services/schema/data-schema-identity.js'

interface SemanticCardFixtureCase {
  readonly typeId: string
  readonly sections: Readonly<Record<string, readonly string[]>>
  readonly sampleFields?: Readonly<Record<string, unknown>>
}

const semanticParityFixture = JSON.parse(
  readFileSync(new URL('./fixtures/semantic-card-graph-parity.json', import.meta.url), 'utf8'),
) as {
  readonly verdict: string
  readonly namespaces: Readonly<Record<string, SemanticCardFixtureCase>>
}

const source = Object.freeze({
  rootId: 'workspace',
  path: 'Base.SC2Data/GameData/TestData.xml',
  documentIndex: 0,
  revision: 'sha256:test-data',
})

function entity(namespace: string, typeId: string, entityId: string, fields: object) {
  return Object.freeze({
    namespace,
    typeId,
    entityId,
    inheritanceChain: Object.freeze([Object.freeze({ namespace, entityId })]),
    fields: Object.freeze(fields),
    sources: Object.freeze([source]),
    complete: true,
  })
}

function relation(
  fromNamespace: string,
  fromId: string,
  toNamespace: string,
  toId: string,
  role: string,
  dead = false,
) {
  return Object.freeze({
    from: Object.freeze({ namespace: fromNamespace, entityId: fromId }),
    to: Object.freeze({ namespace: toNamespace, entityId: toId }),
    role,
    dead,
    source,
  })
}

function snapshot(effectType = 'CEffectDamage', effectField = 'Effect') {
  const definitions = Object.freeze([
    entity('Unit', 'CUnit', 'Marine', {
      Name: 'Unit/Name/Marine',
      Description: 'Unit/Description/Marine',
      LifeMax: 45,
      ShieldsMax: 0,
      EnergyMax: 0,
      Speed: 2.25,
      Food: 1,
      KillXP: 100,
      Race: 'Terr',
      DeathType: 'Unit/DeathType/Normal',
      Attributes: Object.freeze(['Biological', 'Light']),
      WeaponArray: Object.freeze([
        Object.freeze({ index: '0', value: Object.freeze({ Link: 'GaussRifle' }) }),
      ]),
    }),
    entity('Weapon', 'CWeapon', 'GaussRifle', {
      Range: 5,
      Period: 0.75,
      [effectField]: effectType === 'CEffectDamage' ? 'GaussDamage' : 'GaussSet',
    }),
    entity(
      'Effect',
      effectType,
      effectType === 'CEffectDamage' ? 'GaussDamage' : 'GaussSet',
      effectType === 'CEffectDamage'
        ? { Amount: 6 }
        : { EffectArray: Object.freeze(['GaussDamage']) },
    ),
    entity('Actor', 'CActor', 'MarineActor', {}),
  ])
  const selectedEffect = effectType === 'CEffectDamage' ? 'GaussDamage' : 'GaussSet'
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: 'workspace:test',
    gameId: 'blizzard/starcraft-2',
    analyzerId: 'blizzard.starcraft2.data',
    typeIds: Object.freeze(['CUnit', 'CWeapon', effectType, 'CActor']),
    schemas: Object.freeze([]),
    namespaces: Object.freeze([
      Object.freeze({ namespace: 'Unit', entityCount: 1 }),
      Object.freeze({ namespace: 'Weapon', entityCount: 1 }),
      Object.freeze({ namespace: 'Effect', entityCount: 1 }),
      Object.freeze({ namespace: 'Actor', entityCount: 1 }),
    ]),
    entityCount: definitions.length,
    patchCount: definitions.length,
    definitions,
    entities: definitions,
    relations: Object.freeze([
      relation('Unit', 'Marine', 'Weapon', 'GaussRifle', 'WeaponArray[0].Link'),
      relation('Weapon', 'GaussRifle', 'Effect', selectedEffect, 'Effect.Link'),
      relation('Actor', 'MarineActor', 'Unit', 'Marine', 'UnitName'),
    ]),
    localizedStrings: Object.freeze([
      Object.freeze({
        key: 'Unit/Name/Marine',
        requestedLocale: 'enUS',
        resolvedLocale: 'enUS',
        value: 'Marine',
        source: Object.freeze({
          rootId: 'workspace',
          path: 'Base.SC2Data/LocalizedData/GameStrings.txt',
          documentIndex: 1,
          revision: 'sha256:test-strings',
        }),
        fallback: false,
      }),
    ]),
    diagnostics: Object.freeze([]),
    snapshotId: `provider-token:subject-facts-${effectType}`,
    complete: true,
  })
}

async function allPages<T>(
  read: (cursor: string | undefined) => Promise<{ items: readonly T[]; nextCursor?: string }>,
) {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const page = await read(cursor)
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return items
}

const openFacts = (data: ReturnType<typeof snapshot>) =>
  openStarcraft2SubjectFactsSource(data, {
    snapshotId: data.snapshotId,
    subject: { namespace: 'Unit', entityId: 'Marine' },
    maxPageSize: 2,
    maxEntities: 16,
    maxRelations: 16,
    maxCalculations: 4,
  })

const genericSubjectCases = Object.freeze(
  [
    ['Weapon', 'CardWeapon'],
    ['Abil', 'CardAbility'],
    ['Effect', 'CardEffect'],
    ['Behavior', 'CardBehavior'],
    ['Upgrade', 'CardUpgrade'],
    ['Button', 'CardButton'],
    ['Actor', 'CardActor'],
    ['Model', 'CardModel'],
  ].map(([namespace, entityId]) => {
    const profile = semanticParityFixture.namespaces[namespace]
    if (profile === undefined || profile.sampleFields === undefined) {
      throw new Error(`semantic parity fixture is missing ${namespace} sample fields`)
    }
    return Object.freeze({
      namespace,
      typeId: profile.typeId,
      entityId,
      sampleFields: profile.sampleFields,
      sectionIds: Object.freeze(Object.keys(profile.sections)),
    })
  }),
)

function genericSubjectSnapshot(subjectCase: (typeof genericSubjectCases)[number]) {
  const base = snapshot()
  const nameKey = `${subjectCase.namespace}/Name/${subjectCase.entityId}`
  const descriptionKey = `${subjectCase.namespace}/Description/${subjectCase.entityId}`
  const definition = entity(subjectCase.namespace, subjectCase.typeId, subjectCase.entityId, {
    ...subjectCase.sampleFields,
    Name: nameKey,
    Description: descriptionKey,
    SemanticValue: 42,
  })
  const definitions = Object.freeze([...base.definitions, definition])
  return Object.freeze({
    ...base,
    typeIds: Object.freeze([...base.typeIds, subjectCase.typeId]),
    definitions,
    entities: definitions,
    entityCount: definitions.length,
    patchCount: definitions.length,
    relations: Object.freeze([
      ...base.relations,
      relation('Unit', 'Marine', subjectCase.namespace, subjectCase.entityId, 'CardIncoming'),
      relation(subjectCase.namespace, subjectCase.entityId, 'Unit', 'Marine', 'CardOutgoing'),
    ]),
    localizedStrings: Object.freeze([
      ...base.localizedStrings,
      Object.freeze({
        key: nameKey,
        requestedLocale: 'enUS',
        resolvedLocale: 'enUS',
        value: `${subjectCase.namespace} card`,
        source,
        fallback: false,
      }),
      Object.freeze({
        key: descriptionKey,
        requestedLocale: 'enUS',
        resolvedLocale: 'enUS',
        value: `${subjectCase.namespace} description`,
        source,
        fallback: false,
      }),
    ]),
    snapshotId: `provider-token:subject-facts-${subjectCase.namespace.toLowerCase()}`,
  })
}

const openGenericFacts = (
  data: ReturnType<typeof genericSubjectSnapshot>,
  subjectCase: (typeof genericSubjectCases)[number],
) =>
  openStarcraft2SubjectFactsSource(data, {
    snapshotId: data.snapshotId,
    subject: { namespace: subjectCase.namespace, entityId: subjectCase.entityId },
    maxPageSize: 2,
    maxEntities: 16,
    maxRelations: 16,
    maxCalculations: 4,
  })

describe('StarCraft II Unit subject facts', () => {
  it('has one knowledge-pack entry for every curated target emitted by the first Unit slice', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../contributions/knowledge-data.json', import.meta.url), 'utf8'),
    )
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(',')}}`
      }
      return JSON.stringify(value)
    }
    const publishedTargets = new Set(
      manifest.spec.entries.map((entry: { target: unknown }) => canonical(entry.target)),
    )
    const leases = [openFacts(snapshot()), openFacts(snapshot('CEffectSet', 'DisplayEffect'))]
    try {
      const targets = []
      for (const lease of leases) {
        const groups = await allPages(cursor =>
          lease.value.groups({ ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
        )
        for (const group of groups) {
          // Every field names its schema place for optional help (plan 5.16); the pack curates the
          // card's own facts, as it does not the resolved field list either.
          if (group.id === 'resolved-fields' || group.id === 'fields') continue
          const facts = await allPages(cursor =>
            lease.value.facts(group.id, { ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
          )
          targets.push(
            ...facts.flatMap(fact =>
              fact.knowledgeTarget === undefined ? [] : [fact.knowledgeTarget],
            ),
          )
        }
      }
      expect(targets.length).toBeGreaterThan(0)
      for (const target of targets) expect(publishedTargets.has(canonical(target))).toBe(true)
    } finally {
      await Promise.all(leases.map(lease => lease.release()))
    }
  })

  it('keeps the canonical relation graph snapshot-bound and exposes both edge directions', async () => {
    const data = snapshot()
    const lease = openStarcraft2DataSource(data, 'relations', 2)
    try {
      const summary = await lease.value.summary()
      expect(summary).toMatchObject({
        snapshotId: data.snapshotId,
        totalNodes: 4,
        totalEdges: 3,
        completeness: 'complete',
      })
      const edges = await allPages(cursor =>
        lease.value.edges({ ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'Unit/Marine',
            to: 'Weapon/GaussRifle',
            role: 'WeaponArray[0].Link',
          }),
          expect.objectContaining({
            from: 'Weapon/GaussRifle',
            to: 'Effect/GaussDamage',
            role: 'Effect.Link',
          }),
          expect.objectContaining({
            from: 'Actor/MarineActor',
            to: 'Unit/Marine',
            role: 'UnitName',
          }),
        ]),
      )
      expect(edges.filter(edge => edge.from === 'Unit/Marine')).toHaveLength(1)
      expect(edges.filter(edge => edge.to === 'Unit/Marine')).toHaveLength(1)
    } finally {
      await lease.release()
    }
  })

  /*
   * One SC2 entity card (parity plan 5.6): the sc2data codec's projection, fed the snapshot's values
   * resolved along the mod chain. What only a resolved workspace knows travels with it — the layers
   * behind each value, field help, every resolved field, the weapon calculation, the snapshot's edges.
   */
  it('builds the one entity card over the snapshot, with calculations, knowledge and layered provenance', async () => {
    const data = snapshot()
    const lease = openFacts(data)
    try {
      const summary = await lease.value.summary()
      expect(summary).toMatchObject({
        snapshotId: data.snapshotId,
        identity: { subjectId: 'Unit/Marine', label: 'Marine', kind: 'Unit', type: 'CUnit' },
        provenance: {
          schema: {
            contract: 'blizzard/sc2-data-schema',
            // The schema's own revision, not a second copy of it: `full-data-schema.test.ts`
            // pins the corrected schema, so repeating the digest here only went stale.
            revision: STARCRAFT2_DATA_SCHEMA_REVISION,
          },
        },
        completeness: {
          state: 'complete',
          reasons: [],
          calculation: { state: 'complete', computedWeapons: 1 },
        },
      })
      expect(summary.identity.origins[0].label).toContain('TestData.xml@sha256:test-data')

      const groups = await allPages(cursor =>
        lease.value.groups({ ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(groups.map(group => group.id)).toEqual([
        'stats',
        'overview',
        'weapons',
        'fields',
        'resolved-fields',
      ])

      // A card value names the field it came from, so the host can turn it into an edit target.
      const stats = await allPages(cursor =>
        lease.value.facts('stats', { ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(stats).toContainEqual(
        expect.objectContaining({
          id: 'life',
          value: 45,
          provenance: [
            expect.objectContaining({
              label: expect.stringContaining('TestData.xml'),
              semanticPath: ['Unit', 'Marine', 'LifeMax'],
            }),
          ],
        }),
      )

      const resolvedFields = await allPages(cursor =>
        lease.value.facts('resolved-fields', {
          ...(cursor === undefined ? {} : { cursor }),
          limit: 2,
        }),
      )
      expect(resolvedFields).toHaveLength(Object.keys(data.definitions[0].fields).length)
      expect(
        resolvedFields.find(fact => fact.label === 'DeathType')?.knowledgeTarget,
      ).toMatchObject({ typeId: 'CUnit', canonicalPath: ['DeathType'] })
      const name = resolvedFields.find(fact => fact.label === 'Name')
      expect(name?.value).toBe('Marine')
      expect(name?.provenance).toHaveLength(2)

      const weaponFacts = await allPages(cursor =>
        lease.value.facts('weapons', { ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(weaponFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'weapon-0-link',
            value: 'GaussRifle',
            knowledgeTarget: expect.objectContaining({
              typeId: 'CUnit',
              canonicalPath: ['WeaponArray', 'Link'],
            }),
          }),
          expect.objectContaining({
            id: 'weapon-0-period',
            value: 0.75,
            knowledgeTarget: expect.objectContaining({ typeId: 'CWeapon', canonicalPath: ['Period'] }),
          }),
          expect.objectContaining({
            id: 'weapon-0-damage',
            value: 6,
            knowledgeTarget: expect.objectContaining({
              typeId: 'CEffectDamage',
              canonicalPath: ['Amount'],
            }),
          }),
          expect.objectContaining({
            id: 'weapon-0-dps',
            value: 8,
            knowledgeTarget: {
              kind: 'concept',
              ecosystem: 'starcraft-2',
              conceptId: 'simple-weapon-dps',
            },
          }),
        ]),
      )
      // One DPS per card: the calculation's, not also the card assembler's estimate.
      expect(weaponFacts.filter(fact => /dps/iu.test(JSON.stringify(fact.value)))).toEqual([])

      const relations = await allPages(cursor =>
        lease.value.relations({ ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(relations).toEqual([
        expect.objectContaining({ role: 'Weapons', subjectId: 'Weapon/GaussRifle' }),
        expect.objectContaining({
          direction: 'incoming',
          edgeRole: 'UnitName',
          role: 'incoming:UnitName',
          subjectId: 'Actor/MarineActor',
        }),
        expect.objectContaining({
          direction: 'outgoing',
          edgeRole: 'WeaponArray[0].Link',
          role: 'outgoing:WeaponArray[0].Link',
          subjectId: 'Weapon/GaussRifle',
        }),
      ])
    } finally {
      await lease.release()
    }
  })

  it('builds the same card for every catalog namespace', async () => {
    expect(semanticParityFixture.verdict).toBe('parity')
    for (const subjectCase of genericSubjectCases) {
      const data = genericSubjectSnapshot(subjectCase)
      const lease = openGenericFacts(data, subjectCase)
      try {
        const summary = await lease.value.summary()
        expect(summary).toMatchObject({
          snapshotId: data.snapshotId,
          identity: {
            subjectId: `${subjectCase.namespace}/${subjectCase.entityId}`,
            label: `${subjectCase.namespace} card`,
            kind: subjectCase.namespace,
            type: subjectCase.typeId,
          },
          completeness: { state: 'complete', relations: 'complete' },
        })
        const groups = await allPages(cursor =>
          lease.value.groups({ ...(cursor === undefined ? {} : { cursor }), limit: 1 }),
        )
        expect(groups.map(group => group.id)).toEqual(
          expect.arrayContaining(['overview', 'resolved-fields']),
        )

        const facts = await allPages(cursor =>
          lease.value.facts('resolved-fields', {
            ...(cursor === undefined ? {} : { cursor }),
            limit: 1,
          }),
        )
        expect(facts.map(fact => fact.label)).toEqual(
          Object.keys(data.definitions.at(-1)?.fields ?? {}).sort((left, right) =>
            left.localeCompare(right),
          ),
        )
        expect(facts.find(fact => fact.label === 'Name')?.value).toBe(
          `${subjectCase.namespace} card`,
        )
        expect(facts.find(fact => fact.label === 'Description')?.value).toBe(
          `${subjectCase.namespace} description`,
        )
        for (const fact of facts) {
          expect(fact.knowledgeTarget).toMatchObject({
            kind: 'field',
            ecosystem: 'starcraft-2',
            typeId: starcraft2DeclaringTypeForField(subjectCase.typeId, fact.label),
            canonicalPath: [fact.label],
          })
          expect(fact.provenance.length).toBeGreaterThan(0)
        }

        const relations = await allPages(cursor =>
          lease.value.relations({ ...(cursor === undefined ? {} : { cursor }), limit: 1 }),
        )
        expect(relations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              direction: 'incoming',
              edgeRole: 'CardIncoming',
              subjectId: 'Unit/Marine',
            }),
            expect.objectContaining({
              direction: 'outgoing',
              edgeRole: 'CardOutgoing',
              subjectId: 'Unit/Marine',
            }),
          ]),
        )
      } finally {
        await lease.release()
      }
    }
  })

  it('shows a Unit command card, abilities and behaviors as the card assembler does', async () => {
    const base = snapshot()
    const originalUnit = base.definitions.find(
      item => item.namespace === 'Unit' && item.entityId === 'Marine',
    )
    if (originalUnit === undefined) throw new Error('Unit/Marine fixture is missing')
    const enrichedUnit = entity('Unit', 'CUnit', 'Marine', {
      ...originalUnit.fields,
      CardLayouts: Object.freeze([
        Object.freeze({
          CardId: 'Root',
          LayoutButtons: Object.freeze([Object.freeze({ Face: 'CardButton' })]),
        }),
      ]),
      AbilArray: Object.freeze([Object.freeze({ Link: 'CardAbility' })]),
      BehaviorArray: Object.freeze([Object.freeze({ Link: 'CardBehavior' })]),
    })
    const definitions = Object.freeze([
      ...base.definitions.map(item => (item === originalUnit ? enrichedUnit : item)),
      entity('Abil', 'CAbilEffectInstant', 'CardAbility', {}),
      entity('Behavior', 'CBehaviorBuff', 'CardBehavior', {}),
    ])
    const data = Object.freeze({
      ...base,
      definitions,
      entities: definitions,
      snapshotId: 'provider-token:subject-facts-unit-semantic-parity',
    })
    const lease = openFacts(data)
    try {
      const groups = await allPages(cursor =>
        lease.value.groups({ ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(groups.map(group => group.id)).toContain('command-card')
      const commands = await allPages(cursor =>
        lease.value.facts('command-card', { ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(commands).toContainEqual(
        expect.objectContaining({ value: expect.objectContaining({ page: 'Root', face: 'CardButton' }) }),
      )
      const relations = await allPages(cursor =>
        lease.value.relations({ ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'Abilities', subjectId: 'Abil/CardAbility' }),
          expect.objectContaining({ role: 'Behaviors', subjectId: 'Behavior/CardBehavior' }),
          expect.objectContaining({ role: 'Command buttons', subjectId: 'Button/CardButton' }),
        ]),
      )
      const resolvedFields = await allPages(cursor =>
        lease.value.facts('resolved-fields', { ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      for (const fieldId of ['CardLayouts', 'AbilArray', 'BehaviorArray'])
        expect(resolvedFields.find(fact => fact.label === fieldId)).toMatchObject({
          knowledgeTarget: { kind: 'field', ecosystem: 'starcraft-2', typeId: 'CUnit' },
          provenance: [expect.objectContaining({ label: expect.stringContaining('TestData.xml') })],
        })
    } finally {
      await lease.release()
    }
  })

  it('keeps card cursors subject-bound and observes cancellation', async () => {
    const weapon = genericSubjectCases[0]
    const ability = genericSubjectCases[1]
    const weaponLease = openGenericFacts(genericSubjectSnapshot(weapon), weapon)
    const abilityLease = openGenericFacts(genericSubjectSnapshot(ability), ability)
    try {
      const firstPage = await weaponLease.value.facts('resolved-fields', { limit: 1 })
      expect(firstPage.nextCursor).toBeDefined()
      await expect(
        abilityLease.value.facts('resolved-fields', { cursor: firstPage.nextCursor, limit: 1 }),
      ).rejects.toThrow()

      const controller = new AbortController()
      controller.abort(new Error('generic card cancelled'))
      await expect(weaponLease.value.summary(controller.signal)).rejects.toThrow(
        'generic card cancelled',
      )
    } finally {
      await Promise.all([weaponLease.release(), abilityLease.release()])
    }
  })

  it('opens every namespace the snapshot defines and refuses absent or unbounded entities', async () => {
    const data = snapshot()
    const actor = openStarcraft2SubjectFactsSource(data, {
      snapshotId: data.snapshotId,
      subject: { namespace: 'Actor', entityId: 'MarineActor' },
      maxPageSize: 2,
      maxEntities: 16,
      maxRelations: 16,
    })
    try {
      expect((await actor.value.summary()).identity).toMatchObject({
        subjectId: 'Actor/MarineActor',
        kind: 'Actor',
      })
    } finally {
      await actor.release()
    }
    expect(() =>
      openStarcraft2SubjectFactsSource(data, {
        snapshotId: data.snapshotId,
        subject: { namespace: 'Sound', entityId: 'MarineVoice' },
        maxPageSize: 2,
      }),
    ).toThrow('Sound/MarineVoice is absent from snapshot')

    const subjectCase = genericSubjectCases[0]
    const bounded = genericSubjectSnapshot(subjectCase)
    const oversized = entity(
      subjectCase.namespace,
      subjectCase.typeId,
      'OversizedWeapon',
      Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => [`Field${index}`, index])),
    )
    const definitions = Object.freeze([...bounded.definitions, oversized])
    const oversizedSnapshot = Object.freeze({
      ...bounded,
      definitions,
      entities: definitions,
      entityCount: definitions.length,
      patchCount: definitions.length,
    })
    expect(() =>
      openStarcraft2SubjectFactsSource(oversizedSnapshot, {
        snapshotId: oversizedSnapshot.snapshotId,
        subject: { namespace: subjectCase.namespace, entityId: 'OversizedWeapon' },
        maxPageSize: 2,
        maxEntities: 16,
        maxRelations: 16,
      }),
    ).toThrow('at most 4096 top-level entries')
  })

  it('publishes unsupported effect-chain facts without inventing DPS', async () => {
    const lease = openFacts(snapshot('CEffectSet'))
    try {
      const summary = await lease.value.summary()
      expect(summary.completeness).toMatchObject({
        state: 'partial',
        calculation: { state: 'unsupported', unsupportedWeapons: 1 },
      })
      expect(summary.completeness.reasons).toContain('calculation-unsupported')
      expect(summary.warnings.map(item => item.code)).toContain(
        'blizzard.starcraft2/calculation-effect-chain-unsupported',
      )
      const weaponFacts = await allPages(cursor =>
        lease.value.facts('weapons', { ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(weaponFacts.some(fact => fact.id === 'weapon-0-dps')).toBe(false)
      expect(weaponFacts.find(fact => fact.id === 'weapon-0-calculation')?.value).toMatchObject({
        status: 'unsupported',
        completeness: 'unsupported',
      })
    } finally {
      await lease.release()
    }
  })

  it('keeps unresolved outgoing relations visible and lowers relation completeness', async () => {
    const base = snapshot()
    const data = Object.freeze({
      ...base,
      relations: Object.freeze([
        ...base.relations,
        relation('Unit', 'Marine', 'Behavior', 'MissingStim', 'BehaviorArray[0].Link', true),
      ]),
    })
    const lease = openFacts(data)
    try {
      const summary = await lease.value.summary()
      expect(summary.completeness).toMatchObject({ relations: 'incomplete' })
      expect(summary.completeness.reasons).toContain('dead-relations')
      expect(summary.warnings.map(item => item.code)).toContain(
        'blizzard.starcraft2/subject-facts-dead-relations',
      )
      const relations = await allPages(cursor =>
        lease.value.relations({ ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      )
      expect(relations).toContainEqual(
        expect.objectContaining({
          direction: 'outgoing',
          dead: true,
          subjectId: 'Behavior/MissingStim',
        }),
      )
    } finally {
      await lease.release()
    }
  })

  it('enforces snapshot identity and scan bounds and observes cancellation', async () => {
    const data = snapshot()
    expect(() =>
      openStarcraft2SubjectFactsSource(data, {
        snapshotId: 'provider-token:wrong-snapshot',
        subject: { namespace: 'Unit', entityId: 'Marine' },
        maxPageSize: 2,
        maxCalculations: 4,
      }),
    ).toThrow('another data snapshot')
    expect(() =>
      openStarcraft2SubjectFactsSource(data, {
        snapshotId: data.snapshotId,
        subject: { namespace: 'Unit', entityId: 'Marine' },
        maxPageSize: 2,
        maxEntities: 3,
        maxCalculations: 4,
      }),
    ).toThrow('at most maxEntities 3')
    expect(() =>
      openStarcraft2SubjectFactsSource(data, {
        snapshotId: data.snapshotId,
        subject: { namespace: 'Unit', entityId: 'Marine' },
        maxPageSize: 2,
        maxRelations: 2,
        maxCalculations: 4,
      }),
    ).toThrow('at most maxRelations 2')

    const lease = openFacts(data)
    const controller = new AbortController()
    controller.abort(new Error('facts cancelled'))
    expect(() =>
      openStarcraft2DataSource(data, 'relations', 2, { signal: controller.signal }),
    ).toThrow('facts cancelled')
    await expect(lease.value.summary(controller.signal)).rejects.toThrow('facts cancelled')
    await expect(lease.value.facts('overview', { limit: 1 }, controller.signal)).rejects.toThrow(
      'facts cancelled',
    )
    await lease.release()
  })
})
