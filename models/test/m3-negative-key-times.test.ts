import { existsSync, readFileSync } from 'node:fs'

import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'

import { decodeM3Animations } from '../src/m3/animation.node.js'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'

installM3PlatformAdapters({ DOMParser })

const budget = {
  maxInputBytes: 10n ** 9n,
  maxDepth: 128,
  maxNodes: 4_000_000,
  maxScalarBytes: 2 * 10 ** 8,
  maxDiagnostics: 500,
}

/**
 * A real StarCraft II model whose residual tracks open before frame zero.
 *
 * Blizzard writes a key at -999 ms so a channel has a value through the whole run-up to a
 * sequence. A synthetic M3 would only prove the reader against itself; this proves it against the
 * convention the game's own files use.
 */
const installed =
  'C:/Apps/StarCraft II/Maps/all-races-coop-maps/21-LosingMemories.SC2Map/Assets'
const PYLON_DEATH = `${installed}/Buildings/Protoss/NerazimPylonDeath/NerazimPylonDeath.m3`

const describeInstalled = existsSync(PYLON_DEATH) ? describe : describe.skip

describeInstalled('M3 key times before frame zero', () => {
  it('projects a lead-in key instead of refusing the channel it belongs to', async () => {
    const decoded = (await decodeM3Animations(
      new Uint8Array(readFileSync(PYLON_DEATH)),
      budget,
    )) as {
      unsupportedChannels: number
      supportedChannels: number
      unsupportedChannelReasons: Record<string, number>
      residualAnimationTracks: readonly { frames: readonly number[] }[]
    }
    // Nine channels used to be refused outright, which stopped the whole model from exporting.
    expect(decoded.unsupportedChannels).toBe(0)
    expect(decoded.unsupportedChannelReasons).toEqual({})
    expect(decoded.supportedChannels).toBeGreaterThan(0)

    // And the negative time survives into the residual rather than being clamped away: a key at
    // -999 is what gives the channel a value before its sequence starts.
    const leadIn = decoded.residualAnimationTracks.filter(track =>
      track.frames.some(frame => frame < 0),
    )
    expect(leadIn.length).toBeGreaterThan(0)
    for (const track of leadIn) expect(Math.min(...track.frames)).toBe(-999)
  })
})
