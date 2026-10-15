/**
 * Warcraft III map codec (`.w3m`, `.w3x`): opened over the host's `blizzard/mpq` container alias,
 * it reads the map's documents (`map.ts`) and publishes the map as a tree, its players as a table
 * and its terrain grids as map layers. A layer write is a plan replacing the one entry that stores
 * the layer; the host packs it back into the map through the container's `container.pack`. The
 * map's namespace and `container.extract` are the carrier's: the host lends them to the composed
 * session (core 8e51dc6a), and the MPQ codec finds an entry no listing names (a protected map) by its
 * path. The world is `blizzard/war3-map-world`.
 */
import type { InspectionTreeNode, NamespaceInspectionContext } from '@modkit/codec-kit'
import type { HostOperationHandler } from '@modkit/host'
import type { ArtifactSource, AssetNamespace, JsonValue, OperationDecl } from '@modkit/sdk'
import { createInspectionCodec, createTableDataSource, createTreeDataSource } from '@modkit/codec-kit'
import {
  MAP_LAYERS_INPUT_SCHEMA,
  MAP_LAYERS_OPERATION,
  MAP_LAYER_READ_INPUT_SCHEMA,
  MAP_LAYER_READ_OPERATION,
  MAP_LAYER_WRITE_INPUT_SCHEMA,
  MAP_LAYER_WRITE_OPERATION,
  type MapLayerGrid,
  type MapLayerReadRequest,
} from '@modkit/sdk/maps'
import type War3MapW3i from '../lib/mdx-m3-viewer/parsers/w3x/w3i/file.js'
import { WAR3_MAP_INFO, readWar3Map, readWar3MapLayer, war3MapLayers, war3MapText, writeWar3MapLayer, type War3Map } from './map.js'

const operations = [
  { id: MAP_LAYERS_OPERATION as OperationDecl['id'], handlerId: 'map-layers', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], inputSchema: MAP_LAYERS_INPUT_SCHEMA },
  { id: MAP_LAYER_READ_OPERATION as OperationDecl['id'], handlerId: 'map-layer-read', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], inputSchema: MAP_LAYER_READ_INPUT_SCHEMA },
  { id: MAP_LAYER_WRITE_OPERATION as OperationDecl['id'], handlerId: 'map-layer-write', mutatesSource: true, requiredPermissions: ['read-source', 'write-source'], outputKinds: ['edit-plan'], inputSchema: MAP_LAYER_WRITE_INPUT_SCHEMA },
] satisfies readonly OperationDecl[]

const normalized = (path: string) => path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')

/** A map entry as read: its bytes, and the ref and revision a plan replacing it names. */
interface Entry {
  readonly bytes: Uint8Array
  readonly ref: ArtifactSource['ref']
  readonly revision: ArtifactSource['revision']
}

/** An entry, or `undefined` when the map has no such entry. */
async function readEntry(namespace: AssetNamespace, listed: ReadonlySet<string>, path: string, maximum: number, signal?: AbortSignal): Promise<Entry | undefined> {
  let lease
  try {
    lease = await namespace.open(path, signal)
  } catch (error) {
    // A map without a listfile names nothing; an entry it does name must open.
    if (listed.has(path.toLowerCase())) throw error
    return undefined
  }
  try {
    const source = lease.value
    if (source.kind !== 'bytes' || source.size === undefined) throw new TypeError(`map entry is not a sized file: ${path}`)
    if (source.size > BigInt(maximum)) throw new RangeError(`map entry ${path} is ${String(source.size)} bytes, more than ${String(maximum)}`)
    const bytes = new Uint8Array(Number(source.size))
    for (let offset = 0; offset < bytes.byteLength; ) {
      signal?.throwIfAborted()
      const chunk = await source.read(BigInt(offset), Math.min(1 << 20, bytes.byteLength - offset), signal)
      if (chunk.byteLength === 0) throw new RangeError(`map entry ${path} ended early`)
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, ref: source.ref, revision: source.revision }
  } finally {
    await lease.release()
  }
}

const RACES = ['selectable', 'human', 'orc', 'undead', 'night elf']
const CONTROLLERS = ['', 'user', 'computer', 'neutral', 'rescuable']
const PLAYER_COLUMNS = ['id', 'name', 'controller', 'race', 'fixed start', 'start x', 'start y'] as const

function playerRows(map: War3Map, info: War3MapW3i): string[][] {
  return info.players.map(player => [
    String(player.id),
    war3MapText(map, player.name),
    CONTROLLERS[player.type] ?? String(player.type),
    RACES[player.race] ?? String(player.race),
    player.isFixedStartPosition === 0 ? '' : 'yes',
    String(player.startLocation[0]),
    String(player.startLocation[1]),
  ])
}

const at = (location: ArrayLike<number>) => `(${Math.round(location[0] ?? 0)}, ${Math.round(location[1] ?? 0)})`

