import { describe, it, expect } from 'vitest'
import { parseLayout } from '../../../../shared/layout-engine/sc2-layout-core/simple-parse/index.js'
import { layoutToHtml } from '../../../../shared/layout-engine/sc2-layout-core/html.js'

const render = (xml: string, options?: Parameters<typeof layoutToHtml>[1]): string =>
  layoutToHtml(parseLayout(xml), options)

describe('layoutToHtml', () => {
  it('produces a self-contained HTML document (no external assets or scripts)', () => {
    const html = render('<Desc><Frame type="Frame" name="Root"/></Desc>', { fileName: 'root.sc2layout' })
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html.endsWith('</html>')).toBe(true)
    // nothing that would trip a strict webview CSP / leak the network
    expect(html).not.toContain('<script')
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
    // the fileName is surfaced in the header
    expect(html).toContain('root.sc2layout')
  })

  it('renders the frame tree with collapsible <details> and a type badge', () => {
    const html = render('<Desc><Frame type="Button" name="OK"/></Desc>')
    expect(html).toContain('<details')
    expect(html).toContain('lx-name')
    expect(html).toContain('OK')
    expect(html).toContain('<span class="lx-type">Button</span>')
  })

  it('nests child frames and defaults unnamed frames to (unnamed)', () => {
    const html = render('<Desc><Frame type="Frame" name="Parent"><Frame type="Label"/></Frame></Desc>')
    // one <details> per frame — parent + child
    expect(html.match(/<details/g)?.length).toBe(2)
    expect(html).toContain('(unnamed)')
    expect(html).toContain('Label')
  })

  it('honours the collapsed option (omits the open attribute)', () => {
    const open = render('<Desc><Frame type="Frame" name="A"/></Desc>')
    const collapsed = render('<Desc><Frame type="Frame" name="A"/></Desc>', { collapsed: true })
    expect(open).toContain('<details class="lx-frame" open>')
    expect(collapsed).toContain('<details class="lx-frame">')
    expect(collapsed).not.toContain('lx-frame" open')
  })

  it('shows template and file-override badges', () => {
    const html = render('<Desc><Frame type="Frame" name="T" template="Std/Tip" file="Other"/></Desc>')
    expect(html).toContain('lx-tmpl')
    expect(html).toContain('Std/Tip')
    expect(html).toContain('lx-fileref')
    expect(html).toContain('file: Other')
  })

  it('renders an anchors table with side/relative/pos/offset (and defaults)', () => {
    const html = render(
      '<Desc><Frame type="Frame" name="A"><Anchor side="Top" relative="$parent" pos="Min" offset="4"/></Frame></Desc>',
    )
    expect(html).toContain('lx-anchors')
    expect(html).toContain('Top')
    expect(html).toContain('$parent')
    expect(html).toContain('Min')
    expect(html).toContain('>4<')
  })

  it('classifies reference values by property kind', () => {
    const html = render(
      '<Desc><Frame type="Frame" name="A">' +
        '<Texture val="@@UI/Icon"/>' +
        '<Sound val="@Snd/Click"/>' +
        '<Style val="@Fnt/Body"/>' +
        '<Text val="@Str/Hello"/>' +
        '</Frame></Desc>',
    )
    expect(html).toContain('lx-ref-asset')
    expect(html).toContain('lx-ref-sound')
    expect(html).toContain('lx-ref-style')
    expect(html).toContain('lx-ref-string')
    expect(html).toContain('@@UI/Icon')
  })

  it('treats a *@-prefixed value as a reference', () => {
    const html = render('<Desc><Frame type="Frame" name="A"><Text val="*@Str/Ref"/></Frame></Desc>')
    expect(html).toContain('lx-ref')
    expect(html).toContain('*@Str/Ref')
  })

  it('renders constants and reports counts in the header', () => {
    const html = render(
      '<Desc><Constant name="MyColor" val="ffffff"/><Frame type="Frame" name="A"><Frame type="Label"/></Frame></Desc>',
    )
    expect(html).toContain('Constants')
    expect(html).toContain('MyColor')
    expect(html).toContain('ffffff')
    // 2 frames (parent + child), 1 constant
    expect(html).toContain('<b>2</b> frames')
    expect(html).toContain('<b>1</b> constants')
  })

  it('shows the empty-frames placeholder', () => {
    const html = render('<Desc/>')
    expect(html).toContain('No frames.')
    expect(html).toContain('<b>0</b> frames')
  })

  it('HTML-escapes names and values (no markup injection)', () => {
    const html = render('<Desc><Frame type="Frame" name="A&lt;B"><Text val="&lt;x&gt;"/></Frame></Desc>')
    expect(html).toContain('A&lt;B')
    expect(html).toContain('&lt;x&gt;')
    // the escaped value must not re-introduce a raw tag
    expect(html).not.toContain('<x>')
  })
})



