import type { JsonObject } from '@modkit/sdk'
import type { M3RigidBody, M3RigidShapeGeometry } from './rigid-bodies.js'

interface Field {
  readonly name: string
  readonly size: number
}
interface Description {
  readonly history: { readonly name: string; readonly primitive: boolean }
  readonly version: number
  readonly size: number
  readonly fields: Readonly<Record<string, Field>>
}
interface Section {
  readonly desc: Description
  readonly indexEntry: Readonly<Record<string, unknown>>
  readonly content: readonly unknown[]
  readonly rawBytes: ArrayBuffer | null
}
export interface M3PhysicsSections extends Array<Section> {
  readonly mdVersion: number
  readonly model: Readonly<Record<string, unknown>>
}
export interface M3PhysicsBudget {
  readonly maxNodes: number
  readonly maxScalarBytes: number
}
export type M3PhysicsFieldType =
  'Matrix44' | 'Reference' | 'VEC3' | 'uint8' | 'uint16' | 'uint32' | 'float'
/** The existing native field readers own scalar/reference decoding. No registry is modified. */
export type M3PhysicsFieldReader = (
  type: M3PhysicsFieldType,
  buffer: ArrayBuffer,
  byteOffset: number,
) => unknown

const widths: Readonly<Record<M3PhysicsFieldType, number>> = {
  Matrix44: 64,
  Reference: 12,
  VEC3: 12,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  float: 4,
}
// Physical MD34 PHSH v3 layout, independently checked against native index/range fixtures.
// WhiteoutLib e4b1457cc1c3630c87ea28381a764e5e53a4bb68: PhysicsShape/parse visitor.
// The frozen XML's duplicate names and trailing guesses cannot be uniquified into this layout.
const v3Fields: readonly (readonly [string, M3PhysicsFieldType])[] = [
  ['matrix', 'Matrix44'],
  ['shape', 'uint8'],
  ['shape_fb8', 'uint8'],
  ['shape_fb16', 'uint16'],
  ['legacy_sizes', 'VEC3'],
  ['reserved_reference', 'Reference'],
  ['size0', 'float'],
  ['size1', 'float'],
  ['size2', 'float'],
  ['vertices', 'Reference'],
  ['plane_equations', 'Reference'],
  ['loops', 'Reference'],
  ['polygons', 'Reference'],
  ['polygons_center', 'VEC3'],
  ['vertices_count', 'uint32'],
  ['polygons_count', 'uint32'],
  ['loops_count', 'uint32'],
  ['unknown8d41b3f8', 'float'],
  ['unknown56fece2', 'float'],
  ['mesh_bvh', 'Reference'],
  ['mesh_vertices', 'Reference'],
  ['mesh_triangles16', 'Reference'],
  ['mesh_triangles32', 'Reference'],
  ['mesh_bounds_center', 'VEC3'],
  ['mesh_bounds_extent', 'VEC3'],
  ['mesh_tolerance', 'VEC3'],
  ['mesh_bvh_count', 'uint32'],
  ['mesh_vertex_count', 'uint32'],
  ['mesh_triangle16_count', 'uint32'],
  ['mesh_triangle32_count', 'uint32'],
  ['mesh_unknown', 'uint32'],
  ['mesh_reserved', 'uint32'],
  ['mesh_tree_depth', 'uint32'],
  ['mesh_collision_margin', 'float'],
]

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`M3 physics ${label} must be a structure`)
  return value as Readonly<Record<string, unknown>>
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`M3 physics ${label} must be a nonnegative integer`)
  return value
}
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`M3 physics ${label} is absent`)
  return value
}

/** Replaces only parse-local PHSH v3 views. Original bytes, schema histories and native kernels
 * remain unchanged. Corrected names describe physical native fields, never synthetic source edits.
 */
