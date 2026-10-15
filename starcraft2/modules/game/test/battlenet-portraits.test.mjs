import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePngSamples } from '@modkit/codec-kit/raster'
import { encodeDxt } from '@modkit/codec-kit/texture/bc'
import { createPortraitImages, KNOWN_PORTRAIT_TEXTURE_LISTS, objectStream } from '../../../dist/modules/game/battlenet/profiles/portraits.js'
import { createPublicDepotApi } from '../../../dist/modules/game/battlenet/content-sources/public-depot.js'

/** A DXT1 DDS as the portrait atlases (`.wafl`) are: 128-byte header, one surface. */
function dds(width, height, colorAt) {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([...colorAt(x, y), 255], (y * width + x) * 4)
  const blocks = encodeDxt({ width, height, pixels }, 'dxt1')
  const header = new Uint8Array(128)
  const view = new DataView(header.buffer)
  header.set([0x44, 0x44, 0x53, 0x20])
  view.setUint32(4, 124, true); view.setUint32(8, 0x1007, true); view.setUint32(12, height, true); view.setUint32(16, width, true)
  view.setUint32(76, 32, true); view.setUint32(80, 4, true); header.set([0x44, 0x58, 0x54, 0x31], 84)
  return new Uint8Array([...header, ...blocks])
}

const stream = (...objects) => new TextEncoder().encode(objects.map(object => JSON.stringify(object, null, 1)).join('\n'))
const handle = (type, region, fill) => Buffer.from(type + '\0\0' + region).toString('hex') + fill.repeat(64)
const PORT = 0x504F5254

/**
 * Three definition files (a skin catalog and two portrait catalogs, as the Welcome on EU names a
 * main one and a small one), a texture list of two 2 × 2 atlases and the atlases, whose quarters
 * are red, green, blue and white.
 */
function depot() {
  const skins = handle('unlk', 'EU', '1'), small = handle('unlk', 'EU', '2'), main = handle('unlk', 'EU', '3')
  const atlas = [handle('wafl', 'EU', '4'), handle('wafl', 'EU', '5')]
  const quarters = [[220, 20, 20], [20, 220, 20], [20, 20, 220], [230, 230, 230]]
  const files = new Map([
    [skins, stream({ m_programId: 21298, m_typeTag: 0x5a4c6172, m_unlockableCount: 1 }, { m_unlockableId: 7, m_imageHandle: { m_offset: 0, m_textureFileIndex: 0 } })],
    [small, stream({ m_programId: 21298, m_typeTag: PORT, m_unlockableCount: 1 },
      // Negative in the file: ids are 32-bit and written signed.
      { m_uiOrderHint: 2, m_imageHandle: { m_offset: 1, m_textureFileIndex: 1 }, m_unlockableId: -1343813580, m_flags: 1, m_name: { m_id: 2, m_fileIndex: 0 } })],
    [main, stream({ m_programId: 21298, m_typeTag: PORT, m_unlockableCount: 1 },
      { m_uiOrderHint: 1, m_imageHandle: { m_offset: 3, m_textureFileIndex: 0 }, m_unlockableId: 1076076546, m_flags: 1, m_name: { m_id: 1, m_fileIndex: 0 } })],
    [KNOWN_PORTRAIT_TEXTURE_LISTS[0], stream({ m_count: 2, m_usage: 0x6C647074 },
      { m_cacheHandle: atlas[0] }, { m_textureFileIndex: 0, m_textureCols: 2, m_textureRows: 2 },
      { m_cacheHandle: atlas[1] }, { m_textureFileIndex: 1, m_textureCols: 2, m_textureRows: 2 })],
    [atlas[0], dds(64, 64, (x, y) => quarters[(y < 32 ? 0 : 2) + (x < 32 ? 0 : 1)])],
    [atlas[1], dds(64, 64, (x, y) => quarters[3 - ((y < 32 ? 0 : 2) + (x < 32 ? 0 : 1))])],
  ])
  const reads = []
  return { files: [skins, small, main], reads, readComponent: async request => {
    reads.push(request.handle)
    const bytes = files.get(request.handle)
    if (!bytes) throw new Error('not on the depot')
    return bytes
  } }
}

