import {
  TRANSPORT_OPERATIONS,
  createInspectionCodec,
  createTransportHandlers,
  createTransportSource,
  createTreeDataSource,
} from '@modkit/codec-kit'
import {
  createSc2NamespaceEntrySource,
  normalizeSc2NamespacePath,
  readSc2NamespaceEntry,
  walkSc2Namespace,
} from '../../../../shared/package-namespace/runtime.js'
import { createTableDataSource } from '../../../../shared/inspection/structured-text.js'
import {
  decodeReplayAttributes,
  decodeReplayDetails,
  decodeReplayHeaderPayload,
  decodeReplayLoadInfo,
  decodeTrackerEvents,
} from '@modkit/blizzard-common-formats/s2protocol'
import {
  ReplayScene,
  buildControlTimeline,
  buildReplayTimeline,
  hudStateAt,
  selectionAt,
  timelineToJson,
} from '../../services/timeline/index.js'
import { DATA_CATALOG_ENTITIES_INPUT, DATA_CATALOG_QUERIES_OUTPUT } from '@modkit/sdk/data'
import {
  analyzeReplay,
  chatLines,
  replayUnitTypes,
  REPLAY_LOOPS_PER_SECOND,
} from '../../services/analysis/index.js'
import { projectReplayPlayback } from '../../../../dist/modules/replay/services/timeline/playback.js'
import {
  loadReplayCatalogLookups,
  replayCatalogLookups as catalogFromEntities,
} from '../../services/analysis/catalog-enrichment.js'
import { normalizeSc2ReplayCommands } from '../../services/commands/normalize.js'
import { replayDependencySet } from '../../services/dependencies/cache-handles.js'
import {
  createReplaySemanticCommandResolver,
  loadReplayAbilityCatalog,
} from '../../services/commands/semantic-resolver.js'

const ID = 'blizzard/sc2-replay'
const KNOWN_STREAMS = new Map([
  ['replay.details', 'details'],
  ['replay.initdata', 'initialization'],
  ['replay.attributes.events', 'attributes'],
  ['replay.game.events', 'game-events'],
  ['replay.message.events', 'message-events'],
  ['replay.tracker.events', 'tracker-events'],
  ['replay.load.info', 'load-info'],
])

const streamRole = path => KNOWN_STREAMS.get(path.toLowerCase()) ?? ''

/**
 * Bytes that own their whole buffer. A stream read out of the archive is a view into a larger buffer,
 * and the protocol service in a worker refuses a partial view ("a Uint8Array must own its whole
 * buffer"); in process it took one, so in the VS Code window replays lost their game events and chat.
 * A copy, not `slice()`: a Node Buffer's `slice` is another view.
 */
const ownedBytes = bytes =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes)

async function withProtocolService(activation, signal, callback) {
  if (activation?.contracts === undefined) {
    throw new TypeError('s2protocol requires an activated contribution context')
  }
  const lease = await activation.contracts.resolve({
    contract: 'common.blizzard/s2protocol',
    major: 1,
    ...(signal === undefined ? {} : { signal }),
  })
  try {
    return await callback(lease.value)
  } finally {
    await lease.release()
  }
}

async function withResolvedDataService(activation, signal, callback) {
  if (activation?.contracts === undefined) {
    throw new TypeError('resolved-data enrichment requires an activated contribution context')
  }
  const lease = await activation.contracts.resolve({
    contract: 'common.data/resolved-workspace',
    major: 1,
    facet: { gameId: 'blizzard/starcraft-2' },
    ...(signal === undefined ? {} : { signal }),
  })
  try {
    return await callback(lease.value)
  } finally {
    await lease.release()
  }
}

async function replayCatalogLookups(activation, input, signal) {
  const request = input?.resolvedData
  if (request === undefined) return undefined
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('resolvedData must be an object')
  }
  return withResolvedDataService(activation, signal, async workspace => {
    let snapshotId = request.snapshotId
    if (request.analysis !== undefined) {
      if (
        request.analysis === null ||
        typeof request.analysis !== 'object' ||
        Array.isArray(request.analysis)
      ) {
        throw new TypeError('resolvedData.analysis must be a catalog analysis request')
      }
      const snapshot = await workspace.analyze({ ...request.analysis, signal })
      snapshotId = snapshot.snapshotId
    }
    return loadReplayCatalogLookups(workspace, {
      snapshotId,
      maxUnits: request.maxUnits,
      maxDefinitions: request.maxDefinitions,
      maxPageSize: request.maxPageSize,
      signal,
    })
  })
}

