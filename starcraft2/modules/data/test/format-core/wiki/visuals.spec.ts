import { describe, it, expect } from 'vitest'
import { TypedCatalog } from '../../../shared/catalog-engine/sc2-catalog'
import { createBuiltinRegistry } from '../../../shared/catalog-engine/sc2-schema'
import { parseCatalogXml } from '../../../shared/catalog-engine/xml/index.js'
import { SC2Mod } from '../../../../mod/shared/core/index.js'
import {
  buildUnitVisualIndex,
  placeholderColorFor,
  resolveDoodadVisuals,
  resolveUnitVisuals,
} from '../../../shared/format/wiki/visuals.js'

function makeMod(xml: string): SC2Mod {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  catalog.loadFromFiles([parseCatalogXml(xml)])
  return new SC2Mod(catalog, [], new Map())
}

// Mirrors shipped data (core.sc2mod GenericUnitMinimal): creation events and
// the Model link live TOKENIZED on a base template; concrete actors only set
// the `unitName` token. The Marine death-model actor is declared BEFORE the
// standing actor on purpose — declaration order must lose to event ranking.
const XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="Marine">
    <Radius value="0.375"/>
  </CUnit>
  <CUnit id="Zergling">
    <Radius value="0.25"/>
  </CUnit>
  <CUnit id="Ghost">
    <Radius value="0.4"/>
  </CUnit>
  <CModel id="Marine">
    <Model value="Assets\\Units\\Marine.m3"/>
  </CModel>
  <CModel id="Zergling">
    <Model value="Assets\\Units\\Zergling.m3"/>
  </CModel>
  <CModel id="MarineDeathModel">
    <Model value="Assets\\Units\\MarineDeath.m3"/>
  </CModel>
  <CActorUnit default="1" id="UnitTemplate">
    <?token id="unitName" type="CUnitLink" value="Bogus"?>
    <Model value="##unitName##"/>
    <On Terms="UnitBirth.##unitName##" Send="Create"/>
    <On Terms="UnitRevive.##unitName##" Send="Create"/>
    <On Terms="UnitConstruction.##unitName##.Start" Send="Create"/>
    <On Terms="UnitDeath.##unitName##" Send="Destroy"/>
  </CActorUnit>
  <CActorModel id="MarineDeathActor">
    <Model value="MarineDeathModel"/>
    <On Terms="UnitDeath.Marine" Send="Create"/>
  </CActorModel>
  <CActorUnit id="MarineActor" parent="UnitTemplate" unitName="Marine">
    <Scale value="1.25"/>
  </CActorUnit>
  <CActorUnit id="ZerglingActor" parent="UnitTemplate" unitName="Zergling"/>
</Catalog>`

describe('resolveUnitVisuals', () => {
  const mod = makeMod(XML)

  it('resolves through inherited tokenized On events and Model links', () => {
    const result = resolveUnitVisuals(mod, ['Zergling']).get('Zergling')!
    expect(result.unitId).toBe('Zergling')
    expect(result.modelPath).toBe('Assets\\Units\\Zergling.m3')
    expect(result.actorId).toBe('ZerglingActor')
    expect(result.diagnostics).toEqual([])
  })

  it('ranks the birth-event actor above an earlier-declared death actor', () => {
    const result = resolveUnitVisuals(mod, ['Marine']).get('Marine')!
    expect(result.modelPath).toBe('Assets\\Units\\Marine.m3')
    expect(result.actorId).toBe('MarineActor')
    expect(result.diagnostics).toEqual([])
  })

  it('surfaces the death-only actor model separately', () => {
    const result = resolveUnitVisuals(mod, ['Marine']).get('Marine')!
    expect(result.deathModelPath).toBe('Assets\\Units\\MarineDeath.m3')
  })

  it('reads scale from the actor and radius from the unit', () => {
    const result = resolveUnitVisuals(mod, ['Marine']).get('Marine')!
    expect(result.scale).toBeCloseTo(1.25)
    expect(result.radius).toBeCloseTo(0.375)
  })

  it('corrects type-name case against the catalog', () => {
    const result = resolveUnitVisuals(mod, ['marine']).get('marine')!
    expect(result.unitId).toBe('Marine')
    expect(result.modelPath).toBe('Assets\\Units\\Marine.m3')
  })

  it('degrades unknown types to a placeholder resolution, never an error', () => {
    const result = resolveUnitVisuals(mod, ['DoesNotExist']).get('DoesNotExist')!
    expect(result.unitId).toBeUndefined()
    expect(result.modelPath).toBeUndefined()
    expect(result.diagnostics).toEqual(['unit-not-found: DoesNotExist'])
    expect(result.radius).toBe(0.5)
    expect(result.scale).toBe(1)
    expect(result.placeholderColor).toHaveLength(3)
  })

  it('diagnoses units without a model-carrying actor', () => {
    const result = resolveUnitVisuals(mod, ['Ghost']).get('Ghost')!
    expect(result.modelPath).toBeUndefined()
    expect(result.diagnostics).toEqual(['no-actor-model: Ghost'])
    expect(result.radius).toBeCloseTo(0.4)
  })

  it('reuses a prebuilt index across calls', () => {
    const index = buildUnitVisualIndex(mod)
    const result = resolveUnitVisuals(mod, ['Marine'], { index }).get('Marine')!
    expect(result.modelPath).toBe('Assets\\Units\\Marine.m3')
  })

  it('rewrites a catalog stem to an existing unit variation asset', () => {
    const result = resolveUnitVisuals(mod, ['Marine'], {
      hasAsset: basename => basename === 'marine_00.m3',
    }).get('Marine')!
    expect(result.modelPath).toBe('Assets/Units/Marine_00.m3')
    expect(result.diagnostics).toEqual([])
  })

  it('returns one entry per requested type', () => {
    const results = resolveUnitVisuals(mod, ['Marine', 'Ghost', 'Nope', 'Marine'])
    expect([...results.keys()].sort()).toEqual(['Ghost', 'Marine', 'Nope'])
  })
})

// Mirrors shipped doodad data: `CActorDoodad` entries declare NO Model link
// (the game defaults it to the like-named CModel), and the class default
// chain injects a bogus Model on every modelless actor — the resolver must
// prefer the same-id convention over resolved defaults.
const DOODAD_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CActorModel default="1" id="ClassDefault">
    <Model value="ActorLightSpot"/>
  </CActorModel>
  <CModel id="ActorLightSpot">
    <Model value="Assets\\Doodads\\ActorLightSpot\\ActorLightSpot.m3"/>
  </CModel>
  <CActorDoodad id="AiurTree"/>
  <CModel id="AiurTree">
    <Model value="Assets\\Doodads\\AiurTree\\AiurTree.m3"/>
  </CModel>
  <CActorDoodad id="FancyRock">
    <Model value="RockModel"/>
    <Scale value="1.5"/>
  </CActorDoodad>
  <CModel id="RockModel">
    <Model value="Assets\\Doodads\\Rock\\Rock.m3"/>
  </CModel>
  <CActorDoodad id="TemplatedBush" parent="BushTemplate"/>
  <CActorDoodad id="BushTemplate">
    <Model value="BushModel"/>
  </CActorDoodad>
  <CModel id="BushModel">
    <Model value="Assets\\Doodads\\Bush\\Bush.m3"/>
  </CModel>
  <CActorDoodad id="ModellessProp"/>
</Catalog>`