const colorOf = async portrait => {
  const png = await decodePngSamples(portrait.png)
  const at = ((png.height >> 1) * png.width + (png.width >> 1)) * 4
  return [...png.samples.subarray(at, at + 3)]
}
const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < 24)

test('a portrait id is found in the merged PORT catalogs and cut from its atlas cell', async () => {
  const fake = depot()
  const images = createPortraitImages({ readComponent: fake.readComponent })
  const signal = new AbortController().signal
  const white = await images.image({ region: 'eu', portraitId: 1076076546, unlockableFiles: fake.files, signal })
  assert.deepEqual([white.id, white.width, white.height], [1076076546, 32, 32])
  assert.ok(near(await colorOf(white), [230, 230, 230]), 'cell 3 of a 2 × 2 grid is the bottom right quarter')
  const second = await images.image({ region: 'eu', portraitId: 2951153716, unlockableFiles: fake.files, signal, maxSize: 16 })
  assert.deepEqual([second.width, second.height], [16, 16], 'scaled to the longer side')
  assert.ok(near(await colorOf(second), [20, 20, 220]), 'cell 1 of the second atlas')
  assert.equal(await images.image({ region: 'eu', portraitId: 5, unlockableFiles: fake.files, signal }), null, 'not a portrait')

  const before = fake.reads.length
  await images.image({ region: 'eu', portraitId: 1076076546, unlockableFiles: fake.files, signal })
  assert.equal(fake.reads.length, before, 'kept images are not read again')
})

test('a texture list that does not cover the catalog is not used', async () => {
  const fake = depot()
  const short = stream({ m_count: 1, m_usage: 0x6C647074 }, { m_cacheHandle: handle('wafl', 'EU', '4') }, { m_textureFileIndex: 0, m_textureCols: 2, m_textureRows: 2 })
  const readComponent = request => request.handle === KNOWN_PORTRAIT_TEXTURE_LISTS[0] ? Promise.resolve(short) : fake.readComponent(request)
  const images = createPortraitImages({ readComponent })
  assert.equal(await images.image({ region: 'eu', portraitId: 1076076546, unlockableFiles: fake.files, signal: AbortSignal.timeout(5000) }), null)
})

test('an unreadable definition file is a failure, not a missing portrait', async () => {
  const fake = depot()
  let broken = true
  // The unreadable file is the small catalog: the portrait asked for is in the main one, which was read.
  const images = createPortraitImages({ readComponent: request => broken && request.handle === fake.files[1]
    ? Promise.reject(new Error('offline')) : fake.readComponent(request) })
  const request = { region: 'eu', portraitId: 1076076546, unlockableFiles: fake.files, signal: AbortSignal.timeout(5000) }
  await assert.rejects(images.image(request), /could not be read/)
  broken = false
  assert.equal((await images.image(request)).id, 1076076546, 'asked again after a failure')
})

test('object streams are the top-level JSON objects of a file', () => {
  assert.deepEqual(objectStream(new TextEncoder().encode('{"a":{"b":"}"}}\n{"c":1}')), [{ a: { b: '}' } }, { c: 1 }])
  assert.throws(() => objectStream(new TextEncoder().encode('{"a":1')), /Truncated/)
})

test('the depot reader accepts the files profiles name, not only map files', async () => {
  const sha = 'ab'.repeat(32)
  const asked = []
  const api = createPublicDepotApi({ fetch: async url => {
    asked.push(url)
    return new Response(new Uint8Array(0), { status: 404 })
  } })
  await assert.rejects(api.readComponent({ region: 'eu', handle: Buffer.from('wafl\0\0EU').toString('hex') + sha, signal: AbortSignal.timeout(5000) }), /refused/)
  assert.deepEqual(asked, [`https://eu-s2-depot.classic.blizzard.com/${sha}.wafl`])
})
