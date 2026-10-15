/**
 * World of Warcraft M2 model bundle reader — the native layer of the `blizzard/wow-m2` codec
 * (owner: GAME-WOW). It decodes bytes only; the scene projection is `./scene.ts` and the MK3
 * surface `./codec.ts`. Nothing here opens a file: companions arrive as bytes from the codec.
 *
 * Formats and versions:
 * - `.m2`: the chunked container (`MD21` + `SFID`, `TXID`, `AFID`, `BFID`, `SKID`, `LDV1`… — tags
 *   read left to right, not byte-reversed like other WoW chunks) and the pre-Legion flat `MD20`
 *   file. The MD20 header and records of versions 264–274 (Wrath of the Lich King to The War
 *   Within); version < 264 (inline skins, single-timeline tracks) is refused with its version.
 * - `.skin`: one skin profile (`SKIN`), Cataclysm+ 64-byte header; a submesh's first index carries
 *   its high word in the neighbouring `level` field.
 * - `.anim`: external keyframes, raw or separate AFM2/AFSB/AFSA domains.
 * - `.skel`: SKS1 sequences, SKB1 bones, SKA1 attachments and bounded SKPD identity.
 * - `.bone`: profile-1 BIDA bone indices and BOMT facial-pose offset matrices, separately decoded.
 *
 * Read: header arrays (sequences, bones, vertices, textures, materials, the combo tables, colours,
 * texture weights, attachments, events), the per-sequence keyframes of every track this layer
 * names, including native float-quaternion UV transform tracks. Not read: lights, cameras,
 * ribbon and particle emitters, collision
 * geometry, `.phys` (later stages). BONE client application is not projected. Skeleton composition belongs to the same native owner;
 * this reader decodes one skeleton at a time. Unknown chunks remain listed.
 *
 * Track semantics (verified against the client by WhiteoutFlakes, see NOTICE.md): a track is an
 * array of arrays, one keyframe list per sequence; a global-sequence track has one list on its
 * own clock; a sequence whose data is external reads its list from its `.anim` buffer, and with
 * no buffer its list is empty (the caller reports it). A compressed quaternion component is
 * `raw · 2/65535 − 1`, not the wiki's signed formula.
 *
 * Budgets: every count is checked against `maxRecords` before allocation and every range against
 * its source with `@modkit/codec-kit/binary`; a malformed file throws `RangeError`/`TypeError`.
 *
 * Adapted from WhiteoutLib (BSD-3-Clause, © 2026 Fernando Sahmkow): record layouts of
 * `binary_parse_visitor/base.cpp`, `skin.cpp` and `docs/M2_FILE_FORMAT_SPECIFICATION.md`.
 */
import { boundedCount, byteView, checkedProduct, requireRange } from '@modkit/codec-kit/binary'

const latin1 = new TextDecoder('latin1')

/** One chunk of a chunked file: tag and payload range in the file. */
export interface M2Chunk {
  readonly tag: string
  readonly offset: number
  readonly size: number
}

/** The model's companions by FileDataID, as the chunks name them; 0 means none. */
export interface M2FileIds {
  readonly skins: readonly number[]
  readonly lodSkins: readonly number[]
  readonly textures: readonly number[]
  readonly animations: readonly { readonly animId: number; readonly subAnimId: number; readonly fileId: number }[]
  readonly bones: readonly number[]
  readonly skeleton?: number
  readonly physics?: number
}

/** One keyframe list: millisecond times and their values, equal length. */
export interface M2Keys<T> {
  readonly times: readonly number[]
  readonly values: readonly T[]
  /** Composed skeleton layers may have different interpolation and independent clocks per clip. */
  readonly interpolation?: number
  readonly globalPeriodMilliseconds?: number
}

/**
 * An animated property. `perSequence[i]` is sequence i's list; a global-sequence track has one
 * list (index 0) and `globalSequence` names its loop. `missing[i]` marks a list whose `.anim`
 * buffer was not supplied (its keys are then empty).
 */
export interface M2Track<T> {
  readonly interpolation: number
  readonly globalSequence: number | null
  readonly perSequence: readonly M2Keys<T>[]
  readonly missing: readonly number[]
}

export type Vec3 = readonly [number, number, number]
export type Quat = readonly [number, number, number, number]

export interface M2Sequence {
  readonly id: number
  readonly variation: number
  readonly duration: number
  readonly moveSpeed: number
  readonly flags: number
  readonly frequency: number
  readonly replayMin: number
  readonly replayMax: number
  readonly blendIn: number
  readonly blendOut: number
  readonly boundsMin: Vec3
  readonly boundsMax: Vec3
  readonly boundsRadius: number
  readonly variationNext: number
  readonly aliasNext: number
}

export interface M2Bone {
  readonly keyBoneId: number
  readonly flags: number
  readonly parent: number
  readonly submeshId: number
  readonly translation: M2Track<Vec3>
  readonly rotation: M2Track<Quat>
  readonly scale: M2Track<Vec3>
  readonly pivot: Vec3
}

