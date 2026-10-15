/**
 * "Who uses this style?" — asked across files.
 *
 * A style sheet does not know its own users, so the question is answered by an index over the
 * documents a request carries. The two-way bookkeeping is the shared `createReferenceIndex`, which
 * came from MK2's `project-index` and sat in the kit with no consumer until this one; what the
 * format decides is only what counts as a reference.
 */
import { describe, expect, it } from 'vitest'
import { styleUsageIndex } from '../shared/language/string-workspace.js'

const NL = '\n'

const A = [
  'Unit/Name/Marine=<s val="TooltipStyle">Marine</s>',
  'Unit/Tip/Marine=Costs <c val="ColorAttackInfo">50</c>',
  '',
].join(NL)

const B = ['Abil/Name/Stim=<s val="TooltipStyle">Stimpack</s>', ''].join(NL)

/** A deliberately trivial extractor: the test is about the index, not about markup parsing. */
function styleNames(text: string): string[] {
  return [...text.matchAll(/val="([A-Za-z_]\w*)"/gu)].map(match => match[1] as string)
}

function documents(entries: readonly (readonly [string, string])[]) {
  return entries.map(([uri, text]) => ({ uri, text, languageId: 'sc2-strings' }))
}

describe('style usage across a workspace', () => {
  it('answers which documents use a style, and which styles a document uses', () => {
    const index = styleUsageIndex(
      documents([
        ['file:///enUS/GameStrings.txt', A],
        ['file:///enUS/AbilStrings.txt', B],
      ]),
      styleNames,
    )
    expect(index.referencing('TooltipStyle')).toEqual([
      'file:///enus/gamestrings.txt',
      'file:///enus/abilstrings.txt',
    ])
    expect(index.targetsOf('file:///enUS/GameStrings.txt')).toEqual([
      'TooltipStyle',
      'ColorAttackInfo',
    ])
  })

  /*
   * The property that makes a two-way index worth having. A document that stops referencing a style
   * must stop being reported for it; an index that only grows keeps pointing at edits that are no
   * longer there, which is worse than no index at all.
   */
  it('forgets a reference a document no longer makes', () => {
    const index = styleUsageIndex(documents([['file:///a.txt', A]]), styleNames)
    expect(index.referencing('ColorAttackInfo')).toHaveLength(1)
    index.set('file:///a.txt', ['TooltipStyle'])
    expect(index.referencing('ColorAttackInfo')).toEqual([])
    expect(index.referencing('TooltipStyle')).toEqual(['file:///a.txt'])
  })

  it('treats two spellings of one path as one document', () => {
    const index = styleUsageIndex(
      documents([
        ['C:\\Mod\\Strings.txt', B],
        ['c:/mod/strings.txt', B],
      ]),
      styleNames,
    )
    expect(index.documents()).toHaveLength(1)
    expect(index.referencing('TooltipStyle')).toHaveLength(1)
  })

  it('indexes only the localization documents in a mixed snapshot', () => {
    const index = styleUsageIndex(
      [
        { uri: 'file:///GameStrings.txt', text: A, languageId: 'sc2-strings' },
        { uri: 'file:///UI/FontStyles.SC2Style', text: '<StyleFile/>', languageId: 'sc2-style' },
      ],
      styleNames,
    )
    expect(index.documents()).toEqual(['file:///gamestrings.txt'])
  })
})
