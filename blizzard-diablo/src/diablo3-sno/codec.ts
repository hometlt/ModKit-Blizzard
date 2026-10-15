/**
 * Diablo III SNO data: any group without a dedicated codec — actors, monsters, GameBalance tables,
 * scenes, worlds, powers, quests, sounds and the rest.
 *
 * The file is decoded with the type registry of the installation it came from
 * (`blizzard/diablo3-sno-registry@1`, read from the game's own executable). Its group is the folder
 * the storage files it under (`monster/…`, `gamebalance/…`), which names the root structure. The
 * executable carries no field names, so members read as their type and offset.
 */
import type { InspectionContext, InspectionTreeNode } from '@modkit/codec-kit'
import { createInspectionCodec, createTreeDataSource } from '@modkit/codec-kit'
import { foreignServiceContractId, type JsonValue } from '@modkit/sdk'
import {
  MAP_LAYERS_INPUT_SCHEMA,
  MAP_LAYERS_OPERATION,
  MAP_LAYER_READ_INPUT_SCHEMA,
  MAP_LAYER_READ_OPERATION,
} from '@modkit/sdk/maps'
import { SnoDecoder, type SnoValue } from './decode.js'
import { SNO_FIELD_NAMES } from './field-names.js'
import { sceneLayers } from './scene-layers.js'
import { createSceneWorldSource, loadSceneWorld } from './scene-world.js'
import { snoLinks } from './sno-links.js'
import { SNO_REGISTRY_CONTRACT, type SnoRegistryService } from './contract.js'
import type { SnoTypeRegistry } from './registry.js'

const ID = 'blizzard/diablo3-sno'
const MAGIC = 0xdeadbeef

/** A scene's navigation mesh through the shared map-layer operations; other groups have none. */
const operations = Object.freeze([
  Object.freeze({
    id: MAP_LAYERS_OPERATION,
    handlerId: 'map-layers',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source'] as const),
    outputKinds: Object.freeze(['json'] as const),
    inputSchema: MAP_LAYERS_INPUT_SCHEMA,
  }),
  Object.freeze({
    id: MAP_LAYER_READ_OPERATION,
    handlerId: 'map-layer-read',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source'] as const),
    outputKinds: Object.freeze(['json'] as const),
    inputSchema: MAP_LAYER_READ_INPUT_SCHEMA,
  }),
])

/** The storage path inside the installation: what the host attests, else the entry's own id. */
async function logicalPath(context: InspectionContext): Promise<string> {
  const identity = await context.logicalResources?.identity?.(context.signal)
  if (identity !== undefined) return identity.primaryLogicalId.replaceAll('\\', '/')
  const id = context.source.ref.id
  const cut = id.indexOf('!/')
  return decodeURIComponent(cut < 0 ? id : id.slice(cut + 2))
}

/** Where the linked files of a scene are looked up — the scopes the host uses for a game's own data links. */
const LINK_SCOPES = Object.freeze(['current-mount', 'enclosing-container', 'workspace-dependency-layer'] as const)
/** The host's resource session serves 256 resources to one subject; a scene's marker sets and actors fit. */
const MAX_LINKS = 240

