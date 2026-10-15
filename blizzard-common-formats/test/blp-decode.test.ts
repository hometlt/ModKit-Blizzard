import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const extension = join(import.meta.dirname, '..')
const codec = (await import(pathToFileURL(join(extension, 'src', 'blp', 'codec.js')).href)) as {
  createCodec: (context: unknown) => unknown
}

const budget = {
  maxInputBytes: 10n ** 9n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 32 * 1024 * 1024,
  maxDiagnostics: 100,
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
  const uri = 'memory://texture.blp'
  const revision = 'content-hash.sha256:texture'
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

interface Session {
  dataSource: (
    contract: string,
    major: number,
  ) => Promise<{ value: never; release: () => Promise<void> }>
  operations: () => { invoke: (id: string, payload: unknown) => Promise<never> }
  dispose: () => Promise<void>
}

const open = async (bytes: Uint8Array): Promise<Session> =>
  (
    codec.createCodec(context) as {
      open: (input: unknown, mode: string, budget: unknown) => Promise<Session>
    }
  ).open(input(bytes), 'inspect', budget)

/**
 * A palettised BLP1: a 156-byte header, a 256-entry BGRA palette, then one byte of palette index
 * per pixel. Warcraft III's own textures are laid out exactly this way.
 */
function palettisedBlp1(alphaDepth: number): Uint8Array {
  const width = 2
  const height = 2
  const header = 156
  const palette = 256 * 4
  const indices = width * height
  const alphaBytes = Math.ceil((indices * alphaDepth) / 8)
  const bytes = new Uint8Array(header + palette + indices + alphaBytes)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('BLP1'), 0)
  view.setUint32(4, 1, true) // palettised
  view.setUint32(8, alphaDepth, true)
  view.setUint32(12, width, true)
  view.setUint32(16, height, true)
  view.setUint32(28, header + palette, true) // mip 0 offset
  view.setUint32(92, indices + alphaBytes, true) // mip 0 size
  // Palette entry 1 is pure red, stored BGRA like every other Blizzard palette.
  bytes[header + 4] = 0
  bytes[header + 5] = 0
  bytes[header + 6] = 255
  bytes[header + 7] = 255
  for (let index = 0; index < indices; index += 1) bytes[header + palette + index] = 1
  if (alphaDepth === 8)
    for (let index = 0; index < indices; index += 1)
      bytes[header + palette + indices + index] = 128
  return bytes
}

async function topLeftPixel(bytes: Uint8Array) {
  const session = await open(bytes)
  try {
    const lease = await session.dataSource('common.view/raster-image-source', 1)
    const source = lease.value as never as {
      info: () => Promise<{ width: number; height: number; decodedAccess?: boolean }>
      readRegion?: (request: unknown) => Promise<{ pixels: Uint8Array }>
    }
    const info = await source.info()
    expect(source.readRegion, 'the codec must expose decoded access').toBeTypeOf('function')
    const region = await source.readRegion!({
      x: 0,
      y: 0,
      width: info.width,
      height: info.height,
      pixelFormat: 'rgba8',
      maxBytes: info.width * info.height * 4,
    })
    await lease.release()
    return [...region.pixels.subarray(0, 4)]
  } finally {
    await session.dispose()
  }
}

