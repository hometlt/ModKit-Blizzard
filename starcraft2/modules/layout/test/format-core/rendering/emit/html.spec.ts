import { describe, it, expect } from 'vitest'
import { emitHtml } from '../../../../shared/format/rendering/emit/html.js'
import type { DisplayItem, DisplayList } from '../../../../shared/format/rendering/model/display.js'

function listOf(...items: DisplayItem[]): DisplayList {
  return { items, canvas: { width: 100, height: 100 }, diagnostics: [] }
}

const base = {
  frameType: 'Image',
  descPath: ['A'],
  rect: { x: 0, y: 0, width: 10, height: 10 },
  visible: true,
  opacity: 1,
  diagnostics: [],
} as const

describe('emitHtml — LayerColor tint', () => {
  it('fills an image that has NO asset (the connector-line idiom)', () => {
    const html = emitHtml(
      listOf({ ...base, kind: 'image', tint: { r: 250, g: 60, b: 60, a: 1 } }),
      { document: false },
    )
    expect(html).toContain('background-color:rgba(250, 60, 60, 1)')
  })

  it('does NOT fill an image that has an asset — the tint is a multiply there', () => {
    // A solid background under a texture shows through its transparent margins: the
    // tech-tree arrows are a ~14px shaft inside a 30px texture, and filling the frame
    // put a solid rectangle behind every arrow. The host bakes the multiply into pixels.
    const html = emitHtml(
      listOf({
        ...base,
        kind: 'image',
        asset: { kind: 'alias', value: 'UI/TechTreeVerticalArrowTail' },
        tint: { r: 250, g: 60, b: 60, a: 1 },
      }),
      { document: false },
    )
    expect(html).not.toContain('background-color')
    expect(html).toContain('data-asset="alias:UI/TechTreeVerticalArrowTail"')
  })
})
