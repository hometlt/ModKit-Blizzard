import { describe, expect, it } from 'vitest'

import { readDeclaredDependencies } from '../content-sources/document-dependencies.js'

/** A DocumentHeader names each dependency as the editor wrote it, NUL terminated. */
const documentHeader = (...entries: string[]): Uint8Array =>
  Buffer.concat([
    Buffer.from('H2CS\u0000\u0000\u0000\u0000', 'binary'),
    ...entries.map(entry => Buffer.concat([Buffer.from(entry, 'utf8'), Buffer.of(0)])),
    Buffer.from('\u0000\u0000DocInfo/Name', 'binary'),
  ])

describe('what a document says it depends on', () => {
  it('reads the published documents it names, in order, with the local file beside each', () => {
    const declared = readDeclaredDependencies(
      documentHeader(
        'bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod',
        'bnet:SCEvo_MultiArtAssets/0.0/244126,file:Mods/Assets.SC2Mod',
      ),
    )

    expect(declared).toEqual([
      { name: 'Void (Mod)', version: '0.0/999', file: 'Mods/Void.SC2Mod' },
      { name: 'SCEvo_MultiArtAssets', version: '0.0/244126', file: 'Mods/Assets.SC2Mod' },
    ])
  })

  it('reports nothing for a document that depends on nothing published', () => {
    expect(readDeclaredDependencies(documentHeader('file:Mods/Local.SC2Mod'))).toEqual([])
    expect(readDeclaredDependencies(new Uint8Array(0))).toEqual([])
  })
})