export interface M2Texture {
  readonly type: number
  readonly flags: number
  /** In-file path (old files, type 0 only); empty when TXID names it. */
  readonly filename: string
}

export interface M2Material {
  readonly flags: number
  readonly blend: number
}

export interface M2Color {
  readonly color: M2Track<Vec3>
  /** 0..1 (fixed16 / 0x7FFF). */
  readonly alpha: M2Track<number>
}

/** Native UV animation has float quaternions, unlike compressed bone quaternions. */
export interface M2TextureTransform {
  readonly translation: M2Track<Vec3>
  readonly rotation: M2Track<Quat>
  readonly scale: M2Track<Vec3>
}

export interface M2Attachment {
  readonly id: number
  readonly bone: number
  readonly position: Vec3
  /** Native visibility, on the attachment ANIM domain rather than the bone domain. */
  readonly enabled: M2Track<number>
}

/** Skeleton metadata read before external animation buffers are resolved. Offsets are chunk-local. */
export interface M2SkeletonDescriptor {
  readonly chunks: readonly M2Chunk[]
  readonly fileIds: M2FileIds
  readonly parent?: number
  readonly sequences?: readonly M2Sequence[]
  readonly globalLoops?: readonly number[]
}

/** One skeleton's decoded records; absent record chunks differ from present empty arrays. */
export interface M2Skeleton extends M2SkeletonDescriptor {
  readonly bones?: readonly M2Bone[]
  readonly keyBones?: readonly number[]
  readonly attachments?: readonly M2Attachment[]
}

export interface M2Event {
  /** Four ASCII characters, `$FSD`. */
  readonly identifier: string
  readonly data: number
  readonly bone: number
  readonly position: Vec3
  /** Fire times per sequence, milliseconds. */
  readonly times: M2Track<null>
}

/** Decoded vertex arrays of the whole model, `count` vertices. */
export interface M2Vertices {
  readonly count: number
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly uv0: Float32Array
  readonly uv1: Float32Array
  readonly boneIndices: Uint8Array
  /** 0..255 each, summing to 255. */
  readonly boneWeights: Uint8Array
}

export interface M2Model {
  readonly version: number
  readonly name: string
  readonly globalFlags: number
  readonly globalLoops: readonly number[]
  readonly sequences: readonly M2Sequence[]
  readonly bones: readonly M2Bone[]
  readonly keyBones: readonly number[]
  readonly vertices: M2Vertices
  readonly skinProfiles: number
  readonly colors: readonly M2Color[]
  readonly textures: readonly M2Texture[]
  readonly textureWeights: readonly M2Track<number>[]
  readonly textureTransforms: readonly M2TextureTransform[]
  readonly materials: readonly M2Material[]
  readonly boneCombos: readonly number[]
  readonly textureCombos: readonly number[]
  readonly textureCoordCombos: readonly number[]
  readonly textureWeightCombos: readonly number[]
  readonly textureTransformCombos: readonly number[]
  readonly boundsMin: Vec3
  readonly boundsMax: Vec3
  readonly boundsRadius: number
  readonly attachments: readonly M2Attachment[]
  readonly events: readonly M2Event[]
  readonly chunks: readonly M2Chunk[]
  readonly fileIds: M2FileIds
}

export interface M2SkinSubmesh {
  readonly sectionId: number
  readonly vertexStart: number
  readonly vertexCount: number
  /** Index start with its high word folded in. */
  readonly indexStart: number
  readonly indexCount: number
  readonly boneCount: number
  readonly boneComboIndex: number
  readonly centerBone: number
}

export interface M2SkinBatch {
  readonly flags: number
  readonly priorityPlane: number
  readonly shaderId: number
  readonly submesh: number
  readonly colorIndex: number
  readonly materialIndex: number
  readonly materialLayer: number
  readonly textureCount: number
  readonly textureComboIndex: number
  readonly textureCoordComboIndex: number
  readonly textureWeightComboIndex: number
  readonly textureTransformComboIndex: number
}

export interface M2Skin {
  /** Indices into the model's vertices (before `lodVertexBase`). */
  readonly vertices: Uint16Array
  /** Triangle indices into `vertices`. */
  readonly indices: Uint16Array
  readonly submeshes: readonly M2SkinSubmesh[]
  readonly batches: readonly M2SkinBatch[]
  readonly lodVertexBase: number
}

/** What a read may allocate, and the `.anim` keyframes of each external sequence. */
export interface M2ReadOptions {
  /** Upper bound on every record count. */
  readonly maxRecords: number
  /** Sequence index → its `.anim` keyframe buffer (already unwrapped by `animPayload`). */
  readonly animBuffers?: ReadonlyMap<number, Uint8Array>
  /** Attachment sequence buffers (AFSA), kept separate from bone buffers (AFSB). */
  readonly attachmentAnimBuffers?: ReadonlyMap<number, Uint8Array>
}

