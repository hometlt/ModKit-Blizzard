import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Codec, ContributionContext, TableDataSource } from '@modkit/sdk'
import { authoredReplay } from './war3-fixtures.js'
import { budget, context, extension, input, source } from './war3-harness.js'

/**
 * A Warcraft III replay written byte by byte from the format (`war3-fixtures.ts`), read by the codec,
 * which inflates its blocks through codec-kit.
 */
const { createCodec } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-replay', 'codec.js')).href
)) as { createCodec(context: ContributionContext): Codec }


async function openReplay(bytes: Uint8Array) {
  return createCodec(context).open(input(source(bytes)), 'inspect', budget)
}

describe('Warcraft III replays', () => {
  it('reads the game, its players, their commands and chat', async () => {
    const session = await openReplay(authoredReplay())
    try {
      const result = await session.operations().invoke('export-convert', null)
      if (result.state !== 'ok' || result.output.kind !== 'json')
        throw new Error(`export.convert failed: ${JSON.stringify(result)}`)
      expect(result.output.value).toMatchObject({
        product: 'W3XP',
        version: '1.24',
        build: 6059,
        multiplayer: true,
        durationMs: 1000,
        recordedMs: 1000,
        gameName: 'Test Game',
        map: { path: 'Maps\\Test.w3x', checksum: 0xdeadbeef, creator: 'Creator' },
        speed: 'fast',
        randomSeed: 42,
        players: [
          {
            id: 1,
            name: 'Host',
            host: true,
            commands: 1,
            team: 0,
            race: 'human',
            handicap: 100,
            // One counted action in the second the game lasted.
            apm: 60,
            actions: { ability: 1 },
            buildOrder: [{ timeMs: 250, id: 'hpea' }],
          },
          {
            id: 2,
            name: 'Guest',
            host: false,
            commands: 1,
            team: 1,
            race: 'undead',
            handicap: 90,
            leftAtMs: 1000,
            leaveResult: 9,
            apm: 60,
            actions: { selection: 2 },
            buildOrder: [],
          },
        ],
        chat: [{ timeMs: 250, playerId: 1, scope: 'all', text: 'gg' }],
      })
      const lease = await session.dataSource('common.view/table-data-source', 1)
      try {
        const table = lease.value as TableDataSource
        const page = await table.rows({ kind: 'range', from: 0, count: 10 })
        expect(page.items.map(row => row.cells.slice(0, 4))).toEqual([
          ['1', 'Host', '1', 'human'],
          ['2', 'Guest', '2', 'undead'],
        ])
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('refuses a recording with no game in it, and a file that is no replay', async () => {
    const empty = authoredReplay()
    // The header's record size and block count are zero: the recording was cut off.
    new DataView(empty.buffer).setUint32(0x28, 0, true)
    await expect(openReplay(empty)).rejects.toThrow(/no game record/u)
    await expect(openReplay(new TextEncoder().encode('not a replay'))).rejects.toThrow()
  })
})