async function replayCommandSemantics(activation, input, signal) {
  const request = input?.semantic
  if (request === undefined) return undefined
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('semantic must be an object')
  }
  if (request.stableIds === undefined) {
    throw new TypeError('semantic.stableIds is required')
  }
  const resolved = request.resolvedData
  if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new TypeError('semantic.resolvedData is required')
  }
  return withResolvedDataService(activation, signal, async workspace => {
    let snapshotId = resolved.snapshotId
    if (resolved.analysis !== undefined) {
      if (
        resolved.analysis === null ||
        typeof resolved.analysis !== 'object' ||
        Array.isArray(resolved.analysis)
      ) {
        throw new TypeError('semantic.resolvedData.analysis must be a catalog analysis request')
      }
      const snapshot = await workspace.analyze({ ...resolved.analysis, signal })
      snapshotId = snapshot.snapshotId
    }
    const catalog = await loadReplayAbilityCatalog(workspace, {
      snapshotId,
      maxAbilities: resolved.maxAbilities,
      maxDefinitions: resolved.maxDefinitions,
      maxPageSize: resolved.maxPageSize,
      signal,
    })
    const resolver = createReplaySemanticCommandResolver(request.stableIds, catalog, {
      maxStableAbilities: request.maxStableAbilities,
    })
    return Object.freeze({
      resolver,
      summary: Object.freeze({
        snapshotId,
        stableAbilityCount: resolver.stableAbilityCount,
        catalogAbilityCount: resolver.catalogAbilityCount,
      }),
    })
  })
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return [...value]
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]))
  }
  return value
}

const REPLAY_WORLD_CONTRACT = 'common.view/world-scene-source'
const REPLAY_WORLD_LAYER = 'replay-units'

function replayBounds(timeline) {
  let minimumX = Infinity
  let maximumX = -Infinity
  let minimumY = Infinity
  let maximumY = -Infinity
  for (const track of timeline.units) {
    for (let index = 1; index < track.samples.length; index += 3) {
      const x = track.samples[index]
      const y = track.samples[index + 1]
      minimumX = Math.min(minimumX, x)
      maximumX = Math.max(maximumX, x)
      minimumY = Math.min(minimumY, y)
      maximumY = Math.max(maximumY, y)
    }
  }
  return Number.isFinite(minimumX)
    ? { minimumX, maximumX, minimumY, maximumY }
    : { minimumX: 0, maximumX: 0, minimumY: 0, maximumY: 0 }
}

function pageOffset(cursor) {
  if (cursor === undefined) return 0
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError('invalid replay world cursor')
  return offset
}

