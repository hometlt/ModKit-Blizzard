import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
  registerServiceDefinitionsOrThrow,
} from '@modkit/host'
import { loadExtensionDirectory, openFileArtifactSource } from '@modkit/host/node'
import type { TransportSource, WorldSceneSource } from '@modkit/sdk'
import { buildReplayTimeline } from '../modules/replay/services/timeline/index.js'
import { projectReplayPlayback } from '../modules/replay/services/timeline/playback.js'

const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxScalarBytes: 8_388_608,
  maxDiagnostics: 100,
  deadlineMs: 30_000,
}

async function openFixture(name: string) {
  const roots = [
    join(import.meta.dirname, '..', '..', 'blizzard-common-formats'),
    join(import.meta.dirname, '..', '..', 'mpq'),
    join(import.meta.dirname, '..'),
  ]
  const extensions = await Promise.all(
    roots.map(async root => ({
      ...(await loadExtensionDirectory(root)),
      execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
    })),
  )
  const inventory = await buildInventory(extensions, createHostContributionContractRegistry())
  const serviceDefinitions = createBundledServiceDefinitionRegistry()
  await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
  const executionBackends = createExecutionBackendRegistry([
    {
      profile: 'trusted-in-process',
      supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
      async activate(context) {
        return {
          module: (await import(context.entrypoint.href)) as Record<string, unknown>,
          release: async () => undefined,
        }
      },
    },
  ])
  const target = {
    environment: 'node' as const,
    operatingSystem: 'windows' as const,
    architecture: 'x64' as const,
  }
  const path = join(import.meta.dirname, 'fixtures', 'replays', name)
  const opened = await openSubject({
    inventory,
    serviceDefinitions,
    executionBackends,
    target,
    source: await openFileArtifactSource(path),
    path,
    intent: 'full',
    grant: { id: `sc2-replay-playback-${name}`, classes: ['read-source'] },
    budget,
  })
  if (opened.state !== 'opened') throw new Error(`${name} did not open: ${opened.reason}`)
  expect(opened.selected.contributionId).toBe('blizzard/sc2-replay')
  return opened.session
}

const tag = (index: number) => index * 2 ** 18 + 1
const born = (gameloop: number, index: number, player: number, name: string) => ({
  gameloop,
  eventid: 1,
  event: 'UnitBorn',
  unitTagIndex: index,
  unitTagRecycle: 1,
  unitTag: tag(index),
  unitTypeName: name,
  controlPlayerId: player,
  upkeepPlayerId: player,
  x: index,
  y: index,
})
const stats = (gameloop: number, playerId: number, army: number) => ({
  gameloop,
  eventid: 0,
  event: 'PlayerStats',
  playerId,
  stats: { mineralsUsedCurrentArmy: army, vespeneUsedCurrentArmy: 10 },
})

