const PROVIDER_ID = 'blizzard/sc2-workspace-copy-writer'
const OFFER_ID = 'sc2-workspace-copy-v1'
const DOCUMENT_KINDS = new Set(['SC2Map', 'SC2Mod', 'SC2Campaign'])

export const SC2_NATIVE_REPACK_UNSUPPORTED =
  'blizzard/sc2-native-mpq-repack-unsupported'

const error = (code, message) => Object.freeze({ severity: 'error', code, message })

const abort = signal => {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
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
    throw new TypeError(`workspace-copy path «${String(path)}» is not a portable relative path`)
  }
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`workspace-copy path «${path}» contains an empty or traversal segment`)
  }
  return parts.join('/')
}

function nativeFeatureRefusal(intent) {
  if (intent.sourceMode === 'native-mpq') {
    return 'native MPQ preserving repack is not implemented; export a bounded workspace copy instead'
  }
  if (intent.encrypted === true) return 'encrypted MPQ features cannot be preserved'
  if (intent.highOffset === true) return 'high-offset MPQ tables cannot be preserved'
  if (intent.patchEntries === true) return 'MPQ patch entries cannot be preserved'
  if (Array.isArray(intent.unknownNativeFeatures) && intent.unknownNativeFeatures.length > 0) {
    return `unknown MPQ features cannot be preserved: ${intent.unknownNativeFeatures.join(', ')}`
  }
  return undefined
}

function validationOf(change, context, signal) {
  abort(context.signal)
  abort(signal)
  const diagnostics = []
  const intent = record(change.semanticIntent)
  const refusal = intent === undefined ? undefined : nativeFeatureRefusal(intent)
  if (refusal !== undefined) {
    diagnostics.push(error(SC2_NATIVE_REPACK_UNSUPPORTED, refusal))
    return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics) })
  }
  if (
    intent?.kind !== 'sc2-workspace-copy-export-v1' ||
    !DOCUMENT_KINDS.has(intent.documentKind) ||
    !['loose-workspace', 'read-only-casc'].includes(intent.sourceMode) ||
    intent.completeSnapshot !== true ||
    intent.unknownDataPolicy !== 'copy-every-entry-byte-for-byte' ||
    !Number.isSafeInteger(intent.entryCount) ||
    intent.entryCount !== change.edits.length
  ) {
    diagnostics.push(
      error(
        'blizzard/sc2-workspace-copy-intent-invalid',
        'workspace-copy export requires a complete loose/CASC snapshot with an exact entry count',
      ),
    )
  }
  if (
    change.targets.length !== 1 ||
    change.targets[0].expectedRevision.namespaceRevision === undefined
  ) {
    diagnostics.push(
      error(
        'blizzard/sc2-workspace-copy-target-not-namespace',
        'workspace-copy export requires one revision-pinned namespace target',
      ),
    )
  }
  const target = change.targets[0]
  const paths = new Set()
  let bytes = 0n
  for (const edit of change.edits) {
    abort(context.signal)
    abort(signal)
    if (
      edit.operation !== 'create' ||
      target === undefined ||
      edit.targetId !== target.targetId ||
      edit.source.id !== target.ownerSource.id ||
      edit.payload.kind !== 'inline'
    ) {
      diagnostics.push(
        error(
          'blizzard/sc2-workspace-copy-edit-unsupported',
          'workspace-copy export accepts only inline creates inside its selected target directory',
        ),
      )
      continue
    }
    try {
      const path = relativePath(edit.newPath)
      if (paths.has(path)) throw new TypeError(`duplicate workspace-copy path «${path}»`)
      paths.add(path)
      bytes += BigInt(edit.payload.bytes.byteLength)
    } catch (cause) {
      diagnostics.push(
        error(
          'blizzard/sc2-workspace-copy-path-invalid',
          cause instanceof Error ? cause.message : String(cause),
        ),
      )
    }
  }
  if (bytes > context.budgets.maxInputBytes || bytes > BigInt(context.budgets.maxScalarBytes)) {
    diagnostics.push(
      error(
        'blizzard/sc2-workspace-copy-budget-exceeded',
        'workspace-copy payload exceeds the provider resource budget',
      ),
    )
  }
  return Object.freeze({ valid: diagnostics.length === 0, diagnostics: Object.freeze(diagnostics) })
}

const identity = Object.freeze({
  providerId: PROVIDER_ID,
  providerVersion: '1.0.0',
  artifactDigest: 'x3:blizzard/sc2-workspace-copy-writer@1.0.0',
  formatId: 'sc2-workspace-copy',
  representationId: 'namespace',
})

const fidelity = Object.freeze({
  roundTrip: 'byte-identical',
  preservesUnknownData: true,
  notes: Object.freeze([
    'every enumerated workspace entry is copied byte-for-byte to a separate export target',
    'the source namespace, including CASC installations, is never mutated',
    'this receipt is not a native MPQ repack receipt',
  ]),
})

export const abiVersion = 1
export const provides = Object.freeze(['common.edit/writer'])

