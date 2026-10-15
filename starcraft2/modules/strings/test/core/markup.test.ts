import { describe, it, expect } from 'vitest'
import { parseMarkup, serializeMarkup, markupCatalogRefs, validateMarkupSyntax, findColorSwatches, findSegmentAt } from '../../shared/core/markup.js'

describe('parseMarkup', () => {
  it('round-trips arbitrary values byte-exact', () => {
    const samples = [
      'Marine',
      "Speed +<d ref=\"(Behavior,AccelZone,Modification.MoveSpeedMultiplier-1)*100\"/>%.",
      'Line one<n/>Line two',
      'Damage: <d ref="Weapon,Gauss,Amount" precision="1"/>',
      '<c val="ff0000ff">Red</c> normal <s val="Bold">bold</s>',
      'Charges: $AbilChargeCount:Stim$ left',
      'Ref: <d stringref="Unit,Marine,Life"/>',
      'Var: <d GalaxyVar="Lib_UntitledVariable"/>',
      '<w><d ref="Effect,X,Amount"/> damage</w>',
      'Press <k val="Marine,Attack,0,4"/> then <h/>Attack',
      '<lang rule="plural">PLAYER,PLAYERS</lang>',
      '<a name="WebsiteUrl" href="https://example.test">site</a>',
      '<ignore d="strip" c="ignore"><c val="ff0000">red</c></ignore>',
      '<c val="ff0000">red</c><ignore/><c val="ff0000">plain</c>',
      '<sp/><d GameValue="MapName"/><d Score="APMAverage" Player="1"/><d UnitCount="Marine"/>',
      "<d Player='~ID~' GameValue='PlayerColor'/>",
      '<c val="[d Player=\'~ID~\' GameValue=\'PlayerColor\'/]">~PLAYER~</c>',
      '<ul indent="2" text="*"><li/>Baneling gains damage</ul>',
    ]
    for (const s of samples) expect(serializeMarkup(parseMarkup(s))).toBe(s)
  })

  it('classifies segment kinds', () => {
    const segs = parseMarkup('A<n/><d ref="X,Y,Z"/><c val="00ff00ff">G</c>$Tok:a:b$ ~Name~')
    expect(segs.map((s) => s.kind)).toEqual(['text', 'newline', 'ref', 'color', 'token', 'text', 'token'])
    const color = segs[3]
    expect(color?.kind).toBe('color')
    if (color?.kind === 'color') expect(color.children[0]?.kind).toBe('text')
    const tok = segs[4]
    expect(tok?.kind).toBe('token')
    if (tok?.kind === 'token') {
      expect(tok.token).toBe('Tok')
      expect(tok.args).toEqual(['a', 'b'])
    }
    const tilde = segs[6]
    expect(tilde).toMatchObject({ kind: 'token', token: 'Name', syntax: 'tilde' })
  })

  it('parses ~Name1|Name2~ alternative parameter names in a tilde token', () => {
    const s = 'Auto-reveal ~visibilityRegion|Region~ for player ~player~'
    const segs = parseMarkup(s)
    expect(serializeMarkup(segs)).toBe(s)
    const tok = segs.find((seg) => seg.kind === 'token' && seg.raw === '~visibilityRegion|Region~')
    expect(tok).toMatchObject({ kind: 'token', token: 'visibilityRegion', args: ['Region'], syntax: 'tilde' })
  })

  it('parses %Name% runtime variables like %current%/%ideal%/%colorValue%', () => {
    const s = 'Workers: <c val="%colorValue%">%current%/%ideal%</c>'
    const segs = parseMarkup(s)
    expect(serializeMarkup(segs)).toBe(s)
    const color = segs[1]
    expect(color?.kind).toBe('color')
    if (color?.kind === 'color') {
      expect(color.color).toBe('%colorValue%') // not a hex color; findColorSwatches skips it
      expect(color.children[0]).toMatchObject({ kind: 'token', token: 'current', syntax: 'percent' })
      expect(color.children[2]).toMatchObject({ kind: 'token', token: 'ideal', syntax: 'percent' })
    }
  })

  it('treats a bare "%" (e.g. a literal percentage) as ordinary text, not a token attempt', () => {
    const s = 'Speed +25% Attack Speed, +10% armor'
    const segs = parseMarkup(s)
    expect(segs).toEqual([{ kind: 'text', text: s }])
  })

  it('parses stringref into ns/entity/field', () => {
    const seg = parseMarkup('<d stringref="Unit,Marine,Life"/>')[0]
    expect(seg).toMatchObject({ kind: 'stringref', ns: 'Unit', entity: 'Marine', field: 'Life' })
  })

  it('parses GalaxyVar into a global variable reference', () => {
    const seg = parseMarkup('<d GalaxyVar="Lib_UntitledVariable"/>')[0]
    expect(seg).toMatchObject({ kind: 'galaxyvar', name: 'Lib_UntitledVariable' })
  })

  it('parses <img> tags with path/width/height and round-trips', () => {
    const s = '<img path="Assets\\Textures\\blank.dds" width="24" height="24" alignment="middle" texcoords="0,1,1,0" color="100,255,0,0"/>X'
    const segs = parseMarkup(s)
    expect(segs[0]).toMatchObject({ kind: 'img', path: 'Assets\\Textures\\blank.dds', width: '24', height: '24' })
    const img = segs[0]
    expect(img?.kind).toBe('img')
    if (img?.kind === 'img') {
      expect(img.attrs['alignment']).toBe('middle')
      expect(img.attrs['texcoords']).toBe('0,1,1,0')
      expect(img.attrs['color']).toBe('100,255,0,0')
    }
    expect(serializeMarkup(segs)).toBe(s)
  })

  it('parses <ul>/<li> lists and round-trips', () => {
    const s = '<ul><li>one</li><li>two</li></ul>'
    const segs = parseMarkup(s)
    expect(segs[0]?.kind).toBe('list')
    expect(serializeMarkup(segs)).toBe(s)
  })

  it('a self-closing <li/> absorbs the text up to the next <li/> as its own children', () => {
    const s = '<ul indent="2" text="*"><li/>Baneling gains damage<li/>Roach gains armor</ul>'
    const ul = parseMarkup(s)[0]
    expect(ul?.kind).toBe('list')
    if (ul?.kind !== 'list') throw new Error('expected list')
    expect(ul.children).toHaveLength(2)
    expect(ul.children[0]).toMatchObject({ kind: 'list', tag: 'li' })
    expect(ul.children[1]).toMatchObject({ kind: 'list', tag: 'li' })
    if (ul.children[0]?.kind === 'list') expect(ul.children[0].children).toEqual([{ kind: 'text', text: 'Baneling gains damage' }])
    if (ul.children[1]?.kind === 'list') expect(ul.children[1].children).toEqual([{ kind: 'text', text: 'Roach gains armor' }])
    expect(serializeMarkup(parseMarkup(s))).toBe(s)
  })

  it('a self-closing <li/> absorbs content up to </ul> when it is the last item', () => {
    const s = '<ul><li/>Only item</ul>'
    const ul = parseMarkup(s)[0]
    expect(ul?.kind).toBe('list')
    if (ul?.kind !== 'list') throw new Error('expected list')
    expect(ul.children).toEqual([{ kind: 'list', tag: 'li', children: [{ kind: 'text', text: 'Only item' }], raw: '<li/>Only item' }])
  })

  it('parses additional SC2 text tags from localized strings', () => {
    const segs = parseMarkup('<w>A<sp/><h/>B<k val="CommandButton08" pre="[" post="]"/></w><d GameValue="MapName"/><ignore/>')
    expect(segs[0]).toMatchObject({ kind: 'container', tag: 'w' })
    expect(segs[1]).toMatchObject({ kind: 'dynamic', name: 'GameValue', value: 'MapName' })
    expect(segs[2]).toMatchObject({ kind: 'container', tag: 'ignore', children: [] })
    const wrap = segs[0]
    expect(wrap?.kind).toBe('container')
    if (wrap?.kind === 'container') {
      expect(wrap.children.map((s) => s.kind)).toEqual(['text', 'space', 'highlight', 'text', 'hotkey'])
    }
  })

  it('parses Player/GameValue d-tags and single-quoted dynamic color attrs', () => {
    const segs = parseMarkup("<d Player='~ID~' GameValue='PlayerColor'/><c val=\"[d Player='~ID~' GameValue='PlayerColor'/]\">~PLAYER~</c>")
    expect(segs[0]).toMatchObject({ kind: 'dynamic', name: 'GameValue', value: 'PlayerColor' })
    const color = segs[1]
    expect(color).toMatchObject({ kind: 'color', color: "[d Player='~ID~' GameValue='PlayerColor'/]" })
    if (color?.kind === 'color') expect(color.children[0]).toMatchObject({ kind: 'token', token: 'PLAYER', syntax: 'tilde' })
  })

  it('handles a real cost-tooltip mix of img/color/ref', () => {
    const s = '<img path="@@UI/ResourceIconNoBackground0" width="24" height="24"/><c val="FF0000"><d ref="Unit,Fuse,CostResource[Minerals]"/></c>'
    const segs = parseMarkup(s)
    expect(segs.map((x) => x.kind)).toEqual(['img', 'color'])
    expect(serializeMarkup(segs)).toBe(s)
  })

  it('handles nested color spans', () => {
    const s = '<c val="ff0000ff">a<c val="00ff00ff">b</c>c</c>'
    expect(serializeMarkup(parseMarkup(s))).toBe(s)
  })

  it('treats unrecognized tags as plain text, not a markup segment', () => {
    const s = 'text <unknowntag attr="1"/> more'
    const segs = parseMarkup(s)
    expect(segs.every((seg) => seg.kind === 'text')).toBe(true)
    expect(segs.some((seg) => seg.kind === 'unknown')).toBe(false)
    expect(serializeMarkup(segs)).toBe(s)
  })

  it('treats a bare "<None>" as literal text without throwing', () => {
    const s = 'Value: <None> after'
    const segs = parseMarkup(s)
    expect(segs).toEqual([{ kind: 'text', text: s }])
    expect(serializeMarkup(segs)).toBe(s)
  })

  it('treats a stray ">" outside markup as ordinary text', () => {
    const s = '5 > 3 and <d ref="A,B,C"/>'
    const segs = parseMarkup(s)
    expect(segs[0]).toMatchObject({ kind: 'text', text: '5 > 3 and ' })
    expect(segs[1]).toMatchObject({ kind: 'ref' })
    expect(serializeMarkup(segs)).toBe(s)
  })
})

