/**
 * What a scenario shows, the same from a loose `scenario.chk` and from a map (`.scm`, `.scx`): a
 * tree of its sections, its players as a table, and its terrain as a map layer. Both codecs build
 * their answers here and differ only in where the scenario's bytes come from and go back to.
 */
import { createRasterImageSource, createTableDataSource, createTreeDataSource, type InspectionTreeNode } from '@modkit/codec-kit'
import type { HostOperationHandler } from '@modkit/host'
import type { JsonValue, RasterRegionRequest } from '@modkit/sdk'
import { mapLayerWindow, type MapLayerDescriptor, type MapLayerGrid, type MapLayerReadRequest } from '@modkit/sdk/maps'
import type { LoadedStringTable } from '../tbl/companion.js'
import { showControlCodes } from '../text.js'
import { TILESET_REQUIREMENT_ID, type LoadedTileset } from '../tileset/companion.js'
import { minitileFlags, renderTerrain, type Tileset } from '../tileset/tileset.js'
import { OWNERS, RACES, TILESET_NAMES, VERSIONS, writeScenarioTiles, type Scenario } from './scenario.js'
import { ACTION_NAMES, COMPARISONS, CONDITION_NAMES, GROUPS, readTriggers, type Trigger, type TriggerAction, type TriggerCondition } from './triggers.js'

/** Where a scenario lives inside a map (`staredit\scenario.chk`; the MPQ namespace spells `/`). */
export const SCENARIO_ENTRY = 'staredit/scenario.chk'

/** The one layer a scenario has on its own: its tiles. Walkability and elevation need the tileset. */
export const TILES_LAYER = 'tiles'
export const WALKABLE_LAYER = 'walkable'
export const ELEVATION_LAYER = 'elevation'

export const PLAYER_COLUMNS = ['player', 'owner', 'race', 'force'] as const

/** The companion naming units: the game's `rez\stat_txt.tbl`, whose entry `id` names unit `id`. */
export const UNIT_NAMES_REQUIREMENT_ID = 'unit-names'

const playerName = (index: number) => (index < 8 ? `Player ${String(index + 1)}` : index === 11 ? 'Neutral' : `Player ${String(index + 1)}`)
const tilesetName = (scenario: Scenario) => TILESET_NAMES[scenario.tileset] ?? String(scenario.tileset)
const versionName = (scenario: Scenario) =>
  scenario.version === undefined ? 'unknown' : (VERSIONS[scenario.version] ?? `version ${String(scenario.version)}`)
/** Slots a game can fill: human and computer, not closed, inactive or neutral. */
const playable = (scenario: Scenario) => scenario.players.filter(player => player.index < 8 && [1, 2, 5, 6].includes(player.owner))

export function scenarioSummary(scenario: Scenario, tileset?: Tileset) {
  return {
    format: 'starcraft1-scenario',
    name: scenario.name,
    version: scenario.version ?? null,
    tileset: tilesetName(scenario),
    width: scenario.width,
    height: scenario.height,
    players: playable(scenario).length,
    units: scenario.units.length,
    doodads: scenario.doodads.length,
    locations: scenario.locations.length,
    triggers: scenario.triggers,
    sections: scenario.sections.length,
    layers: [...scenarioLayers(scenario, tileset).keys()],
    terrain: tileset !== undefined,
  }
}

export function scenarioMetadata(scenario: Scenario) {
  return [{
    id: 'starcraft1-scenario',
    label: 'StarCraft scenario',
    entries: [
      { key: 'name', value: scenario.name },
      { key: 'description', value: scenario.description },
      { key: 'version', value: versionName(scenario) },
      { key: 'tileset', value: tilesetName(scenario) },
      { key: 'size', value: `${String(scenario.width)} × ${String(scenario.height)}` },
      { key: 'players', value: playable(scenario).length },
    ],
  }]
}

export function playerRows(scenario: Scenario): string[][] {
  return scenario.players.map(player => [
    playerName(player.index),
    OWNERS[player.owner] ?? String(player.owner),
    RACES[player.race] ?? String(player.race),
    player.index < 8 ? (scenario.forces[player.force]?.name || `Force ${String(player.force + 1)}`) : '',
  ])
}

/** A node whose items are built when a client first opens it. */
function listNode<T>(kind: string, label: string, items: readonly T[], limit: number, node: (item: T) => InspectionTreeNode): InspectionTreeNode {
  return { kind, label, preview: String(items.length), hasChildren: items.length > 0, children: () => items.slice(0, limit).map(node) }
}

