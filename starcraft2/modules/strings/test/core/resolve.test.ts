import { describe, it, expect } from 'vitest'
import { resolveStringValue, resolveFieldPath, validateStringRefs, type CatalogResolver } from '../../shared/core/resolve.js'
import { renderMarkupHtml } from '../../shared/core/render-html.js'

const localizedStrings = new Map<string, Map<string, string>>([
  ['GameHotkeys', new Map([
    ['UI/Hotkey/Name/TestPreferred', 'Preferred Hotkey Name'],
  ])],
  ['GameStrings', new Map([
    ['Unit/Name/Marine', 'Marine'],
    ['UI/Hotkey/Name/23/CameraFollow', 'Follow Current Selection'],
    ['UI/Hotkey/Name/TestPreferred', 'Fallback Hotkey Name'],
  ])],
])

const mod: CatalogResolver = {
  getResolved(ns, id) {
    const data: Record<string, Record<string, unknown>> = {
      'Behavior/Speed': { Modification: { MoveSpeedMultiplier: '1.5' } },
      'Weapon/Gauss': { Amount: '6', Period: '0.86' },
      'Unit/Marine': { Life: 45, Name: 'Unit/Name/Marine' },
      'Unit/Banshee': { EnergyRegenRate: '0.5625' },
      'Unit/OverseerSiegeMode': { Sight: 13 },
      'Unit/Overseer': { Sight: 11 },
      'Behavior/BansheeCloak': { Modification: { VitalRegenArray: { index: 'Energy', value: '-1.4765' } } },
      'Abil/Blink': { Cost: [{ Cooldown: { TimeUse: '10' } }] },
      'GameUI/Dflt': {
        HotkeyInfoArray: [
          { index: 'CameraFollow', Name: 'UI/Hotkey/Name/23/CameraFollow' },
          { index: 'PreferHotkeys', Name: 'UI/Hotkey/Name/TestPreferred' },
          { index: 'MissingHotkeyNameString', Name: 'UI/Hotkey/Name/MissingHotkeyNameString' },
        ],
      },
    }
    return data[`${ns}/${id}`]
  },
  getString(key, preferredFiles) {
    for (const fileName of preferredFiles ?? []) {
      const v = localizedStrings.get(fileName)?.get(key)
      if (v !== undefined) return v
    }
    for (const file of localizedStrings.values()) {
      const v = file.get(key)
      if (v !== undefined) return v
    }
    return undefined
  },
  getGalaxyVar(name) {
    return name === 'Lib_UntitledVariable' ? { type: 'int', value: 7 } : undefined
  },
  getTextConstant(name) {
    const constants: Record<string, string> = {
      ColorAttackInfo: 'ffff8a',
      ColorLinked: '#ColorAttackInfo',
    }
    return constants[name]
  },
  getTextStyle(name) {
    if (name !== 'TooltipStyle') return undefined
    return {
      name,
      attrs: { textcolor: '#ColorLinked', height: '18', styleflags: 'Bold|Italic|Shadow', shadowoffset: '2' },
      fonts: ['UI\\Fonts\\Eurostile-Bol.otf'],
    }
  },
}

describe('resolveFieldPath', () => {
  it('walks dot paths and coerces to number', () => {
    expect(resolveFieldPath({ a: { b: '2.5' } }, 'a.b')).toBe(2.5)
  })
  it('walks array indices', () => {
    expect(resolveFieldPath({ Cost: [{ v: '3' }, { v: '7' }] }, 'Cost[1].v')).toBe(7)
  })
  it('treats [0] on a singleton object as the object itself', () => {
    expect(resolveFieldPath({ Cost: { Cooldown: { TimeUse: '10' } } }, 'Cost[0].Cooldown.TimeUse')).toBe(10)
  })
  it('resolves indexed singleton objects by index name and vital number', () => {
    const root = { Modification: { VitalRegenArray: { index: 'Energy', value: '-1.4765' } } }
    expect(resolveFieldPath(root, 'Modification.VitalRegenArray[Energy]')).toBe(-1.4765)
    expect(resolveFieldPath(root, 'Modification.VitalRegenArray[2]')).toBe(-1.4765)
  })
  it('returns undefined for missing leaves', () => {
    expect(resolveFieldPath({ a: 1 }, 'a.b.c')).toBeUndefined()
  })
})