describe('markupCatalogRefs', () => {
  it('extracts every embedded reference (including multi-ref expressions)', () => {
    const refs = markupCatalogRefs('<d ref="Weapon,A,Amount + Weapon,B,Amount"/> and <d stringref="Unit,M,Life"/>')
    expect(refs).toEqual([
      { ns: 'Weapon', entity: 'A', field: 'Amount' },
      { ns: 'Weapon', entity: 'B', field: 'Amount' },
      { ns: 'Unit', entity: 'M', field: 'Life' },
    ])
  })

  it('extracts the embedded entity from a $UpgradeEffectArrayValue$ token', () => {
    const refs = markupCatalogRefs('$UpgradeEffectArrayValue:UpgradeX:Weapon,Gauss,Amount$')
    expect(refs).toContainEqual({ ns: 'Weapon', entity: 'Gauss', field: 'Amount' })
  })
})

describe('findColorSwatches', () => {
  it('locates a raw hex color and its exact offset', () => {
    const value = 'Damage <c val="ff0000ff">50</c> per hit'
    const [swatch] = findColorSwatches(value)
    expect(swatch).toBeDefined()
    expect(value.slice(swatch!.start, swatch!.end)).toBe('ff0000ff')
    expect(swatch!.hex).toBe('ff0000ff')
  })

  it('accepts 6-digit (no alpha) and 8-digit (with alpha) hex', () => {
    expect(findColorSwatches('<c val="ff0000">x</c>')[0]!.hex).toBe('ff0000')
    expect(findColorSwatches('<c val="ff0000ff">x</c>')[0]!.hex).toBe('ff0000ff')
  })

  it('skips named color constants (not literal hex)', () => {
    expect(findColorSwatches('<c val="ColorAttackInfo">x</c>')).toEqual([])
  })

  it('finds nested color swatches inside another color span', () => {
    const value = '<c val="ff0000">a<c val="00ff00">b</c>c</c>'
    const swatches = findColorSwatches(value)
    expect(swatches.map((s) => s.hex)).toEqual(['ff0000', '00ff00'])
    for (const s of swatches) expect(value.slice(s.start, s.end)).toBe(s.hex)
  })

  it('skips a dynamic per-player color ([d Player=.../]) — no literal hex to preview', () => {
    const value = "<c val=\"[d Player='~ID~' GameValue='PlayerColor'/]\">~PLAYER~</c> wants to attack <c val=\"[d Player='~ENEMYID~' GameValue='PlayerColor'/]\">~ENEMY~</c>!"
    expect(findColorSwatches(value)).toEqual([])
  })
})

