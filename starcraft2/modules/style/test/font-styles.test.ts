import { describe, it, expect } from 'vitest'
import { createResolvedStyleSnapshot, parseFontStyles } from '../shared/font-styles.js'
import { stringResolverFromWorkspace } from '../../../shared/language/string-workspace.js'

describe('parseFontStyles position capture', () => {
  it('captures the line/character of each <Style> tag against the original text', () => {
    const xml = [
      '<Constant name="C" val="1"/>', // line 0
      '<Style name="Alpha" template="C"/>', // line 1
      '<Style name="Beta"/>', // line 2
    ].join('\n')
    const sheet = parseFontStyles(xml)
    expect(sheet.styles.get('Alpha')?.position).toEqual({ line: 1, character: 0 })
    expect(sheet.styles.get('Beta')?.position).toEqual({ line: 2, character: 0 })
  })

  it('keeps positions correct when a comment precedes a style (offset bug regression)', () => {
    const xml = [
      '<Constant name="C" val="1"/>', // line 0
      '<!-- a multi', // line 1
      '     line comment -->', // line 2
      '<Style name="Gamma"/>', // line 3
    ].join('\n')
    const sheet = parseFontStyles(xml)
    // Before the fix, comment-stripping shifted this to an earlier line.
    expect(sheet.styles.get('Gamma')?.position).toEqual({ line: 3, character: 0 })
  })

  it('ignores <Style> tags that appear inside a comment', () => {
    const xml = ['<!-- <Style name="Ghost"/> -->', '<Style name="Real"/>'].join('\n')
    const sheet = parseFontStyles(xml)
    expect(sheet.styles.has('Ghost')).toBe(false)
    expect(sheet.styles.get('Real')?.position).toEqual({ line: 1, character: 0 })
  })

  it('still parses attributes correctly (no regression in style resolution)', () => {
    const sheet = parseFontStyles('<Style name="Alpha" font="Bold"/>')
    expect(sheet.styles.get('Alpha')?.attrs['font']).toBe('Bold')
  })

  it('excludes a commented-out <CodepointRange> inside a FontGroup body', () => {
    const xml = [
      '<FontGroup name="G">',
      '    <CodepointRange min="0" max="127" font="Latin"/>',
      '    <!-- <CodepointRange min="128" max="255" font="Phantom"/> -->',
      '</FontGroup>',
    ].join('\n')
    const group = parseFontStyles(xml).fontGroups.get('G')
    expect(group?.ranges).toHaveLength(1)
    expect(group?.ranges[0]?.['font']).toBe('Latin')
  })
})

