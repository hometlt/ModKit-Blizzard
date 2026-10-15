import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  calculateBankSignature,
  coerceBankValue,
  getBankValue,
  makeBankValue,
  parseBank,
  serializeBank,
  sortBank,
  verifyBankSignature,
} from '../../shared/core/index.js'

const INFO = {
  bankName: 'Example',
  authorId: '2-S2-1-100',
  playerId: '1-S2-1-200',
}

describe('SC2Bank', () => {
  it('parses typed values and signatures', () => {
    const bank = parseBank(`<?xml version="1.0" encoding="utf-8"?>
<Bank version="1">
  <Section name="Stats">
    <Key name="Kills"><Value int="75"/></Key>
    <Key name="Name"><Value string="Raynor &amp; Co"/></Key>
    <Key name="Done"><Value flag="1"/></Key>
    <Key name="Where"><Value point="12.5,9"/></Key>
  </Section>
  <Signature value="ABCD"/>
</Bank>`)

    expect(bank.version).toBe('1')
    expect(bank.signature).toBe('ABCD')
    expect(coerceBankValue(getBankValue(bank, 'Stats', 'Kills')!)).toBe(75)
    expect(coerceBankValue(getBankValue(bank, 'Stats', 'Name')!)).toBe('Raynor & Co')
    expect(coerceBankValue(getBankValue(bank, 'Stats', 'Done')!)).toBe(true)
    expect(coerceBankValue(getBankValue(bank, 'Stats', 'Where')!)).toEqual({ x: 12.5, y: 9 })
  })

  it('serializes and reparses banks', () => {
    const bank = {
      version: '1',
      sections: [
        {
          name: 'Stats',
          keys: [
            { name: 'Kills', value: makeBankValue('int', 75) },
            { name: 'Rank', value: makeBankValue('string', 'Hero') },
          ],
        },
      ],
    }

    const xml = serializeBank(bank, { signature: INFO })
    const parsed = parseBank(xml)

    expect(parsed.signature).toBe(calculateBankSignature(bank, INFO))
    expect(verifyBankSignature(parsed, INFO)).toBe(true)
    expect(getBankValue(parsed, 'Stats', 'Rank')?.value).toBe('Hero')
  })

  it('sorts sections and keys using SC2 bank byte-order semantics', () => {
    const sorted = sortBank({
      sections: [
        { name: 'b', keys: [{ name: 'z' }, { name: 'aa' }, { name: 'a' }] },
        { name: 'A', keys: [] },
      ],
    })

    expect(sorted.sections.map(section => section.name)).toEqual(['A', 'b'])
    expect(sorted.sections[1]!.keys.map(key => key.name)).toEqual(['a', 'aa', 'z'])
  })

  it('supports non-Value child nodes used by some custom banks', () => {
    const bank = parseBank(`<Bank>
  <Section name="S">
    <Key name="Complex">
      <Unit id="Marine"/>
      <Item text="ignored-for-signature"/>
    </Key>
  </Section>
</Bank>`)

    expect(bank.sections[0]!.keys[0]!.nodes).toEqual([
      { name: 'Unit', type: 'id', value: 'Marine', attrs: { id: 'Marine' } },
      {
        name: 'Item',
        type: 'text',
        value: 'ignored-for-signature',
        attrs: { text: 'ignored-for-signature' },
      },
    ])
    expect(serializeBank(bank, { xmlHeader: false })).toContain('<Unit id="Marine"/>')
  })

  it('round-trips a real End of Dreams bank', () => {
    const xml = readFileSync(
      new URL('./fixtures/endofdreamsbank2.SC2Bank', import.meta.url),
      'utf8',
    ).trim()
    const bank = parseBank(xml)

    expect(bank.version).toBe('1')
    expect(bank.signature).toBe('B786E6B04930A2B9D6789019D9D7DAD476A3A9DB')
    expect(getBankValue(bank, 'Ranks', 'Rank')).toEqual({ type: 'string', value: 'Hero' })
    expect(coerceBankValue(getBankValue(bank, 'Stats', 'TotalKills')!)).toBe(9999999)
    expect(coerceBankValue(getBankValue(bank, 'Check', 'Sum')!)).toBe(31)
    expect(serializeBank(bank)).toBe(xml.replace(/\r\n?/g, '\n'))
  })
})