const MD20 = 0x3032444d // 'MD20' little-endian
const MD21 = 'MD21'
const NO_GLOBAL = 0xffff
/** Resident-data bits 0x20/0x100 and the runtime-loaded marker participate in the native 0x130 gate. */
export const SEQUENCE_EMBEDDED = 0x20
export const SEQUENCE_STORED_IN_MODEL = 0x100
export const SEQUENCE_RUNTIME_LOADED = 0x10
/** An alias selects another sequence's data, without requesting an ANIM of its own. */
export const SEQUENCE_ALIAS = 0x40

const tagAt = (bytes: Uint8Array, offset: number): string =>
  latin1.decode(bytes.subarray(offset, offset + 4))

/** Whether the bytes start like an M2: a flat `MD20` or a chunked file opening with `MD21`. */
export function isM2(prefix: Uint8Array): boolean {
  if (prefix.byteLength < 8) return false
  const tag = tagAt(prefix, 0)
  return tag === 'MD20' || tag === MD21
}

/** The chunk list of a chunked file; refuses a chunk running past the end. */
export function readChunks(bytes: Uint8Array, maxRecords: number, label = 'M2'): M2Chunk[] {
  const view = byteView(bytes)
  const chunks: M2Chunk[] = []
  let offset = 0
  while (offset + 8 <= bytes.byteLength) {
    if (chunks.length >= maxRecords) throw new RangeError(`${label} chunk count exceeds budget`)
    const tag = tagAt(bytes, offset)
    if (!/^[A-Z0-9]{4}$/u.test(tag)) throw new TypeError(`${label} chunk tag at ${String(offset)} is invalid`)
    const size = view.getUint32(offset + 4, true)
    requireRange(bytes, offset + 8, size, `${label} ${tag} chunk`)
    chunks.push(Object.freeze({ tag, offset: offset + 8, size }))
    offset += 8 + size
  }
  return chunks
}

/** Native facial-pose offsets, not skeleton records or animation keyframe buffers. */
export interface M2BonePose {
  readonly prelude: number
  /** Matrices retain native storage order; the client application rule is not inferred here. */
  readonly offsets: readonly { readonly bone: number; readonly matrix: readonly number[] }[]
  readonly chunks: readonly M2Chunk[]
}

/**
 * BONE profile 1: u32 prelude, BIDA u16 bone indices and BOMT 16-float offset matrices.
 * Original bounded decoder of the documented native layout (WhiteoutLib format specification §15).
 * It deliberately does not feed these matrices into the SKEL or ANIM track decoder.
 */
export function readBonePose(bytes: Uint8Array, maxRecords: number, boneCount?: number, signal?: AbortSignal): M2BonePose {
  signal?.throwIfAborted()
  requireRange(bytes, 0, 4, 'BONE prelude')
  const prelude = byteView(bytes).getUint32(0, true)
  if (prelude !== 1) throw new TypeError(`unsupported BONE prelude ${String(prelude)}`)
  if (boneCount !== undefined && (!Number.isSafeInteger(boneCount) || boneCount < 0))
    throw new TypeError('invalid BONE skeleton count')
  const payload = bytes.subarray(4)
  const chunks = readChunks(payload, maxRecords, 'BONE')
  const last = chunks.at(-1)
  if ((last === undefined ? 0 : last.offset + last.size) !== payload.byteLength)
    throw new TypeError('BONE has an incomplete chunk header')
  const single = (tag: string): M2Chunk => {
    const found = chunks.filter(chunk => chunk.tag === tag)
    if (found.length !== 1) throw new TypeError(`BONE requires one ${tag} chunk`)
    return found[0]!
  }
  const ids = single('BIDA')
  const matrices = single('BOMT')
  if (ids.size % 2 !== 0 || matrices.size % 64 !== 0 || ids.size / 2 !== matrices.size / 64)
    throw new TypeError('BONE bone indices and matrices have mismatched record sizes or counts')
  const count = boundedCount(ids.size / 2, maxRecords, 'BONE offsets')
  const view = byteView(payload)
  const seen = new Set<number>()
  const offsets: { bone: number; matrix: readonly number[] }[] = []
  for (let index = 0; index < count; index++) {
    if (index % 1024 === 0) signal?.throwIfAborted()
    const bone = view.getUint16(ids.offset + index * 2, true)
    if (seen.has(bone) || (boneCount !== undefined && bone >= boneCount))
      throw new TypeError(`BONE bone index ${String(bone)} is duplicated or outside the selected skeleton`)
    seen.add(bone)
    const matrix = Array.from({ length: 16 }, (_, component) =>
      view.getFloat32(matrices.offset + index * 64 + component * 4, true))
    if (!matrix.every(Number.isFinite)) throw new TypeError(`BONE matrix ${String(index)} is not finite`)
    offsets.push({ bone, matrix })
  }
  return { prelude, offsets, chunks: chunks.map(chunk => ({ ...chunk, offset: chunk.offset + 4 })) }
}