function createReplayPlayback(timeline, scene, replayId, participants) {
  const durationMs = Math.ceil((timeline.durationLoops * 1000) / REPLAY_LOOPS_PER_SECOND)
  let positionMs = 0
  const base = createTransportSource(
    {
      state: 'paused',
      positionMs,
      durationMs,
      frameRate: REPLAY_LOOPS_PER_SECOND,
      rate: 1,
      seekable: true,
      live: false,
      tracks: Object.freeze([
        Object.freeze({
          id: 'tracked-units',
          kind: 'data',
          label: 'Tracked units',
          selected: true,
        }),
      ]),
      controls: Object.freeze({
        playPause: 'media.play-pause',
        seek: 'media.seek',
        setRate: 'media.set-rate',
        selectTrack: 'media.select-track',
      }),
    },
    { wallClock: true },
  )
  const transport = Object.freeze({
    async snapshot(signal) {
      const value = await base.snapshot(signal)
      positionMs = value.positionMs
      return value
    },
    async *events(signal) {
      for await (const event of base.events(signal)) {
        if (event.kind === 'snapshot') positionMs = event.snapshot.positionMs
        yield event
      }
    },
    async timeline(request, signal) {
      signal?.throwIfAborted()
      if (request === null || typeof request !== 'object') {
        throw new TypeError('transport timeline requires {maxMarkers, maxSeriesPoints}')
      }
      return projectReplayPlayback(
        { timeline, ...participants() },
        { maxMarkers: request.maxMarkers, maxSeriesPoints: request.maxSeriesPoints },
      )
    },
    control(kind, input) {
      base.control(kind, input)
      if (kind === 'seek') positionMs = Math.min(Number(input?.positionMs), durationMs)
    },
  })
  const bounds = replayBounds(timeline)
  // info() pins the sampled position, so one info-then-pages read sees one consistent frame even
  // while the transport keeps moving, and a remote consumer (which cannot read the live snapshotId
  // property) can rely on the snapshot info() returned.
  let pinnedMs
  const pinnedLoop = () => ((pinnedMs ?? positionMs) * REPLAY_LOOPS_PER_SECOND) / 1000
  const snapshotId = () => `${replayId}:loop:${Math.round(pinnedLoop())}`
  const frame = () => scene.sampleAt(pinnedLoop())
  const world = Object.freeze({
    contract: REPLAY_WORLD_CONTRACT,
    major: 1,
    get snapshotId() {
      return snapshotId()
    },
    async info(signal) {
      signal?.throwIfAborted()
      pinnedMs = positionMs
      const sampled = frame()
      const currentSnapshot = snapshotId()
      return Object.freeze({
        contract: REPLAY_WORLD_CONTRACT,
        major: 1,
        maturity: 'publisher-candidate',
        snapshotId: currentSnapshot,
        mapId: replayId,
        coordinateSpaces: Object.freeze([
          Object.freeze({
            id: 'sc2-replay-world',
            horizontalAxes: Object.freeze(['x', 'y']),
            verticalAxis: 'z',
            handedness: 'publisher-native',
            linearUnit: 'sc2-game-unit',
            rotationUnit: 'radian',
            origin: 'sc2-replay-tracker-origin',
          }),
        ]),
        crossSpaceTransforms: Object.freeze([]),
        bounds: Object.freeze([
          Object.freeze({
            facet: 'objects',
            coordinateSpaceId: 'sc2-replay-world',
            x: Object.freeze({
              state: 'known',
              minimum: bounds.minimumX,
              maximum: bounds.maximumX,
            }),
            y: Object.freeze({
              state: 'known',
              minimum: bounds.minimumY,
              maximum: bounds.maximumY,
            }),
            z: Object.freeze({ state: 'known', minimum: 0, maximum: 0 }),
          }),
        ]),
        facets: Object.freeze([
          Object.freeze({
            facet: 'objects',
            layerId: REPLAY_WORLD_LAYER,
            state: 'available',
            itemCount: sampled.count,
            lods: Object.freeze(['sampled']),
          }),
        ]),
        provenance: Object.freeze([]),
        unknownFacets: Object.freeze(['terrain', 'regions', 'resources', 'navigation', 'height']),
        lossPolicy: 'explicit-partial',
        complete: false,
      })
    },
    async page(request, signal) {
      signal?.throwIfAborted()
      if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
        throw new RangeError('replay world page limit must be a positive safe integer')
      }
      const currentSnapshot = snapshotId()
      const sampled = frame()
      if (request.facet === 'layers') {
        const layers = [
          Object.freeze({
            facet: 'layers',
            id: `layer:${REPLAY_WORLD_LAYER}`,
            layerId: REPLAY_WORLD_LAYER,
            kind: 'objects',
            state: 'available',
            itemCount: sampled.count,
            lods: Object.freeze(['sampled']),
          }),
        ]
        const offset = pageOffset(request.cursor)
        return Object.freeze({
          snapshotId: currentSnapshot,
          facet: 'layers',
          state: 'available',
          items: Object.freeze(layers.slice(offset, offset + request.limit)),
        })
      }
      if (request.facet !== 'objects' || request.layerId !== REPLAY_WORLD_LAYER) {
        return Object.freeze({
          snapshotId: currentSnapshot,
          facet: request.facet,
          state: 'unsupported',
          items: Object.freeze([]),
          reason: 'replay playback publishes only the sampled tracked-unit layer',
        })
      }
      const objects = []
      for (let index = 0; index < sampled.count; index += 1) {
        const x = sampled.positions[index * 2]
        const y = sampled.positions[index * 2 + 1]
        if (
          request.bounds !== undefined &&
          (x < request.bounds.minimumX ||
            x > request.bounds.maximumX ||
            y < request.bounds.minimumY ||
            y > request.bounds.maximumY)
        )
          continue
        const typeId = sampled.typeIds[index]
        const tag = sampled.tags[index]
        objects.push(
          Object.freeze({
            facet: 'objects',
            id: `unit:${tag}`,
            layerId: REPLAY_WORLD_LAYER,
            coordinateSpaceId: 'sc2-replay-world',
            kind: 'unit',
            objectId: sampled.trackIndices[index],
            sourceKey: String(tag),
            sourcePositionDimensions: 2,
            position: Object.freeze({ x, y, z: 0 }),
            typeId: timeline.typeNames[typeId] ?? String(typeId),
            player: sampled.playerIds[index],
          }),
        )
      }
      const offset = pageOffset(request.cursor)
      const items = objects.slice(offset, offset + request.limit)
      return Object.freeze({
        snapshotId: currentSnapshot,
        facet: 'objects',
        state: 'available',
        items: Object.freeze(items),
        ...(offset + items.length < objects.length
          ? { nextCursor: String(offset + items.length) }
          : {}),
      })
    },
  })
  return Object.freeze({ transport, world, handlers: createTransportHandlers(transport) })
}

