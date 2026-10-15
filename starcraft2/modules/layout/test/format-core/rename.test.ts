import { describe, expect, it } from 'vitest'
import {
  isSc2LayoutFilePath,
  renameSc2LayoutReferences,
  type Sc2LayoutRenameOptions,
} from '../../shared/format/rename.js'

const options: Sc2LayoutRenameOptions = {
  canon: namespace =>
    ['Button', 'Unit'].find(candidate => candidate.toLowerCase() === namespace.toLowerCase()),
  mapped: (namespace, id) => {
    if (namespace === 'Button' && id === 'Cancel') return 'MyCancel'
    if (namespace === 'Unit' && id === 'Marine') return 'Hero'
    return undefined
  },
}

describe('SC2Layout reference rename', () => {
  it('recognizes layout paths without making routing case-sensitive', () => {
    expect(isSc2LayoutFilePath('Base.SC2Data/UI/Layout/Foo.SC2Layout')).toBe(true)
    expect(isSc2LayoutFilePath('ui/layout/bar.sc2layout')).toBe(true)
    expect(isSc2LayoutFilePath('Triggers')).toBe(false)
  })

  it('rewrites entity and string-key references while preserving prefixes', () => {
    const xml = [
      '<Shortcut val="@Button/Hotkey/Cancel"/>',
      '<Texture val="@@Unit/Icon/Marine"/>',
      '<ClickSound val="*@Unit/Sound/Marine"/>',
      '<Text val="@Unit/Name/Marine"/>',
    ].join('')
    const result = renameSc2LayoutReferences(xml, {
      ...options,
      textKeyRenames: new Map([['Unit/Name/Marine', 'Unit/Name/Hero']]),
    })

    expect(result.patched).toBe(4)
    expect(result.xml).toBe(
      [
        '<Shortcut val="@Button/Hotkey/MyCancel"/>',
        '<Texture val="@@Unit/Icon/Hero"/>',
        '<ClickSound val="*@Unit/Sound/Hero"/>',
        '<Text val="@Unit/Name/Hero"/>',
      ].join(''),
    )
  })

  it('does not rewrite anchors, unrelated references, or scalar values', () => {
    const xml = '<Anchor relative="$parent/Foo"/><Width val="100"/><Texture val="@@UI/Bar"/>'
    expect(renameSc2LayoutReferences(xml, options)).toEqual({ xml, patched: 0 })
  })
})
