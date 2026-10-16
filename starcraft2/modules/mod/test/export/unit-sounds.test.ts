import { describe, expect, it } from 'vitest'
import {
  abilityEventName, actorSoundIndex, planUnitSounds, readUnitSound, soundKindId, soundPrefixes, soundsJson, STARMINE_ABILITIES,
  type DataEntity, type SoundExportContext, unitEventName,
} from '../../shared/export/unit-sounds.js'

const on = (...terms: string[]) => terms.map((Terms, index) => ({ index: String(index), value: { Terms, Send: 'Create' } }))
const files = (...paths: string[]) => paths.map((File, index) => ({ index: String(index), value: { File } }))

/** A small slice of SC2 Data: a siege tank (weapon → missile effect → action actor) and psionic storm. */
const DATA: Record<string, DataEntity[]> = {
  Unit: [
    { entityId: 'SiegeTank', fields: { WeaponArray: [{ index: '0', value: { Link: '90mmCannons' } }] } },
    { entityId: 'Pylon', fields: {} },
  ],
  Weapon: [{ entityId: '90mmCannons', fields: { Effect: '90mmCannonsSet' } }],
  Effect: [
    { entityId: '90mmCannonsSet', fields: { EffectArray: [{ index: '0', value: '90mmCannons' }] } },
    { entityId: '90mmCannons', fields: { Amount: 15 } },
    { entityId: 'PsiStormPersistent', fields: {} },
  ],
  Abil: [{ entityId: 'PsiStorm', fields: { Effect: [{ index: '0', value: 'PsiStormPersistent' }] } }],
  Actor: [
    { entityId: 'SiegeTank', fields: {
      SoundArray: [{ index: 'Attack', value: 'SiegeTank_Attack' }, { index: 'What', value: 'SiegeTank_What' },
        { index: 'Pissed', value: 'SiegeTank_Pissed' }],
      DeathArray: [{ index: 'Normal', value: { SoundLink: 'SiegeTank_Death' } }],
    } },
    { entityId: 'SiegeTankAttack', fields: { On: on('Effect.90mmCannons.Start; At Caster'),
      LaunchAssets: { Sound: 'SiegeTank_AttackLaunch' }, ImpactMap: [{ index: 'None', value: { Sound: 'SiegeTank_AttackImpact' } }] } },
    { entityId: 'HighTemplarPsiStormSound', fields: { On: on('Effect.PsiStormPersistent.Start'), Sound: 'HighTemplar_PsionicStormLaunch' } },
    // Data names a CSound that no longer exists: the next candidate wins.
    { entityId: 'HighTemplarPsiStormLaunchSound', fields: { On: on('Abil.PsiStorm.SourcePrepStart'), Sound: 'HiTePsionicStormCast' } },
  ],
  Sound: [
    { entityId: 'SiegeTank_AttackLaunch', fields: { AssetArray: files('Assets\\Sounds\\Terran\\SiegeTank\\SiegeTank_AttackLaunch0.wav') } },
    { entityId: 'SiegeTank_Attack', fields: { AssetArray: files('Assets\\Sounds\\Terran\\SiegeTank\\SiegeTank_Attack00.ogg', 'Assets\\Sounds\\Terran\\SiegeTank\\SiegeTank_Attack01.ogg') } },
    { entityId: 'SiegeTank_What', fields: { AssetArray: files('Assets\\Sounds\\Terran\\SiegeTank\\SiegeTank_What00.ogg') } },
    { entityId: 'SiegeTank_Pissed', fields: { AssetArray: files('Assets\\Sounds\\Terran\\SiegeTank\\SiegeTank_Pissed00.ogg') } },
    { entityId: 'SiegeTank_Death', fields: { AssetArray: files('Assets\\Sounds\\Terran\\SiegeTank\\SiegeTank_Death0.wav') } },
    { entityId: 'HighTemplar_PsionicStormLaunch', fields: { AssetArray: files('Assets\\Sounds\\Protoss\\HighTemplar\\Storm0.wav') } },
    { entityId: 'Pylon_What', fields: {
      AssetArrayTemplate: { File: 'LocalizedData\\Sounds\\VO\\Protoss\\^TemplateParam2^.ogg' },
      AssetArray: [{ index: '0', value: { TemplateParam: 'Pylon_What00' } }] } },
  ],
}

/** A context over DATA whose voice files live per locale, as CASC lists them (lower case). */
function fixtureContext(heldLocales: readonly string[]): SoundExportContext & { reads: string[] } {
  const reads: string[] = []
  const localized = (path: string) => /siegetank_(attack|what|pissed)\d/u.test(path)
  return {
    reads,
    async locate(path) {
      const lower = path.toLowerCase()
      return { layerId: 'liberty', path: localized(lower) ? `dede.sc2assets/${lower}` : `base.sc2assets/${lower}` }
    },
    async read(_layerId, path) {
      reads.push(path)
      const locale = /^([a-z]{4})\.sc2assets\//u.exec(path)?.[1]
      if (locale !== undefined && locale !== 'base' && !heldLocales.includes(locale)) throw new Error('not on this installation')
      return new TextEncoder().encode(path)
    },
    async query(request) {
      const { kind, namespace, refs } = request as { kind: string; namespace?: string; refs?: { namespace: string; entityId: string }[] }
      if (kind === 'data.ids') return { ids: (DATA[namespace!] ?? []).map(row => row.entityId) }
      return { entities: (refs ?? []).flatMap(ref => (DATA[ref.namespace] ?? []).filter(row => row.entityId === ref.entityId)) }
    },
  }
}