export async function detectSc2ReplayNamespaceMarkers(markers) {
  const paths = new Set(markers.map(marker => normalizeSc2NamespacePath(marker.path).toLowerCase()))
  if (!paths.has('replay.details')) {
    return { confidence: 0, kind: 'structure', note: 'sc2-replay-details-missing' }
  }
  const known = [...KNOWN_STREAMS.keys()].filter(path => paths.has(path)).length
  return {
    confidence: known >= 2 ? 0.999 : 0.995,
    kind: 'structure',
    note: `sc2-replay-namespace:${known}-known-streams`,
  }
}

const operations = Object.freeze([
  ...TRANSPORT_OPERATIONS,
  Object.freeze({
    id: 'blizzard/sc2-replay.analyze',
    handlerId: 'analyze',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'export.convert',
    handlerId: 'export-convert',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'blizzard/sc2-replay.decode-stream',
    handlerId: 'decode-stream',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'blizzard/sc2-replay.timeline',
    handlerId: 'timeline',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'blizzard/sc2-replay.sample-scene',
    handlerId: 'sample-scene',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'blizzard/sc2-replay.player-state',
    handlerId: 'player-state',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'blizzard/sc2-replay.command-intents',
    handlerId: 'command-intents',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'export.raw',
    handlerId: 'export-raw',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['bytes']),
  }),
  Object.freeze({
    id: 'container.extract',
    handlerId: 'extract-entry',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['bytes']),
  }),
])

