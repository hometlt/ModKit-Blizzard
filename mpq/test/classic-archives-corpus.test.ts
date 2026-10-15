/**
 * Classic MPQ archives of an installed Warcraft III (1.24e and earlier): every entry of the base
 * archives read through the MPQ reader. The installation comes from the Warcraft III extension's
 * own discovery — its manual root, the registry through host probes, platform defaults — never
 * from a path written here.
 *
 * The report groups what does not read yet by reason, so each decoder the archives need shows up
 * with how many entries wait on it. The base archives are read by range from their files, as a
 * content source reads them: the reader holds none of their bytes.
 */
import { existsSync } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNodeInstallationProbes } from '@modkit/host/node'
import { describe, expect, it } from 'vitest'
import { createCodec, openMpqReader } from '../src/mpq/codec.js'

/** The first discovered installation that has the classic archives; Reforged is a CASC product. */
async function classicRoot(): Promise<string | undefined> {
  if (process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1') return undefined
  const { discoverWarcraft3Installations } = (await import(
    pathToFileURL(join(import.meta.dirname, '..', '..', 'blizzard-warcraft-3', 'dist', 'game', 'installation.js')).href
  )) as typeof import('../../blizzard-warcraft-3/dist/game/installation.js')
  const discovery = await discoverWarcraft3Installations(
    { gameId: 'blizzard/warcraft-3', maxCandidates: 16 },
    createNodeInstallationProbes(),
  )
  return discovery.installations.find(installation =>
    installation.evidence.some(entry => entry.kind === 'warcraft3-classic-archive' && entry.found),
  )?.normalizedPath
}

const root = await classicRoot()

/** A byte range source over a file, counting what it reads; `close` when done. */
async function fileSource(path: string) {
  const handle = await open(path, 'r')
  const size = (await handle.stat()).size
  const counted = { bytes: 0, reads: 0, largest: 0 }
  return {
    counted,
    close: () => handle.close(),
    source: {
      async size() {
        return BigInt(size)
      },
      async read(offset: bigint, length: number) {
        const buffer = new Uint8Array(length)
        const { bytesRead } = await handle.read(buffer, 0, length, Number(offset))
        counted.bytes += bytesRead
        counted.reads += 1
        counted.largest = Math.max(counted.largest, bytesRead)
        return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
      },
    },
  }
}
const ARCHIVES = ['war3.mpq', 'War3x.mpq', 'War3Patch.mpq', 'War3xlocal.mpq']

describe.skipIf(root === undefined || !existsSync(join(root, 'war3.mpq')))(
  'installed Warcraft III classic archives',
  () => {
    it('reads the base archives entry by entry', { timeout: 600_000 }, async () => {
      const summary: Record<string, unknown> = {}
      for (const name of ARCHIVES) {
        const path = join(root!, name)
        if (!existsSync(path)) continue
        const file = await fileSource(path)
        const reader = await openMpqReader(file.source, {
          maxArchiveBytes: 268_435_456, maxEntries: 200_000, maxEntryBytes: 268_435_456,
        })
        const opening = { ...file.counted }
        try {
          const failures = new Map<string, { count: number; sample: string }>()
          let read = 0
          for (const entry of reader.entries) {
            try {
              await reader.read(entry.id)
              read += 1
            } catch (error) {
              const reason = (error instanceof Error ? error.message : String(error))
                .replace(/: .*$/u, '').replace(/ for .*$/u, '')
              const known = failures.get(reason)
              if (known === undefined) failures.set(reason, { count: 1, sample: entry.path })
              else known.count += 1
            }
          }
          expect(reader.retainedBytes).toBe(0)
          summary[name] = {
            opening,
            read: { bytes: file.counted.bytes, reads: file.counted.reads, largest: file.counted.largest },
            entries: reader.entries.length,
            named: reader.entries.filter(entry => !entry.path.startsWith('block/')).length,
            readEntries: read,
            failures: Object.fromEntries([...failures].sort((left, right) => right[1].count - left[1].count)),
          }
        } finally {
          reader.dispose()
          await file.close()
        }
      }
      console.log(JSON.stringify(summary, null, 1))
      expect(Object.keys(summary)).toContain('war3.mpq')
    })

    it('finds War3Patch.mpq entries by path, with no listfile to name them', { timeout: 120_000 }, async () => {
      const file = await fileSource(join(root!, 'War3Patch.mpq'))
      const reader = await openMpqReader(file.source, {
        maxArchiveBytes: 268_435_456, maxEntries: 200_000, maxEntryBytes: 268_435_456,
      })
      try {
        const script = new TextDecoder().decode(await reader.read('Scripts/common.j'))
        console.log(`War3Patch.mpq Scripts/common.j: ${script.length} characters`)
        expect(script).toContain('native')
        expect(reader.find('Scripts\\common.j')).toMatchObject({ path: 'Scripts/common.j' })
      } finally {
        reader.dispose()
        await file.close()
      }
    })

    it('decodes unit sounds stored as ADPCM under Huffman (mask 0x41) into continuous 16-bit PCM', { timeout: 300_000 }, async () => {
      const file = await fileSource(join(root!, 'war3.mpq'))
      const reader = await openMpqReader(file.source, {
        maxArchiveBytes: 268_435_456, maxEntries: 200_000, maxEntryBytes: 268_435_456,
      })
      try {
        const sounds = reader.entries.filter(entry => /^Units\/Human\/Footman\/[^/]+\.wav$/iu.test(entry.path))
        expect(sounds.length).toBeGreaterThan(3)
        let deltas = 0
        let deltaCount = 0
        let jumps = 0
        let jumpCount = 0
        let clipped = 0
        let total = 0
        for (const entry of sounds) {
          const bytes = await reader.read(entry.id)
          expect(bytes.byteLength).toBe(entry.size)
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
          expect([tag(0), tag(8)]).toEqual(['RIFF', 'WAVE'])
          let data: { start: number; end: number } | undefined
          for (let at = 12; at + 8 <= bytes.byteLength;) {
            const size = view.getUint32(at + 4, true)
            if (tag(at) === 'fmt ') expect([view.getUint16(at + 8, true), view.getUint16(at + 22, true)]).toEqual([1, 16])
            if (tag(at) === 'data') data = { start: at + 8, end: Math.min(at + 8 + size, bytes.byteLength) }
            at += 8 + size + (size & 1)
          }
          const sample = (index: number) => view.getInt16(data!.start + index * 2, true)
          const count = Math.floor((data!.end - data!.start) / 2)
          for (let index = 0; index < count; index += 1) {
            if (Math.abs(sample(index)) >= 32767) clipped += 1
            if (index > 0) {
              deltas += Math.abs(sample(index) - sample(index - 1))
              deltaCount += 1
            }
          }
          total += count
          // Every 4 KiB sector restarts the decoder from a sample written raw: a wrong decoder
          // drifts inside the sector and jumps where the next one starts.
          for (let offset = 4096; offset < data!.end; offset += 4096) {
            const index = (offset - data!.start) / 2
            if (!Number.isInteger(index) || index <= 0 || index >= count) continue
            jumps += Math.abs(sample(index) - sample(index - 1))
            jumpCount += 1
          }
        }
        const meanDelta = deltas / deltaCount
        const meanJump = jumps / jumpCount
        console.log(`Footman sounds: ${sounds.length}, samples ${total}, mean step ${meanDelta.toFixed(0)}, mean step at sector starts ${meanJump.toFixed(0)} (${jumpCount}), clipped ${clipped}`)
        expect(jumpCount).toBeGreaterThan(20)
        expect(meanJump).toBeLessThan(meanDelta * 3)
        expect(clipped / total).toBeLessThan(0.001)
      } finally {
        reader.dispose()
        await file.close()
      }
    })

    it('opens war3.mpq through the codec by range and extracts a sound from the host entry table', { timeout: 300_000 }, async () => {
      const path = join(root!, 'war3.mpq')
      const file = await fileSource(path)
      const size = BigInt(await file.source.size())
      const revision = 'content-hash.sha256:war3-mpq'
      const source = {
        kind: 'bytes' as const,
        ref: { id: path, uri: `file:///${path.replaceAll('\\', '/')}` },
        revision,
        size,
        read: (offset: bigint, length: number) => file.source.read(offset, length),
        async *stream() {
          throw new Error('a range codec never streams the whole archive')
        },
      }
      const input = {
        originKind: 'single' as const,
        bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: source.ref, revision }],
        primaryBindingId: 'content',
        revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: path },
        bindingsFor: () => [],
        async openBinding() {
          return { value: source, release: async () => undefined }
        },
      }
      const budget = { maxInputBytes: 67_108_864n, maxDepth: 64, maxNodes: 200_000, maxScalarBytes: 67_108_864, maxDiagnostics: 100 }
      const session = await (await createCodec()).open(input as never, 'full', budget as never)
      try {
        const opened = { ...file.counted }
        const lease = await session.dataSource('common.view/namespace-entry-source', 1)
        let listed = 0
        try {
          const namespace = lease.value as unknown as {
            list(prefix: string, page: { limit: number; cursor?: string }): Promise<{ items: unknown[]; nextCursor?: string }>
            lookup(path: string): Promise<{ id: string } | undefined>
          }
          let cursor: string | undefined
          do {
            const page = await namespace.list('', { limit: 5_000, ...(cursor === undefined ? {} : { cursor }) })
            listed += page.items.length
            cursor = page.nextCursor
          } while (cursor !== undefined)
          expect(await namespace.lookup('Units/Human/Footman/FootmanYes1.wav')).toMatchObject({ id: 'Units/Human/Footman/FootmanYes1.wav' })
        } finally {
          await lease.release()
        }
        const extracted = await session.operations().invoke('extract-entry', { entryId: 'Units/Human/Footman/FootmanYes1.wav' } as never)
        const bytes = extracted.state === 'ok' && extracted.output.kind === 'bytes' ? extracted.output.value : new Uint8Array()
        expect(String.fromCharCode(...bytes.subarray(0, 4), ...bytes.subarray(8, 12))).toBe('RIFFWAVE')
        await expect(session.operations().invoke('export-raw', {} as never)).rejects.toThrow(/budget of a whole-archive operation/u)
        console.log(`war3.mpq through the codec: ${listed} entries listed, opened with ${opened.reads} reads of ${opened.bytes} bytes (archive ${size} bytes)`)
        expect(listed).toBe(10_664)
        expect(opened.bytes).toBeLessThan(4 * 1024 * 1024)
      } finally {
        await session.dispose()
        await file.close()
      }
    })

    it('opens the installed maps behind their HM3W header', { timeout: 600_000 }, async () => {
      const maps = (await readdir(join(root!, 'Maps'), { recursive: true }))
        .filter(path => /\.w3[mx]$/iu.test(path))
      const opened: Record<string, unknown> = {}
      for (const path of maps) {
        const reader = await openMpqReader(await readFile(join(root!, 'Maps', path)), {
          maxArchiveBytes: 268_435_456, maxEntries: 100_000, maxEntryBytes: 67_108_864,
        })
        try {
          let read = 0
          for (const entry of reader.entries) {
            try {
              await reader.read(entry.id)
              read += 1
            } catch {
              // counted by what did read
            }
          }
          opened[path] = { entries: reader.entries.length, named: reader.entries.filter(entry => !entry.path.startsWith('block/')).length, read }
        } finally {
          reader.dispose()
        }
      }
      console.log(JSON.stringify(opened, null, 1))
      expect(Object.values(opened).every(item => (item as { entries: number }).entries > 0)).toBe(true)
    })
  },
)
