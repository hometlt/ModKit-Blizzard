/**
 * StarCraft map codec (`.scm`, `.scx`): opened over the host's `blizzard/mpq` container alias, it
 * reads the map's scenario (`staredit\scenario.chk`) and publishes it as a tree, its players as a
 * table, its terrain as map layers and, with the installation's tileset behind it (the subject's
 * workspace dependency layer), as the image the game draws. A layer write is a plan replacing the scenario entry; the
 * host packs it back into the map through the container. Protected maps list no names: the
 * scenario is found by its exact path, which the MPQ hash table answers without a listfile.
 */
import type { NamespaceInspectionContext } from '@modkit/codec-kit'
import type { ArtifactSource, AssetNamespace, CodecCandidateSource, OperationDecl } from '@modkit/sdk'
import { createInspectionCodec } from '@modkit/codec-kit'
import {
  MAP_LAYERS_INPUT_SCHEMA,
  MAP_LAYERS_OPERATION,
  MAP_LAYER_READ_INPUT_SCHEMA,
  MAP_LAYER_READ_OPERATION,
  MAP_LAYER_WRITE_INPUT_SCHEMA,
  MAP_LAYER_WRITE_OPERATION,
  type MapLayerGrid,
} from '@modkit/sdk/maps'
import { ERA_PREFIX_BYTES, TILESET_FILES, eraOfPrefix, readScenario } from '../chk/scenario.js'
import { SCENARIO_ENTRY, UNIT_NAMES_REQUIREMENT_ID, scenarioInspection, writeScenarioLayer } from '../chk/view.js'
import { STAT_TXT, loadStringTable, stringTableRequirement } from '../tbl/companion.js'
import { loadTileset, tilesetRequirement } from '../tileset/companion.js'
import { textDecoderOf } from '../text.js'

const operations = [
  { id: MAP_LAYERS_OPERATION as OperationDecl['id'], handlerId: 'map-layers', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], inputSchema: MAP_LAYERS_INPUT_SCHEMA },
  { id: MAP_LAYER_READ_OPERATION as OperationDecl['id'], handlerId: 'map-layer-read', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], inputSchema: MAP_LAYER_READ_INPUT_SCHEMA },
  { id: MAP_LAYER_WRITE_OPERATION as OperationDecl['id'], handlerId: 'map-layer-write', mutatesSource: true, requiredPermissions: ['read-source', 'write-source'], outputKinds: ['edit-plan'], inputSchema: MAP_LAYER_WRITE_INPUT_SCHEMA },
] satisfies readonly OperationDecl[]

interface Entry {
  readonly bytes: Uint8Array
  readonly ref: ArtifactSource['ref']
  readonly revision: ArtifactSource['revision']
}

async function readScenarioEntry(namespace: AssetNamespace, maximum: number, signal?: AbortSignal): Promise<Entry> {
  const lease = await namespace.open(SCENARIO_ENTRY, signal)
  try {
    const source = lease.value
    if (source.kind !== 'bytes' || source.size === undefined) throw new TypeError(`${SCENARIO_ENTRY} is not a sized file`)
    if (source.size > BigInt(maximum)) throw new RangeError(`${SCENARIO_ENTRY} is ${String(source.size)} bytes, more than ${String(maximum)}`)
    const bytes = new Uint8Array(Number(source.size))
    for (let offset = 0; offset < bytes.byteLength; ) {
      signal?.throwIfAborted()
      const chunk = await source.read(BigInt(offset), Math.min(1 << 20, bytes.byteLength - offset), signal)
      if (chunk.byteLength === 0) throw new RangeError(`${SCENARIO_ENTRY} ended early`)
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, ref: source.ref, revision: source.revision }
  } finally {
    await lease.release()
  }
}

