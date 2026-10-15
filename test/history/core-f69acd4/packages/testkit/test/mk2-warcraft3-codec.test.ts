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
  type ResourceBudget,
  type TreeDataSource,
} from '@modkitx-x3/sdk'

const root = join(import.meta.dirname, '..', '..', '..')
const extension = join(root, 'extensions', 'mk2', 'blizzard-warcraft-3')
const fixturePath = join(import.meta.dirname, 'fixtures', 'mk2-synthetic', 'minimal.mdx')
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

describe('ported Warcraft III model codec', () => {
  it('walks an MDLX container and reads VERS and MODL metadata', async () => {
    const session = await open(new Uint8Array(await readFile(fixturePath)))
    expect(await inspect(session)).toMatchObject({
      format: 'war3-mdx',
      encoding: 'mdx',
      version: 800,
      name: 'FixtureModel',
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

  it('inspects bounded text MDL declarations without the historical parser graph', async () => {
    const bytes = new TextEncoder().encode(
      'Version { FormatVersion 800, }\nModel "Footman" { NumSequences 2, }\nSequences 2 { }\n',
    )
    const session = await open(bytes)
    expect(await inspect(session)).toMatchObject({
      format: 'war3-mdx',
      encoding: 'mdl',
      version: 800,
      name: 'Footman',
      sequences: 2,
      declarations: 3,
    })
    await session.dispose()
  })

  it('rejects missing chunks, out-of-bounds ranges, and node budgets', async () => {
    const bytes = new Uint8Array(await readFile(fixturePath))
    const noVersion = bytes.slice(0, 4)
    await expect(open(noVersion)).rejects.toThrow(/VERS/u)

    const outOfBounds = bytes.slice()
    new DataView(outOfBounds.buffer).setUint32(20, 0xffffffff, true)
    await expect(open(outOfBounds)).rejects.toThrow(/out of bounds/u)
    await expect(open(bytes, { ...budget, maxNodes: 1 })).rejects.toThrow(/maxNodes/u)
  })
})