describe('StarMine unit sounds', () => {
  it('names events exactly as the StarMine contract', () => {
    expect(soundKindId('SIEGE_TANK')).toBe('siegetank')
    expect(soundKindId('HIGH_TEMPLAR')).toBe('hightemplar')
    expect(unitEventName('siegetank', 'fire')).toBe('siegetank.fire')
    expect(abilityEventName('psionic_storm')).toBe('ability.psionic_storm')
    expect(Object.keys(STARMINE_ABILITIES)).toContain('psionic_storm')
    expect(soundPrefixes('SwarmHostMP', { entityId: 'SwarmHostMP', fields: { SoundArray: [{ index: 'What', value: 'SwarmHost_What' }] } }))
      .toEqual(['SwarmHostMP', 'SwarmHost'])
  })

  it('indexes actor sounds by their first On term', () => {
    const index = actorSoundIndex(DATA['Actor']!)
    expect(index.get('Effect.90mmCannons.Start')).toEqual(['SiegeTank_AttackLaunch', 'SiegeTank_AttackImpact'])
    expect(index.get('Effect.90mmCannons.*')).toEqual(['SiegeTank_AttackLaunch', 'SiegeTank_AttackImpact'])
    expect(index.get('Effect.PsiStormPersistent.Start')).toEqual(['HighTemplar_PsionicStormLaunch'])
  })

  it('plans fire from the weapon effect tree, voices from the actor and abilities from their effects', async () => {
    const plan = await planUnitSounds(fixtureContext(['enus']), { kinds: ['siegetank', 'pylon'], abilities: ['psionic_storm', 'stimpack'] })
    expect(plan.events['siegetank.fire']?.map(sound => sound.gamePath)).toEqual(['Assets\\Sounds\\Terran\\SiegeTank\\SiegeTank_AttackLaunch0.wav'])
    expect(plan.events['siegetank.attack']?.map(sound => sound.name)).toEqual(['sc2/siegetank/attack_0', 'sc2/siegetank/attack_1'])
    expect(plan.events['ability.psionic_storm']?.[0]?.name).toBe('sc2/ability/psionic_storm_0')
    expect(plan.events['ability.psionic_storm']?.[0]?.sound).toBe('HighTemplar_PsionicStormLaunch')
    // SC2's own naming fills the actor's gaps; templates give the file.
    expect(plan.events['pylon.ambient']?.[0]?.gamePath).toBe('LocalizedData\\Sounds\\VO\\Protoss\\Pylon_What00.ogg')
    expect(plan.missing.map(item => item.event)).toEqual(expect.arrayContaining(['pylon.fire', 'pylon.attack', 'ability.stimpack']))
    expect(soundsJson(plan)).toMatchObject({
      'siegetank.fire': { subtitle: 'subtitles.starmine.siegetank.fire', sounds: ['starmine:sc2/siegetank/fire_0'] },
      'ability.psionic_storm': { sounds: ['starmine:sc2/ability/psionic_storm_0'] },
    })
  })

  it('reads voices in the chosen locale even when locate names another', async () => {
    const context = fixtureContext(['enus', 'ruru'])
    const plan = await planUnitSounds(context, { kinds: ['siegetank'], abilities: [] })
    const attack = plan.events['siegetank.attack']![0]!
    expect(attack.path.startsWith('dede.sc2assets/')).toBe(true)
    const warnings: string[] = []
    expect((await readUnitSound(context, attack, 'ruRU', message => warnings.push(message))).locale).toBe('ruRU')
    expect(context.reads.at(-1)).toMatch(/^ruru\.sc2assets\//u)
    expect(warnings).toEqual([])
    // Unlocalized files are read as located.
    const fire = plan.events['siegetank.fire']![0]!
    expect((await readUnitSound(context, fire, 'ruRU', message => warnings.push(message))).locale).toBeUndefined()
  })

  it('falls back to English, with a warning, when the chosen locale cannot be read', async () => {
    const context = fixtureContext(['enus'])
    const plan = await planUnitSounds(context, { kinds: ['siegetank'], abilities: [] })
    const warnings: string[] = []
    const read = await readUnitSound(context, plan.events['siegetank.ambient']![0]!, 'koKR', message => warnings.push(message))
    expect(read.locale).toBe('enUS')
    expect(warnings[0]).toMatch(/no koKR copy.*took enUS/u)
  })
})
