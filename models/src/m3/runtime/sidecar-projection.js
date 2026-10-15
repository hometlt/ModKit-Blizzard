import { CANCELLED_CODE, throwIfAborted } from '@modkit/core'
import { decodeM3Animations } from './animation.js'
import { decodeM3Attachments } from './attachments.js'
import { decodeM3Skeleton } from './skeleton.js'
import { decodeM3Materials } from './material.js'
import { m3SiblingStemAssociation } from '../../../dist/m3/uvm/material-binding.js'

const MAX_SIDECARS = 64

function diagnostic(code, message, severity = 'warning') {
  return Object.freeze({
    id: `x3.m3/${code}`,
    code: `x3.m3/${code}`,
    category: 'dependency',
    severity,
    message,
  })
}

function skeletonsCompatible(base, sidecar, nativeBinding) {
  if (base.fatal || sidecar.fatal) return false
  // MK2 permits a material-only bundle without BONE entries. A decoder refusal which merely
  // returned an empty table is not evidence of an authored empty skeleton.
  if (nativeBinding && sidecar.bones.length === 0) return sidecar.issues.length === 0
  if (base.bones.length !== sidecar.bones.length) return false
  return base.bones.every((bone, index) => {
    const other = sidecar.bones[index]
    return other?.parentIndex === bone.parentIndex && other.name === bone.name
  })
}

async function exactBytes(source, budget, totalBytes, signal, logicalId, aggregateInput) {
  if (source.kind !== 'bytes') {
    throw new TypeError(`M3A «${logicalId}» did not resolve to a byte source`)
  }
  const size = source.size
  if (typeof size !== 'bigint' || size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`M3A «${logicalId}» has no bounded readable size`)
  }
  if (
    size > budget.maxInputBytes ||
    totalBytes + size > BigInt(budget.maxScalarBytes) ||
    (aggregateInput && totalBytes + size > budget.maxInputBytes)
  ) {
    throw new RangeError(`M3A «${logicalId}» exceeds the sidecar byte budget`)
  }
  const bytes = await source.read(0n, Number(size), signal)
  throwIfAborted(signal)
  if (!(bytes instanceof Uint8Array) || BigInt(bytes.byteLength) !== size) {
    throw new TypeError(`M3A «${logicalId}» returned a short read`)
  }
  return Uint8Array.from(bytes)
}

/**
 * Resolve exact, caller-supplied M3A logical ids through `ResourceSessionPort` and project their
 * verified clips. It never lists directories or infers identity from an ambient URI. The original
 * projection-only route requires a hash, matching skeleton and sampleable channels. The native
 * source route preserves every valid sequence, permits an authored empty bundle skeleton and
 * applies the exact MK2 sibling-stem predicate only with a host-attested naming context when the
 * base has no hashes. Explicit authored companions may differ in hash only after their typed
 * animIds bind unambiguously to the base; hashes remain provenance, not a rig identity proof.
 * `includeSources` retains private source snapshots, material tracks and exact native sequence
 * indices for the UVM mapper. Optional host readBatch owns deadlines, ordering and lease cleanup.
 * Callers that already publish base decoder issues may set `includeBaseDiagnostics` to false;
 * standalone calls retain them. Candidate diagnostic identities always name their logical source.
 */
