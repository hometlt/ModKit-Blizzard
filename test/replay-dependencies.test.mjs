import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeBlizzardCacheHandle } from '../blizzard-common-formats/modules/content-address/cache-handle.js'
import { replayDependencySet } from '../starcraft2/modules/replay/services/dependencies/cache-handles.js'

function handle(seed = 0, region = 'US') {
  const bytes = new Uint8Array(40)
  bytes.set(new TextEncoder().encode('s2ma'), 0)
  bytes.set(new TextEncoder().encode(region), 6)
  for (let index = 8; index < bytes.length; index += 1) bytes[index] = (seed + index) & 0xff
  return bytes
}

test('Blizzard cache handles preserve type, region and exact digest', () => {
  const decoded = decodeBlizzardCacheHandle(handle())
  assert.equal(decoded.type, 's2ma')
  assert.equal(decoded.region, 'US')
  assert.equal(decoded.sha256, '08090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021222324252627')
  assert.equal(decoded.file, `${decoded.sha256}.s2ma`)
  assert.equal(decodeBlizzardCacheHandle(new Uint8Array(39)), undefined)
})

test('Replay dependency extraction is bounded, ordered and diagnostic', () => {
  const duplicate = handle(1)
  const result = replayDependencySet({
    m_syncLobbyState: {
      m_gameDescription: {
        m_cacheHandles: [handle(), duplicate, duplicate, new Uint8Array(2)],
      },
    },
  })
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.dependencies.length, 2)
  assert.deepEqual(result.dependencies.map(item => item.order), [0, 1])
  assert.equal(result.complete, false)
  assert.equal(result.diagnostics[0].code, 'blizzard/sc2-replay-cache-handle-invalid')
  assert.throws(
    () => replayDependencySet({
      m_syncLobbyState: { m_gameDescription: { m_cacheHandles: Array(257).fill(handle()) } },
    }),
    /exceed/u,
  )
})

test('Replay dependency extraction reports unavailable initialization metadata', () => {
  const result = replayDependencySet({})
  assert.equal(result.complete, false)
  assert.deepEqual(result.dependencies, [])
  assert.equal(result.diagnostics[0].code, 'blizzard/sc2-replay-cache-handles-unavailable')
})
