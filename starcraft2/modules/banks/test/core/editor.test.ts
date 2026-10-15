import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SC2BankEditor, calculateBankSignature, parseBank } from '../../shared/core/index.js'

const INFO = {
  bankName: 'endofdreamsbank2',
  authorId: '2-S2-1-2355723',
  playerId: '2-S2-1-98765',
}

describe('SC2BankEditor', () => {
  it('reads, updates, removes, signs, and serializes bank values', () => {
    const xml = readFileSync(new URL('./fixtures/endofdreamsbank2.SC2Bank', import.meta.url), 'utf8')
    const editor = SC2BankEditor.parse(xml, INFO)

    expect(editor.getString('Ranks', 'Rank')).toBe('Hero')
    expect(editor.getInt('Stats', 'Score')).toBe(9999999)
    expect(editor.getInt('Stats', 'Missing', 12)).toBe(12)

    editor
      .setString('Ranks', 'Rank', 'Legendary')
      .setInt('Stats', 'Score', 1234)
      .setFlag('Flags', 'Unlocked', true)
      .removeKey('Stats', 'HellWins')

    const signature = editor.sign()
    expect(signature).toBe(calculateBankSignature(editor.bank, INFO))
    expect(editor.verify()).toBe(true)

    const reparsed = parseBank(editor.serialize({ signature: false }))
    expect(reparsed.signature).toBe(signature)
    expect(SC2BankEditor.parse(editor.serialize(), INFO).getInt('Stats', 'Score')).toBe(1234)
    expect(SC2BankEditor.parse(editor.serialize(), INFO).getFlag('Flags', 'Unlocked')).toBe(true)
    expect(SC2BankEditor.parse(editor.serialize(), INFO).get('Stats', 'HellWins')).toBeUndefined()
  })

  it('can serialize with implicit signature info', () => {
    const editor = new SC2BankEditor({ sections: [] }, INFO)
    editor.setInt('Stats', 'Kills', 7)

    const xml = editor.serialize()
    const parsed = SC2BankEditor.parse(xml, INFO)

    expect(parsed.verify()).toBe(true)
    expect(parsed.getInt('Stats', 'Kills')).toBe(7)
  })
})
