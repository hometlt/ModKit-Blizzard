import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeBcSurface, type BcFormat } from '@modkit/codec-kit/texture/bc'

const codec = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'diablo3-tex', 'codec.js')).href
)) as { createCodec: (context: unknown) => { open: (...args: unknown[]) => Promise<Session> } }

interface Session {
  dataSource: (contract: string, major: number) => Promise<{
    value: { readRegion: (request: unknown) => Promise<{ pixels: Uint8Array }> }
    release: () => Promise<void>
  }>
  dispose: () => Promise<void>
}

const budget = { maxInputBytes: 1n << 20n, maxDepth: 64, maxNodes: 1000, maxScalarBytes: 1 << 20, maxDiagnostics: 100 }
const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: { resolve: async () => undefined, resolveUnknown: async () => undefined },
}

function input(bytes: Uint8Array) {
  const uri = 'memory://blocks.tex'
  const revision = 'content-hash.sha256:blocks'
  const value = {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
    read: async (offset: bigint, length: number) => bytes.slice(Number(offset), Number(offset) + length),
    async *stream() {
      yield bytes
    },
  }
  const binding = { sourceKind: 'candidate', bindingId: 'content', role: 'content', ownership: 'owned', source: value.ref, revision }
  return {
    originKind: 'single',
    bindings: [binding],
    primaryBindingId: 'content',
    revisions: { topology: 'single', revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: uri },
    bindingsFor: () => [],
    openBinding: async () => ({ value, release: async () => undefined }),
  }
}

/**
 * Diablo III stores each component of every block in its own run: for 16-byte blocks the alpha
 * endpoints of all blocks, then their alpha indices, then colour endpoints, then selectors.
 * `parts` is the byte length of each run's slice of one block.
 */
function planar(blocks: readonly Uint8Array[], parts: readonly number[]): Uint8Array {
  const out: number[] = []
  let start = 0
  for (const length of parts) {
    for (const block of blocks) out.push(...block.subarray(start, start + length))
    start += length
  }
  return Uint8Array.from(out)
}

/**
 * One block-compressed level laid out as the installed game does: a 16-byte rectangle at the
 * table offset, then every face back to back. `extraEntries` are further mip-table rows.
 */
function tex(
  pixelFormat: number,
  payload: Uint8Array,
  { width = 8, height = 4, faces = 1, extraEntries = [] as readonly [number, number][] } = {},
): Uint8Array {
  const header = 0x270
  const bytes = new Uint8Array(header + 16 + payload.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xdeadbeef, true)
  view.setUint32(4, 47, true)
  view.setUint32(0x20, pixelFormat, true)
  view.setUint32(0x24, width, true)
  view.setUint32(0x28, height, true)
  view.setUint32(0x2c, faces, true)
  view.setUint32(0x38, header, true)
  view.setUint32(0x3c, payload.byteLength / faces, true)
  for (const [index, [offset, size]] of extraEntries.entries()) {
    view.setUint32(0x40 + index * 8, offset, true)
    view.setUint32(0x44 + index * 8, size, true)
  }
  bytes.set(payload, header + 16)
  return bytes
}

async function readFace(bytes: Uint8Array, face: number, width: number, height: number) {
  const session = await codec.createCodec(context).open(input(bytes), 'inspect', budget)
  const raster = await session.dataSource('common.view/raster-image-source', 1)
  const info = await (
    raster.value as unknown as { info: () => Promise<{ mipLevels: number; storedMipLevels?: number }> }
  ).info()
  const region = await raster.value.readRegion({ x: 0, y: 0, width, height, face, pixelFormat: 'rgba8', maxBytes: 1024 })
  await raster.release()
  await session.dispose()
  // codec-kit computes the levels below the stored chain on request; the file's own are `stored`
  return { pixels: region.pixels, mipLevels: info.storedMipLevels ?? info.mipLevels }
}

const cases: readonly [number, BcFormat, number[]][] = [
  [9, 'DXT1', [4, 4]],
  [11, 'DXT3', [8, 4, 4]],
  [12, 'DXT5', [2, 6, 4, 4]],
  [43, 'BC5', [2, 6, 4, 4]],
]

/** Pixel format 9 is opaque BC1: the three-colour block's fourth index decodes black, not transparent. */
const opaque = (pixels: Uint8Array) => {
  const out = pixels.slice()
  for (let alpha = 3; alpha < out.length; alpha += 4) out[alpha] = 255
  return out
}
const decoded = (id: number, data: Uint8Array, width: number, height: number, format: BcFormat) => {
  const pixels = decodeBcSurface(data, 0, width, height, format)
  return id === 9 ? opaque(pixels) : pixels
}

describe('Diablo III TEX block formats', () => {
  it.each(cases)('pixel format %i decodes as %s through the shared BC decoder', async (id, format, parts) => {
    const blockBytes = parts.reduce((sum, part) => sum + part, 0)
    // Two different blocks: with one block the planar and interleaved layouts coincide.
    const blocks = [0, 1].map(block =>
      Uint8Array.from({ length: blockBytes }, (_, index) => (index * 37 + block * 101 + 11) & 0xff),
    )
    const session = await codec.createCodec(context).open(input(tex(id, planar(blocks, parts))), 'inspect', budget)
    const raster = await session.dataSource('common.view/raster-image-source', 1)
    const region = await raster.value.readRegion({ x: 0, y: 0, width: 8, height: 4, pixelFormat: 'rgba8', maxBytes: 128 })
    await raster.release()
    await session.dispose()
    const interleaved = new Uint8Array(blockBytes * 2)
    interleaved.set(blocks[0]!, 0)
    interleaved.set(blocks[1]!, blockBytes)
    expect(region.pixels).toEqual(decoded(id, interleaved, 8, 4, format))
  })

  it('reads every face of a cube map stored after one rectangle', async () => {
    // Installed irradiance cubes: 32x32 BC1, one rectangle, six faces back to back.
    const faces = Array.from({ length: 6 }, (_, face) =>
      Uint8Array.from({ length: 8 }, (_, index) => (index * 29 + face * 53 + 7) & 0xff),
    )
    const bytes = tex(9, Uint8Array.from(faces.flatMap(face => [...face])), { width: 4, height: 4, faces: 6 })
    for (const [index, face] of faces.entries())
      expect((await readFace(bytes, index, 4, 4)).pixels).toEqual(decoded(9, face, 4, 4, 'DXT1'))
  })

  it('ends the mip chain at the first table entry the file does not hold', async () => {
    // Installed lightning textures list levels whose ranges lie past the end of the file.
    const block = Uint8Array.from({ length: 8 }, (_, index) => index * 31)
    const bytes = tex(9, block, { width: 4, height: 4, extraEntries: [[0x270 + 64, 8], [0xffff, 4]] })
    const read = await readFace(bytes, 0, 4, 4)
    expect(read.mipLevels).toBe(1)
    expect(read.pixels).toEqual(decoded(9, block, 4, 4, 'DXT1'))
  })
})
