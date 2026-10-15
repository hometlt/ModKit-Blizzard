import { describe, it, expect } from 'vitest'
import { TypedCatalog } from '../../shared/catalog-engine/sc2-catalog'
import { createBuiltinRegistry } from '../../shared/catalog-engine/sc2-schema'
import { parseCatalogXml } from '../../shared/catalog-engine/xml/index.js'
import { SC2Mod } from '../../../mod/shared/core/index.js'
import { flatten } from '../../shared/format/flatten.js'

// GenericAttackBase declares the `effectImpact` token via a <?token?> PI and uses
// it as ##effectImpact## / $effectImpact. The child supplies the value. A second
// lowercase field (`unitName`) is NOT declared as a token — it must be preserved
// (this is the bug old-parser parity exposed: undeclared lowercase actor fields
// are real data, not tokens).
const MINI = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CActorUnit id="GenericAttackBase" default="1">
    <?token id="effectImpact" type="CEffectLink"?>
    <On Terms="Effect.##effectImpact##.Start" Send="Create $effectImpact"/>
  </CActorUnit>
  <CActorUnit id="MarauderAttack" parent="GenericAttackBase" unitName="Marauder">
    <effectImpact value="PunisherU"/>
    <Missile value="MarauderMissile"/>
  </CActorUnit>
  <CActorUnit id="SelfRef" parent="SelfRef">
    <unitName value="Marine"/>
  </CActorUnit>
  <CSound id="MarauderSound">
    <unitSound value="Marauder"/>
    <AssetArray value="Sound/Marauder/Attack"/>
  </CSound>
</Catalog>`

function makeMod(): SC2Mod {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  catalog.loadFromFiles([parseCatalogXml(MINI)])
  return new SC2Mod(catalog, [])
}

describe('flatten — port of fixActorSoundsLimitIssue', () => {
  it('expands declared tokens, removes them and the parent — keeps undeclared fields', () => {
    const mod = makeMod()
    const res = flatten(mod)

    const child = mod.get('Actor', 'MarauderAttack')!
    expect(child.parent).toBeUndefined() // parent dropped
    // The complete schema normalizes On as a list even when XML has one element.
    const events = child.data['On'] as Array<Record<string, string>>
    expect(events).toHaveLength(1)
    const on = events[0]!
    expect(on['Terms']).toBe('Effect.PunisherU.Start') // ##effectImpact## expanded
    expect(on['Send']).toBe('Create PunisherU') // $effectImpact expanded
    expect(child.data['effectImpact']).toBeUndefined() // declared token removed
    expect(child.data['unitName']).toBe('Marauder') // UNDECLARED lowercase field kept
    expect(child.data['Missile']).toBe('MarauderMissile') // ordinary field kept
    expect(res.parentsRemoved).toBeGreaterThanOrEqual(1)
    expect(res.tokensRemoved).toBeGreaterThanOrEqual(1)
  })

  it('flattens sounds: lowercase token props dropped, PascalCase fields kept', () => {
    const mod = makeMod()
    flatten(mod)
    const snd = mod.get('Sound', 'MarauderSound')!
    expect(snd.data['unitSound']).toBeUndefined()
    expect(snd.data['AssetArray']).toEqual(['Sound/Marauder/Attack'])
  })

  it('skips self-parented entities', () => {
    const mod = makeMod()
    flatten(mod)
    const self = mod.get('Actor', 'SelfRef')!
    expect(self.parent).toBe('SelfRef')
    expect(self.data['unitName']).toBe('Marine')
  })

  it('skips default="1" template entities', () => {
    const mod = makeMod()
    flatten(mod)
    const base = mod.get('Actor', 'GenericAttackBase')!
    // default template is left intact (still references the token)
    expect((base.data['On'] as Record<string, string>)['Terms']).toContain('##effectImpact##')
  })

  it('honors isCore predicate (keeps shared deps intact)', () => {
    const mod = makeMod()
    flatten(mod, { isCore: e => e.id === 'MarauderAttack' })
    const child = mod.get('Actor', 'MarauderAttack')!
    expect(child.parent).toBe('GenericAttackBase')
    expect(child.data['effectImpact']).toBe('PunisherU')
  })

  it('only touches the requested namespaces', () => {
    const mod = makeMod()
    const res = flatten(mod, { namespaces: ['Sound'] })
    expect(mod.get('Actor', 'MarauderAttack')!.parent).toBe('GenericAttackBase')
    expect(mod.get('Sound', 'MarauderSound')!.data['unitSound']).toBeUndefined()
    expect(res.entitiesFlattened).toBe(1)
  })
})
