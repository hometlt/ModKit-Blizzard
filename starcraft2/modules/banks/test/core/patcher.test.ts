import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchBankValueXml, patchBankSignatureXml } from '../../shared/core/patcher.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(resolve(__dirname, 'fixtures/endofdreamsbank2.SC2Bank'), 'utf8')

describe('patchBankValueXml', () => {
  it('patches an int value in-place', () => {
    const result = patchBankValueXml(FIXTURE, { section: 'Stats', key: 'Score', type: 'int', value: '42' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    // Only the score value should change
    expect(result.xml).toContain('<Value int="42"/>')
    // Rest of file should be structurally intact
    expect(result.xml).toContain('<Section name="Ranks">')
    expect(result.xml).toContain('<Value string="Hero"/>')
    expect(result.xml).toContain('<Signature value="')
    // Should not have reformatted any other values
    expect(result.xml).toContain('<Value int="9999999"/>')
  })

  it('patches a string value', () => {
    const result = patchBankValueXml(FIXTURE, { section: 'Ranks', key: 'Rank', type: 'string', value: 'Legend' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.xml).toContain('<Value string="Legend"/>')
    // Other sections untouched
    expect(result.xml).toContain('<Value int="9999999"/>')
  })

  it('returns changed=false when value is already the target', () => {
    const result = patchBankValueXml(FIXTURE, { section: 'Ranks', key: 'Rank', type: 'string', value: 'Hero' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
  })

  it('replaces whole <Value> tag when type changes', () => {
    const result = patchBankValueXml(FIXTURE, { section: 'Stats', key: 'Score', type: 'string', value: 'max' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<Value string="max"/>')
    // Old int tag should be gone from Score key neighbourhood
    const scoreKeyIdx = result.xml.indexOf('<Key name="Score">')
    const afterScore = result.xml.slice(scoreKeyIdx, result.xml.indexOf('</Key>', scoreKeyIdx))
    expect(afterScore).not.toContain('<Value int=')
  })

  it('returns ok=false for unknown section', () => {
    const result = patchBankValueXml(FIXTURE, { section: 'NoSuch', key: 'X', type: 'int', value: '1' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/Section "NoSuch"/)
  })

  it('returns ok=false for unknown key', () => {
    const result = patchBankValueXml(FIXTURE, { section: 'Stats', key: 'NoSuch', type: 'int', value: '1' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/Key "NoSuch"/)
  })

  it('escapes XML special chars in value', () => {
    const xml = `<Bank version="1">\n\t<Section name="S">\n\t\t<Key name="K">\n\t\t\t<Value string="old"/>\n\t\t</Key>\n\t</Section>\n</Bank>`
    const result = patchBankValueXml(xml, { section: 'S', key: 'K', type: 'string', value: 'a&b<c>"d"' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('a&amp;b&lt;c&gt;&quot;d&quot;')
  })

  it('preserves surrounding whitespace and indentation unchanged', () => {
    const result = patchBankValueXml(FIXTURE, { section: 'Stats', key: 'TotalKills', type: 'int', value: '0' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The first line should be the XML declaration unchanged
    expect(result.xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true)
    // Line count should stay the same (only attribute value changed, not structure)
    const origLines = FIXTURE.split('\n').length
    const newLines = result.xml.split('\n').length
    expect(newLines).toBe(origLines)
  })
})

describe('patchBankSignatureXml', () => {
  it('replaces existing signature value', () => {
    const newSig = 'AABBCCDDEE112233445566778899AABBCCDDEEFF'
    const result = patchBankSignatureXml(FIXTURE, newSig)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.xml).toContain(`<Signature value="${newSig}"/>`)
    // Should not have added a second <Signature>
    expect(result.xml.match(/<Signature/g)?.length).toBe(1)
  })

  it('returns changed=false when signature is already the target', () => {
    const existing = 'B786E6B04930A2B9D6789019D9D7DAD476A3A9DB'
    const result = patchBankSignatureXml(FIXTURE, existing)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
  })

  it('inserts <Signature> before </Bank> when missing', () => {
    const noSig = FIXTURE.replace(/\s*<Signature[^>]*\/>/, '')
    const newSig = 'DEADBEEF00000000000000000000000000000000'
    const result = patchBankSignatureXml(noSig, newSig)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.xml).toContain(`<Signature value="${newSig}"/>`)
    expect(result.xml).toContain('</Bank>')
    // Signature must appear before </Bank>
    const sigIdx = result.xml.indexOf('<Signature')
    const closeIdx = result.xml.indexOf('</Bank>')
    expect(sigIdx).toBeLessThan(closeIdx)
  })

  it('returns ok=false when </Bank> is missing', () => {
    const broken = FIXTURE.replace('</Bank>', '')
    const noSig = broken.replace(/\s*<Signature[^>]*\/>/, '')
    const result = patchBankSignatureXml(noSig, 'ABCD')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/<\/Bank>/)
  })

  it('handles single-quoted signature attribute', () => {
    const singleQuoted = FIXTURE.replace(
      /(<Signature\s+value=)"([^"]*)"(\/>)/,
      `$1'B786E6B04930A2B9D6789019D9D7DAD476A3A9DB'$3`,
    )
    const newSig = 'AABBCCDDEE112233445566778899AABBCCDDEEFF'
    const result = patchBankSignatureXml(singleQuoted, newSig)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.xml).toContain(newSig)
  })
})
