import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AVAILABLE_BUILDS,
  BitPackedBuffer,
  asNumber,
  asString,
  asStruct,
  decodeVersioned,
  createProvider,
  decodeEventStream,
  decodeReplayAttributes,
  decodeReplayHeaderPayload,
  decodeReplayLoadInfo,
  loadProtocol,
  resolveProtocolBuild,
} from '../blizzard-common-formats/modules/s2protocol/index.js'

const concat = (...parts) => Uint8Array.from(parts.flatMap(part => [...part]))
const vint = value => {
  let remaining = BigInt(value)
  const output = [Number((remaining & 0x3fn) << 1n)]
  remaining >>= 6n
  if (remaining !== 0n) output[0] |= 0x80
  while (remaining !== 0n) {
    const next = Number(remaining & 0x7fn)
    remaining >>= 7n
    output.push(next | (remaining === 0n ? 0 : 0x80))
  }
  return output
}
const integer = value => [9, ...vint(value)]
const blob = value => {
  const bytes = new TextEncoder().encode(value)
  return [2, ...vint(bytes.byteLength), ...bytes]
}
const struct = fields => [
  5,
  ...vint(fields.length),
  ...fields.flatMap(([tag, value]) => [...vint(tag), ...value]),
]

test('versioned decoder preserves scalar meaning and rejects truncated or excessive input', () => {
  const value = asStruct(decodeVersioned(new Uint8Array([5, 4, 0, 2, 4, 104, 105, 2, 9, 18])))
  assert.equal(asString(value[0]), 'hi')
  assert.equal(asNumber(value[1]), 9)
  assert.throws(() => decodeVersioned(new Uint8Array([2, 20, 1])), /truncated/u)
  assert.throws(
    () => decodeVersioned(new Uint8Array([2, 20, 1]), { maxScalarBytes: 5 }),
    /exceeds/u,
  )
})

test('replay header payload exposes exact build identity without a protocol table', () => {
  const version = struct([
    [0, integer(1)],
    [1, integer(5)],
    [2, integer(0)],
    [3, integer(12)],
    [4, integer(95299)],
    [5, integer(95299)],
  ])
  const bytes = concat(
    struct([
      [0, blob('StarCraft II replay')],
      [1, version],
      [2, integer(2)],
      [3, integer(12345)],
    ]),
  )
  const header = decodeReplayHeaderPayload(bytes)
  assert.equal(header.signature, 'StarCraft II replay')
  assert.equal(header.version.build, 95299)
  assert.equal(header.version.baseBuild, 95299)
  assert.equal(header.elapsedGameLoops, 12345)
})

test('replay attributes decode the nine-byte header and bounded records', () => {
  const bytes = new Uint8Array(9 + 2 * 13)
  const view = new DataView(bytes.buffer)
  bytes[0] = 1
  view.setUint32(1, 0x12345678, true)
  view.setUint32(5, 2, true)
  view.setUint32(9, 3, true)
  view.setUint32(13, 500, true)
  bytes[17] = 1
  bytes.set(new TextEncoder().encode('1v1\0'), 18)
  view.setUint32(22, 4, true)
  view.setUint32(26, 501, true)
  bytes[30] = 2
  bytes.set(new TextEncoder().encode('rrT\0'), 31)

  const decoded = decodeReplayAttributes(bytes)
  assert.equal(decoded.source, 1)
  assert.equal(decoded.mapNamespace, 0x12345678)
  assert.equal(decoded.declaredCount, 2)
  assert.deepEqual(decoded.attributes, [
    { namespace: 3, id: 500, scope: 1, value: '1v1' },
    { namespace: 4, id: 501, scope: 2, value: 'Trr' },
  ])
  assert.throws(() => decodeReplayAttributes(bytes, { maxNodes: 1 }), /exceed/u)
  assert.throws(() => decodeReplayAttributes(bytes.subarray(0, -1)), /truncated/u)
})

