import type { CascRootCache } from './index.js'

/** sdk `IndexCacheManifest`, written as `cache.json` beside the cache. */
export interface IndexCacheDescription {
  readonly game: string
  readonly product?: string
  readonly kind: 'names'
  readonly installation: string
}
/** The game a CASC product code names (`s2` → `starcraft2`), or the code itself. */
export function cascGameOf(product: string): string
export function createInstallationRootCache(directory: string, installation: string,
  log: { info(message: string): void; warn(message: string): void }, describe?: IndexCacheDescription): CascRootCache
export function canonicalInstallation(installation: string): string
/** The folder of an installation's caches inside the shared directory, from its canonical identity. */
export function installationCacheFolder(installation: string): string
export function removeLegacyCache(directory: string, installation: string): Promise<void>
