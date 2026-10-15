import { describe, it, expect } from 'vitest'
import { tokenizeStringValue, tokenizeStringKey, type StringToken, type KeyToken } from '../../shared/core/tokenize.js'

/** Reconstruct the value from tokens to prove full, gap-free coverage. */
function cover(value: string, toks: StringToken[]): string {
  let out = ''
  let pos = 0
  for (const t of toks) {
    expect(t.start).toBe(pos) // contiguous, non-overlapping
    out += value.slice(t.start, t.end)
    pos = t.end
  }
  expect(pos).toBe(value.length)
  return out
}

describe('tokenizeStringValue', () => {
  it('covers the whole value contiguously', () => {
    const samples = [
      'Marine',
      'Damage: <d ref="Weapon,Gauss,Amount" precision="1"/>',
      '<c val="ff0000ff">Red</c> normal',
      'Charges: $AbilChargeCount:Stim$ left',
      'Ref: <d stringref="Unit,Marine,Life"/>',
      'Speed +<d ref="(Behavior,AccelZone,Mod.Mult-1)*100"/>%',
      // nested <c val="[d Player='~ID~' GameValue='PlayerColor'/]">…</c> — dynamic
      // per-player color, two sibling color spans, tildes both in the attribute
      // value and in the tag's own text content.
      "<c val=\"[d Player='~ID~' GameValue='PlayerColor'/]\">~PLAYER~</c> wants to attack <c val=\"[d Player='~ENEMYID~' GameValue='PlayerColor'/]\">~ENEMY~</c>!",
    ]
    for (const s of samples) expect(cover(s, tokenizeStringValue(s))).toBe(s)
  })

  it('tokenizes the tilde tokens in a nested dynamic-color tag\'s text content as "token" (not the attribute value)', () => {
    const value = "<c val=\"[d Player='~ID~' GameValue='PlayerColor'/]\">~PLAYER~</c>"
    const toks = tokenizeStringValue(value)
    const playerTok = toks.find((t) => t.scope === 'token' && value.slice(t.start, t.end) === '~PLAYER~')
    expect(playerTok).toBeDefined()
    // the ~ID~ inside the attribute's bracket expression is part of the opaque
    // attribute-value string, not separately classified as a token span
    expect(toks.some((t) => t.scope === 'token' && value.slice(t.start, t.end) === '~ID~')).toBe(false)
  })

  it('treats an unrecognized tag like <None> as plain text, not a tag token', () => {
    const value = 'Value: <None> after'
    const toks = tokenizeStringValue(value)
    expect(toks.every((t) => t.scope === 'text')).toBe(true)
    expect(cover(value, toks)).toBe(value)
  })

  it('classifies a <d ref> tag into punctuation, attribute, string and operators', () => {
    const value = '<d ref="A,B,C*2"/>'
    const toks = tokenizeStringValue(value)
    const scopes = new Set(toks.map((t) => t.scope))
    expect(scopes.has('punctuation')).toBe(true)
    expect(scopes.has('ref')).toBe(true)
    expect(scopes.has('attribute')).toBe(true)
    expect(scopes.has('operator')).toBe(true)
    const op = toks.find((t) => t.scope === 'operator')!
    expect(value.slice(op.start, op.end)).toBe('*')
  })

  it('marks stringref, galaxyvar and hotkey tags distinctly', () => {
    expect(tokenizeStringValue('<d stringref="U,M,L"/>').some((t) => t.scope === 'stringref')).toBe(true)
    expect(tokenizeStringValue('<d GalaxyVar="V"/>').some((t) => t.scope === 'galaxyvar')).toBe(true)
    expect(tokenizeStringValue('<k val="A"/>').some((t) => t.scope === 'hotkey')).toBe(true)
  })

  it('treats $Tok$ / ~Name~ as token spans and a trailing /// as a comment', () => {
    const toks = tokenizeStringValue('Hi $Player$ ~ID~ /// note')
    expect(toks.filter((t) => t.scope === 'token').length).toBe(2)
    const comment = toks.find((t) => t.scope === 'comment')!
    expect('Hi $Player$ ~ID~ /// note'.slice(comment.start)).toBe('/// note')
  })

  it('treats ~Name1|Name2~ as a single token span', () => {
    const value = 'Order ~transport~ to Unload All at ~targetPoint|TargetPoint~'
    const toks = tokenizeStringValue(value)
    expect(cover(value, toks)).toBe(value)
    const alt = toks.find((t) => t.scope === 'token' && value.slice(t.start, t.end) === '~targetPoint|TargetPoint~')
    expect(alt).toBeDefined()
  })

  it('treats %Name% as a token span, but a literal "%" (e.g. "+25%") as plain text', () => {
    const value = 'Workers: %current%/%ideal% (+25% bonus)'
    const toks = tokenizeStringValue(value)
    expect(cover(value, toks)).toBe(value)
    const tokens = toks.filter((t) => t.scope === 'token')
    expect(tokens.map((t) => value.slice(t.start, t.end))).toEqual(['%current%', '%ideal%'])
  })
})

describe('tokenizeStringKey', () => {
  function cover(key: string, toks: KeyToken[]): string {
    let out = ''
    let pos = 0
    for (const t of toks) { expect(t.start).toBe(pos); out += key.slice(t.start, t.end); pos = t.end }
    expect(pos).toBe(key.length)
    return out
  }

  it('covers the whole key and splits catalog/property/objectid on "/"', () => {
    const key = 'Race/Name/Zerg'
    const toks = tokenizeStringKey(key)
    expect(cover(key, toks)).toBe(key)
    expect(toks.map((t) => t.scope)).toEqual(['namespace', 'punctuation', 'property', 'punctuation', 'objectid'])
  })

  it('treats a two-segment key as namespace/objectid (no property)', () => {
    const toks = tokenizeStringKey('Race/Zerg')
    expect(toks.map((t) => t.scope)).toEqual(['namespace', 'punctuation', 'objectid'])
  })

  it('joins multi-part property paths under the "property" scope', () => {
    const toks = tokenizeStringKey('Unit/CardLayouts/Tooltip/Marine')
    expect(toks.map((t) => t.scope)).toEqual(['namespace', 'punctuation', 'property', 'punctuation', 'property', 'punctuation', 'objectid'])
  })

  it('a key with no "/" is a single namespace-scoped span', () => {
    expect(tokenizeStringKey('Malformed')).toEqual([{ start: 0, end: 9, scope: 'namespace' }])
  })
})
