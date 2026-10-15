import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createCodec } from '../codecs/package/src/codec.js'
import {
  SC2_MAP_PREVIEW_PROVENANCE,
  renderSc2HeightPreview,
  renderSc2PathingPreview,
} from '../codecs/package/src/preview.js'
import { createNamespaceInput } from '../../../test/support/namespace-input.js'

const encoder = new TextEncoder()
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 8_388_608,
  maxDiagnostics: 1_000,
}

function grid(magic: 'HMAP' | 'PATH', values: readonly number[]) {
  const stride = magic === 'HMAP' ? 6 : 2
  const bytes = new Uint8Array(32 + values.length * stride)
  bytes.set(encoder.encode(magic))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, magic === 'HMAP' ? 101 : 1, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  for (const [index, value] of values.entries()) {
    view.setUint16(32 + index * stride, value, true)
    if (magic === 'HMAP') {
      view.setUint16(34 + index * stride, 10 + index, true)
      view.setUint16(36 + index * stride, 1, true)
    }
  }
  return bytes
}

function pngData(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const data: Uint8Array[] = []
  while (offset < bytes.byteLength) {
    const size = view.getUint32(offset, false)
    const type = new TextDecoder('ascii').decode(bytes.subarray(offset + 4, offset + 8))
    const body = bytes.slice(offset + 8, offset + 8 + size)
    if (type === 'IHDR') {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength)
      width = header.getUint32(0, false)
      height = header.getUint32(4, false)
      bitDepth = body[8] ?? 0
      colorType = body[9] ?? 0
    } else if (type === 'IDAT') data.push(body)
    offset += 12 + size
  }
  const compressed = new Uint8Array(data.reduce((total, part) => total + part.byteLength, 0))
  let dataOffset = 0
  for (const part of data) {
    compressed.set(part, dataOffset)
    dataOffset += part.byteLength
  }
  return { width, height, bitDepth, colorType, scanlines: new Uint8Array(inflateSync(compressed)) }
}

