/**
 * Host-owned post-open resource resolution (block 11, slice 11C0, plan item 13).
 *
 * The companion resolver of block 9 answers "what did this subject need before it was opened".
 * This module answers the other question: "what did the projection discover *inside* it". A model
 * names its textures in its own data; nobody could have written those names into an input plan,
 * and yet a codec, projector, viewer or renderer still must not resolve them itself.
 *
 * It is built out of the same primitives on purpose. The backend is the very same host-private
 * `CompanionOrigin` — the filesystem one, the archive-namespace one, whatever comes third — and
 * confinement is the very same `normalizeCompanionLogicalId`, so a traversal that the pre-open
 * seam refuses is refused here for the same reason and with the same words. What is genuinely
 * different is the lifecycle: an `AssetInput` binding is pinned for the whole session, while a
 * resource lease is taken, held and released independently and repeatedly while the session
 * stays open. That difference is why this is a separate port rather than an alias of
 * `openBinding`, and it is the only thing about it that is new.
 *
 * Four rules, and each of them is a test:
 *
 * 1. **Named outcomes, never silent ones.** A missing texture is a typed `unresolved` result with
 *    a coded reason and a provenance record — never an empty array, never a thrown surprise. The
 *    honest answer "this model references a texture that lives somewhere this session cannot
 *    reach" is a first-class result, because for cross-archive game content it is the common one.
 * 2. **The budget is spent once.** A repeated lookup is served from the session's index, including
 *    a repeated *miss*: enumerating a 666,588-entry CASC twice to fail twice is not a bounded
 *    search.
 * 3. **Leases are the session's to clean up.** A caller that forgets to release still cannot leak:
 *    `dispose()` releases everything outstanding, and is idempotent.
 * 4. **The chain is finite.** A resource may name another resource; a resource may not, directly or
 *    transitively, name itself. The cycle is detected from the declared parent chain rather than
 *    discovered by running out of memory.
 */

import { diagnostic, isModkitError, throwIfAborted, type Diagnostic } from '@modkit/core'
import type {
  ArtifactSource,
  InputSearchScope,
  Lease,
  LogicalResourceRequirement,
  ResourceProvenanceRecord,
  ResourceResolution,
  ResourceSessionPort,
  ResourceSessionState,
  ResourceUnresolvedReason,
  RevisionId,
} from '@modkit/sdk'
import {
  COMPANION_PATH_REFUSED,
  normalizeCompanionLogicalId,
  type CompanionCaseSensitivity,
  type CompanionOrigin,
} from './input-resolution.js'

// ---------------------------------------------------------------------------------------------
// diagnostic codes

/** No entry in any served scope carries this logical id. */
export const RESOURCE_NOT_FOUND = 'x3.host/resource-not-found'
/** The session's allowlist does not admit this logical id. */
export const RESOURCE_NOT_ALLOWLISTED = 'x3.host/resource-not-allowlisted'
/** A logical id that is not a plain confined name (traversal, absolute, UNC, drive, NUL). */
export const RESOURCE_PATH_REFUSED = 'x3.host/resource-path-refused'
/** Every scope the requirement asked for is one this origin does not serve. */
export const RESOURCE_SCOPE_UNSUPPORTED = 'x3.host/resource-scope-unsupported'
/** Resource, byte, depth or entry limit reached. */
export const RESOURCE_BUDGET_EXCEEDED = 'x3.host/resource-budget-exceeded'
/** The declared parent chain already contains this logical id. */
export const RESOURCE_CYCLE_DETECTED = 'x3.host/resource-cycle-detected'
/** The session was disposed; it holds no leases and resolves nothing further. */
export const RESOURCE_SESSION_DISPOSED = 'x3.host/resource-session-disposed'

const REASON_CODES: Readonly<Record<ResourceUnresolvedReason, string>> = Object.freeze({
  'not-found': RESOURCE_NOT_FOUND,
  'not-allowlisted': RESOURCE_NOT_ALLOWLISTED,
  'path-refused': RESOURCE_PATH_REFUSED,
  'scope-unsupported': RESOURCE_SCOPE_UNSUPPORTED,
  'budget-exceeded': RESOURCE_BUDGET_EXCEEDED,
  'cycle-detected': RESOURCE_CYCLE_DETECTED,
  'session-disposed': RESOURCE_SESSION_DISPOSED,
})

/** The diagnostic code a given unresolved reason is reported under. */
export function resourceDiagnosticCode(reason: ResourceUnresolvedReason): string {
  return REASON_CODES[reason] ?? RESOURCE_NOT_FOUND
}