describe('validateMarkupSyntax operations', () => {
  const codes = (v: string) => validateMarkupSyntax(v).map((i) => i.code)

  it('accepts well-formed expressions', () => {
    expect(codes('<d ref="(Behavior,AccelZone,Modification.MoveSpeedMultiplier-1)*100"/>')).not.toContain('malformed-operation')
    expect(codes('<d ref="Weapon,A,Amount + Weapon,B,Amount"/>')).not.toContain('malformed-operation')
    expect(codes('<d ref="Effect,X,Amount"/>')).not.toContain('malformed-operation')
    expect(codes('<d ref=""/>')).not.toContain('malformed-operation')
  })

  it('flags unbalanced parentheses', () => {
    expect(codes('<d ref="(Weapon,A,Amount*2"/>')).toContain('malformed-operation')
  })

  it('flags a dangling / doubled operator', () => {
    expect(codes('<d ref="Weapon,A,Amount *"/>')).toContain('malformed-operation')
    expect(codes('<d ref="Weapon,A,Amount * / 2"/>')).toContain('malformed-operation')
  })

  it('does not flag ~Name1|Name2~ alternative parameter names as malformed', () => {
    expect(codes('Order ~transport~ to Unload All at ~targetPoint|TargetPoint~ then despawn at ~despawnPoint~')).not.toContain('malformed-tilde-token')
  })

  it('still flags a genuinely malformed tilde token', () => {
    expect(codes('~Name|~')).toContain('malformed-tilde-token')
    expect(codes('~Name|Bad Name~')).toContain('malformed-tilde-token')
  })
})

