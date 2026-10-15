/**
 * Sockets and volumes a common scene carries, as a fresh M3 writes them. Warcraft III puts its
 * attachments and collision shapes on joints themselves, names socket roles (origin, overhead, …)
 * with numbers per role, and marks collision shapes as hit volumes; SC2's own round trip keeps
 * attach sockets on helper nodes in their numbered order.
 */
import { describe, expect, it } from 'vitest'
import { projectM3AttachmentsFromUvm } from '../src/m3/runtime/fresh-export.js'

const budget = { maxScalarBytes: 1_048_576 }

function project(nodes: unknown[], bones: Record<number, number>, parents: Record<number, number>, notes: string[] = []) {
  return projectM3AttachmentsFromUvm({ document: { nodes }, binary: new Uint8Array() }, bones, parents, budget, undefined, [], notes)
}

describe('fresh M3 attachments', () => {
  it('binds sockets and hit volumes on joints to their own bones', () => {
    const notes: string[] = []
    const result = project(
      [
        { name: 'Bone_Root' },
        { name: 'Origin Ref', translation: [1, 2, 3], extensions: { UV_game_socket: { role: 'origin', index: 0, sourceName: 'Origin Ref' } } },
        { name: 'Weapon', extensions: { UV_game_socket: { role: 'attach', index: 0, sourceName: 'Weapon' } } },
        { name: 'Collision Box', extensions: { UV_game_collision: { role: 'hit', shapes: [{ kind: 'box', size: [2, 4, 6] }] } } },
        { name: 'Collision Sphere', extensions: { UV_game_collision: { role: 'hit', shapes: [{ kind: 'sphere', radius: 5 }] } } },
        { name: 'Collision Mesh', extensions: { UV_game_collision: { role: 'hit', shapes: [{ kind: 'mesh' }] } } },
        { name: 'Overhead Ref', extensions: { UV_game_socket: { role: 'overhead', index: 0, sourceName: 'Overhead Ref' } } },
      ],
      { 0: 0, 1: 1, 3: 2, 4: 3, 5: 4, 6: 5 },
      { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      notes,
    )
    // Numbered attach sockets first, then the other roles in scene order.
    expect(result.sockets).toEqual([
      { name: 'Weapon', boneIndex: 0 },
      { name: 'Origin Ref', boneIndex: 1 },
      { name: 'Overhead Ref', boneIndex: 5 },
    ])
    expect(result.hittests).toEqual([
      expect.objectContaining({ shape: 0, boneIndex: 2, size0: 1, size1: 2, size2: 3 }),
      expect.objectContaining({ shape: 1, boneIndex: 3, size0: 5, size1: 1, size2: 1 }),
    ])
    expect(notes).toEqual([expect.stringContaining('mesh')])
  })

  it('still refuses a helper socket that would need a transform of its own', () => {
    expect(() => project(
      [
        { name: 'Bone_Root' },
        { name: 'Weapon', translation: [1, 0, 0], extensions: { UV_game_socket: { role: 'attach', index: 0, sourceName: 'Weapon' } } },
      ],
      { 0: 0 },
      { 1: 0 },
    )).toThrow(/helper/)
  })
})
