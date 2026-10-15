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
  type RasterImageSource,
  type ResourceBudget,
} from '@modkitx-x3/sdk'

const root = join(import.meta.dirname, '..', '..', '..')
const extension = join(root, 'extensions', 'mk2', 'blizzard-common-formats')
const fixturePath = join(import.meta.dirname, 'fixtures', 'mk2-synthetic', 'minimal.blp')
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
      throw new Error('BLP codec has no service dependency')
    },
    async resolveUnknown() {
      throw new Error('BLP codec has no foreign service dependency')
    },
  },
}

function source(bytes: Uint8Array): ArtifactByteSource {
  const uri = 'memory://blizzard-common-formats/minimal.blp'
  return {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision: revisionId('content-hash.sha256:blizzard-common-formats-blp'),
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

async function blpCodec(): Promise<Codec> {
  const module = (await import(pathToFileURL(join(extension, 'src', 'blp', 'codec.js')).href)) as {
    createCodec(context: ContributionContext): Codec
  }
  return module.createCodec(context)
}

async function open(bytes: Uint8Array, resourceBudget = budget) {
  return (await blpCodec()).open(input(source(bytes)), 'inspect', resourceBudget)
}

async function inspect(session: Awaited<ReturnType<typeof open>>) {
  const result = await session.operations().invoke('inspect', null)
  if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('inspect failed')
  return result.output.value
}

describe('ported Blizzard common-formats BLP codec', () => {
  it('decodes a BLP2 BGRA top mip to bounded RGBA regions', async () => {
    const bytes = new Uint8Array(await readFile(fixturePath))
    const session = await open(bytes)
    expect(await inspect(session)).toMatchObject({
      format: 'blp',
      version: 'BLP2',
      width: 2,
      height: 1,
      encoding: 'bgra8',
      alphaDepth: 8,
      mipLevels: 1,
      decodedAccess: true,
    })
    const lease = await session.dataSource('common.view/raster-image-source', 1)
    const raster = lease.value as RasterImageSource
    expect(await raster.info()).toMatchObject({ width: 2, height: 1, decodedAccess: true })
    if (raster.readRegion === undefined) throw new Error('BLP raster has no decoded access')
    await expect(
      raster.readRegion({
        x: 0,
        y: 0,
        width: 2,
        height: 1,
        pixelFormat: 'rgba8',
        maxBytes: 8,
      }),
    ).resolves.toMatchObject({
      pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]),
    })
    expect(new TextDecoder('ascii').decode(await (await raster.encoded()).read(0n, 4))).toBe('BLP2')
    await lease.release()
    await session.dispose()
  })

  it('keeps BLP1 paletted textures metadata-only without external decoders', async () => {
    const bytes = new Uint8Array(156)
    bytes.set(new TextEncoder().encode('BLP1'), 0)
    const data = new DataView(bytes.buffer)
    data.setUint32(4, 1, true)
    data.setUint32(8, 8, true)
    data.setUint32(12, 4, true)
    data.setUint32(16, 2, true)
    const session = await open(bytes)
    expect(await inspect(session)).toMatchObject({
      version: 'BLP1',
      width: 4,
      height: 2,
      encoding: 'paletted',
      decodedAccess: false,
    })
    const lease = await session.dataSource('common.view/raster-image-source', 1)
    const raster = lease.value as RasterImageSource
    expect(await raster.info()).toMatchObject({ decodedAccess: false })
    expect(raster.readRegion).toBeUndefined()
    await lease.release()
    await session.dispose()
  })

  it('rejects mip ranges and decoded images outside their bounds and budget', async () => {
    const bytes = new Uint8Array(await readFile(fixturePath))
    const outOfBounds = bytes.slice()
    new DataView(outOfBounds.buffer).setUint32(20, outOfBounds.byteLength, true)
    await expect(open(outOfBounds)).rejects.toThrow(/out of bounds/u)

    const truncated = bytes.slice()
    new DataView(truncated.buffer).setUint32(84, 7, true)
    await expect(open(truncated)).rejects.toThrow(/top mip is truncated/u)
    await expect(open(bytes, { ...budget, maxScalarBytes: 7 })).rejects.toThrow(/maxScalarBytes/u)
  })
})