/** Linked files by logical path, read through the host; one that does not read is absent. */
function linkedReader(context: InspectionContext) {
  return async (paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> => {
    const resources = context.logicalResources
    if (resources === undefined || paths.length === 0) return new Map()
    const batch = await resources.readBatch(
      {
        items: paths.map(logicalId => ({ requirement: { id: logicalId, logicalId, role: 'sidecar' as const, scopes: LINK_SCOPES } })),
        concurrency: 4,
        readTimeoutMs: 8000,
        totalTimeoutMs: 30000,
        maxBytes: BigInt(context.budget.maxScalarBytes),
      },
      context.signal,
    )
    return new Map(batch.items.flatMap((item, index) => (item.state === 'read' ? [[paths[index]!, item.bytes] as const] : [])))
  }
}

async function registryFor(context: InspectionContext): Promise<SnoTypeRegistry> {
  const contracts = context.contracts
  if (contracts === undefined) throw new TypeError('this host resolves no services, so the SNO type registry is unavailable')
  // an extension's own contract: resolved as foreign to the platform's typed catalogue
  const lease = await contracts.resolveUnknown({
    contract: foreignServiceContractId(SNO_REGISTRY_CONTRACT),
    major: 1,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  const service = lease.value as SnoRegistryService
  try {
    return await service.registry(context.signal === undefined ? {} : { signal: context.signal })
  } finally {
    await lease.release()
  }
}

const round = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000))
/** A keyframe value: a number, a vector, or an RGBA colour word. */
function keyValue(value: SnoValue): string {
  if (value.kind === 'vector') return `(${value.value.map(round).join(', ')})`
  if (value.kind === 'number') return value.type === 'DT_RGBACOLOR' ? `#${(value.value >>> 0).toString(16).padStart(8, '0')}` : round(value.value)
  return value.kind
}
/**
 * Animated values read as keys: a node (FloatNode, ColorNode, VectorNode, …) is its value's low and
 * high end and a time in the particle's life (0..1); a path (FloatPath, ColorPath, …) is its nodes.
 */
function curvePreview(value: Extract<SnoValue, { kind: 'structure' }>): string | undefined {
  if (/Node$/u.test(value.type) && value.members.length === 3 && value.members[2]!.value.kind === 'number') {
    const [low, high, time] = value.members.map(member => member.value)
    const [a, b] = [keyValue(low!), keyValue(high!)]
    return `t=${round((time as { value: number }).value)} ${a === b ? a : `${a}…${b}`}`
  }
  if (/Path$/u.test(value.type)) {
    const nodes = value.members.find(member => member.value.kind === 'array' && /Node$/u.test(member.value.element))?.value
    if (nodes?.kind !== 'array') return undefined
    const keys = nodes.items.flatMap(node => {
      if (node.kind !== 'structure' || node.members.length !== 3 || node.members[2]!.value.kind !== 'number') return []
      return [`${round(node.members[2]!.value.value)}→${keyValue(node.members[0]!.value)}`]
    })
    return `${keys.length} key${keys.length === 1 ? '' : 's'}${keys.length === 0 ? '' : `: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}`}`
  }
  return undefined
}

function preview(value: SnoValue, registry: SnoTypeRegistry): string {
  switch (value.kind) {
    case 'number':
      return Number.isInteger(value.value) ? String(value.value) : String(Math.round(value.value * 1e6) / 1e6)
    case 'bigint':
    case 'gbid':
      return String(value.value)
    case 'sno': {
      if (value.id === -1) return 'none'
      const extension = value.group === null ? undefined : registry.groups[value.group]
      return `SNO ${value.id}${extension === undefined ? '' : ` (${extension})`}`
    }
    case 'vector':
      return value.value.map(component => (Number.isInteger(component) ? component : Math.round(component * 1e4) / 1e4)).join(', ')
    case 'text':
      return value.value.slice(0, 200)
    case 'structure':
      return curvePreview(value) ?? `${value.type}, ${value.members.length} members`
    case 'array':
      return `${value.element}[${value.length}]`
    case 'opaque':
      return `${value.type}, ${value.bytes} bytes${value.note === undefined ? '' : ` (${value.note})`}`
  }
}

function node(label: string, value: SnoValue, registry: SnoTypeRegistry): InspectionTreeNode {
  const base = { label, preview: preview(value, registry) }
  switch (value.kind) {
    case 'structure':
      return { ...base, kind: 'structure', hasChildren: value.members.length > 0, children: () => value.members.map(member => node(member.name === undefined ? member.label : `${member.name} · ${member.label}`, member.value, registry)) }
    case 'array':
      return { ...base, kind: 'array', hasChildren: value.items.length > 0, children: () => value.items.map((item, index) => node(`[${index}]`, item, registry)) }
    case 'number':
    case 'gbid':
      return { ...base, kind: 'field', value: value.value }
    case 'sno':
      return { ...base, kind: 'reference', value: value.id }
    case 'text':
      return { ...base, kind: 'field', value: value.value }
    case 'vector':
      return { ...base, kind: 'field', value: value.value as unknown as JsonValue }
    default:
      return { ...base, kind: 'field' }
  }
}

