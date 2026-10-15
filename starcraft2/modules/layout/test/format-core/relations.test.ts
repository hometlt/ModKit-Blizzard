import { describe, expect, it } from 'vitest'
import { parseLayout } from '../../shared/layout-engine/sc2-layout-core/simple-parse/index.js'
import { buildSc2LayoutReferences, type Sc2LayoutRelationSource } from '../../shared/format/relations.js'

const source: Sc2LayoutRelationSource = {
  layouts: new Map([
    [
      'UI/Layout/Test.SC2Layout',
      parseLayout(
        [
          '<Desc><Frame type="Button" name="CloseButton">',
          '<Shortcut val="@Button/Hotkey/Cancel"/>',
          '<Texture val="@@UI/Foo"/>',
          '<ClickSound val="*@UI_Click"/>',
          '<Text val="@UI/SomeText"/>',
          '</Frame></Desc>',
        ].join(''),
      ),
    ],
  ]),
  namespaces: () => ['Button'],
  get: (namespace, id) =>
    namespace === 'Button' && id === 'Cancel' ? { namespace, id } : undefined,
}

describe('SC2Layout relations', () => {
  const references = buildSc2LayoutReferences(source)

  it('retains source/frame/property evidence and classifies presentation references', () => {
    expect(references).toHaveLength(4)
    expect(references.find(reference => reference.property === 'Texture')?.kind).toBe('asset')
    expect(references.find(reference => reference.property === 'ClickSound')).toMatchObject({
      kind: 'sound',
      raw: '*@UI_Click',
    })
    expect(references.find(reference => reference.property === 'Text')?.kind).toBe('string')
  })

  it('resolves catalog links only through the supplied namespace/entity source', () => {
    expect(references.find(reference => reference.property === 'Shortcut')).toMatchObject({
      kind: 'catalog',
      to: { namespace: 'Button', id: 'Cancel' },
    })
  })
})
