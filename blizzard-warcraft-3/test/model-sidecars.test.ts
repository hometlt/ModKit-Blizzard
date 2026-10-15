/** MDX/MDL sidecar publication preserves native names without claiming a resolved dependency. */
import { describe, expect, it } from 'vitest'
import type { ModelResourceRefsSource, ModelSceneSource } from '@modkit/sdk'
import { revisionId } from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'
import { parseWar3Mdx, generateWar3Mdx, generateWar3Mdl, war3ModelToRenderModel } from '../dist/war3-mdx/render-model.js'
import { exportWar3Uvm } from '../dist/war3-mdx/uvm.js'
import { authoredModelBytes, inspect, open } from './war3-harness.js'

/** Native node records, including duplicates/empty sockets and a PRE1 .mdl preview alias. */
async function modelWithSidecars() {
  const model = parseWar3Mdx((await authoredModelBytes()).mdx)
  for (const [index, path] of ['Models\\Attached.mdl', 'Models\\Attached.mdl', ''].entries()) {
    const node = {
      Name: `Attachment${index}`, ObjectId: model.Nodes.length, Parent: 0, Flags: 0x800,
      PivotPoint: new Float32Array(3), Path: path, AttachmentID: index,
    }
    model.Attachments.push(node)
    model.Nodes.push(node)
    model.PivotPoints.push(node.PivotPoint)
  }
  for (const path of ['Models\\Particle.mdl', 'Models\\Attached.mdl', '']) {
    const node = {
      Name: `Particle${model.Nodes.length}`, ObjectId: model.Nodes.length, Parent: 0, Flags: 0x1000 | 0x8000,
      PivotPoint: new Float32Array(3), Path: path, EmissionRate: 1, Gravity: 0,
      Longitude: 0, Latitude: 0, LifeSpan: 1, InitVelocity: 0,
      Visibility: { LineType: 0, GlobalSeqId: null, Keys: [{ Frame: 0, Vector: Float32Array.of(1) }] },
    }
    model.ParticleEmitters.push(node)
    model.Nodes.push(node)
    model.PivotPoints.push(node.PivotPoint)
  }
  return model
}

describe('native model sidecar references', () => {
  it.each(['mdx', 'mdl'] as const)('publishes ATCH/PRE1 paths as unbound sidecars in %s', async format => {
    const native = await modelWithSidecars()
    const bytes = format === 'mdx' ? generateWar3Mdx(native) : new TextEncoder().encode(generateWar3Mdl(native))
    const session = await open(bytes)
    try {
      const lease = await session.dataSource('common.view/model-resource-refs-source', 1)
      try {
        const refs = lease.value as ModelResourceRefsSource
        expect(await refs.info()).toMatchObject({ references: 3, bound: 0, truncated: false })
        const page = await refs.references({ limit: 20 })
        expect(page.items).toEqual([
          { id: 'Textures\\Fixture.blp', role: 'texture', provenance: 'reference-only' },
          { id: 'Models\\Attached.mdl', role: 'sidecar', provenance: 'reference-only' },
          { id: 'Models\\Particle.mdl', role: 'sidecar', provenance: 'reference-only' },
        ])
      } finally { await lease.release() }
      expect(await inspect(session)).toMatchObject({ textures: 1, particleEmitters: 3 })
      const scene = await session.dataSource('common.view/model-scene-source', 1)
      try { expect(await (scene.value as ModelSceneSource).info()).toMatchObject({ textures: 1 }) }
      finally { await scene.release() }
      const budget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 128, maxNodes: 100_000 }
      const exported = exportWar3Uvm(war3ModelToRenderModel(native, format), native as unknown as Readonly<Record<string, unknown>>, format, {
        assetId: 'sidecar-test', subjectRevision: revisionId('content-hash.sha256:sidecar-test'), budget,
      })
      expect(exported.notes.some(note => note.includes('2 non-image resource closure'))).toBe(true)
      const { document } = readUvmContainer(exported.bytes, budget)
      // Sidecars remain native residual facts, never invalid glTF model-as-image entries.
      expect(JSON.stringify(document['images'])).not.toContain('.mdl')
    } finally { await session.dispose() }
  })
})
