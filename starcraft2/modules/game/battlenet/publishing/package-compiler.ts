/**
 * Compile a `.modkit-publish.json` package for a StarCraft II document.
 *
 * The desktop publisher never compiles game metadata: it stages a prepared package whose header
 * (`.s2mh`), locale tables (`.s2ml`) and archive hash already agree. This builds that package from
 * an existing editor-produced header plus the document's own archive and names, which covers a new
 * revision of something the editor has published once (new bytes, new name, new description).
 *
 * A first publication is NOT covered: the structural half of a header (dimensions, player slots,
 * dependency handles, category data) is written by the editor, and inventing it would publish a
 * document the game cannot read. `compilePublicationPackage` refuses without a base header and says so.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  array,
  blob,
  decodeCacheHeader,
  encodeCacheHeader,
  field,
  number,
  type CacheNode,
} from '../content-sources/cache-header.js'

export type PublicationRegion = 'us' | 'eu' | 'kr'

export interface PublicationLocaleText {
  /** SC2 locale code as the header spells it, e.g. `enUS`. */
  readonly locale: string
  readonly name: string
  readonly description?: string
}

export interface CompilePublicationRequest {
  /** The archive to publish, already built (`.SC2Map`/`.SC2Mod`). */
  readonly archive: { readonly path: string; readonly bytes: Uint8Array }
  /** An editor-produced header for this same document, from the game cache or a previous package. */
  readonly baseHeader: Uint8Array
  /** Attribute namespace PrePublish answered with; the publisher refuses any other value. */
  readonly namespace: number
  readonly region: PublicationRegion
  readonly kind: 'map' | 'mod'
  readonly locale: string
  readonly texts: readonly PublicationLocaleText[]
  readonly target: { readonly mode: 'create' } | { readonly mode: 'update'; readonly id: number; readonly expectedVersion: number }
  readonly visibility: 'private' | 'public'
  readonly locked: boolean
  /** A major revision moves the published version to the next whole number instead of the next minor. */
  readonly majorRevision?: boolean
  readonly isExtensionMod?: boolean
  readonly isUndependable?: boolean
  readonly isSkipInitialDownload?: boolean
  readonly isMelee?: boolean
  readonly isHiddenLobby?: boolean
  /** Arcade categories. No query reports the live mask back, so a republish can only set it. */
  readonly categoryMask?: number
  /** Listed labels and cluster membership; the publisher cannot send either, so they must be empty. */
  readonly labels?: readonly string[]
  readonly cluster?: boolean
  readonly clusterParent?: number | null
  /** Visual components (`.s2mv`) already uploaded with this document, keyed by their sha256. */
  readonly visuals?: readonly { readonly sha256: string; readonly bytes: Uint8Array }[]
}

export interface CompiledPublicationPackage {
  readonly directory: string
  readonly packagePath: string
  readonly packageSha256: string
  readonly archiveSha256: string
  readonly headerSha256: string
  readonly locales: readonly { readonly locale: string; readonly file: string; readonly sha256: string }[]
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

/** `usage` + two reserved bytes + upper-case region + the component digest, as the depot addresses it. */
function cacheHandle(usage: string, region: PublicationRegion, digest: string): Uint8Array {
  const handle = new Uint8Array(8 + 32)
  handle.set(text(usage), 0)
  handle.set(text(region.toUpperCase()), 6)
  handle.set(Buffer.from(digest, 'hex'), 8)
  return handle
}

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/gu, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character,
  )

/** The locale table the game reads: one `<e id>` per string the header's references point at. */
export function localeDocument(locale: string, strings: ReadonlyMap<number, string>): Uint8Array {
  const entries = [...strings.entries()].sort(([left], [right]) => left - right)
  const lines = entries.map(([id, value]) => `    <e id="${id}">${escapeXml(value)}</e>`)
  return text(
    // The editor writes no trailing newline; a publication's locale document is compared by digest.
    `<?xml version="1.0" encoding="utf-8"?>\r\n<Locale region="${locale}">\r\n${lines.join('\r\n')}\r\n</Locale>`,
  )
}

const localeEntry = (locale: string, handle: Uint8Array): CacheNode => ({
  kind: 5,
  value: new Map<bigint, CacheNode>([
    [0n, { kind: 7, value: text(locale) }],
    [1n, { kind: 0, value: [{ kind: 2, value: handle }] }],
  ]),
})

const setField = (node: CacheNode, tag: number, value: CacheNode): void => {
  ;(node.value as Map<bigint, CacheNode>).set(BigInt(tag), value)
}

/** Which string ids the header's name and description references name, so the tables match it. */
function stringReferences(publication: CacheNode): { name: number; description?: number } {
  const info = field(publication, 4)
  const name = number(field(field(info, 0), 2))
  const descriptionReference = (info.value as Map<bigint, CacheNode>).get(1n)
  const description = descriptionReference ? number(field(descriptionReference, 2)) : undefined
  return description === undefined ? { name } : { name, description }
}

