import { describe, it, expect } from 'vitest'
import { readTextureMasks, writeTextureMasks, textureMaskWeight, setTextureMaskWindow } from '../shared/format/formats/texture-masks.js'
import { applyStarcraft2MapWorldEdits } from '../codecs/package/src/world-writer.js'
import { createCodec } from '../codecs/package/src/codec.js'
import { createNamespaceInput } from '../../../test/support/namespace-input.js'

/** Asymmetric native rows, two layers and untouched block/header/trailing data. */
function fixture() {
  return { version: 102, unk: 9, sizeX: 128, sizeY: 128, tilesX: 2, tilesY: 2,
    blocksPerLayer: 4, layers: 2, body: new Uint8Array(8 * 2048).fill(0xab),
    _raw: { zero: new Uint8Array(44).fill(7), trailing: Uint8Array.of(8, 9) } }
}
const budget = { maxInputBytes: 4_000_000n, maxDepth: 64, maxNodes: 100000,
  maxScalarBytes: 4_000_000, maxDiagnostics: 100 }

describe('native texture paint windows', () => {
  it('crosses both tile boundaries, preserves other nibbles and does not mutate input', () => {
    const source = fixture(), before = writeTextureMasks(source)
    const changed = setTextureMaskWindow(source, 0, { x: 63, y: 63, width: 3, height: 2, values: [1, 2, 3, 4, 5, 6] })
    const after = readTextureMasks(writeTextureMasks(changed))
    expect([63, 64, 65].map(x => textureMaskWeight(after, 0, x, 64))).toEqual([1, 2, 3])
    expect([63, 64, 65].map(x => textureMaskWeight(after, 0, x, 63))).toEqual([4, 5, 6])
    expect(textureMaskWeight(after, 0, 62, 64)).toBe(10)
    expect(textureMaskWeight(after, 0, 66, 63)).toBe(10)
    expect(after.body.slice(4 * 2048)).toEqual(source.body.slice(4 * 2048))
    expect(after._raw).toEqual(source._raw)
    expect(writeTextureMasks(source)).toEqual(before)
  })

  it('refuses invalid weights, windows, counts, budgets and cancellation without mutation', () => {
    const source = fixture(), before = writeTextureMasks(source)
    const window = { x: 0, y: 0, width: 1, height: 1, values: [15] }
    expect(() => setTextureMaskWindow(source, 2, window)).toThrow(/layer/)
    expect(() => setTextureMaskWindow(source, 0, { ...window, values: [16] })).toThrow(/weight/)
    expect(() => setTextureMaskWindow(source, 0, { ...window, x: 128 })).toThrow(/x/)
    expect(() => setTextureMaskWindow(source, 0, { ...window, values: [] })).toThrow(/count/)
    expect(() => setTextureMaskWindow(source, 0, { ...window, values: new Array(1) })).toThrow(/weight/)
    expect(() => setTextureMaskWindow(source, 0, { ...window, width: 2, values: [1, 2] }, { maxSamples: 1 })).toThrow(/budget/)
    expect(() => setTextureMaskWindow(source, 0, window, { signal: AbortSignal.abort() })).toThrow()
    expect(writeTextureMasks(source)).toEqual(before)
  })

  it('uses the common map layer descriptors/read/write, preserves south-first document API and rejects stale revisions', async () => {
    const source = fixture(), bytes = writeTextureMasks(source), utf8 = new TextEncoder()
    const session = await createCodec().open(createNamespaceInput({ MapInfo: utf8.encode('<MapInfo/>'),
      Objects: utf8.encode('<PlacedObjects/>'), Regions: utf8.encode('<Regions/>'), t3TextureMasks: bytes }) as never, 'full', budget)
    try {
      const listed = await session.operations().invoke('map-layers', {})
      expect(listed).toMatchObject({ state: 'ok', output: { value: { layers: [
        { id: 'texture-weight-0', meaning: 'texture-weight', maximum: 15, valueScale: 1 / 15 },
        { id: 'texture-weight-1', meaning: 'texture-weight' },
      ] } } })
      const written = await session.operations().invoke('map-layer-write', {
        layer: 'texture-weight-0', x: 63, y: 63, width: 3, height: 2, values: [1, 2, 3, 4, 5, 15],
      })
      if (written.state !== 'ok' || written.output.kind !== 'edit-plan') throw new Error('No texture plan')
      expect(written.output.plan.edits).toHaveLength(1)
      const payload = written.output.plan.edits[0]!.payload
      if (payload.kind !== 'inline') throw new Error('No native replacement')
      const next = await createCodec().open(createNamespaceInput({ MapInfo: utf8.encode('<MapInfo/>'),
        Objects: utf8.encode('<PlacedObjects/>'), Regions: utf8.encode('<Regions/>'), t3TextureMasks: payload.bytes }) as never, 'full', budget)
      try {
        expect(await next.operations().invoke('map-layer-read', { layer: 'texture-weight-0', x: 63, y: 63, width: 3, height: 2 }))
          .toMatchObject({ state: 'ok', output: { value: { values: [1, 2, 3, 4, 5, 15] } } })
      } finally { await next.dispose() }
      await expect(applyStarcraft2MapWorldEdits({ sourceRevision: 'a', expectedSourceRevision: 'b',
        documents: [{ path: 't3TextureMasks', bytes }], edits: [{ kind: 'grid.set', grid: 'texture-weight-0', width: 128, height: 128, values: [] }] }))
        .rejects.toThrow(/stale/)
    } finally { await session.dispose() }
  })
})
