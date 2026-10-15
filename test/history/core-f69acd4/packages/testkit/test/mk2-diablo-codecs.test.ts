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
  type ModelSceneSource,
  type RasterImageSource,
  type ResourceBudget,
} from '@modkitx-x3/sdk'

const root = join(import.meta.dirname, '..', '..', '..')
const extension = join(root, 'extensions', 'mk2', 'blizzard-diablo')
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'mk2-synthetic')
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
      throw new Error('Diablo codecs have no service dependency')
    },
    async resolveUnknown() {
      throw new Error('Diablo codecs have no foreign service dependency')
    },
  },
}

function source(bytes: Uint8Array, name: string): ArtifactByteSource {
  const uri = `memory://blizzard-diablo/${name}`
  return {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision: revisionId(`content-hash.sha256:blizzard-diablo-${name}`),
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

async function codec(id: 'diablo3-app' | 'diablo3-tex'): Promise<Codec> {
  const module = (await import(pathToFileURL(join(extension, 'src', id, 'codec.js')).href)) as {
    createCodec(context: ContributionContext): Codec
  }
  return module.createCodec(context)
}

async function open(id: 'diablo3-app' | 'diablo3-tex', bytes: Uint8Array, resourceBudget = budget) {
  return (await codec(id)).open(input(source(bytes, id)), 'inspect', resourceBudget)
}

async function inspect(session: Awaited<ReturnType<typeof open>>) {
  const result = await session.operations().invoke('inspect', null)
  if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('inspect failed')
  return result.output.value
}

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(fixtureRoot, name)))
}

describe('ported Diablo III codecs', () => {
  it('decodes APP v260 fixed-record triangle geometry', async () => {
    const session = await open('diablo3-app', await fixture('minimal.diablo3.app'))
    expect(await inspect(session)).toMatchObject({
      format: 'diablo3-app',
      version: 260,
      snoId: 42,
      objectType: 1,
      submeshes: 1,
      vertices: 3,
      triangles: 1,
      bones: 0,
      bounds: { min: [0, -17, 0], max: [17, 0, 0] },
      geometryAccess: 'decoded',
    })
    const lease = await session.dataSource('common.view/model-scene-source', 1)
    const model = lease.value as ModelSceneSource
    expect(await model.info()).toMatchObject({
      meshes: 1,
      primitives: 1,
      geometryAccess: 'decoded',
    })
    expect(await model.primitive?.('primitive-0', { maxBytes: 1024 })).toMatchObject({
      topology: 'triangles',
      positions: new Float32Array([0, 0, 0, 0, -17, 0, 17, 0, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      textureCoordinates: new Float32Array([0, -1, 0, 0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    })
    await lease.release()
    await session.dispose()
  })

  it('decodes TEX v47 raw pixels and a component-planar BC1 block', async () => {
    const raw = await fixture('minimal.diablo3.tex')
    const session = await open('diablo3-tex', raw)
    expect(await inspect(session)).toMatchObject({
      format: 'diablo3-tex',
      version: 47,
      snoId: 1234,
      width: 2,
      height: 1,
      pixelFormat: 'A8R8G8B8',
      decodedAccess: true,
    })
    const lease = await session.dataSource('common.view/raster-image-source', 1)
    const raster = lease.value as RasterImageSource
    expect(
      await raster.readRegion?.({
        x: 0,
        y: 0,
        width: 2,
        height: 1,
        pixelFormat: 'rgba8',
        maxBytes: 8,
      }),
    ).toMatchObject({
      pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]),
    })
    await lease.release()
    await session.dispose()

    const compressed = new Uint8Array(0x2c8 + 16 + 8)
    compressed.set(raw.subarray(0, 0x2c8))
    const view = new DataView(compressed.buffer)
    view.setUint32(0x20, 9, true)
    view.setUint32(0x24, 4, true)
    view.setUint32(0x28, 4, true)
    view.setUint32(0x3c, 8, true)
    compressed.set([0x00, 0xf8, 0x00, 0x00, 0, 0, 0, 0], 0x2c8 + 16)
    const compressedSession = await open('diablo3-tex', compressed)
    const compressedLease = await compressedSession.dataSource('common.view/raster-image-source', 1)
    const compressedRaster = compressedLease.value as RasterImageSource
    const decoded = await compressedRaster.readRegion?.({
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      pixelFormat: 'rgba8',
      maxBytes: 64,
    })
    expect(decoded?.pixels.subarray(0, 4)).toEqual(new Uint8Array([255, 0, 0, 255]))
    await compressedLease.release()
    await compressedSession.dispose()
  })

  it('rejects invalid geometry, mip ranges, and resource budgets', async () => {
    const app = await fixture('minimal.diablo3.app')
    const invalidApp = app.slice()
    const appView = new DataView(invalidApp.buffer)
    const submesh = appView.getUint32(0x0ac, true) + 16
    const indices = appView.getUint32(submesh + 0x2c, true) + 16
    appView.setUint16(indices + 4, 3, true)
    await expect(open('diablo3-app', invalidApp)).rejects.toThrow(/out of range/u)
    await expect(open('diablo3-app', app, { ...budget, maxNodes: 6 })).rejects.toThrow(/maxNodes/u)

    const tex = await fixture('minimal.diablo3.tex')
    const invalidTex = tex.slice()
    new DataView(invalidTex.buffer).setUint32(0x38, tex.byteLength, true)
    await expect(open('diablo3-tex', invalidTex)).rejects.toThrow(/out of bounds/u)
    await expect(open('diablo3-tex', tex, { ...budget, maxScalarBytes: 7 })).rejects.toThrow(
      /maxScalarBytes/u,
    )
  })
})
