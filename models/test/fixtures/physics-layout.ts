import { readFile } from 'node:fs/promises'
import { createRigidBodyNativeFixture } from './rigid-body.js'

export type PhysicsFixtureVariant =
  | 'mesh16'
  | 'mesh32'
  | 'hull'
  | 'two-shapes'
  | 'bad-index'
  | 'both-streams'
  | 'bad-tag'
  | 'bad-count'
  | 'nonzero-w'
interface Description {
  readonly history: unknown
  readonly size: number
  instance(): Record<string, unknown>
}
interface Section {
  desc: Description
  readonly indexEntry: { version: number }
  content: Record<string, unknown>[]
}
interface Sections extends Array<Section> {
  readonly model: Record<string, unknown>
  getSectionByReference(reference: unknown): Section | null
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('physics literal fixture structure absent')
  return value as Record<string, unknown>
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new TypeError('physics literal fixture value absent')
  return value
}

/** Synthetic fixed-byte physics corpus. The native writer only lays out the enclosing section
 * graph; PHSH, vertex and triangle payloads use literal offsets/bytes independent of production
 * field descriptors. These are format regression fixtures, not evidence of retail conformance.
 */
export async function createPhysicsLayoutFixture(
  version: 1 | 2 | 3,
  variant: PhysicsFixtureVariant = 'mesh16',
): Promise<Uint8Array> {
  const base = await createRigidBodyNativeFixture()
  const { M3SectionList } = (await import(
    new URL('../../dist/m3/native/binary/sections.js', import.meta.url).href
  )) as {
    M3SectionList: { load(buffer: ArrayBuffer, xml: string): Promise<Sections> }
  }
  const { M3StructureDescription } = (await import(
    new URL('../../dist/m3/native/binary/structures.js', import.meta.url).href
  )) as {
    M3StructureDescription: new (
      history: unknown,
      version: number,
      fields: Record<string, unknown>,
      size: number,
    ) => Description
  }
  const { M3FieldBytes } = (await import(
    new URL('../../dist/m3/native/binary/fields.js', import.meta.url).href
  )) as {
    M3FieldBytes: new (name: string, size: number, value: Uint8Array) => unknown
  }
  const { appendM3Section, replaceM3ReferencedRecords, serializeM3SectionGraph } = (await import(
    new URL('../../dist/m3/native/structural.js', import.meta.url).href
  )) as {
    appendM3Section(sections: Sections, tag: string, version: number): Section
    replaceM3ReferencedRecords(
      sections: Sections,
      reference: unknown,
      records: readonly Record<string, unknown>[],
    ): void
    serializeM3SectionGraph(sections: Sections): Uint8Array
  }
  const buffer = new ArrayBuffer(base.length)
  new Uint8Array(buffer).set(base)
  const xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(buffer, xml)
  const body = record(
    required(sections.getSectionByReference(sections.model['physics_rigidbodies'])).content[0],
  )
  const shapes = required(sections.getSectionByReference(body['physics_shape']))
  const opaque = (
    section: Section,
    version: number,
    stride: number,
    payloads: readonly Uint8Array[],
  ) => {
    section.desc = new M3StructureDescription(
      section.desc.history,
      version,
      { raw: new M3FieldBytes('raw', stride, new Uint8Array(stride)) },
      stride,
    )
    section.indexEntry.version = version
    section.content = payloads.map(raw => {
      const instance = section.desc.instance()
      instance['raw'] = raw
      return instance
    })
  }
  const hull = variant === 'hull'
  const vector4 = version === 3 && !hull
  const points = [
    [0, 0, 0],
    [2, 0, 0],
    [0, 3, 0],
    [0, 0, 4],
  ]
  const vertexSection = appendM3Section(sections, vector4 ? 'VEC4' : 'VEC3', 0)
  opaque(
    vertexSection,
    0,
    vector4 ? 16 : 12,
    points.map(point => {
      const bytes = new Uint8Array(vector4 ? 16 : 12),
        view = new DataView(bytes.buffer)
      point.forEach((value, axis) => view.setFloat32(axis * 4, value, true))
      if (vector4) view.setFloat32(12, variant === 'nonzero-w' ? 1 : 0, true)
      return bytes
    }),
  )
  // Hull VEC3 points and VEC4 support planes are distinct references. In particular,
  // the nonzero plane distance must never be interpreted as a homogeneous vertex w.
  const planeSection = hull ? appendM3Section(sections, 'VEC4', 0) : undefined
  if (planeSection !== undefined) {
    const length = Math.sqrt(61)
    const planes = [
      [-1, 0, 0, 0],
      [0, -1, 0, 0],
      [0, 0, -1, 0],
      [6 / length, 4 / length, 3 / length, 12 / length],
    ]
    opaque(
      planeSection,
      0,
      16,
      planes.map(plane => {
        const bytes = new Uint8Array(16),
          view = new DataView(bytes.buffer)
        plane.forEach((value, axis) => view.setFloat32(axis * 4, value, true))
        return bytes
      }),
    )
  }
  const triangles = [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ]
  if (variant === 'bad-index') required(triangles[1])[2] = 4
  let first: Section | undefined, second: Section | undefined
  if (!hull) {
    const triangleSection = (wide: boolean): Section => {
      const tag = version === 1 ? 'U16_' : version === 2 ? 'DMMT' : wide ? 'MT32' : 'MT16'
      const section = appendM3Section(sections, tag, 0)
      if (version === 1) {
        // U16_ uses a primitive descriptor; its plain numeric content is independently authored.
        const numeric = triangles.flat()
        // The narrow JS runtime boundary allows the native scalar array representation.
        const target = section as unknown as { content: number[] }
        target.content = numeric
      } else {
        const width = version === 2 || wide ? 4 : 2
        opaque(
          section,
          0,
          width * 7,
          triangles.map(face => {
            const bytes = new Uint8Array(width * 7),
              view = new DataView(bytes.buffer)
            const values = [...face, width === 2 ? 65535 : 4294967295, 0, 1, 0]
            values.forEach((value, i) =>
              width === 2
                ? view.setUint16(i * width, value, true)
                : view.setUint32(i * width, value, true),
            )
            return bytes
          }),
        )
      }
      return section
    }
    if (version === 3 && variant === 'mesh32') second = triangleSection(true)
    else first = triangleSection(false)
    if (version === 3 && variant === 'both-streams') second = triangleSection(true)
  }
  const size = version === 1 ? 132 : version === 2 ? 292 : 300
  const payloads = Array.from({ length: variant === 'two-shapes' ? 2 : 1 }, (_, shapeIndex) => {
    const payload = new Uint8Array(size),
      view = new DataView(payload.buffer)
    const matrix = [
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      ...(shapeIndex === 0 ? [1, 2, 3] : [5, 7, 11]),
      1,
    ]
    matrix.forEach((value, i) => view.setFloat32(i * 4, value, true))
    view.setUint8(version === 1 ? 68 : 64, hull ? 4 : 5)
    if (version === 1) view.setUint32(64, 0x3ca14285, true)
    const dimensions = version === 1 ? 120 : 92
    ;[2, 3, 4].forEach((value, i) => view.setFloat32(dimensions + 4 * i, value, true))
    const putRef = (offset: number, section: Section | undefined, count?: number) => {
      if (section === undefined) return
      view.setUint32(offset, count ?? section.content.length, true)
      view.setUint32(offset + 4, sections.indexOf(section), true)
    }
    const vertexOffset = version === 1 ? 72 : hull ? 104 : version === 2 ? 232 : 196
    putRef(
      vertexOffset,
      variant === 'bad-tag' ? first : vertexSection,
      variant === 'bad-count' ? 5 : undefined,
    )
    if (hull) putRef(version === 1 ? 108 : 116, planeSection)
    if (!hull) {
      putRef(version === 1 ? 96 : version === 2 ? 244 : 208, first)
      if (version === 3) putRef(220, second)
    }
    if (version === 2) {
      // Native XML v2 has six u32 tail fields at268..291. Preserve unknowns; do not read300.
      ;[0, 4, 4, 0, 0x12345678, 0x13579bdf].forEach((value, i) =>
        view.setUint32(268 + 4 * i, value, true),
      )
    } else if (version === 3) {
      ;[11, 13, 17, 19, 23, 29, 0.25, 0.5, 0.75].forEach((value, i) =>
        view.setFloat32(232 + i * 4, value, true),
      )
      ;[0, 4, first === undefined ? 0 : 4, second === undefined ? 0 : 4, 23, 0, 0].forEach(
        (value, i) => view.setUint32(268 + i * 4, value, true),
      )
      view.setFloat32(296, 0.125, true)
    }
    return payload
  })
  opaque(shapes, version, size, payloads)
  replaceM3ReferencedRecords(sections, body['physics_shape'], shapes.content)
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
