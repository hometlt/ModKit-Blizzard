import { describe, it, expect } from 'vitest'
import { parseLayout } from '../../shared/layout-engine/sc2-layout-core/simple-parse/index.js'
import {
  buildSc2LayoutReferences as buildLayoutRelations,
  type Sc2LayoutRelationSource as LayoutRelationSource,
} from '../../shared/format/relations.js'

const testPanel = parseLayout(
  [
    '<Desc>',
    '<Frame type="Button" name="CloseButton">',
    '<Shortcut val="@Button/Hotkey/Cancel"/>',
    '<Texture val="@@UI/Foo"/>',
    '<ClickSound val="*@UI_Click"/>',
    '<Text val="@UI/SomeText"/>',
    '</Frame></Desc>',
  ].join('\n'),
)

const mod: LayoutRelationSource = {
  layouts: new Map([['UI/Layout/Test.SC2Layout', testPanel]]),
  namespaces: () => ['Button'],
  get: (ns, id) =>
    ns === 'Button' && id === 'Cancel' ? { namespace: 'Button', id: 'Cancel' } : undefined,
}

describe('buildLayoutRelations', () => {
  const refs = buildLayoutRelations(mod)

  it('captures each reference with file/frame/property', () => {
    expect(refs.length).toBe(4)
    for (const r of refs) {
      expect(r.file).toContain('Test')
      expect(r.frame).toContain('CloseButton')
      expect(r.property.length).toBeGreaterThan(0)
    }
  })

  it('classifies kinds by property', () => {
    const by = (p: string) => refs.find(r => r.property === p)!
    expect(by('Texture').kind).toBe('asset')
    expect(by('ClickSound').kind).toBe('sound')
    expect(by('Text').kind).toBe('string')
  })

  it('resolves a catalog entity when the trailing segment matches', () => {
    const shortcut = refs.find(r => r.property === 'Shortcut')!
    expect(shortcut.kind).toBe('catalog')
    expect(shortcut.to).toEqual({ namespace: 'Button', id: 'Cancel' })
  })

  it('preserves the *@ literal value verbatim', () => {
    expect(refs.find(r => r.property === 'ClickSound')!.raw).toBe('*@UI_Click')
  })
})
