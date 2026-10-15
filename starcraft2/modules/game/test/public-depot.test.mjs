/**
 * The public depot path, proven without an account and without the network.
 *
 * A publication states where its header lives, the header states where its archive lives, and the
 * depot serves both by digest. Synthetic fixtures preserve the actual tagged header encoding
 * and bind every object to its SHA-256.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { createPublicDepotApi } from '../../../dist/modules/game/battlenet/content-sources/public-depot.js'
import { createDepotApi } from '../../../dist/modules/game/battlenet/desktop/desktop-backend.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ARCHIVE_SHA = hash(new Uint8Array([77, 80, 81, 26]))
const HEADER_SHA = hash(encodeHeader(handle('s2ma', 'US', ARCHIVE_SHA)))

/** A 40-byte cache handle: four bytes of type, four of region, thirty-two of digest. */
function handle(type, region, sha256) {
  const bytes = new Uint8Array(40)
  for (const [index, code] of [...type].entries()) bytes[index] = code.charCodeAt(0)
  for (const [index, code] of [...region].entries()) bytes[4 + index] = code.charCodeAt(0)
  for (let index = 0; index < 32; index += 1) {
    bytes[8 + index] = Number.parseInt(sha256.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * The header's own encoding: a struct (kind 5) whose field 0 is the identity struct, and whose
 * field 2 inside it is the archive handle. Written by hand so the test does not depend on a codec.
 */
function encodeHeader(archiveHandle, id = 1, version = 65536) {
  const parts = []
  const varint = value => {
    const out = []
    let rest = BigInt(value) << 1n
    do {
      const byte = Number(rest & 0x7fn)
      rest >>= 7n
      out.push(rest > 0n ? byte | 0x80 : byte)
    } while (rest > 0n)
    return Uint8Array.from(out)
  }
  const struct = fields => {
    const body = [varint(fields.length)]
    for (const [tag, value] of fields) {
      body.push(varint(tag), value)
    }
    return concat([Uint8Array.from([0x05]), ...body])
  }
  const blobValue = bytes => concat([Uint8Array.from([0x02]), varint(bytes.byteLength), bytes])
  const integer = value => concat([Uint8Array.from([0x09]), varint(value)])
  const identity = struct([
    [0, struct([[0, integer(id)], [1, integer(version)]])],
    [2, blobValue(archiveHandle)],
  ])
  parts.push(struct([[0, identity]]))
  return concat(parts)
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

const root = mkdtempSync(join(tmpdir(), 'sc2-depot-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const writeCache = (file, bytes) => {
  const directory = join(root, file.slice(0, 2), file.slice(2, 4))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, file), bytes)
}

describe('public Battle.net depot', () => {
  const request = (bytes, overrides = {}) => ({ region: 'us', signal: AbortSignal.timeout(5_000),
    publication: { id: 1, version: 65536, name: 'Example', isMod: true,
      headerHandle: hex(handle('s2mh', 'US', hash(bytes))), ...overrides } })

  it('the desktop backend uses the Node cache without any Python runtime', async () => {
    const header = encodeHeader(handle('s2ma', 'US', ARCHIVE_SHA))
    writeCache(`${hash(header)}.s2mh`, header)
    const api = createDepotApi({ researchDirectory: 'missing', pythonExecutable: 'missing',
      electronExecutable: 'missing', battleNetCacheDirectory: root })
    expect(await api.resolveArchive(request(header))).toEqual({ sha256: ARCHIVE_SHA, kind: 'mpq' })
  })

  it('rejects a forged digest and a correctly hashed header belonging to another revision', async () => {
    const header = encodeHeader(handle('s2ma', 'US', ARCHIVE_SHA))
    const api = createPublicDepotApi({ fetch: async () => new Response(header) })
    await expect(api.resolveArchive(request(header, {
      headerHandle: hex(handle('s2mh', 'US', 'c'.repeat(64))),
    }))).rejects.toThrow(/SHA-256/u)
    await expect(api.resolveArchive(request(header, { version: 65537 }))).rejects.toThrow(/identity/u)
  })

  it('does not follow a redirect outside the selected official depot', async () => {
    const requested = []
    const header = encodeHeader(handle('s2ma', 'US', ARCHIVE_SHA))
    const api = createPublicDepotApi({ fetch: async url => {
      requested.push(url)
      return new Response(null, { status: 302, headers: { location: 'https://example.org/payload' } })
    } })
    await expect(api.resolveArchive(request(header))).rejects.toThrow(/redirect/u)
    expect(requested).toHaveLength(1)
  })

  it('replaces a corrupt cache response with hash-verified depot bytes', async () => {
    const header = encodeHeader(handle('s2ma', 'US', ARCHIVE_SHA), 1, 65538)
    writeCache(`${hash(header)}.s2mh`, new Uint8Array([0]))
    let fetched = 0
    const api = createPublicDepotApi({ cacheDirectory: root,
      fetch: async () => { fetched++; return new Response(header) } })
    expect(await api.resolveArchive(request(header, { version: 65538 }))).toEqual({ sha256: ARCHIVE_SHA, kind: 'mpq' })
    expect(fetched).toBe(1)
  })

  it('resolves a publication to its archive from the local cache, with no account and no network', async () => {
    writeCache(`${HEADER_SHA}.s2mh`, encodeHeader(handle('s2ma', 'US', ARCHIVE_SHA)))
    writeCache(`${ARCHIVE_SHA}.s2ma`, new Uint8Array([77, 80, 81, 26]))

    const api = createPublicDepotApi({
      cacheDirectory: root,
      // Any network use at all would be a defect: the bytes are already on disk.
      fetch: () => {
        throw new Error('the depot must not be contacted when the cache answers')
      },
    })

    const archive = await api.resolveArchive({
      region: 'us',
      signal: AbortSignal.timeout(5_000),
      publication: {
        id: 1,
        version: 65536,
        name: 'Example',
        isMod: true,
        headerHandle: hex(handle('s2mh', 'US', HEADER_SHA)),
      },
    })
    expect(archive).toEqual({ sha256: ARCHIVE_SHA, kind: 'mpq' })

    const chunks = []
    for await (const chunk of api.downloadArchive({
      region: 'us',
      signal: AbortSignal.timeout(5_000),
      archive,
    })) {
      chunks.push(...chunk)
    }
    expect(chunks).toEqual([77, 80, 81, 26])
  })

  it('asks the depot of the region the handle names, not the one the caller assumed', async () => {
    const header = encodeHeader(handle('s2ma', 'SG', ARCHIVE_SHA), 2, 65536)
    const requested = []
    const api = createPublicDepotApi({
      fetch: async url => {
        requested.push(String(url))
        return new Response(String(url).endsWith('.s2mh') ? header : new Uint8Array([77, 80, 81, 26]), { status: 200 })
      },
    })

    const archive = await api.resolveArchive({
      region: 'us',
      signal: AbortSignal.timeout(5_000),
      publication: {
        id: 2,
        version: 65536,
        name: 'Regional',
        isMod: false,
        // Published in SG; a US depot would not serve it.
        headerHandle: hex(handle('s2mh', 'SG', hash(header))),
      },
    })
    expect(requested[0]).toBe(`https://sg-s2-depot.classic.blizzard.com/${hash(header)}.s2mh`)
    for await (const _ of api.downloadArchive({ region: 'us', archive, signal: AbortSignal.timeout(5_000) })) { /* consume */ }
    expect(requested[1]).toBe(`https://sg-s2-depot.classic.blizzard.com/${ARCHIVE_SHA}.s2ma`)
  })

  it('refuses a handle that does not address a map header', async () => {
    const api = createPublicDepotApi({ cacheDirectory: root })
    await expect(
      api.resolveArchive({
        region: 'us',
        signal: AbortSignal.timeout(5_000),
        publication: {
          id: 3,
          version: 0,
          name: 'Wrong',
          isMod: false,
          headerHandle: hex(handle('s2ma', 'US', HEADER_SHA)),
        },
      }),
    ).rejects.toThrow(/map header/u)
  })
})