describe('findSegmentAt', () => {
  it('finds a <d ref> tag at any offset within its span', () => {
    const value = 'Damage: <d ref="Weapon,Gauss,Amount"/> total'
    const start = value.indexOf('<d ref')
    const end = start + '<d ref="Weapon,Gauss,Amount"/>'.length
    for (let off = start; off < end; off++) {
      const at = findSegmentAt(value, off)
      expect(at?.segment.kind).toBe('ref')
      expect(at?.start).toBe(start)
      expect(at?.end).toBe(end)
    }
  })

  it('returns undefined for an offset in plain text', () => {
    const value = 'Damage: <d ref="Weapon,Gauss,Amount"/> total'
    expect(findSegmentAt(value, 2)).toBeUndefined()
    expect(findSegmentAt(value, value.length - 2)).toBeUndefined()
  })

  it('finds a stringref/galaxyvar tag', () => {
    const sr = '<d stringref="Unit,Marine,Life"/>'
    expect(findSegmentAt(sr, 5)?.segment).toMatchObject({ kind: 'stringref', ns: 'Unit', entity: 'Marine', field: 'Life' })
    const gv = '<d GalaxyVar="Lib_Untitled"/>'
    expect(findSegmentAt(gv, 5)?.segment).toMatchObject({ kind: 'galaxyvar', name: 'Lib_Untitled' })
  })

  it('finds a ref nested inside a <c> color tag, with an offset relative to the whole value', () => {
    const value = '<c val="ff0000">Life: <d ref="Unit,Ghost,Life"/></c>'
    const innerStart = value.indexOf('<d ref')
    const at = findSegmentAt(value, innerStart + 3)
    expect(at?.segment.kind).toBe('ref')
    expect(at?.start).toBe(innerStart)
  })
})