describe('resolveStringValue — arithmetic over catalog data', () => {
  it('evaluates (field - 1) * 100 with rounding', () => {
    const r = resolveStringValue('Speed +<d ref="(Behavior,Speed,Modification.MoveSpeedMultiplier-1)*100"/>%.', mod)
    expect(r.rendered).toBe('Speed +50%.')
  })

  it('applies precision option', () => {
    const r = resolveStringValue('DPS <d ref="Weapon,Gauss,Amount/Weapon,Gauss,Period" precision="1"/>', mod)
    expect(r.rendered).toBe('DPS 7.0') // 6 / 0.86 ≈ 6.98 → 7.0
  })

  it('evaluates multi-reference SC2 expressions without whitespace', () => {
    const r = resolveStringValue('<d ref="(Unit,OverseerSiegeMode,Sight/Unit,Overseer,Sight-1)*100"/>', mod)
    expect(r.rendered).toBe('18')
    expect(r.segments[0]).toMatchObject({ kind: 'ref', value: (13 / 11 - 1) * 100 })
  })

  it('resolves SC2 catalog paths with indexed children', () => {
    const r = resolveStringValue('<d ref="Abil,Blink,Cost[0].Cooldown.TimeUse"/> seconds.', mod)
    expect(r.rendered).toBe('10 seconds.')
  })

  it('evaluates SC2 vital-array singleton refs with numeric vital indices', () => {
    const r = resolveStringValue('<d ref="-1 * (Behavior,BansheeCloak,Modification.VitalRegenArray[2] + Unit,Banshee,EnergyRegenRate)" precision="1"/>', mod)
    expect(r.rendered).toBe('0.9')
    const seg = r.segments[0]
    expect(seg).toMatchObject({ kind: 'ref' })
    if (seg?.kind === 'ref') expect(seg.value).toBeCloseTo(0.914)
  })

  it('renders d time values as seconds instead of minutes', () => {
    const r = resolveStringValue('<d time="90"/> seconds', mod)
    expect(r.rendered).toBe('90 seconds')
    expect(r.segments[0]).toMatchObject({ kind: 'time', value: 90, text: '90' })
  })

  it('applies precision to d time seconds', () => {
    const r = resolveStringValue('<d time="Weapon,Gauss,Period" precision="2"/> seconds', mod)
    expect(r.rendered).toBe('0.86 seconds')
    expect(r.segments[0]).toMatchObject({ kind: 'time', value: 0.86, text: '0.86' })
  })

  it('resolves indexed SC2 paths when XML produced a singleton child object', () => {
    const resolver: CatalogResolver = {
      getResolved(ns, id) {
        return ns === 'Abil' && id === 'Blink' ? { Cost: { Cooldown: { TimeUse: '10' } } } : undefined
      },
    }
    const r = resolveStringValue('<d ref="Abil,Blink,Cost[0].Cooldown.TimeUse"/> seconds.', resolver)
    expect(r.rendered).toBe('10 seconds.')
  })

  it('resolves a stringref that points to another string key', () => {
    const r = resolveStringValue('<d stringref="Unit,Marine,Name"/>', mod)
    expect(r.rendered).toBe('Marine')
  })

  it('renders <n/> as a newline and keeps text', () => {
    expect(resolveStringValue('a<n/>b', mod).rendered).toBe('a\nb')
  })

  it('marks unresolved entity refs as errors without throwing', () => {
    const r = resolveStringValue('<d ref="Unit,Ghost,Life"/>', mod)
    const seg = r.segments[0]
    expect(seg?.kind).toBe('ref')
    if (seg?.kind === 'ref') expect(seg.error?.startsWith('entity-not-found')).toBe(true)
    expect(r.rendered).toBe('?')
  })

  it('shows $Token$ as a typed placeholder', () => {
    expect(resolveStringValue('x $AbilChargeCount:Stim$ y', mod).rendered).toBe('x ‹AbilChargeCount› y')
  })

  it('renders additional SC2 text tags to plain text placeholders', () => {
    const r = resolveStringValue('Press <k val="Marine,Attack,0,4" pre="[" post="]"/> <sp/><h/>now <d GameValue="MapName"/>', mod)
    expect(r.rendered).toBe('Press ‹[Marine,Attack,0,4]›  now MapName')
  })

  it('resolves hotkey tags through GameUI HotkeyInfoArray name strings', () => {
    const r = resolveStringValue('Press <k val="CameraFollow" pre="[" post="]"/>', mod)
    expect(r.rendered).toBe('Press ‹[Follow Current Selection]›')
    expect(r.segments[1]).toMatchObject({ kind: 'hotkey', val: 'CameraFollow', nameKey: 'UI/Hotkey/Name/23/CameraFollow' })
  })

  it('prefers GameHotkeys before GameStrings for hotkey name localization', () => {
    const r = resolveStringValue('<k val="PreferHotkeys"/>', mod)
    expect(r.rendered).toBe('‹Preferred Hotkey Name›')
  })

  it('inserts missing whitespace before hotkey previews', () => {
    const r = resolveStringValue('Press<k val="CameraFollow"/>', mod)
    expect(r.rendered).toBe('Press ‹Follow Current Selection›')
  })

  it('falls back to the hotkey index when the Name string is missing', () => {
    const r = resolveStringValue('<k val="MissingHotkeyNameString"/>', mod)
    expect(r.rendered).toBe('‹MissingHotkeyNameString›')
  })

  it('renders Player/GameValue d-tags and tilde runtime tokens', () => {
    const r = resolveStringValue('<d Player="~ID~" GameValue="PlayerColor"/> ~PLAYER~', mod)
    expect(r.rendered).toContain('PlayerColor')
    expect(r.rendered).toContain('PLAYER')
    expect(r.segments[0]).toMatchObject({ kind: 'dynamic', name: 'GameValue', value: 'PlayerColor', attrs: { Player: expect.stringContaining('ID') } })
    expect(r.segments[2]).toMatchObject({ kind: 'token', token: 'PLAYER' })
  })

  it('renders runtime-only d-ref functions as dynamic placeholders', () => {
    const r = resolveStringValue('<d ref="$BehaviorStackCount:AscendantSacrificeSelfBuff$"/> stacks', mod)
    expect(r.rendered).toBe('BehaviorStackCount stacks')
    expect(r.segments[0]).toMatchObject({ kind: 'dynamic', name: 'BehaviorStackCount' })
  })

  it('renders named runtime time values without marking them broken', () => {
    const r = resolveStringValue('<d Time="MissionTime"/>', mod)
    expect(r.rendered).toBe('MissionTime')
    expect(r.segments[0]).toMatchObject({ kind: 'time', text: 'MissionTime' })
  })

  it('falls back to the Galaxy variable name when no provider is available', () => {
    const resolver: CatalogResolver = { getResolved: (ns, id) => mod.getResolved(ns, id) }
    const r = resolveStringValue('<d GalaxyVar="Lib_UntitledVariable"/>', resolver)
    expect(r.rendered).toBe('Lib_UntitledVariable')
    expect(r.segments[0]).toMatchObject({ kind: 'galaxyvar', name: 'Lib_UntitledVariable', text: 'Lib_UntitledVariable' })
  })

  it('resolves Galaxy variable values when a provider is available', () => {
    const r = resolveStringValue('Value <d GalaxyVar="Lib_UntitledVariable"/>', mod)
    expect(r.rendered).toBe('Value 7')
    expect(r.segments[1]).toMatchObject({ kind: 'galaxyvar', name: 'Lib_UntitledVariable', text: '7', value: 7, type: 'int' })
  })
})

