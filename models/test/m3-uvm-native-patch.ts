import { expect } from 'vitest'
import type { JsonObject } from '@modkit/sdk'
import { openUvmDocument, type UvmJsonEdit } from '@modkit/scene/uvm'
import {
  readUvmContainer,
  writeUvmContainer,
  type UvmContainer,
  type UvmContainerBudget,
} from '@modkit/uv/model/container'
import { exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import type { M3AttachmentVolume } from '../dist/m3/uvm/volumes.js'

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('test object absent')
  return value as JsonObject
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError('test value absent')
  return value
}

/** Edit through the shared document, export, then reopen with the independent native parser. */
export async function verifyM3VolumeEdits(
  container: UvmContainer,
  source: Uint8Array,
  budget: UvmContainerBudget,
) {
  const { decodeM3UvmSource } = (await import(
    new URL('../src/m3/geometry.node.js', import.meta.url).href
  )) as {
    decodeM3UvmSource(
      bytes: Uint8Array,
      budget: { maxDepth: number; maxNodes: number; maxScalarBytes: number },
    ): Promise<{ metadata: JsonObject; attachmentVolumes: M3AttachmentVolume[] }>
  }
  const nativeBudget = {
    maxDepth: budget.maxDepth,
    maxNodes: budget.maxNodes,
    maxScalarBytes: budget.maxInputBytes,
  }
  const before = await decodeM3UvmSource(source, nativeBudget)
  const envelope = object(object(container.document['extras'])['BlizzardM3'])
  const bindings = object(envelope['mapping'])['attachmentVolumes'] as JsonObject[]
  const sections = before.metadata['sections'] as JsonObject[]
  const section = required(sections.find(item => item['tag'] === 'ATVL'))
  const start = Number(object(section['sourceRange'])['byteOffset'])
  const expected = Uint8Array.from(source)
  const expectedView = new DataView(expected.buffer)
  const ranges: { byteOffset: number; byteLength: number }[] = []
  const edits: UvmJsonEdit[] = []
  const expectedVolumes = before.attachmentVolumes.map(volume => {
    const path = `/nodes/${required(bindings[volume.index])['node']}/extensions/UV_game_collision/shapes/0`
    const recordStart = start + volume.index * 116
    const result = { ...volume, matrix4: [...volume.matrix4] }
    const put = (offset: number, value: number) => {
      expectedView.setFloat32(recordStart + offset, value, true)
      ranges.push({ byteOffset: recordStart + offset, byteLength: 4 })
    }
    // Different components test column-major local translation and nontrivial linear transform.
    result.matrix4[0] = 2
    result.matrix4[12] = 7 + volume.index
    result.matrix4[13] = -3
    result.matrix4[14] = 5
    for (const j of [0, 12, 13, 14]) put(16 + j * 4, required(result.matrix4[j]))
    edits.push({ op: 'replace', path: `${path}/matrix`, value: result.matrix4 })
    if (volume.shape === 0) {
      result.size0 = 3
      result.size1 = 4
      result.size2 = 5
      edits.push({ op: 'replace', path: `${path}/size`, value: [6, 8, 10] })
      put(104, 3)
      put(108, 4)
      put(112, 5)
    } else if (volume.shape >= 1 && volume.shape <= 3) {
      result.size0 = 3
      edits.push({ op: 'replace', path: `${path}/radius`, value: 3 })
      put(104, 3)
      if (volume.shape >= 2) {
        result.size1 = 4
        edits.push({ op: 'replace', path: `${path}/height`, value: 4 })
        put(108, 4)
      }
    }
    return result
  })
  const document = openUvmDocument(writeUvmContainer(container, budget), { budget })
  try {
    document.apply({ expectedRevision: 0, json: edits })
    const patched = await exportM3FromUvm(readUvmContainer(document.serialize(1), budget), budget)
    expect(patched).toEqual(expected) // Every untouched native byte, including padding/unknown data.
    expect((await decodeM3UvmSource(patched, nativeBudget)).attachmentVolumes).toEqual(
      expectedVolumes,
    )
    document.undo(1)
    expect(await exportM3FromUvm(document.snapshot(), budget)).toEqual(source)
    document.redo(2)
    expect(await exportM3FromUvm(document.snapshot(), budget)).toEqual(patched)

    // Valid mapped edits never conceal a second, unsupported change.
    const path = `/nodes/${required(bindings[0])['node']}/extensions/UV_game_collision`
    const badEdits: UvmJsonEdit[] = [
      { op: 'add', path: '/extras/unmapped', value: true },
      { op: 'replace', path: `${path}/role`, value: 'physics' },
      { op: 'add', path: `${path}/shapes/0/future`, value: 1 },
      { op: 'replace', path: `${path}/shapes/0/matrix/3`, value: 1 },
      { op: 'replace', path: `${path}/shapes/0/matrix/12`, value: 0.1 },
      { op: 'replace', path: `${path}/shapes/0/matrix/12`, value: { type: 'float', value: '-0' } },
      { op: 'replace', path: `${path}/shapes/0/kind`, value: 'plane' },
    ]
    if (before.attachmentVolumes[0]?.shape === 0)
      badEdits.push({ op: 'replace', path: `${path}/shapes/0/size/0`, value: Number.MIN_VALUE })
    for (const edit of badEdits) {
      const revision = document.status().revision
      document.apply({ expectedRevision: revision, json: [edit] })
      await expect(exportM3FromUvm(document.snapshot(), budget)).rejects.toThrow()
      document.undo(revision + 1)
    }
    expect(await exportM3FromUvm(document.snapshot(), budget)).toEqual(patched)
    return {
      patched,
      edited: document.snapshot(),
      ranges,
      volumes: expectedVolumes.length,
      kinds: expectedVolumes.map(item => item.shape),
    }
  } finally {
    document.dispose()
  }
}
