/**
 * Warcraft III replay codec (`.w3g`): the recorded game as a tree, a player table and a JSON
 * export. The format lives in `format.ts`; this module owns the MK3 surface — budgets,
 * cancellation, the published facets.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import type { HostOperationHandler } from '@modkit/host'
import type { JsonValue, OperationDecl } from '@modkit/sdk'
import { createInspectionCodec, createTableDataSource, createTreeDataSource } from '@modkit/codec-kit'
import { loadInflateSync } from '@modkit/codec-kit/compression/inflate'
import {
  readW3gBlocks,
  isW3g,
  readW3gHeader,
  readW3gRecord,
  type W3gPlayer,
  type W3gReplay,
} from './format.js'
import { decodesActions } from './actions.js'

const ID = 'blizzard/war3-replay'

const operations: readonly OperationDecl[] = [
  {
    id: 'export.convert' as OperationDecl['id'],
    handlerId: 'export-convert',
    mutatesSource: false,
    requiredPermissions: ['read-source'],
    outputKinds: ['json'],
  },
]

const clock = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

const PLAYER_COLUMNS = [
  'id',
  'name',
  'team',
  'race',
  'color',
  'handicap',
  'computer',
  'commands',
  'APM',
  'left at',
] as const

function playerRow(player: W3gPlayer): string[] {
  const slot = player.slot
  return [
    String(player.id),
    player.name,
    slot === undefined ? '' : slot.team === 12 ? 'observer' : String(slot.team + 1),
    slot?.race ?? '',
    slot === undefined ? '' : String(slot.color),
    slot === undefined ? '' : String(slot.handicap),
    slot?.computer === true ? (slot.aiStrength ?? 'yes') : '',
    String(player.commands),
    player.actions === undefined ? '' : String(player.actions.apm),
    player.leftAtMs === undefined ? '' : clock(player.leftAtMs),
  ]
}

/** The replay as plain JSON: what `export.convert` returns. */
export function war3ReplayJson(replay: W3gReplay): JsonValue {
  const { header } = replay
  return {
    format: 'war3-replay',
    product: header.product,
    version: `1.${String(header.version)}`,
    build: header.build,
    multiplayer: header.multiplayer,
    durationMs: header.durationMs,
    recordedMs: replay.recordedMs,
    pausedMs: replay.pausedMs,
    gameName: replay.gameName,
    map: { ...replay.map },
    speed: replay.settings.speed ?? null,
    randomSeed: replay.randomSeed,
    players: replay.players.map(player => ({
      id: player.id,
      name: player.name,
      host: player.host,
      commands: player.commands,
      ...(player.slot === undefined
        ? {}
        : {
            team: player.slot.team,
            color: player.slot.color,
            race: player.slot.race ?? null,
            handicap: player.slot.handicap,
            computer: player.slot.computer,
          }),
      ...(player.leftAtMs === undefined
        ? {}
        : { leftAtMs: player.leftAtMs, leaveResult: player.leaveResult ?? null }),
      ...(player.actions === undefined
        ? {}
        : {
            apm: player.actions.apm,
            actions: { ...player.actions.kinds },
            buildOrder: player.actions.orders.map(order => ({ timeMs: order.timeMs, id: order.id })),
            ...(player.actions.undecodedBlocks === 0
              ? {}
              : {
                  undecoded: {
                    blocks: player.actions.undecodedBlocks,
                    bytes: player.actions.undecodedBytes,
                    actions: { ...player.actions.unknownActions },
                  },
                }),
          }),
    })),
    chat: replay.chat.map(line => ({
      timeMs: line.timeMs,
      playerId: line.playerId,
      scope: line.scope,
      ...(line.toSlot === undefined ? {} : { toSlot: line.toSlot }),
      text: line.text,
    })),
  }
}

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'war3-replay', label: 'Warcraft III replay' }),
  operations,
  async detect(prefix: Uint8Array) {
    return isW3g(prefix)
      ? { confidence: 0.99, kind: 'magic', note: 'w3g-signature' }
      : { confidence: 0, kind: 'magic', note: 'w3g-signature-missing' }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    context.signal?.throwIfAborted()
    const header = readW3gHeader(bytes)
    const inflate = await loadInflateSync('zlib-flushed')
    const record = readW3gBlocks(bytes, header, inflate, context.budget.maxScalarBytes, context.signal)
    const replay = readW3gRecord(header, record, context.signal)
    if (replay.players.length + replay.chat.length > context.budget.maxNodes)
      throw new RangeError('Warcraft III replay exceeds maxNodes budget')
    const version = `1.${String(header.version)}`
    const players = replay.players
    return {
      summary: {
        format: 'war3-replay',
        product: header.product,
        version,
        build: header.build,
        duration: clock(header.durationMs),
        map: replay.map.path,
        players: players.length,
        chat: replay.chat.length,
      },
      metadata: [
        {
          id: 'war3-replay',
          label: 'Warcraft III replay',
          entries: [
            { key: 'game', value: header.product === 'W3XP' ? 'The Frozen Throne' : 'Reign of Chaos' },
            { key: 'version', value: `${version} (build ${String(header.build)})` },
            { key: 'duration', value: clock(header.durationMs) },
            { key: 'gameName', value: replay.gameName },
            { key: 'map', value: replay.map.path },
            { key: 'players', value: players.length },
            { key: 'chat', value: replay.chat.length },
          ],
        },
      ],
      traits: [{ id: 'content.binary', parameters: { bytes: String(bytes.byteLength) } }],
      handlers: {
        'export-convert': (async () => ({
          kind: 'json',
          value: war3ReplayJson(replay),
        })) satisfies HostOperationHandler,
      },
      dataSources: {
        'common.view/table-data-source': createTableDataSource({
          header: [...PLAYER_COLUMNS],
          rows: players.map(playerRow),
        }),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'replay',
          label: replay.gameName || 'Warcraft III replay',
          preview: `${version}, ${clock(header.durationMs)}, ${replay.map.path}`,
          children: [
            {
              kind: 'map',
              label: 'Map',
              preview: replay.map.path,
              children: [
                { kind: 'value', label: 'Creator', preview: replay.map.creator },
                { kind: 'value', label: 'Checksum', preview: replay.map.checksum.toString(16) },
              ],
            },
            {
              kind: 'players',
              label: 'Players',
              preview: String(players.length),
              children: players.map(player => ({
                kind: 'player',
                label: player.name,
                preview: playerRow(player).slice(2).filter(Boolean).join(', '),
              })),
            },
            {
              kind: 'chat',
              label: 'Chat',
              preview: String(replay.chat.length),
              children: () =>
                replay.chat.map(line => ({
                  kind: 'message',
                  label: `${clock(line.timeMs)} ${players.find(player => player.id === line.playerId)?.name ?? String(line.playerId)}`,
                  preview: line.text,
                })),
            },
          ],
        }),
      },
      // Actions are decoded from patch 1.15, the sizes the format description lists; older
      // replays have their command blocks counted only.
      unsupportedFeatures: decodesActions(header.version) ? [] : ['action-decoding-before-1.15'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