describe('legacy SC2 map 2D preview parity', () => {
  it('pins the exact legacy user-visible renderer sources', () => {
    expect(SC2_MAP_PREVIEW_PROVENANCE).toEqual({
      legacyCommit: '1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
      legacyDispatch: 'extensions/blizzard/starcraft-2/codecs/sc2-map/src/codec.ts',
      legacyRasterizer: 'extensions/blizzard/starcraft-2/codecs/sc2-map/src/image/map-image.ts',
      legacyPng: 'extensions/blizzard/starcraft-2/codecs/sc2-map/src/image/png.ts',
    })
  })

  it('renders HMAP base heights as a deterministic north-up 16-bit grayscale PNG', () => {
    const first = renderSc2HeightPreview(grid('HMAP', [100, 101, 102, 103]), budget)
    const second = renderSc2HeightPreview(grid('HMAP', [100, 101, 102, 103]), budget)
    expect(second).toEqual(first)
    expect(pngData(first)).toEqual({
      width: 2,
      height: 2,
      bitDepth: 16,
      colorType: 0,
      scanlines: new Uint8Array([0, 0, 102, 0, 103, 0, 0, 100, 0, 101]),
    })
  })

  it('renders PATH values with the legacy colors and refuses malformed or over-budget grids', () => {
    const rendered = renderSc2PathingPreview(grid('PATH', [0x00, 0x02, 0x23, 0x77]), budget)
    expect(pngData(rendered)).toEqual({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 2,
      scanlines: new Uint8Array([0, 45, 49, 57, 177, 82, 178, 0, 42, 154, 99, 230, 181, 70]),
    })
    expect(() => renderSc2HeightPreview(new Uint8Array(10), budget)).toThrow(/truncated/u)
    expect(() =>
      renderSc2PathingPreview(grid('PATH', [0, 0, 0, 0]), { ...budget, maxNodes: 3 }),
    ).toThrow(/budget/u)
  })

  it('exposes thumbnail and render through a normal namespace codec session', async () => {
    const documents = new Map([
      ['t3HeightMap', grid('HMAP', [100, 101, 102, 103])],
      ['t3SyncPathingInfo', grid('PATH', [0x00, 0x02, 0x23, 0x77])],
      ['MapInfo', encoder.encode('<MapInfo/>')],
      ['Objects', encoder.encode('<PlacedObjects/>')],
      ['Regions', encoder.encode('<Regions/>')],
    ])
    const input = createNamespaceInput(Object.fromEntries(documents), {
      revision: 'content-hash.sha256:sc2-map-preview-parity',
      uri: 'memory://sc2/Preview.SC2Map',
    })
    const session = await (await createCodec()).open(input as never, 'full', budget)
    try {
      const descriptor = await session.descriptor()
      expect(descriptor.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'view.thumbnail', handlerId: 'thumbnail' }),
          expect.objectContaining({ id: 'view.render', handlerId: 'render-preview' }),
        ]),
      )
      expect(descriptor.constraints.unsupportedFeatures).not.toContain(
        'terrain-and-minimap-rendering',
      )

      const height = await session.operations().invoke('thumbnail', {})
      expect(height.state).toBe('ok')
      if (height.state !== 'ok' || height.output.kind !== 'bytes') {
        throw new Error('thumbnail did not return bytes')
      }
      expect(pngData(height.output.value)).toMatchObject({ width: 2, height: 2, bitDepth: 16 })

      const pathing = await session.operations().invoke('render-preview', { layer: 'pathing' })
      expect(pathing.state).toBe('ok')
      if (pathing.state !== 'ok' || pathing.output.kind !== 'bytes') {
        throw new Error('render-preview did not return bytes')
      }
      expect(pngData(pathing.output.value)).toMatchObject({ width: 2, height: 2, colorType: 2 })
    } finally {
      await session.dispose()
    }
  })

  it('renders the height sum layer and publishes the map facts group', async () => {
    const documents = new Map([
      ['t3HeightMap', grid('HMAP', [100, 101, 102, 103])],
      ['MapInfo', encoder.encode('<MapInfo/>')],
      ['Objects', encoder.encode('<PlacedObjects><ObjectPoint Id="1" Position="1,1,0" Type="StartLoc"/><ObjectPoint Id="2" Position="1,0,0" Type="StartLoc"/></PlacedObjects>')],
      ['Regions', encoder.encode('<Regions/>')],
    ])
    const input = createNamespaceInput(Object.fromEntries(documents), {
      revision: 'content-hash.sha256:sc2-map-sum',
      uri: 'memory://sc2/Sum.SC2Map',
    })
    const session = await (await createCodec()).open(input as never, 'full', budget)
    try {
      const render = async (request: Record<string, unknown>) => {
        const result = await session.operations().invoke('render-preview', request as never)
        if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error('render-preview did not return bytes')
        return pngData(result.output.value).scanlines
      }
      // Base 100..103 plus adjustments 10..13, north-up (row 0 is the map's top row, cells 2 and 3).
      const sum = new Uint8Array([0, 0, 114, 0, 116, 0, 0, 110, 0, 112])
      expect(await render({ layer: 'height-sum' })).toEqual(sum)
      expect(await render({ layer: 'height', channel: 'sum' })).toEqual(sum)
      expect(await render({ layer: 'height' })).toEqual(new Uint8Array([0, 0, 102, 0, 103, 0, 0, 100, 0, 101]))
      const lease = await session.dataSource('common.view/subject-facts-source', 1)
      try {
        const facts = lease.value as never as {
          groups(page: unknown): Promise<{ items: readonly { id: string }[] }>
          facts(groupId: string, page: unknown): Promise<{ items: readonly { id: string; value: unknown }[] }>
        }
        expect((await facts.groups({ limit: 20 })).items.map(group => group.id)).toContain('map')
        expect((await facts.facts('map', { limit: 20 })).items).toEqual([expect.objectContaining({ id: 'startLocations', value: 2 })])
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('renders the map overview and the per-document cliff level layers', async () => {
    const documents = new Map([
      ['t3HeightMap', grid('HMAP', [100, 101, 102, 103])],
      [
        't3Terrain.xml',
        encoder.encode(
          '<terrain><vertData quantizeBias="8" quantizeScale="0.5" standardHeight="6" name="t3HeightMap"/></terrain>',
        ),
      ],
      ['MapInfo', encoder.encode('<MapInfo/>')],
      ['Objects', encoder.encode('<PlacedObjects/>')],
      ['Regions', encoder.encode('<Regions/>')],
    ])
    const input = createNamespaceInput(Object.fromEntries(documents), {
      revision: 'content-hash.sha256:sc2-map-overview',
      uri: 'memory://sc2/Overview.SC2Map',
    })
    const session = await (await createCodec()).open(input as never, 'full', budget)
    try {
      const render = async (request: Record<string, unknown>) => {
        const result = await session.operations().invoke('render-preview', request as never)
        if (result.state !== 'ok' || result.output.kind !== 'bytes')
          throw new Error('render-preview did not return bytes')
        return pngData(result.output.value)
      }
      // 2x2 height vertices hold one terrain cell
      expect(await render({ layer: 'overview', pixelsPerCell: 4 })).toMatchObject({
        width: 4,
        height: 4,
        colorType: 2,
      })
      expect(
        await render({ layer: 'navigation', pixelsPerCell: 4, route: ['R1', 'R2'], layers: { edges: true } }),
      ).toMatchObject({ width: 4, height: 4, colorType: 2 })
      expect(await render({ layer: 'cliff-vertices' })).toMatchObject({
        width: 2,
        height: 2,
        colorType: 2,
      })
    } finally {
      await session.dispose()
    }
  })
})