describe('validateStringRefs', () => {
  it('reports broken refs with ns/entity', () => {
    const issues = validateStringRefs([['K', '<d ref="Unit,Ghost,Life"/>']], mod)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ key: 'K', ns: 'Unit', entity: 'Ghost' })
  })
  it('passes valid refs', () => {
    expect(validateStringRefs([['K', '<d ref="Unit,Marine,Life"/>']], mod)).toHaveLength(0)
  })
})

describe('renderMarkupHtml', () => {
  it('escapes quotes in a style name used in HTML attributes', () => {
    const resolved = resolveStringValue(`<s val='Title" data-injected="yes'>Text</s>`, mod)
    expect(renderMarkupHtml(resolved.segments)).toContain('sc-style-Title&quot; data-injected=&quot;yes')
    expect(renderMarkupHtml(resolved.segments)).not.toContain(' data-injected="yes')
  })

  it('renders colors, refs, and newlines to HTML', () => {
    const r = resolveStringValue('<c val="ff0000ff">Hi</c><n/><d ref="Unit,Marine,Life"/>', mod)
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('<span style="color:#ff0000">Hi</span>')
    expect(html).toContain('<br>')
    expect(html).toContain('data-ref="1"')
    expect(html).toContain('>45<')
  })
  it('escapes text', () => {
    const r = resolveStringValue('a < b & c', mod)
    expect(renderMarkupHtml(r.segments)).toBe('a &lt; b &amp; c')
  })

  it('resolves FontStyles color constants used by color tags', () => {
    const r = resolveStringValue('<c val="#ColorAttackInfo">Can target ground units.</c>', mod)
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('style="color:#ffff8a"')
    expect(html).toContain('Can target ground units.')
  })

  it('resolves a bare-name color constant (no leading #), the common <c val=""> convention', () => {
    const r = resolveStringValue('<c val="ColorAttackInfo">Can target ground units.</c>', mod)
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('style="color:#ffff8a"')
  })

  it('resolves a chained bare-name constant that points at a #-prefixed one', () => {
    const r = resolveStringValue('<c val="ColorLinked">chained</c>', mod)
    expect(renderMarkupHtml(r.segments)).toContain('style="color:#ffff8a"')
  })

  it('leaves an unresolvable name as "inherit" rather than a bogus color', () => {
    const r = resolveStringValue('<c val="NotARealConstant">text</c>', mod)
    expect(renderMarkupHtml(r.segments)).toContain('style="color:inherit"')
  })

  it('renders FontStyles style records used by style tags', () => {
    const r = resolveStringValue('<s val="TooltipStyle">Tooltip</s>', mod)
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('color:#ffff8a')
    expect(html).toContain('font-size:18px')
    expect(html).toContain('font-weight:700')
    expect(html).toContain('font-style:italic')
    expect(html).toContain('font-family:&quot;Eurostile-Bol&quot;')
  })

  it('renders Galaxy variables as linkable spans', () => {
    const r = resolveStringValue('<d GalaxyVar="Lib_UntitledVariable"/>', mod)
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('class="sc-galaxyvar"')
    expect(html).toContain('data-galaxy-var="Lib_UntitledVariable"')
    expect(html).toContain('title="int Lib_UntitledVariable"')
    expect(html).toContain('>7<')
  })
  it('renders additional text tags to styled HTML spans', () => {
    const r = resolveStringValue('<w><h>Use</h> <k val="CommandButton08" pre="[" post="]"/></w><sp/><d GameValue="MapName"/>', mod)
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('class="sc-nowrap"')
    expect(html).toContain('class="sc-highlight"')
    expect(html).toContain('<span class="sc-token sc-hotkey">‹[CommandButton08]›</span>')
    expect(html).toContain('&nbsp;')
    expect(html).toContain('class="sc-dynamic"')
  })

  it('accepts computed d-tags inside color attributes', () => {
    const r = resolveStringValue("<c val=\"[d Player='~ID~' GameValue='PlayerColor'/]\">~PLAYER~</c> wants to attack <c val=\"[d Player='~ENEMYID~' GameValue='PlayerColor'/]\">~ENEMY~</c>!", mod)
    expect(r.rendered).toContain('PLAYER')
    expect(r.rendered).toContain('ENEMY')
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('class="sc-dynamic-attr"')
    expect(html).toContain('computed GameValue')
    expect(html).toContain('Player=')
    expect(html).toContain('PLAYER')
  })

  it('renders image metadata from SC2 image attrs', () => {
    const r = resolveStringValue('<img path="Assets\\Textures\\blank.dds" width="24" height="24" alignment="UpperMiddle" texcoords="0,1,1,0" color="100,255,0,0"/>', mod)
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('width:24px')
    expect(html).toContain('height:24px')
    expect(html).toContain('vertical-align:middle')
    expect(html).toContain('background-color:rgb(255 0 0 / 0.39215686274509803)')
    expect(html).toContain('texcoords=0,1,1,0')
  })

  it('renders uppercase SC2 IMG tags as lazy image requests', () => {
    const r = resolveStringValue('<IMG path="Assets\\Textures\\tutorialmouseleftbuttondown.dds" alignment="absolutemiddle"/> To Target Area', mod)
    const html = renderMarkupHtml(r.segments)
    expect(html).toContain('data-img="Assets\\Textures\\tutorialmouseleftbuttondown.dds"')
    expect(html).toContain('vertical-align:middle')
    expect(r.rendered).toBe(' To Target Area')
  })
})
