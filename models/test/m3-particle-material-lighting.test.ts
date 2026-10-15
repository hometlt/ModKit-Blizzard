import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { JsonObject, ModelMaterialRef } from '@modkit/sdk'
import { deriveM3ParticleMaterials } from '../src/m3/particle-material-lighting.js'
import { replicateM3ParticleMaterial } from '../src/m3/uvm/material-binding.js'
import { materializeUvmAnimationMaterialTargets } from '@modkit/uv/model/animation-clips'
import { createM3aEffectBindingFixture } from './fixtures/m3a-effect-binding.js'
import { bindM3EffectSidecars } from '../src/m3/uvm/effect-sidecar-binding.js'
import { decodeM3EffectSidecarBinding } from '../src/m3/uvm/effect-sidecar-source.js'
import { bindM3SequenceIndices } from '../src/m3/uvm/animation-binding.js'
import { projectM3Effects } from '../src/m3/uvm/effects.js'
import { DEFAULT_UVM_CONTAINER_BUDGET, readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { materializeUvmCore } from '@modkit/uv/model/materializer'
import { materialBatchFixture } from './fixtures/material-batches.js'

const budget = { maxNodes: 100_000, maxDepth: 128, maxScalarBytes: 32_000_000, maxInputBytes: 16_000_000 }
const adapter = { program: (material: Record<string, unknown>) => material,
  replace: (_material: Record<string, unknown>, program: unknown) => program as Record<string, unknown> }

describe('M3 particle-only material lighting', () => {
  it.each([false, true].flatMap(base => [false, true].map(lit => ({ base, lit }))))(
    'base=$base LitParts=$lit', ({ base, lit }) => {
      const original = { standard: { unshaded: base, alphaTestThreshold: 0.25 }, inert: { keep: 1 } }
      const before = structuredClone(original)
      const result = deriveM3ParticleMaterials([original], [0], [lit], adapter, budget)
      expect(result.materials[result.particleMaterialIndices[0]!]!['standard']).toEqual({
        unshaded: base || !lit, alphaTestThreshold: 0.25,
      })
      expect(original).toEqual(before)
      expect(result.materials[0]).toBe(original)
      expect(result.materials).toHaveLength(!base && !lit ? 2 : 1)
      expect(result.particleMaterialIndices[0]).toBe(!base && !lit ? 1 : 0)
    },
  )

  it('deduplicates mixed emitters without changing the shared mesh material or composite payload', () => {
    const base = { composite: { priority: 7, passes: [false, true].map(unshaded => ({
      alphaFactor: { value: 0.6 }, material: { unshaded, layers: { diffuse: { texturePath: 'same.dds' } }, depthPrepass: true },
    })) }, inert: ['retain'] }
    const result = deriveM3ParticleMaterials([base], [0, 0, 0], [false, true, false], adapter, budget)
    expect(result.particleMaterialIndices).toEqual([1, 0, 1])
    expect(result.derivations).toEqual([{ sourceIndex: 0, targetIndex: 1 }])
    expect(result.materials[0]).toBe(base)
    expect(result.materials[1]).toEqual({ ...base, composite: { ...base.composite,
      passes: base.composite.passes.map(pass => ({ ...pass, material: { ...pass.material, unshaded: true } })),
    } })
  })

  it('retains existing animated targets in base and derived identities without new source tracks', () => {
    const value = { value: 0.5, sequenceTracks: [{ sequenceIndex: 0, track: {
      lineType: 1, globalSeqId: null, keys: [{ frame: 0, vector: [0.5] }, { frame: 1, vector: [1] }],
    } }] }
    const base: ModelMaterialRef = { id: 'material-0', layers: [], shader: {
      id: 'modkit.render-material.v1', parameters: { renderModel: { version: 1, layers: [], standard: {
        unshaded: false, layers: { diffuse: { colorMultiply: value } },
      } } },
    } }
    const result = deriveM3ParticleMaterials([base], [0, 0], [true, false], {
      program: material => material.shader!.parameters['renderModel'], replace: replicateM3ParticleMaterial,
    }, budget)
    expect(result.materials[1]!.shader!.parameters['renderModel']).toEqual({
      ...base.shader!.parameters['renderModel'] as object,
      standard: { unshaded: true, layers: { diffuse: { colorMultiply: value } } },
    })
    const targets = materializeUvmAnimationMaterialTargets(result.materials,
      { maxNodes: budget.maxNodes, maxDepth: budget.maxDepth, maxBytes: budget.maxScalarBytes })
    expect(targets).toHaveLength(2)
    expect(targets[0]!.properties).toEqual(targets[1]!.properties)
    expect(result.derivations).toHaveLength(1) // replication, not another authored source track
    const materialized = materializeUvmCore({
      info: { scenes: 1, nodes: 0, meshes: 0, primitives: 0, materials: 2, textures: 0,
        animations: 1, geometryAccess: 'metadata-only' },
      materials: result.materials,
      animations: [{ id: 'clip-0', name: 'animated layer', provenance: 'direct', kind: 'animation',
        frames: 2, durationSeconds: 1, sequenceIndex: 0, channels: [] }],
    }, { scope: { scopeId: 'model-interchange-v1', version: '1.0.0' }, profile: 'UVM/core@1.0',
      subjectRevision: 'content-hash.sha256:particle-lighting' as never,
      options: { assetId: 'particle-lighting', sourceFormat: 'm3' },
    })
    const reopened = readUvmContainer(writeUvmContainer(readUvmContainer(materialized.bytes))).document
    expect(reopened.materials).toHaveLength(2)
    const extensions = reopened['extensions'] as JsonObject
    expect((extensions['UV_game_animation_clips'] as JsonObject)['materialTargets']).toHaveLength(2)
  })

  it('refuses incomplete DTOs, invalid indices, output budgets and cancellation', () => {
    const source = [{ standard: { unshaded: false } }]
    expect(() => deriveM3ParticleMaterials(source, [0], [], adapter, budget)).toThrow(/ordinals/)
    expect(() => deriveM3ParticleMaterials(source, [1], [false], adapter, budget)).toThrow(/index/)
    expect(() => deriveM3ParticleMaterials(source, [0], [false], adapter, { ...budget, maxScalarBytes: 10 })).toThrow()
    expect(() => deriveM3ParticleMaterials(source, [0], [false], adapter, budget, AbortSignal.abort())).toThrow()
  })

  it('carries PARC lighting through M3A combination without leaking the internal DTO to UV effects', async () => {
    const runtime = await import('../src/m3/runtime/effects.js')
    const baseBytes = await createM3aEffectBindingFixture()
    const sideBytes = await createM3aEffectBindingFixture({ sidecar: true })
    const base = await runtime.decodeM3Effects(baseBytes, budget)
    expect(base.particleLighting).toHaveLength(2)
    expect(base.particleLighting[1]).toBe(base.particleLighting[0])
    const side = await decodeM3EffectSidecarBinding(baseBytes, sideBytes, 'side', budget)
    const sequences = bindM3SequenceIndices({ clips: [{ id: 'base' }], nativeSequenceIndices: [0] },
      [{ logicalId: 'side', clips: [{ id: 'side0' }, { id: 'side1' }], nativeSequenceIndices: [0, 1] }], budget)
    const combined = bindM3EffectSidecars(base, [side], sequences, budget)
    expect(combined.particleLighting).toEqual(base.particleLighting)
    const projected = projectM3Effects(combined, new Set(['bone/0']), new Set(['material-0']), sequences,
      { ...DEFAULT_UVM_CONTAINER_BUDGET, ...budget })!
    expect(projected.particleLighting).toEqual(base.particleLighting)
    expect(projected.effects).not.toHaveProperty('particleLighting')
    expect(() => projectM3Effects({ ...combined, particleLighting: [] }, new Set(['bone/0']),
      new Set(['material-0']), sequences, { ...DEFAULT_UVM_CONTAINER_BUDGET, ...budget })).toThrow(/ordinals/)
  })

  it.each([false, true])('native preview uses the same policy (LitParts=%s)', async litParts => {
    const { createM3EffectShadingFixture } = await import('./fixtures/m3-effect-shading.fixture.mjs')
    const bytes = await createM3EffectShadingFixture({ litParts, mixed: true })
    const { M3SectionList } = await import('../dist/m3/native/binary/sections.js')
    const { M3Model } = await import('../dist/m3/native/model.js')
    const sections = await M3SectionList.load(bytes.slice().buffer,
      await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8'))
    const model = new M3Model(sections)
    const result = model.toRenderModel()
    const first = result.effects!.particles[0]!, second = result.effects!.particles[1]!
    expect(result.materials[first.materialIndex]!.standard!.unshaded).toBe(!litParts)
    expect(result.materials[second.materialIndex]!.standard!.unshaded).toBe(litParts)
    expect(first.materialIndex).not.toBe(second.materialIndex)
    expect(result.effects).not.toHaveProperty('particleLighting')
  })

  it('keeps native mesh MATM identity when mixed emitters share its material', async () => {
    const { M3SectionList } = await import('../dist/m3/native/binary/sections.js')
    const { M3Model } = await import('../dist/m3/native/model.js')
    const bytes = await materialBatchFixture({ materialIndices: [0],
      inputBytes: new Uint8Array(await readFile(new URL('./fixtures/m3/corpus/Harbinger.m3', import.meta.url))),
    })
    const sections = await M3SectionList.load(bytes.slice().buffer,
      await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8'))
    const particles = sections.getSectionByReference(sections.model!.particle_systems as never)!.content
    for (const [index, particle] of particles.entries()) {
      particle['material_reference_index'] = 0
      particle['flags'] = index === 1 ? 0x8000 : 0
    }
    const materials = sections.getSectionByReference(sections.model!.materials_standard as never)!.content
    for (const material of materials) material['flags'] = Number(material['flags']) & ~0x10
    const result = new M3Model(sections).toRenderModel()
    expect(result.meshes.some(mesh => mesh.materialIndex === 0)).toBe(true)
    expect(result.materials[0]!.standard!.unshaded).toBe(false)
    expect(result.effects!.particles[0]!.materialIndex).not.toBe(0)
    expect(result.effects!.particles[1]!.materialIndex).toBe(0)
  })
})