export async function resolveM3AnimationSidecars({
  baseBytes,
  candidates,
  resources,
  budget,
  signal,
  includeSources = false,
  includeBaseDiagnostics = true,
  bindingContext,
  animationNames,
}) {
  throwIfAborted(signal)
  if (!Array.isArray(candidates) || candidates.length > Math.min(MAX_SIDECARS, budget.maxNodes)) {
    throw new RangeError(`M3A candidates exceed the ${MAX_SIDECARS}-sidecar budget`)
  }
  const ids = new Set()
  const capturedCandidates = candidates.map((candidate, index) => {
    if (typeof candidate?.logicalId !== 'string' || candidate.logicalId.trim() === '') {
      throw new TypeError(`M3A candidate ${index} needs an exact logicalId`)
    }
    if (ids.has(candidate.logicalId)) {
      throw new TypeError(`M3A candidates contain duplicate logicalId «${candidate.logicalId}»`)
    }
    ids.add(candidate.logicalId)
    return Object.freeze({
      logicalId: candidate.logicalId,
      expectedRevision: candidate.expectedRevision,
      size: candidate.size,
      rootId: candidate.rootId,
      scopes: Object.freeze([
        ...(candidate.scopes === undefined ? ['workspace-dependency-layer'] : candidate.scopes),
      ]),
    })
  })
  const baseSnapshot = includeSources ? Uint8Array.from(baseBytes) : baseBytes
  const baseAttachments = await decodeM3Attachments(baseSnapshot, budget, signal)
  const baseSkeleton = await decodeM3Skeleton(baseSnapshot, budget, signal)
  const acceptedHashes = new Set(baseAttachments.animationHashes)
  const clips = []
  const references = []
  const accepted = []
  const diagnostics = includeBaseDiagnostics
    ? [...baseAttachments.issues, ...baseSkeleton.issues]
    : []
  let totalBytes = includeSources ? BigInt(baseSnapshot.byteLength) : 0n
  const finish = async (admissionComplete = true) => {
    const provenance = await resources.provenance(signal)
    throwIfAborted(signal)
    return Object.freeze({
      clips: Object.freeze(admissionComplete ? clips : []),
      references: Object.freeze(admissionComplete ? references : []),
      accepted: Object.freeze(admissionComplete ? accepted : []),
      diagnostics: Object.freeze(diagnostics),
      provenance,
      ...(includeSources ? { admissionComplete } : {}),
    })
  }

  if (baseAttachments.fatal || baseSkeleton.fatal) {
    diagnostics.push(
      diagnostic('m3a-base-refused', 'the base M3 attachment hashes or skeleton were refused'),
    )
    return finish(false)
  }
  let batch
  if (includeSources && typeof resources.readBatch === 'function') {
    const ceiling =
      budget.maxInputBytes < BigInt(budget.maxScalarBytes)
        ? budget.maxInputBytes
        : BigInt(budget.maxScalarBytes)
    if (totalBytes > ceiling) {
      diagnostics.push(
        diagnostic(
          'm3a-sidecar-budget-exceeded',
          'M3 base exceeds the aggregate source byte budget',
        ),
      )
      return finish(false)
    }
    batch = await resources.readBatch(
      {
        items: capturedCandidates.map((candidate, index) => ({
          requirement: {
            id: `m3a-${index}`,
            logicalId: candidate.logicalId,
            role: 'sidecar',
            scopes: candidate.scopes,
          },
          ...(candidate.expectedRevision === undefined
            ? {}
            : { expectedRevision: candidate.expectedRevision }),
          ...(candidate.size === undefined ? {} : { size: candidate.size }),
        })),
        concurrency: 4,
        readTimeoutMs: 8000,
        totalTimeoutMs: 10000,
        maxBytes: ceiling - totalBytes,
      },
      signal,
    )
    throwIfAborted(signal)
    if (batch?.state === 'refused') {
      const code =
        batch.reason === 'source-revision-changed'
          ? 'm3a-sidecar-stale'
          : batch.reason === 'budget-exceeded'
            ? 'm3a-sidecar-budget-exceeded'
            : `m3a-batch-${batch.reason}`
      diagnostics.push(diagnostic(code, batch.message))
      return finish(false)
    }
    if (
      batch?.state !== 'complete' ||
      !Array.isArray(batch.items) ||
      batch.items.length !== capturedCandidates.length
    )
      throw new TypeError('M3A bounded read returned an incomplete indexed batch')
  }

  for (const [candidateIndex, candidate] of capturedCandidates.entries()) {
    throwIfAborted(signal)
    let diagnosticIndex = 0
    const addDiagnostics = (...issues) => {
      diagnostics.push(
        ...issues.map(item =>
          Object.freeze({
            ...item,
            id: `m3a:${encodeURIComponent(candidate.logicalId)}:diagnostic-${diagnosticIndex++}:${item.id ?? item.code}`,
          }),
        ),
      )
    }
    const result =
      batch === undefined
        ? await resources.resolve(
            {
              id: `m3a-${candidateIndex}`,
              logicalId: candidate.logicalId,
              role: 'sidecar',
              scopes: candidate.scopes,
            },
            signal,
          )
        : batch.items[candidateIndex]
    if (result.state === 'unresolved') {
      addDiagnostics(
        diagnostic(
          'm3a-sidecar-unavailable',
          `M3A «${candidate.logicalId}» was ${result.reason}`,
          'information',
        ),
      )
      if (
        ['permission-missing', 'source-revision-changed', 'session-disposed'].includes(
          result.reason,
        ) ||
        (includeSources && ['budget-exceeded', 'size-mismatch'].includes(result.reason))
      ) {
        return finish(false)
      }
      continue
    }
    try {
      throwIfAborted(signal)
      if (
        candidate.expectedRevision !== undefined &&
        String(candidate.expectedRevision) !== String(result.revision)
      ) {
        addDiagnostics(
          diagnostic(
            'm3a-sidecar-stale',
            `M3A «${candidate.logicalId}» resolved at ${String(result.revision)}, not the expected revision`,
          ),
        )
        return await finish(false)
      }
      let bytes
      try {
        if (batch !== undefined) {
          if (result.state !== 'read' || !(result.bytes instanceof Uint8Array))
            throw new TypeError('M3A bounded read returned an invalid byte outcome')
          const size = BigInt(result.bytes.byteLength)
          if (
            totalBytes + size > budget.maxInputBytes ||
            totalBytes + size > BigInt(budget.maxScalarBytes)
          )
            throw new RangeError('M3A bounded read exceeds the aggregate source byte budget')
          bytes = Uint8Array.from(result.bytes)
        } else
          bytes = await exactBytes(
            result.lease.value,
            budget,
            totalBytes,
            signal,
            candidate.logicalId,
            includeSources,
          )
      } catch (error) {
        throwIfAborted(signal)
        if (error?.code === CANCELLED_CODE || error?.name === 'AbortError') throw error
        addDiagnostics(
          diagnostic(
            error instanceof RangeError ? 'm3a-sidecar-budget-exceeded' : 'm3a-sidecar-read-failed',
            error instanceof Error
              ? error.message
              : `M3A «${candidate.logicalId}» could not be read`,
          ),
        )
        return await finish(false)
      }
      totalBytes += BigInt(bytes.byteLength)
      if (candidate.size !== undefined && BigInt(bytes.byteLength) !== candidate.size) {
        addDiagnostics(
          diagnostic(
            'm3a-sidecar-stale',
            `M3A «${candidate.logicalId}» changed its discovered size`,
          ),
        )
        return await finish(false)
      }
      if (
        includeSources &&
        bytes.byteLength === baseSnapshot.byteLength &&
        bytes.every((value, index) => value === baseSnapshot[index])
      ) {
        addDiagnostics(
          diagnostic(
            'm3a-sidecar-self-reference',
            `M3A «${candidate.logicalId}» repeats the base source bytes`,
          ),
        )
        continue
      }
      const [sidecarAttachments, sidecarSkeleton, animation, material] = await Promise.all([
        decodeM3Attachments(bytes, budget, signal),
        decodeM3Skeleton(bytes, budget, signal),
        decodeM3Animations(bytes, budget, signal, undefined, animationNames),
        includeSources ? decodeM3Materials(bytes, budget, signal) : undefined,
      ])
      const issues = [
        ...sidecarAttachments.issues,
        ...sidecarSkeleton.issues,
        ...animation.issues,
        ...(material?.issues ?? []),
      ]
      addDiagnostics(...issues)
      if (includeSources && issues.some(item => item.code.endsWith('-budget-exceeded')))
        return await finish(false)
      if (sidecarAttachments.fatal || sidecarSkeleton.fatal || animation.fatal || material?.fatal) {
        addDiagnostics(
          diagnostic('m3a-sidecar-parse-failed', `M3A «${candidate.logicalId}» was refused`),
        )
        continue
      }
      const hashMatched = sidecarAttachments.animationHashes.some(hash => acceptedHashes.has(hash))
      const stemMatched =
        includeSources &&
        acceptedHashes.size === 0 &&
        typeof bindingContext?.primaryLogicalId === 'string' &&
        (bindingContext.rootId === undefined || bindingContext.rootId === candidate.rootId) &&
        m3SiblingStemAssociation(bindingContext.primaryLogicalId, candidate.logicalId)
      const explicitlyBound = includeSources && bindingContext?.explicit === true
      if (!hashMatched && !stemMatched && !explicitlyBound) {
        addDiagnostics(
          diagnostic(
            'm3a-sidecar-hash-mismatch',
            `M3A «${candidate.logicalId}» does not match an explicit base-model animation hash`,
          ),
        )
        continue
      }
      const bindByAnimId = includeSources && bindingContext?.explicit === true
      const unusedSubset = bindByAnimId && animationNames !== undefined && animation.clips.length === 0
      let boundAnimation
      if (bindByAnimId && (!unusedSubset || !hashMatched)) {
        // An unused selection cannot establish compatibility; verify the whole companion before
        // admitting a different-hash dependency, without publishing its unrequested poses.
        boundAnimation = await decodeM3Animations(bytes, budget, signal, baseSnapshot, unusedSubset ? undefined : animationNames)
        addDiagnostics(...boundAnimation.issues)
        if (boundAnimation.fatal || !boundAnimation.clips.some(c => c.channels.some(ch => ['translation','rotation','scale'].includes(ch.kind)))) {
          addDiagnostics(diagnostic('m3a-animid-binding-refused', `M3A «${candidate.logicalId}» has no unambiguous typed base animation binding`))
          continue
        }
      }
      // A presentation subset may not use anything in this authored bundle. Its native source
      // still passed the readers/budgets; retain the dependency receipt without inventing a pose.
      if (unusedSubset) {
        references.push(Object.freeze({ id: candidate.logicalId, role: 'sidecar', provenance: 'companion', bytes: bytes.byteLength }))
        accepted.push(Object.freeze({ logicalId: candidate.logicalId, revision: result.revision,
          bytes: bytes.byteLength, hashes: sidecarAttachments.animationHashes, clips: 0,
          sourceBytes: bytes, boundClips: [], bindingReport: { mode: 'native-animid', selectedSequences: 0, completeness: 'partial' } }))
        continue
      }
      if (!bindByAnimId && !skeletonsCompatible(baseSkeleton, sidecarSkeleton, includeSources)) {
        addDiagnostics(
          diagnostic(
            'm3a-sidecar-skeleton-mismatch',
            `M3A «${candidate.logicalId}» uses an incompatible skeleton`,
          ),
        )
        continue
      }
      const selected = animation.clips.flatMap((clip, index) =>
        includeSources || clip.channels.length > 0
          ? [{ clip, nativeSequenceIndex: animation.nativeSequenceIndices?.[index] }]
          : [],
      )
      if (selected.length === 0) {
        addDiagnostics(
          diagnostic(
            'm3a-sidecar-no-animations',
            `M3A «${candidate.logicalId}» publishes no ${includeSources ? 'valid native sequences' : 'executable animation channels'}`,
          ),
        )
        continue
      }
      if (
        includeSources &&
        selected.some(
          item => !Number.isSafeInteger(item.nativeSequenceIndex) || item.nativeSequenceIndex < 0,
        )
      )
        throw new TypeError(`M3A «${candidate.logicalId}» lacks an exact native sequence map`)
      const clipIds = selected.map(({ clip }, clipIndex) =>
        includeSources
          ? `m3a:${encodeURIComponent(candidate.logicalId)}:${clip.id}`
          : `m3a-${candidateIndex}-sequence-${clipIndex}`,
      )
      if (new Set(clipIds).size !== clipIds.length) {
        throw new TypeError(`M3A «${candidate.logicalId}» publishes duplicate clip ids`)
      }
      clips.push(
        ...selected.map(({ clip }, clipIndex) =>
          Object.freeze({
            ...clip,
            id: clipIds[clipIndex],
            provenance: 'companion',
          }),
        ),
      )
      references.push(
        Object.freeze({
          id: candidate.logicalId,
          role: 'sidecar',
          provenance: 'companion',
          bytes: bytes.byteLength,
        }),
      )
      accepted.push(
        Object.freeze({
          logicalId: candidate.logicalId,
          revision: result.revision,
          bytes: bytes.byteLength,
          hashes: sidecarAttachments.animationHashes,
          clips: selected.length,
          ...(includeSources
            ? {
                sourceBytes: bytes,
                ...(boundAnimation === undefined ? {} : {
                  boundClips: boundAnimation.clips,
                  bindingReport: {
                    mode: 'native-animid',
                    boundaryResampledChannels: boundAnimation.boundaryResampledChannels,
                    sourceBoneChannels: animation.clips.reduce((sum,c)=>sum+c.channels.filter(ch=>['translation','rotation','scale'].includes(ch.kind)).length,0),
                    boundBoneChannels: boundAnimation.clips.reduce((sum,c)=>sum+c.channels.filter(ch=>['translation','rotation','scale'].includes(ch.kind)).length,0),
                    nonTrsChannels: boundAnimation.clips.reduce((sum,c)=>sum+c.channels.filter(ch=>!['translation','rotation','scale'].includes(ch.kind)).length,0),
                    residualTracks: boundAnimation.residualAnimationTracks.length,
                  },
                }),
                clipIds: Object.freeze(clipIds),
                nativeSequenceIndices: Object.freeze(
                  selected.map(item => item.nativeSequenceIndex),
                ),
                materials: material?.materials ?? [],
                binding: hashMatched ? 'hash' : explicitlyBound ? 'explicit-animid' : 'sibling-stem',
                declaredSequences: animation.declaredSequences,
                supportedChannels: selected.reduce(
                  (sum, { clip }) => sum + clip.channels.length,
                  0,
                ),
                unsupportedChannels: animation.unsupportedChannels,
                decodedBytes: animation.decodedBytes,
              }
            : {}),
        }),
      )
    } finally {
      if (batch === undefined) await result.lease.release()
    }
  }
  return finish()
}