const definition = activation =>
  Object.freeze({
    id: ID,
    version: '1.0.0',
    format: Object.freeze({ id: 'sc2-replay', label: 'StarCraft II replay' }),
    operations,
    namespace: Object.freeze({
      detect: detectSc2ReplayNamespaceMarkers,
      async inspect(namespace, context) {
        context.signal?.throwIfAborted()
        const entries = await walkSc2Namespace(namespace, context.budget, context.signal)
        const files = entries.filter(entry => entry.kind === 'file')
        const known = files.filter(entry => streamRole(entry.path) !== '')
        if (!known.some(entry => entry.path.toLowerCase() === 'replay.details')) {
          throw new TypeError('SC2Replay namespace has no replay.details stream')
        }
        const decodedStreams = new Map()
        for (const entry of known) {
          decodedStreams.set(
            entry.path.toLowerCase(),
            await readSc2NamespaceEntry(
              namespace,
              entry.path,
              Math.min(Number(context.budget.maxScalarBytes), Number(context.budget.maxInputBytes)),
              context.signal,
            ),
          )
        }
        const decodeOptions = Object.freeze({
          signal: context.signal,
          maxDepth: context.budget.maxDepth,
          maxNodes: context.budget.maxNodes,
          maxEvents: context.budget.maxNodes,
          maxScalarBytes: Number(context.budget.maxScalarBytes),
        })
        const diagnostics = []
        let header
        if (namespace.readPreamble !== undefined) {
          try {
            const preamble = await namespace.readPreamble(
              Math.min(Number(context.budget.maxScalarBytes), Number(context.budget.maxInputBytes)),
              context.signal,
            )
            header = decodeReplayHeaderPayload(preamble, decodeOptions)
          } catch (error) {
            diagnostics.push({
              id: 'sc2-replay-header-decode-failed',
              code: 'blizzard/sc2-replay-header-decode-failed',
              category: 'structure',
              severity: 'warning',
              message: `MPQ replay header could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        }
        const decodeOptional = (path, decode) => {
          const bytes = decodedStreams.get(path)
          if (bytes === undefined) return undefined
          try {
            return decode(bytes, decodeOptions)
          } catch (error) {
            diagnostics.push({
              id: `sc2-replay-${streamRole(path)}-decode-failed`,
              code: `blizzard/sc2-replay-${streamRole(path)}-decode-failed`,
              category: 'structure',
              severity: 'warning',
              message: `${path} could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
            })
            return undefined
          }
        }
        const details = decodeOptional('replay.details', decodeReplayDetails)
        const trackerEvents = decodeOptional('replay.tracker.events', decodeTrackerEvents)
        const attributes = decodeOptional('replay.attributes.events', (bytes, options) =>
          decodeReplayAttributes(bytes, {
            ...options,
            baseBuild: header?.version.baseBuild,
          }),
        )
        const loadInfo = decodeOptional('replay.load.info', decodeReplayLoadInfo)
        let protocolResolution
        let initData
        let gameEvents
        let messageEvents
        // Without the header there is no build to decode game and message events by: say so, rather
        // than leave a timeline with no APM and no chat and no reason (seen in the VS Code window).
        if (header === undefined)
          diagnostics.push({
            id: 'sc2-replay-header-unavailable',
            code: 'blizzard/sc2-replay-header-unavailable',
            category: 'dependency',
            severity: 'warning',
            message:
              namespace.readPreamble === undefined
                ? 'The replay container did not lend its header (readPreamble); game events, chat and APM are not decoded.'
                : 'The replay header was not decoded; game events, chat and APM are not decoded.',
          })
        if (header !== undefined) {
          try {
            await withProtocolService(activation, context.signal, async service => {
              const decode = async (path, stream) => {
                const bytes = decodedStreams.get(path)
                if (bytes === undefined) return undefined
                return service.decodeBitPacked(ownedBytes(bytes), {
                  ...decodeOptions,
                  build: header.version.baseBuild,
                  stream,
                  fallback: 'none',
                })
              }
              const init = await decode('replay.initdata', 'init')
              const game = await decode('replay.game.events', 'game')
              const message = await decode('replay.message.events', 'message')
              protocolResolution = init?.resolution ?? game?.resolution ?? message?.resolution
              initData = init?.value
              gameEvents = game?.value
              messageEvents = message?.value
            })
          } catch (error) {
            diagnostics.push({
              id: 'sc2-replay-protocol-unavailable',
              code: 'blizzard/sc2-replay-protocol-unavailable',
              category: 'dependency',
              severity: 'warning',
              message: `Exact replay protocol is unavailable: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        }
        const timeline =
          trackerEvents === undefined ? undefined : buildReplayTimeline(trackerEvents)
        const scene = timeline === undefined ? undefined : new ReplayScene(timeline)
        const controls =
          timeline === undefined || gameEvents === undefined
            ? undefined
            : buildControlTimeline(gameEvents, timeline.players)
        const analysisInput =
          header === undefined || details === undefined || trackerEvents === undefined
            ? undefined
            : { header, details, trackerEvents, gameEvents, messageEvents, initData }
        const commandInput =
          header === undefined || timeline === undefined || gameEvents === undefined
            ? undefined
            : {
                decoded: {
                  header,
                  trackerEvents,
                  gameEvents,
                  protocolSupport: protocolResolution,
                },
                timeline,
              }
        const dependencies = initData === undefined ? undefined : replayDependencySet(initData)
        const root = context.input.root
        const playback =
          timeline === undefined
            ? undefined
            : createReplayPlayback(timeline, scene, root.uri, () => {
                if (details === undefined) return {}
                let apm
                if (analysisInput !== undefined && gameEvents !== undefined) {
                  apm = analyzeReplay(analysisInput, { buildOrderLimit: 0 }).players.map(
                    player => player.apm,
                  )
                }
                return {
                  players: details.players,
                  ...(apm === undefined ? {} : { apm }),
                  ...(typeof details.title === 'string' ? { title: details.title } : {}),
                  chat: chatLines(messageEvents),
                }
              })
        const namespaceSource = createSc2NamespaceEntrySource(entries, namespace, root)
        const streamBytes = known.reduce((sum, entry) => sum + (entry.size ?? 0n), 0n)
        return {
          detection: await detectSc2ReplayNamespaceMarkers(known),
          summary: {
            format: 'sc2-replay',
            topology: 'mpq-namespace',
            entries: entries.length,
            knownStreams: known.length,
            streamNames: known.map(entry => entry.path),
            streamBytes: String(streamBytes),
            title: details?.title,
            players: details?.players.length,
            trackerEvents: trackerEvents?.length,
            attributes: attributes?.attributes.length,
            loadInfoWords: loadInfo?.values.length,
            durationLoops: timeline?.durationLoops,
            trackedUnits: timeline?.units.length,
            controlPlayers: controls?.players.size,
            build: header?.version.build,
            baseBuild: header?.version.baseBuild,
            elapsedGameLoops: header?.elapsedGameLoops,
            gameEvents: gameEvents?.length,
            messageEvents: messageEvents?.length,
            initDataDecoded: initData !== undefined,
            protocolBuild: protocolResolution?.selectedBuild,
            contentDependencies: dependencies?.dependencies.length,
          },
          metadata: [
            {
              id: 'sc2-replay',
              label: 'SC2Replay namespace',
              entries: [
                { key: 'entries', value: entries.length },
                { key: 'knownStreams', value: known.map(entry => entry.path) },
                { key: 'streamBytes', value: String(streamBytes) },
                { key: 'title', value: details?.title ?? '' },
                { key: 'players', value: details?.players.length ?? 0 },
                { key: 'trackerEvents', value: trackerEvents?.length ?? 0 },
                { key: 'attributes', value: attributes?.attributes.length ?? 0 },
                { key: 'loadInfoWords', value: loadInfo?.values.length ?? 0 },
                { key: 'durationLoops', value: timeline?.durationLoops ?? 0 },
                { key: 'trackedUnits', value: timeline?.units.length ?? 0 },
                { key: 'controlPlayers', value: controls?.players.size ?? 0 },
                { key: 'build', value: header?.version.build ?? 0 },
                { key: 'baseBuild', value: header?.version.baseBuild ?? 0 },
                { key: 'elapsedGameLoops', value: header?.elapsedGameLoops ?? 0 },
                { key: 'gameEvents', value: gameEvents?.length ?? 0 },
                { key: 'messageEvents', value: messageEvents?.length ?? 0 },
              ],
            },
          ],
          traits: [
            { id: 'game.replay', parameters: { streams: known.length, decoded: true } },
            { id: 'container.entries', parameters: { count: entries.length } },
            { id: 'structure.hierarchy', parameters: { entries: entries.length } },
            ...(dependencies === undefined
              ? []
              : [{
                  id: 'source.dependencies',
                  parameters: {
                    count: dependencies.dependencies.length,
                    complete: dependencies.complete,
                  },
                }]),
          ],
          dataSources: {
            'common.view/namespace-entry-source': namespaceSource,
            'common.view/table-data-source': createTableDataSource(
              ['Path', 'Bytes', 'Replay role'],
              files.map(entry => [entry.path, String(entry.size ?? 0n), streamRole(entry.path)]),
            ),
            'common.view/tree-data-source': createTreeDataSource({
              kind: 'replay',
              label: 'StarCraft II replay',
              preview: `${known.length} known stream(s), ${entries.length} entries`,
              children: entries.map(entry => ({
                kind: streamRole(entry.path) === '' ? entry.kind : 'replay-stream',
                label: entry.path,
                preview: streamRole(entry.path) || `${String(entry.size ?? 0n)} bytes`,
              })),
            }),
            ...(playback === undefined
              ? {}
              : {
                  'common.view/transport-source': playback.transport,
                  'common.view/world-scene-source': playback.world,
                }),
          },
          handlers: {
            ...(playback?.handlers ?? {}),
            analyze: async input => {
              if (analysisInput === undefined) {
                throw new RangeError(
                  'replay analysis requires decoded header, details and tracker events',
                )
              }
              if (
                input !== undefined &&
                (input === null || typeof input !== 'object' || Array.isArray(input))
              ) {
                throw new TypeError('replay analysis options must be an object')
              }
              const options = input ?? {}
              const {
                resolvedData: _resolvedData,
                [DATA_CATALOG_ENTITIES_INPUT]: answered,
                unitClass: callerUnitClass,
                unitCost: callerUnitCost,
                ...analysisOptions
              } = options
              // A resolved-data workspace the caller names, else the entities the host answered.
              const catalog =
                (await replayCatalogLookups(activation, options, context.signal)) ??
                (Array.isArray(answered)
                  ? catalogFromEntities({ gameId: 'blizzard/starcraft-2', definitions: answered })
                  : undefined)
              const result = analyzeReplay(analysisInput, {
                ...analysisOptions,
                ...(catalog === undefined && callerUnitClass === undefined
                  ? {}
                  : { unitClass: { ...(catalog?.unitClass ?? {}), ...(callerUnitClass ?? {}) } }),
                ...(catalog === undefined && callerUnitCost === undefined
                  ? {}
                  : { unitCost: { ...(catalog?.unitCost ?? {}), ...(callerUnitCost ?? {}) } }),
              })
              return {
                kind: 'json',
                value: jsonSafe(
                  catalog === undefined
                    ? {
                        ...result,
                        // Without a catalog, name the units whose class and cost it holds; a host
                        // that knows the replay's mod context answers them and asks again.
                        [DATA_CATALOG_QUERIES_OUTPUT]: replayUnitTypes(analysisInput).map(
                          entityId => ({ namespace: 'Unit', entityId }),
                        ),
                      }
                    : { ...result, catalogEnrichment: catalog.summary },
                ),
              }
            },
            // The whole decoded replay as one JSON document: header, details, the timeline and what
            // else the replay holds, with the cache archives it depends on.
            'export-convert': async () => {
              if (header === undefined || details === undefined) {
                throw new RangeError('replay JSON export requires decoded header and details')
              }
              return {
                kind: 'json',
                value: jsonSafe({
                  schemaVersion: 1,
                  codecId: ID,
                  header,
                  details,
                  timeline: timeline === undefined ? null : timelineToJson(timeline),
                  streams: {
                    trackerEvents: trackerEvents?.length ?? null,
                    gameEvents: gameEvents?.length ?? null,
                    messageEvents: messageEvents?.length ?? null,
                    initData: initData !== undefined,
                    loadInfo: loadInfo !== undefined,
                  },
                  dependencies: dependencies ?? null,
                }),
              }
            },
            'extract-entry': async input => {
              if (input === null || typeof input !== 'object' || Array.isArray(input)) {
                throw new TypeError('container.extract requires {entryId}')
              }
              const path = normalizeSc2NamespacePath(input.entryId ?? '')
              const entry = files.find(candidate => candidate.path === path)
              if (entry === undefined) throw new RangeError(`unknown SC2 replay stream: ${path}`)
              const maximum = Math.min(
                Number(context.budget.maxScalarBytes),
                Number(context.budget.maxInputBytes),
              )
              return {
                kind: 'bytes',
                value: await readSc2NamespaceEntry(namespace, path, maximum, context.signal),
              }
            },
            'decode-stream': async input => {
              if (input === null || typeof input !== 'object' || Array.isArray(input)) {
                throw new TypeError('replay.decode-stream requires {stream, build?, fallback?}')
              }
              const stream = String(input.stream ?? '').toLowerCase()
              const bytes = decodedStreams.get(stream)
              if (bytes === undefined)
                throw new RangeError(`replay stream is unavailable: ${stream}`)
              if (stream === 'replay.details')
                return { kind: 'json', value: jsonSafe(decodeReplayDetails(bytes, decodeOptions)) }
              if (stream === 'replay.tracker.events')
                return { kind: 'json', value: decodeTrackerEvents(bytes, decodeOptions) }
              if (stream === 'replay.attributes.events')
                return {
                  kind: 'json',
                  value: decodeReplayAttributes(bytes, {
                    ...decodeOptions,
                    baseBuild: header?.version.baseBuild,
                  }),
                }
              if (stream === 'replay.load.info')
                return { kind: 'json', value: jsonSafe(decodeReplayLoadInfo(bytes, decodeOptions)) }
              if (
                !['replay.game.events', 'replay.message.events', 'replay.initdata'].includes(stream)
              ) {
                throw new RangeError(`unsupported replay stream: ${stream}`)
              }
              const build =
                input.build === undefined ? header?.version.baseBuild : Number(input.build)
              if (build === undefined) {
                throw new RangeError(
                  'replay stream build is unavailable; supply {build} or open the packed replay with its MPQ preamble',
                )
              }
              const result = await withProtocolService(activation, context.signal, service =>
                service.decodeBitPacked(ownedBytes(bytes), {
                  ...decodeOptions,
                  build,
                  stream:
                    stream === 'replay.game.events'
                      ? 'game'
                      : stream === 'replay.message.events'
                        ? 'message'
                        : 'init',
                  fallback: input.fallback ?? 'none',
                }),
              )
              return { kind: 'json', value: jsonSafe(result) }
            },
            timeline: async () => {
              if (timeline === undefined)
                throw new RangeError('replay tracker timeline is unavailable')
              return { kind: 'json', value: jsonSafe(timelineToJson(timeline)) }
            },
            'sample-scene': async input => {
              if (scene === undefined || timeline === undefined)
                throw new RangeError('replay tracker scene is unavailable')
              if (input === null || typeof input !== 'object' || Array.isArray(input)) {
                throw new TypeError('sample-scene requires {loop}')
              }
              const loop = Number(input.loop)
              if (!Number.isFinite(loop) || loop < 0 || loop > timeline.durationLoops) {
                throw new RangeError(`scene loop must be between 0 and ${timeline.durationLoops}`)
              }
              const frame = scene.sampleAt(loop)
              return {
                kind: 'json',
                value: {
                  loop: frame.loop,
                  count: frame.count,
                  tags: [...frame.tags.subarray(0, frame.count)],
                  positions: [...frame.positions.subarray(0, frame.count * 2)],
                  playerIds: [...frame.playerIds.subarray(0, frame.count)],
                  typeIds: [...frame.typeIds.subarray(0, frame.count)],
                  underConstruction: [...frame.underConstruction.subarray(0, frame.count)],
                  typeNames: timeline.typeNames,
                },
              }
            },
            'player-state': async input => {
              if (timeline === undefined || controls === undefined) {
                throw new RangeError('replay player state requires tracker and game events')
              }
              if (input === null || typeof input !== 'object' || Array.isArray(input)) {
                throw new TypeError('player-state requires {playerId, loop}')
              }
              const playerId = Number(input.playerId)
              const loop = Number(input.loop)
              const durationLoops = Math.max(timeline.durationLoops, header?.elapsedGameLoops ?? 0)
              if (!Number.isSafeInteger(playerId) || playerId <= 0) {
                throw new RangeError('playerId must be a positive safe integer')
              }
              if (!Number.isSafeInteger(loop) || loop < 0 || loop > durationLoops) {
                throw new RangeError(`player-state loop must be between 0 and ${durationLoops}`)
              }
              const track = controls.players.get(playerId)
              return {
                kind: 'json',
                value: {
                  playerId,
                  loop,
                  selectionAvailable: track !== undefined,
                  selection: track === undefined ? [] : [...selectionAt(track, loop)],
                  hud: hudStateAt(timeline, playerId, loop),
                  diagnostics: [...controls.diagnostics],
                },
              }
            },
            'command-intents': async input => {
              if (commandInput === undefined) {
                throw new RangeError('replay command intents require header, tracker and game events')
              }
              if (
                input !== undefined &&
                (input === null || typeof input !== 'object' || Array.isArray(input))
              ) {
                throw new TypeError('command-intents options must be an object')
              }
              const semantics = await replayCommandSemantics(activation, input, context.signal)
              const result = normalizeSc2ReplayCommands(commandInput, semantics?.resolver, {
                maxIntents: input?.maxIntents,
              })
              return {
                kind: 'json',
                value: jsonSafe(
                  semantics === undefined
                    ? result
                    : { ...result, semanticContext: semantics.summary },
                ),
              }
            },
          },
          operationStates: [
            ...(playback === undefined
              ? TRANSPORT_OPERATIONS.map(operation => ({
                  id: operation.id,
                  state: 'disabled',
                  reason: 'replay tracker timeline is unavailable',
                }))
              : []),
            ...(analysisInput === undefined
              ? [
                  {
                    id: 'blizzard/sc2-replay.analyze',
                    state: 'disabled',
                    reason: 'decoded replay header, details or tracker events are unavailable',
                  },
                ]
              : []),
            ...(controls === undefined
              ? [
                  {
                    id: 'blizzard/sc2-replay.player-state',
                    state: 'disabled',
                    reason: 'decoded tracker or game events are unavailable',
                  },
                ]
              : []),
            ...(commandInput === undefined
              ? [
                  {
                    id: 'blizzard/sc2-replay.command-intents',
                    state: 'disabled',
                    reason: 'decoded header, tracker or game events are unavailable',
                  },
                ]
              : []),
          ],
          diagnostics,
          maxDecodedBytes: context.budget.maxScalarBytes,
          unsupportedFeatures: ['runtime-divergence-correction', 'replay-editing-and-writing'],
        }
      },
    }),
  })

export const abiVersion = 1
export const createCodec = context => createInspectionCodec(definition(context), context)
