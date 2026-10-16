import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Sc2DesktopContentSources } from '../../../game/battlenet/content-sources/local-content-sources.js'
import { localeOfPath } from '../../shared/core/voice-locale.js'
import { planUnitSounds, readUnitSound, STARMINE_ABILITIES, UNIT_SOUND_EVENTS } from '../../shared/export/unit-sounds.js'

const installation = process.env['MODKITX_SC2_ROOT'] ?? 'F:/GAMES/Blizzard/StarCraft II'
const KINDS = ['marine', 'siegetank', 'zergling', 'hydralisk', 'stalker', 'hightemplar', 'battlecruiser', 'photoncannon']

/** Opens VoidMulti with one voice locale first, as the exporter does. */
async function withContext<T>(locale: string, body: (context: Awaited<ReturnType<Sc2DesktopContentSources['openModContext']>>) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(process.env['MODKIT_TEMP'] ?? 'C:/MKTEMP', 'starmine-sounds-real-'))
  const sources = new Sc2DesktopContentSources({ installationDirectory: installation,
    documentsDirectory: scratch, battleNetCacheDirectory: scratch, sc2MapsCacheDirectory: scratch })
  const context = await sources.openModContext({ schemaVersion: 1,
    target: { sourceId: 'local:casc', path: 'Mods/VoidMulti.SC2Mod' }, locales: [locale] })
  try {
    return await body(context)
  } finally {
    await context.dispose()
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe.skipIf(process.env['MODKIT_TEST_TIER'] !== 'real' || !existsSync(join(installation, '.build.info')))(
  'StarMine sounds from an installed StarCraft II', () => {
    it('finds every contract event of sample kinds and every mapped ability', { timeout: 600_000 }, async () => {
      const plan = await withContext('enUS', context => planUnitSounds(context, { kinds: KINDS, abilities: Object.keys(STARMINE_ABILITIES) }))
      const armed = KINDS.filter(kind => kind !== 'photoncannon')
      for (const kind of armed) for (const event of UNIT_SOUND_EVENTS) expect(plan.events[`${kind}.${event}`], `${kind}.${event}`).toBeDefined()
      expect(plan.events['photoncannon.fire']).toBeDefined()
      // Weapon shots, not voices: the marine fires its gauss rifle.
      expect(plan.events['marine.fire']?.[0]?.gamePath).toMatch(/Marine_AttackLaunch/iu)
      expect(plan.events['ability.psionic_storm']).toBeDefined()
      expect(plan.events['ability.stimpack']?.[0]?.gamePath).toMatch(/Stim/iu)
      const abilities = Object.keys(STARMINE_ABILITIES).filter(id => plan.events[`ability.${id}`] !== undefined)
      console.log(`abilities with a sound ${abilities.length}/${Object.keys(STARMINE_ABILITIES).length}; missing:`,
        plan.missing.filter(item => item.event.startsWith('ability.')).map(item => item.event).join(', '))
      expect(abilities.length).toBeGreaterThanOrEqual(40)
    })

    it('reads voice lines in the chosen locale (enUS and ruRU)', { timeout: 600_000 }, async () => {
      const read = async (locale: string) => withContext(locale, async context => {
        const plan = await planUnitSounds(context, { kinds: ['marine'], abilities: [] })
        const line = plan.events['marine.attack']![0]!
        expect(localeOfPath(line.path)).toBe(locale)
        const warnings: string[] = []
        const result = await readUnitSound(context, line, locale, message => warnings.push(message))
        return { ...result, warnings }
      })
      const english = await read('enUS')
      const russian = await read('ruRU')
      expect([english.locale, russian.locale]).toEqual(['enUS', 'ruRU'])
      expect(english.warnings.concat(russian.warnings)).toEqual([])
      expect(Buffer.from(english.bytes).equals(Buffer.from(russian.bytes))).toBe(false)
    })
  })
