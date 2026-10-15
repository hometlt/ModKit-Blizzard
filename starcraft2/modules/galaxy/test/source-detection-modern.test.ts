import { describe, expect, it } from 'vitest'
import type { ArtifactByteSource } from '@modkit/sdk'
import {
  detectGalaxyBytes,
  detectGalaxySource,
  MAX_SNIFF_BYTES as GALAXY_SNIFF_BYTES,
} from '../services/source-detection.js'
import {
  detectTriggerBytes,
  detectTriggerSource,
} from '../../triggers/services/source-detection.js'

const encoder = new TextEncoder()

function source(
  bytes: Uint8Array,
  uri: string,
  read: ArtifactByteSource['read'] = async (offset, length, signal) => {
    signal?.throwIfAborted()
    return bytes.slice(Number(offset), Number(offset) + length)
  },
): ArtifactByteSource {
  return {
    kind: 'bytes',
    ref: { id: uri, uri } as never,
    revision: 'content-hash.sha256:source-detection-fixture' as never,
    size: BigInt(bytes.byteLength),
    read,
    async *stream() { yield bytes },
  }
}

describe('MK3 Galaxy and TriggerData source detection', () => {
  it('classifies bounded bytes without requiring a source implementation', () => {
    const galaxy = detectGalaxyBytes(encoder.encode('void Demo () {\n}\n'), {
      uri: 'memory://Scripts/Demo.galaxy',
    })
    expect(galaxy.codecId).toBe('blizzard/galaxy')
    expect(galaxy.confidence).toBeGreaterThan(0.5)
    expect(galaxy.requiredRanges[0]).toMatchObject({ byteOffset: '0' })

    const triggers = detectTriggerBytes(
      encoder.encode('<TriggerData><Library Id="A"><Root/></Library></TriggerData>'),
      { uri: 'archive://Test.SC2Mod/Triggers' },
    )
    expect(triggers.codecId).toBe('blizzard/sc2-triggers')
    expect(triggers.confidence).toBeGreaterThan(0.7)
  })

  it('lets negative content evidence defeat a matching extension', () => {
    const result = detectGalaxyBytes(encoder.encode('<TriggerData/>'), {
      uri: 'memory://Wrong.galaxy',
    })
    expect(result.confidence).toBe(0)
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'structure', weight: -1 }),
    ]))
  })

  it('bounds source reads to the detector prefix and handles short sources', async () => {
    const bytes = encoder.encode('int x;')
    const reads: Array<{ offset: bigint; length: number }> = []
    const input = source(bytes, 'memory://Short.galaxy', async (offset, length) => {
      reads.push({ offset, length })
      return bytes.slice(Number(offset), Number(offset) + length)
    })
    await detectGalaxySource(input)
    expect(reads).toEqual([{ offset: 0n, length: bytes.byteLength }])
    expect(reads[0]!.length).toBeLessThanOrEqual(GALAXY_SNIFF_BYTES)
  })

  it('honors cancellation before reading', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(detectTriggerSource(
      source(encoder.encode('<TriggerData/>'), 'memory://Triggers'),
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects a source that violates the requested range', async () => {
    const bytes = encoder.encode('<TriggerData/>')
    const input = source(bytes, 'memory://Triggers', async (_offset, length) =>
      new Uint8Array(length + 1),
    )
    await expect(detectTriggerSource(input)).rejects.toThrow(/beyond the requested probe range/u)
  })
})
