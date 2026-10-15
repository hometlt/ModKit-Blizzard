/**
 * The archive-namespace origin backend for host-owned companion resolution (block 9, step 1).
 *
 * The second backend behind the same `CompanionOrigin` interface the filesystem one implements —
 * and the point of the exercise. If the resolver had needed one branch for a directory and another
 * for a container, the abstraction would have been wrong, and block 9 says so explicitly: the
 * algorithm sees requirements, scopes, patterns and cardinality, never a format and never a medium.
 *
 * Everything here goes through the parent container's own published surfaces — the entry listing
 * it offers as `common.view/namespace-entry-source`, and its own bounded `container.extract`
 * operation for bytes. There is no filesystem access on this path at all, by construction rather
 * than by promise: this module imports nothing from `node:*`, and the companion bytes never touch
 * a disk, which is what makes "temporary extraction to a temp file" not merely discouraged but
 * unrepresentable here.
 */

import { ModkitError, throwIfAborted } from '@modkit/core'
import {
  revisionIdFromRef,
  type ArtifactByteSource,
  type ArtifactSource,
  type AssetSourceRef,
  type InputSearchScope,
  type Lease,
  type NamespaceEntry,
  type NamespaceEntrySource,
  type RevisionId,
} from '@modkit/sdk'
import {
  normalizeCompanionLogicalId,
  type CompanionCaseSensitivity,
  type CompanionEnumerationOptions,
  type CompanionOrigin,
  type CompanionOriginEntry,
} from './input-resolution.js'

/** An entry has no directory of its own to be a sibling of; it has the mount it came out of. */
const NAMESPACE_SCOPES: readonly InputSearchScope[] = Object.freeze([
  'current-mount',
  'enclosing-container',
])

export const NESTED_ENTRY_NOT_FOUND = 'x3.host/nested-entry-not-found'

/**
 * The snapshot of one entry inside a container snapshot.
 *
 * Derived rather than borrowed: a container hands every entry the archive's own revision, which
 * would make two different entries of one BIG indistinguishable by revision. Folding the entry id
 * and its extracted length in keeps each entry its own artifact while still naming the container
 * snapshot it was cut from — so reopening the archive changes every entry's revision, exactly as it
 * should. The nested-subject route and the companion backend both call this, so a primary entry and
 * a companion entry of the same archive are pinned the same way.
 */
export function containerEntryRevision(
  containerRevision: RevisionId,
  entryId: string,
  byteLength: number,
): RevisionId {
  // through the ref builder, not by string concatenation: a revision id is a kind-tagged token
  // whose value is percent-encoded, and the container's own revision is itself one of those
  return revisionIdFromRef({
    kind: 'provider-token',
    value: `${String(containerRevision)}!${entryId}:${byteLength}`,
  })
}

export interface NamespaceCompanionOriginOptions {
  /** The parent container's own entry listing, leased and retained by the caller. */
  readonly namespace: NamespaceEntrySource
  /** Logical id (entry path) of the entry that is being opened as the nested subject. */
  readonly primaryLogicalId: string
  /** Snapshot of the parent container; every entry revision is derived from it. */
  readonly containerRevision: RevisionId
  /** The parent's bounded extraction; the host never decompresses a container's payload itself. */
  readonly extract: (entryId: string, signal?: AbortSignal) => Promise<Uint8Array>
  /**
   * SAGE BIG paths are matched case-insensitively by the games that read them, and a container
   * index is not a filesystem — so the policy is stated here rather than inherited from whatever
   * machine the host happens to run on.
   */
  readonly caseSensitivity?: CompanionCaseSensitivity
  /** Entries per `list` page; the resolver's own entry budget still bounds the total. */
  readonly pageLimit?: number
}

/** One game-provider-resolved logical root, in VFS overlay precedence. */
export interface WorkspaceNamespaceLogicalRoot {
  readonly rootId: string
  /** Namespace prefix under which the root serves resource-relative ids. */
  readonly pathPrefix: string
  /** Prefix ResourceSession callers use; absent preserves the historical resource-relative view. */
  readonly logicalPrefix?: string
}

