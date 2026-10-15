/**
 * Synthetic World of Warcraft M2 bundles for the `blizzard/wow-m2` suites: a chunked model (MD21 +
 * SFID, TXID, AFID), its skin and one chunked `.anim`, written byte by byte to the layouts the reader
 * documents. A test can therefore check every decoded number against the one it wrote.
 */

/** A growing little-endian buffer whose offsets are relative to its own start. */
class Blob {
  private bytes = new Uint8Array(1024)
  private view = new DataView(this.bytes.buffer)
  length = 0
  /** Reserve `size` zeroed bytes aligned to `align`; returns their offset. */
  alloc(size: number, align = 4): number {
    this.length = Math.ceil(this.length / align) * align
    const at = this.length
    this.length += size
    if (this.length > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.length, this.bytes.length * 2))
      grown.set(this.bytes)
      this.bytes = grown
      this.view = new DataView(grown.buffer)
    }
    return at
  }
  u8(at: number, value: number) { this.view.setUint8(at, value) }
  u16(at: number, value: number) { this.view.setUint16(at, value, true) }
  i16(at: number, value: number) { this.view.setInt16(at, value, true) }
  u32(at: number, value: number) { this.view.setUint32(at, value, true) }
  i32(at: number, value: number) { this.view.setInt32(at, value, true) }
  f32(at: number, value: number) { this.view.setFloat32(at, value, true) }
  vec3(at: number, value: readonly number[]) { value.forEach((component, axis) => this.f32(at + axis * 4, component)) }
  ascii(at: number, text: string) { for (let i = 0; i < text.length; i += 1) this.u8(at + i, text.charCodeAt(i)) }
  /** An `M2Array` header at `at` naming `count` records at `offset`. */
  array(at: number, count: number, offset: number) { this.u32(at, count); this.u32(at + 4, offset) }
  /** u16 values as a new array; returns its offset. */
  u16s(values: readonly number[]): number {
    const at = this.alloc(values.length * 2, 2)
    values.forEach((value, index) => this.u16(at + index * 2, value))
    return at
  }
  done(): Uint8Array { return this.bytes.slice(0, this.length) }
}

/** One keyframe list of a track: times and values (vec3/quat raw u16/fixed16 by kind). */
export interface FixtureKeys { readonly times: readonly number[]; readonly values: readonly (readonly number[])[] }

/** Compressed quaternion words for a unit quaternion (inverse of `raw · 2/65535 − 1`). */
export const packQuat = (q: readonly number[]): number[] => q.map(component => Math.round(((component + 1) * 65535) / 2))

/**
 * Write an `M2Track` header at `at` in `main`: one list per entry of `lists`. A list placed in
 * `anim` (an external sequence) has its header in `main` and its keys in `anim`.
 */
function writeTrack(
  main: Blob,
  at: number,
  kind: 'vec3' | 'quat' | 'float-quat' | 'fixed16' | 'u8' | 'none',
  lists: readonly (FixtureKeys & { readonly anim?: Blob })[],
  options: { interpolation?: number; global?: number } = {},
) {
  main.u16(at, options.interpolation ?? 1)
  main.u16(at + 2, options.global ?? 0xffff)
  const timeHeaders = main.alloc(lists.length * 8)
  const valueHeaders = main.alloc(lists.length * 8)
  main.array(at + 4, lists.length, timeHeaders)
  if (kind !== 'none') main.array(at + 12, lists.length, valueHeaders)
  const size = { vec3: 12, quat: 8, 'float-quat': 16, fixed16: 2, u8: 1, none: 0 }[kind]
  lists.forEach((list, index) => {
    const target = list.anim ?? main
    const times = target.alloc(list.times.length * 4)
    list.times.forEach((time, key) => target.u32(times + key * 4, time))
    main.array(timeHeaders + index * 8, list.times.length, times)
    if (kind === 'none') return
    const values = target.alloc(Math.max(1, list.values.length * size))
    list.values.forEach((value, key) => {
      const v = values + key * size
      if (kind === 'vec3') target.vec3(v, value)
      else if (kind === 'quat') value.forEach((word, c) => target.u16(v + c * 2, word))
      else if (kind === 'float-quat') value.forEach((component, c) => target.f32(v + c * 4, component))
      else if (kind === 'u8') target.u8(v, value[0]!)
      else target.i16(v, value[0]!)
    })
    main.array(valueHeaders + index * 8, list.values.length, values)
  })
}

