/**
 * `sc2-data`'s `edit.content` (entity-rename) surface and the pure catalog transform behind it —
 * the catalog/entity half of `@modkitx/ops`'s `renameEntities`, consolidated here in Phase D
 * item 3.
 *
 * Coverage mirrors `packages/mods-processing/test/locale-edit.test.ts`: pure-transform behavior,
 * plan/transaction round trip, diagnostics on invalid input, idempotency, and dispatch through
 * the stable handler ID.
 */

import { describe, expect, it } from 'vitest'
import { isKnownAssetOperationId, sortSourceEdits, validateEditPlan } from '@modkit/codec-kit/legacy/assets'
import { TypedCatalog } from '../../shared/catalog-engine/sc2-catalog'
import { createBuiltinRegistry } from '../../shared/catalog-engine/sc2-schema'
import { parseCatalogXml } from '../../shared/catalog-engine/xml/index.js'
import { createSc2DataCodec } from '../../shared/format/codec.js'
import { sc2DataHandlerId } from '../../shared/format/describe.js'
import { SC2_DATA_ENTITY_RENAME_CHAIN_INCOMPLETE_DIAGNOSTIC_ID, SC2_DATA_ENTITY_RENAME_ID_COLLISION_DIAGNOSTIC_ID, SC2_DATA_ENTITY_RENAME_MULTI_FILE_DIAGNOSTIC_ID, SC2_DATA_ENTITY_RENAME_NO_OP_DIAGNOSTIC_ID, SC2_DATA_ENTITY_RENAME_RESERIALIZED_DIAGNOSTIC_ID, SC2_DATA_ENTITY_RENAME_UNKNOWN_ENTITY_DIAGNOSTIC_ID, createSc2DataEntityRenameEditPlan, createSc2DataEntityRenameEditTransaction, parseSc2DataEntityRenameInput } from '../../shared/format/edit.js'
import { renameCatalogEntities, renameRefsInStringValue, type CatalogRenameStore } from '../../shared/format/entity-rename.js'
import { DATA_OPERATION_IDS } from '../../shared/catalog-engine/operations'
import { CHAINED_LEAF_XML, fixtureSource } from './fixtures.js'

const codec = createSc2DataCodec()

/**
 * A rename-shaped fixture: a weapon referenced by a plain link, by `parent=`, by an actor's
 * dotted `Terms` event, and by a `Ns,Entity,Field` catalog reference — the four composite forms
 * the schema walk has to recognize. Locale strings exercise key re-keying and value-embedded
 * `<d ref>` rewriting.
 */
const RENAME_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CWeaponLegacy id="GaussGun">
    <DisplayEffect Link="ZapDamage"/>
    <Name value="Weapon/Name/GaussGun"/>
  </CWeaponLegacy>
  <CWeaponLegacy id="GaussGunElite" parent="GaussGun"/>
  <CUnit id="Marine">
    <WeaponArray Link="GaussGun"/>
  </CUnit>
  <CEffectDamage id="ZapDamage"/>
  <CActorUnit id="MarineBody" unitName="Marine">
    <On Terms="WeaponStart.GaussGun.AttackStart" Send="Create MarineGlow"/>
  </CActorUnit>
  <CActorModel id="MarineGlow"/>
  <CUpgrade id="ZapBoost">
    <EffectArray Reference="Weapon,GaussGun,DamagePoint" Value="2"/>
  </CUpgrade>
</Catalog>
`

/** A second file declaring an entity the first file already declares (the merge case). */
const OVERRIDE_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="Marine">
    <LifeMax value="55"/>
  </CUnit>
</Catalog>
`

type Locales = Map<string, Map<string, Map<string, string>>>

function makeStore(): CatalogRenameStore & { locales: Locales } {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  catalog.loadFromFiles([parseCatalogXml(RENAME_XML)])
  const locales: Locales = new Map([
    [
      'enus',
      new Map([
        [
          'GameStrings',
          new Map([
            ['Weapon/Name/GaussGun', 'Gauss Gun'],
            ['Unit/Name/Marine', 'Marine'],
            ['Unit/Tooltip/Marine', 'DPS <d ref="(Weapon,GaussGun,DamagePoint-1)*2"/> per shot'],
            // Last segment is NOT an entity id, so only the resolveText mask can re-key it.
            ['Unit/Tooltip/MarineExtra', 'Extra'],
          ]),
        ],
      ]),
    ],
  ])
  // A plain object, to prove `CatalogRenameStore` really is structural: `SC2Mod` satisfies it in
  // `@modkitx/ops` without this package depending on `@modkitx/ops` in either direction.
  return {
    namespaces: () => catalog.namespaces(),
    all: (namespace: string) => catalog.all(namespace),
    get: (namespace: string, id: string) => catalog.get(namespace, id),
    renameEntry: (namespace: string, oldId: string, newId: string) =>
      catalog.renameEntry(namespace, oldId, newId),
    locales,
  }
}