export function repairM3PhysicsSections(
  sections: M3PhysicsSections,
  bytes: Uint8Array,
  read: M3PhysicsFieldReader,
  budget: M3PhysicsBudget,
  signal?: AbortSignal,
): void {
  let working = 0
  for (const [index, section] of sections.entries()) {
    signal?.throwIfAborted()
    if (section.desc.history.name !== 'PHSH' || section.desc.version !== 3) continue
    if (sections.mdVersion !== 34)
      throw new TypeError('M3 PHSH v3 layout adapter requires an audited MD34 source')
    const offset = integer(section.indexEntry['offset'], 'PHSH offset')
    const count = integer(section.indexEntry['repetitions'], 'PHSH repetitions')
    const length = count * 300
    working += length
    if (
      !Number.isSafeInteger(working) ||
      working > budget.maxScalarBytes ||
      count > budget.maxNodes
    )
      throw new RangeError('M3 PHSH layout exceeds its resource budget')
    const header = object(sections[0]?.content[0], 'header')
    const indexOffset = integer(header['index_offset'], 'index offset')
    let limit = indexOffset > offset ? Math.min(indexOffset, bytes.length) : bytes.length
    for (const other of sections) {
      const candidate = integer(other.indexEntry['offset'], 'section offset')
      if (candidate > offset && candidate < limit) limit = candidate
    }
    if (offset + length > bytes.length || offset + length > limit)
      throw new RangeError('M3 PHSH v3 source range is incomplete or overlaps another section')
    const rawBytes = Uint8Array.from(bytes.subarray(offset, offset + length)).buffer
    const fields = Object.fromEntries(
      v3Fields.map(([name, type]) => [name, { name, size: widths[type] }]),
    )
    const desc: Description = {
      history: { name: 'PHSH', primitive: false },
      version: 3,
      size: 300,
      fields,
    }
    const content: Record<string, unknown>[] = []
    for (let item = 0; item < count; item++) {
      signal?.throwIfAborted()
      const value: Record<string, unknown> = { desc }
      let cursor = item * 300
      for (const [name, type] of v3Fields) {
        value[name] = read(type, rawBytes, cursor)
        cursor += widths[type]
      }
      if (cursor !== (item + 1) * 300)
        throw new TypeError('M3 PHSH v3 field coverage is incomplete')
      content.push(value)
    }
    sections[index] = { ...section, desc, content, rawBytes }
  }
}

/** Verify a reference-free record through the existing native field readers. */
export function assertM3AnalyticShapeRecord(
  raw: Readonly<Record<string, unknown>>,
  shape: { readonly shapeCode: number; readonly size: readonly number[]; readonly matrix4: readonly number[] },
): void {
  for (const [name, type] of v3Fields) {
    if (type === 'Reference' && object(raw[name], name)['entries'] !== 0)
      throw new TypeError('M3 degenerate PHSH record has an external reference')
  }
  if (raw['shape'] !== shape.shapeCode ||
      ['size0', 'size1', 'size2'].some((key, index) => raw[key] !== shape.size[index]))
    throw new TypeError('M3 degenerate PHSH record disagrees with its dimensions or type')
  const matrix = object(raw['matrix'], 'matrix')
  const values = ['x', 'y', 'z', 'w'].flatMap(column => {
    const vector = object(matrix[column], `matrix.${column}`)
    return ['x', 'y', 'z', 'w'].map(component => vector[component])
  })
  if (values.some((value, index) => value !== shape.matrix4[index]))
    throw new TypeError('M3 degenerate PHSH record disagrees with its matrix')
}

function reference(
  sections: M3PhysicsSections,
  value: unknown,
  tags: readonly string[],
  label: string,
): { readonly section: Section; readonly index: number; readonly count: number } | undefined {
  const ref = object(value, `${label} reference`)
  const count = integer(ref['entries'], `${label} entries`)
  if (count === 0) return undefined
  const index = integer(ref['index'], `${label} index`)
  const section = required(sections[index], `${label} section`)
  if (!tags.includes(section.desc.history.name) || section.content.length !== count)
    throw new TypeError(`M3 physics ${label} reference has an invalid tag or entry count`)
  return { section, index, count }
}

/** Augment the frozen descriptor with exact geometry; do not replace its legacy summary values.
 * v2's 24-byte tail remains as declared native fields/raw source. It is not reinterpreted using
 * the inconsistent 32-byte common tail in the independent Whiteout visitor.
 */
