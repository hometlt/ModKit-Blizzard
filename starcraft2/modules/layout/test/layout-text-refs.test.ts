/**
 * The GameStrings key scanner a catalog rename uses must find every key the layout schema types as
 * `Text`. The schema is the authority; the scanner exists only because a catalog provider cannot
 * load the schema in a browser worker.
 */
import { describe, expect, it } from 'vitest'
import { layoutTextReferences } from '../../../shared/language/layout-text-refs.js'
import { layoutSchemaTextValues, layoutStore } from '../shared/schema-index.js'

export function schemaKeySpans(uri: string, text: string): string[] {
  return layoutSchemaTextValues(layoutStore([{ uri, text }]), uri).flatMap(value => {
    const prefix = /^@@?/u.exec(value.value)?.[0].length ?? 0
    const key = value.value.slice(prefix)
    return prefix === 0 || key === '' || key.startsWith('@') ? [] : [`${value.start + prefix}:${key}`]
  })
}

export const scannerKeySpans = (text: string): string[] =>
  layoutTextReferences(text).map(item => `${item.start}:${item.key}`)

const LAYOUT = [
  '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
  '<Desc>',
  '  <Frame type="Label" name="Title">',
  '    <Text val="@UI/Title"/>',
  '    <Tooltip val="@@UI/TitleTip"/>',
  '    <Style val="@UI/NotAKey"/>',
  '  </Frame>',
  '  <Frame type="Button" name="Go">',
  '    <Tooltip val="literal text"/>',
  '    <Shortcut val="@UI/Hotkey"/>',
  '  </Frame>',
  '  <Frame type="Frame" name="Owner">',
  '    <StateGroup name="G">',
  '      <State name="S">',
  '        <Action type="SetProperty" frame="$parent/Title" Text="@UI/StateText"/>',
  '      </State>',
  '    </StateGroup>',
  '  </Frame>',
  '</Desc>',
  '',
].join('\n')

describe('layout GameStrings key references', () => {
  it('finds every schema-typed Text key, plus SetProperty text the schema cannot type', () => {
    const uri = 'file:///fixture/Hud.SC2Layout'
    const schema = schemaKeySpans(uri, LAYOUT)
    const scanner = scannerKeySpans(LAYOUT)
    expect(schema.length).toBeGreaterThan(0)
    expect(scanner).toEqual(expect.arrayContaining(schema))
    expect(scanner.map(item => item.split(':')[1])).toEqual([
      'UI/Title',
      'UI/TitleTip',
      'UI/StateText',
    ])
  })
})