const value = (label: string, preview: string): InspectionTreeNode => ({ kind: 'value', label, preview })

/** `unitName(id)`: a unit's name from the game's `stat_txt.tbl`, when bound. */
export function scenarioTree(scenario: Scenario, limit: number, unitName: (id: number) => string | undefined = () => undefined): InspectionTreeNode {
  const unitLabel = (id: number) => unitName(id) ?? `Unit ${String(id)}`
  return {
    kind: 'starcraft1-scenario',
    label: scenario.name || 'StarCraft scenario',
    preview: `${tilesetName(scenario)}, ${String(scenario.width)} × ${String(scenario.height)}, ${String(playable(scenario).length)} players`,
    children: [
      {
        kind: 'information', label: 'Information', preview: versionName(scenario),
        children: [
          value('Name', scenario.name),
          value('Description', scenario.description),
          value('Version', versionName(scenario)),
          value('Tileset', tilesetName(scenario)),
          value('Size', `${String(scenario.width)} × ${String(scenario.height)} tiles`),
        ],
      },
      listNode('players', 'Players', scenario.players, limit, player => ({
        kind: 'player', label: playerName(player.index),
        preview: `${OWNERS[player.owner] ?? String(player.owner)}, ${RACES[player.race] ?? String(player.race)}`,
      })),
      listNode('forces', 'Forces', scenario.forces, limit, force => ({
        kind: 'force', label: force.name || 'Force',
        preview: scenario.players.filter(player => player.index < 8 && scenario.forces[player.force] === force).map(player => playerName(player.index)).join(', '),
      })),
      listNode('units', 'Units', scenario.units, limit, unit => ({ kind: 'unit', label: unitLabel(unit.unitId), preview: `${playerName(unit.owner)}, (${String(unit.x)}, ${String(unit.y)}), unit ${String(unit.unitId)}` })),
      listNode('doodads', 'Doodads and sprites', scenario.doodads, limit, doodad => ({
        kind: doodad.flags & 0x1000 ? 'sprite' : 'doodad', label: doodad.flags & 0x1000 ? `Sprite ${String(doodad.id)}` : unitLabel(doodad.id),
        preview: `(${String(doodad.x)}, ${String(doodad.y)})`,
      })),
      listNode('locations', 'Locations', scenario.locations, limit, location => ({
        kind: 'location', label: location.name || `Location ${String(location.index + 1)}`,
        preview: `(${String(location.left)}, ${String(location.top)}) – (${String(location.right)}, ${String(location.bottom)})`,
      })),
      triggerNode('triggers', 'Triggers', readTriggers(lastSection(scenario, 'TRIG')), ACTION_NAMES, UNIT_ACTIONS, scenario, limit, unitLabel),
      triggerNode('briefings', 'Mission briefings', readTriggers(lastSection(scenario, 'MBRF')), BRIEFING_ACTION_NAMES, UNIT_BRIEFING_ACTIONS, scenario, limit, unitLabel),
      listNode('sections', 'Sections', scenario.sections, limit, section => ({
        kind: 'section', label: section.name.trimEnd(),
        preview: section.bytes.byteLength === section.declaredSize ? `${String(section.declaredSize)} bytes` : `${String(section.bytes.byteLength)} of ${String(section.declaredSize)} bytes`,
      })),
    ],
  }
}

/** Briefing actions: a mission briefing is a trigger list with its own actions. */
const BRIEFING_ACTION_NAMES: readonly string[] = Object.freeze([
  'No Action', 'Wait', 'Play WAV', 'Text Message', 'Mission Objectives', 'Show Portrait', 'Hide Portrait',
  'Display Speaking Portrait', 'Transmission', 'Skip Tutorial Enabled',
])

/** Conditions that name no player: No Condition, Countdown Timer, Switch, Elapsed Time, Mission Briefing, Always, Never. */
const PLAYERLESS_CONDITIONS = new Set([0, 1, 11, 12, 13, 22, 23])
const SWITCH = 11

const lastSection = (scenario: Scenario, name: string) => scenario.sections.findLast(section => section.name === name)?.bytes

