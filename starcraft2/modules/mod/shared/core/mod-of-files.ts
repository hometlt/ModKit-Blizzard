/**
 * One package's files, already read, as the mod they declare — without its dependencies.
 *
 * A mod, a map and a campaign share the package layout (`Base.SC2Data`, locale components), so the
 * same reader turns any of them into the catalog their entity cards are drawn from.
 */
import { SC2ModReader } from './reader.js'
import type { SC2Mod } from './mod.js'

const utf8 = new TextDecoder('utf-8', { fatal: false })
const slashes = (value: string): string => value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')

/** `files` keyed by package-relative path; `root` is only the name the reader gives the package. */
export function readSc2ModOfFiles(
  files: ReadonlyMap<string, Uint8Array>,
  root = 'namespace:Active.SC2Mod',
): Promise<SC2Mod> {
  const byPath = new Map(
    [...files].map(([path, bytes]) => [`${root}/${slashes(path)}`.toLowerCase(), bytes] as const),
  )
  return new SC2ModReader({
    vfs: {
      async list(base: string): Promise<string[]> {
        return slashes(base).toLowerCase() === root.toLowerCase() ? [...files.keys()].sort() : []
      },
      async get(path: string): Promise<Uint8Array> {
        const bytes = byPath.get(slashes(path).toLowerCase())
        if (bytes === undefined) throw new RangeError(`unknown SC2 mod entry: ${path}`)
        return bytes
      },
      async getText(path: string): Promise<string> {
        return utf8.decode(await this.get(path))
      },
      async exists(path: string): Promise<boolean> {
        const normalized = slashes(path).toLowerCase()
        return byPath.has(normalized) || [...byPath.keys()].some(item => item.startsWith(`${normalized}/`))
      },
    },
  }).read(root, { deps: [] })
}
