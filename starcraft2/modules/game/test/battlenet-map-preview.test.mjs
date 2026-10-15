import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePngSamples } from '@modkit/codec-kit/raster'
import { encodeDxt } from '@modkit/codec-kit/texture/bc'
import { composePublicationHeaderTree } from '../../../dist/modules/game/battlenet/publishing/header-composer.js'
import { encodeCacheHeader, reference } from '../../../dist/modules/game/battlenet/content-sources/cache-header.js'
import { readMapPreview } from '../../../dist/modules/game/battlenet/content-sources/map-preview.js'

/** A DXT5 DDS as the Arcade stores `.s2mv` visuals: 128-byte header, one surface, no mipmaps. */
function dds(width, height, colorAt) {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([...colorAt(x, y), 255], (y * width + x) * 4)
  const blocks = encodeDxt({ width, height, pixels }, 'dxt5')
  const header = new Uint8Array(128)
  const view = new DataView(header.buffer)
  header.set([0x44, 0x44, 0x53, 0x20])
  view.setUint32(4, 124, true); view.setUint32(8, 0x1007, true); view.setUint32(12, height, true); view.setUint32(16, width, true)
  view.setUint32(76, 32, true); view.setUint32(80, 4, true); header.set([0x44, 0x58, 0x54, 0x35], 84)
  return new Uint8Array([...header, ...blocks])
}

/** An uncompressed 32-bit TGA with a top-left origin, as the editor stores Arcade icons (BGRA pixels). */
function tga(width, height, [red, green, blue]) {
  const bytes = new Uint8Array(18 + width * height * 4)
  bytes.set([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 32, 0x28])
  for (let at = 18; at < bytes.length; at += 4) bytes.set([blue, green, red, 255], at)
  return bytes
}

const node = value => typeof value === 'number' ? { kind: 9, value: BigInt(value) } : value
const struct = fields => ({ kind: 5, value: new Map(fields.map(([tag, value]) => [BigInt(tag), node(value)])) })
/** `Attribute::ArtId`: visual file index, top, left, height, width. */
const art = values => struct(values.map((value, tag) => [tag, value]))

/**
 * A header whose working set names `visuals` (sha 'd…', 'e…', …), with `bigMap` and optionally an
 * Arcade info whose map icon is `icon` (both ArtId arrays).
 */
function depot({ bigMap, icon, visuals }) {
  const shas = visuals.map((_, index) => 'def'[index].repeat(64))
  const tree = composePublicationHeaderTree({ identity: { id: 140436, version: 131154 }, fileName: 'Direct Strike.SC2Map', region: 'eu',
    archiveSha256: 'a'.repeat(64), namespace: 1, locales: [{ locale: 'enUS', sha256: 'b'.repeat(64) }],
    previews: shas.map(sha256 => ({ sha256 })), workingSet: { bigMap } })
  if (icon) {
    const publication = tree.value.get(0n)
    publication.value.set(19n, { kind: 4, value: struct([[0, { kind: 0, value: [] }], [6, { kind: 4, value: art(icon) }]]) })
  }
  const header = encodeCacheHeader(tree)
  const reads = []
  const readComponent = async request => {
    if (request.handle === 'header') return header
    const bytes = Uint8Array.from(request.handle.match(/../g), pair => Number.parseInt(pair, 16))
    const index = shas.indexOf(reference(bytes)?.sha256)
    assert.ok(index >= 0, 'a visual file of the header')
    reads.push(index)
    return visuals[index]
  }
  return { reads, readComponent }
}

const read = (setup, maxSize) => readMapPreview(setup.readComponent,
  { region: 'eu', headerHandle: 'header', signal: new AbortController().signal, ...(maxSize ? { maxSize } : {}) })
const colorAt = async (preview, x, y) => {
  const png = await decodePngSamples(preview.png)
  return [...png.samples.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)]
}

test('the Arcade image of a map is its m_bigMap rectangle (index, top, left, height, width), as PNG', async () => {
  // Left half red, right half blue; the map covers 48 columns and 40 rows from column 16.
  const visual = dds(64, 40, x => x < 32 ? [220, 20, 20] : [20, 20, 220])
  const preview = await read(depot({ bigMap: [0, 0, 16, 40, 48], visuals: [visual] }))
  assert.deepEqual([preview.width, preview.height], [48, 40])
  const png = await decodePngSamples(preview.png)
  assert.deepEqual([png.width, png.height, png.channels], [48, 40, 4])
  assert.ok((await colorAt(preview, 4, 4))[0] > 180, 'columns 16..31 are red')
  assert.ok((await colorAt(preview, 44, 30))[2] > 180, 'columns 32..63 are blue')

  const small = await read(depot({ bigMap: [0, 0, 0, 40, 64], visuals: [visual] }), 32)
  assert.deepEqual([small.width, small.height], [32, 20], 'scaled to the longer side')
})

test("the map icon of the Arcade info comes first; the editor's placeholder is never shown", async () => {
  const placeholder = dds(24, 24, () => [1, 2, 3])
  const icon = dds(64, 48, () => [20, 200, 20])
  // Star Battle Reloaded: m_bigMap is the 24 × 24 placeholder, the icon a later visual file.
  const both = depot({ bigMap: [0, 0, 0, 24, 24], icon: [1, 0, 0, 48, 64], visuals: [placeholder, icon] })
  const preview = await read(both)
  assert.deepEqual([preview.width, preview.height], [64, 48])
  assert.ok((await colorAt(preview, 10, 10))[1] > 180, 'the green icon')
  assert.deepEqual(both.reads, [1], 'the placeholder is not even read')
})

test('an Arcade icon in TGA is decoded, as Star Battle Reloaded has it', async () => {
  const both = depot({ bigMap: [0, 0, 0, 24, 24], icon: [1, 0, 0, 150, 225], visuals: [dds(24, 24, () => [1, 2, 3]), tga(225, 150, [200, 30, 200])] })
  const preview = await read(both)
  assert.deepEqual([preview.width, preview.height], [225, 150])
  assert.deepEqual(await colorAt(preview, 100, 70), [200, 30, 200])
})

test('an icon that is not decoded falls back to the minimap; nothing usable gives no preview', async () => {
  const minimap = dds(64, 64, () => [220, 20, 20])
  const unknown = new Uint8Array(4096).fill(7)
  const fallback = depot({ bigMap: [0, 0, 0, 64, 64], icon: [1, 0, 0, 48, 64], visuals: [minimap, unknown] })
  assert.ok((await colorAt(await read(fallback), 5, 5))[0] > 180, 'the red minimap')
  assert.deepEqual(fallback.reads, [1, 0])

  const visual = dds(64, 64, () => [1, 2, 3])
  assert.equal(await read(depot({ bigMap: [0, 0, 0, 24, 24], visuals: [visual] })), null, "the editor's 24 × 24 placeholder")
  assert.equal(await read(depot({ bigMap: [1, 0, 0, 64, 64], visuals: [visual] })), null, 'index past the visual files')
  assert.equal(await read(depot({ bigMap: [0, 0, 0, 64, 64], visuals: [new Uint8Array(4096).fill(7)] })), null, 'an unknown format')
})
