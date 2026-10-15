/**
 * What a saved document says it depends on.
 *
 * `DocumentHeader` inside an `.SC2Map`/`.SC2Mod` lists its dependencies as strings the editor
 * writes, for example `bnet:Liberty (Mod)/0.0/999,file:Mods/Liberty.SC2Mod`: a published document
 * named by its Battle.net name, and the local file that stands in for it while editing. Only the
 * `bnet:` half identifies a publication, and only a name — not the id a header must carry.
 */
export interface DeclaredDependency {
  /** The publication name as the document names it, e.g. `Liberty (Mod)`. */
  readonly name: string
  /** `<major>.<minor>/<build>` as written; 0.0/999 means "whatever the service resolves". */
  readonly version: string
  /** The local file the editor used, when the document names one. */
  readonly file?: string
}

const BNET = 'bnet:'

/** Read the `bnet:` dependencies out of a `DocumentHeader`, in the order the document lists them. */
export function readDeclaredDependencies(documentHeader: Uint8Array): readonly DeclaredDependency[] {
  const text = Buffer.from(documentHeader)
  const found: DeclaredDependency[] = []
  let at = 0
  while ((at = text.indexOf(BNET, at)) >= 0) {
    const end = text.indexOf(0, at)
    if (end < 0) break
    const entry = text.subarray(at, end).toString('utf8')
    at = end + 1
    if (entry.length > 512) continue
    const [reference = '', ...rest] = entry.split(',')
    const slash = reference.indexOf('/', BNET.length)
    const name = slash < 0 ? reference.slice(BNET.length) : reference.slice(BNET.length, slash)
    if (!name) continue
    const file = rest.find(item => item.startsWith('file:'))?.slice('file:'.length)
    found.push(Object.freeze({
      name,
      version: slash < 0 ? '' : reference.slice(slash + 1),
      ...(file === undefined ? {} : { file }),
    }))
  }
  return Object.freeze(found)
}
