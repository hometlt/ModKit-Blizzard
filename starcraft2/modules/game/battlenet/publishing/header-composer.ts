/**
 * Compose a publication header (`.s2mh`) for a document that has never been published.
 *
 * The field names below are the game's own: `Battlenet::S2Map::BnetHeader` and the structures it
 * references, recovered from the extracted BSN protocol schema in the publishing research. What a
 * reader of this file sees is therefore the shape Battle.net defines, not an inferred one.
 *
 * Until now a revision could only be compiled from the header the StarCraft II Editor had already
 * produced, which meant Modkit could never publish a document for the first time. The header is a
 * tagged tree whose encoder is exact — decoding and re-encoding reproduces every header in the
 * game's own cache byte for byte — so the question was never whether it can be written, but what
 * belongs in it. This composes the shape that published mods and maps actually carry.
 *
 * What it does not do: a document whose lobby carries variants or attributes needs field 5, which
 * the editor compiles from the document's own data. Such a publication is refused rather than
 * published without the half that makes it playable.
 */
import { encodeCacheHeader, type CacheNode } from '../content-sources/cache-header.js'

export type PublicationRegion = 'us' | 'eu' | 'kr'

/** `m_extraDependencies`: the published documents this one depends on. */
export interface PublicationDependency {
  readonly id: number
  /** Zero means "whatever the service resolves", which is what published documents carry. */
  readonly version: number
}

/**
 * `m_variants`: one lobby variant. A document with no lobby still carries a single default, which
 * is what a mod publishes; a map carries one per team layout it offers.
 */
export interface PublicationVariant {
  readonly categoryId: number
  readonly modeId: number
  readonly maxTeamSize: number
  /** String ids in the locale document; 0 where the variant is not named. */
  readonly categoryName?: number
  readonly modeName?: number
}

export interface ComposePublicationHeaderRequest {
  /** `{ id: 0, version: 0 }` for a first publication; the server allocates the real identity. */
  readonly identity: { readonly id: number; readonly version: number }
  /** The archive's file name as the publication carries it, e.g. `Example.SC2Mod`. */
  readonly fileName: string
  readonly region: PublicationRegion
  /** Digest of the `.s2ma` archive this header publishes. */
  readonly archiveSha256: string
  /** Attribute namespace; PrePublish answers with it. */
  readonly namespace: number
  /** One compiled `.s2ml` per locale, in the order the header should list them. */
  readonly locales: readonly { readonly locale: string; readonly sha256: string }[]
  /** Preview images already uploaded with this document. */
  readonly previews?: readonly { readonly sha256: string }[]
  /** `m_extraDependencies`, in the order the document declares them. */
  readonly dependencies?: readonly PublicationDependency[]
  /** `m_variants`; defaults to the single unnamed variant a document without a lobby carries. */
  readonly variants?: readonly PublicationVariant[]
  /** String ids inside the locale document. The compiler writes the name as 1 and description as 2. */
  readonly nameString?: number
  readonly descriptionString?: number
  /** `m_workingSet` scalars. The defaults are what a mod without a lobby or a map image carries. */
  readonly workingSet?: {
    /** `m_bigMap`: the rectangle of the document's map image. */
    readonly bigMap?: readonly [number, number, number, number, number]
    readonly maxPlayers?: number
    readonly specialScope?: number
  }
}

const int = (value: number | bigint): CacheNode => ({ kind: 9, value: BigInt(value) })
const map = (fields: readonly (readonly [number, CacheNode])[]): CacheNode =>
  ({ kind: 5, value: new Map(fields.map(([tag, node]) => [BigInt(tag), node])) })
const list = (items: readonly CacheNode[]): CacheNode => ({ kind: 0, value: [...items] })
const absent: CacheNode = { kind: 4, value: undefined }
const present = (node: CacheNode): CacheNode => ({ kind: 4, value: node })
const byte = (value: number): CacheNode => ({ kind: 6, value: Uint8Array.of(value) })
const blob = (bytes: Uint8Array): CacheNode => ({ kind: 2, value: bytes })
const text = (value: string): CacheNode => blob(new TextEncoder().encode(value))
/** Four-byte locale code, stored as a fixed-width field rather than a counted blob. */
const localeCode = (value: string): CacheNode => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length !== 4) throw new Error(`A locale code is four characters: ${value}`)
  return { kind: 7, value: bytes }
}
/** `usage` + two reserved bytes + upper-case region + the component digest, as the depot addresses it. */
const handle = (usage: string, region: PublicationRegion, digest: string): CacheNode => {
  if (!/^[0-9a-f]{64}$/iu.test(digest)) throw new Error(`Component digest is not a sha256: ${digest}`)
  const bytes = new Uint8Array(8 + 32)
  bytes.set(new TextEncoder().encode(usage), 0)
  bytes.set(new TextEncoder().encode(region.toUpperCase()), 6)
  bytes.set(Buffer.from(digest.toLowerCase(), 'hex'), 8)
  return blob(bytes)
}
/** A reference into the publication's locale document; string 0 means the field carries no text. */
const stringReference = (id: number): CacheNode =>
  map([[0, absent], [1, int(0)], [2, int(id)]])