/** A document node whose items are built when a client first opens it. */
function listNode<T>(kind: string, label: string, items: readonly T[] | undefined, limit: number, node: (item: T) => InspectionTreeNode): InspectionTreeNode[] {
  if (items === undefined) return []
  return [{
    kind, label, preview: String(items.length), hasChildren: items.length > 0,
    children: () => items.slice(0, limit).map(node),
  }]
}

function tree(map: War3Map, limit: number): InspectionTreeNode {
  const info = map.info
  const text = (value: string) => war3MapText(map, value)
  const [width = 0, height = 0] = map.terrain?.mapSize ?? []
  const information: InspectionTreeNode[] = info === undefined ? [] : [{
    kind: 'information', label: 'Information', preview: text(info.author),
    children: [
      ['Author', text(info.author)],
      ['Description', text(info.description)],
      ['Recommended players', text(info.recommendedPlayers)],
      ['Tileset', info.tileset],
      ['Playable size', `${String(info.playableSize[0])} × ${String(info.playableSize[1])}`],
      ['Format version', String(info.version)],
      ['Editor version', String(info.editorVersion)],
      ['Saves', String(info.saves)],
    ].map(([label, preview]) => ({ kind: 'value', label: label!, preview: preview! })),
  }]
  return {
    kind: 'war3-map',
    label: info === undefined ? 'Warcraft III map' : text(info.name),
    ...(info === undefined ? {} : { preview: `${info.tileset}, ${String(info.playableSize[0])} × ${String(info.playableSize[1])}, ${String(info.players.length)} players` }),
    children: [
      ...information,
      ...listNode('players', 'Players', info?.players, limit, player => ({
        kind: 'player', label: text(player.name),
        preview: `${CONTROLLERS[player.type] ?? String(player.type)}, ${RACES[player.race] ?? String(player.race)}, start ${at(player.startLocation)}`,
      })),
      ...listNode('forces', 'Forces', info?.forces, limit, force => ({
        kind: 'force', label: text(force.name),
        preview: info!.players.filter(player => (force.playerMasks >>> player.id) & 1).map(player => text(player.name)).join(', '),
      })),
      ...(map.terrain === undefined ? [] : [{
        kind: 'terrain', label: 'Terrain', preview: `${String(width - 1)} × ${String(height - 1)} tiles`,
        children: [
          { kind: 'value', label: 'Ground tilesets', preview: map.terrain.groundTilesets.join(' ') },
          { kind: 'value', label: 'Cliff tilesets', preview: map.terrain.cliffTilesets.join(' ') },
        ],
      }]),
      ...listNode('doodads', 'Doodads', map.doodads?.doodads, limit, doodad => ({ kind: 'doodad', label: doodad.id, preview: at(doodad.location) })),
      ...listNode('units', 'Units and items', map.units?.units, limit, unit => ({ kind: 'unit', label: unit.id, preview: `player ${String(unit.player)}, ${at(unit.location)}` })),
      ...listNode('regions', 'Regions', map.regions?.regions, limit, region => ({ kind: 'region', label: region.name, preview: `${at([region.left, region.bottom])} – ${at([region.right, region.top])}` })),
      ...listNode('cameras', 'Cameras', map.cameras?.cameras, limit, camera => ({ kind: 'camera', label: camera.cinematicName, preview: at(camera.targetLocation) })),
      ...listNode('sounds', 'Sounds', map.sounds?.sounds, limit, sound => ({ kind: 'sound', label: sound.name, preview: sound.file })),
      ...listNode('imports', 'Imported files', map.imports === undefined ? undefined : [...map.imports.entries.values()], limit, entry => ({ kind: 'import', label: entry.path })),
    ],
  }
}

