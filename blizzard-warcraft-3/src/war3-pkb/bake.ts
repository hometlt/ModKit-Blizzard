/**
 * PopcornFX 2 bakes (`.pkb`) — the compiled effects Warcraft III Reforged's CORN emitters run.
 *
 * Owner: GAME-WARCRAFT3. Read-only. The format has no public specification; this follows what the
 * game's own 2,165 bakes were measured to hold (W3ModelViewer `mdxres/research/popcornfx-bake.md`,
 * MIT, reference only — the code is written here). Layout:
 *
 *   0x00 u32 magic 0xCA000B11, 0x04 u32 version, 0x0C u32 recordCount, 0x10 u32 classCount,
 *   0x14 u32 stringTableOffset; 0x1C classCount × { u32 classNameString, u32 instanceCount };
 *   recordCount × { u32 size; u8 0x20; u32 class; u16 fieldCount; (u16 fieldIndex, value)* };
 *   at stringTableOffset: u32 count, count × { u8 length, Latin-1 bytes }.
 *
 * Object references are 1-based (0 is null). A field's value carries no type: `BAKE_SCHEMA` names
 * the encoding of every field a reader uses, and a field it does not name is skipped by the
 * encoding under which the rest of its record still parses (field indices ascend, the record ends
 * on its size). That combination parses every record the game ships.
 *
 * Budgets: the caller's byte budget bounds the input; record walking is bounded by a step budget;
 * strings, arrays and records are bounded by the input itself. Nothing is evaluated.
 */

export const PKB_MAGIC = 0xca000b11

/** A field's value encoding: fixed scalars and vectors, or a u32-counted array of fixed elements. */
type Encoding = 'u8' | 'u16' | 'u32' | 'u64' | 'v3' | 'v4' | 'a1' | 'a2' | 'a4' | 'a8' | 'a12' | 'a16'

const FIXED: Readonly<Partial<Record<Encoding, number>>> = { u8: 1, u16: 2, u32: 4, u64: 8, v3: 12, v4: 16 }
const ELEMENT: Readonly<Partial<Record<Encoding, number>>> = { a1: 1, a2: 2, a4: 4, a8: 8, a12: 12, a16: 16 }

/** Encodings tried, in order, for a field the schema does not name. */
const FALLBACK: readonly Encoding[] = ['u32', 'a4', 'v3', 'v4', 'u8', 'u16', 'u64', 'a1', 'a2', 'a8', 'a12', 'a16']

