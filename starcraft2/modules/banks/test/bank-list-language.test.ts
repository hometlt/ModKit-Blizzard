import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createLanguageFileClassifier } from '@modkit/host/language'
import { createSc2BankListLanguageProvider } from '../providers/language/src/bank-list-language.js'

const provider = createSc2BankListLanguageProvider()
const VALID = '<BankList><Bank Name="Progress" Player="1"/><Bank Name="Shared"/></BankList>'

function position(text: string, needle: string) {
  const offset = text.indexOf(needle) + 1
  return { line: 0, character: offset }
}

function request(text: string, extra: Record<string, unknown> = {}) {
  return {
    document: { uri: 'memory://BankList.xml', languageId: 'sc2-bank-list', version: 3, text },
    workspaceDocuments: [],
    workspaceIncomplete: false,
    maxResults: 100,
    maxDocuments: 8,
    ...extra,
  } as never
}

describe('SC2 BankList language', () => {
  it('classifies the contributed BankList filename before the generic XML route', () => {
    const contribution = JSON.parse(readFileSync(new URL('../providers/language/provider.json', import.meta.url), 'utf8'))
    const facet = contribution.spec.provides.find((offer: { offerId: string }) => offer.offerId === 'sc2-bank-list-document-analysis-v1').facet
    const classify = createLanguageFileClassifier([
      { languageId: 'sc2-data', extension: 'xml' },
      ...facet.fileNames.map((fileName: string) => ({ languageId: facet.languageIds[0], fileName })),
    ])
    expect(classify('Base.SC2Data/banklist.xml').languageId).toBe('sc2-bank-list')
    expect(classify('Base.SC2Data/GameData/UnitData.xml').languageId).toBe('sc2-data')
  })

  it('publishes schema diagnostics, typed tokens, and bank symbols', async () => {
    const analysis = await provider.analyze(request(VALID))
    expect(analysis.diagnostics).toEqual([])
    expect(analysis.symbols.map(symbol => [symbol.name, symbol.detail])).toEqual([
      ['Progress', 'player 1'],
      ['Shared', 'shared bank'],
    ])
    expect(analysis.tokens.map(token => token.kind)).toEqual(
      expect.arrayContaining(['type', 'property', 'string', 'number']),
    )
  })

  it('rejects missing names, unknown attributes, and duplicate identities', async () => {
    const invalid =
      '<BankList><Bank Player="1"/><Bank Name="A" Other="x"/><Bank Name="A"/></BankList>'
    const diagnostics = await provider.diagnostics!(request(invalid))
    expect(diagnostics.diagnostics.map(item => item.code)).toEqual(
      expect.arrayContaining([
        'bank-list-name-required',
        'bank-list-unknown-attribute',
        'bank-list-duplicate-entry',
      ]),
    )
  })

  it('navigates a Bank Name to a matching SC2Bank workspace document', async () => {
    const target = {
      uri: 'content-source://fixture/Banks/Progress.SC2Bank',
      languageId: 'sc2-bank',
      version: 7,
      text: '<Bank/>',
    }
    const result = await provider.definition!(
      request(VALID, {
        position: position(VALID, 'Progress'),
        workspaceDocuments: [
          { uri: 'memory://BankList.xml', languageId: 'sc2-bank-list', version: 3, text: VALID },
          target,
        ],
      }),
    )
    expect(result).toEqual({
      locations: [
        {
          uri: target.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ],
      isIncomplete: false,
    })
  })

  it('offers only BankList elements and attributes at structural positions', async () => {
    const element = '<BankList><'
    expect(
      (
        await provider.completion!(
          request(element, { position: { line: 0, character: element.length } }),
        )
      ).items[0],
    ).toMatchObject({ label: 'Bank', insertTextFormat: 'snippet' })
    const attribute = '<BankList><Bank '
    expect(
      (
        await provider.completion!(
          request(attribute, { position: { line: 0, character: attribute.length } }),
        )
      ).items.map(item => item.label),
    ).toEqual(['Name', 'Player'])
  })
})