test('replay load info preserves words, slots and unknown trailing bytes', () => {
  const bytes = Uint8Array.from([1, 0, 0, 0, 2, 0, 0, 0, 7, 8])
  const decoded = decodeReplayLoadInfo(bytes)
  assert.deepEqual(decoded.values, [1, 2])
  assert.deepEqual(decoded.playerSlots, [
    { slot: 1, value: 1 },
    { slot: 2, value: 2 },
  ])
  assert.deepEqual([...decoded.trailingBytes], [7, 8])
  assert.equal(decoded.isEmpty, false)
  bytes[0] = 9
  assert.equal(decoded.raw[0], 1)
  assert.throws(() => decodeReplayLoadInfo(new Uint8Array(8), { maxScalarBytes: 4 }), /exceeds/u)
})

test('early replay attributes decode the eight-byte header', () => {
  const bytes = new Uint8Array(8 + 13)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x12345678, true)
  view.setUint32(4, 1, true)
  view.setUint32(8, 3, true)
  view.setUint32(12, 500, true)
  bytes[16] = 1
  bytes.set(new TextEncoder().encode('1v1\0'), 17)

  const decoded = decodeReplayAttributes(bytes, { baseBuild: 16_561 })
  assert.equal(decoded.source, undefined)
  assert.equal(decoded.mapNamespace, 0x12345678)
  assert.equal(decoded.declaredCount, 1)
  assert.deepEqual(decoded.attributes, [
    { namespace: 3, id: 500, scope: 1, value: '1v1' },
  ])
})

test('early event streams decode the implicit five-bit replay user id', () => {
  const protocol = {
    typeinfos: [['_int', [[0, 1]]], ['_int', [[0, 2]]], ['_null', []]],
    svaruint32Typeid: 0,
    replayUseridTypeid: null,
    gameEventidTypeid: 1,
    gameEventTypes: { 1: [2, 'NNet.Game.TestEvent'] },
    messageEventidTypeid: 1,
    messageEventTypes: { 1: [2, 'NNet.Game.TestMessage'] },
  }
  const bytes = new Uint8Array([0b0100_0110])

  for (const kind of ['game', 'message']) {
    const [event] = decodeEventStream(bytes, protocol, kind)
    assert.deepEqual(event._userid, { m_userId: 3 })
    assert.equal(event._eventid, 1)
  }
})

test('bitpacked decoder detects truncation and cancellation', () => {
  assert.throws(() => new BitPackedBuffer(new Uint8Array()).readBits(1), /truncated/u)
  assert.equal(new BitPackedBuffer(new Uint8Array(8).fill(0xff)).readBits(64), 0xffffffffffffffffn)
  const controller = new AbortController()
  controller.abort()
  assert.throws(
    () => decodeVersioned(new Uint8Array([9, 0]), { signal: controller.signal }),
    /abort/iu,
  )
})

test('protocol selection is exact by default and fallback is explicit and diagnosed', async () => {
  const exactBuild = AVAILABLE_BUILDS.at(-1)
  const exact = resolveProtocolBuild(exactBuild)
  assert.equal(exact.exact, true)
  assert.throws(() => resolveProtocolBuild(exactBuild + 1), /not bundled/u)
  const fallback = resolveProtocolBuild(exactBuild + 1, { fallback: 'nearest-lower' })
  assert.equal(fallback.selectedBuild, exactBuild)
  assert.equal(fallback.exact, false)
  assert.equal(fallback.diagnostics[0].code, 'blizzard/s2protocol-build-fallback')
  const loaded = await loadProtocol(exactBuild)
  assert.ok(loaded.protocol.typeinfos.length > 0)
})

test('provider exposes the shared contract without permissions or I/O', async () => {
  const lease = createProvider({ contract: 'common.blizzard/s2protocol', major: 1 })
  assert.equal(lease.value.contract, 'common.blizzard/s2protocol')
  assert.equal(lease.value.listBuilds().length, 92)
  await lease.release()
})

test('generated protocol tables are browser-safe and free of filesystem/network imports', async () => {
  const implementation = await Promise.all(
    ['index.js', 'versioned.js', 'bitpacked.js', 'streams.js'].map(name =>
      readFile(
        new URL(`../blizzard-common-formats/modules/s2protocol/${name}`, import.meta.url),
        'utf8',
      ),
    ),
  )
  assert.doesNotMatch(implementation.join('\n'), /from ['"](?:node:|fs|https?:)|process\./u)
})
