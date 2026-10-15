import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonObject } from '@modkit/sdk'
import type { M3RigidBody } from '../../dist/m3/uvm/rigid-bodies.js'

export const budget = {
  maxInputBytes: 33_554_432,
  maxJsonBytes: 16_777_216,
  maxScalarBytes: 33_554_432,
  maxDepth: 128,
  maxNodes: 500_000,
}
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('physics proof object absent')
  return value as JsonObject
}
export function list(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError('physics proof array absent')
  return value.map(object)
}
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError('physics proof value absent')
  return value
}
export async function native(bytes: Uint8Array, limits = budget, signal?: AbortSignal) {
  const { decodeM3UvmSource } = (await import(
    new URL('../../src/m3/geometry.node.js', import.meta.url).href
  )) as {
    decodeM3UvmSource(
      bytes: Uint8Array,
      budget: typeof limits,
      signal?: AbortSignal,
    ): Promise<{ metadata: JsonObject; rigidBodies: readonly M3RigidBody[] }>
  }
  return decodeM3UvmSource(bytes, limits, signal)
}
export function shapes(document: JsonObject) {
  return list(document['nodes']).flatMap((node, index) => {
    const extensions = node['extensions'] === undefined ? {} : object(node['extensions'])
    const collision = extensions['UV_game_collision']
    return collision === undefined
      ? []
      : list(object(collision)['shapes']).map(shape => ({
          node: index,
          role: object(collision)['role'],
          id:
            object(collision)['extras'] === undefined
              ? undefined
              : object(object(object(collision)['extras'])['modkit'])['id'],
          shape,
        }))
  })
}
export async function evidence(
  name: string,
  source: Uint8Array,
  uvm: Uint8Array | undefined,
  details: JsonObject,
) {
  const directory = process.env['MODKIT_PHYSICS_BINDING_EVIDENCE_DIR']
  if (directory === undefined) return
  await mkdir(directory, { recursive: true })
  const stem = join(directory, `m3-uvm-physics-binding-${name}`)
  await writeFile(`${stem}.m3`, source, { flag: 'wx' })
  if (uvm !== undefined) await writeFile(`${stem}.uvm.glb`, uvm, { flag: 'wx' })
  await writeFile(
    `${stem}.json`,
    JSON.stringify(
      {
        ...details,
        sourceSha256: sha256(source),
        sourceBytes: source.length,
        ...(uvm === undefined ? {} : { uvmSha256: sha256(uvm) }),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  )
}
