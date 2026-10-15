import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { exportWar3FromUvm } from '../dist/war3-mdx/native-encoder.js'
import { extension, open } from './war3-harness.js'

/**
 * An emitter track on a global sequence runs on its own clock in every sequence (glows, smoke,
 * sparks that never stop). It crosses UVM as a concurrent track of each sequence that wraps at the
 * global sequence's length, the clock the shared effect simulation already keeps, and is written
 * back as one track on a global sequence. It used to cross as its first key, which could leave an
 * emitter off or at the wrong rate for good.
 */
const { parseWar3Mdx, generateWar3Mdx } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
)) as {
  parseWar3Mdx(bytes: Uint8Array): Record<string, unknown> & {
    GlobalSequences: number[]
    Sequences: unknown[]
    ParticleEmitters2: Record<string, unknown>[]
  }
  generateWar3Mdx(model: unknown): Uint8Array
}
const containerBudget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }
const stock = join(
  extension,
  '..',
  '..',
  'references',
  'ReterasModelStudio',
  'matrixeater',
  'res',
  'stock',
  'particles',
  'FireSmallBurn.mdx',
)

type Track = { GlobalSeqId: number | null; Keys: { Frame: number; Vector: Float32Array }[] }

function globalModel(): Uint8Array {
  const model = parseWar3Mdx(new Uint8Array(readFileSync(stock)))
  expect(model.Sequences.length).toBeGreaterThan(0)
  model.GlobalSequences = [1500]
  model.ParticleEmitters2[0]!['EmissionRate'] = {
    LineType: 1,
    GlobalSeqId: 0,
    Keys: [
      { Frame: 0, Vector: Float32Array.from([10]) },
      { Frame: 750, Vector: Float32Array.from([30]) },
    ],
  }
  return generateWar3Mdx(model)
}

describe('Warcraft III emitters through UVM', () => {
  it('tracks on a global sequence cross UVM as a concurrent track of every sequence and come back as a global sequence', async () => {
    const session = await open(globalModel())
    let bytes: Uint8Array
    try {
      const result = await session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
      bytes = result.output.value as Uint8Array
    } finally {
      await session.dispose()
    }
    const container = readUvmContainer(bytes, containerBudget)
    const effects = (container.document['extensions'] as Record<string, unknown>)['UV_game_effects'] as {
      particles: { sequenceAnimation?: Record<string, Record<string, unknown>[]> }[]
    }
    const entries = effects.particles[0]?.sequenceAnimation?.['emissionRate'] ?? []
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry).toMatchObject({ concurrent: true, wrapSeconds: 1.5 })
      expect((entry['track'] as { keys: { frame: number }[] }).keys.map(key => key.frame)).toEqual([0, 750])
    }

    // Without our residual the writer builds the emitters from the common vocabulary alone.
    const document = { ...container.document }
    delete document['extras']
    const written = parseWar3Mdx(
      exportWar3FromUvm(writeUvmContainer({ ...container, document }, containerBudget), containerBudget),
    )
    expect(written.GlobalSequences).toEqual([1500])
    const rate = written.ParticleEmitters2[0]!['EmissionRate'] as Track
    expect(rate.GlobalSeqId).toBe(0)
    expect(rate.Keys.map(key => [key.Frame, key.Vector[0]])).toEqual([
      [0, 10],
      [750, 30],
    ])
  })

  it('publishes a version 1 emitter as a model particle, its spread in degrees', async () => {
    // Each particle of a version 1 emitter is a model, which the game loads as .mdx whatever the
    // path says (mdx-m3-viewer `particleemitterobject.ts`); it used to be published as a texture.
    const model = parseWar3Mdx(new Uint8Array(readFileSync(stock)))
    const nodes = model['Nodes'] as { ObjectId: number }[]
    const ObjectId = Math.max(...nodes.map(node => node.ObjectId)) + 1
    const emitter = {
      Name: 'Spawner',
      ObjectId,
      Parent: null,
      PivotPoint: Float32Array.from([0, 0, 0]),
      Flags: 0x8000,
      EmissionRate: 4,
      Gravity: 2,
      Longitude: 0,
      Latitude: Math.PI / 6,
      Path: 'Abilities\\Weapons\\Spark\\Spark.mdl',
      LifeSpan: 1,
      InitVelocity: 3,
      Visibility: 1,
    }
    ;(model['ParticleEmitters'] as unknown[]).push(emitter)
    nodes.push(emitter)
    ;(model['PivotPoints'] as Float32Array[]).push(Float32Array.from([0, 0, 0]))
    const session = await open(generateWar3Mdx(model))
    let bytes: Uint8Array
    try {
      const result = await session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
      bytes = result.output.value as Uint8Array
    } finally {
      await session.dispose()
    }
    const effects = (readUvmContainer(bytes, containerBudget).document['extensions'] as Record<string, unknown>)[
      'UV_game_effects'
    ] as { particles: { name: string; modelPaths?: string[]; latitude?: number; gravity?: number; texturePath?: string }[] }
    const spawner = effects.particles.find(particle => particle.name === 'Spawner')
    expect(spawner?.modelPaths).toEqual(['Abilities\\Weapons\\Spark\\Spark.mdx'])
    expect(spawner?.texturePath).toBeUndefined()
    expect(spawner?.latitude).toBeCloseTo(30, 4)
    expect(spawner?.gravity).toBe(2)
  })

  it('publishes a ribbon as the flat strip the game draws, not one turned to the camera', async () => {
    const model = parseWar3Mdx(new Uint8Array(readFileSync(stock)))
    const nodes = model['Nodes'] as { ObjectId: number }[]
    // A ribbon draws with a material of the model; this particle model has none of its own.
    const materials = model['Materials'] as unknown[]
    materials.push({
      PriorityPlane: 0,
      RenderMode: 0,
      Layers: [{ FilterMode: 2, Shading: 0, TextureID: 0, CoordId: 0, Alpha: 1 }],
    })
    const ribbon = {
      Name: 'Trail',
      ObjectId: Math.max(...nodes.map(node => node.ObjectId)) + 1,
      Parent: null,
      PivotPoint: Float32Array.from([0, 0, 0]),
      Flags: 0x4000,
      HeightAbove: 10,
      HeightBelow: 5,
      Alpha: 1,
      Color: Float32Array.from([1, 1, 1]),
      LifeSpan: 0.5,
      TextureSlot: 0,
      EmissionRate: 20,
      Rows: 1,
      Columns: 1,
      MaterialID: materials.length - 1,
      Gravity: 0,
    }
    ;(model['RibbonEmitters'] as unknown[]).push(ribbon)
    nodes.push(ribbon)
    ;(model['PivotPoints'] as Float32Array[]).push(Float32Array.from([0, 0, 0]))
    const session = await open(generateWar3Mdx(model))
    let bytes: Uint8Array
    try {
      const result = await session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
      bytes = result.output.value as Uint8Array
    } finally {
      await session.dispose()
    }
    const effects = (readUvmContainer(bytes, containerBudget).document['extensions'] as Record<string, unknown>)[
      'UV_game_effects'
    ] as { ribbons: { name: string; ribbonType?: string }[] }
    expect(effects.ribbons.find(item => item.name === 'Trail')?.ribbonType).toBe('planar')
  })
})