function refusedDiscovery(receipt, code, message, severity = 'warning') {
  return Object.freeze({
    clips: Object.freeze([]),
    references: Object.freeze([]),
    accepted: Object.freeze([]),
    diagnostics: Object.freeze([diagnostic(code, message, severity)]),
    // This discovery attempt opened no resource. An unavailable origin cannot serve provenance;
    // requesting it would turn a readable base with no origin into a failed subject open.
    provenance: Object.freeze([]),
    discovery: receipt,
  })
}

/**
 * Discover M3A candidates inside caller-owned logical roots and admit them through the exact same
 * native hash/stem and skeleton gates as explicit candidates.
 *
 * `candidateDiscovery` is a host-owned namespace adapter. The codec sees public logical identities,
 * never derives a filesystem path and never broadens the roots selected by the game provider.
 * Candidate lookup scopes are selected by that host policy; omitted scopes preserve the original
 * workspace namespace route. The resource origin still decides which scopes it can serve.
 * Discovery must finish completely before any candidate is opened; a truncated namespace result
 * therefore cannot attach an arbitrary prefix of the available sidecars.
 */
export async function discoverM3AnimationSidecars({
  baseBytes,
  candidateDiscovery,
  resources,
  budget,
  signal,
  includeSources = false,
  includeBaseDiagnostics = true,
}) {
  throwIfAborted(signal)
  if (typeof candidateDiscovery?.discover !== 'function') {
    throw new TypeError('M3A discovery requires a candidate discovery port')
  }
  const baseSnapshot = includeSources ? Uint8Array.from(baseBytes) : baseBytes
  const discovered = await candidateDiscovery.discover(signal)
  throwIfAborted(signal)
  if (discovered?.state === 'refused') {
    return refusedDiscovery(
      discovered.receipt,
      `m3a-discovery-${discovered.reason}`,
      discovered.message,
    )
  }
  if (discovered?.state !== 'complete' || !Array.isArray(discovered.candidates)) {
    throw new TypeError('M3A candidate discovery returned an invalid result')
  }
  const receipt = Object.freeze({ ...discovered.receipt })
  if (
    discovered.receipt?.complete !== true ||
    discovered.receipt.candidates !== discovered.candidates.length ||
    typeof discovered.receipt.bytes !== 'bigint'
  ) {
    return refusedDiscovery(
      discovered.receipt,
      'm3a-discovery-namespace-invalid',
      'M3A candidate discovery returned an incomplete or inconsistent receipt',
    )
  }
  if (discovered.candidates.length === 0) {
    return refusedDiscovery(
      discovered.receipt,
      'm3a-discovery-empty',
      'the caller-owned logical roots contain no M3A candidates',
      'information',
    )
  }
  const maxCandidates = Math.min(MAX_SIDECARS, budget.maxNodes)
  if (discovered.candidates.length > maxCandidates) {
    return refusedDiscovery(
      discovered.receipt,
      'm3a-discovery-budget-exceeded',
      `M3A discovery returned more than ${maxCandidates} candidates`,
    )
  }
  let totalBytes = 0n
  const baseByteLength = includeSources ? BigInt(baseSnapshot.byteLength) : 0n
  const ids = new Set()
  for (const [index, candidate] of discovered.candidates.entries()) {
    throwIfAborted(signal)
    if (
      typeof candidate?.logicalId !== 'string' ||
      candidate.logicalId.trim() === '' ||
      typeof candidate.expectedRevision !== 'string' ||
      candidate.expectedRevision.trim() === '' ||
      typeof candidate.size !== 'bigint' ||
      candidate.size < 0n
    ) {
      throw new TypeError(`M3A discovered candidate ${index} is invalid`)
    }
    if (ids.has(candidate.logicalId)) {
      return refusedDiscovery(
        discovered.receipt,
        'm3a-discovery-namespace-invalid',
        `M3A discovery returned duplicate logicalId «${candidate.logicalId}»`,
      )
    }
    ids.add(candidate.logicalId)
    totalBytes += candidate.size
    if (
      candidate.size > budget.maxInputBytes ||
      baseByteLength + totalBytes > BigInt(budget.maxScalarBytes) ||
      (includeSources && baseByteLength + totalBytes > budget.maxInputBytes)
    ) {
      return refusedDiscovery(
        discovered.receipt,
        'm3a-discovery-budget-exceeded',
        includeSources
          ? 'M3 base plus all discovered M3A source bytes exceed the codec byte budget'
          : 'M3A discovery exceeds the codec byte budget',
      )
    }
  }
  if (totalBytes !== discovered.receipt.bytes) {
    return refusedDiscovery(
      discovered.receipt,
      'm3a-discovery-namespace-invalid',
      'M3A candidate discovery byte receipt did not match its candidates',
    )
  }
  const resolved = await resolveM3AnimationSidecars({
    baseBytes: baseSnapshot,
    candidates: discovered.candidates.map(candidate => ({
      logicalId: candidate.logicalId,
      expectedRevision: candidate.expectedRevision,
      size: candidate.size,
      ...(candidate.rootId === undefined ? {} : { rootId: candidate.rootId }),
      ...(candidate.scopes === undefined ? {} : { scopes: candidate.scopes }),
    })),
    resources,
    budget,
    signal,
    includeSources,
    includeBaseDiagnostics,
    ...(includeSources && discovered.context !== undefined
      ? { bindingContext: Object.freeze({ ...discovered.context }) }
      : {}),
  })
  return Object.freeze({
    ...resolved,
    discovery: receipt,
    ...(includeSources && discovered.context !== undefined
      ? { bindingContext: Object.freeze({ ...discovered.context }) }
      : {}),
  })
}
