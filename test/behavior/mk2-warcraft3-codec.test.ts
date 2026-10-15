import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  revisionId,
  type ArtifactByteSource,
  type AssetInput,
  type Codec,
  type ContributionContext,
  type ModelAnimationSource,
  type ModelResourceRefsSource,
  type ModelSceneSource,
  type ResourceBudget,
  type TreeDataSource,
} from '@modkit/sdk'

const extension = join(import.meta.dirname, '..', '..', 'blizzard-warcraft-3')
const fixturePath = join(import.meta.dirname, 'fixtures', 'minimal.mdx')
const budget: ResourceBudget = {
  maxInputBytes: 1_000_000n,
  maxDepth: 32,
  maxNodes: 1000,
  maxScalarBytes: 1_000_000,
  maxDiagnostics: 100,
}
const context: ContributionContext = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('Warcraft III codec has no service dependency')
    },
    async resolveUnknown() {
      throw new Error('Warcraft III codec has no foreign service dependency')
    },
  },
}

function source(bytes: Uint8Array): ArtifactByteSource {
  const uri = 'memory://blizzard-warcraft-3/model'
  return {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision: revisionId('content-hash.sha256:blizzard-warcraft3-model'),
    size: BigInt(bytes.byteLength),
    async read(offset, length) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
}

function input(value: ArtifactByteSource): AssetInput {
  const binding = {
    sourceKind: 'candidate' as const,
    bindingId: 'content',
    role: 'content',
    ownership: 'owned' as const,
    source: value.ref,
    revision: value.revision,
  }
  return {
    originKind: 'single',
    bindings: [binding],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single',
      revision: value.revision,
      bindings: [{ bindingId: 'content', revision: value.revision }],
      compositionFingerprint: value.ref.id,
    },
    bindingsFor: () => [],
    async openBinding() {
      return {
        value,
        async release() {
          return undefined
        },
      }
    },
  }
}

async function war3Codec(): Promise<Codec> {
  const module = (await import(
    pathToFileURL(join(extension, 'src', 'war3-mdx', 'codec.js')).href
  )) as {
    createCodec(context: ContributionContext): Codec
  }
  return module.createCodec(context)
}

async function open(bytes: Uint8Array, resourceBudget = budget) {
  return (await war3Codec()).open(input(source(bytes)), 'inspect', resourceBudget)
}

async function inspect(session: Awaited<ReturnType<typeof open>>) {
  const result = await session.operations().invoke('inspect', null)
  if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('inspect failed')
  return result.output.value
}

/**
 * A geometry-bearing MDX built in memory.
 *
 * Warcraft III is not installed here and its models are not vendored, so the only shipped fixture
 * is the two-chunk container above. This starts from that parsed model — which already carries
 * every array the writer expects — adds one textured, skinned, animated geoset, and writes it back
 * out through the vendored generator. The codec then reads real MDX bytes, not a stub.
 */
async function authoredModelBytes(): Promise<{ mdx: Uint8Array; mdl: Uint8Array }> {
  const { parseWar3Mdx, generateWar3Mdx, generateWar3Mdl } = (await import(
    pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
  )) as {
    parseWar3Mdx(bytes: Uint8Array): Record<string, never[]> & Record<string, unknown>
    generateWar3Mdx(model: unknown): Uint8Array
    generateWar3Mdl(model: unknown): string
  }
  const model = parseWar3Mdx(new Uint8Array(await readFile(fixturePath))) as unknown as {
    Textures: unknown[]
    Materials: unknown[]
    Sequences: unknown[]
    Geosets: unknown[]
    Bones: unknown[]
    Nodes: unknown[]
    PivotPoints: Float32Array[]
  }
  model.Textures.push({ Image: 'Textures\\Fixture.blp' })
  model.Materials.push({ Layers: [{ FilterMode: 0, TextureID: 0, CoordId: 0, Alpha: 1 }] })
  model.Sequences.push({
    Name: 'Stand',
    Interval: Uint32Array.from([0, 1000]),
    NonLooping: false,
    MinimumExtent: Float32Array.from([-1, -1, 0]),
    MaximumExtent: Float32Array.from([1, 1, 1]),
    BoundsRadius: 2,
    MoveSpeed: 0,
    Rarity: 0,
  })
  model.Geosets.push({
    Vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    Normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    TVertices: [Float32Array.from([0, 0, 1, 0, 0, 1])],
    VertexGroup: Uint8Array.from([0, 0, 0]),
    Faces: Uint16Array.from([0, 1, 2]),
    Groups: [[0]],
    TotalGroupsCount: 1,
    MinimumExtent: Float32Array.from([0, 0, 0]),
    MaximumExtent: Float32Array.from([1, 1, 0]),
    BoundsRadius: 1,
    Anims: [
      {
        MinimumExtent: Float32Array.from([0, 0, 0]),
        MaximumExtent: Float32Array.from([1, 1, 0]),
        BoundsRadius: 1,
      },
    ],
    MaterialID: 0,
    SelectionGroup: 0,
    Unselectable: false,
  })
  const bone = {
    Name: 'Bone_Root',
    ObjectId: 0,
    Parent: null,
    PivotPoint: Float32Array.from([0, 0, 0]),
    Flags: 256,
    GeosetId: 0,
    GeosetAnimId: -1,
    // A linear translation track over the sequence interval, so the clip carries a channel and
    // the export has real motion to materialise rather than an empty animation.
    Translation: {
      LineType: 1,
      Keys: [
        { Frame: 0, Vector: Float32Array.from([0, 0, 0]) },
        { Frame: 1000, Vector: Float32Array.from([0, 0, 64]) },
      ],
    },
  }
  model.Bones.push(bone)
  model.Nodes.push(bone)
  model.PivotPoints.push(Float32Array.from([0, 0, 0]))
  return { mdx: generateWar3Mdx(model), mdl: new TextEncoder().encode(generateWar3Mdl(model)) }
}