describe('replay playback timeline projection', () => {
  it('projects participants, alive-unit and army series and ordered markers', () => {
    const timeline = buildReplayTimeline([
      { gameloop: 0, eventid: 9, event: 'PlayerSetup', playerId: 1, type: 1, userId: 0, slotId: 0 },
      { gameloop: 0, eventid: 9, event: 'PlayerSetup', playerId: 2, type: 1, userId: 1, slotId: 1 },
      born(0, 1, 1, 'SCV'),
      born(0, 2, 0, 'MineralField'),
      born(100, 3, 2, 'Zergling'),
      born(110, 4, 2, 'Larva'),
      {
        gameloop: 150,
        eventid: 5,
        event: 'Upgrade',
        playerId: 1,
        upgradeTypeName: 'Stimpack',
        count: 1,
      },
      stats(160, 1, 0),
      stats(160, 2, 50),
      {
        gameloop: 200,
        eventid: 2,
        event: 'UnitDied',
        unitTagIndex: 3,
        unitTagRecycle: 1,
        unitTag: tag(3),
        x: 0,
        y: 0,
      },
      stats(320, 2, 0),
    ])
    const result = projectReplayPlayback(
      {
        timeline,
        players: [
          {
            name: 'Beta',
            race: 'Zerg',
            color: { r: 0, g: 66, b: 255 },
            result: 2,
            workingSetSlotId: 1,
          },
          {
            name: 'Alpha',
            race: 'Terran',
            color: { r: 180, g: 20, b: 30 },
            result: 1,
            workingSetSlotId: 0,
          },
        ],
        apm: [120, 80],
      },
      { maxMarkers: 100, maxSeriesPoints: 100 },
    )
    expect(result.fidelity).toBe('sampled')
    expect(result.complete).toBe(true)
    expect(result.participants).toEqual([
      {
        id: '2',
        label: 'Beta',
        color: '#0042ff',
        group: 'Zerg',
        outcome: 'loss',
        facts: [{ id: 'apm', label: 'APM', value: '120' }],
      },
      {
        id: '1',
        label: 'Alpha',
        color: '#b4141e',
        group: 'Terran',
        outcome: 'win',
        facts: [{ id: 'apm', label: 'APM', value: '80' }],
      },
    ])
    // Neutral minerals, the loop-0 layout and larva are not events.
    expect(result.markers).toEqual([
      { positionMs: 4464, kind: 'unit-born', label: 'Zergling', participantId: '2' },
      { positionMs: 6696, kind: 'upgrade', label: 'Stimpack', participantId: '1' },
      { positionMs: 8929, kind: 'unit-died', label: 'Zergling', participantId: '2' },
    ])
    const series = (metric: string, participantId: string) =>
      result.series.find(item => item.metric === metric && item.participantId === participantId)
        ?.points
    expect(series('units', '2')).toEqual([7143, 2, 14286, 1])
    expect(series('army-value', '2')).toEqual([7143, 60, 14286, 10])
    expect(series('units', '1')).toEqual([7143, 1])

    const bounded = projectReplayPlayback({ timeline }, { maxMarkers: 1, maxSeriesPoints: 1 })
    expect(bounded.complete).toBe(false)
    expect(bounded.markers).toHaveLength(1)
    expect(bounded.series.every(item => item.points.length <= 2)).toBe(true)
    expect(() =>
      projectReplayPlayback({ timeline }, { maxMarkers: -1, maxSeriesPoints: 1 }),
    ).toThrow(RangeError)
  })

  // Parity plan 6.18: the map's title names the timeline; chat lines are markers of their speaker.
  it('titles the timeline with the map and marks chat by its speaker', () => {
    const timeline = buildReplayTimeline([
      { gameloop: 0, eventid: 9, event: 'PlayerSetup', playerId: 1, type: 1, userId: 0, slotId: 0 },
      { gameloop: 0, eventid: 9, event: 'PlayerSetup', playerId: 2, type: 1, userId: 1, slotId: 1 },
    ])
    const player = (name: string, workingSetSlotId: number) => ({
      name,
      race: 'Terran',
      color: { r: 0, g: 0, b: 0 },
      result: 0,
      workingSetSlotId,
    })
    const result = projectReplayPlayback(
      {
        timeline,
        players: [player('Beta', 1), player('Alpha', 0)],
        title: 'Ruins of Tarsonis',
        chat: [
          { gameloop: 224, userId: 1, message: 'gl hf' },
          { gameloop: 112, userId: 0, message: 'hi' },
          { gameloop: 336, userId: 7, message: 'observer here' },
        ],
      },
      { maxMarkers: 100, maxSeriesPoints: 100 },
    )
    expect(result.label).toBe('Ruins of Tarsonis')
    expect(result.markers).toEqual([
      { positionMs: 5000, kind: 'chat', label: 'hi', participantId: '2' },
      { positionMs: 10000, kind: 'chat', label: 'gl hf', participantId: '1' },
      { positionMs: 15000, kind: 'chat', label: 'observer here' },
    ])
    expect(projectReplayPlayback({ timeline }, { maxMarkers: 1, maxSeriesPoints: 1 }).label).toBeUndefined()
  })
})