describe('resolved Style snapshot', () => {
  const base = {
    uri: 'memory://dep/FontStyles.SC2Style',
    version: 2,
    text: [
      '<StyleFile>',
      '<Constant name="Color" val="112233"/>',
      '<Constant name="FontPath" val="UI\\Fonts\\Base.ttf"/>',
      '<FontGroup name="Main"><CodepointRange font="#FontPath"/></FontGroup>',
      '<Style name="Base" font="Main" textcolor="#Color" height="12"/>',
      '</StyleFile>',
    ].join('\n'),
  }
  const mod = {
    uri: 'memory://mod/FontStyles.SC2Style',
    version: 7,
    text: [
      '<StyleFile>',
      '<Constant name="Color" val="aabbcc"/>',
      '<Style name="Title" template="Base" height="18"/>',
      '</StyleFile>',
    ].join('\n'),
  }

  it('merges in supplied order and resolves inherited constants, styles and fonts with provenance', () => {
    const snapshot = createResolvedStyleSnapshot([base, mod], {
      contextRevision: 'mod-context:42',
      complete: true,
    })
    expect(snapshot.resolveConstant('Color')).toBe('aabbcc')
    expect(snapshot.resolveStyle('Title')).toMatchObject({
      attrs: { font: 'Main', textcolor: 'aabbcc', height: '18', template: 'Base' },
      fonts: ['UI\\Fonts\\Base.ttf'],
      contextRevision: 'mod-context:42',
      complete: true,
      provenance: [
        { uri: mod.uri, version: 7, kind: 'style', name: 'Title' },
        { uri: base.uri, version: 2, kind: 'style', name: 'Base' },
        { uri: base.uri, version: 2, kind: 'font-group', name: 'Main' },
      ],
    })
  })

  it('keeps contexts isolated and refuses cyclic inheritance', () => {
    const left = createResolvedStyleSnapshot([base], { contextRevision: 'left', complete: true })
    const right = createResolvedStyleSnapshot([
      { uri: 'memory://right/FontStyles.SC2Style', text: '<Style name="Base" height="99"/>' },
    ], { contextRevision: 'right', complete: false })
    expect(left.resolveStyle('Base')?.attrs['height']).toBe('12')
    expect(right.resolveStyle('Base')?.attrs['height']).toBe('99')
    expect(right.resolveStyle('Base')?.complete).toBe(false)

    const cycle = createResolvedStyleSnapshot([{ uri: 'memory://cycle', text: '<Style name="A" template="B"/><Style name="B" template="A"/>' }])
    expect(cycle.resolveStyle('A')).toBeUndefined()
  })

  it('does not choose conflicting unordered definitions by transport order', () => {
    const first = {
      uri: 'memory://first',
      text: '<Constant name="Shared" val="111111"/><Style name="Base" height="10"/><Style name="OnlyFirst" height="7"/>',
    }
    const second = {
      uri: 'memory://second',
      text: '<Constant name="Shared" val="222222"/><Style name="Base" height="20"/><Style name="Child" template="OnlyFirst"/>',
    }
    const resolve = (sources: typeof first[]) => createResolvedStyleSnapshot(sources, {
      authoritativeOrder: false,
      complete: false,
    })
    const forward = resolve([first, second])
    const reverse = resolve([second, first])

    for (const snapshot of [forward, reverse]) {
      expect(snapshot.resolveConstant('Shared')).toBeUndefined()
      expect(snapshot.resolveStyle('Base')).toBeUndefined()
      expect(snapshot.resolveStyle('OnlyFirst')?.attrs['height']).toBe('7')
      expect(snapshot.resolveStyle('Child')?.attrs['height']).toBe('7')
    }
  })

  it('keeps the Strings workspace result invariant when transport order reverses', () => {
    const documents = [
      { uri: 'memory://a.SC2Style', languageId: 'sc2-style', version: 1, text: '<Style name="Conflict" height="10"/><Style name="Parent" height="7"/>' },
      { uri: 'memory://b.SC2Style', languageId: 'sc2-style', version: 2, text: '<Style name="Conflict" height="20"/><Style name="Child" template="Parent"/>' },
    ]
    const forward = stringResolverFromWorkspace(documents)
    const reverse = stringResolverFromWorkspace([...documents].reverse())
    expect(forward.getTextStyle?.('Conflict')).toBeUndefined()
    expect(reverse.getTextStyle?.('Conflict')).toBeUndefined()
    expect(forward.getTextStyle?.('Child')?.attrs['height']).toBe('7')
    expect(reverse.getTextStyle?.('Child')?.attrs['height']).toBe('7')
  })

  it('normalizes attribute order and follows ambiguous constant dependencies', () => {
    const left = {
      uri: 'memory://left',
      text: [
        '<Constant name="Indirect" val="#Conflict"/>',
        '<Constant name="Conflict" val="111111"/>',
        '<Style name="Same" height="12" textcolor="ffffff"/>',
        '<FontGroup name="Fonts"><CodepointRange min="0" font="#Indirect"/></FontGroup>',
        '<Style name="UsesIndirect" textcolor="#Indirect"/>',
        '<Style name="UsesFont" font="Fonts"/>',
      ].join('\n'),
    }
    const right = {
      uri: 'memory://right',
      text: [
        '<Constant name="Conflict" val="222222"/>',
        '<Style textcolor="ffffff" name="Same" height="12"/>',
        '<FontGroup name="Fonts"><CodepointRange font="#Indirect" min="0"/></FontGroup>',
      ].join('\n'),
    }
    const snapshot = createResolvedStyleSnapshot([left, right], {
      authoritativeOrder: false,
      complete: true,
    })
    expect(snapshot.complete).toBe(false)
    expect(snapshot.resolveStyle('Same')?.attrs).toMatchObject({ height: '12', textcolor: 'ffffff' })
    expect(snapshot.resolveConstant('Indirect')).toBeUndefined()
    expect(snapshot.resolveStyle('UsesIndirect')).toBeUndefined()
    expect(snapshot.resolveStyle('UsesFont')).toBeUndefined()
  })

  it('preserves ordered resolution when a template is missing', () => {
    const snapshot = createResolvedStyleSnapshot([
      { uri: 'memory://ordered', text: '<Style name="Child" template="External" height="9"/>' },
    ], { authoritativeOrder: true, complete: true })
    expect(snapshot.resolveStyle('Child')?.attrs).toMatchObject({ template: 'External', height: '9' })
    expect(snapshot.complete).toBe(true)
  })
})