/** Condition and action types whose unit field names a unit (the Marine is unit 0). */
const UNIT_CONDITIONS = new Set([2, 3, 5, 6, 7, 15, 16, 17])
const UNIT_ACTIONS = new Set([7, 11, 17, 18, 20, 22, 23, 24, 25, 29, 33, 34, 36, 39, 42, 43, 44, 45, 46, 48, 49, 50, 51, 52, 53])
const UNIT_BRIEFING_ACTIONS = new Set([5, 7])
/** Unit ids past the game's 228 units that triggers use for groups of units. */
const UNIT_GROUPS: Readonly<Record<number, string>> = Object.freeze({ 228: 'None', 229: 'Any unit', 230: 'Men', 231: 'Buildings', 232: 'Factories' })

/** A string as one line: the editor's line breaks and indentation collapsed. */
const oneLine = (text: string) => showControlCodes(text).replace(/\s+/gu, ' ').trim()

/** What a trigger slot names, in words: only the fields its type uses. */
function describe(scenario: Scenario, unitLabel: (id: number) => string, unitActions: ReadonlySet<number>, slot: TriggerCondition | TriggerAction): string {
  const parts: string[] = []
  const group = GROUPS[slot.group] ?? `group ${String(slot.group)}`
  if ('amount' in slot) {
    if (slot.type === SWITCH) return `${slot.disabled ? '(disabled) ' : ''}switch ${String(slot.resource + 1)} ${COMPARISONS[slot.comparison] ?? String(slot.comparison)}`
    if (!PLAYERLESS_CONDITIONS.has(slot.type)) parts.push(group)
    if (slot.amount !== 0 || (slot.comparison !== 0 && !PLAYERLESS_CONDITIONS.has(slot.type)))
      parts.push(`${COMPARISONS[slot.comparison] ?? `comparison ${String(slot.comparison)}`} ${String(slot.amount)}`)
  } else {
    if (slot.group !== 0) parts.push(group)
    if (slot.string !== 0) parts.push(`«${oneLine(scenario.strings[slot.string - 1] ?? '')}»`)
    if (slot.sound !== 0) parts.push(oneLine(scenario.strings[slot.sound - 1] ?? `sound ${String(slot.sound)}`))
    if (slot.time !== 0) parts.push(`${String(slot.time)} ms`)
    if (slot.number !== 0) parts.push(`number ${String(slot.number)}`)
  }
  if (('amount' in slot ? UNIT_CONDITIONS : unitActions).has(slot.type)) parts.push(UNIT_GROUPS[slot.unit] ?? unitLabel(slot.unit))
  if (slot.location !== 0) parts.push(`at ${scenario.locationNames[slot.location - 1] || `location ${String(slot.location)}`}`)
  return (slot.disabled ? '(disabled) ' : '') + parts.join('; ')
}

function triggerNode(
  kind: string,
  label: string,
  triggers: readonly Trigger[],
  actionNames: readonly string[],
  unitActions: ReadonlySet<number>,
  scenario: Scenario,
  limit: number,
  unitLabel: (id: number) => string,
): InspectionTreeNode {
  return listNode(kind, label, triggers, limit, trigger => ({
    kind: 'trigger',
    label: `${kind === 'briefings' ? 'Briefing' : 'Trigger'} ${String(trigger.index + 1)}`,
    preview: `${trigger.players.map(group => GROUPS[group] ?? String(group)).join(', ') || 'no players'}; ${String(trigger.conditions.length)} conditions, ${String(trigger.actions.length)} actions`,
    hasChildren: true,
    children: () => [
      ...trigger.conditions.map(condition => ({ kind: 'condition', label: CONDITION_NAMES[condition.type] ?? `Condition ${String(condition.type)}`, preview: describe(scenario, unitLabel, unitActions, condition) })),
      ...trigger.actions.map(action => ({ kind: 'action', label: actionNames[action.type] ?? `Action ${String(action.type)}`, preview: describe(scenario, unitLabel, unitActions, action) })),
    ],
  }))
}

export function tilesLayer(scenario: Scenario): MapLayerDescriptor {
  return Object.freeze({
    id: TILES_LAYER,
    label: 'Terrain tiles: tile group × 16 + variant (MTXM)',
    meaning: 'other',
    width: scenario.width,
    height: scenario.height,
    minimum: 0,
    maximum: 0xffff,
    editable: true,
    sampling: 'cell',
  })
}