describe('resolveDoodadVisuals', () => {
  const mod = makeMod(DOODAD_XML)

  it('resolves undeclared model links through the same-id CModel convention', () => {
    const result = resolveDoodadVisuals(mod, ['AiurTree']).get('AiurTree')!
    expect(result.actorId).toBe('AiurTree')
    expect(result.modelPath).toBe('Assets\\Doodads\\AiurTree\\AiurTree.m3')
    expect(result.diagnostics).toEqual([])
  })

  it('prefers a declared Model link and reads the declared scale', () => {
    const result = resolveDoodadVisuals(mod, ['FancyRock']).get('FancyRock')!
    expect(result.modelPath).toBe('Assets\\Doodads\\Rock\\Rock.m3')
    expect(result.scale).toBeCloseTo(1.5)
  })

  it('finds declared links on explicit template parents', () => {
    const result = resolveDoodadVisuals(mod, ['TemplatedBush']).get('TemplatedBush')!
    expect(result.modelPath).toBe('Assets\\Doodads\\Bush\\Bush.m3')
  })

  it('never falls back to the implicit class-default model', () => {
    const result = resolveDoodadVisuals(mod, ['ModellessProp']).get('ModellessProp')!
    expect(result.modelPath).toBeUndefined()
    expect(result.diagnostics).toEqual(['doodad-model-not-found: ModellessProp'])
  })

  it('degrades unknown types to diagnostics, never an error', () => {
    const result = resolveDoodadVisuals(mod, ['Nope']).get('Nope')!
    expect(result.actorId).toBeUndefined()
    expect(result.modelPath).toBeUndefined()
    expect(result.diagnostics).toEqual([
      'doodad-actor-not-found: Nope',
      'doodad-model-not-found: Nope',
    ])
    expect(result.scale).toBe(1)
  })

  it('rewrites a bare stem to the _00 variation file when only that exists', () => {
    const hasAsset = (basename: string): boolean => basename === 'aiurtree_00.m3'
    const result = resolveDoodadVisuals(mod, ['AiurTree'], { hasAsset }).get('AiurTree')!
    // Variation rewrite normalizes to forward slashes (consumers lowercase-
    // normalize to `/` anyway when forming the model key).
    expect(result.modelPath).toBe('Assets/Doodads/AiurTree/AiurTree_00.m3')
    expect(result.diagnostics).toEqual([])
  })

  it('keeps the bare model file when it exists on disk', () => {
    const hasAsset = (basename: string): boolean => basename === 'aiurtree.m3'
    const result = resolveDoodadVisuals(mod, ['AiurTree'], { hasAsset }).get('AiurTree')!
    expect(result.modelPath).toBe('Assets\\Doodads\\AiurTree\\AiurTree.m3')
  })

  it('reports the asset missing when neither bare nor variation files exist', () => {
    const result = resolveDoodadVisuals(mod, ['AiurTree'], { hasAsset: () => false }).get(
      'AiurTree',
    )!
    expect(result.modelPath).toBeUndefined()
    expect(result.diagnostics).toEqual([
      'doodad-asset-missing: Assets\\Doodads\\AiurTree\\AiurTree.m3',
    ])
  })
})

describe('placeholderColorFor', () => {
  it('is deterministic and produces distinct in-range colors', () => {
    const a = placeholderColorFor('Marine')
    const b = placeholderColorFor('Zergling')
    expect(placeholderColorFor('Marine')).toEqual(a)
    expect(a).not.toEqual(b)
    for (const channel of [...a, ...b]) {
      expect(channel).toBeGreaterThanOrEqual(0)
      expect(channel).toBeLessThanOrEqual(1)
    }
  })
})
