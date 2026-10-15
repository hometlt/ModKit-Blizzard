/**
 * StarCraft scenario codec (`.chk`): a scenario on its own — extracted from a map, or the
 * `staredit\scenario.chk` entry opened inside one, a campaign scenario of the Remastered storage.
 * Same tree, players, layers and terrain as the map codec (`view.ts`); a layer write is a plan
 * replacing the scenario's bytes.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import type { CodecCandidateSource, OperationDecl } from '@modkit/sdk'
import { createInspectionCodec, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import {
  MAP_LAYERS_INPUT_SCHEMA,
  MAP_LAYERS_OPERATION,
  MAP_LAYER_READ_INPUT_SCHEMA,
  MAP_LAYER_READ_OPERATION,
  MAP_LAYER_WRITE_INPUT_SCHEMA,
  MAP_LAYER_WRITE_OPERATION,
} from '@modkit/sdk/maps'
import { loadTileset, tilesetRequirement } from '../tileset/companion.js'
import { textDecoderOf } from '../text.js'
import { ERA_PREFIX_BYTES, TILESET_FILES, eraOfPrefix, readScenario } from './scenario.js'
import { UNIT_NAMES_REQUIREMENT_ID, scenarioInspection, writeScenarioLayer } from './view.js'
import { STAT_TXT, loadStringTable, stringTableRequirement } from '../tbl/companion.js'

const operations = [
  { id: MAP_LAYERS_OPERATION as OperationDecl['id'], handlerId: 'map-layers', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], inputSchema: MAP_LAYERS_INPUT_SCHEMA },
  { id: MAP_LAYER_READ_OPERATION as OperationDecl['id'], handlerId: 'map-layer-read', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], inputSchema: MAP_LAYER_READ_INPUT_SCHEMA },
  { id: MAP_LAYER_WRITE_OPERATION as OperationDecl['id'], handlerId: 'map-layer-write', mutatesSource: true, requiredPermissions: ['read-source', 'write-source'], outputKinds: ['edit-plan'], inputSchema: MAP_LAYER_WRITE_INPUT_SCHEMA },
] satisfies readonly OperationDecl[]

/** Sections a scenario opens with, as StarEdit and later editors write it. */
const FIRST_SECTIONS = new Set(['TYPE', 'VER ', 'IVER', 'IVE2', 'VCOD', 'IOWN', 'OWNR', 'ERA ', 'DIM ', 'SIDE', 'MTXM'])

const definition = Object.freeze({
  id: 'blizzard/starcraft1-chk',
  format: Object.freeze({ id: 'starcraft1-chk', label: 'StarCraft scenario' }),
  operations,
  async detect(prefix: Uint8Array) {
    if (prefix.byteLength < 8) return { confidence: 0 }
    const name = String.fromCharCode(...prefix.subarray(0, 4))
    const size = new DataView(prefix.buffer, prefix.byteOffset, 8).getInt32(4, true)
    return FIRST_SECTIONS.has(name) && size >= 0 && size < 1 << 24
      ? { confidence: 0.8, kind: 'structure' as const, note: `first section ${name.trimEnd()}` }
      : { confidence: 0 }
  },
  /** The scenario's era, read from its first bytes, picks the one tileset to bind. */
  async planInput(source: CodecCandidateSource, _evidence: unknown, signal?: AbortSignal) {
    const era =
      source.kind === 'bytes'
        ? eraOfPrefix(await source.read(0n, Number(source.size === undefined ? BigInt(ERA_PREFIX_BYTES) : source.size < BigInt(ERA_PREFIX_BYTES) ? source.size : BigInt(ERA_PREFIX_BYTES)), signal))
        : undefined
    return Object.freeze({
      originKind: 'bundle' as const,
      candidate: Object.freeze({ bindingId: 'content', role: 'content', ownership: 'owned' as const }),
      requirements: Object.freeze([tilesetRequirement(era), stringTableRequirement(UNIT_NAMES_REQUIREMENT_ID, STAT_TXT)]),
    })
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    const scenario = readScenario(bytes, textDecoderOf(context.settings))
    const era = TILESET_FILES[scenario.tileset]!
    const loaded = await loadTileset(context.input, era, Number(context.budget.maxScalarBytes), context.budget.maxNodes, context.signal)
    const strings = await loadStringTable(context.input, UNIT_NAMES_REQUIREMENT_ID, STAT_TXT, textDecoderOf(context.settings), context.signal)
    return scenarioInspection(scenario, bytes, loaded, strings, context.budget.maxNodes, 'starcraft1-chk', async grid => ({
      kind: 'edit-plan' as const,
      plan: editPlanFromInput(context.input, {
        planId: `starcraft1-chk-layer:${grid.layer}`,
        edits: [replaceBytes(0, bytes.byteLength, writeScenarioLayer(scenario, bytes, grid), `Write the ${grid.layer} layer`)],
        fidelity: {
          roundTrip: 'semantic',
          preservesUnknownData: true,
          notes: ['Only the written tiles of MTXM and TILE change; every other section, its bytes and the section order are kept'],
        },
      }),
    }))
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