describe('BLP decoded access', () => {
  it.each([0, 8])('decodes the valid shared-header JPEG BLP1 with alpha depth %i', async alphaDepth => {
    const bytes = new Uint8Array(readFileSync(new URL('../../../references/mdx-m3-viewer/clients/example/resources/Textures/SmileyGW.blp', import.meta.url)))
    new DataView(bytes.buffer).setUint32(8, alphaDepth, true)
    const session = await open(bytes)
    const lease = await session.dataSource('common.view/raster-image-source', 1)
    const source = lease.value as { readRegion(request: unknown): Promise<{ pixels: Uint8Array }> }
    try {
      const { pixels } = await source.readRegion({ x: 40, y: 150, width: 1, height: 1, pixelFormat: 'rgba8', maxBytes: 4 })
      expect(pixels[0]).toBeGreaterThan(200)
      expect(pixels[1]).toBeGreaterThan(150)
      expect(pixels[2]).toBeLessThan(80)
      expect(pixels[3]).toBeGreaterThan(200)
      const corner = await source.readRegion({ x: 2, y: 2, width: 1, height: 1, pixelFormat: 'rgba8', maxBytes: 4 })
      if (alphaDepth === 0) expect(corner.pixels[3]).toBe(255)
      else expect(corner.pixels[3]).toBeLessThan(60)
      await expect(source.readRegion({ x: 256, y: 0, width: 1, height: 1, pixelFormat: 'rgba8', maxBytes: 4 })).rejects.toThrow(/outside/u)
      await expect(source.readRegion({ x: 0, y: 0, width: 1, height: 1, pixelFormat: 'rgba8', maxBytes: 3 })).rejects.toThrow(/maxBytes/u)
    } finally { await lease.release(); await session.dispose() }
  })

  it.each(['dimensions', 'progressive'])('refuses a JPEG BLP1 with %s mismatch', async fault => {
    const bytes = new Uint8Array(readFileSync(new URL('../../../references/mdx-m3-viewer/clients/example/resources/Textures/SmileyGW.blp', import.meta.url)))
    if (fault === 'dimensions') new DataView(bytes.buffer).setUint32(12, 512, true)
    else {
      const marker = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xc0)
      expect(marker).toBeGreaterThan(159)
      bytes[marker + 1] = 0xc2
    }
    const session = await open(bytes)
    const lease = await session.dataSource('common.view/raster-image-source', 1)
    const source = lease.value as { readRegion(request: unknown): Promise<unknown> }
    try {
      await expect(source.readRegion({ x: 0, y: 0, width: 1, height: 1, pixelFormat: 'rgba8', maxBytes: 4 })).rejects.toThrow(fault === 'dimensions' ? /declared image size/u : /progressive/u)
    } finally { await lease.release(); await session.dispose() }
  })

  it('decodes a palettised BLP1 through its BGRA palette', async () => {
    expect(await topLeftPixel(palettisedBlp1(0))).toEqual([255, 0, 0, 255])
  })

  it('reads the separate alpha plane a palettised BLP1 carries', async () => {
    expect(await topLeftPixel(palettisedBlp1(8))).toEqual([255, 0, 0, 128])
  })

  it('offers decoded access for a JPEG BLP1 whose shared header is declared', async () => {
    // BLP1 stores one JPEG header shared by every mip. With a plausible header the codec offers
    // decoded access; a payload that then fails to decode refuses at read, with the reason.
    const bytes = palettisedBlp1(0)
    const view = new DataView(bytes.buffer)
    view.setUint32(4, 0, true)
    view.setUint32(156, 4, true)
    const session = await open(bytes)
    const lease = await session.dataSource('common.view/raster-image-source', 1)
    const source = lease.value as never as {
      info: () => Promise<{ width: number; height: number; decodedAccess?: boolean }>
      readRegion?: (request: unknown) => Promise<{ pixels: Uint8Array }>
    }
    expect((await source.info()).decodedAccess).toBe(true)
    await expect(
      source.readRegion!({
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        pixelFormat: 'rgba8',
        maxBytes: 64,
      }),
    ).rejects.toThrow()
    await lease.release()
    await session.dispose()
  })

  it('offers no decoded access when the JPEG header segment is not declared', async () => {
    const bytes = palettisedBlp1(0)
    const view = new DataView(bytes.buffer)
    view.setUint32(4, 0, true)
    // A header segment larger than the file is not a header this format wrote.
    view.setUint32(156, 1024 * 1024, true)
    const session = await open(bytes)
    const lease = await session.dataSource('common.view/raster-image-source', 1)
    const source = lease.value as never as {
      info: () => Promise<{ decodedAccess?: boolean }>
      readRegion?: unknown
    }
    expect((await source.info()).decodedAccess).toBe(false)
    expect(source.readRegion).toBeUndefined()
    await lease.release()
    await session.dispose()
  })
})