interface Layer {
  readonly descriptor: MapLayerDescriptor
  /** The sample at `column` from the west edge and `row` from the north edge. */
  sample(column: number, row: number): number
}

/**
 * The scenario's layers: its tiles, and with its tileset what the game reads of each minitile —
 * whether it is walkable and its ground level — on a grid four times finer than the tiles.
 */
export function scenarioLayers(scenario: Scenario, tileset?: Tileset): ReadonlyMap<string, Layer> {
  const layers = new Map<string, Layer>([[TILES_LAYER, { descriptor: tilesLayer(scenario), sample: (column, row) => scenario.tiles[row * scenario.width + column] ?? 0 }]])
  if (tileset === undefined) return layers
  const width = scenario.width * 4
  let flags: Uint16Array | undefined
  const flag = (column: number, row: number) => (flags ??= minitileFlags(scenario.tiles, scenario.width, tileset))[row * width + column] ?? 0
  const grid = { width, height: scenario.height * 4, minimum: 0, editable: false, sampling: 'cell' } as const
  layers.set(WALKABLE_LAYER, {
    descriptor: Object.freeze({ id: WALKABLE_LAYER, label: 'Walkable minitiles (tileset vf4)', meaning: 'pathing', ...grid, maximum: 1 }),
    sample: (column, row) => flag(column, row) & 1,
  })
  layers.set(ELEVATION_LAYER, {
    descriptor: Object.freeze({ id: ELEVATION_LAYER, label: 'Ground level: 0 low, 1 middle, 2 high (tileset vf4)', meaning: 'cliff-level', ...grid, maximum: 3 }),
    sample: (column, row) => (flag(column, row) >> 1) & 3,
  })
  return layers
}

function layerOf(scenario: Scenario, id: string, tileset?: Tileset): Layer {
  const layer = scenarioLayers(scenario, tileset).get(id)
  if (layer === undefined) throw new RangeError(`the scenario has no layer ${id}`)
  return layer
}

/** Rows are the map's rows from the top, as the game stores them: row 0 is the north edge. */
export function readScenarioLayer(scenario: Scenario, request: MapLayerReadRequest, tileset?: Tileset): MapLayerGrid {
  const layer = layerOf(scenario, request.layer, tileset)
  const window = mapLayerWindow(layer.descriptor, request)
  const values: number[] = []
  for (let row = window.y; row < window.y + window.height; row += 1)
    for (let column = window.x; column < window.x + window.width; column += 1) values.push(layer.sample(column, row))
  return { layer: layer.descriptor.id, ...(request.x === undefined ? {} : { x: window.x, y: window.y }), width: window.width, height: window.height, values }
}

/** The scenario's new bytes with the grid's samples written; every other byte kept. Only tiles are written. */
export function writeScenarioLayer(scenario: Scenario, chk: Uint8Array, grid: MapLayerGrid): Uint8Array {
  const layer = layerOf(scenario, grid.layer)
  const window = mapLayerWindow(layer.descriptor, grid)
  const tiles = scenario.tiles.slice()
  for (let row = 0; row < window.height; row += 1)
    for (let column = 0; column < window.width; column += 1)
      tiles[(window.y + row) * scenario.width + window.x + column] = grid.values[row * window.width + column]!
  return writeScenarioTiles(chk, tiles)
}

/** Levels of the terrain image: level `m` draws a tile as `32 >> m` pixels, level 5 one pixel a tile. */
const TERRAIN_LEVELS = 6

/**
 * The terrain as the game draws it, one raster frame over the whole map (32 pixels a tile), drawn
 * on demand for the window asked for: a 256 × 256 map is 8192 pixels a side and is never held
 * whole. Every level down to one pixel a tile is a stored level, so a thumbnail reads little.
 */
