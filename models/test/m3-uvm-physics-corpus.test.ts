import { expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { revisionId, type ArtifactByteSource, type JsonObject } from '@modkit/sdk'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import { createFilesystemInputResolver, loadExtensionDirectory } from '@modkit/host/node'
import { readUvmContainer } from '@modkit/uv/model/container'
import { readUvmAccessor } from '@modkit/uv/model/accessor'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { createUvmCollisionOverlay } from '@modkit/scene/uvm/collision-overlay'
import { openUvmDocument } from '@modkit/scene/uvm'
import { exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import { drainM3aSession } from './m3a-uvm-session.js'
import {
  budget,
  sha256,
  object,
  list,
  required,
  native,
  shapes,
  evidence,
} from './fixtures/physics-proof.js'

const conversionFrame = [2, 0, 0, 0, 0, 0, -2, 0, 0, 2, 0, 0, 0, 0, 0, 1]
function multiply(left: ArrayLike<number>, right: ArrayLike<number>): Float32Array {
  // Independent column-major scalar equation; no production transform/rebase helper.
  return Float32Array.from({ length: 16 }, (_, index) => {
    const row = index % 4,
      column = Math.floor(index / 4)
    let value = 0
    for (let k = 0; k < 4; k++)
      value += required(left[k * 4 + row]) * required(right[column * 4 + k])
    return value
  })
}
async function openCsv(bytes: Uint8Array, path: string) {
  const id = 'memory://physics-binding/csv.m3'
  const source: ArtifactByteSource = {
    kind: 'bytes',
    ref: { id, uri: id },
    revision: revisionId(`content-hash.sha256:${sha256(bytes)}`),
    size: BigInt(bytes.length),
    async read(offset, length, signal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream(range, signal) {
      signal?.throwIfAborted()
      const offset = Number(range?.offset ?? 0n),
        count = Number(range?.length ?? BigInt(bytes.length - offset))
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(count) ||
        offset < 0 ||
        count < 0 ||
        offset + count > bytes.length
      )
        throw new RangeError('CSV source stream range is invalid')
      yield bytes.slice(offset, offset + count)
    },
  }
  const inventory = await buildInventory(
    [
      {
        ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
        execution: { origin: 'bundled', allowTrustedInProcess: true },
      },
    ],
    createHostContributionContractRegistry(),
  )
  const executionBackends = createExecutionBackendRegistry([
    {
      profile: 'trusted-in-process',
      supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
      async activate(context) {
        return {
          module: (await import(context.entrypoint.href)) as Record<string, unknown>,
          release: async () => undefined,
        }
      },
    },
  ])
  return openSubject({
    source,
    path,
    inventory,
    executionBackends,
    intent: 'full',
    target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
    grant: { id: 'physics-binding-csv', classes: ['read-source'] },
    budget: { ...budget, maxInputBytes: BigInt(budget.maxInputBytes), maxDiagnostics: 100 },
    resolveInput: createFilesystemInputResolver({
      primaryPath: path,
      roots: [join(path, '..')],
      inventory,
    }),
  })
}
/*
 * The model is csv.m3 of the community AllRaces2 asset bundle, pinned by its hash and section
 * offsets; no StarCraft II installation ships it, so no discovery can find it. Point
 * MODKIT_PHYSICS_CSV_SOURCE at a copy to run this; without one it is skipped, never failed on a
 * path that exists on one machine only.
 */
const physicsSource = process.env['MODKIT_PHYSICS_CSV_SOURCE']
it.skipIf(physicsSource === undefined || !existsSync(physicsSource))(
  'matches all actual CSV meshes and hulls against independent native points, triangles and support planes (needs MODKIT_PHYSICS_CSV_SOURCE: csv.m3 of the AllRaces2 asset bundle)',
  async () => {
  const sourcePath = physicsSource as string
  const bytes = Uint8Array.from(await readFile(sourcePath))
  expect(sha256(bytes)).toBe('1c614dc82a7bf481088e513df89eb1a3834eb90bf76043c235bbd221ddf8fbd9')
  const raw = new DataView(bytes.buffer),
    indexOffset = raw.getUint32(4, true)
  const decoded = await native(bytes)
  const actual = decoded.rigidBodies
    .flatMap(body => body.shapes)
    .flatMap(shape => (shape.geometry === undefined ? [] : [shape.geometry]))
  const proofs: JsonObject[] = []
  const expectedGeometry: {
    section: number
    kind: 'mesh' | 'convex-hull'
    positions: number[]
    indices?: number[]
  }[] = []
  for (const [shapeSection, shapeOffset, vertexCount, triangleCount] of [
    [354, 256144, 215, 375],
    [358, 272704, 9, 14],
    [362, 273616, 10, 16],
    [411, 292656, 18, 32],
  ]) {
    const section = required(shapeSection),
      offset = required(shapeOffset),
      vertexTotal = required(vertexCount),
      triangleTotal = required(triangleCount)
    expect(raw.getUint32(indexOffset + section * 16, true)).toBe(0x50485348)
    expect(raw.getUint32(indexOffset + section * 16 + 12, true)).toBe(3)
    expect(raw.getUint32(offset + 196, true)).toBe(vertexTotal)
    expect(raw.getUint32(offset + 208, true)).toBe(0)
    expect(raw.getUint32(offset + 220, true)).toBe(triangleTotal)
    const vertexIndex = raw.getUint32(offset + 200, true),
      faceIndex = raw.getUint32(offset + 224, true)
    const vertexOffset = raw.getUint32(indexOffset + vertexIndex * 16 + 4, true),
      faceOffset = raw.getUint32(indexOffset + faceIndex * 16 + 4, true)
    expect(raw.getUint32(indexOffset + vertexIndex * 16, true)).toBe(0x56454334) // VEC4.
    expect(raw.getUint32(indexOffset + faceIndex * 16, true)).toBe(0x4d543332) // MT32.
    const expectedPoints = Array.from({ length: vertexTotal }, (_, i) => {
      expect(raw.getFloat32(vertexOffset + i * 16 + 12, true)).toBe(0)
      return [0, 4, 8].map(component => raw.getFloat32(vertexOffset + i * 16 + component, true))
    })
    const expectedIndices = Array.from({ length: triangleTotal }, (_, i) =>
      [0, 4, 8].map(component => raw.getUint32(faceOffset + i * 28 + component, true)),
    ).flat()
    const geometry = required(actual.find(item => item.source['shapeSection'] === section))
    if (geometry.kind !== 'mesh') throw new TypeError('CSV mesh projection absent')
    expect(geometry.positions).toEqual(expectedPoints)
    expect(geometry.indices).toEqual(expectedIndices)
    expectedGeometry.push({
      section,
      kind: 'mesh',
      positions: expectedPoints.flat(),
      indices: expectedIndices,
    })
    proofs.push({
      shapeSection: section,
      shapeOffset: offset,
      vertexIndex,
      vertexOffset,
      vertexCount: vertexTotal,
      faceIndex,
      faceOffset,
      triangleCount: triangleTotal,
    })
  }
  const hulls = [
    [366, 274592, 16, 28],
    [371, 275904, 52, 32],
    [376, 278032, 52, 32],
    [381, 280160, 52, 32],
    [386, 282288, 52, 32],
    [391, 284416, 42, 30],
    [396, 286304, 47, 31],
    [401, 288320, 55, 32],
    [406, 290528, 52, 32],
    [415, 294304, 16, 10],
    [420, 295168, 24, 14],
  ] as const
  for (const [section, offset, vertexTotal, planeTotal] of hulls) {
    expect(raw.getUint32(indexOffset + section * 16, true)).toBe(0x50485348)
    expect(raw.getUint32(indexOffset + section * 16 + 4, true)).toBe(offset)
    expect(raw.getUint32(indexOffset + section * 16 + 12, true)).toBe(3)
    expect(raw.getUint8(offset + 64)).toBe(4)
    expect(raw.getUint32(offset + 104, true)).toBe(vertexTotal)
    expect(raw.getUint32(offset + 116, true)).toBe(planeTotal)
    expect(raw.getUint32(offset + 164, true)).toBe(vertexTotal)
    expect(raw.getUint32(offset + 168, true)).toBe(planeTotal)
    const vertexIndex = raw.getUint32(offset + 108, true),
      planeIndex = raw.getUint32(offset + 120, true),
      vertexOffset = raw.getUint32(indexOffset + vertexIndex * 16 + 4, true),
      planeOffset = raw.getUint32(indexOffset + planeIndex * 16 + 4, true)
    expect(raw.getUint32(indexOffset + vertexIndex * 16, true)).toBe(0x56454333)
    expect(raw.getUint32(indexOffset + planeIndex * 16, true)).toBe(0x56454334)
    const expectedPoints = Array.from({ length: vertexTotal }, (_, index) =>
      [0, 4, 8].map(component => raw.getFloat32(vertexOffset + index * 12 + component, true)),
    )
    const planes = Array.from({ length: planeTotal }, (_, index) =>
      [0, 4, 8, 12].map(component => raw.getFloat32(planeOffset + index * 16 + component, true)),
    )
    let maximumOutside = -Infinity,
      maximumPlaneNearest = 0
    for (const plane of planes) {
      expect(required(plane[3])).not.toBe(0)
      expect(
        Math.abs(Math.hypot(required(plane[0]), required(plane[1]), required(plane[2])) - 1),
      ).toBeLessThan(1e-7)
      const residuals = expectedPoints.map(
        point =>
          required(plane[0]) * required(point[0]) +
          required(plane[1]) * required(point[1]) +
          required(plane[2]) * required(point[2]) -
          required(plane[3]),
      )
      maximumOutside = Math.max(maximumOutside, ...residuals)
      maximumPlaneNearest = Math.max(maximumPlaneNearest, Math.min(...residuals.map(Math.abs)))
      // Independent support-plane witness: every point lies inside and every plane touches.
      expect(Math.max(...residuals)).toBeLessThan(5e-8)
      expect(Math.min(...residuals.map(Math.abs))).toBeLessThan(5e-8)
    }
    const geometry = required(actual.find(item => item.source['shapeSection'] === section))
    expect(geometry.kind).toBe('convex-hull')
    expect(geometry.positions).toEqual(expectedPoints)
    expect(geometry.source['vertexField']).toBe('vertices')
    expect(geometry.source['vertexSection']).toBe(vertexIndex)
    expectedGeometry.push({ section, kind: 'convex-hull', positions: expectedPoints.flat() })
    proofs.push({
      shapeSection: section,
      shapeOffset: offset,
      vertexIndex,
      vertexOffset,
      vertexCount: vertexTotal,
      planeIndex,
      planeOffset,
      planeCount: planeTotal,
      maximumOutside,
      maximumPlaneNearest,
    })
  }
  expect(actual.filter(item => item.kind === 'mesh')).toHaveLength(4)
  expect(actual.filter(item => item.kind === 'convex-hull')).toHaveLength(11)
  expect(actual).toHaveLength(expectedGeometry.length)
  const opened = await openCsv(bytes, sourcePath)
  if (opened.state !== 'opened')
    throw new TypeError(`CSV ordinary open failed: ${JSON.stringify(opened)}`)
  try {
    const projection = await drainM3aSession(opened.session, {
      ...budget,
      maxInputBytes: BigInt(budget.maxInputBytes),
      maxDiagnostics: 100,
    })
    expect(required(projection.skeleton).length).toBeGreaterThan(28)
    const output = await opened.session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 2 })
    if (output.state !== 'ok' || output.output.kind !== 'bytes')
      throw new TypeError(`CSV UVM export failed: ${JSON.stringify(output)}`)
    const document = openUvmDocument(output.output.value, { budget })
    try {
      const container = readUvmContainer(document.serialize(0), budget)
      const envelope = object(object(container.document['extras'])['BlizzardM3'])
      expect(envelope['schemaVersion']).toBe(1)
      expect(envelope['source']).toBeUndefined()
      expect(envelope['metadata']).toBeUndefined()
      const scene = readUvmModel(container.document, container.binary, budget)
      const nativeSampler = createModelSceneSampler(
        { ...projection, primitives: required(projection.primitives) },
        { maxBytes: budget.maxScalarBytes },
      )
      const uvmSampler = createModelSceneSampler(
        { ...scene.scene, skeleton: scene.rig.bindings },
        { maxBytes: budget.maxScalarBytes },
      )
      const nativeFrame = nativeSampler.sample(0),
        uvmFrame = uvmSampler.sample(0)
      const overlay = createUvmCollisionOverlay(container.document, container.binary, budget)
      expect(overlay.diagnostics).toEqual([])
      const frames = overlay.sample(uvmFrame.nodeTransforms)
      const collisions = shapes(container.document)
      for (const expected of expectedGeometry) {
        const body = required(
          decoded.rigidBodies.find(body =>
            body.shapes.some(shape => shape.geometry?.source['shapeSection'] === expected.section),
          ),
        )
        const shape = required(
          body.shapes.find(shape => shape.geometry?.source['shapeSection'] === expected.section),
        )
        const collision = required(
          collisions.find(
            collision => collision.id === `m3-rigid-body-${body.index}-shape-${shape.index}`,
          ),
        )
        expect(collision.role).toBe('physics')
        expect(collision.shape['kind']).toBe(expected.kind)
        expect(
          Array.from(
            readUvmAccessor(
              container.document,
              container.binary,
              collision.shape['positions'],
              budget,
              'CSV positions',
            ).values,
          ),
        ).toEqual(expected.positions)
        if (expected.kind === 'mesh')
          expect(
            Array.from(
              readUvmAccessor(
                container.document,
                container.binary,
                collision.shape['indices'],
                budget,
                'CSV indices',
              ).values,
            ),
          ).toEqual(expected.indices)
        else expect(collision.shape['indices']).toBeUndefined()
        const frame = required(
          frames.find(frame => frame.id === `node-${collision.node}-collision-0`),
        )
        if (expected.kind === 'mesh') {
          expect(Array.from(frame.positions)).toEqual(expected.positions)
          expect(Array.from(required(frame.indices))).toEqual(expected.indices)
        } else {
          // ConvexGeometry is a display tessellation, not an authored native triangle stream.
          const nativePoints = new Set(
            Array.from({ length: expected.positions.length / 3 }, (_, index) =>
              expected.positions.slice(index * 3, index * 3 + 3).join(','),
            ),
          )
          expect(frame.positions.length).toBeGreaterThan(0)
          expect(frame.positions.length % 9).toBe(0)
          for (let index = 0; index < frame.positions.length; index += 3)
            expect(
              nativePoints.has(Array.from(frame.positions.slice(index, index + 3)).join(',')),
            ).toBe(true)
          expect(Array.from(required(frame.indices))).toEqual(
            Array.from({ length: frame.positions.length / 3 }, (_, index) => index),
          )
        }
        const worldBone = required(nativeFrame.nodeTransforms.get(`bone/${body.boneIndex}`))
        const expectedMatrix = multiply(multiply(conversionFrame, worldBone), shape.matrix4)
        for (const [index, value] of required(frame.transform).entries())
          expect(value === expectedMatrix[index]).toBe(true)
      }
      const canonical = await native(await exportM3FromUvm(container, budget))
      const canonicalGeometry = canonical.rigidBodies.flatMap(body =>
        body.shapes.flatMap(shape => (shape.geometry === undefined ? [] : [shape.geometry])),
      )
      expect(canonicalGeometry).toHaveLength(expectedGeometry.length)
      for (const expected of expectedGeometry) {
        expect(
          canonicalGeometry.some(geometry =>
            geometry.kind === expected.kind &&
            geometry.positions.flat().join(',') === expected.positions.join(',') &&
            (expected.kind !== 'mesh' ||
              (geometry.kind === 'mesh' && geometry.indices.join(',') === expected.indices?.join(','))),
          ),
        ).toBe(true)
      }
      expect(Uint8Array.from(await readFile(sourcePath))).toEqual(bytes)
      await evidence('csv-native', bytes, output.output.value, {
        corpus: 'AllRaces-local',
        route: 'ordinary-M3-session',
        proofs,
        skeletonBones: required(projection.skeleton).length,
        overlayShapes: frames.length,
        nativeMetadata: decoded.metadata,
      })
    } finally {
      document.dispose()
    }
  } finally {
    await opened.session.dispose()
  }
}, 180_000)