/** A u32 array chunk (SFID, TXID, BFID); a ragged tail is ignored as the client does. */
function u32s(bytes: Uint8Array, chunk: M2Chunk | undefined): number[] {
  if (chunk === undefined) return []
  const view = byteView(bytes)
  const values: number[] = []
  for (let at = chunk.offset; at + 4 <= chunk.offset + chunk.size; at += 4) values.push(view.getUint32(at, true))
  return values
}

/**
 * Bounded little-endian reads over one buffer, where an `M2Array`'s offset is relative to the
 * buffer start (the MD20 payload, a `.skin` file or an `.anim` payload).
 */
class Cursor {
  readonly view: DataView
  constructor(
    readonly bytes: Uint8Array,
    readonly maxRecords: number,
  ) {
    this.view = byteView(bytes)
  }
  u8(at: number): number {
    return this.view.getUint8(at)
  }
  u16(at: number): number {
    return this.view.getUint16(at, true)
  }
  i16(at: number): number {
    return this.view.getInt16(at, true)
  }
  u32(at: number): number {
    return this.view.getUint32(at, true)
  }
  i32(at: number): number {
    return this.view.getInt32(at, true)
  }
  f32(at: number): number {
    return this.view.getFloat32(at, true)
  }
  vec3(at: number): Vec3 {
    return [this.f32(at), this.f32(at + 4), this.f32(at + 8)]
  }
  /** An `M2Array` header at `at`: count and the checked start of `size`-byte records. */
  array(at: number, size: number, label: string): { readonly count: number; readonly offset: number } {
    requireRange(this.bytes, at, 8, label)
    const count = boundedCount(this.u32(at), this.maxRecords, label)
    const offset = this.u32(at + 4)
    if (count > 0) requireRange(this.bytes, offset, checkedProduct(count, size, label), label)
    return { count, offset }
  }
  /** Records of an `M2Array`, each decoded by `read` at its byte offset. */
  records<T>(at: number, size: number, label: string, read: (offset: number, index: number) => T): T[] {
    const { count, offset } = this.array(at, size, label)
    const out: T[] = []
    for (let index = 0; index < count; index += 1) out.push(read(offset + index * size, index))
    return out
  }
  u16s(at: number, label: string): number[] {
    return this.records(at, 2, label, offset => this.u16(offset))
  }
  string(at: number, label: string): string {
    const { count, offset } = this.array(at, 1, label)
    let end = offset
    while (end < offset + count && this.bytes[end] !== 0) end += 1
    return latin1.decode(this.bytes.subarray(offset, end))
  }
}

/** One compressed quaternion component (WhiteoutFlakes, from the client's M2CompQuat decode). */
export const quatComponent = (raw: number): number => raw * (2 / 65535) - 1

/** Track value decoders: byte size and read. */
const VEC3 = { size: 12, read: (c: Cursor, at: number): Vec3 => c.vec3(at) }
const QUAT = {
  size: 8,
  read: (c: Cursor, at: number): Quat => [
    quatComponent(c.u16(at)),
    quatComponent(c.u16(at + 2)),
    quatComponent(c.u16(at + 4)),
    quatComponent(c.u16(at + 6)),
  ],
}
const FIXED16 = { size: 2, read: (c: Cursor, at: number): number => c.i16(at) / 0x7fff }
const FLOAT_QUAT = { size: 16, read: (c: Cursor, at: number): Quat =>
  [c.f32(at), c.f32(at + 4), c.f32(at + 8), c.f32(at + 12)] }
const U8 = { size: 1, read: (c: Cursor, at: number): number => c.u8(at) }
const NONE = { size: 0, read: (): null => null }

/** Reads the tracks of one MD20 payload, sending external sequences to their `.anim` buffers. */
class TrackReader {
  private readonly animCursors = new Map<number, Cursor>()
  constructor(
    private readonly main: Cursor,
    private readonly sequences: readonly M2Sequence[],
    animBuffers: ReadonlyMap<number, Uint8Array> | undefined,
  ) {
    for (const [index, bytes] of animBuffers ?? []) this.animCursors.set(index, new Cursor(bytes, main.maxRecords))
  }
  /** Where sequence `index`'s keys live: the model, its `.anim`, or nowhere (missing). */
  sourceOf(index: number): Cursor | undefined {
    const sequence = this.sequences[index]
    if (sequence === undefined || (sequence.flags & (SEQUENCE_EMBEDDED | SEQUENCE_STORED_IN_MODEL)) !== 0) return this.main
    // Runtime-loaded alone does not establish an inline offset base. Only an explicit cached
    // ANIM buffer may supply it; the loader must not fetch another file for a resident runtime entry.
    return this.animCursors.get(index)
  }
  /** An `M2Track<T>` whose 20-byte header is at `at`; `kind` decodes one value. */
  read<T>(at: number, kind: { size: number; read: (c: Cursor, at: number) => T }, label: string): M2Track<T> {
    const c = this.main
    requireRange(c.bytes, at, 20, label)
    const interpolation = c.u16(at)
    const global = c.u16(at + 2)
    const times = c.array(at + 4, 8, `${label} timestamps`)
    const values = c.array(at + 12, 8, `${label} values`)
    if (times.count !== values.count) throw new TypeError(`${label} has ${String(times.count)} timestamp and ${String(values.count)} value lists`)
    const perSequence: M2Keys<T>[] = []
    const missing: number[] = []
    for (let index = 0; index < times.count; index += 1) {
      const timeHeader = times.offset + index * 8
      const valueHeader = values.offset + index * 8
      const count = c.u32(timeHeader)
      const valueCount = c.u32(valueHeader)
      if (count === 0 && valueCount === 0) {
        perSequence.push({ times: [], values: [] })
        continue
      }
      if (count !== valueCount && !(count === 0 && valueCount === 1))
        throw new TypeError(`${label} sequence ${String(index)} has mismatched timestamp/value counts`)
      const source = global === NO_GLOBAL ? this.sourceOf(index) : c
      if (source === undefined) {
        missing.push(index)
        perSequence.push({ times: [], values: [] })
        continue
      }
      if (count === 0) {
        const offset = c.u32(valueHeader + 4)
        requireRange(source.bytes, offset, kind.size, `${label} constant value`)
        perSequence.push({ times: [0], values: [kind.read(source, offset)] })
      } else {
        perSequence.push(readKeys(c, source, timeHeader, valueHeader, kind, `${label} sequence ${String(index)}`))
      }
    }
    return { interpolation, globalSequence: global === NO_GLOBAL ? null : global, perSequence, missing }
  }
}

