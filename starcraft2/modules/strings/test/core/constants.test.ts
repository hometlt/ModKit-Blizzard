import { describe, it, expect } from 'vitest'
import { parseIndexSc2Locale } from '../../shared/core/constants.js'

const REAL_CORE_INDEX = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Locales>
    <Locale id="enUS" name="English"/>
    <Locale id="enGB" name="English (GB)"/>
    <Locale id="frFR" name="Français"/>
    <Locale id="deDE" name="Deutsch"/>
    <Locale id="esES" name="Español (ES)"/>
    <Locale id="esMX" name="Español (AL)"/>
    <Locale id="ruRU" name="Русский"/>
    <Locale id="koKR" name="한국어" wordbreak="1"/>
    <Locale id="zhCN" name="简体中文"/>
    <Locale id="zhTW" name="繁體中文"/>
    <Locale id="plPL" name="Polski"/>
    <Locale id="itIT" name="Italiano"/>
    <Locale id="ptBR" name="Português (BR)"/>
</Locales>`

describe('parseIndexSc2Locale', () => {
  it('parses every <Locale> entry from a real Core.SC2Mod Index.SC2Locale', () => {
    const locales = parseIndexSc2Locale(REAL_CORE_INDEX)
    expect(locales).toHaveLength(13)
    expect(locales[0]).toEqual({ id: 'enUS', name: 'English', iso639: 'en' })
  })

  it('picks up wordbreak="1"', () => {
    const locales = parseIndexSc2Locale(REAL_CORE_INDEX)
    const ko = locales.find((l) => l.id === 'koKR')
    expect(ko?.wordBreak).toBe(true)
    const en = locales.find((l) => l.id === 'enUS')
    expect(en?.wordBreak).toBeUndefined()
  })

  it('falls back to the known iso639 for a recognized id, and a best-effort guess for an unknown one', () => {
    const [known] = parseIndexSc2Locale('<Locales><Locale id="deDE" name="Deutsch"/></Locales>')
    expect(known?.iso639).toBe('de')
    const [unknown] = parseIndexSc2Locale('<Locales><Locale id="xxYY" name="Custom"/></Locales>')
    expect(unknown?.iso639).toBe('xx')
  })

  it('ignores entries missing id or name, and returns [] for no <Locale> tags', () => {
    expect(parseIndexSc2Locale('<Locales><Locale name="No id"/></Locales>')).toEqual([])
    expect(parseIndexSc2Locale('<Locales></Locales>')).toEqual([])
  })
})