export async function compilePublicationPackage(
  request: CompilePublicationRequest,
  directory: string,
): Promise<CompiledPublicationPackage> {
  if (request.baseHeader.length === 0) {
    throw new Error(
      'Compiling a first publication is not supported: publish the document once from the StarCraft II Editor, then Modkit can compile its next revision from that header.',
    )
  }
  if (request.labels?.length || request.cluster === true || (request.clusterParent ?? null) !== null) {
    throw new Error(
      'This publication is listed with arcade labels or cluster membership, which the publisher cannot send; publish this revision from the StarCraft II Editor.',
    )
  }
  const selected = request.texts.find(item => item.locale === request.locale)
  if (!selected) throw new Error('The selected locale has no compiled name')
  if (request.texts.length > 256) throw new Error('Too many locales for one publication')

  const tree = decodeCacheHeader(request.baseHeader)
  const publication = field(tree, 0)
  const references = stringReferences(publication)

  const archiveDigest = sha256(request.archive.bytes)
  setField(publication, 1, { kind: 2, value: text(basename(request.archive.path)) })
  setField(publication, 2, { kind: 2, value: cacheHandle('s2ma', request.region, archiveDigest) })
  setField(publication, 3, { kind: 9, value: BigInt(request.namespace) })
  if (request.target.mode === 'update') {
    const identity = field(publication, 0)
    setField(identity, 0, { kind: 9, value: BigInt(request.target.id) })
    setField(identity, 1, { kind: 9, value: BigInt(request.target.expectedVersion) })
  }

  const locales: { locale: string; file: string; sha256: string; bytes: Uint8Array }[] = []
  for (const item of request.texts) {
    const strings = new Map<number, string>([[references.name, item.name]])
    if (references.description !== undefined) strings.set(references.description, item.description ?? '')
    const bytes = localeDocument(item.locale, strings)
    locales.push({ locale: item.locale, file: `${item.locale}.s2ml`, sha256: sha256(bytes), bytes })
  }
  const localeTables: CacheNode = {
    kind: 0,
    value: locales.map(item => localeEntry(item.locale, cacheHandle('s2ml', request.region, item.sha256))),
  }
  setField(publication, 8, localeTables)
  setField(field(publication, 4), 8, localeTables)

  const visuals = (request.visuals ?? []).map(item => ({ ...item, file: `${item.sha256}.s2mv` }))
  const info = field(publication, 4)
  if ((info.value as Map<bigint, CacheNode>).has(7n)) {
    setField(info, 7, {
      kind: 0,
      value: visuals.map(item => ({ kind: 2, value: cacheHandle('s2mv', request.region, item.sha256) })),
    })
  } else if (visuals.length > 0) {
    throw new Error('This header carries no visual components; remove them or recompile in the editor')
  }
  const header = encodeCacheHeader(tree)
  const headerDigest = sha256(header)
  const metadata = {
    m_mapName: selected.name,
    m_mapHandle:
      request.target.mode === 'update'
        ? { m_id: request.target.id, m_version: request.target.expectedVersion }
        : { m_id: 0, m_version: 0 },
    m_isMod: request.kind === 'mod',
    m_isExtensionMod: request.isExtensionMod ?? false,
    m_isUndependable: request.isUndependable ?? false,
    m_isLocked: request.locked,
    m_isSkipInitialDownload: request.isSkipInitialDownload ?? false,
    m_isMelee: request.isMelee ?? false,
    m_isCluster: false,
    m_clusterParent: null,
    m_isHiddenLobby: request.isHiddenLobby ?? false,
    m_labels: [],
    m_authorPrefs: {
      m_showRID: false,
      m_accountLinked: true,
      m_isPrivate: request.visibility === 'private',
      m_transitionId: null,
    },
    m_categoryMask: request.categoryMask ?? 0,
    m_localizedNames: request.texts.map(item => ({ m_locale: item.locale, m_name: item.name })),
  }
  const manifest = {
    schema: 1 as const,
    region: request.region,
    name: selected.name,
    locale: request.locale,
    kind: request.kind,
    archiveSha256: archiveDigest,
    header: { file: 'publication.s2mh', sha256: headerDigest },
    locales: locales.map(item => ({ file: item.file, sha256: item.sha256 })),
    ...(visuals.length === 0 ? {} : { visuals: visuals.map(item => ({ file: item.file, sha256: item.sha256 })) }),
    metadata,
    target: request.target,
    visibility: request.visibility,
    locked: request.locked,
    ...(request.majorRevision === undefined ? {} : { majorRevision: request.majorRevision }),
    ...(selected.description === undefined ? {} : { description: selected.description }),
  }

  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'publication.s2mh'), header)
  for (const item of locales) await writeFile(join(directory, item.file), item.bytes)
  for (const item of visuals) await writeFile(join(directory, item.file), item.bytes)
  const body = text(`${JSON.stringify(manifest, null, 2)}\n`)
  const packagePath = join(directory, `${selected.name}.modkit-publish.json`)
  await writeFile(packagePath, body)
  return {
    directory,
    packagePath,
    packageSha256: sha256(body),
    archiveSha256: archiveDigest,
    headerSha256: headerDigest,
    locales: locales.map(item => ({ locale: item.locale, file: item.file, sha256: item.sha256 })),
  }
}