describe.sequential('replay playback markers over the bound', () => {
  // A player's 2000-marker bound thins unit events over the whole game and keeps every chat line.
  it('keeps the end of a long game and every chat line', async () => {
    const markersOf = async (name: string, maxMarkers: number) => {
      const session = await openFixture(name)
      try {
        const lease = await session.dataSource('common.view/transport-source', 1)
        try {
          const transport = lease.value as TransportSource
          const timeline = await transport.timeline!({ maxMarkers, maxSeriesPoints: 50 })
          return { timeline, durationMs: Number((await transport.snapshot()).durationMs) }
        } finally {
          await lease.release()
        }
      } finally {
        await session.dispose()
      }
    }
    const ffa = await markersOf('Lost-on-the-Horizon-FFA.SC2Replay', 2_000)
    expect(ffa.timeline.complete).toBe(false)
    expect(ffa.timeline.markers).toHaveLength(2_000)
    expect(ffa.timeline.markers.at(-1)!.positionMs).toBeGreaterThan(ffa.durationMs * 0.9)
    const gresvan = await markersOf('Gresvan-LE.SC2Replay', 10)
    expect(gresvan.timeline.markers.filter(item => item.kind === 'chat').map(item => item.label)).toContain('gl hf')
    expect(gresvan.timeline.markers.filter(item => item.kind === 'chat')).toHaveLength(4)
  })
})

describe.sequential('replay playback through the codec', () => {
  for (const name of [
    'Tokamak-LE.SC2Replay',
    'Taito-Citadel-LE.SC2Replay',
    'Lost-on-the-Horizon-FFA.SC2Replay',
    'Gresvan-LE.SC2Replay',
  ]) {
    it(`${name} publishes a transport timeline and a world synced to the transport`, async () => {
      const session = await openFixture(name)
      try {
        const transportLease = await session.dataSource('common.view/transport-source', 1)
        const worldLease = await session.dataSource('common.view/world-scene-source', 1)
        try {
          const transport = transportLease.value as TransportSource
          const world = worldLease.value as WorldSceneSource
          const timeline = await transport.timeline!({ maxMarkers: 5_000, maxSeriesPoints: 500 })
          expect(timeline.fidelity).toBe('sampled')
          expect(timeline.participants.length).toBeGreaterThanOrEqual(2)
          for (const participant of timeline.participants) {
            expect(participant.label).not.toBe('')
            expect(participant.color).toMatch(/^#[0-9a-f]{6}$/u)
            // APM needs game events, which only builds with a bundled exact protocol decode.
            if (name === 'Tokamak-LE.SC2Replay' || name === 'Gresvan-LE.SC2Replay')
              expect(participant.facts).toContainEqual(
                expect.objectContaining({ id: 'apm', value: expect.stringMatching(/^\d+$/u) }),
              )
          }
          const ids = new Set(timeline.participants.map(item => item.id))
          const positions = timeline.markers.map(item => item.positionMs)
          expect(positions.length).toBeGreaterThan(0)
          expect(positions).toEqual([...positions].sort((left, right) => left - right))
          expect(timeline.markers.every(item => ids.has(item.participantId ?? ''))).toBe(true)
          expect(timeline.markers.some(item => item.kind === 'unit-died')).toBe(true)
          for (const participant of ids) {
            const units = timeline.series.find(
              item => item.metric === 'units' && item.participantId === participant,
            )
            expect(units?.points.length).toBeGreaterThan(2)
          }
          const end = Number((await transport.snapshot()).durationMs)
          expect(Math.max(...positions)).toBeLessThanOrEqual(end + 1)

          // Seek, then read the world as a remote consumer does: identity comes from info().
          const at = Math.floor(end / 2)
          expect((await session.operations().invoke('transport-seek', { positionMs: at })).state).toBe(
            'ok',
          )
          expect((await transport.snapshot()).positionMs).toBe(at)
          const info = await world.info()
          expect(info.snapshotId).toContain(`:loop:${Math.round((at * 22.4) / 1000)}`)
          await session.operations().invoke('transport-seek', { positionMs: end })
          await transport.snapshot()
          const page = await world.page({ facet: 'objects', layerId: 'replay-units', limit: 64 })
          // The page belongs to the frame info() pinned, not to the moved transport.
          expect(page.snapshotId).toBe(info.snapshotId)
          expect(page.items.length).toBeGreaterThan(0)
        } finally {
          await Promise.all([transportLease.release(), worldLease.release()])
        }
      } finally {
        await session.dispose()
      }
    }, 120_000)
  }
})