export function terrainRaster(scenario: Scenario, tileset: Tileset, bytes: Uint8Array) {
  return createRasterImageSource(
    bytes,
    'application/x-starcraft-chk',
    {
      width: scenario.width * 32,
      height: scenario.height * 32,
      depth: 1,
      layers: 1,
      faces: 1,
      mipLevels: TERRAIN_LEVELS,
      frames: 1,
      channels: 3,
      bitDepth: 8,
      colorSpace: 'srgb',
      alphaMode: 'none',
      orientation: 'top-left',
      decodedAccess: true,
    },
    async (request: RasterRegionRequest) => {
      const level = request.mipLevel ?? 0
      if (request.pixelFormat !== 'rgba8' || (request.frame ?? 0) !== 0 || (request.layer ?? 0) !== 0 || (request.face ?? 0) !== 0 || (request.slice ?? 0) !== 0)
        throw new RangeError('the terrain gives RGBA8 pixels of one frame, layer and face')
      if (!Number.isSafeInteger(level) || level < 0 || level >= TERRAIN_LEVELS) throw new RangeError(`the terrain has no level ${String(level)}`)
      if (![request.x, request.y, request.width, request.height].every(value => Number.isSafeInteger(value) && value >= 0))
        throw new TypeError('terrain region values must be non-negative safe integers')
      if (request.x + request.width > (scenario.width * 32) >> level || request.y + request.height > (scenario.height * 32) >> level)
        throw new RangeError('the region is outside the terrain')
      if (request.width * request.height * 4 > request.maxBytes) throw new RangeError('the terrain region exceeds maxBytes')
      const pixels = renderTerrain(scenario.tiles, scenario.width, tileset, request, level)
      return { width: request.width, height: request.height, rowStride: request.width * 4, pixelFormat: 'rgba8' as const, pixels }
    },
  )
}

/**
 * What both codecs answer for a scenario: summary, tree, players, layers (with the tileset, the
 * minitile layers too), the terrain image when the tileset is bound, and the tileset companion. The
 * codecs differ only in `write`, the plan that puts a layer write back where the scenario lives.
 */
export function scenarioInspection(
  scenario: Scenario,
  chk: Uint8Array,
  loaded: LoadedTileset,
  strings: LoadedStringTable,
  maxNodes: number,
  diagnosticPrefix: string,
  write: (grid: MapLayerGrid) => Promise<unknown>,
) {
  const tileset = loaded.tileset
  const unitName = (id: number) => strings.table?.entries[id]?.parts[0] || undefined
  return {
    summary: scenarioSummary(scenario, tileset),
    metadata: scenarioMetadata(scenario),
    traits: [],
    handlers: {
      'map-layers': (async () => ({
        kind: 'json',
        value: { layers: [...scenarioLayers(scenario, tileset).values()].map(layer => layer.descriptor) } as unknown as JsonValue,
      })) satisfies HostOperationHandler,
      'map-layer-read': (async (input: JsonValue) => ({
        kind: 'json',
        value: readScenarioLayer(scenario, (input ?? {}) as unknown as MapLayerReadRequest, tileset) as unknown as JsonValue,
      })) satisfies HostOperationHandler,
      'map-layer-write': (async (input: JsonValue) => write((input ?? {}) as unknown as MapLayerGrid)) as unknown as HostOperationHandler,
    },
    dataSources: {
      'common.view/tree-data-source': createTreeDataSource(scenarioTree(scenario, maxNodes, unitName)),
      'common.view/table-data-source': createTableDataSource({ header: [...PLAYER_COLUMNS], rows: playerRows(scenario) }),
      ...(tileset === undefined ? {} : { 'common.view/raster-image-source': terrainRaster(scenario, tileset, chk) }),
    },
    companions: [{
      id: TILESET_REQUIREMENT_ID,
      role: 'tileset',
      cardinality: 'many' as const,
      required: false,
      ...(loaded.bindingIds.length === 0 ? { state: 'missing' as const } : { state: 'resolved' as const, bindingIds: loaded.bindingIds }),
    }, {
      id: UNIT_NAMES_REQUIREMENT_ID,
      role: 'localization',
      cardinality: 'zero-or-one' as const,
      required: false,
      ...(strings.bindingIds.length === 0 ? { state: 'missing' as const } : { state: 'resolved' as const, bindingIds: strings.bindingIds }),
    }],
    diagnostics: [
      ...scenario.diagnostics.map((diagnostic, index) => ({
        id: `${diagnosticPrefix}.${String(index)}`,
        code: `blizzard/starcraft1-${diagnostic.code.replace('/', '-')}`,
        category: 'syntax' as const,
        severity: 'warning' as const,
        message: diagnostic.message,
      })),
      ...(loaded.note === undefined
        ? []
        : [{ id: `${diagnosticPrefix}.tileset`, code: 'blizzard/starcraft1-tileset', category: 'dependency' as const, severity: 'information' as const, message: loaded.note }]),
    ],
    unsupportedFeatures: ['world-scene', 'triggers'],
  }
}
