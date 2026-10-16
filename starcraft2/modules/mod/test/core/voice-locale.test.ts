import { describe, expect, it } from 'vitest'
import {
  canonicalSc2Locale, DEFAULT_VOICE_LOCALE, localeOfPath, localizedAssetPath, pickVoiceLocale, SC2_LOCALES, voiceLocaleFrom,
} from '../../shared/core/voice-locale.js'

describe('voice locale', () => {
  it('is English unless chosen', () => {
    expect(voiceLocaleFrom([])).toBe('enUS')
    expect(DEFAULT_VOICE_LOCALE).toBe('enUS')
    expect(voiceLocaleFrom(['--voice-locale=ruRU'])).toBe('ruRU')
    expect(voiceLocaleFrom(['--voice-locale', 'de-de'])).toBe('deDE')
    expect(voiceLocaleFrom([], { MODKIT_VOICE_LOCALE: 'frfr' })).toBe('frFR')
    expect(voiceLocaleFrom(['--voice-locale=enGB'], { MODKIT_VOICE_LOCALE: 'frFR' })).toBe('enGB')
    expect(() => voiceLocaleFrom(['--voice-locale=xxYY'])).toThrow(/Unknown StarCraft II voice locale/u)
  })

  it('uses the strings module locale table', () => {
    expect(SC2_LOCALES).toHaveLength(13)
    expect(SC2_LOCALES).toContain('zhTW')
    expect(canonicalSc2Locale('ZHTW')).toBe('zhTW')
    expect(canonicalSc2Locale('xxYY')).toBeUndefined()
  })

  it('moves localized paths to the chosen locale and leaves others', () => {
    expect(localizedAssetPath('mods/liberty.sc2mod/dede.sc2assets/sounds/vo/marine_yes00.ogg', 'enUS'))
      .toBe('mods/liberty.sc2mod/enus.sc2assets/sounds/vo/marine_yes00.ogg')
    expect(localizedAssetPath('Mods/Liberty.SC2Mod/deDE.SC2Assets/Sounds/VO/Marine_Yes00.ogg', 'enUS'))
      .toBe('Mods/Liberty.SC2Mod/enUS.SC2Assets/Sounds/VO/Marine_Yes00.ogg')
    expect(localizedAssetPath('mods/core.sc2mod/ruRU.SC2Data/LocalizedData/GameStrings.txt', 'enUS'))
      .toBe('mods/core.sc2mod/enUS.SC2Data/LocalizedData/GameStrings.txt')
    expect(localizedAssetPath('mods/liberty.sc2mod/base.sc2assets/sounds/weapon/gauss.ogg', 'ruRU'))
      .toBe('mods/liberty.sc2mod/base.sc2assets/sounds/weapon/gauss.ogg')
    expect(localeOfPath('mods/x.sc2mod/dede.sc2assets/a.ogg')).toBe('deDE')
    expect(localeOfPath('mods/x.sc2mod/base.sc2assets/a.ogg')).toBeUndefined()
  })

  it('picks the best held locale', () => {
    expect(pickVoiceLocale('enUS', ['deDE', 'enUS'])).toBe('enUS')
    expect(pickVoiceLocale('ruRU', ['deDE', 'enUS'])).toBe('enUS')
    expect(pickVoiceLocale('ruRU', ['dede'])).toBe('deDE')
    expect(pickVoiceLocale('ruRU', [])).toBeUndefined()
  })
})