/**
 * One keyframe list: the counts/offsets come from the model's headers (`header`), the keys from
 * `source` (the model itself, or the sequence's `.anim` payload, whose offsets are its own).
 */
function readKeys<T>(
  header: Cursor,
  source: Cursor,
  timeHeader: number,
  valueHeader: number,
  kind: { size: number; read: (c: Cursor, at: number) => T },
  label: string,
): M2Keys<T> {
  const count = boundedCount(header.u32(timeHeader), header.maxRecords, label)
  const timesOffset = header.u32(timeHeader + 4)
  const valuesOffset = header.u32(valueHeader + 4)
  requireRange(source.bytes, timesOffset, checkedProduct(count, 4, label), `${label} timestamps`)
  if (kind.size > 0) requireRange(source.bytes, valuesOffset, checkedProduct(count, kind.size, label), `${label} values`)
  const times: number[] = []
  const values: T[] = []
  for (let key = 0; key < count; key += 1) {
    times.push(source.u32(timesOffset + key * 4))
    values.push(kind.read(source, valuesOffset + key * kind.size))
  }
  return { times, values }
}

/** The 20-byte timestamp-only track of an event (`M2TrackBase` without values). */
function readEventTrack(reader: TrackReader, c: Cursor, at: number, label: string): M2Track<null> {
  // An event track has no value array; external sequences resolve as for any other track.
  requireRange(c.bytes, at, 12, label)
  const interpolation = c.u16(at)
  const global = c.u16(at + 2)
  const times = c.array(at + 4, 8, `${label} timestamps`)
  const perSequence: M2Keys<null>[] = []
  const missing: number[] = []
  for (let index = 0; index < times.count; index += 1) {
    const header = times.offset + index * 8
    const count = c.u32(header)
    if (count === 0) {
      perSequence.push({ times: [], values: [] })
      continue
    }
    const source = global === NO_GLOBAL ? reader.sourceOf(index) : c
    if (source === undefined) {
      missing.push(index)
      perSequence.push({ times: [], values: [] })
      continue
    }
    perSequence.push(readKeys(c, source, header, header, NONE, `${label} sequence ${String(index)}`))
  }
  return { interpolation, globalSequence: global === NO_GLOBAL ? null : global, perSequence, missing }
}

const SEQUENCE_SIZE = 64
const BONE_SIZE = 88
const VERTEX_SIZE = 48
const TEXTURE_SIZE = 16
const COLOR_SIZE = 40
const WEIGHT_SIZE = 20
const ATTACHMENT_SIZE = 40
const EVENT_SIZE = 36

/**
 * The MD20 payload of a model: from offset 0 of a flat file, or the `MD21` chunk of a chunked one,
 * with the chunk list (empty for a flat file).
 */
export function md20Of(bytes: Uint8Array, maxRecords: number): { readonly md20: Uint8Array; readonly chunks: readonly M2Chunk[] } {
  if (bytes.byteLength < 8) throw new RangeError('M2 file is truncated')
  if (byteView(bytes).getUint32(0, true) === MD20) return { md20: bytes, chunks: [] }
  const chunks = readChunks(bytes, maxRecords)
  const md21 = chunks.find(chunk => chunk.tag === MD21)
  if (md21 === undefined) throw new TypeError('M2 has no MD21 chunk')
  return { md20: bytes.subarray(md21.offset, md21.offset + md21.size), chunks }
}