/** One `Battlenet::S2Map::VariantInfo`. */
const variantEntry = (item: PublicationVariant): CacheNode =>
  map([
    [0, map([[0, int(item.categoryId)], [1, int(item.modeId)]])],
    [1, stringReference(item.categoryName ?? 0)],
    [2, stringReference(item.modeName ?? 0)],
    [3, absent],
    [4, absent],
    [5, map([[0, absent], [1, absent], [2, absent]])],
    [6, list([])],
    [7, list([])],
    [8, int(item.maxTeamSize)],
    [9, list([])],
    [10, list([])],
    [11, list([])],
    [12, absent],
    [13, absent],
    [14, absent],
    [15, list([])],
  ])

/**
 * Which arcade categories a publication is listed under, as the publish metadata carries them.
 *
 * No query reports the live mask back, but it never had to: a variant names its category, and the
 * mask is those categories. The editor sends what its document's variants say, and so do we.
 */
export function categoryMaskOf(variants: readonly PublicationVariant[]): number {
  let mask = 0
  for (const variant of variants) mask |= 1 << variant.categoryId
  return mask
}

/** What a document with no lobby of its own publishes: one unnamed variant for one player. */
export const DEFAULT_VARIANT: PublicationVariant = Object.freeze({
  categoryId: 1, modeId: 1, maxTeamSize: 1,
})

/** Build the header tree. Exposed separately so a caller can compare it against a real sample. */
export function composePublicationHeaderTree(request: ComposePublicationHeaderRequest): CacheNode {
  if (request.locales.length === 0) throw new Error('A publication header needs at least one locale')
  const localeTables = list(request.locales.map(item =>
    map([[0, localeCode(item.locale)], [1, list([handle('s2ml', request.region, item.sha256)])]])))
  const bigMap = request.workingSet?.bigMap ?? [0, 0, 0, 24, 24]
  const workingSet = map([
    [0, stringReference(request.nameString ?? 1)],
    [1, stringReference(request.descriptionString ?? 2)],
    [2, absent],
    [3, present(map(bigMap.map((value, index) => [index, int(value)] as const)))],
    [4, int(request.workingSet?.maxPlayers ?? 16)],
    [5, int(request.workingSet?.specialScope ?? 22)],
    [6, list([])],
    [7, list((request.previews ?? []).map(item => handle('s2mv', request.region, item.sha256)))],
    [8, localeTables],
    [9, list([])],
    [10, list([])],
    [11, list([])],
  ])
  const dependencies = request.dependencies ?? []
  const variants = request.variants ?? [DEFAULT_VARIANT]
  const publication = map([
    [0, map([[0, int(request.identity.id)], [1, int(request.identity.version)]])],
    [1, text(request.fileName)],
    [2, handle('s2ma', request.region, request.archiveSha256)],
    [3, int(request.namespace)],
    [4, workingSet],
    // Lobby variants and attributes: a document that needs them cannot be composed here.
    [5, list([])],
    [7, list([])],
    [8, localeTables],
    [9, absent],
    [10, absent],
    [12, int(0)],
    [13, list(variants.map(variantEntry))],
    [14, list(dependencies.map(item => map([[0, int(item.id)], [1, int(item.version)]])))],
    [15, byte(1)],
    [16, list([])],
    [17, list([])],
    [18, list([])],
    [19, absent],
    [22, byte(0)],
    [23, list([])],
  ])
  return map([[0, publication], [1, map([[0, byte(0)]])]])
}

export function composePublicationHeader(request: ComposePublicationHeaderRequest): Uint8Array {
  return encodeCacheHeader(composePublicationHeaderTree(request))
}