/** The encoding of every field the effect reader uses, by class (measured over the game's bakes). */
const BAKE_SCHEMA: Readonly<Record<string, Readonly<Record<number, Encoding>>>> = {
  CParticleEffect: { 1: 'u32', 3: 'u32' },
  CLayerGraphCompileCache: { 1: 'a4', 2: 'a4', 3: 'a4', 5: 'a12' },
  CLayerGraphCompileCache_EntrySlot: { 0: 'u32', 1: 'u32' },
  CLayerGraphCompileCache_EventSlot: { 0: 'u32', 1: 'u32', 2: 'a4' },
  CLayerGraphCompileCache_LayerSlot: { 0: 'u32', 1: 'a4', 2: 'a4' },
  CLayerCompileCache: {
    0: 'a16', 1: 'a16', 2: 'a4', 3: 'a4', 5: 'a4', 6: 'a4', 7: 'a4', 8: 'a4', 9: 'u32', 10: 'a4',
    12: 'u32', 13: 'u32', 14: 'u8', 15: 'u8', 20: 'u32', 22: 'u32', 23: 'u32',
  },
  CLayerCompileCacheField: { 0: 'u32', 1: 'u32', 2: 'u32', 3: 'u32', 4: 'u32', 5: 'u32' },
  CLayerCompileCacheSampler: { 0: 'u32', 1: 'u32', 3: 'u32', 4: 'u32' },
  CParticleNodeSamplerData_Curve: {
    0: 'a8', 1: 'a8', 7: 'u64', 9: 'u32', 10: 'u32', 11: 'v4', 14: 'u32', 15: 'u8', 16: 'a4', 17: 'a4', 18: 'a4',
  },
  CParticleNodeSamplerData_Shape: {
    0: 'a8', 1: 'a8', 3: 'u32', 7: 'u64', 9: 'u32', 10: 'u8', 11: 'u8', 12: 'u32', 13: 'v3', 14: 'v3', 15: 'u32',
    16: 'v3', 17: 'u32', 18: 'u32', 20: 'u32', 21: 'u8', 22: 'v3', 23: 'u32', 24: 'v3', 25: 'u32',
  },
  CParticleNodeSamplerData_EventStream: { 10: 'a4' },
  CLayerCompileCacheEvent: { 0: 'u32', 1: 'u32', 2: 'a4', 3: 'u32' },
  CLayerCompileCacheEventPayload: { 0: 'u32', 1: 'u32', 2: 'u32', 3: 'u32', 4: 'u32', 5: 'u32' },
  CCompilerBlobCache: { 1: 'u32', 2: 'a4', 3: 'a4', 4: 'a4', 5: 'u32' },
  CCompilerBlobCacheExternal: { 0: 'u32', 1: 'u32', 2: 'u32', 3: 'u32', 4: 'u32', 5: 'u32', 6: 'u32', 7: 'u32' },
  CCompilerBlobCacheEntryPoint: { 0: 'u32', 1: 'u32', 2: 'u32' },
  CCompilerBlobCacheFunctionDef: { 0: 'u32', 1: 'u32', 2: 'u32', 3: 'a4' },
  CCompilerBlobCacheFunctionArg: { 0: 'u32', 1: 'u32', 2: 'u32' },
  CLayerCompileCacheRenderer: { 0: 'u32', 1: 'a4', 2: 'a4', 3: 'u32', 4: 'u32' },
  CLayerCompileCacheRendererParticleInput: { 0: 'u32', 1: 'u32', 2: 'u32', 3: 'u32' },
  CLayerCompileCacheRendererProperty: { 0: 'u32', 1: 'u32', 2: 'v4', 3: 'u32' },
  CLayerCompileCacheSpatialLayer: { 0: 'u32', 1: 'u32', 2: 'u32', 3: 'u32', 4: 'a4' },
  CLayerCompileCacheSpatialLayerPayload: { 0: 'u32', 1: 'u32', 2: 'u32' },
}

/** One field of a record: its encoding and its value's byte span within the record body. */
interface FieldSpan {
  readonly encoding: Encoding
  readonly start: number
  readonly end: number
}

interface BakeRecord {
  readonly classIndex: number
  readonly fieldCount: number
  readonly body: Uint8Array
  fields?: ReadonlyMap<number, FieldSpan> | null
}

/** Steps a record walk may take before it is refused: the inference backtracks over 12 encodings. */
const WALK_STEPS = 200_000

/**
 * The records of one bake, with typed field reads. Reads are lazy: a record's fields are walked on
 * first access. A read of a field that is absent returns the fallback, as the runtime's defaults do.
 */
export class PkbBake {
  readonly version: number
  readonly strings: readonly string[]
  private readonly classNames: readonly number[]
  private readonly records: readonly BakeRecord[]

  private constructor(version: number, strings: readonly string[], classNames: readonly number[], records: readonly BakeRecord[]) {
    this.version = version
    this.strings = strings
    this.classNames = classNames
    this.records = records
  }

  /** Whether `bytes` start like a bake. */
  static detect(bytes: Uint8Array): boolean {
    return bytes.byteLength > 0x20 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === PKB_MAGIC
  }

