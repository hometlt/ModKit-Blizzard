import { describe, expect, it } from 'vitest'
import { getBankListNames, matchBankListToDiscovered, parseBankList, serializeBankList } from '../../shared/core/index.js'

describe('BankList.xml', () => {
  it('parses preload bank entries', () => {
    const list = parseBankList(`<?xml version="1.0" encoding="utf-8"?>
<BankList>
    <Bank Name="TCampaign" Player="1"/>
    <Bank Name="PArchive" Player="2" Mode="Shared"/>
</BankList>`)

    expect(list.banks).toEqual([
      { name: 'TCampaign', player: '1', attrs: { Name: 'TCampaign', Player: '1' } },
      { name: 'PArchive', player: '2', attrs: { Name: 'PArchive', Player: '2', Mode: 'Shared' } },
    ])
  })

  it('serializes bank lists', () => {
    const xml = serializeBankList({ banks: [{ name: 'A&B', player: '1', attrs: {} }] })
    expect(xml).toContain('<Bank Name="A&amp;B" Player="1"/>')
    expect(parseBankList(xml).banks[0]).toEqual({ name: 'A&B', player: '1', attrs: { Name: 'A&B', Player: '1' } })
  })

  it('matches BankList entries to discovered local banks', () => {
    const list = parseBankList(`<BankList>
      <Bank Name="A" Player="1"/>
      <Bank Name="B" Player="1"/>
    </BankList>`)
    const discovered = [
      {
        path: 'C:/A.SC2Bank',
        info: { bankName: 'a', bankPath: 'C:/A.SC2Bank', authorId: '2-S2-1-1', playerId: '2-S2-1-2', missing: [] },
      },
    ]

    expect(getBankListNames(list)).toEqual(['A', 'B'])
    const matches = matchBankListToDiscovered(list, discovered)
    expect(matches[0]!.discovered).toHaveLength(1)
    expect(matches[1]!.discovered).toHaveLength(0)
  })
})