export interface WorkspaceNamespaceCompanionOriginOptions extends Omit<
  NamespaceCompanionOriginOptions,
  'primaryLogicalId'
> {
  readonly primaryLogicalId: string
  /** Active root first, then dependency layers; the first matching resource wins. */
  readonly logicalRoots: readonly WorkspaceNamespaceLogicalRoot[]
  /** Hard page ceiling across one logical-prefix enumeration. */
  readonly maxPages?: number
}

/** One exact workspace root backed by one already-open container namespace. */
export interface CompositeWorkspaceNamespaceRoot extends WorkspaceNamespaceLogicalRoot {
  readonly namespace: NamespaceEntrySource
  readonly containerRevision: RevisionId
  readonly extract: (entryId: string, signal?: AbortSignal) => Promise<Uint8Array>
}

export interface CompositeWorkspaceNamespaceCompanionOriginOptions {
  readonly primaryLogicalId: string
  /** Active root first, then dependency layers; the first matching resource wins. */
  readonly roots: readonly CompositeWorkspaceNamespaceRoot[]
  readonly caseSensitivity?: CompanionCaseSensitivity
  readonly pageLimit?: number
  readonly maxPages?: number
}

/** One caller-owned subtree to inspect inside a game-provider-resolved logical root. */
export interface WorkspaceNamespaceCandidateSearch {
  readonly rootId: string
  /** Resource-relative directory. The empty string explicitly selects the whole logical root. */
  readonly logicalPrefix: string
}

export interface WorkspaceNamespaceCandidateDiscoveryLimits {
  readonly pageItems: number
  readonly maxPages: number
  readonly maxEntries: number
  readonly maxCandidates: number
  readonly maxBytes: bigint
}

export interface WorkspaceNamespaceCandidateDiscoveryOptions {
  readonly namespace: NamespaceEntrySource
  readonly containerRevision: RevisionId
  readonly logicalRoots: readonly WorkspaceNamespaceLogicalRoot[]
  readonly searches: readonly WorkspaceNamespaceCandidateSearch[]
  /** Exact suffix including the leading dot, for example `.m3a`. No glob syntax is accepted. */
  readonly extension: string
  readonly limits: WorkspaceNamespaceCandidateDiscoveryLimits
  readonly caseSensitivity?: CompanionCaseSensitivity
}

export interface WorkspaceNamespaceDiscoveredCandidate {
  readonly logicalId: string
  readonly expectedRevision: RevisionId
  readonly size: bigint
  readonly rootId: string
}

export interface WorkspaceNamespaceCandidateDiscoveryReceipt {
  readonly complete: boolean
  readonly pages: number
  readonly entries: number
  readonly candidates: number
  readonly bytes: bigint
  readonly searches: readonly WorkspaceNamespaceCandidateSearch[]
}

export type WorkspaceNamespaceCandidateDiscoveryResult =
  | {
      readonly state: 'complete'
      readonly candidates: readonly WorkspaceNamespaceDiscoveredCandidate[]
      readonly receipt: WorkspaceNamespaceCandidateDiscoveryReceipt
    }
  | {
      readonly state: 'refused'
      readonly reason: 'budget-exceeded' | 'namespace-invalid' | 'size-unavailable'
      readonly message: string
      readonly candidates: readonly []
      readonly receipt: WorkspaceNamespaceCandidateDiscoveryReceipt
    }

export interface WorkspaceNamespaceCandidateDiscovery {
  discover(signal?: AbortSignal): Promise<WorkspaceNamespaceCandidateDiscoveryResult>
}

interface IndexedEntry {
  readonly entryId: string
  readonly path: string
  readonly size?: bigint
  readonly revision: RevisionId
}

