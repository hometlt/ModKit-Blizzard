/**
 * Heroes of the Storm content sources: an installed game as the one tree its CASC storage holds
 * (`mods/core.stormmod`, `mods/heroes.stormmod`, `mods/heroesdata.stormmod`, the battleground mods,
 * `versions.osxarchive`…), through the layered-archive helper of `@modkit/vfs` over the shared CASC
 * installation reader of `@modkit/blizzard-casc`. The root declares `storageOf`, so opening the
 * installation folder mounts this root instead of a second reader through the container codec. The
 * name index is kept between windows in the host's shared index cache directory.
 *
 * A file of the tree (a model, a texture) opens in a context of its own over the whole installation
 * (`modContext`). That context does not yet resolve the game's asset paths (`Assets\Textures\x.dds`)
 * through the Storm mod chain (`base.stormassets` of Core, Heroes, HeroesData): the one SC2 mod
 * loader takes Storm's names and dependency rules as game data — [SC2] Mod & Data.
 *
 * Opening needs the CASC reader to admit Heroes' storage: its encoding file (~92 MB) and name index
 * (~1.2 M names) exceed the reader's default limits until the CASC owner raises them.
 */
import { isAbsolute } from 'node:path'
import {
  cascInstallationArchive,
  installationBuild,
  openCascInstallation,
} from '@modkit/blizzard-casc/installation-node'
import { indexCacheEnabled, type ContentSourceModuleContext } from '@modkit/sdk'
import {
  createLayeredArchiveContentSources,
  type LayeredArchiveContentSources,
  type LayeredRoot,
} from '@modkit/vfs/content-sources'
import { HEROES_GAME_ID, discoverHeroesInstallations, matchesHeroes } from './installation.js'

export const HEROES_ROOT_ID = 'local:heroes'

/**
 * The installation comes from the host — the one the user selected, `installationDirectory` — or
 * else from this extension's own discovery. A confirmed Heroes storage gets the root.
 */
export async function createContentSources(
  options: Readonly<Record<string, unknown>>,
  context: ContentSourceModuleContext = {},
): Promise<LayeredArchiveContentSources> {
  const selected = options['installationDirectory']
  let installation = typeof selected === 'string' && isAbsolute(selected) ? selected : undefined
  if (installation === undefined) {
    const discovery = await discoverHeroesInstallations(
      { gameId: HEROES_GAME_ID, maxCandidates: 16 },
      context.installationProbes,
    )
    installation = discovery.installations[0]?.installPath
  }
  const build = installation === undefined ? undefined : installationBuild(installation)
  const cacheDirectory = context.indexCacheDirectory
  const cache =
    cacheDirectory === undefined
      ? undefined
      : {
          directory: cacheDirectory,
          names: (product: string) => indexCacheEnabled(context.indexCaches, product, 'names'),
        }
  const roots: LayeredRoot[] = []
  const storage = installation
  if (storage !== undefined && build !== undefined && matchesHeroes(build.product))
    roots.push({
      root: {
        id: HEROES_ROOT_ID,
        label: 'Heroes of the Storm — CASC',
        region: 'local',
        kind: 'local',
        storageOf: storage,
        game: build.game,
        revision: build.buildKey,
        product: build.product,
      },
      open: async () => [cascInstallationArchive(await openCascInstallation(storage, cache), 'storage')],
    })
  return createLayeredArchiveContentSources('Heroes of the Storm', roots, {
    modContext: { gameId: HEROES_GAME_ID },
  })
}