export function createProvider(selection, context) {
  if (
    selection.contract !== 'common.edit/writer' ||
    selection.major !== 1 ||
    selection.offerId !== OFFER_ID
  ) {
    throw new TypeError(`unknown SC2 workspace-copy writer offer ${selection.offerId}`)
  }
  const writer = Object.freeze({
    identity,
    offer: Object.freeze({
      providerId: PROVIDER_ID,
      fidelityEvidenceId: 'sc2-workspace-copy-writer-v1',
      formatId: 'sc2-workspace-copy',
      representationId: 'namespace',
      mutationMode: 'export-only',
      minimumRoundTrip: 'byte-identical',
    }),
    async validate(change, signal) {
      return validationOf(change, context, signal)
    },
    async plan(change, signal) {
      const validation = validationOf(change, context, signal)
      if (!validation.valid) {
        throw new TypeError(validation.diagnostics.map(item => item.message).join('; '))
      }
      return Object.freeze({
        planId: `${PROVIDER_ID}:${change.targets[0].targetId}`,
        targets: change.targets,
        edits: change.edits,
        semantics: Object.freeze({
          mutationMode: 'export-only',
          minimumGuarantee: change.edits.length <= 1 ? 'atomic' : 'recoverable',
        }),
        fidelity,
        diagnostics: Object.freeze([]),
      })
    },
  })
  return Object.freeze({ value: writer, release: async () => undefined })
}

/**
 * Materialize one bounded SC2 namespace snapshot as a ChangeSet for the standard writer/coordinator
 * path. The source is deliberately read-only; all side effects target `target.ownerSource`.
 */
export async function snapshotSc2WorkspaceCopy(options) {
  const {
    source,
    sourcePrefix,
    sourceMode,
    documentKind,
    target,
    signal,
    maxEntries = 4_096,
    maxEntryBytes = 16_777_216,
    maxTotalBytes = 67_108_864,
    pageLimit = 256,
  } = options
  abort(signal)
  if (!DOCUMENT_KINDS.has(documentKind))
    throw new TypeError(`unsupported ${documentKind} workspace`)
  if (!['loose-workspace', 'read-only-casc'].includes(sourceMode)) {
    throw new TypeError(
      `${SC2_NATIVE_REPACK_UNSUPPORTED}: native MPQ preserving repack is not implemented`,
    )
  }
  if (target.expectedRevision.namespaceRevision === undefined) {
    throw new TypeError('workspace-copy export target is not a revision-pinned namespace')
  }
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0 ||
    !Number.isSafeInteger(maxEntryBytes) ||
    maxEntryBytes <= 0 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes <= 0 ||
    !Number.isSafeInteger(pageLimit) ||
    pageLimit <= 0
  ) {
    throw new TypeError('workspace-copy limits must be positive safe integers')
  }
  const prefix = sourcePrefix.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  if (prefix === '') throw new TypeError('workspace-copy sourcePrefix must name an SC2 workspace')
  const suffix = `.${documentKind.toLowerCase()}`
  if (!prefix.toLowerCase().endsWith(suffix)) {
    throw new TypeError(`workspace-copy sourcePrefix must end in ${suffix}`)
  }
  const entries = new Map()
  let cursor
  const cursors = new Set()
  do {
    abort(signal)
    const page = await source.list(
      `${prefix}/`,
      cursor === undefined ? { limit: pageLimit } : { cursor, limit: pageLimit },
      signal,
    )
    if (!Array.isArray(page.items) || page.items.length > pageLimit) {
      throw new TypeError('workspace-copy source returned an invalid or overproduced page')
    }
    for (const item of page.items) {
      abort(signal)
      if (item.kind !== 'file') continue
      if (!item.path.startsWith(`${prefix}/`)) {
        throw new TypeError(`workspace-copy source escaped prefix: ${item.path}`)
      }
      const path = relativePath(item.path.slice(prefix.length + 1))
      if (entries.has(path)) throw new TypeError(`duplicate workspace-copy path «${path}»`)
      if (entries.size >= maxEntries) throw new RangeError('workspace-copy exceeds maxEntries')
      if (item.size !== undefined && item.size > BigInt(maxEntryBytes)) {
        throw new RangeError(`workspace-copy entry ${path} exceeds maxEntryBytes`)
      }
      entries.set(path, item.path)
    }
    if (page.nextCursor !== undefined) {
      if (page.nextCursor === cursor || cursors.has(page.nextCursor)) {
        throw new TypeError('workspace-copy source repeated a page cursor')
      }
      cursors.add(page.nextCursor)
    }
    cursor = page.nextCursor
  } while (cursor !== undefined)
  if (entries.size === 0) throw new TypeError('workspace-copy source contains no files')
  let total = 0
  const edits = []
  for (const [path, sourcePath] of [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    abort(signal)
    const bytes = await source.read(sourcePath, signal)
    abort(signal)
    if (!(bytes instanceof Uint8Array))
      throw new TypeError(`workspace-copy read ${sourcePath} returned no bytes`)
    if (bytes.byteLength > maxEntryBytes) {
      throw new RangeError(`workspace-copy entry ${path} exceeds maxEntryBytes`)
    }
    total += bytes.byteLength
    if (total > maxTotalBytes) throw new RangeError('workspace-copy exceeds maxTotalBytes')
    edits.push(
      Object.freeze({
        operation: 'create',
        targetId: target.targetId,
        source: target.ownerSource,
        newPath: path,
        payload: Object.freeze({ kind: 'inline', bytes: bytes.slice() }),
      }),
    )
  }
  return Object.freeze({
    targets: Object.freeze([target]),
    edits: Object.freeze(edits),
    semanticIntent: Object.freeze({
      kind: 'sc2-workspace-copy-export-v1',
      documentKind,
      sourceMode,
      completeSnapshot: true,
      unknownDataPolicy: 'copy-every-entry-byte-for-byte',
      entryCount: edits.length,
      sourceRevision: String(source.revision),
    }),
    provenance: Object.freeze({ actor: 'user', note: 'bounded SC2 workspace-copy export' }),
  })
}