export function createNamespaceCompanionOrigin(
  options: NamespaceCompanionOriginOptions,
): CompanionOrigin {
  const pageLimit = options.pageLimit ?? 256
  const caseSensitivity = options.caseSensitivity ?? 'insensitive'
  const fold = (value: string): string =>
    caseSensitivity === 'insensitive' ? value.toLowerCase() : value
  /*
   * One listing per resolution, shared by `enumerate` and `open`.
   *
   * `open` needs the container's opaque entry id, and the only place that mapping exists is the
   * listing — so without this cache an open would re-page the whole archive to translate one name.
   * It is built lazily: a plan with no requirements never pages the container at all.
   */
  const index = new Map<string, Map<string, IndexedEntry>>()

  /**
   * Pages one prefix out of the container, merging the spellings a literal matcher might need.
   *
   * A container compares a listing prefix *literally*, but the hint the resolver derives comes from
   * a codec's patterns, whose casing is the author's. Folding the hint was wrong in one direction
   * (a BIG storing `art/skeletons/TANK_SKL.w3x` never matches a lower-cased prefix) and not folding
   * it was wrong in the other (a CASC index is entirely lower-case). So both spellings are asked
   * for and their results merged: two bounded listings instead of one, and no silent miss.
   *
   * The limit this leaves is worth naming: a container that stores some third casing — `ART/...` —
   * is still missed on a case-insensitive backend, and the companion reports as absent rather than
   * wrong. Covering that would mean giving up prefix narrowing altogether, which is what makes a
   * 666,588-entry namespace searchable at all.
   */
  const listing = async (
    prefix: string,
    signal?: AbortSignal,
  ): Promise<Map<string, IndexedEntry>> => {
    const cached = index.get(prefix)
    if (cached !== undefined) return cached
    const built = new Map<string, IndexedEntry>()
    const spellings = [...new Set(prefix === '' ? [''] : [prefix, fold(prefix)])]
    for (const spelling of spellings) {
      let cursor: string | undefined
      do {
        throwIfAborted(signal)
        const page = await options.namespace.list(
          spelling,
          cursor === undefined ? { limit: pageLimit } : { cursor, limit: pageLimit },
          signal,
        )
        for (const entry of page.items) {
          if (entry.kind !== 'file') continue
          const key = fold(entry.path)
          // first spelling wins, deterministically, because the resolver sorts before it selects
          if (!built.has(key)) {
            built.set(key, {
              entryId: entry.id,
              path: entry.path,
              ...(entry.size === undefined ? {} : { size: entry.size }),
              revision: entry.revision,
            })
          }
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
    }
    index.set(prefix, built)
    return built
  }

  return Object.freeze({
    primaryLogicalId: options.primaryLogicalId,
    caseSensitivity,
    scopes: NAMESPACE_SCOPES,
    async *enumerate(
      scope: InputSearchScope,
      enumeration: CompanionEnumerationOptions,
      signal?: AbortSignal,
    ): AsyncIterable<CompanionOriginEntry> {
      throwIfAborted(signal)
      /*
       * Both scopes resolve to the same place, and that is a statement, not a shortcut. A BIG is a
       * flat mount with no nesting: the mount the entry currently lives in and the container that
       * encloses it are the same namespace. A format where they differ (an archive inside an
       * archive) will need this backend to distinguish them, and the test suite pins today's
       * answer so that change is visible when it comes.
       */
      if (scope !== 'current-mount' && scope !== 'enclosing-container') return
      /*
       * The prefix goes straight to the container's own `list(prefix, …)`. This is the difference
       * between a bounded search and a scan: the installed StarCraft II CASC lists 666,588 entries,
       * and a requirement that names a directory reads a few hundred of them instead.
       */
      for (const entry of (await listing(enumeration.prefix, signal)).values()) {
        throwIfAborted(signal)
        yield Object.freeze({
          logicalId: entry.path,
          ...(entry.size === undefined ? {} : { size: entry.size }),
        })
      }
    },
    async open(logicalId: string, signal?: AbortSignal): Promise<Lease<ArtifactSource>> {
      throwIfAborted(signal)
      /*
       * The id itself is the narrowest possible prefix, and opening asks for one exact entry — so
       * the listing behind an open is one entry, not the directory it sits in. That mattered
       * measurably: resolving a StarCraft II texture read 4,101 entries when the open re-listed its
       * folder, and 2 once it stopped.
       */
      const entry = (await listing(logicalId, signal)).get(fold(logicalId))
      if (entry === undefined) {
        throw new ModkitError({
          code: NESTED_ENTRY_NOT_FOUND,
          message: `container has no entry «${logicalId}»`,
          context: { logicalId },
        })
      }
      // the container's own reference for this entry, held for as long as the source it names
      const refLease = await options.namespace.openEntry(entry.entryId, signal)
      let bytes: Uint8Array
      try {
        bytes = await options.extract(entry.entryId, signal)
      } catch (error) {
        await refLease.release()
        throw error
      }
      const source = containerEntrySource(
        refLease.value,
        containerEntryRevision(options.containerRevision, entry.entryId, bytes.byteLength),
        bytes,
      )
      return Object.freeze({ value: source, release: () => refLease.release() })
    },
  })
}

/**
 * Project a dependency-composed workspace onto the same host-private `CompanionOrigin` seam.
 *
 * The host knows only ordered prefixes. The StarCraft II provider decides that its roots expose
 * resources below `base.sc2assets`; another game can provide different prefixes without a branch
 * here. Enumeration strips each namespace prefix and can then add the workspace's logical prefix,
 * so standalone archives and nested maps both match the paths declared by their resolved graph;
 * provenance still comes from the exact namespace entry selected by workspace precedence.
 */
export function createWorkspaceNamespaceCompanionOrigin(
  options: WorkspaceNamespaceCompanionOriginOptions,
): CompanionOrigin {
  return createCompositeWorkspaceNamespaceCompanionOrigin({
    primaryLogicalId: options.primaryLogicalId,
    roots: options.logicalRoots.map(root => ({
      ...root,
      namespace: options.namespace,
      containerRevision: options.containerRevision,
      extract: options.extract,
    })),
    ...(options.caseSensitivity === undefined ? {} : { caseSensitivity: options.caseSensitivity }),
    ...(options.pageLimit === undefined ? {} : { pageLimit: options.pageLimit }),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
  })
}

/**
 * Project a dependency-composed workspace whose roots come from multiple opened containers.
 *
 * The caller owns every namespace lease and container session. This origin only retains their
 * capabilities until its enclosing ResourceSession is disposed, so release order stays with the
 * host adapter that acquired them.
 */
export function createCompositeWorkspaceNamespaceCompanionOrigin(
  options: CompositeWorkspaceNamespaceCompanionOriginOptions,
): CompanionOrigin {
  const pageLimit = options.pageLimit ?? 256
  const maxPages = options.maxPages ?? 4096
  const caseSensitivity = options.caseSensitivity ?? 'insensitive'
  const fold = (value: string): string =>
    caseSensitivity === 'insensitive' ? value.toLowerCase() : value
  const roots = options.roots.map(root => {
    const pathPrefix =
      root.pathPrefix === '' ? '' : normalizeCompanionLogicalId(root.pathPrefix).replace(/\/$/u, '')
    const logicalPrefix =
      root.logicalPrefix === undefined || root.logicalPrefix === ''
        ? ''
        : normalizeCompanionLogicalId(root.logicalPrefix).replace(/\/$/u, '')
    return Object.freeze({
      rootId: root.rootId,
      pathPrefix,
      logicalPrefix,
      namespace: root.namespace,
      containerRevision: root.containerRevision,
      extract: root.extract,
    })
  })
  if (roots.length === 0) throw new TypeError('workspace namespace origin requires a logical root')
  if (new Set(roots.map(root => root.rootId)).size !== roots.length) {
    throw new TypeError('workspace namespace origin root ids must differ')
  }
  type BoundIndexedEntry = IndexedEntry & {
    readonly namespace: NamespaceEntrySource
    readonly containerRevision: RevisionId
    readonly extract: (entryId: string, signal?: AbortSignal) => Promise<Uint8Array>
  }
  const byLogicalId = new Map<string, BoundIndexedEntry>()

  const pages = async function* (
    root: (typeof roots)[number],
    prefix: string,
    signal?: AbortSignal,
  ) {
    const spellings = [...new Set(prefix === '' ? [''] : [prefix, fold(prefix)])]
    for (const spelling of spellings) {
      let cursor: string | undefined
      let pageCount = 0
      const seenCursors = new Set<string>()
      do {
        throwIfAborted(signal)
        if (pageCount >= maxPages) {
          throw new RangeError(`workspace namespace prefix exceeds ${maxPages} pages`)
        }
        if (cursor !== undefined) {
          if (seenCursors.has(cursor)) {
            throw new RangeError('workspace namespace paging cursor repeated')
          }
          seenCursors.add(cursor)
        }
        const page = await root.namespace.list(
          spelling,
          cursor === undefined ? { limit: pageLimit } : { cursor, limit: pageLimit },
          signal,
        )
        yield* page.items
        pageCount += 1
        cursor = page.nextCursor
      } while (cursor !== undefined)
    }
  }

  const joinPrefix = (prefix: string, suffix: string): string =>
    prefix === '' ? suffix : suffix === '' ? prefix : `${prefix}/${suffix}`

  const relativeRequest = (
    root: { readonly logicalPrefix: string },
    logicalId: string,
  ): string | undefined => {
    if (logicalId === '') return ''
    if (root.logicalPrefix === '') return logicalId
    if (fold(logicalId) === fold(root.logicalPrefix)) return ''
    const prefix = `${root.logicalPrefix}/`
    return fold(logicalId).startsWith(fold(prefix)) ? logicalId.slice(prefix.length) : undefined
  }

  const remember = (root: (typeof roots)[number], entry: NamespaceEntry): string | undefined => {
    if (entry.kind !== 'file') return undefined
    const prefix = root.pathPrefix === '' ? '' : `${root.pathPrefix}/`
    if (prefix !== '' && !fold(entry.path).startsWith(fold(prefix))) return undefined
    const relative = prefix === '' ? entry.path : entry.path.slice(prefix.length)
    if (relative === '') return undefined
    const logicalId = joinPrefix(root.logicalPrefix, relative)
    const key = fold(logicalId)
    if (!byLogicalId.has(key)) {
      byLogicalId.set(key, {
        entryId: entry.id,
        path: entry.path,
        ...(entry.size === undefined ? {} : { size: entry.size }),
        revision: entry.revision,
        namespace: root.namespace,
        containerRevision: root.containerRevision,
        extract: root.extract,
      })
    }
    return logicalId
  }

  const find = async (
    logicalId: string,
    signal?: AbortSignal,
  ): Promise<BoundIndexedEntry | undefined> => {
    const key = fold(logicalId)
    const cached = byLogicalId.get(key)
    if (cached !== undefined) return cached
    for (const root of roots) {
      const relative = relativeRequest(root, logicalId)
      if (relative === undefined) continue
      for await (const entry of pages(root, joinPrefix(root.pathPrefix, relative), signal)) {
        const remembered = remember(root, entry)
        if (remembered !== undefined && fold(remembered) === key) return byLogicalId.get(key)
      }
    }
    return undefined
  }

  return Object.freeze({
    primaryLogicalId: options.primaryLogicalId,
    caseSensitivity,
    scopes: Object.freeze(['workspace-dependency-layer'] as const),
    async *enumerate(
      scope: InputSearchScope,
      enumeration: CompanionEnumerationOptions,
      signal?: AbortSignal,
    ): AsyncIterable<CompanionOriginEntry> {
      if (scope !== 'workspace-dependency-layer') return
      const yielded = new Set<string>()
      for (const root of roots) {
        const relative = relativeRequest(root, enumeration.prefix)
        if (relative === undefined) continue
        for await (const entry of pages(root, joinPrefix(root.pathPrefix, relative), signal)) {
          throwIfAborted(signal)
          const logicalId = remember(root, entry)
          if (logicalId === undefined || yielded.has(fold(logicalId))) continue
          yielded.add(fold(logicalId))
          yield Object.freeze({
            logicalId,
            ...(entry.size === undefined ? {} : { size: entry.size }),
          })
        }
      }
    },
    async open(logicalId: string, signal?: AbortSignal): Promise<Lease<ArtifactSource>> {
      throwIfAborted(signal)
      const entry = await find(logicalId, signal)
      if (entry === undefined) {
        throw new ModkitError({
          code: NESTED_ENTRY_NOT_FOUND,
          message: `workspace namespace has no entry «${logicalId}»`,
          context: { logicalId },
        })
      }
      const refLease = await entry.namespace.openEntry(entry.entryId, signal)
      let bytes: Uint8Array
      try {
        bytes = await entry.extract(entry.entryId, signal)
      } catch (error) {
        await refLease.release()
        throw error
      }
      return Object.freeze({
        value: containerEntrySource(
          refLease.value,
          containerEntryRevision(entry.containerRevision, entry.entryId, bytes.byteLength),
          bytes,
        ),
        release: () => refLease.release(),
      })
    },
  })
}

function positiveDiscoveryLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

/**
 * Enumerate one exact extension inside caller-owned workspace roots.
 *
 * This is deliberately not a path-derivation service. The game provider supplies both the logical
 * roots and every subtree that may be searched; the host only pages those explicit prefixes,
 * strips the already-declared root prefix and applies an exact extension suffix. Results are fully
 * collected before they are published. A page, entry, candidate, byte or revision-shape failure
 * therefore returns no partial candidates for a codec to accidentally attach.
 */
export function createWorkspaceNamespaceCandidateDiscovery(
  options: WorkspaceNamespaceCandidateDiscoveryOptions,
): WorkspaceNamespaceCandidateDiscovery {
  const pageItems = positiveDiscoveryLimit(options.limits.pageItems, 'pageItems')
  const maxPages = positiveDiscoveryLimit(options.limits.maxPages, 'maxPages')
  const maxEntries = positiveDiscoveryLimit(options.limits.maxEntries, 'maxEntries')
  const maxCandidates = positiveDiscoveryLimit(options.limits.maxCandidates, 'maxCandidates')
  if (typeof options.limits.maxBytes !== 'bigint' || options.limits.maxBytes < 0n) {
    throw new TypeError('maxBytes must be a non-negative bigint')
  }
  if (!/^\.[a-z0-9][a-z0-9_-]*$/iu.test(options.extension)) {
    throw new TypeError('candidate extension must be an exact dotted suffix without glob syntax')
  }
  const caseSensitivity = options.caseSensitivity ?? 'insensitive'
  const fold = (value: string): string =>
    caseSensitivity === 'insensitive' ? value.toLowerCase() : value
  const extension = fold(options.extension)
  const roots = options.logicalRoots.map((root, index) => {
    if (typeof root.rootId !== 'string' || root.rootId.trim() === '') {
      throw new TypeError(`logicalRoots[${index}].rootId must be a non-empty string`)
    }
    const pathPrefix = normalizeCompanionLogicalId(root.pathPrefix).replace(/\/$/u, '')
    return Object.freeze({ rootId: root.rootId, pathPrefix, rank: index })
  })
  if (roots.length === 0) throw new TypeError('candidate discovery requires a logical root')
  const rootsById = new Map(roots.map(root => [root.rootId, root]))
  if (rootsById.size !== roots.length)
    throw new TypeError('candidate discovery root ids must differ')
  if (options.searches.length === 0) {
    throw new TypeError('candidate discovery requires an explicit search root')
  }
  const searches = options.searches.map((search, index) => {
    const root = rootsById.get(search.rootId)
    if (root === undefined) {
      throw new TypeError(`searches[${index}] names unknown logical root «${search.rootId}»`)
    }
    if (typeof search.logicalPrefix !== 'string') {
      throw new TypeError(`searches[${index}].logicalPrefix must be a string`)
    }
    const logicalPrefix =
      search.logicalPrefix.trim() === ''
        ? ''
        : normalizeCompanionLogicalId(search.logicalPrefix).replace(/\/$/u, '')
    return Object.freeze({ root, logicalPrefix, rank: index })
  })
  const receiptSearches = Object.freeze(
    searches.map(search =>
      Object.freeze({ rootId: search.root.rootId, logicalPrefix: search.logicalPrefix }),
    ),
  )

  return Object.freeze({
    async discover(signal?: AbortSignal): Promise<WorkspaceNamespaceCandidateDiscoveryResult> {
      throwIfAborted(signal)
      let pages = 0
      let entries = 0
      let bytes = 0n
      const candidates = new Map<
        string,
        WorkspaceNamespaceDiscoveredCandidate & {
          readonly rootRank: number
          readonly searchRank: number
        }
      >()
      const receipt = (complete: boolean): WorkspaceNamespaceCandidateDiscoveryReceipt =>
        Object.freeze({
          complete,
          pages,
          entries,
          candidates: complete ? candidates.size : 0,
          bytes: complete ? bytes : 0n,
          searches: receiptSearches,
        })
      const refused = (
        reason: 'budget-exceeded' | 'namespace-invalid' | 'size-unavailable',
        message: string,
      ): WorkspaceNamespaceCandidateDiscoveryResult =>
        Object.freeze({
          state: 'refused' as const,
          reason,
          message,
          candidates: Object.freeze([]) as readonly [],
          receipt: receipt(false),
        })

      for (const search of searches) {
        const rootPrefix = `${search.root.pathPrefix}/`
        const namespacePrefix =
          search.logicalPrefix === ''
            ? rootPrefix
            : `${rootPrefix}${search.logicalPrefix.replace(/\/$/u, '')}/`
        const spellings = [
          ...new Set(
            caseSensitivity === 'insensitive'
              ? [namespacePrefix, fold(namespacePrefix)]
              : [namespacePrefix],
          ),
        ]
        for (const spelling of spellings) {
          let cursor: string | undefined
          const seenCursors = new Set<string>()
          do {
            throwIfAborted(signal)
            if (pages >= maxPages) {
              return refused(
                'budget-exceeded',
                `candidate discovery exceeded its ${maxPages}-page budget`,
              )
            }
            if (cursor !== undefined) {
              if (seenCursors.has(cursor)) {
                return refused('namespace-invalid', 'candidate discovery cursor repeated')
              }
              seenCursors.add(cursor)
            }
            const page = await options.namespace.list(
              spelling,
              cursor === undefined ? { limit: pageItems } : { cursor, limit: pageItems },
              signal,
            )
            pages += 1
            throwIfAborted(signal)
            if (
              page === null ||
              typeof page !== 'object' ||
              !Array.isArray(page.items) ||
              (page.nextCursor !== undefined &&
                (typeof page.nextCursor !== 'string' || page.nextCursor === ''))
            ) {
              return refused('namespace-invalid', 'candidate discovery received a malformed page')
            }
            if (page.items.length > pageItems) {
              return refused(
                'namespace-invalid',
                `candidate discovery page exceeded its requested ${pageItems}-entry limit`,
              )
            }
            for (const entry of page.items) {
              throwIfAborted(signal)
              if (
                entry === null ||
                typeof entry !== 'object' ||
                typeof entry.id !== 'string' ||
                entry.id === '' ||
                typeof entry.path !== 'string' ||
                entry.path === '' ||
                typeof entry.kind !== 'string'
              ) {
                return refused(
                  'namespace-invalid',
                  'candidate discovery received a malformed namespace entry',
                )
              }
              entries += 1
              if (entries > maxEntries) {
                return refused(
                  'budget-exceeded',
                  `candidate discovery exceeded its ${maxEntries}-entry budget`,
                )
              }
              if (entry.kind !== 'file' || !fold(entry.path).endsWith(extension)) continue
              if (!fold(entry.path).startsWith(fold(rootPrefix))) {
                return refused(
                  'namespace-invalid',
                  `namespace entry «${entry.path}» escaped logical root «${search.root.rootId}»`,
                )
              }
              const logicalId = entry.path.slice(rootPrefix.length)
              if (logicalId === '') continue
              const key = fold(logicalId)
              if (candidates.has(key)) continue
              if (
                entry.size === undefined ||
                typeof entry.size !== 'bigint' ||
                entry.size < 0n ||
                entry.size > BigInt(Number.MAX_SAFE_INTEGER)
              ) {
                return refused(
                  'size-unavailable',
                  `candidate «${logicalId}» has no bounded revision-safe size`,
                )
              }
              if (candidates.size >= maxCandidates) {
                return refused(
                  'budget-exceeded',
                  `candidate discovery exceeded its ${maxCandidates}-candidate budget`,
                )
              }
              if (bytes + entry.size > options.limits.maxBytes) {
                return refused(
                  'budget-exceeded',
                  `candidate discovery exceeded its ${options.limits.maxBytes}-byte budget`,
                )
              }
              bytes += entry.size
              candidates.set(
                key,
                Object.freeze({
                  logicalId,
                  expectedRevision: containerEntryRevision(
                    options.containerRevision,
                    entry.id,
                    Number(entry.size),
                  ),
                  size: entry.size,
                  rootId: search.root.rootId,
                  rootRank: search.root.rank,
                  searchRank: search.rank,
                }),
              )
            }
            cursor = page.nextCursor
          } while (cursor !== undefined)
        }
      }

      const ordered = [...candidates.values()]
        .sort(
          (left, right) =>
            left.rootRank - right.rootRank ||
            left.searchRank - right.searchRank ||
            (left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0),
        )
        .map(({ logicalId, expectedRevision, size, rootId }) =>
          Object.freeze({ logicalId, expectedRevision, size, rootId }),
        )
      return Object.freeze({
        state: 'complete' as const,
        candidates: Object.freeze(ordered),
        receipt: receipt(true),
      })
    },
  })
}

/**
 * The extracted entry as a byte source.
 *
 * Held in memory on purpose. A companion staged to a temporary file would be a different artifact
 * at a different path with a revision of its own, and the whole requirement of the archive case is
 * that the codec reads the entry that is *in the container* — so the bytes stay where the host can
 * still say which container revision they came out of.
 */
export function containerEntrySource(
  ref: AssetSourceRef,
  revision: RevisionId,
  bytes: Uint8Array,
): ArtifactByteSource {
  return Object.freeze({
    kind: 'bytes' as const,
    ref,
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
      throwIfAborted(signal)
      if (offset < 0n || !Number.isSafeInteger(length) || length < 0) {
        throw new ModkitError({
          code: 'x3.host/invalid-source-range',
          message: `container entry read of «${ref.uri}» must use a non-negative exact range`,
          context: { uri: ref.uri, offset: String(offset), length },
        })
      }
      if (offset > BigInt(bytes.byteLength)) {
        throw new ModkitError({
          code: 'x3.host/invalid-source-range',
          message: `container entry read of «${ref.uri}» starts beyond the entry size`,
          context: { uri: ref.uri, offset: String(offset), size: bytes.byteLength },
        })
      }
      const start = Number(offset)
      return bytes.slice(start, Math.min(bytes.byteLength, start + length))
    },
    async *stream(
      range?: { readonly offset: bigint; readonly length?: bigint },
      signal?: AbortSignal,
    ): AsyncIterable<Uint8Array> {
      throwIfAborted(signal)
      const start = Number(range?.offset ?? 0n)
      const end = range?.length === undefined ? bytes.byteLength : start + Number(range.length)
      yield bytes.slice(start, Math.min(bytes.byteLength, end))
    },
  })
}
