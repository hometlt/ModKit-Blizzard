// Exports the StarCraft II sounds the StarMine Minecraft mod plays (contract: docs/SC2_EXPORT.md and
// tools/check_sounds.py of hometlt/minecraft) from an installed StarCraft II:
//   pnpm --dir starcraft2 exec tsx ../scripts/export-starmine-sounds.mjs --starmine <StarMine checkout>
//     [--out <assets dir, default <StarMine>/sc2-assets>] [--voice-locale=ruRU] [--sc2 <SC2 root>]
// Events come from the mod's own UnitKind.java / Ability.java (as check_sounds.py reads them); which
// SC2 sound each event takes is decided by starcraft2/modules/mod/shared/export/unit-sounds.ts from the
// resolved Data of VoidMulti, read through the SC2 mod loader (ContentSources.openModContext). Voices are
// English unless --voice-locale / MODKIT_VOICE_LOCALE says otherwise. Files become mono Ogg Vorbis
// through the host's ffmpeg (FFMPEG or PATH). Writes <out>/assets/starmine/sounds/sc2/** and
// <out>/assets/starmine/sounds.json (replacing earlier sc2 sounds), then prints what SC2 has no sound for.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { voiceLocaleFrom } from '../starcraft2/modules/mod/shared/core/voice-locale.ts'
import { CAMPAIGN_MOD, planUnitSounds, readUnitSound, soundKindId, soundsJson } from '../starcraft2/modules/mod/shared/export/unit-sounds.ts'
import { Sc2DesktopContentSources } from '../starcraft2/modules/game/battlenet/content-sources/local-content-sources.ts'

const option = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const starmine = option('--starmine')
if (!starmine) throw new Error('usage: export-starmine-sounds.mjs --starmine <StarMine checkout> [--out <dir>] [--voice-locale=xxXX]')
const out = resolve(option('--out') ?? join(starmine, 'sc2-assets'))
const sc2 = option('--sc2') ?? process.env.MODKITX_SC2_ROOT ?? 'F:/GAMES/Blizzard/StarCraft II'
const voiceLocale = voiceLocaleFrom(process.argv, process.env)
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'

// The events the mod plays, read the way tools/check_sounds.py reads them.
const java = join(starmine, 'src/main/java/dev/starmine')
const kinds = [...readFileSync(join(java, 'entity/UnitKind.java'), 'utf8').matchAll(/^\t([A-Z_]+)\(/gmu)].map(match => soundKindId(match[1]))
const abilities = [...readFileSync(join(java, 'ability/Ability.java'), 'utf8').matchAll(/^\t[A-Z0-9_]+\(\s*"([a-z0-9_]+)"/gmu)].map(match => match[1])

const scratch = mkdtempSync(join(process.env.MODKIT_TEMP ?? 'C:/MKTEMP', 'starmine-sounds-'))
const sources = new Sc2DesktopContentSources({ installationDirectory: sc2,
  documentsDirectory: scratch, battleNetCacheDirectory: scratch, sc2MapsCacheDirectory: scratch })
const open = path => sources.openModContext({ schemaVersion: 1, target: { sourceId: 'local:casc', path }, locales: [voiceLocale] })
const contexts = []
try {
  console.log(`voice locale ${voiceLocale}; ${kinds.length} kinds, ${abilities.length} abilities`)
  // The multiplayer Data first; what it lacks (the heroes and their abilities) from the campaign.
  const context = await open('Mods/VoidMulti.SC2Mod')
  contexts.push(context)
  const first = await planUnitSounds(context, { kinds, abilities })
  const owner = new Map(Object.keys(first.events).map(event => [event, context]))
  const events = { ...first.events }
  let missing = first.missing
  const { kinds: heroKinds, abilities: heroAbilities } = first.unresolved
  if (heroKinds.length || heroAbilities.length) {
    const campaign = await open(CAMPAIGN_MOD)
    contexts.push(campaign)
    const second = await planUnitSounds(campaign, { kinds: heroKinds, abilities: heroAbilities })
    for (const [event, sounds] of Object.entries(second.events)) { events[event] = sounds; owner.set(event, campaign) }
    // Missing is what neither context gives (a campaign miss keeps a multiplayer fallback).
    const seen = new Set()
    missing = [...first.missing, ...second.missing].filter(item => events[item.event] === undefined && !seen.has(item.event) && seen.add(item.event))
    console.log(`campaign ${CAMPAIGN_MOD}: ${heroKinds.join(', ') || '-'} | ${heroAbilities.join(', ') || '-'}`)
  }
  const plan = { events, missing }
  const root = join(out, 'assets/starmine')
  rmSync(join(root, 'sounds/sc2'), { recursive: true, force: true })
  const raw = join(scratch, 'raw')
  mkdirSync(raw, { recursive: true })
  const warnings = new Set()
  const locales = new Map()
  let files = 0
  for (const [event, sounds] of Object.entries(plan.events)) {
    for (const sound of sounds) {
      const { bytes, locale } = await readUnitSound(owner.get(event), sound, voiceLocale, message => warnings.add(message))
      if (locale) locales.set(locale, (locales.get(locale) ?? 0) + 1)
      const source = join(raw, `${files}${sound.path.slice(sound.path.lastIndexOf('.'))}`)
      writeFileSync(source, bytes)
      const target = join(root, 'sounds', `${sound.name}.ogg`)
      mkdirSync(dirname(target), { recursive: true })
      // Positional sounds: mono (Minecraft attenuates only mono sounds by distance).
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', source, '-ac', '1', '-c:a', 'libvorbis', '-q:a', '5', target])
      files++
    }
  }
  writeFileSync(join(root, 'sounds.json'), JSON.stringify(soundsJson(plan), null, '\t') + '\n')
  for (const warning of warnings) console.warn('warning:', warning)
  console.log(`${Object.keys(plan.events).length} events, ${files} files, localized files by locale: ${JSON.stringify(Object.fromEntries(locales))}`)
  console.log(`${plan.missing.length} events SC2 has no sound for:`)
  for (const { event, reason } of plan.missing) console.log(`  ${event}: ${reason}`)
} finally {
  for (const context of contexts) await context.dispose?.()
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
