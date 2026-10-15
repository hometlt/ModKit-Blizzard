import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalSc2Locale, DEFAULT_VOICE_LOCALE, localeOfPath, localizedAssetPath, pickVoiceLocale, voiceLocaleFrom,
} from '../../shared/core/voice-locale.ts'

test('voice locale: English unless chosen', () => {
  assert.equal(voiceLocaleFrom([]), 'enUS')
  assert.equal(DEFAULT_VOICE_LOCALE, 'enUS')
  assert.equal(voiceLocaleFrom(['--voice-locale=ruRU']), 'ruRU')
  assert.equal(voiceLocaleFrom(['--voice-locale', 'de-de']), 'deDE')
  assert.equal(voiceLocaleFrom([], { MODKIT_VOICE_LOCALE: 'frfr' }), 'frFR')
  assert.equal(voiceLocaleFrom(['--voice-locale=enGB'], { MODKIT_VOICE_LOCALE: 'frFR' }), 'enGB')
  assert.throws(() => voiceLocaleFrom(['--voice-locale=xxYY']), /Unknown StarCraft II voice locale/u)
})

test('localized paths move to the chosen locale, others stay', () => {
  assert.equal(localizedAssetPath('mods/liberty.sc2mod/dede.sc2assets/sounds/vo/marine_yes00.ogg', 'enUS'),
    'mods/liberty.sc2mod/enus.sc2assets/sounds/vo/marine_yes00.ogg')
  assert.equal(localizedAssetPath('Mods/Liberty.SC2Mod/deDE.SC2Assets/Sounds/VO/Marine_Yes00.ogg', 'enUS'),
    'Mods/Liberty.SC2Mod/enUS.SC2Assets/Sounds/VO/Marine_Yes00.ogg')
  assert.equal(localizedAssetPath('mods/core.sc2mod/ruRU.SC2Data/LocalizedData/GameStrings.txt', 'enUS'),
    'mods/core.sc2mod/enUS.SC2Data/LocalizedData/GameStrings.txt')
  assert.equal(localizedAssetPath('mods/liberty.sc2mod/base.sc2assets/sounds/weapon/gauss.ogg', 'ruRU'),
    'mods/liberty.sc2mod/base.sc2assets/sounds/weapon/gauss.ogg')
  assert.equal(localeOfPath('mods/x.sc2mod/dede.sc2assets/a.ogg'), 'deDE')
  assert.equal(localeOfPath('mods/x.sc2mod/base.sc2assets/a.ogg'), undefined)
  assert.equal(canonicalSc2Locale('ZHTW'), 'zhTW')
})

test('the best held locale', () => {
  assert.equal(pickVoiceLocale('enUS', ['deDE', 'enUS']), 'enUS')
  assert.equal(pickVoiceLocale('ruRU', ['deDE', 'enUS']), 'enUS')
  assert.equal(pickVoiceLocale('ruRU', ['dede']), 'deDE')
  assert.equal(pickVoiceLocale('ruRU', []), undefined)
})
