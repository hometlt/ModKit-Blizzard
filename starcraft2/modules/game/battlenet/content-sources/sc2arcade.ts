/** Blizzard depot CDN base per SC2 region id. */
export const REGION_DEPOTS: Record<number, string> = {
  1: 'https://us-s2-depot.classic.blizzard.com',
  2: 'https://eu-s2-depot.classic.blizzard.com',
  3: 'https://kr-s2-depot.classic.blizzard.com',
  5: 'https://cn-s2-depot.necdn.leihuo.netease.com',
}

export interface ModDependency {
  name: string
  type: string
  regionId: number
  bnetId: number
  majorVersion: number
  minorVersion: number
  archiveHash: string
  headerHash: string
  archiveFilename: string
  archiveSize: number
  isExtensionMod: boolean
}

export interface Sc2ArcadeOptions {
  readonly token?: string
  readonly apiBase?: string
  readonly depots?: Record<number, string>
  readonly fetch?: typeof globalThis.fetch
}

export function depotUrl(
  regionId: number,
  hash: string,
  extension: 's2ma' | 's2mh',
  depots: Record<number, string> = REGION_DEPOTS,
): string {
  const base = depots[regionId]
  if (base === undefined) throw new Error(`sc2arcade: unknown region id ${regionId}`)
  return `${base}/${hash}.${extension}`
}

export function parseDependencies(api: unknown): ModDependency[] {
  const list = (api as { list?: unknown[] })?.list
  if (!Array.isArray(list)) return []
  const dependencies: ModDependency[] = []
  for (const entry of list) {
    const value = entry as { map?: Record<string, unknown>; mapHeader?: Record<string, unknown> }
    const header = value.mapHeader
    if (!header || typeof header['archiveHash'] !== 'string') continue
    dependencies.push({
      name: String(value.map?.['name'] ?? header['archiveFilename'] ?? ''),
      type: String(value.map?.['type'] ?? ''),
      regionId: Number(header['regionId']),
      bnetId: Number(header['bnetId']),
      majorVersion: Number(header['majorVersion'] ?? 0),
      minorVersion: Number(header['minorVersion'] ?? 0),
      archiveHash: String(header['archiveHash']),
      headerHash: String(header['headerHash'] ?? ''),
      archiveFilename: String(header['archiveFilename'] ?? ''),
      archiveSize: Number(header['archiveSize'] ?? 0),
      isExtensionMod: Boolean(header['isExtensionMod']),
    })
  }
  return dependencies
}

/** SC2Arcade dependency metadata and depot transport owned by the SC2 content-source module. */
export class Sc2ArcadeClient {
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(private readonly options: Sc2ArcadeOptions = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new Error('sc2arcade: no fetch available — pass options.fetch')
    }
    this.fetchImpl = fetchImpl
  }

  async dependencies(regionId: number, bnetId: number): Promise<ModDependency[]> {
    const base = this.options.apiBase ?? 'https://api.sc2arcade.com'
    const url = `${base}/maps/${regionId}/${bnetId}/dependencies`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.options.token) headers['Authorization'] = `Bearer ${this.options.token}`
    const response = await this.fetchImpl(url, { headers })
    if (!response.ok) throw new Error(`sc2arcade: ${url} → HTTP ${response.status}`)
    return parseDependencies(await response.json())
  }

  async downloadArchive(
    dependency: Pick<ModDependency, 'regionId' | 'archiveHash'>,
  ): Promise<Uint8Array> {
    return this.downloadHash(dependency.regionId, dependency.archiveHash, 's2ma')
  }

  async downloadHeader(
    dependency: Pick<ModDependency, 'regionId' | 'headerHash'>,
  ): Promise<Uint8Array> {
    return this.downloadHash(dependency.regionId, dependency.headerHash, 's2mh')
  }

  private async downloadHash(
    regionId: number,
    hash: string,
    extension: 's2ma' | 's2mh',
  ): Promise<Uint8Array> {
    const url = depotUrl(regionId, hash, extension, this.options.depots)
    const response = await this.fetchImpl(url)
    if (!response.ok) throw new Error(`sc2arcade: ${url} → HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}