const EMPTY: FixtureKeys = { times: [], values: [] }

/** A chunk: tag, u32 size, payload. */
export function chunk(tag: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  for (let i = 0; i < 4; i += 1) out[i] = tag.charCodeAt(i)
  new DataView(out.buffer).setUint32(4, payload.length, true)
  out.set(payload, 8)
  return out
}
export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
export const u32Payload = (values: readonly number[]): Uint8Array => {
  const out = new Uint8Array(values.length * 4)
  values.forEach((value, index) => new DataView(out.buffer).setUint32(index * 4, value, true))
  return out
}

export const SKIN_FILE_ID = 5001
export const TEXTURE_FILE_ID = 6001
export const ANIM_FILE_ID = 7001

/** Native AFID/sequence table crossing the old 200-file cap; every file is a valid AFM2 buffer. */
export function fixtureAnimationPages(count = 205): { model: Uint8Array; skin: Uint8Array; anim: Uint8Array } {
  const bundle = fixtureBundle()
  const m = new Blob()
  m.alloc(bundle.flat.length, 1)
  bundle.flat.forEach((value, index) => m.u8(index, value))
  const view = new DataView(bundle.flat.buffer, bundle.flat.byteOffset)
  const original = view.getUint32(0x20, true)
  const table = m.alloc((count + 1) * 64)
  bundle.flat.subarray(original, original + 64).forEach((value, index) => m.u8(table + index, value))
  const afid = new Uint8Array(count * 8)
  const ids = new DataView(afid.buffer)
  for (let index = 0; index < count; index += 1) {
    const at = table + (index + 1) * 64
    bundle.flat.subarray(original + 64, original + 128).forEach((value, offset) => m.u8(at + offset, value))
    m.u16(at, index + 4)
    ids.setUint16(index * 8, index + 4, true)
    ids.setUint32(index * 8 + 4, ANIM_FILE_ID + index, true)
  }
  m.array(0x1c, count + 1, table)
  return { model: concat([chunk('MD21', m.done()), chunk('SFID', u32Payload([SKIN_FILE_ID])),
    chunk('TXID', u32Payload([TEXTURE_FILE_ID, 0])), chunk('AFID', afid)]), skin: bundle.skin, anim: bundle.anim }
}

/** Native single-texture MOD profile with independently clocked colour/alpha/weight and UV translation. */
export function fixtureMaterialBundle(batchFlags = 0): ReturnType<typeof fixtureBundle> {
  const bundle = fixtureBundle()
  const m = new Blob()
  m.alloc(bundle.flat.length, 1)
  bundle.flat.forEach((value, index) => m.u8(index, value))
  const a = new Blob()
  const oldAnim = bundle.anim.subarray(8)
  a.alloc(oldAnim.length, 1)
  oldAnim.forEach((value, index) => a.u8(index, value))
  const colors = m.alloc(40)
  writeTrack(m, colors, 'vec3', [{ times: [0, 1000], values: [[0.5, 0.4, 0.25], [1, 0.8, 0.5]] }], { global: 0 })
  writeTrack(m, colors + 20, 'fixed16', [
    { times: [0, 1000], values: [[0x4000], [0x7fff]] },
    { times: [0, 500], values: [[0x7fff], [0x4000]], anim: a },
  ])
  m.array(0x48, 1, colors)
  const weight = m.alloc(20)
  writeTrack(m, weight, 'fixed16', [{ times: [0, 1000], values: [[0x4000], [0x7fff]] }], { global: 0 })
  m.array(0x58, 1, weight)
  const transform = m.alloc(60)
  writeTrack(m, transform, 'vec3', [{ times: [0, 1000], values: [[0, 0, 0], [0.2, 0.4, 0]] }], { global: 0 })
  writeTrack(m, transform + 20, 'float-quat', [{ times: [0], values: [[0, 0, 0, 1]] }])
  writeTrack(m, transform + 40, 'vec3', [{ times: [0], values: [[1, 1, 1]] }])
  m.array(0x60, 1, transform)
  m.array(0x98, 1, m.u16s([0]))
  const original = new DataView(bundle.flat.buffer, bundle.flat.byteOffset)
  m.u16(original.getUint32(0x74, true), 0x17) // unlit, no fog, two-sided, no depth write
  m.u32(original.getUint32(0x54, true) + 4, 3) // wrap both axes
  const flat = m.done()
  const skin = bundle.skin.slice()
  const view = new DataView(skin.buffer)
  const batch = view.getUint32(40, true)
  view.setUint8(batch, batchFlags)
  view.setUint16(batch + 2, 0x10, true)
  view.setUint16(batch + 14, 1, true)
  const model = concat([chunk('MD21', flat), chunk('SFID', u32Payload([SKIN_FILE_ID])),
    chunk('TXID', u32Payload([TEXTURE_FILE_ID, 0])), chunk('AFID', new Uint8Array([4, 0, 0, 0, 0x59, 0x1b, 0, 0]))])
  return { model, flat, skin, anim: chunk('AFM2', a.done()) }
}

