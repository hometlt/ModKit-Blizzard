/** Localized catalogs preserve every physical terminator while resolving native duplicate keys. */
import { expect, it } from 'vitest'
import { effectiveValue, parseSc2Strings, parseSc2StringsOrdered, serializeStringModel, setStringValue } from '../../shared/core/text-file.js'

it('reads BOM and mixed CR/CRLF/LF lines without losing entries or changing bytes', () => {
  const text = '\uFEFFName=Earlier\r// Comment\r\nName=Current \nOther=Final'
  const model = parseSc2StringsOrdered(text)
  expect(effectiveValue(model, 'Name')).toBe('Current ')
  expect(effectiveValue(model, 'Other')).toBe('Final')
  expect(model.lines.map(line => line.eol)).toEqual(['\r', '\r\n', '\n', ''])
  expect(serializeStringModel(model)).toBe(text)
})

it('uses the same last-line values for lookup and lossless CR-only catalogs', () => {
  const text = '\uFEFFName=Earlier\r// Name=Comment\rOther=Other \rName=Current \r'
  const model = parseSc2StringsOrdered(text)
  const values = parseSc2Strings(text)
  expect([...values]).toEqual([['Name', 'Current '], ['Other', 'Other ']])
  for (const [key, value] of values) expect(effectiveValue(model, key)).toBe(value)
  expect(serializeStringModel(model)).toBe(text)
})

it('normalizes lookup keys while retaining raw duplicate buckets and independent native edits', () => {
  const text = '\uFEFF Key =first \rKey=second\r\n Key =third=tail \n\t// Comment=ignored\r=empty-key-value \r\nКлюч/名=雪=λ \nBlank='
  const model = parseSc2StringsOrdered(new TextEncoder().encode(text))
  const lookup = parseSc2Strings(text)
  expect([...lookup]).toEqual([
    ['Key', 'third=tail '], ['', 'empty-key-value '], ['Ключ/名', '雪=λ '], ['Blank', ''],
  ])
  expect(model.bom).toBe(true)
  expect(model.lines.map(line => line.eol)).toEqual(['\r', '\r\n', '\n', '\r', '\r\n', '\n', ''])
  expect(model.index.get(' Key ')?.map(line => line.value)).toEqual(['first ', 'third=tail '])
  expect(effectiveValue(model, 'Key')).toBe('second')
  expect(serializeStringModel(model)).toBe(text)
  lookup.set('Key', 'lookup only edit')
  expect(effectiveValue(model, ' Key ')).toBe('third=tail ')
  expect(setStringValue(model, ' Key ', 'native edit ')).toBe(true)
  expect(model.index.get(' Key ')?.map(line => line.value)).toEqual(['first ', 'native edit '])
  expect(serializeStringModel(model)).toBe(text.replace(' Key =third=tail ', ' Key =native edit '))
})

it.each([
  { text: '', lines: 0 }, { text: '\uFEFF', lines: 0 },
  { text: '\r\n', lines: 1 }, { text: '// comment=ignored\r', lines: 1 },
])('keeps empty or comment-only catalogs complete: $text', ({ text, lines }) => {
  expect([...parseSc2Strings(text)]).toEqual([])
  const model = parseSc2StringsOrdered(text)
  expect(model.lines).toHaveLength(lines)
  expect(model.index.size).toBe(0)
  expect(serializeStringModel(model)).toBe(text)
})
