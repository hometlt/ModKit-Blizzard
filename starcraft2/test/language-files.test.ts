/**
 * GameData is recognised by its `<Catalog>` root wherever it sits (parity plan 1.25): the
 * extension's own manifest declares the association, the host's one classifier reads it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeExtensionManifest } from '@modkit/sdk'
import { languageFileAssociationFor } from '@modkit/host/language'

describe('SC2 language file associations', () => {
  it('routes any .xml with a Catalog root to sc2-data and leaves other XML alone', async () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    const { manifest, diagnostics } = await normalizeExtensionManifest({ packageJson })
    expect(diagnostics.filter(item => item.severity === 'error')).toEqual([])
    const associations = manifest?.languageFiles ?? []
    const head = String.fromCharCode(0xfeff) + '<?xml version="1.0" encoding="utf-8"?>\r\n<!-- custom catalog -->\r\n<Catalog>\r\n'
    expect(languageFileAssociationFor(associations, 'Mods/My.SC2Mod/Custom/MyData.xml', head)?.languageId).toBe('sc2-data')
    expect(languageFileAssociationFor(associations, 'Mods/My.SC2Mod/Base.SC2Data/UI/Layouts/X.xml', '<Desc>')).toBeUndefined()
  })
})
