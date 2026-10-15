// Legacy Layout imports Node helpers that are unreachable in portable inspection paths.
// One build adapter serves every portable codec that consumes the Layout owner.
const builtin = /^(?:node:)?(?:fs|fs\/promises|path|util|stream)$/

export const erasedNodeHelpers = {
  name: 'sc2-layout-erased-node-helpers',
  enforce: 'pre',
  resolveId(id) {
    if (builtin.test(id) || id === 'fast-glob') return `\0sc2-layout-erased:${id}`
  },
  load(id) {
    if (!id.startsWith('\0sc2-layout-erased:')) return
    const name = id.slice('\0sc2-layout-erased:'.length)
    if (name === 'util' || name === 'node:util') {
      return 'export const promisify = () => async () => { throw new Error("Node-only helper unavailable in portable SC2Layout runtime") }; export const inspect = () => { throw new Error("Node-only inspect helper unavailable in portable SC2Layout runtime") }'
    }
    if (name === 'path' || name === 'node:path') {
      return 'export const sep = "/"; export const join = (...parts) => parts.map(String).filter(Boolean).join("/").replace(/\\/+/g, "/"); export const resolve = join; export default { sep, resolve, join }'
    }
    if (name === 'fast-glob') {
      return 'export default async function glob() { throw new Error("Node-only glob helper unavailable in portable SC2Layout runtime") }'
    }
    if (name === 'stream' || name === 'node:stream') return 'export class Stream {}'
    return 'export const readFile = async () => { throw new Error("Node-only file helper unavailable in portable SC2Layout runtime") }; export const readdir = readFile; export const exists = readFile'
  },
}