describe('ported Warcraft III model codec', () => {
  it('decodes an MDLX container into model facets', async () => {
    const session = await open(new Uint8Array(await readFile(fixturePath)))
    expect(await inspect(session)).toMatchObject({
      format: 'war3-mdx',
      encoding: 'mdx',
      version: 800,
      name: 'FixtureModel',
      geosets: 0,
      materials: 0,
      bones: 0,
      sequences: 0,
      chunks: 2,
    })
    const lease = await session.dataSource('common.view/tree-data-source', 1)
    const tree = lease.value as TreeDataSource
    const children = await tree.children(await tree.root(), { limit: 10 })
    expect(children.items).toHaveLength(2)
    expect(await Promise.all(children.items.map(item => tree.facts(item)))).toMatchObject([
      { kind: 'chunk', label: 'VERS' },
      { kind: 'chunk', label: 'MODL' },
    ])
    await lease.release()
    await session.dispose()
  })

  it('publishes decoded geometry, materials, bones and sequences', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    expect(await inspect(session)).toMatchObject({
      encoding: 'mdx',
      geosets: 1,
      materials: 1,
      bones: 1,
      sequences: 1,
      textures: 1,
      // The authored fixture carries no emitter; emitter decoding is covered by the real-model
      // corpus, which needs an installed Warcraft III and is not available in this repository.
      particleEmitters: 0,
    })
    const sceneLease = await session.dataSource('common.view/model-scene-source', 1)
    const scene = sceneLease.value as ModelSceneSource
    const info = await scene.info()
    expect(info).toMatchObject({ meshes: 1, primitives: 1, geometryAccess: 'decoded' })
    const meshes = await scene.meshes({ limit: 10 })
    const primitive = await scene.primitive(meshes.items[0]!.primitiveIds[0]!, {
      maxBytes: 1_000_000,
    })
    expect(primitive?.positions).toHaveLength(9)
    expect(primitive?.indices).toHaveLength(3)
    expect(primitive?.materialId).toBe('war3-material-0')
    await sceneLease.release()

    const refsLease = await session.dataSource('common.view/model-resource-refs-source', 1)
    const refs = refsLease.value as ModelResourceRefsSource
    const references = await refs.references({ limit: 10 })
    expect(references.items).toMatchObject([
      { id: 'Textures\\Fixture.blp', role: 'texture', provenance: 'reference-only' },
    ])
    await refsLease.release()

    const clipLease = await session.dataSource('common.view/model-animation-source', 1)
    const animation = clipLease.value as ModelAnimationSource
    const clips = await animation.clips({ limit: 10 })
    expect(clips.items[0]).toMatchObject({
      name: 'Stand',
      kind: 'animation',
      provenance: 'direct',
      nativeTimeBounds: { startMilliseconds: 0, endMilliseconds: 1000 },
    })
    await clipLease.release()
    await session.dispose()
  })

  it('reads the same model back from its MDL serialisation', async () => {
    // The vendored writer emits both encodings from one model, so the text path is exercised
    // against real geometry instead of a hand-written declaration stub.
    const session = await open((await authoredModelBytes()).mdl)
    expect(await inspect(session)).toMatchObject({
      format: 'war3-mdx',
      encoding: 'mdl',
      geosets: 1,
      materials: 1,
      bones: 1,
      sequences: 1,
      textures: 1,
    })
    await session.dispose()
  })

  it('exports UVM whose facets match the ones it publishes', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    const result = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    if (result.state !== 'ok' || result.output.kind !== 'bytes')
      throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
    const bytes = result.output.value as Uint8Array
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF')
    const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)
    const document = JSON.parse(
      new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
    ) as Record<string, unknown>

    // The projection handed to the materializer is the same facet set the codec publishes, so the
    // UVM document has to agree with the inspection summary rather than merely parse.
    expect((document['meshes'] as unknown[]).length).toBe(1)
    expect((document['materials'] as unknown[]).length).toBe(1)
    expect((document['animations'] as unknown[]).length).toBe(1)
    expect((document['nodes'] as unknown[]).length).toBeGreaterThan(1)
    const extras = document['extras'] as Record<string, Record<string, unknown>>
    expect(extras['BlizzardMDX']).toMatchObject({ format: 'war3-mdx' })
    // No native bytes are smuggled into the residual.
    expect(JSON.stringify(document)).not.toContain('UV_source_blob')
    await session.dispose()
  })

  it('refuses an export that does not state its unit scale', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    const operations = session.operations()
    for (const request of [
      { schemaVersion: 1 },
      { schemaVersion: 1, metersPerSourceUnit: 0 },
      { schemaVersion: 1, metersPerSourceUnit: -1 },
      { schemaVersion: 2, metersPerSourceUnit: 1 },
      { schemaVersion: 1, metersPerSourceUnit: 1, scale: 2 },
    ]) {
      await expect(
        operations.invoke('model-export-uvm', request),
        JSON.stringify(request),
      ).rejects.toThrow()
    }
    await session.dispose()
  })

  it('writes the model back as MDX and as MDL, verified by reopening', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    const operations = session.operations()
    const mdx = await operations.invoke('model-write', { schemaVersion: 1 })
    if (mdx.state !== 'ok' || mdx.output.kind !== 'bytes') throw new Error('model.write failed')
    const written = mdx.output.value as Uint8Array
    expect(new TextDecoder().decode(written.subarray(0, 4))).toBe('MDLX')

    const mdl = await operations.invoke('model-write', { schemaVersion: 1, encoding: 'mdl' })
    if (mdl.state !== 'ok' || mdl.output.kind !== 'bytes') throw new Error('MDL write failed')
    expect(new TextDecoder().decode((mdl.output.value as Uint8Array).subarray(0, 7))).toMatch(
      /Version/u,
    )

    // The written model is a model: reopening it through the codec yields the same facets.
    const reopened = await open(written)
    expect(await inspect(reopened)).toMatchObject({
      encoding: 'mdx',
      geosets: 1,
      materials: 1,
      bones: 1,
      sequences: 1,
      textures: 1,
    })
    await reopened.dispose()
    await session.dispose()
  })

  it('writes Warcraft III bytes back from UVM through the native encoder', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    const exported = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
      throw new Error('model.export-uvm failed')
    await session.dispose()

    const { createProvider } = (await import(
      pathToFileURL(
        join(extension, 'dist', 'war3-mdx', 'encoder-provider.js'),
      ).href
    )) as typeof import('../../blizzard-warcraft-3/dist/war3-mdx/encoder-provider.js')
    const provider = createProvider(
      {
        contract: 'common.model/native-encoder',
        major: 1,
        offerId: 'war3-mdx-from-uvm',
        contractSelectionKey: 'format=war3-mdx',
      },
      { budgets: budget },
    )
    const encoded = await provider.value.encode({ uvm: exported.output.value as Uint8Array })
    expect(encoded.formatId).toBe('war3-mdx')
    expect(new TextDecoder().decode(encoded.bytes.subarray(0, 4))).toBe('MDLX')
    await provider.release()

    // UVM -> MDX is a model this codec reads back with the same facets it exported.
    const roundTripped = await open(encoded.bytes)
    expect(await inspect(roundTripped)).toMatchObject({
      encoding: 'mdx',
      geosets: 1,
      materials: 1,
      bones: 1,
      sequences: 1,
    })
    await roundTripped.dispose()
  })

  it('converts a UVM document from another game, with no Warcraft III residual', async () => {
    const { exportWar3FromUvm } = (await import(
      pathToFileURL(join(extension, 'dist', 'war3-mdx', 'native-encoder.js')).href
    )) as typeof import('../../blizzard-warcraft-3/dist/war3-mdx/native-encoder.js')
    const { materializeUvmCore } = (await import(
      pathToFileURL(
        join(extension, 'node_modules', '@modkit', 'uv', 'dist', 'model', 'materializer.js'),
      ).href
    )) as typeof import('@modkit/uv/model/materializer')

    // A plain UVM document: no BlizzardMDX residual, the shape any other game's exporter produces.
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const foreign = materializeUvmCore(
      {
        info: {
          scenes: 1,
          nodes: 1,
          meshes: 1,
          primitives: 1,
          materials: 1,
          textures: 0,
          animations: 0,
          geometryAccess: 'decoded',
        },
        nodes: [
          {
            id: 'root',
            name: 'Root',
            childIds: [],
            meshIds: ['mesh-0'],
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
        ],
        meshes: [{ id: 'mesh-0', name: 'Mesh', primitiveIds: ['mesh-0-primitive'] }],
        primitives: [
          {
            id: 'mesh-0-primitive',
            topology: 'triangles',
            positions,
            indices: Uint32Array.from([0, 1, 2]),
            materialId: 'material-0',
          },
        ],
        materials: [{ id: 'material-0', name: 'Foreign', alphaMode: 'opaque' }],
      },
      {
        scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
        profile: 'UVM/core@1.0',
        subjectRevision: revisionId('content-hash.sha256:foreign'),
        options: { assetId: 'memory://foreign', sourceFormat: 'test' },
      },
    )

    const containerBudget = {
      maxInputBytes: Number(budget.maxInputBytes),
      maxJsonBytes: budget.maxScalarBytes,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
    }
    const converted = exportWar3FromUvm(foreign.bytes, containerBudget)
    expect(new TextDecoder().decode(converted.subarray(0, 4))).toBe('MDLX')

    // The converted model is a Warcraft III model this codec reads back.
    const session = await open(converted)
    expect(await inspect(session)).toMatchObject({
      format: 'war3-mdx',
      encoding: 'mdx',
      geosets: 1,
      materials: 1,
      sequences: 1,
    })
    await session.dispose()
  })

  it('refuses to write a UVM document it cannot read', async () => {
    const { exportWar3FromUvm } = (await import(
      pathToFileURL(join(extension, 'dist', 'war3-mdx', 'native-encoder.js')).href
    )) as typeof import('../../blizzard-warcraft-3/dist/war3-mdx/native-encoder.js')
    const containerBudget = {
      maxInputBytes: Number(budget.maxInputBytes),
      maxJsonBytes: budget.maxScalarBytes,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
    }
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}')
    const glb = new Uint8Array(20 + json.length)
    const view = new DataView(glb.buffer)
    glb.set(new TextEncoder().encode('glTF'), 0)
    view.setUint32(4, 2, true)
    view.setUint32(8, glb.length, true)
    view.setUint32(12, json.length, true)
    glb.set(new TextEncoder().encode('JSON'), 16)
    glb.set(json, 20)
    expect(() => exportWar3FromUvm(glb, containerBudget)).toThrow()
  })

  it('refuses malformed models by naming the format instead of leaking a parser error', async () => {
    const bytes = new Uint8Array(await readFile(fixturePath))
    const noVersion = bytes.slice(0, 4)
    await expect(open(noVersion)).rejects.toThrow(/VERS/u)

    const outOfBounds = bytes.slice()
    new DataView(outOfBounds.buffer).setUint32(20, 0xffffffff, true)
    await expect(open(outOfBounds)).rejects.toThrow(/out of bounds/u)
    await expect(open(bytes, { ...budget, maxNodes: 1 })).rejects.toThrow(/maxNodes/u)

    // MDLX with a valid VERS but a truncated payload: the parser fails, the codec names the format.
    const truncated = new Uint8Array([
      ...bytes.slice(0, 12),
      ...new Uint8Array([0x20, 0x03, 0, 0]),
      ...new Uint8Array([0x4d, 0x4f, 0x44, 0x4c, 0x04, 0, 0, 0, 0, 0, 0, 0]),
    ])
    await expect(open(truncated)).rejects.toThrow(/MDX model could not be decoded|out of bounds/u)
  })
})
