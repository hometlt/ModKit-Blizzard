import { describe, expect, it } from 'vitest'
import {
  documentInfoDependencies,
  documentInfoPreloads,
  documentInfoValues,
  parseDocumentInfo,
  writeDocumentInfo,
} from '../../../dist/modules/mod/codecs/document-metadata/core/index.js'

describe('DocumentInfo', () => {
  it('parses values, nested fields, and canonical round-trips', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<DocInfo>
    <ModType>
        <Value>Interface</Value>
    </ModType>
    <Dependencies>
        <Value>bnet:Liberty (Mod)/0.0/999,file:Mods/Liberty.SC2Mod</Value>
        <Value>file:Mods\\Void.SC2Mod</Value>
    </Dependencies>
    <Screenshot>
        <File>
            <Value>Assets\\Textures\\shot.dds</Value>
        </File>
        <CaptionId>
            <Value>42</Value>
        </CaptionId>
    </Screenshot>
    <Preload>
        <Value>GameLink:Unit;Viking</Value>
        <Value>AssetFile;Assets\\Textures\\icons.dds</Value>
    </Preload>
</DocInfo>
`
    const parsed = parseDocumentInfo(xml)

    expect(documentInfoValues(parsed, 'ModType')).toEqual(['Interface'])
    expect(documentInfoDependencies(parsed)).toEqual([
      'bnet:Liberty (Mod)/0.0/999,file:Mods/Liberty.SC2Mod',
      'file:Mods\\Void.SC2Mod',
    ])
    expect(documentInfoValues(parsed, 'Screenshot/File')).toEqual(['Assets\\Textures\\shot.dds'])
    expect(documentInfoPreloads(parsed)).toEqual([
      'GameLink:Unit;Viking',
      'AssetFile;Assets\\Textures\\icons.dds',
    ])

    expect(documentInfoPreloads(parseDocumentInfo(writeDocumentInfo(parsed)))).toEqual(documentInfoPreloads(parsed))
  })
})
