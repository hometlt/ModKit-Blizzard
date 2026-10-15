import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { extension } from './war3-harness.js'

/**
 * A classic installation's archives as one tree: the base archive and the patch that overrides one
 * of its files, written by the MPQ library, read back through the content-source module.
 */
const { createContentSources } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href
)) as typeof import('../dist/game/content-sources.js')

const text = (value: string) => new TextEncoder().encode(value)
const decoded = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
let installation = ''

beforeAll(async () => {
  installation = await mkdtemp(join(tmpdir(), 'modkit-war3-sources-'))
  // Installers vary the case of these names; the chain is matched without it.
  await writeFile(
    join(installation, 'War3.mpq'),
    encodeFreshMpq([
      { path: 'Units/Human/Footman/Footman.mdx', bytes: text('base model') },
      { path: 'Scripts/common.j', bytes: text('base script') },
    ]),
  )
  await writeFile(
    join(installation, 'War3Patch.mpq'),
    encodeFreshMpq([
      { path: 'Scripts/common.j', bytes: text('patched script') },
      { path: 'Scripts/Blizzard.j', bytes: text('patch only') },
    ]),
  )
})
afterAll(() => rm(installation, { recursive: true, force: true }))

describe('Warcraft III content sources', () => {
  it('serves the chain as one tree, the patch winning over the base', async () => {
    const sources = await createContentSources({ installationDirectory: installation })
    try {
      const { roots } = await sources.snapshot()
      expect(roots).toEqual([
        expect.objectContaining({ id: 'local:warcraft3', kind: 'local', storageOf: installation }),
      ])
      const top = await sources.list('local:warcraft3', '')
      expect(top.filter(entry => !entry.hidden).map(entry => [entry.name, entry.directory])).toEqual([
        ['Scripts', true],
        ['Units', true],
      ])
      expect((await sources.list('local:warcraft3', 'Scripts')).map(entry => entry.name)).toEqual([
        'Blizzard.j',
        'common.j',
      ])
      expect(decoded(await sources.read('local:warcraft3', 'Scripts/common.j', 1024))).toBe(
        'patched script',
      )
      // Paths are the game's: backslashes and any case.
      expect(
        decoded(await sources.read('local:warcraft3', 'units\\human\\footman\\FOOTMAN.MDX', 1024)),
      ).toBe('base model')
      await expect(sources.read('local:warcraft3', 'Scripts/common.j', 4)).rejects.toThrow(/more than 4/u)
      const page = await sources.files!('local:warcraft3', '', { pattern: 'fotmdx', limit: 10 })
      expect(page.items.map(item => item.path)).toEqual(['Units/Human/Footman/Footman.mdx'])
    } finally {
      await sources.dispose()
    }
  })

  it('places maps and scripts, and leaves other files and games to others', async () => {
    const sources = await createContentSources({ installationDirectory: installation })
    const project = await mkdtemp(join(tmpdir(), 'modkit-war3-project-'))
    try {
      await writeFile(join(project, 'Duel.w3x'), encodeFreshMpq([{ path: 'war3map.j', bytes: text('map script') }]))
      expect(await sources.locateModPackage!(join(project, 'Duel.w3x'))).toEqual({
        kind: 'package',
        sourceId: 'host',
        path: join(project, 'Duel.w3x'),
        displayName: 'Duel.w3x',
      })
      expect(await sources.locateModPackage!(join(project, 'Gone.w3m'))).toEqual({ kind: 'missing' })
      expect(await sources.locateModPackage!(join(project, 'war3map.j'))).toEqual({ kind: 'loose' })
      expect(await sources.locateModPackage!(join(project, 'readme.txt'))).toEqual({ kind: 'foreign' })
      expect(await sources.locateModPackage!({ sourceId: 'local:casc', path: 'Mods/Core.SC2Mod' })).toEqual({ kind: 'foreign' })
    } finally {
      await sources.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('opens a map inside the game: the installation first, the map last', async () => {
    const sources = await createContentSources({ installationDirectory: installation })
    const project = await mkdtemp(join(tmpdir(), 'modkit-war3-project-'))
    const map = join(project, 'Duel.w3x')
    await writeFile(map, encodeFreshMpq([{ path: 'war3map.j', bytes: text('map script') }]))
    const context = await sources.openModContext!({ schemaVersion: 1, target: map })
    try {
      expect(context.gameId).toBe('blizzard/warcraft-3')
      expect(context.unresolved).toEqual([])
      expect(context.layers.map(layer => [layer.id, layer.sourceId, layer.sourcePath, layer.role])).toEqual([
        ['war3-game', 'local:warcraft3', '', 'dependency'],
        ['primary', 'host', map, 'primary'],
      ])
      expect((await context.files('war3-game', { limit: 10, prefix: 'Scripts' })).items).toEqual(['Scripts/Blizzard.j', 'Scripts/common.j'])
      // The patch's common.j is the one the game reads.
      expect(decoded(await context.read('war3-game', 'Scripts/common.j', 1024))).toBe('patched script')
      expect((await context.files('primary', { limit: 10 })).items).toContain('war3map.j')
      expect(decoded(await context.read('primary', 'war3map.j', 1024))).toBe('map script')
      expect(await context.locate('Scripts/common.j')).toEqual({ layerId: 'war3-game', path: 'Scripts/common.j' })
      expect(await context.locate('war3map.j')).toEqual({ layerId: 'primary', path: 'war3map.j' })
      await expect(context.read('war3-game', 'Scripts/nothing.j', 1024)).rejects.toThrow(/not a file/u)
    } finally {
      await context.dispose()
      await sources.dispose()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('opens a model inside the whole installation, so textures of another archive resolve', async () => {
    // Frozen Throne models live in War3x.mpq; the team colour they draw with lives in war3.mpq.
    const game = await mkdtemp(join(tmpdir(), 'modkit-war3-models-'))
    const project = await mkdtemp(join(tmpdir(), 'modkit-war3-project-'))
    const model = 'Units/Naga/NagaMyrmidon/NagaMyrmidon.mdx'
    try {
      await writeFile(
        join(game, 'war3.mpq'),
        encodeFreshMpq([{ path: 'ReplaceableTextures/TeamColor/TeamColor00.blp', bytes: text('red') }]),
      )
      await writeFile(join(game, 'War3x.mpq'), encodeFreshMpq([{ path: model, bytes: text('naga') }]))
      const sources = await createContentSources({ installationDirectory: game })
      try {
        // An archive member, the same file in the installation's tree, and a model outside any game.
        const member = join(game, 'War3x.mpq', ...model.split('/'))
        expect(await sources.locateModPackage!(member)).toEqual({ kind: 'loose' })
        expect(await sources.locateModPackage!({ sourceId: 'local:warcraft3', path: model })).toEqual({ kind: 'loose' })
        expect(await sources.locateModPackage!(join(project, 'Custom.mdx'))).toEqual({ kind: 'loose' })
        expect(await sources.locateModPackage!(join(project, 'readme.txt'))).toEqual({ kind: 'foreign' })
        const context = await sources.openModContext!({ schemaVersion: 1, target: { sourceId: 'local:warcraft3', path: model } })
        try {
          expect(context.layers.map(layer => layer.id)).toEqual(['war3-game', 'primary'])
          expect(await context.locate('ReplaceableTextures\\TeamColor\\TeamColor00.blp')).toEqual({
            layerId: 'war3-game',
            path: 'ReplaceableTextures/TeamColor/TeamColor00.blp',
          })
          expect(decoded(await context.read('war3-game', 'ReplaceableTextures/TeamColor/TeamColor00.blp', 16))).toBe('red')
        } finally {
          await context.dispose()
        }
      } finally {
        await sources.dispose()
      }
    } finally {
      await rm(game, { recursive: true, force: true })
      await rm(project, { recursive: true, force: true })
    }
  })

  it('offers no root for a folder without the base archive', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'modkit-war3-empty-'))
    try {
      const sources = await createContentSources({ installationDirectory: empty })
      expect((await sources.snapshot()).roots).toEqual([])
      await sources.dispose()
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