const definition = Object.freeze({
  id: 'blizzard/war3-map',
  format: Object.freeze({ id: 'war3-map', label: 'Warcraft III map' }),
  operations,
  namespace: Object.freeze({
    async detect(markers: readonly { readonly path: string; readonly kind: string }[]) {
      return markers.some(marker => marker.kind === 'file' && marker.path.toLowerCase() === WAR3_MAP_INFO)
        ? { confidence: 0.97, kind: 'structure' as const, note: WAR3_MAP_INFO }
        : { confidence: 0, kind: 'structure' as const, note: `${WAR3_MAP_INFO}-missing` }
    },
    async inspect(namespace: AssetNamespace, context: NamespaceInspectionContext) {
      // The files the map lists: the listing is flat, every path below the root once.
      const listed = new Set<string>()
      for await (const entry of namespace.list('', context.signal)) {
        const path = normalized(entry.path)
        if (path === '' || listed.size >= context.budget.maxNodes) continue
        if (entry.kind === 'file') listed.add(path.toLowerCase())
      }
      const maximum = Number(context.budget.maxScalarBytes)
      const entries = new Map<string, Entry>()
      const map = await readWar3Map(async path => {
        const entry = await readEntry(namespace, listed, path, maximum, context.signal)
        if (entry !== undefined) entries.set(path, entry)
        return entry?.bytes
      }, context.signal)
      const info = map.info
      const limit = context.budget.maxNodes
      const summary = {
        format: 'war3-map',
        name: info === undefined ? null : war3MapText(map, info.name),
        tileset: info?.tileset ?? null,
        players: info?.players.length ?? 0,
        doodads: map.doodads?.doodads.length ?? 0,
        units: map.units?.units.length ?? 0,
        regions: map.regions?.regions.length ?? 0,
        layers: [...war3MapLayers(map).keys()],
      }
      return {
        detection: { confidence: 0.97, kind: 'structure' as const, note: WAR3_MAP_INFO },
        summary,
        metadata: info === undefined ? [] : [{
          id: 'war3-map', label: 'Warcraft III map',
          entries: [
            { key: 'name', value: summary.name ?? '' },
            { key: 'author', value: war3MapText(map, info.author) },
            { key: 'tileset', value: info.tileset },
            { key: 'playableSize', value: `${String(info.playableSize[0])} × ${String(info.playableSize[1])}` },
            { key: 'players', value: info.players.length },
            { key: 'formatVersion', value: info.version },
          ],
        }],
        traits: [],
        handlers: {
          'map-layers': (async () => ({ kind: 'json', value: { layers: [...war3MapLayers(map).values()].map(layer => layer.descriptor) } as unknown as JsonValue })) satisfies HostOperationHandler,
          'map-layer-read': (async (input: JsonValue) => ({ kind: 'json', value: readWar3MapLayer(map, (input ?? {}) as unknown as MapLayerReadRequest) as unknown as JsonValue })) satisfies HostOperationHandler,
          'map-layer-write': (async (input: JsonValue) => {
            const grid = (input ?? {}) as unknown as MapLayerGrid & { readonly expectedSourceRevision?: unknown }
            if (grid.expectedSourceRevision !== undefined && grid.expectedSourceRevision !== String(namespace.revision))
              throw new RangeError('the map changed since this layer was read')
            const layer = war3MapLayers(map).get(grid.layer)
            const entry = layer === undefined ? undefined : entries.get(layer.document)
            if (layer === undefined || entry === undefined) throw new RangeError(`the map has no layer ${String(grid.layer)}`)
            const written = writeWar3MapLayer(map, entry.bytes, grid)
            const targetId = `entry:${written.path}`
            return {
              kind: 'edit-plan' as const,
              plan: {
                planId: `war3-map-layer:${grid.layer}:${String(namespace.revision)}`,
                targets: [{
                  targetId,
                  subjectUri: entry.ref.uri,
                  ownerSource: entry.ref,
                  semanticPath: [],
                  expectedRevision: {
                    bindings: { content: entry.revision },
                    compositionFingerprint: `namespace-entry:${String(entry.revision)}:${entry.ref.id}`,
                  },
                }],
                edits: [{
                  operation: 'replace' as const,
                  targetId,
                  source: entry.ref,
                  payload: { kind: 'inline' as const, bytes: written.bytes },
                  label: `Write the ${grid.layer} layer into ${written.path}`,
                }],
                semantics: { mutationMode: 'mutate' as const, minimumGuarantee: 'atomic' as const },
                fidelity: {
                  roundTrip: 'semantic' as const,
                  preservesUnknownData: true,
                  notes: [`Only the written samples of ${written.path} change; the other fields of each corner or cell, the header and every other entry keep their bytes`],
                },
                diagnostics: [],
              },
            }
          }) as unknown as HostOperationHandler,
        },
        dataSources: {
          'common.view/tree-data-source': createTreeDataSource(tree(map, limit)),
          ...(info === undefined ? {} : { 'common.view/table-data-source': createTableDataSource({ header: [...PLAYER_COLUMNS], rows: playerRows(map, info) }) }),
        },
        diagnostics: [
          ...map.failures.map((failure, index) => ({
            id: `war3-map.parse.${String(index)}`,
            code: 'blizzard/war3-map-entry-parse-failed',
            category: 'syntax' as const,
            severity: 'warning' as const,
            message: `${failure.path}: ${failure.message}`,
          })),
          // A protected map lists no names; the container finds them only by exact path.
          ...(map.terrain === undefined && !map.failures.some(failure => failure.path === 'war3map.w3e')
            ? [{
                id: 'war3-map.terrain-missing',
                code: 'blizzard/war3-map-terrain-missing',
                category: 'semantic' as const,
                severity: 'warning' as const,
                message: 'the map names no war3map.w3e, so it has no terrain layers',
              }]
            : []),
        ],
        unsupportedFeatures: ['gui-triggers'],
      }
    },
  }),
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