/**
 * The fixture bundle. The model: version 274, name "Fixture", sequences 0 (Stand, embedded) and
 * 1 (id 4, external in `.anim`), global loop 1000 ms; bone 0 (root, pivot 0,0,0) and bone 1
 * (parent 0, pivot 0,0,1, spherical billboard) with a translation track keyed in both sequences
 * and a rotation track on the global sequence; three vertices bound to bone 1; one texture
 * (type 0, TXID) and one game-chosen (type 1); one alpha-blend material without depth writes; an
 * attachment (HandRight) on bone 1 at 0,0,2 and a `$FSD` event at 250 ms of sequence 0.
 */
export function fixtureBundle(): { model: Uint8Array; skin: Uint8Array; anim: Uint8Array; flat: Uint8Array } {
  const m = new Blob()
  const anim = new Blob()
  const header = m.alloc(0x130)
  m.ascii(header, 'MD20')
  m.u32(header + 4, 274)
  const name = m.alloc(8, 1)
  m.ascii(name, 'Fixture')
  m.array(header + 0x08, 8, name)
  m.u32(header + 0x10, 0x2080)
  const loops = m.alloc(4)
  m.u32(loops, 1000)
  m.array(header + 0x14, 1, loops)
  // sequences
  const sequences = m.alloc(64 * 2)
  const sequence = (index: number, id: number, flags: number, duration: number) => {
    const at = sequences + index * 64
    m.u16(at, id)
    m.u32(at + 4, duration)
    m.f32(at + 8, index === 1 ? 2.5 : 0)
    m.u32(at + 12, flags)
    m.u16(at + 28, 150)
    m.u16(at + 30, 150)
    m.i16(at + 60, -1)
    m.u16(at + 62, index)
  }
  sequence(0, 0, 0x20, 1000)
  sequence(1, 4, 0x00, 500)
  m.array(header + 0x1c, 2, sequences)
  // bones
  const bones = m.alloc(88 * 2)
  m.array(header + 0x2c, 2, bones)
  for (const [index, parent, pivot, flags] of [[0, -1, [0, 0, 0], 0], [1, 0, [0, 0, 1], 0x88]] as const) {
    const at = bones + index * 88
    m.i32(at, -1)
    m.u32(at + 4, flags)
    m.i16(at + 8, parent)
    m.vec3(at + 76, pivot)
    if (index === 0) {
      writeTrack(m, at + 16, 'vec3', [EMPTY, EMPTY])
      writeTrack(m, at + 36, 'quat', [EMPTY, EMPTY])
      writeTrack(m, at + 56, 'vec3', [EMPTY, EMPTY])
      continue
    }
    writeTrack(m, at + 16, 'vec3', [
      { times: [0, 1000], values: [[0, 0, 0], [1, 0, 0]] },
      { times: [0, 500], values: [[0, 0, 0], [0, 2, 0]], anim },
    ])
    writeTrack(m, at + 36, 'quat', [{ times: [0, 1000], values: [packQuat([0, 0, 0, 1]), packQuat([0, 0, 1, 0])] }], { global: 0 })
    writeTrack(m, at + 56, 'vec3', [EMPTY, EMPTY], { interpolation: 0 })
  }
  // vertices: a triangle bound fully to bone 1
  const vertices = m.alloc(48 * 3)
  m.array(header + 0x3c, 3, vertices)
  ;[[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((position, index) => {
    const at = vertices + index * 48
    m.vec3(at, position)
    m.u8(at + 12, 255)
    m.u8(at + 16, 1)
    m.vec3(at + 20, [0, 0, 1])
    m.f32(at + 32, position[0]!)
    m.f32(at + 36, position[1]!)
    m.f32(at + 40, 0.5)
  })
  m.u32(header + 0x44, 1) // one skin profile
  // textures: type 0 (TXID) and type 1 (game-chosen body skin)
  const textures = m.alloc(16 * 2)
  m.u32(textures + 16, 1)
  m.array(header + 0x50, 2, textures)
  // texture weight: 0x7FFF at the first key of sequence 0
  const weights = m.alloc(20)
  writeTrack(m, weights, 'fixed16', [{ times: [0], values: [[0x4000]] }, EMPTY])
  m.array(header + 0x58, 1, weights)
  // material: alpha blend (2), no depth write (0x10), two-sided (0x4)
  const materials = m.alloc(4)
  m.u16(materials, 0x14)
  m.u16(materials + 2, 2)
  m.array(header + 0x70, 1, materials)
  m.array(header + 0x78, 2, m.u16s([0, 1]))
  m.array(header + 0x80, 2, m.u16s([0, 1]))
  m.array(header + 0x88, 2, m.u16s([0, 1]))
  m.array(header + 0x90, 1, m.u16s([0]))
  m.array(header + 0x98, 1, m.u16s([0xffff]))
  m.vec3(header + 0xa0, [-1, -1, 0])
  m.vec3(header + 0xac, [1, 1, 2])
  m.f32(header + 0xb8, 2)
  // attachment HandRight on bone 1
  const attachments = m.alloc(40)
  m.u32(attachments, 1)
  m.u16(attachments + 4, 1)
  m.vec3(attachments + 8, [0, 0, 2])
  writeTrack(m, attachments + 20, 'none', [])
  m.array(header + 0xf0, 1, attachments)
  // event $FSD on bone 1 at 250 ms of sequence 0
  const events = m.alloc(36)
  m.ascii(events, '$FSD')
  m.u32(events + 4, 77)
  m.u32(events + 8, 1)
  m.u16(events + 24, 0)
  m.u16(events + 26, 0xffff)
  const eventTimes = m.alloc(16)
  const eventKeys = m.alloc(4)
  m.u32(eventKeys, 250)
  m.array(eventTimes, 1, eventKeys)
  m.array(eventTimes + 8, 0, 0)
  m.array(events + 28, 2, eventTimes)
  m.array(header + 0x100, 1, events)
  const md20 = m.done()

  // skin: three vertices, one triangle, one submesh, one batch
  const s = new Blob()
  const skinHeader = s.alloc(64)
  s.ascii(skinHeader, 'SKIN')
  s.array(4, 3, s.u16s([0, 1, 2]))
  s.array(12, 3, s.u16s([0, 1, 2]))
  const submesh = s.alloc(48)
  s.u16(submesh + 6, 3)
  s.u16(submesh + 10, 3)
  s.u16(submesh + 12, 1)
  s.array(28, 1, submesh)
  const batch = s.alloc(24)
  s.u16(batch + 14, 2) // two texture units: the TXID texture and the game-chosen one
  s.array(36, 1, batch)

  const model = concat([
    chunk('MD21', md20),
    chunk('SFID', u32Payload([SKIN_FILE_ID])),
    chunk('TXID', u32Payload([TEXTURE_FILE_ID, 0])),
    (() => {
      const payload = new Uint8Array(8)
      const view = new DataView(payload.buffer)
      view.setUint16(0, 4, true)
      view.setUint16(2, 0, true)
      view.setUint32(4, ANIM_FILE_ID, true)
      return chunk('AFID', payload)
    })(),
  ])
  return { model, skin: s.done(), anim: chunk('AFM2', anim.done()), flat: md20 }
}

export const SKELETON_FILE_ID = 8001
export const PARENT_SKELETON_FILE_ID = 8002

/** Native BONE framing: an untagged u32 prelude followed by independently sized chunks. */
export function fixtureBonePose(ids: readonly number[] = [0, 1], matrixCount = ids.length): Uint8Array {
  const indices = new Blob()
  indices.u16s(ids)
  const matrices = new Blob()
  const start = matrices.alloc(matrixCount * 64)
  for (let index = 0; index < matrixCount; index++) {
    for (const component of [0, 5, 10, 15]) matrices.f32(start + index * 64 + component * 4, 1)
    matrices.f32(start + index * 64 + 12 * 4, index + 0.25)
  }
  return concat([u32Payload([1]), chunk('BIDA', indices.done()), chunk('BOMT', matrices.done())])
}

export function fixtureBonePoseBundle(): ReturnType<typeof fixtureBundle> {
  const bundle = fixtureBundle()
  return { ...bundle, model: concat([bundle.model, chunk('BFID', u32Payload([9001, 9001, 9002, 0]))]) }
}

/** SKEL arrays/offsets obey the native chunk-local layout; bone and attachment data are distinct. */
export function fixtureSkeleton(options: { readonly parent?: number; readonly externalId?: number;
  readonly animationFileId?: number } = {}): { readonly skeleton: Uint8Array; readonly anim: Uint8Array } {
  const base = fixtureBundle()
  const bones = base.flat.slice()
  bones.set(base.flat.subarray(0x2c, 0x34), 0)
  bones.set(base.flat.subarray(0x34, 0x3c), 8)
  const sequences = base.flat.slice()
  sequences.set(base.flat.subarray(0x14, 0x1c), 0)
  sequences.set(base.flat.subarray(0x1c, 0x24), 8)
  sequences.set(base.flat.subarray(0x24, 0x2c), 16)
  const sequenceOffset = new DataView(sequences.buffer).getUint32(12, true)
  new DataView(sequences.buffer).setUint16(sequenceOffset + 64, options.externalId ?? 4, true)
  const attachmentBytes = new Blob()
  const attachmentAnim = new Blob()
  attachmentBytes.alloc(16)
  const record = attachmentBytes.alloc(40)
  attachmentBytes.array(0, 1, record)
  attachmentBytes.u32(record, 1)
  attachmentBytes.u16(record + 4, 1)
  attachmentBytes.vec3(record + 8, [0, 0, 2])
  writeTrack(attachmentBytes, record + 20, 'u8', [
    { times: [0], values: [[1]] },
    { times: [0, 500], values: [[1], [0]], anim: attachmentAnim },
  ])
  const afid = new Blob()
  afid.alloc(8)
  afid.u16(0, options.externalId ?? 4)
  afid.u32(4, options.animationFileId ?? ANIM_FILE_ID)
  const parent = new Blob()
  parent.alloc(16)
  parent.u32(8, options.parent ?? 0)
  return {
    skeleton: concat([chunk('SKS1', sequences), chunk('SKB1', bones), chunk('SKA1', attachmentBytes.done()),
      chunk('AFID', afid.done()), ...(options.parent === undefined ? [] : [chunk('SKPD', parent.done())])]),
    anim: concat([chunk('AFSB', base.anim.subarray(8)), chunk('AFSA', attachmentAnim.done())]),
  }
}

/** Geometry is in M2, while sequence/bone/attachment records live only in its declared SKEL. */
export function fixtureSharedSkeleton(): ReturnType<typeof fixtureBundle> & ReturnType<typeof fixtureSkeleton> {
  const base = fixtureBundle()
  const primary = base.flat.slice()
  const view = new DataView(primary.buffer)
  for (const header of [0x1c, 0x2c, 0xf0]) { view.setUint32(header, 0, true); view.setUint32(header + 4, 0, true) }
  const skel = fixtureSkeleton()
  return { ...base, ...skel,
    model: concat([chunk('MD21', primary), chunk('SFID', u32Payload([SKIN_FILE_ID])),
      chunk('TXID', u32Payload([TEXTURE_FILE_ID, 0])), chunk('SKID', u32Payload([SKELETON_FILE_ID]))]),
  }
}
