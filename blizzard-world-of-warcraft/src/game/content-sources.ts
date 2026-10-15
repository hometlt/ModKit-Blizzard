/**
 * World of Warcraft content sources: each product an installation holds (retail `local:wow`,
 * classic `local:wow_classic`…) as the one tree its CASC root names, through the layered-archive
 * helper of `@modkit/vfs` over the shared CASC installation reader of `@modkit/blizzard-casc`.
 * Retail's root declares `storageOf`, so opening the installation folder mounts it instead of a
 * second reader through the container codec; the other products share its storage.
 *
 * The root names files by FileDataID: a file the wowdev listfile names is listed under its path
 * (`world/maps/azeroth/azeroth.wdt`), every other one as `filedataid/<id>`, and `filedataid/<id>`
 * reads any file — models name their textures by ID. The listfile and the TACT keys are fetched
 * into the host's index cache directory (`./community-data.ts`); without that directory, or offline
 * on first use, files stay unnamed. The parsed index is kept there between windows, per locale and
 * listfile. Encrypted files (~3% of a sample) are refused with the key they need: decryption is a
 * separate step. The tree's files open in a context of their own over the whole installation.
 */
import { isAbsolute } from 'node:path'
import {
  cascInstallationArchive,
  openCascInstallation,
} from '@modkit/blizzard-casc/installation-node'
import { indexCacheEnabled, type ContentSourceModuleContext } from '@modkit/sdk'
import {
  createLayeredArchiveContentSources,
  type LayeredArchiveContentSources,
  type LayeredRoot,
} from '@modkit/vfs/content-sources'
import { LISTFILE_URL, TACT_KEYS_URL, communityFile, parseTactKeys } from './community-data.js'
import { WOW_GAME_ID, discoverWowInstallations, installedWowProducts } from './installation.js'

/** Root id of a product: `local:wow` for retail, `local:<product>` for the others. */
export function wowRootId(product: string): string {
  return product === 'wow' ? 'local:wow' : `local:${product}`
}

const FLAVORS: Readonly<Record<string, string>> = Object.freeze({
  wow: 'Retail',
  wow_classic: 'Classic',
  wow_classic_era: 'Classic Era',
  wowt: 'PTR',
  wow_beta: 'Beta',
})

/**
 * The installation comes from the host — the one the user selected, `installationDirectory` — or
 * else from this extension's own discovery. Each active WoW product of it gets a root.
 */
export async function createContentSources(
  options: Readonly<Record<string, unknown>>,
  context: ContentSourceModuleContext = {},
): Promise<LayeredArchiveContentSources> {
  const selected = options['installationDirectory']
  let installation = typeof selected === 'string' && isAbsolute(selected) ? selected : undefined
  if (installation === undefined) {
    const discovery = await discoverWowInstallations(
      { gameId: WOW_GAME_ID, maxCandidates: 16 },
      context.installationProbes,
    )
    installation = discovery.installations[0]?.installPath
  }
  const products = installation === undefined ? [] : await installedWowProducts(installation)
  const cacheDirectory = context.indexCacheDirectory
  const cache =
    cacheDirectory === undefined
      ? undefined
      : {
          directory: cacheDirectory,
          names: (product: string) => indexCacheEnabled(context.indexCaches, product, 'names'),
        }
  const log = (message: string) => console.warn(message)
  const roots: LayeredRoot[] = []
  const storage = installation
  if (storage !== undefined)
    for (const { product, buildKey } of products)
      roots.push({
        root: {
          id: wowRootId(product),
          label: `World of Warcraft ${FLAVORS[product] ?? product} — CASC`,
          region: 'local',
          kind: 'local',
          ...(product === products[0]?.product ? { storageOf: storage } : {}),
          game: 'wow',
          revision: buildKey,
          product,
        },
        open: async () => {
          const listfile = cacheDirectory === undefined ? undefined
            : await communityFile(cacheDirectory, 'community-listfile.csv', LISTFILE_URL, log)
          const keys = cacheDirectory === undefined ? undefined
            : await communityFile(cacheDirectory, 'tact-keys.txt', TACT_KEYS_URL, log)
          const reader = await openCascInstallation(storage, cache, {
            product,
            ...(listfile === undefined ? {} : { wowListfile: listfile }),
            ...(keys === undefined ? {} : { encryptionKeys: parseTactKeys(new TextDecoder().decode(await keys.load())) }),
          })
          return [cascInstallationArchive(reader, 'storage')]
        },
      })
  return createLayeredArchiveContentSources('World of Warcraft', roots, {
    modContext: { gameId: WOW_GAME_ID },
  })
}
