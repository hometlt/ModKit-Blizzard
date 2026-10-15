import { expect, it } from 'vitest'
import { createSc2DataLanguageProvider } from '../providers/language/src/language.js'

const provider = createSc2DataLanguageProvider()
it.each([
  ['UnitData.xml', '<Catalog>\n<', 'CUnit'],
  ['ActorData.xml', '<Catalog>\n<', 'CActor'],
  ['UnitData.xml', '<Catalog>\n<CUn', 'CUnit'],
  ['UnitData.xml', '<Catalog><CUnit id="Marine">\n<', 'LifeMax'],
  ['UnitData.xml', '<Catalog><CUnit id="Marine"><AddedOnArray ', 'index'],
  ['UnitData.xml', '<Catalog><CUnit id="Marine"><EditorFlags index="', 'NoPlacement'],
  ['UnitData.xml', '<Catalog><CUnit id="Marine"><EditorFlags index="NoPlacement" value=', '1'],
  ['UnitData.xml', '<Catalog><CUnit id="Marine"><EditorFlags index="NoPlacement" value="', '0'],
  ['UnitData.xml', '<Catalog><CUnit id="Marine"><Race value=', 'Terr'],
  ['UnitData.xml', '<Catalog><CUnit id="Marine"><LifeMax value="45"/><', 'AbilArray'],
])('completes unfinished %s at the end of %s', async (file, text, expected) => {
  const lines = text!.split('\n')
  const result = await provider.completion!({
    document: { uri: `memory://${file}`, languageId: 'sc2-data', version: 1, text: text! },
    workspaceDocuments: [{ uri: 'memory://RaceData.xml', languageId: 'sc2-data', version: 1,
      text: '<Catalog><CRace id="Terr"/></Catalog>' }], maxResults: 1000, maxDocuments: 10,
    position: { line: lines.length - 1, character: lines.at(-1)!.length },
  })
  expect(result.items.map(item => item.label)).toContain(expected)
})

it('validates indexed flags without reporting healthy stock syntax as invalid', async () => {
  for (const [index, value, valid] of [['NoPlacement', '1', true], ['UnknownFlag', '1', false], ['NoPlacement', 'bad', false]] as const) {
    const result = await provider.analyze({
      document: { uri: 'memory://UnitData.xml', languageId: 'sc2-data', version: 1,
        text: `<Catalog><CUnit id="Marine"><EditorFlags index="${index}" value="${value}"/></CUnit></Catalog>` },
      workspaceDocuments: [],
    })
    expect(result.diagnostics.some(item => item.code === 'sc2-data/invalid-value')).toBe(!valid)
  }
})