export function projectM3PhysicsBodies(
  sections: M3PhysicsSections,
  bodies: readonly M3RigidBody[],
  budget: M3PhysicsBudget,
  signal?: AbortSignal,
): readonly M3RigidBody[] {
  const bodySource = reference(
    sections,
    sections.model['physics_rigidbodies'],
    ['PHRB'],
    'rigid bodies',
  )
  if (bodySource === undefined) {
    if (bodies.length !== 0) throw new TypeError('M3 physics body projection has no native source')
    return bodies
  }
  if (bodySource.count !== bodies.length)
    throw new TypeError('M3 physics body projection is incomplete')
  let working = 0
  return bodies.map(body => {
    signal?.throwIfAborted()
    const rawBody = object(bodySource.section.content[body.index], 'body')
    const shapes = reference(sections, rawBody['physics_shape'], ['PHSH'], 'shapes')
    if (shapes === undefined && body.shapes.length === 0) return body
    if (shapes === undefined || shapes.count !== body.shapes.length)
      throw new TypeError('M3 physics shape projection is incomplete')
    // Preserve geometry for inspection even when the frozen collidable flag gate later
    // excludes this body from active UVM collisions.
    return {
      ...body,
      shapes: body.shapes.map(shape => {
        signal?.throwIfAborted()
        const raw = object(shapes.section.content[shape.index], 'shape')
        const version = shapes.section.desc.version
        if ((shape.shapeCode === 2 || shape.shapeCode === 3) &&
            shape.size[0] >= 0 && shape.size[1] >= 0 &&
            (shape.size[0] === 0 || shape.size[1] === 0)) {
          if (version !== 3 || shapes.section.rawBytes === null)
            throw new TypeError('M3 degenerate shape requires an audited PHSH v3 record')
          assertM3AnalyticShapeRecord(raw, shape)
          const bytes = new Uint8Array(shapes.section.rawBytes, shape.index * 300, 300)
          return { ...shape, nativeRecord: { version: 3 as const, bytes: Array.from(bytes) } }
        }
        if (shape.shapeCode !== 4 && shape.shapeCode !== 5) return shape
        if (![1, 2, 3].includes(version))
          throw new TypeError('M3 physics shape version is unsupported')
        const mesh = shape.shapeCode === 5
        const vertexKey =
          version === 1 || !mesh ? 'vertices' : version === 2 ? 'unknownd93ef965' : 'mesh_vertices'
        const vertices = reference(
          sections,
          raw[vertexKey],
          [version === 1 || !mesh || version === 2 ? 'VEC3' : 'VEC4'],
          'vertices',
        )
        if (vertices === undefined)
          throw new TypeError('M3 physics geometry has no native vertices')
        working += vertices.count * 12
        if (
          !Number.isSafeInteger(working) ||
          working > budget.maxScalarBytes ||
          vertices.count > budget.maxNodes
        )
          throw new RangeError('M3 physics geometry exceeds its resource budget')
        const positions: [number, number, number][] = vertices.section.content.map(value => {
          signal?.throwIfAborted()
          const vertex = object(value, 'vertex')
          const xyz = [vertex['x'], vertex['y'], vertex['z']]
          if (
            !xyz.every(
              component =>
                typeof component === 'number' &&
                Number.isFinite(component) &&
                Math.fround(component) === component,
            )
          )
            throw new TypeError('M3 physics vertices must be finite native float32 values')
          if (vertices.section.desc.history.name === 'VEC4' && vertex['w'] !== 0)
            throw new TypeError('M3 physics VEC4 vertex requires the audited zero w component')
          return [xyz[0] as number, xyz[1] as number, xyz[2] as number]
        })
        const source: JsonObject = {
          version,
          shapeSection: shapes.index,
          shapeIndex: shape.index,
          vertexSection: vertices.index,
          vertexField: vertexKey,
        }
        let geometry: M3RigidShapeGeometry
        if (!mesh) geometry = { kind: 'convex-hull', positions, source }
        else {
          const first = reference(
            sections,
            raw[
              version === 1 ? 'face_data' : version === 2 ? 'unknown09823b6e' : 'mesh_triangles16'
            ],
            [version === 1 ? 'U16_' : version === 2 ? 'DMMT' : 'MT16'],
            'triangles',
          )
          const second =
            version === 3
              ? reference(sections, raw['mesh_triangles32'], ['MT32'], 'triangles32')
              : undefined
          if ((first === undefined) === (second === undefined))
            throw new TypeError(
              'M3 physics mesh requires exactly one nonempty native triangle stream',
            )
          const triangles = required(first ?? second, 'triangles')
          const count = triangles.count * (version === 1 ? 1 : 3)
          working += count * 4
          if (
            !Number.isSafeInteger(working) ||
            working > budget.maxScalarBytes ||
            count > budget.maxNodes * 3
          )
            throw new RangeError('M3 physics triangle stream exceeds its resource budget')
          if (count === 0 || count % 3 !== 0)
            throw new TypeError('M3 physics triangle stream is incomplete')
          const indices: number[] = []
          for (const item of triangles.section.content) {
            signal?.throwIfAborted()
            const values =
              version === 1
                ? [item]
                : (() => {
                    const record = object(item, 'triangle')
                    return (
                      version === 2
                        ? ['vertex_index_0', 'vertex_index_1', 'vertex_index_2']
                        : ['unknown4c11db70', 'unknown2e003dc5', 'unknownfa325055']
                    ).map(key => record[key])
                  })()
            for (const value of values) {
              const index = integer(value, 'triangle vertex')
              if (index >= vertices.count)
                throw new RangeError('M3 physics triangle index exceeds native vertices')
              indices.push(index)
            }
          }
          geometry = {
            kind: 'mesh',
            positions,
            indices,
            source: {
              ...source,
              triangleSection: triangles.index,
              triangleTag: triangles.section.desc.history.name,
            },
          }
        }
        return { ...shape, geometry }
      }),
    }
  })
}