const definition = Object.freeze({
  id: ID,
  // the registry and the storage path come through host capabilities bound only after open
  deferInspection: true,
  format: Object.freeze({ id: 'diablo3-sno', label: 'Diablo III SNO data' }),
  operations,
  async detect(prefix: Uint8Array) {
    if (prefix.byteLength < 0x20) return { confidence: 0, kind: 'magic', note: 'header-truncated' }
    // every SNO file starts so; the dedicated APP, TEX and StringList codecs claim theirs more surely
    return new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(0, true) === MAGIC
      ? { confidence: 0.6, kind: 'magic', note: 'deadbeef-sno' }
      : { confidence: 0, kind: 'magic', note: 'signature-mismatch' }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    if (bytes.byteLength < 0x1c) throw new RangeError('Diablo III SNO file is truncated')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(0, true) !== MAGIC) throw new TypeError('not a Diablo III SNO file')
    const path = await logicalPath(context)
    const folder = path.split('/').at(-2) ?? ''
    const registry = await registryFor(context)
    const decoder = new SnoDecoder(registry, SNO_FIELD_NAMES)
    const root = folder === '' ? undefined : decoder.rootOf(folder)
    if (root === undefined)
      throw new TypeError(`the SNO group of «${path}» is unknown: a Diablo III data file is opened from its folder in the game storage (monster/, gamebalance/, …)`)
    const { value, truncated } = decoder.decode(bytes, root, { maxMembers: context.budget.maxNodes, maxDepth: 64 })
    const version = view.getUint32(4, true)
    const snoId = view.getInt32(0x10, true)
    const layers = root.name === 'Scene' ? sceneLayers(value) : undefined
    // the storage prefix the scene's links are read under: `Scene/<name>.scn` sits at ''
    const storageRoot = path.split('/').slice(0, -2).map(part => `${part}/`).join('')
    const world =
      root.name === 'Scene'
        ? createSceneWorldSource({
            snapshotId: `diablo3-scene:${snoId}`,
            mapId: path,
            root: storageRoot,
            ...(context.modelResources === undefined ? {} : { models: context.modelResources }),
            load: () => loadSceneWorld({ scene: value, decoder, registry, root: storageRoot, read: linkedReader(context), maxLinks: MAX_LINKS }),
          })
        : undefined
    const noLayers = 'only a scene has a navigation mesh to show as map layers'
    return {
      summary: {
        format: 'diablo3-sno',
        group: root.name,
        version,
        snoId,
        rootBytes: root.size,
        members: value.kind === 'structure' ? value.members.length : 0,
        truncated,
      },
      metadata: [
        {
          id: 'diablo3-sno',
          label: `Diablo III ${root.name}`,
          entries: [
            { key: 'group', value: root.name },
            { key: 'version', value: version },
            { key: 'snoId', value: snoId },
          ],
        },
      ],
      traits: [{ id: 'content.binary', parameters: { version } }],
      diagnostics: truncated
        ? [
            {
              id: 'blizzard.diablo3-sno/truncated',
              severity: 'warning' as const,
              category: 'performance' as const,
              code: 'blizzard.diablo3-sno/truncated',
              message: `the file holds more members than the ${context.budget.maxNodes} the budget allows; the rest is not shown`,
            },
          ]
        : [],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource(node(`${root.name} ${snoId}`, value, registry)),
        'common.view/relation-graph-source': snoLinks(value, { group: root.name, snoId }, registry.groups, `diablo3-sno:${snoId}`),
        ...(world === undefined ? {} : { 'common.view/world-scene-source': world }),
      },
      ...(layers === undefined
        ? {
            operationStates: [
              { id: MAP_LAYERS_OPERATION, state: 'disabled' as const, reason: noLayers },
              { id: MAP_LAYER_READ_OPERATION, state: 'disabled' as const, reason: noLayers },
            ],
          }
        : {
            handlers: {
              'map-layers': async () => ({ kind: 'json' as const, value: { layers: layers.layers } as unknown as JsonValue }),
              'map-layer-read': async (input: unknown) => ({ kind: 'json' as const, value: layers.read(input) as unknown as JsonValue }),
            },
          }),
      unsupportedFeatures: ['sno-field-names', 'sno-writing'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