/** The era of the map's scenario from its first bytes; `undefined` when it cannot be read so early. */
async function mapEra(source: CodecCandidateSource, signal?: AbortSignal): Promise<number | undefined> {
  if (source.kind !== 'namespace') return undefined
  try {
    const namespace = await source.openNamespace(signal)
    try {
      const entry = await namespace.value.open(SCENARIO_ENTRY, signal)
      try {
        const scenario = entry.value
        if (scenario.kind !== 'bytes') return undefined
        const length = scenario.size === undefined || scenario.size > BigInt(ERA_PREFIX_BYTES) ? ERA_PREFIX_BYTES : Number(scenario.size)
        return eraOfPrefix(await scenario.read(0n, length, signal))
      } finally {
        await entry.release()
      }
    } finally {
      await namespace.release()
    }
  } catch {
    return undefined
  }
}

const definition = Object.freeze({
  id: 'blizzard/starcraft1-map',
  format: Object.freeze({ id: 'starcraft1-map', label: 'StarCraft map' }),
  operations,
  namespace: Object.freeze({
    async detect(markers: readonly { readonly path: string; readonly kind: string }[]) {
      return markers.some(marker => marker.kind === 'file' && marker.path.replaceAll('\\', '/').toLowerCase() === SCENARIO_ENTRY)
        ? { confidence: 0.97, kind: 'structure' as const, note: SCENARIO_ENTRY }
        : { confidence: 0, kind: 'structure' as const, note: `${SCENARIO_ENTRY}-missing` }
    },
    async inspect(namespace: AssetNamespace, context: NamespaceInspectionContext) {
      const entry = await readScenarioEntry(namespace, Number(context.budget.maxScalarBytes), context.signal)
      const scenario = readScenario(entry.bytes, textDecoderOf(context.settings))
      const era = TILESET_FILES[scenario.tileset]!
      const loaded = await loadTileset(context.input, era, Number(context.budget.maxScalarBytes), context.budget.maxNodes, context.signal)
      const strings = await loadStringTable(context.input, UNIT_NAMES_REQUIREMENT_ID, STAT_TXT, textDecoderOf(context.settings), context.signal)
      return {
        detection: { confidence: 0.97, kind: 'structure' as const, note: SCENARIO_ENTRY },
        ...scenarioInspection(scenario, entry.bytes, loaded, strings, context.budget.maxNodes, 'starcraft1-map.scenario', async grid => {
          const expected = (grid as MapLayerGrid & { readonly expectedSourceRevision?: unknown }).expectedSourceRevision
          if (expected !== undefined && expected !== String(namespace.revision)) throw new RangeError('the map changed since this layer was read')
          const bytes = writeScenarioLayer(scenario, entry.bytes, grid)
          const targetId = `entry:${SCENARIO_ENTRY}`
          return {
            kind: 'edit-plan' as const,
            plan: {
              planId: `starcraft1-map-layer:${grid.layer}:${String(namespace.revision)}`,
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
                payload: { kind: 'inline' as const, bytes },
                label: `Write the ${grid.layer} layer into ${SCENARIO_ENTRY}`,
              }],
              semantics: { mutationMode: 'mutate' as const, minimumGuarantee: 'atomic' as const },
              fidelity: {
                roundTrip: 'semantic' as const,
                preservesUnknownData: true,
                notes: ['Only the written tiles of MTXM and TILE change; every other section, its bytes and the section order are kept'],
              },
              diagnostics: [],
            },
          }
        }),
      }
    },
  }),
  /**
   * The map's tileset lies in the installation behind it (its workspace dependency layer); the era
   * its scenario names, read from the scenario's first bytes, picks the one tileset to bind.
   */
  async planInput(source: CodecCandidateSource, _evidence: unknown, signal?: AbortSignal) {
    return Object.freeze({ originKind: 'namespace' as const, requirements: Object.freeze([tilesetRequirement(await mapEra(source, signal)), stringTableRequirement(UNIT_NAMES_REQUIREMENT_ID, STAT_TXT)]) })
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
