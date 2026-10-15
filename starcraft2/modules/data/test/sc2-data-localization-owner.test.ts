/** Data projections must use native Strings semantics while preserving winner-first dependencies. */
import { describe, expect, it } from 'vitest'
import { analyzeStarcraft2ResolvedData } from '../services/catalog/provider.js'
import { effectiveValue, parseSc2StringsOrdered } from '../../strings/shared/core/text-file.js'

const key = 'Unit/Name/Marine'
const path = 'enUS.SC2Data/LocalizedData/GameStrings.txt'

/** Supply the public Data analyzer with ordered layers and a typed localization field. */
function request(localizationDocuments: readonly {
  readonly rootId: string
  readonly path: string
  readonly text: string
  readonly locale: string
}[]) {
  return {
    workspaceId: 'workspace:localization-owner',
    gameId: 'blizzard/starcraft-2',
    documents: [{
      rootId: 'map', path: 'Base.SC2Data/GameData/UnitData.xml',
      text: `<Catalog><CUnit id="Marine"><Name value="${key}"/></CUnit></Catalog>`,
    }],
    localizationDocuments,
    usageDocuments: [],
    locales: ['enUS'],
    localizationKeys: [key],
    queries: [],
    maxDocuments: 8,
    maxTextBytes: 1_048_576,
    maxEntities: 2_048,
    maxDepth: 64,
    maxOutputBytes: 16 * 1_048_576,
    plannedDocumentCount: 1 + localizationDocuments.length,
    unresolvedRequirementIds: [],
  }
}

describe('SC2 Data uses the Strings owner', () => {
  it('resolves repeated keys to the native last line and keeps trailing value whitespace', async () => {
    const text = `\uFEFF${key}=Earlier\r\n// ${key}=Comment\r\n${key}=Marine: \r\n`
    const result = await analyzeStarcraft2ResolvedData(request([{ rootId: 'map', path, text, locale: 'enUS' }]))
    expect(result.localizedStrings).toEqual([expect.objectContaining({
      key, value: effectiveValue(parseSc2StringsOrdered(text), key),
      requestedLocale: 'enUS', resolvedLocale: 'enUS', fallback: false,
      source: expect.objectContaining({ rootId: 'map', path, documentIndex: 0 }),
    })])
    expect(result.localizedStrings[0]?.value).toBe('Marine: ')
    expect(result.diagnostics.filter((item: { code: string }) => item.code === 'blizzard.starcraft2/localization-key-duplicate'))
      .toEqual([expect.objectContaining({ severity: 'warning', fieldId: key })])
    expect(result.diagnostics.some((item: { severity: string }) => item.severity === 'error')).toBe(false)
    expect(result.complete).toBe(true)
  })

  it('keeps the mod above its dependency while the last line wins within each file', async () => {
    const result = await analyzeStarcraft2ResolvedData(request([
      { rootId: 'map', path, locale: 'enUS', text: `${key}=Old map\n${key}=Current map\n` },
      { rootId: 'liberty', path, locale: 'enUS', text: `${key}=Old dependency\n${key}=Current dependency\n` },
    ]))
    expect(result.localizedStrings).toEqual([expect.objectContaining({
      key, value: 'Current map', source: expect.objectContaining({ rootId: 'map', documentIndex: 0 }),
    })])
    expect(result.diagnostics.some((item: { severity: string }) => item.severity === 'error')).toBe(false)
    expect(result.complete).toBe(true)
  })

  it('preserves refusal diagnostics and physical line positions for invalid input', async () => {
    const result = await analyzeStarcraft2ResolvedData(request([{
      rootId: 'map', path, locale: 'enUS',
      text: `\uFEFF// Header\rMissing separator\r \t=No key\rBad\0Key=Refused\r${key}=Marine\r`,
    }]))
    expect(result.localizedStrings).toEqual([expect.objectContaining({ key, value: 'Marine' })])
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'blizzard.starcraft2/localization-line-malformed', message: expect.stringContaining(`${path}:2`) }),
      expect.objectContaining({ code: 'blizzard.starcraft2/localization-key-refused', message: expect.stringContaining(`${path}:3`) }),
      expect.objectContaining({ code: 'blizzard.starcraft2/localization-key-refused', message: expect.stringContaining(`${path}:4`) }),
    ]))
  })
})