/** The companions the chunks name by FileDataID. */
export function fileIdsOf(bytes: Uint8Array, chunks: readonly M2Chunk[], skinProfiles: number): M2FileIds {
  const find = (tag: string) => chunks.find(chunk => chunk.tag === tag)
  const sfid = u32s(bytes, find('SFID'))
  const afid = find('AFID')
  const view = byteView(bytes)
  const animations: { animId: number; subAnimId: number; fileId: number }[] = []
  if (afid !== undefined)
    for (let at = afid.offset; at + 8 <= afid.offset + afid.size; at += 8)
      animations.push({ animId: view.getUint16(at, true), subAnimId: view.getUint16(at + 2, true), fileId: view.getUint32(at + 4, true) })
  const skid = u32s(bytes, find('SKID'))[0]
  const pfid = u32s(bytes, find('PFID'))[0]
  return {
    skins: sfid.slice(0, skinProfiles),
    lodSkins: sfid.slice(skinProfiles),
    textures: u32s(bytes, find('TXID')),
    animations,
    bones: u32s(bytes, find('BFID')),
    ...(skid === undefined || skid === 0 ? {} : { skeleton: skid }),
    ...(pfid === undefined || pfid === 0 ? {} : { physics: pfid }),
  }
}

/** The sequences of an MD20 payload alone — what the codec needs to pick `.anim` files. */
export function readSequences(md20: Uint8Array, maxRecords: number): M2Sequence[] {
  const c = new Cursor(md20, maxRecords)
  checkVersion(c)
  return sequenceRecords(c, 0x1c)
}

/** Shared sequence record layout, used by MD20 and SKS1 with their own array header. */
function sequenceRecords(c: Cursor, header: number): M2Sequence[] {
  return c.records(header, SEQUENCE_SIZE, 'M2 sequences', at => ({
    id: c.u16(at),
    variation: c.u16(at + 2),
    duration: c.u32(at + 4),
    moveSpeed: c.f32(at + 8),
    flags: c.u32(at + 12),
    frequency: c.i16(at + 16),
    replayMin: c.u32(at + 20),
    replayMax: c.u32(at + 24),
    blendIn: c.u16(at + 28),
    blendOut: c.u16(at + 30),
    boundsMin: c.vec3(at + 32),
    boundsMax: c.vec3(at + 44),
    boundsRadius: c.f32(at + 56),
    variationNext: c.i16(at + 60),
    aliasNext: c.u16(at + 62),
  }))
}

/** The one bone record decoder for MD20 and SKB1; track offsets belong to this cursor. */
function boneRecords(c: Cursor, tracks: TrackReader, header: number): M2Bone[] {
  return c.records(header, BONE_SIZE, 'M2 bones', (at, index) => ({
    keyBoneId: c.i32(at), flags: c.u32(at + 4), parent: c.i16(at + 8), submeshId: c.u16(at + 10),
    translation: tracks.read(at + 16, VEC3, `M2 bone ${String(index)} translation`),
    rotation: tracks.read(at + 36, QUAT, `M2 bone ${String(index)} rotation`),
    scale: tracks.read(at + 56, VEC3, `M2 bone ${String(index)} scale`),
    pivot: c.vec3(at + 76),
  }))
}

/** Attachment records use their own external animation domain. */
function attachmentRecords(c: Cursor, tracks: TrackReader, header: number): M2Attachment[] {
  return c.records(header, ATTACHMENT_SIZE, 'M2 attachments', (at, index) => ({
    id: c.u32(at), bone: c.u16(at + 4), position: c.vec3(at + 8),
    enabled: tracks.read(at + 20, U8, `M2 attachment ${String(index)} enabled`),
  }))
}

/** A chunk's own bounded payload cursor; no skeleton offset is relative to the enclosing file. */
function skeletonCursor(bytes: Uint8Array, chunks: readonly M2Chunk[], tag: string, maxRecords: number): Cursor | undefined {
  const chunk = chunks.find(item => item.tag === tag)
  return chunk === undefined ? undefined : new Cursor(bytes.subarray(chunk.offset, chunk.offset + chunk.size), maxRecords)
}

/** Resolves native skeleton identities and sequence tables before companion I/O. */
export function skeletonDescriptor(bytes: Uint8Array, maxRecords: number): M2SkeletonDescriptor {
  const chunks = readChunks(bytes, maxRecords, 'M2 skeleton')
  if (!chunks.some(chunk => ['SKL1', 'SKS1', 'SKB1', 'SKA1', 'SKPD'].includes(chunk.tag)))
    throw new TypeError('M2 skeleton has no skeleton chunks')
  const sequence = skeletonCursor(bytes, chunks, 'SKS1', maxRecords)
  const parent = skeletonCursor(bytes, chunks, 'SKPD', maxRecords)
  if (parent !== undefined) requireRange(parent.bytes, 0, 16, 'M2 SKPD')
  const parentId = parent?.u32(8) ?? 0
  return {
    chunks, fileIds: fileIdsOf(bytes, chunks, 0),
    ...(parentId === 0 ? {} : { parent: parentId }),
    ...(sequence === undefined ? {} : {
      sequences: sequenceRecords(sequence, 8),
      globalLoops: sequence.records(0, 4, 'M2 skeleton global loops', at => sequence.u32(at)),
    }),
  }
}

