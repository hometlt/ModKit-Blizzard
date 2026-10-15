import { expect, it } from 'vitest'
import { createSc2DataLanguageProvider } from '../providers/language/src/language.js'

const provider = createSc2DataLanguageProvider()
it.each([
  ['<', 'document'],
  ['<Catalog><', 'document'],
  ['<Catalog><CUnit id="Marine"><', 'document'],
  ['<Catalog><CUnit id="Marine"><AddedOnArray ', 'document'],
  ['<Catalog><CUnit id="Marine"><EditorFlags index="', 'document'],
  ['<Catalog><CUnit id="Marine"><EditorFlags index="NoPlacement" value="', 'document'],
  ['<Catalog><CUnit id="Marine"><Collide value="Ground,', 'document'],
  ['<Catalog><CUnit id="Marine"><Collide value="Ground;', 'document'],
  ['<Catalog><CUnit id="Marine" parent="', 'workspace'],
  ['<Catalog><CUnit id="Marine" parent="Template" ', 'workspace'],
  ['<Catalog><CUnit id="Marine"><Race value="', 'workspace'],
  ['<Catalog><CUnit id="Marine"><UnitIcon value="', 'workspace'],
])('selects the required context for %s', async (text, expected) => {
  const context = await provider.completionContext?.({
    document: {
      uri: 'memory://UnitData.xml',
      languageId: 'sc2-data',
      version: 1,
      text,
    },
    position: { line: 0, character: text.length },
  })
  expect(context).toBe(expected)
})
