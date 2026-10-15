/**
 * A replay opened the way the VS Code window and the CLI open it: every codec worker-brokered, so
 * whatever crosses into the protocol service and back goes through worker RPC. In process the
 * decoded events were views of the stream's buffer and passed; in a worker RPC refused them, and the
 * window showed Gresvan with no APM and no chat while the tests were green.
 */
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createModkit } from '@modkit/host/node'
import type { TransportSource } from '@modkit/sdk'

describe('replay through worker-brokered codecs', () => {
  it('decodes game and message events: APM and chat reach the timeline', async () => {
    const file = join(import.meta.dirname, 'fixtures', 'replays', 'Gresvan-LE.SC2Replay')
    const modkit = await createModkit({
      modules: [],
      extensions: [],
      userExtensions: [
        join(import.meta.dirname, '..', '..', 'blizzard-common-formats'),
        join(import.meta.dirname, '..', '..', 'mpq'),
        join(import.meta.dirname, '..'),
      ],
      roots: [dirname(file)],
      intent: 'full',
    } as never)
    try {
      const opened = await modkit.open(file)
      try {
        const descriptor = JSON.stringify(opened.snapshot)
        expect(descriptor).not.toContain('sc2-replay-protocol-unavailable')
        const lease = await opened.session!.dataSource('common.view/transport-source', 1)
        try {
          const timeline = await (lease.value as TransportSource).timeline!({ maxMarkers: 2_000, maxSeriesPoints: 50 })
          for (const participant of timeline.participants)
            expect(participant.facts).toContainEqual(expect.objectContaining({ id: 'apm', value: expect.stringMatching(/^\d+$/u) }))
          expect(timeline.markers.filter(item => item.kind === 'chat')).toHaveLength(4)
        } finally {
          await lease.release()
        }
      } finally {
        await opened.close()
      }
    } finally {
      await (modkit as { dispose?: () => Promise<void> }).dispose?.()
    }
  }, 300_000)
})