  /** The bake in `bytes`; refuses anything that is not one, or whose records overrun their stream. */
  static read(bytes: Uint8Array, signal?: AbortSignal): PkbBake {
    if (!PkbBake.detect(bytes)) throw new TypeError('not a PopcornFX bake (missing the 0xCA000B11 magic)')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const version = view.getUint32(0x04, true)
    const recordCount = view.getUint32(0x0c, true)
    const classCount = view.getUint32(0x10, true)
    const stringTable = view.getUint32(0x14, true)
    if (stringTable <= 0x1c || stringTable + 4 > bytes.byteLength) throw new RangeError('bake string table offset is out of range')
    if (0x1c + classCount * 8 > stringTable) throw new RangeError('bake class table overruns its records')
    const strings: string[] = []
    const stringCount = view.getUint32(stringTable, true)
    let at = stringTable + 4
    const latin1 = new TextDecoder('latin1')
    for (let index = 0; index < stringCount && at < bytes.byteLength; index++) {
      const length = bytes[at++]!
      if (at + length > bytes.byteLength) throw new RangeError('bake string overruns the file')
      strings.push(latin1.decode(bytes.subarray(at, at + length)))
      at += length
    }
    const classNames = Array.from({ length: classCount }, (_, index) => view.getUint32(0x1c + index * 8, true))
    const records: BakeRecord[] = []
    at = 0x1c + classCount * 8
    while (at + 4 <= stringTable && records.length < recordCount) {
      if (records.length % 4096 === 0) signal?.throwIfAborted()
      const size = view.getUint32(at, true)
      if (size < 7 || at + 4 + size > stringTable) throw new RangeError(`bake record at ${String(at)} overruns the object stream`)
      if (bytes[at + 4] !== 0x20) throw new RangeError(`bake record at ${String(at)} lacks its 0x20 marker`)
      records.push({
        classIndex: view.getUint32(at + 5, true),
        fieldCount: view.getUint16(at + 9, true),
        body: bytes.subarray(at + 11, at + 4 + size),
      })
      at += 4 + size
    }
    if (records.length !== recordCount)
      throw new RangeError(`bake declares ${String(recordCount)} records but ${String(records.length)} parse`)
    return new PkbBake(version, Object.freeze(strings), Object.freeze(classNames), Object.freeze(records))
  }

  get count(): number {
    return this.records.length
  }

  /** The class name of record `record` ('' for none). */
  classOf(record: number): string {
    const classIndex = this.records[record]?.classIndex
    return classIndex === undefined ? '' : this.string(this.classNames[classIndex] ?? -1)
  }

  string(index: number): string {
    return this.strings[index] ?? ''
  }

  /** The records of one class, in file order. */
  ofClass(name: string): number[] {
    const out: number[] = []
    for (let record = 0; record < this.records.length; record++) if (this.classOf(record) === name) out.push(record)
    return out
  }

  /** Every class with its record count, in file order. */
  classes(): { name: string; count: number }[] {
    const counts = new Map<string, number>()
    for (let record = 0; record < this.records.length; record++) {
      const name = this.classOf(record)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts].map(([name, count]) => ({ name, count }))
  }

  has(record: number, field: number): boolean {
    return this.field(record, field) !== undefined
  }

  u32(record: number, field: number, fallback = 0): number {
    const span = this.field(record, field)
    return span === undefined || span.end - span.start < 4 ? fallback : this.view(record).getUint32(span.start, true)
  }

  i32(record: number, field: number, fallback = 0): number {
    const span = this.field(record, field)
    return span === undefined || span.end - span.start < 4 ? fallback : this.view(record).getInt32(span.start, true)
  }

  f32(record: number, field: number, fallback = 0): number {
    const span = this.field(record, field)
    return span === undefined || span.end - span.start < 4 ? fallback : this.view(record).getFloat32(span.start, true)
  }

  /** A field holding a string-table index, as the string; '' when absent. */
  text(record: number, field: number): string {
    return this.has(record, field) ? this.string(this.i32(record, field)) : ''
  }

  v3(record: number, field: number, fallback: readonly [number, number, number] = [0, 0, 0]): [number, number, number] {
    const span = this.field(record, field)
    if (span === undefined || span.end - span.start < 12) return [...fallback]
    const view = this.view(record)
    return [view.getFloat32(span.start, true), view.getFloat32(span.start + 4, true), view.getFloat32(span.start + 8, true)]
  }

  /** A fixed field's raw bytes (a 16-byte property value, say); empty when absent. */
  raw(record: number, field: number): Uint8Array {
    const span = this.field(record, field)
    return span === undefined ? new Uint8Array(0) : this.records[record]!.body.slice(span.start, span.end)
  }