/** Decodes a skeleton using its sequence table, or an explicitly supplied inherited table. */
export function readSkeleton(bytes: Uint8Array, options: M2ReadOptions & {
  readonly inheritedSequences?: readonly M2Sequence[]
  readonly inheritedGlobalLoops?: readonly number[]
}): M2Skeleton {
  const descriptor = skeletonDescriptor(bytes, options.maxRecords)
  const sequences = descriptor.sequences ?? options.inheritedSequences ?? []
  const bones = skeletonCursor(bytes, descriptor.chunks, 'SKB1', options.maxRecords)
  const attachments = skeletonCursor(bytes, descriptor.chunks, 'SKA1', options.maxRecords)
  return {
    ...descriptor,
    sequences,
    globalLoops: descriptor.globalLoops ?? options.inheritedGlobalLoops ?? [],
    ...(bones === undefined ? {} : {
      bones: boneRecords(bones, new TrackReader(bones, sequences, options.animBuffers), 0),
      keyBones: bones.u16s(8, 'M2 skeleton key bones'),
    }),
    ...(attachments === undefined ? {} : {
      attachments: attachmentRecords(attachments, new TrackReader(attachments, sequences, options.attachmentAnimBuffers), 0),
    }),
  }
}

function checkVersion(c: Cursor): number {
  requireRange(c.bytes, 0, 0x130, 'M2 MD20 header')
  if (c.u32(0) !== MD20) throw new TypeError('M2 MD21 payload does not start with MD20')
  const version = c.u32(4)
  if (version < 264 || version > 274)
    throw new TypeError(`M2 version ${String(version)} is not supported (264–274: Wrath of the Lich King to The War Within)`)
  return version
}

/**
 * Whether sequence `index` keeps its keyframes in an `.anim` file: neither embedded (0x20) nor an
 * alias (0x40) — an alias has no data of its own and plays its `aliasNext` target.
 */
export const isExternalSequence = (sequence: M2Sequence): boolean =>
  (sequence.flags & (SEQUENCE_EMBEDDED | SEQUENCE_STORED_IN_MODEL | SEQUENCE_RUNTIME_LOADED | SEQUENCE_ALIAS)) === 0

/** The whole model (header arrays and every track it names) from its bytes. */
export function readM2(bytes: Uint8Array, options: M2ReadOptions): M2Model {
  const { md20, chunks } = md20Of(bytes, options.maxRecords)
  const c = new Cursor(md20, options.maxRecords)
  const version = checkVersion(c)
  const sequences = readSequences(md20, options.maxRecords)
  const tracks = new TrackReader(c, sequences, options.animBuffers)
  const bones = boneRecords(c, tracks, 0x2c)
  const skinProfiles = c.u32(0x44)
  const globalFlags = c.u32(0x10)
  return {
    version,
    name: c.string(0x08, 'M2 name'),
    globalFlags,
    globalLoops: c.records(0x14, 4, 'M2 global loops', at => c.u32(at)),
    sequences,
    bones,
    keyBones: c.u16s(0x34, 'M2 key bones'),
    vertices: readVertices(c),
    skinProfiles,
    colors: c.records(0x48, COLOR_SIZE, 'M2 colors', (at, index) => ({
      color: tracks.read(at, VEC3, `M2 color ${String(index)}`),
      alpha: tracks.read(at + 20, FIXED16, `M2 color ${String(index)} alpha`),
    })),
    textures: c.records(0x50, TEXTURE_SIZE, 'M2 textures', (at, index) => ({
      type: c.u32(at),
      flags: c.u32(at + 4),
      filename: c.string(at + 8, `M2 texture ${String(index)} name`),
    })),
    textureWeights: c.records(0x58, WEIGHT_SIZE, 'M2 texture weights', (at, index) =>
      tracks.read(at, FIXED16, `M2 texture weight ${String(index)}`),
    ),
    textureTransforms: c.records(0x60, 60, 'M2 texture transforms', (at, index) => ({
      translation: tracks.read(at, VEC3, `M2 UV transform ${String(index)} translation`),
      rotation: tracks.read(at + 20, FLOAT_QUAT, `M2 UV transform ${String(index)} rotation`),
      scale: tracks.read(at + 40, VEC3, `M2 UV transform ${String(index)} scale`),
    })),
    materials: c.records(0x70, 4, 'M2 materials', at => ({ flags: c.u16(at), blend: c.u16(at + 2) })),
    boneCombos: c.u16s(0x78, 'M2 bone combos'),
    textureCombos: c.u16s(0x80, 'M2 texture combos'),
    textureCoordCombos: c.u16s(0x88, 'M2 texture coordinate combos'),
    textureWeightCombos: c.u16s(0x90, 'M2 texture weight combos'),
    textureTransformCombos: c.u16s(0x98, 'M2 texture transform combos'),
    boundsMin: c.vec3(0xa0),
    boundsMax: c.vec3(0xac),
    boundsRadius: c.f32(0xb8),
    attachments: attachmentRecords(c, new TrackReader(c, sequences, options.attachmentAnimBuffers ?? options.animBuffers), 0xf0),
    events: c.records(0x100, EVENT_SIZE, 'M2 events', (at, index) => ({
      identifier: latin1.decode(md20.subarray(at, at + 4)),
      data: c.u32(at + 4),
      bone: c.u32(at + 8),
      position: c.vec3(at + 12),
      times: readEventTrack(tracks, c, at + 24, `M2 event ${String(index)}`),
    })),
    chunks,
    fileIds: fileIdsOf(bytes, chunks, skinProfiles),
  }
}

