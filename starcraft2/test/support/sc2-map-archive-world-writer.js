import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import {
  encodeNativePreservingMpq,
  readNativeMpqSnapshot,
} from '@modkit/blizzard-mpq/native-preserving'
import { applyStarcraft2MapWorldEdits } from '../../modules/map/codecs/package/src/world-writer.js'

const MAP_DOCUMENT_BASENAMES = Object.freeze([
  'objects',
  'mapobjects',
  'regions',
  'mapregions',
  't3heightmap',
  'mapheightmap',
  't3syncpathinginfo',
  'mappathinginfo',
  'preload',
])

function requiredBasenamesForEdits(edits) {
  if (!Array.isArray(edits)) return MAP_DOCUMENT_BASENAMES
  const required = new Set()
  for (const candidate of edits) {
    const kind = candidate?.kind
    if (typeof kind !== 'string') continue
    if (kind.startsWith('object.')) required.add('objects').add('mapobjects')
    else if (kind.startsWith('region.')) required.add('regions').add('mapregions')
    else if (kind === 'terrain.cell.set') required.add('t3heightmap').add('mapheightmap')
    else if (kind === 'pathing.cell.set')
      required.add('t3syncpathinginfo').add('mappathinginfo')
    else if (kind === 'reference.rename')
      required.add('objects').add('mapobjects').add('preload')
  }
  return required.size === 0 ? MAP_DOCUMENT_BASENAMES : Object.freeze([...required])
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function abort(signal) {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
}

async function digest(bytes, signal) {
  abort(signal)
  const value = await crypto.subtle.digest('SHA-256', bytes)
  abort(signal)
  return `sha256:${Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Test-only direct archive harness. Production composition materializes through container.pack. */
export async function buildStarcraft2MapWorldArchive(options) {
  const value = record(options, 'SC2 map archive edit request')
  abort(value.signal)
  const mode = value.archiveMode ?? 'native-preserving'
  if (!['native-preserving', 'deterministic-rebuild'].includes(mode)) {
    throw new TypeError(`unsupported SC2 map archiveMode ${String(mode)}`)
  }
  const commonLimits = {
    maxArchiveBytes: value.maxArchiveBytes ?? 268_435_456,
    maxBlocks: value.maxBlocks ?? 100_000,
    maxEntries: value.maxDocuments ?? 4_096,
    maxEntryBytes: value.maxDocumentBytes ?? 67_108_864,
    maxTotalBytes: value.maxTotalBytes ?? 268_435_456,
  }
  const snapshot = await readNativeMpqSnapshot({
    sourceBytes: value.sourceBytes,
    signal: value.signal,
    ...(mode === 'native-preserving'
      ? { includeBasenames: requiredBasenamesForEdits(value.edits) }
      : {}),
    ...commonLimits,
  })
  abort(value.signal)
  if (
    typeof value.expectedSourceArchiveDigest === 'string' &&
    value.expectedSourceArchiveDigest !== snapshot.sourceArchiveDigest
  ) {
    throw new TypeError('stale SC2 map archive digest')
  }
  const semantic = await applyStarcraft2MapWorldEdits({ ...value, documents: snapshot.entries })
  const replacements = semantic.replacements.map(item => ({ path: item.path, bytes: item.bytes }))
  let bytes
  let archiveReceipt
  if (mode === 'native-preserving') {
    const encoded = await encodeNativePreservingMpq({
      sourceBytes: value.sourceBytes,
      replacements,
      signal: value.signal,
      maxArchiveBytes: commonLimits.maxArchiveBytes,
      maxBlocks: commonLimits.maxBlocks,
      maxReplacementBytes: commonLimits.maxEntryBytes,
    })
    bytes = encoded.bytes
    archiveReceipt = encoded.receipt
  } else {
    if (
      snapshot.filtered ||
      !snapshot.completeNamedSnapshot ||
      snapshot.opaqueInternalPaths.length > 0 ||
      snapshot.aliasedBlocks.length > 0
    ) {
      throw new TypeError(
        'deterministic SC2 map rebuild requires a complete uniquely named archive without attributes or signatures',
      )
    }
    const changed = new Map(replacements.map(item => [item.path.toLowerCase(), item.bytes]))
    const entries = snapshot.entries.map(item => ({
      path: item.path,
      bytes: changed.get(item.path.toLowerCase()) ?? item.bytes,
    }))
    bytes = encodeFreshMpq(entries, commonLimits.maxArchiveBytes)
    archiveReceipt = Object.freeze({
      schemaVersion: 1,
      kind: 'sc2-map-deterministic-rebuild-receipt-v1',
      strategy: 'complete-named-mpq-v0-stored-single-unit',
      sourceArchiveDigest: snapshot.sourceArchiveDigest,
      outputArchiveDigest: await digest(bytes, value.signal),
      entryCount: entries.length,
      unknownEntryPayloads: 'preserved-byte-identical',
      nativeLayout: 'deterministically-rebuilt',
    })
  }
  abort(value.signal)
  return Object.freeze({
    bytes,
    semantic,
    archiveReceipt,
    fidelity: Object.freeze({
      roundTrip: 'semantic',
      preservesUnknownData: semantic.fidelity.preservesUnknownData,
      notes: Object.freeze([
        ...semantic.fidelity.notes,
        ...(mode === 'native-preserving'
          ? ['native MPQ unknown blocks and untouched payloads remain byte-identical']
          : ['all named entry payloads not edited remain byte-identical; MPQ layout is rebuilt']),
      ]),
    }),
  })
}
