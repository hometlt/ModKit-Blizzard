import { readFile } from 'node:fs/promises'

/** Reproduces the old authored candidate through the ambiguous PHSH v3 field schema.
 * Its 300-byte section size matches the declaration but does not prove native field conformance.
 */
export async function createLegacyRigidBodyNativeFixture(): Promise<Uint8Array> {
  const source = {
    format: 'm3',
    meshes: [],
    materials: [],
    animations: [],
    bounds: null,
    effects: { particles: [], ribbons: [] },
    skeleton: {
      bones: [
        {
          index: 0,
          name: 'PhysicsRoot',
          parentIndex: -1,
          inverseBindMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -3, -4, -5, 1]),
        },
      ],
    },
    collisionShapes: [
      {
        kind: 'box',
        boneIndex: 0,
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1],
        size: [2, 3, 4],
      },
    ],
    metadata: { coordinateSystem: 'Y_UP' },
  }
  const { encodeM3SemanticModel } = (await import(
    new URL('../../src/m3/writer.js', import.meta.url).href
  )) as {
    encodeM3SemanticModel(
      model: typeof source,
      options: { fileName: string; includeTextures: false },
      budget: {
        maxInputBytes: bigint
        maxDepth: number
        maxNodes: number
        maxScalarBytes: number
        maxDiagnostics: number
      },
    ): Promise<{ bytes: Uint8Array }>
  }
  const output = await encodeM3SemanticModel(
    source,
    { fileName: 'AuthoredPhysics.m3a', includeTextures: false },
    {
      maxInputBytes: 16_777_216n,
      maxDepth: 128,
      maxNodes: 100_000,
      maxScalarBytes: 16_777_216,
      maxDiagnostics: 100,
    },
  )
  return Uint8Array.from(output.bytes)
}

interface Description {
  readonly size: number
  instance(): Record<string, unknown>
}
interface History {
  getVersion(version: number, mdVersion: number, histories: Record<string, History>): Description
}
interface Section {
  desc: Description
  readonly indexEntry: { version: number }
  readonly content: readonly unknown[]
  rawBytes: ArrayBuffer | null
}
interface Sections {
  readonly mdVersion: number
  readonly structureHistories: Record<string, History>
  readonly model: Record<string, unknown>
  getSectionByReference(reference: unknown): Section | null
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('authored PHSH fixture record is absent')
  return value as Record<string, unknown>
}

/** Authored nonempty PHSH v1 (132 bytes), preserving the same bone, local matrix and raw sizes.
 * Replace the old section in place; no orphan PHSH v3 section remains in the graph.
 * This uses existing structural writer APIs, not a new parser or a claim about retail physics.
 */
export async function createRigidBodyNativeFixture(): Promise<Uint8Array> {
  const bytes = await createLegacyRigidBodyNativeFixture()
  const { M3SectionList } = (await import(
    new URL('../../dist/m3/native/binary/sections.js', import.meta.url).href
  )) as {
    M3SectionList: { load(bytes: ArrayBuffer, xml: string): Promise<Sections> }
  }
  const { replaceM3ReferencedRecords, serializeM3SectionGraph } = (await import(
    new URL('../../dist/m3/native/structural.js', import.meta.url).href
  )) as {
    replaceM3ReferencedRecords(
      sections: Sections,
      reference: unknown,
      records: readonly Record<string, unknown>[],
    ): void
    serializeM3SectionGraph(sections: Sections): Uint8Array
  }
  const buffer = new ArrayBuffer(bytes.length)
  new Uint8Array(buffer).set(bytes)
  const xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(buffer, xml)
  const bodies = sections.getSectionByReference(sections.model['physics_rigidbodies'])
  if (bodies?.content.length !== 1) throw new TypeError('authored physics body count changed')
  const body = record(bodies.content[0])
  const shapes = sections.getSectionByReference(body['physics_shape'])
  if (shapes?.content.length !== 1) throw new TypeError('authored physics shape count changed')
  const history = sections.structureHistories['PHSH']
  if (history === undefined) throw new TypeError('authored PHSH schema is absent')
  const description = history.getVersion(1, sections.mdVersion, sections.structureHistories)
  if (description.size !== 132) throw new TypeError('PHSH v1 schema must occupy exactly 132 bytes')
  const shape = description.instance()
  shape['matrix'] = record(shapes.content[0])['matrix']
  shape['shape'] = 0
  shape['size0'] = 2
  shape['size1'] = 3
  shape['size2'] = 4
  shapes.desc = description
  shapes.indexEntry.version = 1
  shapes.rawBytes = null
  replaceM3ReferencedRecords(sections, body['physics_shape'], [shape])
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
