import { describe, expect, it } from 'vitest'
import { openReforgedLayers, parseFileAliases, reforgedLayers, reforgedOverlays } from '../src/game/reforged.js'

/**
 * Warcraft III Reforged keeps the game in nested `.w3mod` manifests of one CASC storage; the view
 * stacks the overlays the game reads (HD over the base, the locale over each) and answers a path
 * the way a model writes it — `.blp`/`.tif`, or an old path `filealiases.json` moved — with the
 * stored `.dds`.
 */
function storage(files: Record<string, string>) {
  const reads: string[] = []
  return {
    reads,
    entries: Object.keys(files).map(path => ({ path, size: files[path]!.length })),
    async read(path: string) {
      reads.push(path)
      const text = files[path]
      if (text === undefined) throw new Error(`no ${path}`)
      return new TextEncoder().encode(text)
    },
    async close() {},
  }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('Warcraft III Reforged overlays', () => {
  it('stacks HD over the base and the locale over each, highest first', () => {
    expect(reforgedOverlays()).toEqual([
      'war3.w3mod:_hd.w3mod:_locales/enus.w3mod:',
      'war3.w3mod:_hd.w3mod:',
      'war3.w3mod:_locales/enus.w3mod:',
      'war3.w3mod:',
    ])
    expect(reforgedOverlays({ artSet: 'sd', locale: 'ruRU' })).toEqual(['war3.w3mod:_locales/ruru.w3mod:', 'war3.w3mod:'])
  })

  it('lists each overlay by its own paths, without nested manifests, tilesets or other locales', () => {
    const layers = reforgedLayers(
      storage({
        'war3.w3mod:units/human/footman/footman.mdx': 'sd',
        'war3.w3mod:_hd.w3mod:units/human/footman/footman.mdx': 'hd',
        'war3.w3mod:_hd.w3mod': 'manifest',
        'war3.w3mod:_hd.w3mod:_teen.w3mod:units/human/footman/footman.mdx': 'teen',
        'war3.w3mod:_hd.w3mod:_locales/dede.w3mod:x.flac': 'de',
        'war3.w3mod:_tilesets/a.w3mod:terrainart/a.dds': 'tile',
        'x86_64/warcraft iii.exe': 'exe',
      }),
    )
    expect(layers.map(layer => [layer.id, layer.entries.map(entry => entry.path)])).toEqual([
      ['war3.w3mod:_hd.w3mod:_locales/enus.w3mod', []],
      ['war3.w3mod:_hd.w3mod', ['units/human/footman/footman.mdx']],
      ['war3.w3mod:_locales/enus.w3mod', []],
      ['war3.w3mod', ['units/human/footman/footman.mdx']],
    ])
  })

  it('answers a model’s texture path with the stored .dds, through the file aliases too', async () => {
    const files = storage({
      'war3.w3mod:filealiases.json': JSON.stringify([{ src: 'SharedModels/Dust3.blp', dest: 'Textures/Dust3.blp' }]),
      'war3.w3mod:textures/black32.dds': 'black',
      'war3.w3mod:textures/dust3.dds': 'dust',
      'war3.w3mod:_hd.w3mod:units/human/footman/human_footman_main_diffuse.dds': 'diffuse',
    })
    const [, hd, , base] = await openReforgedLayers(files)
    expect(hd!.resolve('Units\\Human\\Footman\\Human_Footman_Main_Diffuse.tif')).toBe('units/human/footman/human_footman_main_diffuse.dds')
    expect(base!.resolve('Textures\\Black32.blp')).toBe('textures/black32.dds')
    expect(base!.resolve('SharedModels/Dust3.blp')).toBe('textures/dust3.dds')
    expect(base!.resolve('Textures/Missing.blp')).toBeUndefined()
    expect(await base!.lookup!('Textures/Black32.blp')).toEqual({ path: 'Textures/Black32.blp', size: 5 })
    expect(text(await base!.read('Textures/Black32.blp', 1 << 20))).toBe('black')
    expect(files.reads.at(-1)).toBe('war3.w3mod:textures/black32.dds')
  })

  it('reads filealiases.json as the game’s old-path → new-path table', () => {
    const aliases = parseFileAliases('[{"src":"A\\\\B.blp","dest":"C/D.blp"},{"src":"a/b.blp","dest":"other"},{"x":1}]')
    expect([...aliases]).toEqual([['a/b.blp', 'c/d.blp']])
  })
})
