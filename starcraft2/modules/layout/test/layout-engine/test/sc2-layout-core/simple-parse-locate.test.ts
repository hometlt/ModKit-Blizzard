import { describe, it, expect } from 'vitest'
import { locateFrame } from '../../../../shared/layout-engine/sc2-layout-core/simple-parse/locate.js'

const XML = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Desc>
    <Constant name="Gap" val="5"/>
    <!-- a comment mentioning <Frame name="Decoy"> which must be ignored -->
    <Frame type="Frame" name="Root">
        <Anchor relative="$parent"/>
        <Frame type="Image" name="Icon">
            <Texture val="Assets/x.dds"/>
        </Frame>
        <Frame type="Frame" name="Row" template="Foo/Bar"/>
        <Frame type="Frame" name="Row2">
            <Frame type="Label" name="Icon">
                <Text val="a &gt; b"/>
                <Tooltip val="{$parent/@Text}"/>
            </Frame>
        </Frame>
    </Frame>
    <Frame type="Frame" name="Second">
        <Frame type="Frame" name="Icon"/>
    </Frame>
</Desc>`

function lineOf(text: string, needle: string): number {
  const off = text.indexOf(needle)
  return text.slice(0, off).split('\n').length - 1
}

describe('locateFrame', () => {
  it('finds a top-level frame', () => {
    const loc = locateFrame(XML, ['Root'])
    expect(loc?.line).toBe(lineOf(XML, '<Frame type="Frame" name="Root">'))
  })

  it('finds nested frames by path, not by first name match', () => {
    // Root/Row2/Icon, not Root/Icon and not Second/Icon
    const loc = locateFrame(XML, ['Root', 'Row2', 'Icon'])
    expect(loc?.line).toBe(lineOf(XML, '<Frame type="Label" name="Icon">'))
  })

  it('distinguishes sibling subtrees with equal leaf names', () => {
    const a = locateFrame(XML, ['Root', 'Icon'])
    const b = locateFrame(XML, ['Second', 'Icon'])
    expect(a?.line).toBe(lineOf(XML, '<Frame type="Image" name="Icon">'))
    expect(b?.line).toBe(lineOf(XML, '<Frame type="Frame" name="Icon"/>'))
  })

  it('handles self-closing frames as path targets', () => {
    const loc = locateFrame(XML, ['Root', 'Row'])
    expect(loc?.line).toBe(lineOf(XML, 'name="Row" template'))
  })

  it('ignores frame-like text inside comments', () => {
    expect(locateFrame(XML, ['Decoy'])).toBeUndefined()
  })

  it('is case-insensitive like SC2 desc resolution', () => {
    expect(locateFrame(XML, ['root', 'row2', 'icon'])?.line)
      .toBe(lineOf(XML, '<Frame type="Label" name="Icon">'))
  })

  it('returns undefined for missing paths and empty input', () => {
    expect(locateFrame(XML, ['Root', 'Nope'])).toBeUndefined()
    expect(locateFrame(XML, [])).toBeUndefined()
    expect(locateFrame('', ['Root'])).toBeUndefined()
  })

  it('survives raw > inside quoted attribute values', () => {
    const tricky = `<Desc><Frame type="Frame" name="A"><FormatText val="x > y <Frame name='fake'"/><Frame type="Frame" name="B"/></Frame></Desc>`
    const loc = locateFrame(tricky, ['A', 'B'])
    expect(loc).toBeDefined()
    expect(tricky.slice(loc!.offset)).toMatch(/^<Frame type="Frame" name="B"/)
  })

  it('reports 0-based line/character of the opening <', () => {
    const loc = locateFrame(XML, ['Root'])!
    const abs = XML.split('\n')[loc.line]!
    expect(abs.slice(loc.character)).toMatch(/^<Frame type="Frame" name="Root">/)
  })
})