// ---------------------------------------------------------------------------------------------
// budgets

export interface ResourceSessionLimits {
  /** Distinct resources one session may hold open at once. */
  readonly maxResources: number
  /** Bytes the session may hand out in total, summed over resolved resources. */
  readonly maxBytes: bigint
  /** Depth of the resource-names-resource chain. */
  readonly maxDepth: number
  /** Entries the session will take from one scope before refusing to continue. */
  readonly maxEntries: number
}

export const DEFAULT_RESOURCE_SESSION_LIMITS: ResourceSessionLimits = Object.freeze({
  maxResources: 256,
  maxBytes: 256n * 1024n * 1024n,
  maxDepth: 8,
  maxEntries: 4096,
})

export interface ResourceSessionOptions {
  /**
   * The same host-private backend the pre-open seam resolves against.
   *
   * Host-private by construction: created by product wiring, closed over here, and never reaching
   * a codec, a projector or a public host export.
   */
  readonly origin: CompanionOrigin
  /** The resource plane every resolution in this session is pinned against. */
  readonly revision: RevisionId
  readonly sessionId?: string
  readonly limits?: Partial<ResourceSessionLimits>
  /**
   * Segment-aligned logical-id prefixes this session may resolve inside.
   *
   * Absent means "anything the confined origin serves", which is already a bounded set. Present
   * means a further narrowing, and it is segment-aligned on purpose: a bare string prefix would
   * make `assets/tex` admit `assets/textures-internal/…`, which is not what anyone writing that
   * line meant.
   */
  readonly allowlist?: readonly string[]
  readonly onDiagnostic?: (item: Diagnostic) => void
}

// ---------------------------------------------------------------------------------------------
// helpers

function fold(value: string, caseSensitivity: CompanionCaseSensitivity): string {
  return caseSensitivity === 'insensitive' ? value.toLowerCase() : value
}

/** Directory part of a logical id: the listing hint a large namespace needs to stay bounded. */
function prefixOf(logicalId: string): string {
  const cut = logicalId.lastIndexOf('/')
  return cut < 0 ? '' : logicalId.slice(0, cut + 1)
}

function allowed(logicalId: string, allowlist: readonly string[] | undefined): boolean {
  if (allowlist === undefined) return true
  return allowlist.some(entry => {
    if (entry === '') return true
    const normalized = entry.endsWith('/') ? entry : `${entry}/`
    return logicalId === entry || logicalId.startsWith(normalized)
  })
}

interface CacheEntry {
  /** The entry's own logical id as the backend spells it, or `undefined` for a proven miss. */
  readonly found: string | undefined
}

// ---------------------------------------------------------------------------------------------
// the session

/**
 * Create a post-open resource session over a host-private origin.
 *
 * The returned port is the only thing a projection ever sees: it has no enumeration surface, no
 * origin handle and no way to name anything the origin does not serve.
 */