  /** An array field's element bytes, without its count; empty when absent. */
  arrayBytes(record: number, field: number): Uint8Array {
    const span = this.field(record, field)
    return span === undefined || span.end - span.start < 4 ? new Uint8Array(0) : this.records[record]!.body.slice(span.start + 4, span.end)
  }

  u32s(record: number, field: number): number[] {
    const raw = this.arrayBytes(record, field)
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    return Array.from({ length: Math.floor(raw.byteLength / 4) }, (_, index) => view.getUint32(index * 4, true))
  }

  f32s(record: number, field: number): number[] {
    const raw = this.arrayBytes(record, field)
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    return Array.from({ length: Math.floor(raw.byteLength / 4) }, (_, index) => view.getFloat32(index * 4, true))
  }

  /** An array of 1-based references, 0-based; a null or dangling reference is -1. */
  refs(record: number, field: number): number[] {
    return this.u32s(record, field).map(value => (value === 0 || value > this.records.length ? -1 : value - 1))
  }

  /** One 1-based reference, 0-based; -1 when absent, null or dangling. */
  ref(record: number, field: number): number {
    const value = this.u32(record, field)
    return value === 0 || value > this.records.length ? -1 : value - 1
  }

  /** Every field of a record with the encoding it parsed under (for inspection); none if it does not parse. */
  fieldsOf(record: number): { field: number; encoding: Encoding; bytes: number }[] {
    const fields = this.walked(record)
    return fields === null ? [] : [...fields].sort(([a], [b]) => a - b).map(([field, span]) => ({ field, encoding: span.encoding, bytes: span.end - span.start }))
  }

  private view(record: number): DataView {
    const body = this.records[record]!.body
    return new DataView(body.buffer, body.byteOffset, body.byteLength)
  }

  private field(record: number, field: number): FieldSpan | undefined {
    return this.walked(record)?.get(field)
  }

  private walked(record: number): ReadonlyMap<number, FieldSpan> | null {
    const entry = this.records[record]
    if (entry === undefined) return null
    if (entry.fields === undefined) entry.fields = walkRecord(entry, BAKE_SCHEMA[this.classOf(record)])
    return entry.fields
  }
}

/** The end of a value of `encoding` starting at `at`, or -1 when it does not fit. */
function valueEnd(body: Uint8Array, at: number, encoding: Encoding): number {
  const fixed = FIXED[encoding]
  if (fixed !== undefined) return at + fixed <= body.byteLength ? at + fixed : -1
  if (at + 4 > body.byteLength) return -1
  const count = new DataView(body.buffer, body.byteOffset, body.byteLength).getInt32(at, true)
  if (count < 0 || count > 1_000_000) return -1
  const end = at + 4 + count * ELEMENT[encoding]!
  return end <= body.byteLength ? end : -1
}

/**
 * A record's fields, each under the schema's encoding or, unnamed, the first fallback under which
 * the rest of the record parses (each next field index larger, the record ending on its size).
 * `null` when no assignment parses, or the walk takes more than `WALK_STEPS` steps.
 */
function walkRecord(record: BakeRecord, schema: Readonly<Record<number, Encoding>> | undefined): ReadonlyMap<number, FieldSpan> | null {
  const body = record.body
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const fields = new Map<number, FieldSpan>()
  let steps = WALK_STEPS
  const step = (ordinal: number, at: number, last: number): boolean => {
    if (--steps < 0) return false
    if (ordinal === record.fieldCount) return at === body.byteLength
    if (at + 2 > body.byteLength) return false
    const field = view.getUint16(at, true)
    if (field <= last) return false
    const start = at + 2
    const known = schema?.[field]
    for (const encoding of known === undefined ? FALLBACK : [known]) {
      const end = valueEnd(body, start, encoding)
      if (end < 0) continue
      const lastField = ordinal === record.fieldCount - 1
      if (!lastField && !(end + 2 <= body.byteLength && view.getUint16(end, true) > field)) continue
      fields.set(field, { encoding, start, end })
      if (step(ordinal + 1, end, field)) return true
      fields.delete(field)
    }
    return false
  }
  return step(0, 0, -1) ? fields : null
}
