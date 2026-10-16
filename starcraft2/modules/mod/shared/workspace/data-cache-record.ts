/**
 * One saved Data prefix in a single framed V8 file. `data-cache-node` owns disk IO, fingerprints,
 * atomic rename, retention and in-flight sharing; the Data owner owns native parse facts and values.
 * Each document is encoded/decoded separately, yielding every 16 documents or 8 ms so other requests
 * can run. The complete record is returned only after all frames validate; old/truncated records fail.
 * The writer consumes an async iterable directly, keeping only the current encoded document buffer.
 * Document text is stored once in the catalog list and restored by its exact root/path identity.
 * Native elements and their value inputs share references within a frame; no game parser lives here.
 */
import { serialize, deserialize } from 'node:v8'
import type { CatalogDocument, StoredCatalogDocument } from '../../../data/services/catalog/catalog-analysis.js'
import type { ChainPrefixRecord } from './chain-data.js'

const MAGIC = Buffer.from('MKSC2D2\0')
const TURN_DOCUMENTS = 16
const TURN_MS = 8

type StoredEntry = Omit<ChainPrefixRecord['parses'][number][1], 'text' | 'parsed'> & {
  readonly parsed: StoredCatalogDocument
}
interface RecordHeader {
  readonly key: string
  readonly count: number
  readonly record: Omit<ChainPrefixRecord, 'parses'>
}

/** Exact native identities; one parsed entry must refer to an admitted catalog document. */
function catalogDocuments(catalogs: readonly CatalogDocument[]): ReadonlyMap<string, CatalogDocument> {
  return new Map(catalogs.map(document => [`${document.rootId}\0${document.path}`, document]))
}

/** Prefix one independently decodable V8 value with its byte length. */
function encodedFrame(value: unknown): Buffer {
  const bytes = serialize(value)
  const frame = Buffer.allocUnsafe(4 + bytes.length)
  frame.writeUInt32LE(bytes.length)
  bytes.copy(frame, 4)
  return frame
}

/** Refuse a truncated length or payload before invoking the platform decoder. */
function decodedFrame(bytes: Buffer, offset: number): { readonly value: unknown; readonly next: number } {
  if (offset > bytes.length - 4) throw new TypeError('truncated Data cache frame length')
  const length = bytes.readUInt32LE(offset)
  const start = offset + 4
  if (length === 0 || length > bytes.length - start) throw new TypeError('truncated Data cache frame')
  return { value: deserialize(bytes.subarray(start, start + length)), next: start + length }
}

/** Store canonical facts without enumerating lazy value getters, in bounded document turns. */
export async function* encodeDataCacheRecord(key: string, record: ChainPrefixRecord): AsyncGenerator<Buffer> {
  const { storeCatalogDocument } = await import('../../../data/services/catalog/catalog-analysis.js')
  const { parses, ...metadata } = record
  const documents = catalogDocuments(record.catalogs)
  yield MAGIC
  yield encodedFrame({ key, count: parses.length, record: metadata } satisfies RecordHeader)
  let turn = 0
  let yieldAt = performance.now() + TURN_MS
  for (const [identity, entry] of parses) {
    const document = documents.get(identity)
    if (document === undefined || entry.text !== document.text) throw new TypeError('Data cache parse text does not match its catalog')
    const { text: _text, parsed, ...facts } = entry
    yield encodedFrame([identity, { ...facts, parsed: storeCatalogDocument(parsed) } satisfies StoredEntry])
    if (++turn >= TURN_DOCUMENTS || performance.now() >= yieldAt) {
      await new Promise<void>(resolve => setImmediate(resolve))
      turn = 0
      yieldAt = performance.now() + TURN_MS
    }
  }
}

/** Restore one full record; yields never publish a partly decoded chain to a caller. */
export async function decodeDataCacheRecord(bytes: Buffer, key: string): Promise<ChainPrefixRecord> {
  if (bytes.length < MAGIC.length + 4 || !bytes.subarray(0, MAGIC.length).equals(MAGIC))
    throw new TypeError('unsupported Data cache record')
  const first = decodedFrame(bytes, MAGIC.length)
  const header = first.value as RecordHeader | null
  if (header?.key !== key || !Number.isSafeInteger(header.count) || header.count < 0 ||
      header.count > Math.floor((bytes.length - first.next) / 4) ||
      !Array.isArray(header.record?.catalogs) || !Array.isArray(header.record.editorCategories) ||
      !Number.isSafeInteger(header.record.bytes) || header.record.bytes < 0)
    throw new TypeError('invalid Data cache header')
  const documents = catalogDocuments(header.record.catalogs)
  if (header.count > documents.size) throw new TypeError('Data cache has more parses than catalogs')
  const { restoreCatalogDocument } = await import('../../../data/services/catalog/catalog-analysis.js')
  const parses: ChainPrefixRecord['parses'][number][] = []
  const seen = new Set<string>()
  let offset = first.next
  let turn = 0
  let yieldAt = performance.now() + TURN_MS
  for (let at = 0; at < header.count; at++) {
    const frame = decodedFrame(bytes, offset)
    const pair = frame.value as readonly [string, StoredEntry]
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || seen.has(pair[0]))
      throw new TypeError('invalid Data cache parse identity')
    const [identity, entry] = pair
    const document = documents.get(identity)
    if (document === undefined || typeof document.text !== 'string' || entry === null || typeof entry !== 'object')
      throw new TypeError('Data cache parse has no catalog')
    parses.push([identity, { ...entry, text: document.text, parsed: restoreCatalogDocument(entry.parsed) }])
    seen.add(identity)
    offset = frame.next
    if (++turn >= TURN_DOCUMENTS || performance.now() >= yieldAt) {
      await new Promise<void>(resolve => setImmediate(resolve))
      turn = 0
      yieldAt = performance.now() + TURN_MS
    }
  }
  if (offset !== bytes.length) throw new TypeError('trailing Data cache bytes')
  return { ...header.record, parses }
}
