/**
 * `classifyField` regression: file-path links (Icon/texture/etc.) must be
 * flagged `isFileLink`. These derive from an unexported `CFile extends CLink`
 * (`static link = 'File'`) in @modkitx/data-processing/sc2-schema, which is a *different* class from
 * the exported scalar `CFile` — so classification must key off the link
 * namespace (`link === 'File'`), not an `instanceof CFile` identity check.
 *
 * Fields are discovered off the real schema (not hardcoded) so the test tracks
 * schema evolution rather than a specific class/field name.
 */
import { describe, it, expect } from 'vitest'
import { getClassFields, classifyField, type FieldInfo } from '../../../shared/catalog-engine/sc2-catalog/index.js'

/** First (class, field) across candidate classes whose classified info matches. */
function findField(classes: string[], pred: (i: FieldInfo) => boolean): FieldInfo | undefined {
  for (const className of classes) {
    const schema = getClassFields(className)
    if (!schema) continue
    for (const ft of Object.values(schema)) {
      const info = classifyField(ft)
      if (pred(info)) return info
    }
  }
  return undefined
}

const IMAGE_CLASSES = ['CButton', 'CUnit', 'CTacticalUI', 'CRace']
const REF_CLASSES = ['CUnit', 'CWeapon', 'CAbilEffectInstant', 'CEffectDamage']

describe('classifyField file-link classification', () => {
  it('classifies an image/asset link (Icon, texture, …) as a File link', () => {
    const info = findField(IMAGE_CLASSES, i => i.kind === 'link' && i.linkNamespace === 'File')
    expect(info, 'expected a File-namespace link field in the schema').toBeDefined()
    expect(info).toMatchObject({ kind: 'link', linkNamespace: 'File', isFileLink: true })
    expect(info!.isTextLink).toBeFalsy()
  })

  it('does not mark a non-file entity link as a File link', () => {
    const info = findField(
      REF_CLASSES,
      i =>
        i.kind === 'link' &&
        !!i.linkNamespace &&
        i.linkNamespace !== 'File' &&
        i.linkNamespace !== 'String',
    )
    expect(info, 'expected a non-file link field in the schema').toBeDefined()
    expect(info!.isFileLink).toBeFalsy()
  })
})
