import { decodeStructuredText } from '../../../inspection/structured-text.js'

const PROVIDER_ID = 'blizzard/sc2-authored-text-writers'
const encoder = new TextEncoder()

const error = (code, message) => Object.freeze({ severity: 'error', code, message })

const abort = signal => {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function payloadBytes(payload) {
  if (payload.kind === 'text') return encoder.encode(payload.text)
  if (payload.kind === 'inline') return payload.bytes
  throw new TypeError('SC2 authored text writers require an inline complete source snapshot')
}

function relativePath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path)
  ) {
    throw new TypeError('SC2 authored-text create path must be portable and relative')
  }
  if (path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError('SC2 authored-text create path contains traversal or an empty segment')
  }
  return path
}

function validationOf(specification, change, context, signal) {
  abort(context.signal)
  abort(signal)
  const diagnostics = []
  if (change.targets.length === 0 || change.edits.length !== 1) {
    diagnostics.push(
      error(
        'blizzard/sc2-writer-single-snapshot-required',
        'an SC2 authored-text save requires one complete-source mutation and one or more revision targets',
      ),
    )
    return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics) })
  }
  const edit = change.edits[0]
  const target = change.targets.find(candidate => candidate.targetId === edit.targetId)
  if (
    target === undefined ||
    !['replace', 'create'].includes(edit.operation) ||
    (edit.operation === 'replace' && edit.range !== undefined) ||
    (edit.operation === 'create' && specification.formatId !== 'sc2-data') ||
    (edit.operation === 'create' && target.expectedRevision.namespaceRevision === undefined) ||
    edit.source.id !== target.ownerSource.id
  ) {
    diagnostics.push(
      error(
        'blizzard/sc2-writer-edit-shape-unsupported',
        'SC2 authored-text saves accept one whole-source replace, or a GameData create inside a revision-pinned namespace',
      ),
    )
    return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics) })
  }
  if (new Set(change.targets.map(candidate => candidate.targetId)).size !== change.targets.length) {
    diagnostics.push(
      error(
        'blizzard/sc2-writer-target-duplicate',
        'SC2 authored-text revision targets must be unique',
      ),
    )
    return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics) })
  }
  const intent = record(change.semanticIntent)
  if (
    intent?.kind !== 'sc2-authored-text-save-v1' ||
    intent.formatId !== specification.formatId ||
    intent.sourceComplete !== true ||
    intent.unknownDataPolicy !== 'preserve-from-complete-snapshot'
  ) {
    diagnostics.push(
      error(
        'blizzard/sc2-writer-complete-snapshot-required',
        'the writer requires a complete source snapshot and the preserve-from-complete-snapshot policy',
      ),
    )
    return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics) })
  }
  if (specification.formatId === 'sc2-bank' && intent.originalSignaturePresent !== false) {
    diagnostics.push(
      error(
        'blizzard/sc2-bank-signature-unsupported',
        'a signed or signature-unknown SC2 bank is read-only until signing is implemented',
      ),
    )
    return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics) })
  }
  try {
    if (edit.operation === 'create') relativePath(edit.newPath)
    const bytes = payloadBytes(edit.payload)
    const maxInputBytes = context.budgets.maxInputBytes
    if (BigInt(bytes.byteLength) > maxInputBytes) {
      throw new RangeError(`${specification.label} exceeds maxInputBytes budget`)
    }
    const text = decodeStructuredText(bytes, context.budgets, specification.label)
    abort(context.signal)
    abort(signal)
    specification.validate(text, context.budgets)
    abort(context.signal)
    abort(signal)
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    diagnostics.push(
      error(
        'blizzard/sc2-writer-source-invalid',
        cause instanceof Error ? cause.message : String(cause),
      ),
    )
  }
  return Object.freeze({ valid: diagnostics.length === 0, diagnostics: Object.freeze(diagnostics) })
}

function writerFor(specification, context) {
  const identity = Object.freeze({
    providerId: PROVIDER_ID,
    providerVersion: '1.0.0',
    artifactDigest: 'x3:blizzard/sc2-authored-text-writers@1.0.0',
    formatId: specification.formatId,
    representationId: 'source',
  })
  const fidelity = Object.freeze({
    roundTrip: 'byte-identical',
    preservesUnknownData: true,
    notes: Object.freeze([
      'the complete edited UTF-8 snapshot is committed literally without normalization',
      'comments, whitespace, unknown XML nodes and unknown Galaxy/string text survive when retained by the editor snapshot',
    ]),
  })
  return Object.freeze({
    identity,
    offer: Object.freeze({
      providerId: PROVIDER_ID,
      fidelityEvidenceId: specification.evidenceId,
      formatId: specification.formatId,
      representationId: 'source',
      mutationMode: 'mutate',
      minimumRoundTrip: 'byte-identical',
    }),
    async validate(change, signal) {
      return validationOf(specification, change, context, signal)
    },
    async plan(change, signal) {
      const validation = validationOf(specification, change, context, signal)
      if (!validation.valid) {
        throw new TypeError(validation.diagnostics.map(item => item.message).join('; '))
      }
      return Object.freeze({
        planId: `${PROVIDER_ID}:${specification.formatId}:${change.edits[0].targetId}`,
        targets: change.targets,
        edits: change.edits,
        semantics: Object.freeze({ mutationMode: 'mutate', minimumGuarantee: 'atomic' }),
        fidelity,
        diagnostics: Object.freeze([]),
      })
    },
  })
}

export function createAuthoredTextProvider(specifications, selection, context) {
  const specification = specifications.find(candidate => candidate.offerId === selection.offerId)
  if (selection.contract !== 'common.edit/writer' || selection.major !== 1 || !specification) {
    throw new TypeError(`unknown SC2 authored-text writer offer ${selection.offerId}`)
  }
  const writer = writerFor(specification, context)
  return Object.freeze({ value: writer, release: async () => undefined })
}
