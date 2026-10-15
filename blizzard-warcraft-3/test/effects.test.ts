import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const extension = join(import.meta.dirname, '..')
const codec = (await import(
  pathToFileURL(join(extension, 'src', 'war3-mdx', 'codec.js')).href
)) as { createCodec: (context: unknown) => unknown }

const budget = {
  maxInputBytes: 10n ** 9n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 64 * 1024 * 1024,
  maxDiagnostics: 200,
}

const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('no service is needed')
    },
    async resolveUnknown() {
      throw new Error('no service is needed')
    },
  },
}

function input(bytes: Uint8Array) {
  const uri = 'memory://model.mdx'
  const revision = 'content-hash.sha256:model'
  const value = {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single',
    bindings: [
      {
        sourceKind: 'candidate',
        bindingId: 'content',
        role: 'content',
        ownership: 'owned',
        source: value.ref,
        revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single',
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: uri,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value, async release() {} }
    },
  }
}

/**
 * A stock Warcraft III particle emitter from the repository-local ReterasModelStudio reference.
 * Warcraft III is not installed here, and a synthetic emitter would only prove the projection
 * against itself.
 */
const modelPath = join(
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

interface Session {
  dataSource: (
    contract: string,
    major: number,
  ) => Promise<{ value: never; release: () => Promise<void> }>
  dispose: () => Promise<void>
}

async function openModel(): Promise<Session> {
  const bytes = new Uint8Array(readFileSync(modelPath))
  expect(new TextDecoder('latin1').decode(bytes.subarray(0, 4))).toBe('MDLX')
  return (
    codec.createCodec(context) as {
      open: (input: unknown, mode: string, budget: unknown) => Promise<Session>
    }
  ).open(input(bytes), 'inspect', budget)
}

describe('Warcraft III effect facet', () => {
  it('publishes the emitters the model declares, in its own vocabulary', async () => {
    const session = await openModel()
    const lease = await session.dataSource('common.view/model-effect-source', 1)
    const source = lease.value as never as {
      info: () => Promise<{ effects: number; byKind: Record<string, number>; profile?: string }>
      effects: (page: { limit: number }) => Promise<{
        items: readonly {
          id: string
          kind: string
          name?: string
          nodeId?: string
          resourceId?: string
          properties?: readonly { key: string; value: unknown; animated?: boolean }[]
        }[]
      }>
    }
    const info = await source.info()
    expect(info.effects).toBeGreaterThan(0)
    expect(info.profile).toBe('mdx')
    expect(Object.keys(info.byKind)).toContain('particle')

    const items = (await source.effects({ limit: 32 })).items
    const emitter = items[0]!
    // The id follows the kind, so the two cannot drift apart.
    expect(emitter.id.startsWith(emitter.kind)).toBe(true)
    expect(emitter.name).toBeTypeOf('string')
    // It rides on a node of the model's own hierarchy, addressable in the scene facet.
    expect(emitter.nodeId).toMatch(/^war3-node-\d+$/u)
    // Parameters are the format's own; a shared vocabulary would drop whatever did not fit.
    expect((emitter.properties ?? []).length).toBeGreaterThan(5)
    const keys = (emitter.properties ?? []).map(property => property.key)
    expect(new Set(keys).size).toBe(keys.length)
    await lease.release()
    await session.dispose()
  })

  it('never carries an object where a setting is expected', async () => {
    const session = await openModel()
    const lease = await session.dataSource('common.view/model-effect-source', 1)
    const source = lease.value as never as {
      effects: (page: { limit: number }) => Promise<{
        items: readonly {
          properties?: readonly { key: string; value: unknown; animated?: boolean }[]
        }[]
      }>
    }
    for (const effect of (await source.effects({ limit: 32 })).items)
      for (const property of effect.properties ?? []) {
        expect(['string', 'number', 'boolean']).toContain(typeof property.value)
        // An animated parameter says so rather than printing a track object.
        if (property.animated === true) expect(property.value).toBe('track')
      }
    await lease.release()
    await session.dispose()
  })

  it('places an emitter on its own node, not on the bone above it', async () => {
    // The game spawns particles at the emitter's own pivot, moved by its own tracks (mdx-m3-viewer
    // `particle2.ts`); hanging the emitter on its parent bone lost both. The stock emitter gets a bone above it.
    const { parseWar3Mdx, generateWar3Mdx, parseWar3ModelToRenderModel } = (await import(
      pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
    )) as {
      parseWar3Mdx(bytes: Uint8Array): Record<string, unknown[]>
      generateWar3Mdx(model: unknown): Uint8Array
      parseWar3ModelToRenderModel(bytes: Uint8Array, hint: string): {
        effects?: { particles?: readonly { name?: string; boneIndex: number }[] }
      }
    }
    const model = parseWar3Mdx(new Uint8Array(readFileSync(modelPath)))
    const emitters = model['ParticleEmitters2'] as { ObjectId: number; Parent: number | null }[]
    const ids = (model['Nodes'] as { ObjectId: number }[]).map(node => node.ObjectId)
    // Two bones, so neither the bone's ObjectId nor its place in the bone list is the emitter's id.
    const boneId = Math.max(...ids) + 2
    for (const [Name, ObjectId] of [['Bone_Other', boneId - 1], ['Bone_Above', boneId]] as const) {
      const bone = {
        Name,
        ObjectId,
        Parent: null,
        PivotPoint: Float32Array.from([0, 0, 0]),
        Flags: 0x100,
        GeosetId: -1,
        GeosetAnimId: -1,
      }
      model['Bones']!.push(bone)
      model['Nodes']!.push(bone)
      model['PivotPoints']!.push(Float32Array.from([0, 0, 0]))
    }
    emitters[0]!.Parent = boneId
    const rendered = parseWar3ModelToRenderModel(generateWar3Mdx(model), 'parented.mdx')
    expect(rendered.effects?.particles?.[0]?.boneIndex).toBe(emitters[0]!.ObjectId)
  })
})
