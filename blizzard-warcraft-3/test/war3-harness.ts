/** Shared by the Warcraft III codec suites: the codec opened as the host would, and a model authored
 * through the vendored writer, so every suite reads real MDX/MDL bytes rather than a stub. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  revisionId,
  type ArtifactByteSource,
  type AssetInput,
  type Codec,
  type ContributionContext,
  type ResourceBudget,
} from '@modkit/sdk'

export const extension = join(import.meta.dirname, '..')
// The fixture stays with the migrated suite this file carries on (test/behavior/coverage-receipt.json).
export const fixturePath = join(extension, '..', 'test', 'behavior', 'fixtures', 'minimal.mdx')
export const budget: ResourceBudget = {
  maxInputBytes: 1_000_000n,
  maxDepth: 32,
  maxNodes: 1000,
  maxScalarBytes: 1_000_000,
  maxDiagnostics: 100,
}
export const context: ContributionContext = {
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

export function source(bytes: Uint8Array, uri = 'memory://blizzard-warcraft-3/model'): ArtifactByteSource {
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

export function input(value: ArtifactByteSource): AssetInput {
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

export async function open(bytes: Uint8Array, resourceBudget = budget) {
  return (await war3Codec()).open(input(source(bytes)), 'inspect', resourceBudget)
}

export async function inspect(session: Awaited<ReturnType<typeof open>>) {
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
export async function authoredModelBytes(): Promise<{ mdx: Uint8Array; mdl: Uint8Array }> {
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