const openRenameDoc = () =>
  codec.openCatalogFiles([
    fixtureSource(RENAME_XML, { path: 'Mods/Test.SC2Mod/GameData/TestData.xml' }),
  ])

describe('renameCatalogEntities (pure transform)', () => {
  it('patches every catalog reference form and re-keys the entity', () => {
    const store = makeStore()
    const result = renameCatalogEntities(store, [
      { namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' },
    ])

    expect(result.entitiesRenamed).toBe(1)
    expect(store.get('Weapon', 'GaussGun')).toBeUndefined()
    expect(store.get('Weapon', 'CUSTOM_GaussGun')).toBeDefined()

    // plain link
    expect(JSON.stringify(store.get('Unit', 'Marine')!.data)).toContain('CUSTOM_GaussGun')
    // parent= chain
    expect(store.get('Weapon', 'GaussGunElite')!.parent).toBe('CUSTOM_GaussGun')
    // dotted actor Terms event
    expect(JSON.stringify(store.get('Actor', 'MarineBody')!.data)).toContain(
      'WeaponStart.CUSTOM_GaussGun.AttackStart',
    )
    // "Ns,Entity,Field" catalog reference
    expect(JSON.stringify(store.get('Upgrade', 'ZapBoost')!.data)).toContain(
      'Weapon,CUSTOM_GaussGun,DamagePoint',
    )
    expect(result.referencesPatched).toBeGreaterThan(0)
    // the handles other domains (triggers/layouts/map) still need from @modkitx/ops
    expect(result.mapped('weapon', 'GaussGun')).toBe('CUSTOM_GaussGun')
    expect(result.canon('weapon')).toBe('Weapon')
  })

  it('re-keys locale string keys (old key kept) and the entity field holding them', () => {
    const store = makeStore()
    const result = renameCatalogEntities(store, [
      { namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' },
    ])

    expect(result.stringsRenamed).toBeGreaterThan(0)
    const strings = store.locales.get('enus')!.get('GameStrings')!
    expect(strings.get('Weapon/Name/CUSTOM_GaussGun')).toBe('Gauss Gun')
    // old-parser behavior: the old key is retained
    expect(strings.get('Weapon/Name/GaussGun')).toBe('Gauss Gun')
    expect(result.textKeyRenames.get('Weapon/Name/GaussGun')).toBe('Weapon/Name/CUSTOM_GaussGun')
    expect(JSON.stringify(store.get('Weapon', 'CUSTOM_GaussGun')!.data)).toContain(
      'Weapon/Name/CUSTOM_GaussGun',
    )
    // an unrelated namespace's key with the same shape is untouched
    expect(strings.has('Unit/Name/CUSTOM_Marine')).toBe(false)
  })

  it('rewrites entity ids embedded in localized string VALUES, preserving surrounding markup', () => {
    const store = makeStore()
    renameCatalogEntities(store, [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' }])
    expect(store.locales.get('enus')!.get('GameStrings')!.get('Unit/Tooltip/Marine')).toBe(
      'DPS <d ref="(Weapon,CUSTOM_GaussGun,DamagePoint-1)*2"/> per shot',
    )
  })

  it('renameRefsInStringValue preserves the @array suffix and leaves unmapped refs alone', () => {
    const map = new Map([['weapon/GaussGun', 'CUSTOM_GaussGun']])
    expect(renameRefsInStringValue('Weapon,GaussGun@Upgrade,Damage', map)).toBe(
      'Weapon,CUSTOM_GaussGun@Upgrade,Damage',
    )
    expect(renameRefsInStringValue('Weapon,Other,Damage', map)).toBe('Weapon,Other,Damage')
  })

  it('applies a mask to referenced string keys only when textReferences are supplied', () => {
    const withoutRefs = makeStore()
    renameCatalogEntities(withoutRefs, [{ namespace: 'Unit', oldId: 'Marine', newId: 'X_*' }])
    const plain = withoutRefs.locales.get('enus')!.get('GameStrings')!
    // Direct match (last segment IS the renamed id) always re-keys...
    expect(plain.has('Unit/Name/X_Marine')).toBe(true)
    // ...but a key merely referenced by the entity does not.
    expect(plain.has('Unit/Tooltip/X_MarineExtra')).toBe(false)

    const withRefs = makeStore()
    renameCatalogEntities(withRefs, [{ namespace: 'Unit', oldId: 'Marine', newId: 'X_*' }], {
      textReferences: [
        { from: { namespace: 'Unit', id: 'Marine' }, key: 'Unit/Tooltip/MarineExtra' },
      ],
    })
    expect(
      withRefs.locales.get('enus')!.get('GameStrings')!.has('Unit/Tooltip/X_MarineExtra'),
    ).toBe(true)
  })
})

describe('sc2-data edit.content (entity rename)', () => {
  it('is declared with a stable shared operation ID and handler ID', () => {
    expect(DATA_OPERATION_IDS.edit).toBe('edit.content')
    expect(isKnownAssetOperationId(DATA_OPERATION_IDS.edit)).toBe(true)
    expect(sc2DataHandlerId(DATA_OPERATION_IDS.edit)).toBe('sc2-data.edit.content')
  })

  it('rejects malformed input', () => {
    expect(() => parseSc2DataEntityRenameInput(undefined)).toThrow()
    expect(() => parseSc2DataEntityRenameInput({})).toThrow()
    expect(() => parseSc2DataEntityRenameInput({ renames: [] })).toThrow()
    expect(() => parseSc2DataEntityRenameInput({ renames: [{ namespace: 'Weapon' }] })).toThrow()
    expect(() =>
      parseSc2DataEntityRenameInput({
        renames: [{ namespace: 'Weapon', oldId: 'A', newId: '' }],
      }),
    ).toThrow()
    expect(() =>
      parseSc2DataEntityRenameInput({
        renames: [{ namespace: 'Weapon', oldId: 'A', newId: 'B' }],
        textReferences: [{ key: 'x' }],
      }),
    ).toThrow()
    expect(
      parseSc2DataEntityRenameInput({
        renames: [{ namespace: 'Weapon', oldId: 'A', newId: 'B' }],
      }),
    ).toEqual({ renames: [{ namespace: 'Weapon', oldId: 'A', newId: 'B' }] })
  })

  it('produces a structurally valid replace edit per changed GameData file, without mutating the open document', async () => {
    const document = await openRenameDoc()
    const plan = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' }],
    })

    expect(plan.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    expect(plan.preservesUnknownData).toBe(false)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]?.operation).toBe('replace')
    expect(plan.edits[0]?.text).toContain('CUSTOM_GaussGun')
    expect(plan.summary.entitiesRenamed).toBe(1)
    expect(validateEditPlan(plan)).toEqual([])
    expect(sortSourceEdits(plan.edits)).toHaveLength(1)

    // The plan is computed over clones: the opened catalog is untouched.
    expect(document.catalog.get('Weapon', 'GaussGun')).toBeDefined()
    expect(document.catalog.get('Weapon', 'CUSTOM_GaussGun')).toBeUndefined()

    // The re-serialized file is a lossy rebuild, and says so.
    expect(plan.diagnostics.map(d => d.id)).toContain(
      SC2_DATA_ENTITY_RENAME_RESERIALIZED_DIAGNOSTIC_ID,
    )
  })

  it('reports a diagnostic instead of throwing when a rename target does not exist', async () => {
    const document = await openRenameDoc()
    const plan = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Weapon', oldId: 'NoSuchWeapon', newId: 'X_*' }],
    })
    expect(plan.edits).toEqual([])
    expect(plan.diagnostics.map(d => d.id)).toContain(
      SC2_DATA_ENTITY_RENAME_UNKNOWN_ENTITY_DIAGNOSTIC_ID,
    )
    expect(
      plan.diagnostics.find(d => d.id === SC2_DATA_ENTITY_RENAME_UNKNOWN_ENTITY_DIAGNOSTIC_ID)
        ?.severity,
    ).toBe('error')
  })

  it('reports a collision when the new id is already taken', async () => {
    const document = await openRenameDoc()
    const plan = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'GaussGunElite' }],
    })
    expect(plan.diagnostics.map(d => d.id)).toContain(
      SC2_DATA_ENTITY_RENAME_ID_COLLISION_DIAGNOSTIC_ID,
    )
  })

  it('refuses when one id is declared in more than one loaded file', async () => {
    const document = await codec.openCatalogFiles([
      fixtureSource(RENAME_XML, { path: 'Mods/Test.SC2Mod/GameData/TestData.xml' }),
      fixtureSource(OVERRIDE_XML, { path: 'Mods/Test.SC2Mod/GameData/OverrideData.xml' }),
    ])
    const plan = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' }],
    })
    const multi = plan.diagnostics.find(
      d => d.id === SC2_DATA_ENTITY_RENAME_MULTI_FILE_DIAGNOSTIC_ID,
    )
    expect(multi?.severity).toBe('error')
    expect(multi?.detail).toMatchObject({ entities: ['Unit/Marine'] })

    const transaction = createSc2DataEntityRenameEditTransaction(document, {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' }],
    })
    await expect(transaction.validate()).rejects.toThrow()
  })

  it('warns that an incomplete inheritance chain under-patches token-typed references', async () => {
    const document = await codec.open(fixtureSource(CHAINED_LEAF_XML), {})
    const plan = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Unit', oldId: 'Marauder', newId: 'CUSTOM_*' }],
    })
    const chain = plan.diagnostics.find(
      d => d.id === SC2_DATA_ENTITY_RENAME_CHAIN_INCOMPLETE_DIAGNOSTIC_ID,
    )
    expect(chain?.severity).toBe('warning')
    // A warning does not block: the plan still applies.
    expect(plan.edits.length).toBeGreaterThan(0)
  })

  it('is idempotent: re-planning against an already-named entity is a diagnosed no-op', async () => {
    const document = await openRenameDoc()
    const plan = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'GaussGun' }],
    })
    expect(plan.edits).toEqual([])
    expect(plan.diagnostics.map(d => d.id)).toContain(SC2_DATA_ENTITY_RENAME_NO_OP_DIAGNOSTIC_ID)

    // And the same input twice yields byte-identical edits, because nothing was mutated.
    const first = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' }],
    })
    const second = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' }],
    })
    expect(second.edits.map(e => e.text)).toEqual(first.edits.map(e => e.text))
  })

  it('validate()/apply() round-trip through the transaction and expose the finished AssetOutputs', async () => {
    const document = await openRenameDoc()
    const transaction = createSc2DataEntityRenameEditTransaction(document, {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' }],
    })
    expect(transaction.plans).toHaveLength(1)
    expect(() => transaction.outputs()).toThrow()

    await transaction.validate()
    await transaction.apply()

    const outputs = transaction.outputs()
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.path).toBe('Mods/Test.SC2Mod/GameData/TestData.xml')
    expect(outputs[0]?.mediaType).toBe('application/xml')
    const xml = new TextDecoder().decode(outputs[0]!.data)
    expect(xml).toContain('<CWeaponLegacy id="CUSTOM_GaussGun">')
    expect(xml).toContain('parent="CUSTOM_GaussGun"')
    // The re-serialized document parses back through the real catalog parser.
    expect(parseCatalogXml(xml).rootTypes.length).toBeGreaterThan(0)
  })

  it('is exposed on the codec as createEntityRenameEditTransaction', async () => {
    const document = await openRenameDoc()
    const transaction = codec.createEntityRenameEditTransaction(document, {
      renames: [{ namespace: 'Effect', oldId: 'ZapDamage', newId: '*_S' }],
    })
    await transaction.validate()
    await transaction.apply()
    expect(new TextDecoder().decode(transaction.outputs()[0]!.data)).toContain('ZapDamage_S')
  })

  it('is invoked through the operation session using the stable handler-ID convention', async () => {
    const document = await openRenameDoc()
    const descriptor = await codec.describe(document, {})
    const session = codec.createSession(document, {}, descriptor, {
      grantedPermissions: ['read-source', 'write-workspace'],
    })
    const plan = (await session.invoke(sc2DataHandlerId(DATA_OPERATION_IDS.edit), {
      renames: [{ namespace: 'Weapon', oldId: 'GaussGun', newId: 'CUSTOM_*' }],
    })) as { edits: unknown[] }
    expect(plan.edits).toHaveLength(1)
    await session.dispose()
  })

  it('degrades edit.content to dependency-required when the chain is incomplete', async () => {
    const complete = await openRenameDoc()
    const completeOp = (await codec.describe(complete, {})).operations.find(
      op => op.id === DATA_OPERATION_IDS.edit,
    )
    expect(completeOp?.state).toBe('available')

    const partial = await codec.open(fixtureSource(CHAINED_LEAF_XML), {})
    const partialOp = (await codec.describe(partial, {})).operations.find(
      op => op.id === DATA_OPERATION_IDS.edit,
    )
    expect(partialOp?.state).toBe('dependency-required')
    expect(partialOp?.reason?.message).toContain('inheritance chain')
  })
})