export function createResourceSession(options: ResourceSessionOptions): ResourceSessionPort {
  const limits: ResourceSessionLimits = { ...DEFAULT_RESOURCE_SESSION_LIMITS, ...options.limits }
  const sessionId = options.sessionId ?? `resource-session-${String(options.revision)}`
  const origin = options.origin
  const provenance: ResourceProvenanceRecord[] = []
  const byRequirementId = new Map<string, ResourceProvenanceRecord>()
  const index = new Map<string, CacheEntry>()
  const held = new Set<Lease<ArtifactSource>>()
  let resources = 0
  let bytes = 0n
  let state: ResourceSessionState = 'live'
  // read through a call so a check before an `await` does not narrow the check after it: the value
  // changes underneath a resolution in flight, which is exactly the case this guards
  const disposed = (): boolean => state === 'disposed'

  const record = (
    requirement: LogicalResourceRequirement,
    entry: Omit<ResourceProvenanceRecord, 'requirementId' | 'logicalId' | 'role' | 'scopes'>,
  ): ResourceProvenanceRecord => {
    /*
     * Frozen, with its own copy of `scopes`, and both halves are load-bearing.
     *
     * This record is handed to the caller and kept by the session as the evidence a projection
     * receipt is built from. Sharing a mutable object between the two means the caller can rewrite
     * the session's own history — turn an `unresolved` into a `resolved`, or widen the scopes a
     * lookup is recorded as having searched — after the fact and without the host noticing. Sharing
     * the caller's `scopes` array is the same hole with an extra step: mutating it later would
     * retroactively change what the provenance says was searched.
     */
    const value: ResourceProvenanceRecord = Object.freeze({
      requirementId: requirement.id,
      logicalId: requirement.logicalId,
      role: requirement.role,
      scopes: Object.freeze([...requirement.scopes]),
      ...entry,
    })
    provenance.push(value)
    byRequirementId.set(requirement.id, value)
    return value
  }

  const unresolved = (
    requirement: LogicalResourceRequirement,
    reason: ResourceUnresolvedReason,
    message: string,
    cached = false,
  ): ResourceResolution => {
    const item = diagnostic(
      // an unreachable cross-archive texture is a fact about the corpus, not a defect in the model
      reason === 'not-found' ? 'information' : 'warning',
      resourceDiagnosticCode(reason),
      message,
      [requirement.id],
      {
        sessionId,
        logicalId: requirement.logicalId,
        role: requirement.role,
        scopes: [...requirement.scopes],
      },
    )
    options.onDiagnostic?.(item)
    return {
      state: 'unresolved',
      reason,
      diagnostic: item,
      provenance: record(requirement, { state: 'unresolved', reason, cached }),
    }
  }

  /** requirement id -> the requirement that named it, as the caller declared the link. */
  const parents = new Map<string, string>()

  /**
   * Walks the declared parent chain.
   *
   * Returns the chain's logical ids, or `undefined` when it is longer than the depth budget. A
   * parent id naming no known requirement ends the walk: the port refuses to invent a link it was
   * not told about. A loop in the parent map itself also ends it — the depth budget would catch
   * that too, but spinning to reach it would be a poor way to find out.
   */
  const chainOf = (requirement: LogicalResourceRequirement): readonly string[] | undefined => {
    const chain: string[] = []
    const seen = new Set<string>()
    let cursor = requirement.parentResourceId
    while (cursor !== undefined) {
      if (chain.length >= limits.maxDepth) return undefined
      if (seen.has(cursor)) break
      seen.add(cursor)
      const parent = byRequirementId.get(cursor)
      if (parent === undefined) break
      chain.push(parent.logicalId)
      cursor = parents.get(cursor)
    }
    return chain
  }

  const locate = async (
    normalized: string,
    scopes: readonly InputSearchScope[],
    signal: AbortSignal | undefined,
  ): Promise<{ readonly found: string | undefined; readonly overBudget: boolean }> => {
    const wanted = fold(normalized, origin.caseSensitivity)
    /*
     * A name is matched by name; a path is matched as a path.
     *
     * This is the block-9 companion rule, not a second one: a requirement spelled `fixture.tga`
     * carries no directory, so the model is naming a *file* and the host looks for that file
     * anywhere it serves; a requirement spelled `art/textures/fixture.tga` is naming a place and
     * only that place will do. Matching the whole id in both cases is what the port used to do, and
     * it made the same reference resolve through the pre-open seam and miss through this one — two
     * resolvers disagreeing, which is the exact thing plan item 13 says this port must not become.
     * The CASC case never caught it because SC2 spells its texture references as paths.
     */
    const byName = !normalized.includes('/')
    let entries = 0
    for (const scope of scopes) {
      throwIfAborted(signal)
      for await (const entry of origin.enumerate(scope, { prefix: prefixOf(normalized) }, signal)) {
        entries += 1
        if (entries > limits.maxEntries) return { found: undefined, overBudget: true }
        const candidate = byName
          ? (entry.logicalId.split('/').at(-1) ?? entry.logicalId)
          : entry.logicalId
        if (fold(candidate, origin.caseSensitivity) === wanted) {
          return { found: entry.logicalId, overBudget: false }
        }
      }
    }
    return { found: undefined, overBudget: false }
  }

  return {
    sessionId,
    revision: options.revision,
    state: () => state,

    async resolve(requirement, signal) {
      if (state === 'disposed') {
        return unresolved(
          requirement,
          'session-disposed',
          `resource session ${sessionId} is disposed and resolves nothing further`,
        )
      }
      throwIfAborted(signal)
      if (requirement.parentResourceId !== undefined) {
        parents.set(requirement.id, requirement.parentResourceId)
      }

      let normalized: string
      try {
        normalized = normalizeCompanionLogicalId(requirement.logicalId, {
          sessionId,
          requirementId: requirement.id,
        })
      } catch (error) {
        if (isModkitError(error) && error.code === COMPANION_PATH_REFUSED) {
          return unresolved(requirement, 'path-refused', error.message)
        }
        throw error
      }

      const chain = chainOf(requirement)
      if (chain === undefined) {
        return unresolved(
          requirement,
          'budget-exceeded',
          `resource chain for «${requirement.logicalId}» is deeper than the session depth budget of ${limits.maxDepth}`,
        )
      }
      if (
        chain.some(
          item => fold(item, origin.caseSensitivity) === fold(normalized, origin.caseSensitivity),
        )
      ) {
        return unresolved(
          requirement,
          'cycle-detected',
          `resource «${requirement.logicalId}» is already in its own reference chain: ${[...chain, requirement.logicalId].join(' -> ')}`,
        )
      }

      if (!allowed(normalized, options.allowlist)) {
        return unresolved(
          requirement,
          'not-allowlisted',
          `resource «${requirement.logicalId}» is outside every allowlisted prefix of this session`,
        )
      }

      const servedScopes = requirement.scopes.filter(scope => origin.scopes.includes(scope))
      if (servedScopes.length === 0) {
        return unresolved(
          requirement,
          'scope-unsupported',
          `this origin serves ${origin.scopes.join(', ')}; the requirement asked only for ${requirement.scopes.join(', ')}`,
        )
      }

      const key = fold(normalized, origin.caseSensitivity)
      const cached = index.get(key)
      let found: string | undefined
      if (cached !== undefined) {
        found = cached.found
        if (found === undefined) {
          return unresolved(
            requirement,
            'not-found',
            `resource «${requirement.logicalId}» is not in any scope this session serves`,
            true,
          )
        }
      } else {
        const located = await locate(normalized, servedScopes, signal)
        if (located.overBudget) {
          return unresolved(
            requirement,
            'budget-exceeded',
            `locating «${requirement.logicalId}» exceeded the session entry budget of ${limits.maxEntries}`,
          )
        }
        index.set(key, { found: located.found })
        found = located.found
        if (found === undefined) {
          return unresolved(
            requirement,
            'not-found',
            `resource «${requirement.logicalId}» is not in any scope this session serves`,
          )
        }
      }

      if (resources >= limits.maxResources) {
        return unresolved(
          requirement,
          'budget-exceeded',
          `this session already holds ${resources} resources, its limit`,
        )
      }

      throwIfAborted(signal)
      const originLease = await origin.open(found, signal)
      /*
       * The session may have been disposed while this open was in flight.
       *
       * `dispose()` releases what the session held *at that instant*; a resolution that was already
       * past the disposal check keeps going and comes back holding a lease nobody will ever release
       * — sixty-four concurrent resolutions torn down mid-burst stranded sixty-four leases, which is
       * what the block-12 teardown case found. Re-checking after the await is the whole fix: the
       * lease this call owns is released by this call, and the caller gets the same coded outcome a
       * late request would have got.
       */
      if (disposed()) {
        await originLease.release()
        return unresolved(
          requirement,
          'session-disposed',
          `resource session ${sessionId} was disposed while «${requirement.logicalId}» was being opened`,
        )
      }
      const size = originLease.value.kind === 'bytes' ? (originLease.value.size ?? 0n) : 0n
      if (bytes + size > limits.maxBytes) {
        await originLease.release()
        return unresolved(
          requirement,
          'budget-exceeded',
          `resolving «${requirement.logicalId}» would exceed the session byte budget of ${limits.maxBytes}`,
        )
      }
      let released = false
      const lease: Lease<ArtifactSource> = {
        value: originLease.value,
        async release() {
          if (released) return
          released = true
          held.delete(lease)
          resources -= 1
          bytes -= size
          await originLease.release()
        },
      }
      held.add(lease)
      resources += 1
      bytes += size
      return {
        state: 'resolved',
        lease,
        revision: lease.value.revision,
        provenance: record(requirement, {
          state: 'resolved',
          revision: lease.value.revision,
          bytes: size,
          cached: cached !== undefined,
        }),
      }
    },

    provenance: () => Object.freeze([...provenance]),

    async dispose() {
      if (state === 'disposed') return
      state = 'disposed'
      const outstanding = [...held]
      held.clear()
      // every lease is released even if one of them throws: a failed release must not strand the rest
      const results = await Promise.allSettled(outstanding.map(lease => lease.release()))
      const failure = results.find(result => result.status === 'rejected')
      if (failure !== undefined && failure.status === 'rejected') throw failure.reason
    },
  }
}
