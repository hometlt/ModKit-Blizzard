/**
 * Root-level structure defaults (`<SCost>` in AbilData.xml): each catalog's defaults are the lowest
 * layer of every matching structure in that catalog, `##id##` names the owning entity, and a
 * rewrite of the file keeps them.
 */
import { describe, expect, it } from 'vitest'
import { createSc2DataCodec } from '../../shared/format/codec.js'
import { catalogStructureDefaults } from '../../shared/format/document.js'
import { createSc2DataEntityRenameEditPlan } from '../../shared/format/edit.js'
import { fixtureSource } from './fixtures.js'

const ABIL_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <SCost>
        <Charge Link="Abil/##id##"/>
        <Cooldown Link="Abil/##id##"/>
    </SCost>
    <SAbilCmdButton>
        <Flags index="AllowMinimap" value="1"/>
    </SAbilCmdButton>
    <CAbilEffectInstant id="Blink">
        <Cost><Vital index="Energy" value="50"/><Cooldown TimeUse="10"/></Cost>
        <CmdButtonArray index="Execute" DefaultButtonFace="Blink"/>
    </CAbilEffectInstant>
    <CAbilEffectInstant id="BlinkElite" parent="Blink"/>
</Catalog>
`

const BEHAVIOR_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <SCost>
        <Charge Link="Behavior/##id##" Location="Behavior"/>
    </SCost>
    <CBehaviorBuff id="Stim"/>
</Catalog>
`

const openAbilAndBehavior = () =>
  createSc2DataCodec().openCatalogFiles([
    fixtureSource(ABIL_XML, { path: 'Mods/Test.SC2Mod/Base.SC2Data/GameData/AbilData.xml' }),
    fixtureSource(BEHAVIOR_XML, { path: 'Mods/Test.SC2Mod/Base.SC2Data/GameData/BehaviorData.xml' }),
  ])

describe('SC2 structure defaults', () => {
  it('reads root structure defaults without treating them as entities', async () => {
    expect(catalogStructureDefaults(ABIL_XML).map(item => item.structureType)).toEqual([
      'SCost',
      'SAbilCmdButton',
    ])
    const document = await openAbilAndBehavior()
    expect(document.catalog.namespaces()).not.toContain('Cost')
    expect(document.stats.entityCount).toBe(3)
  })

  it('lays defaults under declared and inherited values, substituting the owning id', async () => {
    const { catalog } = await openAbilAndBehavior()
    const blink = catalog.getResolved('Abil', 'Blink') as Record<string, any>
    const cost = [blink['Cost']].flat()[0]
    expect(cost.Charge).toEqual({ Link: 'Abil/Blink' })
    expect(cost.Cooldown).toMatchObject({ Link: 'Abil/Blink', TimeUse: '10' })
    expect(cost.Vital).toMatchObject({ index: 'Energy', value: '50' })
    const button = [blink['CmdButtonArray']].flat()[0]
    expect(button).toMatchObject({ index: 'Execute', DefaultButtonFace: 'Blink' })
    expect(button.Flags).toMatchObject({ index: 'AllowMinimap', value: '1' })

    const elite = catalog.getResolved('Abil', 'BlinkElite') as Record<string, any>
    expect([elite['Cost']].flat()[0].Cooldown).toMatchObject({
      Link: 'Abil/BlinkElite',
      TimeUse: '10',
    })
  })

  it('scopes defaults to the catalog that declares them', async () => {
    const { catalog } = await openAbilAndBehavior()
    const stim = catalog.getResolved('Behavior', 'Stim') as Record<string, any>
    // CBehavior.Cost is a scalar SCost: an undeclared structure still exists and takes its
    // catalog's default, never the Abil catalog's.
    expect(stim['Cost']).toEqual({ Charge: { Link: 'Behavior/Stim', Location: 'Behavior' } })
    expect(JSON.stringify(stim)).not.toContain('Abil/')
  })

  it('keeps structure defaults when a rename rewrites the file', async () => {
    const document = await openAbilAndBehavior()
    const plan = createSc2DataEntityRenameEditPlan(document, {
      renames: [{ namespace: 'Abil', oldId: 'BlinkElite', newId: 'BlinkPrime' }],
    })
    const rewritten = plan.edits.find(edit => edit.text?.includes('BlinkPrime'))?.text ?? ''
    expect(rewritten).toContain('<SCost>')
    expect(rewritten).toContain('<Charge Link="Abil/##id##"/>')
    expect(rewritten).toContain('<SAbilCmdButton>')
  })
})
