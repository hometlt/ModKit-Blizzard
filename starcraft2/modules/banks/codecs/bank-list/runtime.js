import { createInspectionCodec, createTreeDataSource } from '@modkit/codec-kit'
import {
  createTableDataSource,
  decodeStructuredText,
  lineCount,
} from '../../../../shared/inspection/structured-text.js'
import { bankIdentity, parseSc2BankList } from '../../shared/model.js'
import { createBankListSources } from '../../shared/sources.js'

const ID = 'blizzard/sc2-bank-list'
const ascii = new TextDecoder('ascii', { fatal: false })

function sourceLabel(uri) {
  const normalized = String(uri).replaceAll('\\', '/').replace(/\/$/u, '')
  try {
    return decodeURIComponent(normalized.split('/').at(-1) || 'BankList')
  } catch {
    return normalized.split('/').at(-1) || 'BankList'
  }
}

export const definition = Object.freeze({
  id: ID,
  format: Object.freeze({
    id: 'sc2-bank-list',
    label: 'StarCraft II BankList',
    mediaType: 'application/xml',
  }),
  async detect(prefix, uri) {
    const text = ascii.decode(prefix)
    const structural = /^\s*(?:<\?xml\b[^>]*>\s*)?<BankList(?:\s|>)/iu.test(text)
    if (!structural) return { confidence: 0, kind: 'structure', note: 'bank-list-root-missing' }
    return {
      confidence: /(?:^|[\\/])BankList(?:\.xml)?$/iu.test(uri) ? 0.999 : 0.995,
      kind: 'structure',
      note: 'bank-list-root',
    }
  },
  async inspect(bytes, context) {
    const text = decodeStructuredText(bytes, context.budget, 'SC2 BankList')
    const bankList = parseSc2BankList(text, context.budget)
    const source = context.primary.source
    const semanticSources = createBankListSources(bankList, {
      snapshotId: String(context.input.revisions.revision),
      subjectId: source.id,
      label: sourceLabel(source.uri),
      source,
      bankIdentity,
    })
    return {
      summary: {
        format: 'sc2-bank-list',
        lines: lineCount(text),
        banks: bankList.banks.length,
        bankNames: [...new Set(bankList.banks.map(bank => bank.name))],
        playerScopedBanks: bankList.banks.filter(bank => bank.player !== undefined).length,
      },
      metadata: [
        {
          id: 'sc2-bank-list',
          label: 'SC2 BankList',
          entries: [
            { key: 'banks', value: bankList.banks.length },
            {
              key: 'playerScopedBanks',
              value: bankList.banks.filter(bank => bank.player !== undefined).length,
            },
            { key: 'elements', value: bankList.elementCount },
          ],
        },
      ],
      traits: [
        { id: 'content.text', parameters: { language: 'xml', lines: lineCount(text) } },
        { id: 'structure.hierarchy', parameters: { banks: bankList.banks.length } },
        { id: 'content.metadata', parameters: { banks: bankList.banks.length } },
      ],
      text: true,
      dataSources: {
        'common.view/table-data-source': createTableDataSource(
          ['Bank', 'Player'],
          bankList.banks.map(bank => [bank.name, bank.player ?? '']),
        ),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'bank-list',
          label: 'StarCraft II BankList',
          preview: `${bankList.banks.length} bank(s)`,
          children: bankList.banks.map(bank => ({
            kind: 'bank',
            label: bank.name,
            preview: bank.player === undefined ? 'shared' : `player ${bank.player}`,
          })),
        }),
        'common.view/subject-facts-source': semanticSources.factsSource,
        'common.view/relation-graph-source': semanticSources.relationGraphSource,
      },
      unsupportedFeatures: ['bank-list-serialization', 'source-writing'],
    }
  },
})

export const abiVersion = 1
export const createCodec = context => createInspectionCodec(definition, context)