/** The 48-byte vertex records as typed arrays. */
function readVertices(c: Cursor): M2Vertices {
  const { count, offset } = c.array(0x3c, VERTEX_SIZE, 'M2 vertices')
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const uv0 = new Float32Array(count * 2)
  const uv1 = new Float32Array(count * 2)
  const boneIndices = new Uint8Array(count * 4)
  const boneWeights = new Uint8Array(count * 4)
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * VERTEX_SIZE
    for (let axis = 0; axis < 3; axis += 1) {
      positions[index * 3 + axis] = c.f32(at + axis * 4)
      normals[index * 3 + axis] = c.f32(at + 20 + axis * 4)
    }
    for (let k = 0; k < 4; k += 1) {
      boneWeights[index * 4 + k] = c.u8(at + 12 + k)
      boneIndices[index * 4 + k] = c.u8(at + 16 + k)
    }
    uv0[index * 2] = c.f32(at + 32)
    uv0[index * 2 + 1] = c.f32(at + 36)
    uv1[index * 2] = c.f32(at + 40)
    uv1[index * 2 + 1] = c.f32(at + 44)
  }
  return { count, positions, normals, uv0, uv1, boneIndices, boneWeights }
}

/** One `.skin` profile. */
export function readSkin(bytes: Uint8Array, maxRecords: number): M2Skin {
  const c = new Cursor(bytes, maxRecords)
  requireRange(bytes, 0, 48, 'M2 skin header')
  if (tagAt(bytes, 0) !== 'SKIN') throw new TypeError('M2 skin does not start with SKIN')
  const vertexArray = c.array(4, 2, 'M2 skin vertices')
  const indexArray = c.array(12, 2, 'M2 skin indices')
  const vertices = new Uint16Array(vertexArray.count)
  for (let index = 0; index < vertexArray.count; index += 1) vertices[index] = c.u16(vertexArray.offset + index * 2)
  const indices = new Uint16Array(indexArray.count)
  for (let index = 0; index < indexArray.count; index += 1) indices[index] = c.u16(indexArray.offset + index * 2)
  return {
    vertices,
    indices,
    submeshes: c.records(28, 48, 'M2 skin submeshes', at => ({
      sectionId: c.u16(at),
      vertexStart: c.u16(at + 4),
      vertexCount: c.u16(at + 6),
      // the high word of the start rides in `level` (WhiteoutFlakes M2IndexStart, humanmale_hd00)
      indexStart: c.u16(at + 2) * 0x10000 + c.u16(at + 8),
      indexCount: c.u16(at + 10),
      boneCount: c.u16(at + 12),
      boneComboIndex: c.u16(at + 14),
      centerBone: c.u16(at + 18),
    })),
    batches: c.records(36, 24, 'M2 skin batches', at => ({
      flags: c.u8(at),
      priorityPlane: c.view.getInt8(at + 1),
      shaderId: c.u16(at + 2),
      submesh: c.u16(at + 4),
      colorIndex: c.i16(at + 8),
      materialIndex: c.u16(at + 10),
      materialLayer: c.u16(at + 12),
      textureCount: c.u16(at + 14),
      textureComboIndex: c.u16(at + 16),
      textureCoordComboIndex: c.u16(at + 18),
      textureWeightComboIndex: c.u16(at + 20),
      textureTransformComboIndex: c.u16(at + 22),
    })),
    lodVertexBase: c.u32(44),
  }
}

/**
 * The keyframe buffer of an `.anim` file: the `AFM2` payload of a chunked one, the whole file of
 * a raw one. A chunked file without `AFM2` (bone data for a `.skel` model only) has none.
 */
export function animPayload(bytes: Uint8Array, maxRecords: number, domain: 'model' | 'bones' | 'attachments' = 'model'): Uint8Array | undefined {
  const head = bytes.byteLength >= 4 ? tagAt(bytes, 0) : ''
  if (head !== 'AFM2' && head !== 'AFSA' && head !== 'AFSB') return bytes
  const chunks = readChunks(bytes, maxRecords, 'M2 anim')
  const tag = domain === 'bones' ? 'AFSB' : domain === 'attachments' ? 'AFSA' : 'AFM2'
  const afm2 = chunks.find(chunk => chunk.tag === tag) ?? chunks.find(chunk => chunk.tag === 'AFM2')
  return afm2 === undefined ? undefined : bytes.subarray(afm2.offset, afm2.offset + afm2.size)
}
