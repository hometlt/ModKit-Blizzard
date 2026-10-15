import { describe, it, expect } from 'vitest'
import { patchCatalogField } from '../../services/editing/catalog-field-patch.js'

const XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <!-- a comment with <LifeMax value="99"/> inside -->
    <CUnit id="Zergling" parent="ZERGLING">
        <LifeMax value="35"/>
    </CUnit>
    <CUnit id="Marine">
        <LifeMax value="45"/>
        <Speed value="2.25"/>
        <WeaponArray index="0" Link="GaussRifle"/>
        <WeaponArray index="1" Link="Flamethrower"/>
        <CardLayouts CardId="Root">
            <LayoutButtons index="0" Face="Stop" Row="2" Column="0"/>
        </CardLayouts>
    </CUnit>
    <CAbilEffectTarget id="Blink">
        <Cost>
            <Cooldown TimeUse="10"/>
        </Cost>
    </CAbilEffectTarget>
</Catalog>
`

/** Assert the patch changed only the expected substring. */
function expectSingleEdit(before: string, after: string, oldFrag: string, newFrag: string): void {
  expect(after).toBe(before.replace(oldFrag, newFrag))
}

describe('patchCatalogField', () => {
  it('replaces a value attribute in place (form 1)', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Marine', 'LifeMax', '55')
    expect(r.changed).toBe(true)
    expectSingleEdit(XML, r.text, '<LifeMax value="45"/>', '<LifeMax value="55"/>')
    // The other unit's LifeMax is untouched.
    expect(r.text).toContain('<LifeMax value="35"/>')
    // The comment decoy is untouched.
    expect(r.text).toContain('<LifeMax value="99"/> inside')
  })

  it('edits an indexed array entry attribute (form 2)', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Marine', 'WeaponArray.1.Link', 'PunisherGrenades')
    expect(r.changed).toBe(true)
    expectSingleEdit(
      XML,
      r.text,
      '<WeaponArray index="1" Link="Flamethrower"/>',
      '<WeaponArray index="1" Link="PunisherGrenades"/>',
    )
  })

  it('selects word-indexed entries (CardLayouts CardId is not the index — numeric position works)', () => {
    const r = patchCatalogField(
      XML,
      'CUnit',
      'Marine',
      'CardLayouts.0.LayoutButtons.0.Face',
      'Move',
    )
    expect(r.changed).toBe(true)
    expect(r.text).toContain('Face="Move"')
    expect(r.text).not.toContain('Face="Stop"')
  })

  it('edits a nested struct path leaf attribute (form 3)', () => {
    const r = patchCatalogField(XML, 'CAbilEffectTarget', 'Blink', 'Cost.0.Cooldown.TimeUse', '14')
    expect(r.changed).toBe(true)
    expectSingleEdit(XML, r.text, '<Cooldown TimeUse="10"/>', '<Cooldown TimeUse="14"/>')
  })

  it('is a byte-exact no-op when the value is unchanged', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Marine', 'LifeMax', '45')
    expect(r.changed).toBe(false)
    expect(r.text).toBe(XML)
  })

  it('inserts a missing field after the last existing field, matching indentation', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Marine', 'Sight', '9')
    expect(r.changed).toBe(true)
    expect(r.text).toContain('        <Sight value="9"/>\n    </CUnit>')
    // Everything before the insertion point is byte-identical.
    const idx = XML.indexOf('</CUnit>', XML.indexOf('id="Marine"'))
    expect(r.text.slice(0, idx)).toBe(XML.slice(0, idx))
  })

  it('inserts a nested missing chain when setting deep paths', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Zergling', 'CostResource.0.Minerals', '25')
    expect(r.changed).toBe(true)
    expect(r.text).toMatch(
      /<CostResource Minerals="25"\/>|<CostResource>\s*<Minerals value="25"\/>/,
    )
  })

  it('expands a self-closed entity when inserting into it', () => {
    const xml = '<Catalog>\n    <CUnit id="Empty"/>\n</Catalog>\n'
    const r = patchCatalogField(xml, 'CUnit', 'Empty', 'LifeMax', '10')
    expect(r.changed).toBe(true)
    expect(r.text).toContain('<CUnit id="Empty">')
    expect(r.text).toContain('<LifeMax value="10"/>')
    expect(r.text).toContain('</CUnit>')
  })

  it('clears a field by removing its line (newValue = null)', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Marine', 'Speed', null)
    expect(r.changed).toBe(true)
    expect(r.text).not.toContain('<Speed')
    expect(r.text).toBe(XML.replace('        <Speed value="2.25"/>\n', ''))
  })

  it('clearing a missing field is a no-op', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Marine', 'Sight', null)
    expect(r.changed).toBe(false)
    expect(r.text).toBe(XML)
  })

  it('reports a missing entity without touching the text', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Nope', 'LifeMax', '1')
    expect(r.changed).toBe(false)
    expect(r.reason).toContain('not found')
  })

  it('escapes attribute values', () => {
    const r = patchCatalogField(XML, 'CUnit', 'Marine', 'LifeMax', 'a"<&b')
    expect(r.text).toContain('value="a&quot;&lt;&amp;b"')
  })
})
