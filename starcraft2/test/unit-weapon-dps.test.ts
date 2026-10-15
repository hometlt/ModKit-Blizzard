import { describe, expect, it } from 'vitest'
import { calculateStarcraft2UnitWeaponDps } from '../modules/data/services/calculations/index.js'

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

function snapshot(definitions: readonly object[], complete = true) {
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: 'workspace:test',
    gameId: 'blizzard/starcraft-2',
    analyzerId: 'blizzard.starcraft2.data',
    typeIds: Object.freeze(['CUnit', 'CWeapon', 'CEffectDamage', 'CEffectSet']),
    namespaces: Object.freeze([]),
    entityCount: definitions.length,
    patchCount: definitions.length,
    definitions: Object.freeze(definitions),
    entities: Object.freeze(definitions),
    diagnostics: Object.freeze([]),
    snapshotId: 'provider-token:synthetic-sc2-data',
    complete,
  })
}

describe('StarCraft II Unit weapon DPS calculation', () => {
  it('computes and documents the direct Damage Effect case from a pinned snapshot', () => {
    const data = snapshot([
      entity('Unit', 'CUnit', 'Marine', {
        WeaponArray: Object.freeze([
          Object.freeze({ index: '0', value: Object.freeze({ Link: 'GaussRifle' }) }),
        ]),
      }),
      entity('Weapon', 'CWeapon', 'GaussRifle', {
        Period: '0.75',
        DisplayAttackCount: Object.freeze({ value: '2' }),
        Effect: 'GaussDamage',
      }),
      entity('Effect', 'CEffectDamage', 'GaussDamage', {
        Amount: Object.freeze({ value: '6' }),
      }),
    ])

    const result = calculateStarcraft2UnitWeaponDps(data, { unitId: 'Marine' })

    expect(result.formula).toMatchObject({
      id: 'blizzard.starcraft2/simple-weapon-dps',
      name: 'StarCraft II simple displayed weapon DPS',
      version: '1.0.0',
      expression: 'damage * attacks / period',
    })
    expect(result.snapshotId).toBe(data.snapshotId)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      status: 'computed',
      rawValue: 16,
      value: 16,
      unit: 'damage-per-game-second',
      inputs: {
        damage: { state: 'resolved', value: 6, fieldPath: 'Amount' },
        attacks: { state: 'resolved', value: 2, fieldPath: 'DisplayAttackCount' },
        period: { state: 'resolved', value: 0.75, fieldPath: 'Period' },
      },
      completeness: { state: 'complete' },
    })
    expect(result.results[0].provenance.entities).toHaveLength(3)
    expect(result.results[0].provenance.entities[2].sources[0]).toEqual(source)
    expect(result.provenance.algorithm).toMatchObject({
      kind: 'adapted',
      repository: 'modkit',
      revision: '1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
    })
    expect(result.warnings).toEqual([])
    expect(result.completeness).toMatchObject({
      state: 'complete',
      computedWeapons: 1,
      unsupportedWeapons: 0,
      incompleteWeapons: 0,
      truncated: false,
    })
  })

  it('returns explicit missing-data evidence instead of inventing a value', () => {
    const data = snapshot([
      entity('Unit', 'CUnit', 'BrokenUnit', {
        WeaponArray: Object.freeze([{ index: '0', value: { Link: 'BrokenWeapon' } }]),
      }),
      entity('Weapon', 'CWeapon', 'BrokenWeapon', { Effect: 'MissingDamage' }),
    ])

    const result = calculateStarcraft2UnitWeaponDps(data, { unitId: 'BrokenUnit' })

    expect(result.results[0]).toMatchObject({
      status: 'missing-data',
      inputs: {
        damage: { state: 'missing', value: null },
        attacks: { state: 'resolved', value: 1, origin: 'implicit-sc2-default' },
        period: { state: 'missing', value: null },
      },
      completeness: {
        state: 'incomplete',
        missingFields: ['Effect', 'Effect.Amount', 'Weapon.Period'],
      },
    })
    expect(result.results[0]).not.toHaveProperty('value')
    expect(result.warnings.map(item => item.code)).toEqual(
      expect.arrayContaining([
        'blizzard.starcraft2/calculation-effect-missing',
        'blizzard.starcraft2/calculation-period-missing',
      ]),
    )
    expect(result.completeness.state).toBe('incomplete')
  })

  it('marks an indirect EffectSet chain unsupported without following it', () => {
    const data = snapshot([
      entity('Unit', 'CUnit', 'SiegeTank', {
        WeaponArray: Object.freeze([{ value: { Link: 'SiegeCannon' } }]),
      }),
      entity('Weapon', 'CWeapon', 'SiegeCannon', {
        Period: 2,
        DisplayEffect: 'SiegeSet',
      }),
      entity('Effect', 'CEffectSet', 'SiegeSet', {
        EffectArray: Object.freeze(['SiegeDamage']),
      }),
      entity('Effect', 'CEffectDamage', 'SiegeDamage', { Amount: 40 }),
    ])

    const result = calculateStarcraft2UnitWeaponDps(data, { unitId: 'SiegeTank' })

    expect(result.results[0]).toMatchObject({
      status: 'unsupported',
      completeness: {
        state: 'unsupported',
        unsupportedReasons: ['Effect type CEffectSet'],
      },
    })
    expect(result.results[0]).not.toHaveProperty('value')
    expect(result.results[0].warnings.map(item => item.code)).toContain(
      'blizzard.starcraft2/calculation-effect-chain-unsupported',
    )
    expect(result.completeness.state).toBe('unsupported')
  })

  it('enforces entity and weapon bounds and observes cancellation', () => {
    const data = snapshot([
      entity('Unit', 'CUnit', 'DualUnit', {
        WeaponArray: Object.freeze([{ value: 'WeaponA' }, { value: 'WeaponB' }]),
      }),
      entity('Weapon', 'CWeapon', 'WeaponA', { Period: 1, Effect: 'DamageA' }),
      entity('Weapon', 'CWeapon', 'WeaponB', { Period: 1, Effect: 'DamageB' }),
      entity('Effect', 'CEffectDamage', 'DamageA', { Amount: 5 }),
      entity('Effect', 'CEffectDamage', 'DamageB', { Amount: 7 }),
    ])

    const bounded = calculateStarcraft2UnitWeaponDps(data, {
      unitId: 'DualUnit',
      maxWeapons: 1,
    })
    expect(bounded.results).toHaveLength(1)
    expect(bounded.completeness).toMatchObject({ state: 'partial', truncated: true })
    expect(bounded.warnings.map(item => item.code)).toContain(
      'blizzard.starcraft2/calculation-weapon-limit-reached',
    )
    expect(() =>
      calculateStarcraft2UnitWeaponDps(data, { unitId: 'DualUnit', maxEntities: 4 }),
    ).toThrow('snapshot entity count 5 exceeds request.maxEntities 4')

    const controller = new AbortController()
    controller.abort(new Error('calculation cancelled'))
    expect(() =>
      calculateStarcraft2UnitWeaponDps(data, {
        unitId: 'DualUnit',
        signal: controller.signal,
      }),
    ).toThrow('calculation cancelled')
  })
})
