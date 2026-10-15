import { operationId } from '@modkit/core'
import type {
  ContributionContext,
  JsonValue,
  OperationDecl,
  OperationOutput,
  RevisionId,
  SubjectCatalogPort,
  SubjectSelectorSource,
} from '@modkit/sdk'
import { namespaceEntryEditTarget } from '@modkit/sdk'
import { isJsonSerializable } from '@modkit/codec-kit'
import { dequantizeCliffLevel, getObjectEntityLinks, textureMaskWeight } from '../../../shared/format/index.js'
import { looksLikeWizardFile, parseWizardDocument } from '../../../../wizard/codecs/wizard/src/core/parse.js'
import {
  parseSc2MapDocuments,
  serializeSc2MapDocuments,
  type SC2MapDocumentData,
} from '../../../shared/coordinator.js'
import {
  cellFlagsToPng,
  cliffLevelToPng,
  composeOverlayToPng,
  heightToPng,
  overlayToPng,
  PATHING_UNKNOWN_COLOR,
  PATHING_VALUES,
  paintedPathingToPng,
  pathingToPng,
  textureToPng,
  vertexColorToPng,
} from '../../../shared/image/map-image.js'
import {
  type CatalogSnapshot,
  analyzeCellCliffLevels,
  analyzeVertexCliffLevels,
  cellCliffLevelsToPng,
  cliffLevelColor,
  mapOverviewToPng,
  vertexCliffLevelsToPng,
} from '../../../shared/image/overview.js'
import {
  analyzeMapNavigation,
  findRouteAlternatives,
  navigationToPng,
  sc2MapSpatialData,
  type NavigationLayer,
} from '../../../shared/navigation/index.js'
import {
  parseDocumentHeader,
  parseDocumentInfo,
  parseVersionFile,
} from '../../../../mod/codecs/document-metadata/core/index.js'
import { createSc2DirectoryCodec } from '../../../../../shared/package-namespace/runtime.js'
import { readSc2ModOfFiles } from '../../../../mod/shared/core/mod-of-files.js'
import { isSemanticModEntry } from '../../../../mod/shared/core/document-routes.js'
import { modEntitySelector } from '../../../../mod/services/resources/src/entity-selector.js'
import { applyStarcraft2MapWorldEdits } from './world-writer.js'
import {
  MAP_LAYERS_INPUT_SCHEMA,
  MAP_LAYERS_OPERATION,
  MAP_LAYER_READ_INPUT_SCHEMA,
  MAP_LAYER_READ_OPERATION,
  MAP_LAYER_WRITE_INPUT_SCHEMA,
  MAP_LAYER_WRITE_OPERATION,
  mapLayerWindow,
  type MapLayerCategory,
  type MapLayerDescriptor,
  type MapLayerGrid,
  type MapPictureDescriptor,
  type MapLayerReadRequest,
} from '@modkit/sdk/maps'

const ID = 'blizzard/sc2-map'
const utf8 = new TextDecoder('utf-8', { fatal: false })

export const SC2_MAP_OPERATION_MAP = Object.freeze({
  'sc2-map.detect': { id: 'blizzard/sc2-map.detect', handlerId: 'detect-map', outputKinds: ['json'] },
  'sc2-map.open': { id: 'blizzard/sc2-map.open', handlerId: 'open-map', outputKinds: ['json'] },
  'sc2-map.embedded': { id: 'blizzard/sc2-map.embedded', handlerId: 'embedded-map', outputKinds: ['json'] },
  'sc2-map.metadata': { id: 'blizzard/sc2-map.metadata', handlerId: 'metadata-map', outputKinds: ['json'] },
  'view.inspect': { id: 'view.inspect', handlerId: 'inspect', outputKinds: ['json'] },
  'asset.validate': { id: 'asset.validate', handlerId: 'validate', outputKinds: ['json'] },
  'view.thumbnail': { id: 'view.thumbnail', handlerId: 'thumbnail', outputKinds: ['bytes'] },
  'view.render': { id: 'view.render', handlerId: 'render-preview', outputKinds: ['bytes'] },
  'sc2-map.world': { id: 'blizzard/sc2-map.world', handlerId: 'world-map', outputKinds: ['json'] },
  'container.extract': { id: 'container.extract', handlerId: 'extract-entry', outputKinds: ['bytes'] },
  'sc2-map.extract-modeled': { id: 'blizzard/sc2-map.extract-modeled', handlerId: 'extract-modeled', outputKinds: ['bytes'] },
  'export.raw': { id: 'export.raw', handlerId: 'export-raw', outputKinds: ['bytes'] },
  'blizzard/sc2-map.edit-world': {
    id: 'blizzard/sc2-map.edit-world', handlerId: 'edit-world', outputKinds: ['edit-plan'],
  },
  [MAP_LAYERS_OPERATION]: { id: MAP_LAYERS_OPERATION, handlerId: 'map-layers', outputKinds: ['json'], inputSchema: MAP_LAYERS_INPUT_SCHEMA },
  [MAP_LAYER_READ_OPERATION]: { id: MAP_LAYER_READ_OPERATION, handlerId: 'map-layer-read', outputKinds: ['json'], inputSchema: MAP_LAYER_READ_INPUT_SCHEMA },
  [MAP_LAYER_WRITE_OPERATION]: { id: MAP_LAYER_WRITE_OPERATION, handlerId: 'map-layer-write', outputKinds: ['edit-plan'], inputSchema: MAP_LAYER_WRITE_INPUT_SCHEMA },
} as const)

export const SC2_MAP_OPERATION_MAP_VERSION = 1

function operationsFor(contributionId: string): readonly OperationDecl[] {
  return Object.freeze(
  (Object.entries(SC2_MAP_OPERATION_MAP) as Array<[
    keyof typeof SC2_MAP_OPERATION_MAP,
    (typeof SC2_MAP_OPERATION_MAP)[keyof typeof SC2_MAP_OPERATION_MAP],
  ]>)
    .filter(([legacyId]) => legacyId !== 'container.extract')
    .map(([legacyId, mapping]) => {
      const mutatesSource = legacyId === 'blizzard/sc2-map.edit-world' || legacyId === MAP_LAYER_WRITE_OPERATION
      const requestedId = mapping.id.startsWith(`${ID}.`)
        ? `${contributionId}${mapping.id.slice(ID.length)}`
        : mapping.id
      return {
        id: operationId(requestedId, { contributionId }),
        handlerId: mapping.handlerId,
        mutatesSource,
        requiredPermissions: mutatesSource ? ['read-source', 'write-source'] : ['read-source'],
        outputKinds: mapping.outputKinds,
        ...('inputSchema' in mapping ? { inputSchema: mapping.inputSchema } : {}),
      } satisfies OperationDecl
    }),
  )
}
const operations = operationsFor(ID)

type NamespaceEntry = Readonly<{
  id: string
  path: string
  name: string
  kind: 'file' | 'directory'
  size?: bigint
}>
type ExtensionContext = Readonly<{
  entries: readonly NamespaceEntry[]
  namespace: Readonly<{ open(path: string, signal?: AbortSignal): Promise<Readonly<{ value: NamespaceBytes; release(): Promise<void> }>> }>
  context: Readonly<{ budget: Readonly<{ maxScalarBytes: number | bigint; maxInputBytes: number | bigint; maxNodes: number }>; signal?: AbortSignal }>
  root: Readonly<{ id: string; uri: string }>
  /** DocumentInfo package references, as the shared package runtime read them. */
  declaredDependencies: readonly string[]
  revision: string
  readEntry(path: string, limit?: number | bigint, signal?: AbortSignal): Promise<Uint8Array>
}>

type NamespaceBytes = Readonly<{
  kind: string
  size?: bigint
  ref: Readonly<{ id: string; uri: string }>
  revision: RevisionId
  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>
}>

interface ParseFailure { readonly path: string; readonly message: string }
interface ParsedMap {
  readonly files: Map<string, Uint8Array>
  readonly data: SC2MapDocumentData
  readonly parseFailures: readonly ParseFailure[]
  readonly metadataFailures: readonly ParseFailure[]
  readonly documentHeader?: unknown
  readonly documentInfo?: unknown
  readonly versionFiles: Readonly<Record<string, unknown>>
  readonly dataWizards: readonly Readonly<{ path: string; value: unknown }>[]
}

const basename = (path: string): string => path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''

function portable(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return String(value)
  if (value instanceof Uint8Array) return { byteLength: value.byteLength }
  if (Array.isArray(value)) return value.map(portable)
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()]
        .map(([key, item]) => [String(key), portable(item)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    )
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
      if (item !== undefined) result[key] = portable(item)
    }
    return result
  }
  return String(value)
}

function json(value: unknown): OperationOutput {
  const valueJson = portable(value)
  if (!isJsonSerializable(valueJson)) throw new TypeError('SC2 map operation produced non-JSON data')
  return { kind: 'json', value: valueJson }
}

function modeledComponents(data: SC2MapDocumentData): readonly string[] {
  return Object.keys(data).filter(key => key !== 'rawFiles' && data[key as keyof SC2MapDocumentData] !== undefined).sort()
}

function dimensions(data: SC2MapDocumentData): Readonly<{ width?: number; height?: number }> {
  if (data.info !== undefined) return { width: data.info.width, height: data.info.height }
  if (data.pathing !== undefined) return { width: data.pathing.sizeX, height: data.pathing.sizeY }
  if (data.cliffLevel !== undefined) return { width: data.cliffLevel.sizeX, height: data.cliffLevel.sizeY }
  if (data.height !== undefined) return { width: data.height.sizeX - 1, height: data.height.sizeY - 1 }
  return {}
}

async function parseNamespace(context: ExtensionContext): Promise<ParsedMap> {
  const files = new Map<string, Uint8Array>()
  let total = 0
  const maximum = Math.min(Number(context.context.budget.maxInputBytes), Number.MAX_SAFE_INTEGER)
  for (const entry of context.entries) {
    if (entry.kind !== 'file') continue
    context.context.signal?.throwIfAborted()
    const bytes = await context.readEntry(entry.path, context.context.budget.maxScalarBytes, context.context.signal)
    total += bytes.byteLength
    if (total > maximum) throw new RangeError('SC2 map namespace exceeds the input byte budget')
    files.set(entry.path, bytes)
  }
  const failures: ParseFailure[] = []
  const data = parseSc2MapDocuments(files, {
    onError: (path, error) => failures.push({
      path,
      message: error instanceof Error ? error.message : String(error),
    }),
  })
  const metadataFailures: ParseFailure[] = []
  let documentHeader: unknown
  let documentInfo: unknown
  const versionFiles: Record<string, unknown> = {}
  const dataWizards: Array<Readonly<{ path: string; value: unknown }>> = []
  for (const [path, bytes] of files) {
    const name = basename(path)
    try {
      if (name === 'documentheader') documentHeader = parseDocumentHeader(bytes)
      else if (name === 'documentinfo') documentInfo = parseDocumentInfo(utf8.decode(bytes))
      else if (name.endsWith('.version')) versionFiles[path.slice(0, -'.version'.length)] = parseVersionFile(bytes)
      else if (name.endsWith('.blizwiz') || looksLikeWizardFile(utf8.decode(bytes.subarray(0, 4096)))) {
        const document = parseWizardDocument(utf8.decode(bytes))
        if (document.file.rootKind !== 'wizardfile') throw new Error('SC2 wizard requires a <wizardfile> root')
        dataWizards.push({ path, value: document.file })
      }
    } catch (error) {
      metadataFailures.push({ path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    files,
    data,
    parseFailures: Object.freeze(failures),
    metadataFailures: Object.freeze(metadataFailures),
    ...(documentHeader === undefined ? {} : { documentHeader }),
    ...(documentInfo === undefined ? {} : { documentInfo }),
    versionFiles: Object.freeze(versionFiles),
    dataWizards: Object.freeze(dataWizards),
  }
}

type MapForm = Readonly<{ format: string; topology: string }>

function summary(parsed: ParsedMap, form: MapForm): Readonly<Record<string, JsonValue>> {
  const size = dimensions(parsed.data)
  return Object.freeze({
    format: form.format,
    topology: form.topology,
    embeddedFiles: parsed.files.size,
    recognizedEntries: parsed.files.size - parsed.data.rawFiles.size + modeledComponents(parsed.data).length,
    modeledComponents: modeledComponents(parsed.data),
    parseFailures: parsed.parseFailures.length,
    metadataFailures: parsed.metadataFailures.length,
    dataWizards: parsed.dataWizards.length,
    versionFiles: Object.keys(parsed.versionFiles).length,
    ...(size.width === undefined ? {} : { width: size.width }),
    ...(size.height === undefined ? {} : { height: size.height }),
  })
}

/**
 * The map's own facts for the card (MK2's archive summary): its name from DocumentHeader (enUS first),
 * MapInfo's size, playable area, theme and planet strings and version, and the start locations Objects
 * places. Each fact names the document it came from.
 */
function mapFactGroups(parsed: ParsedMap, root: unknown): readonly JsonValue[] {
  const facts: JsonValue[] = []
  const fact = (id: string, label: string, value: JsonValue, semanticPath: readonly string[]) =>
    facts.push(Object.freeze({
      id, label, value,
      provenance: Object.freeze([Object.freeze({ label: semanticPath[0]!, source: root as JsonValue, semanticPath: Object.freeze([...semanticPath]) })]),
    }))
  const header = parsed.documentHeader as { readonly entries?: readonly { key: string; type: string; value: string }[] } | undefined
  const names = (header?.entries ?? []).filter(entry => entry.key === 'DocInfo/Name' && entry.value.length > 0)
  const name = (names.find(entry => entry.type === 'SUne') ?? names[0])?.value
  if (name !== undefined) fact('name', 'Name', name, ['DocumentHeader', 'DocInfo/Name'])
  const info = parsed.data.info
  if (info !== undefined) {
    fact('size', 'Size', `${info.width} × ${info.height}`, ['MapInfo', 'size'])
    const bounds = info.boundary
    if (bounds !== undefined) {
      fact('playable', 'Playable area', `${bounds.left}, ${bounds.bottom} – ${bounds.right}, ${bounds.top} (${bounds.right - bounds.left} × ${bounds.top - bounds.bottom})`, ['MapInfo', 'boundary'])
    }
    const [theme, planet] = info.strings
    if (theme !== undefined) fact('theme', 'Theme', theme, ['MapInfo', 'strings', '0'])
    if (planet !== undefined) fact('planet', 'Planet', planet, ['MapInfo', 'strings', '1'])
    fact('version', 'MapInfo version', info.version, ['MapInfo', 'version'])
  }
  const starts = parsed.data.objects?.points.filter(point => point.type === 'StartLoc').length ?? 0
  if (starts > 0) fact('startLocations', 'Start locations', starts, ['Objects', 'StartLoc'])
  return facts.length === 0 ? [] : [Object.freeze({ id: 'map', label: 'Map', facts: Object.freeze(facts) })]
}

function embeddedProjection(parsed: ParsedMap): JsonValue {
  const result: Record<string, JsonValue> = {}
  for (const component of modeledComponents(parsed.data)) {
    result[component] = portable(parsed.data[component as keyof SC2MapDocumentData])
  }
  result['dataWizards'] = portable(parsed.dataWizards)
  result['rawFiles'] = [...parsed.files.keys()].sort()
  return result
}

function metadataProjection(parsed: ParsedMap): JsonValue {
  return portable({
    mapInfo: parsed.data.info,
    scenarioProperties: parsed.data.scenarioProperties,
    documentHeader: parsed.documentHeader,
    documentInfo: parsed.documentInfo,
    versionFiles: parsed.versionFiles,
    locales: parsed.data.locales,
    includes: parsed.data.includes,
    fileHash: parsed.data.fileHash,
  })
}

function worldProjection(data: SC2MapDocumentData): JsonValue {
  return portable({
    dimensions: dimensions(data),
    terrain: data.terrain,
    height: data.height === undefined ? undefined : { sizeX: data.height.sizeX, sizeY: data.height.sizeY },
    pathing: data.pathing === undefined ? undefined : { sizeX: data.pathing.sizeX, sizeY: data.pathing.sizeY },
    cellAttributes: data.cellAttributes === undefined ? undefined : Object.fromEntries(
      Object.entries(data.cellAttributes).map(([suffix, document]) => [
        suffix,
        {
          path: document.path,
          byteLength: document.byteLength,
          missingContext: document.missingContext,
          sizeX: document.value?.sizeX,
          sizeY: document.value?.sizeY,
        },
      ]),
    ),
    paintedCreep: data.paintedCreep === undefined ? undefined : {
      bounds: data.paintedCreep.bounds,
      byteLength: data.paintedCreep.raw.byteLength,
    },
    objects: data.objects === undefined ? undefined : {
      units: data.objects.units,
      doodads: data.objects.doodads,
      points: data.objects.points,
      cameras: data.objects.cameras,
    },
    regions: data.regions?.regions,
    relations: data.objects === undefined ? [] : getObjectEntityLinks(data.objects),
  })
}

const isJsonRecord = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function preview(parsed: ParsedMap, input: JsonValue): Uint8Array {
  const request = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, JsonValue>
    : {}
  const layer = typeof request['layer'] === 'string' ? request['layer'] : 'auto'
  const map = parsed.data
  const scale = typeof request['pixelsPerCell'] === 'number' ? request['pixelsPerCell'] : undefined
  // Top-down map preview: cliff levels, cliff faces, ramps, pathing, resources, start locations, bounds.
  const flag = (name: string) => (typeof request[name] === 'boolean' ? { [name]: request[name] } : {})
  const catalog = isJsonRecord(request['catalog'])
    ? (request['catalog'] as unknown as CatalogSnapshot)
    : undefined
  // Strategic navigation graph over the overview: regions, ramps, expansions, portals and, with
  // `route: [from, to]` (node ids), every alternative route class between them.
  if (layer === 'navigation' && map.height !== undefined && map.terrain !== undefined) {
    const spatial = sc2MapSpatialData(map, catalog, {
      ...(typeof request['groundCellSize'] === 'number' ? { groundCellSize: request['groundCellSize'] } : {}),
    })
    const navigation = analyzeMapNavigation(spatial, {
      area: {
        ...(typeof request['areaRadius'] === 'number' ? { maxRadius: request['areaRadius'] } : {}),
        ...(typeof request['resourceAreaRadius'] === 'number'
          ? { resourceRadius: request['resourceAreaRadius'] }
          : {}),
      },
    })
    const route = request['route']
    const routes =
      Array.isArray(route) && route.length === 2 && route.every(item => typeof item === 'string')
        ? findRouteAlternatives(navigation, route[0] as string, route[1] as string, {
            ...(isJsonRecord(request['layers']) && request['layers']['predrop'] === true
              ? {}
              : { capabilities: ['destroy', 'mine', 'cliff'] as const }),
          })
        : []
    const layers = isJsonRecord(request['layers'])
      ? Object.fromEntries(
          Object.entries(request['layers']).filter(
            (entry): entry is [NavigationLayer, boolean] => typeof entry[1] === 'boolean',
          ),
        )
      : undefined
    return navigationToPng(map, navigation, {
      routes,
      spatial,
      ...(layers === undefined ? {} : { layers }),
      overview: {
        ...(scale === undefined ? {} : { pixelsPerCell: scale }),
        ...(catalog === undefined ? {} : { catalog }),
      },
    })
  }
  if (layer === 'overview' && map.height !== undefined && map.terrain !== undefined) {
    return mapOverviewToPng(map, {
      ...(scale === undefined ? {} : { pixelsPerCell: scale }),
      ...flag('pathing'),
      ...flag('markers'),
      ...flag('bounds'),
      ...flag('latticeDots'),
      ...flag('grid'),
      ...(typeof request['minWalkableArea'] === 'number'
        ? { minWalkableArea: request['minWalkableArea'] }
        : {}),
      // The resolved catalog snapshot (`{ definitions }` or `{ entities }`) the map's scene uses.
      ...(catalog === undefined ? {} : { catalog }),
    })
  }
  // t3HeightMap: the cliff level of every vertex; t3SyncCliffLevel: the cliff level of every cell.
  if (layer === 'cliff-vertices' && map.height !== undefined && map.terrain !== undefined)
    return vertexCliffLevelsToPng(analyzeVertexCliffLevels(map.height, map.terrain), scale === undefined ? {} : { pixelsPerVertex: scale })
  if (layer === 'cliff-cells' && map.cliffLevel !== undefined)
    return cellCliffLevelsToPng(analyzeCellCliffLevels(map.cliffLevel), scale === undefined ? {} : { pixelsPerCell: scale })
  // `channel`: base (default), adjustments or sum (base + adjustments, the surface the game draws);
  // `height-sum` names the sum as a layer of its own.
  if ((layer === 'auto' || layer === 'height' || layer === 'height-sum') && map.height !== undefined) {
    const channel = layer === 'height-sum' ? 'sum' : request['channel'] === 'sum' || request['channel'] === 'adjustments' ? request['channel'] : 'base'
    return heightToPng(map.height, channel)
  }
  // Texture masks with the object, region and water overlay drawn over them (MK2 «Texture + Overlay»).
  if (layer === 'texture-overlay' && map.textureMasks !== undefined) {
    return composeOverlayToPng(textureToPng(map.textureMasks), map)
  }
  if ((layer === 'auto' || layer === 'cliff') && map.cliffLevel !== undefined) return cliffLevelToPng(map.cliffLevel)
  if ((layer === 'auto' || layer === 'pathing') && map.pathing !== undefined) return pathingToPng(map.pathing)
  if ((layer === 'auto' || layer === 'cell-flags') && map.cellFlags !== undefined) return cellFlagsToPng(map.cellFlags)
  if ((layer === 'auto' || layer === 'painted-pathing') && map.paintedPathing !== undefined) {
    const rendered = paintedPathingToPng(map.paintedPathing)
    if (rendered !== null) return rendered
  }
  if ((layer === 'auto' || layer === 'texture') && map.textureMasks !== undefined) return textureToPng(map.textureMasks)
  if (layer === 'vertex-color' && map.vertexColor !== undefined) {
    return vertexColorToPng(map.vertexColor, {
      ...(typeof request['width'] === 'number' ? { width: request['width'] } : {}),
      ...(typeof request['height'] === 'number' ? { height: request['height'] } : {}),
      ...(typeof request['cellScale'] === 'number' ? { cellScale: request['cellScale'] } : {}),
    })
  }
  if (layer === 'overlay' || (layer === 'auto' && (map.info !== undefined || map.objects !== undefined || map.regions !== undefined || map.water !== undefined))) {
    return overlayToPng(map, {
      ...(typeof request['width'] === 'number' ? { width: request['width'] } : {}),
      ...(typeof request['height'] === 'number' ? { height: request['height'] } : {}),
      ...(typeof request['cellScale'] === 'number' ? { cellScale: request['cellScale'] } : {}),
    })
  }
  throw new RangeError(`The SC2 map has no renderable '${layer}' preview layer`)
}

function encodeNamespace(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let length = 0
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const name = encoder.encode(path.replaceAll('\\', '/'))
    const chunk = new Uint8Array(name.byteLength + bytes.byteLength + 2)
    chunk.set(name)
    chunk[name.byteLength] = 0
    chunk.set(bytes, name.byteLength + 1)
    chunks.push(chunk)
    length += chunk.byteLength
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

async function openEntryBytes(namespace: ExtensionContext['namespace'], path: string, maximum: number, signal?: AbortSignal) {
  const lease = await namespace.open(path, signal)
  try {
    const source = lease.value
    if (source.kind !== 'bytes' || source.size === undefined) throw new TypeError(`SC2 map entry is not a sized byte file: ${path}`)
    if (source.size > BigInt(maximum) || source.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`SC2 map entry exceeds its ${maximum}-byte read budget: ${path}`)
    const bytes = new Uint8Array(Number(source.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      signal?.throwIfAborted()
      const chunk = await source.read(BigInt(offset), Math.min(64 * 1024, bytes.byteLength - offset), signal)
      if (chunk.byteLength === 0) throw new RangeError(`SC2 map entry ended early: ${path}`)
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return Object.freeze({ path, bytes, ref: source.ref, revision: source.revision })
  } finally { await lease.release() }
}

function entryRevision(source: Awaited<ReturnType<typeof openEntryBytes>>) {
  return Object.freeze({
    bindings: Object.freeze({ content: source.revision }),
    compositionFingerprint: `namespace-entry:${String(source.revision)}:${source.ref.id}`,
  })
}

const EDIT_BASENAMES = new Set(['objects', 'mapobjects', 'regions', 'mapregions', 't3heightmap', 'mapheightmap', 't3syncpathinginfo', 'mappathinginfo', 't3syncclifflevel', 'mapsyncclifflevel', 't3texturemasks', 'maptexturemasks', 'preload'])

/**
 * The map's grid layers (`map.layers`): the height map's base, the cell cliff levels and the
 * pathing flags, each a uint16 per sample. Values go out north row first, as an image shows the
 * map; the documents keep the south row first. SC2 water is zones, not a grid, so it is no layer.
 *
 * The height layer samples vertices. With `t3Terrain.xml` it also says what a sample means:
 * the base term of the engine's vertex height (ADR-WORLD-001), `heightBase · quantizeScale ·
 * scale.z + offset.z − quantizeBias · scale.z`, in SC2 game units. The vertex's cliff offset
 * (`heightAdjustments`) is not part of the layer, so a cliff vertex stands higher or lower by it.
 */
function mapLayers(data: SC2MapDocumentData): ReadonlyMap<string, { readonly descriptor: MapLayerDescriptor; values(): number[] }> {
  const layers = new Map<string, { readonly descriptor: MapLayerDescriptor; values(): number[] }>()
  const add = (id: string, label: string, meaning: MapLayerDescriptor['meaning'], width: number, height: number, at: (index: number) => number, world: Partial<MapLayerDescriptor> = {}) =>
    layers.set(id, {
      descriptor: Object.freeze({ id, label, meaning, width, height, minimum: 0, maximum: 0xffff, editable: true, ...world }),
      values: () => {
        const values = new Array<number>(width * height)
        for (let row = 0; row < height; row += 1) {
          for (let x = 0; x < width; x += 1) values[row * width + x] = at((height - 1 - row) * width + x)
        }
        return values
      },
    })
  const { height, cliffLevel, pathing, terrain, textureMasks } = data
  const scaleZ = terrain?.scaleZ ?? 1
  const heightWorld: Partial<MapLayerDescriptor> =
    terrain !== undefined && terrain.quantizeScale > 0 && Number.isFinite(terrain.quantizeScale * scaleZ)
      ? {
          valueScale: terrain.quantizeScale * scaleZ,
          valueOffset: (terrain.offsetZ ?? 0) - terrain.quantizeBias * scaleZ,
          unit: 'sc2-game-unit',
          sampling: 'vertex',
        }
      : { sampling: 'vertex' }
  if (height !== undefined) add('height', 'Height (t3HeightMap base, without cliff offsets)', 'height', height.sizeX, height.sizeY, index => height.cells[index]!.heightBase, heightWorld)
  if (cliffLevel !== undefined) {
    // Each stored value names the cliff level the engine rounds it to, in the preview's colours.
    const categories = legend(cliffLevel.heights, value => {
      const level = dequantizeCliffLevel(value)
      return { label: `Cliff level ${String(level)}`, color: cliffLevelColor(level) }
    })
    add('cliff-level', 'Cliff level (t3SyncCliffLevel)', 'cliff-level', cliffLevel.sizeX, cliffLevel.sizeY, index => cliffLevel.heights[index]!, categories === undefined ? {} : { categories })
  }
  if (pathing !== undefined) {
    const categories = legend(pathing.blocks, value => {
      const known = PATHING_VALUES.find(item => item.value === value)
      return known ?? { label: `Flags 0x${value.toString(16).padStart(2, '0')}`, color: PATHING_UNKNOWN_COLOR }
    })
    add('pathing', 'Pathing flags (t3SyncPathingInfo)', 'pathing', pathing.sizeX, pathing.sizeY, index => pathing.blocks[index]!, categories === undefined ? {} : { categories })
  }
  if (textureMasks !== undefined) for (let slot = 0; slot < textureMasks.layers; slot++)
    add(`texture-weight-${slot}`, `Texture weight slot ${slot}`, 'texture-weight', textureMasks.sizeX, textureMasks.sizeY,
      index => textureMaskWeight(textureMasks, slot, index % textureMasks.sizeX, Math.floor(index / textureMasks.sizeX)),
      { maximum: 15, valueScale: 1 / 15, valueOffset: 0, unit: 'normalized-weight', sampling: 'cell' })
  return layers
}

/** At most this many distinct values get a legend; a layer with more is a ramp, not classes. */
const MAX_LAYER_CATEGORIES = 64

/** The legend of a layer of classes (sdk `MapLayerCategory`): every value present, in order. */
function legend(
  samples: readonly number[],
  name: (value: number) => { readonly label: string; readonly color: readonly [number, number, number] },
): readonly MapLayerCategory[] | undefined {
  const values = new Set<number>()
  for (const value of samples) {
    values.add(value)
    if (values.size > MAX_LAYER_CATEGORIES) return undefined
  }
  const hex = (channel: number) => channel.toString(16).padStart(2, '0')
  return Object.freeze(
    [...values].sort((left, right) => left - right).map(value => {
      const { label, color } = name(value)
      return Object.freeze({ value, label, color: `#${color.map(hex).join('')}` })
    }),
  )
}

/**
 * Pictures `view.render` draws for `{ layer: id }` (sdk `MapPictureDescriptor`): shown beside the
 * numeric layers, not exported as numbers. Only those this map has the documents for.
 */
function mapPictures(data: SC2MapDocumentData): readonly MapPictureDescriptor[] {
  const terrain = data.height !== undefined && data.terrain !== undefined
  const pictures: MapPictureDescriptor[] = []
  const picture = (present: boolean, id: string, label: string) => {
    if (present) pictures.push(Object.freeze({ id, label }))
  }
  picture(terrain, 'overview', 'Overview: cliffs, ramps, pathing, resources, start locations')
  picture(terrain, 'navigation', 'Navigation: regions, ramps, expansions, routes')
  picture(data.height !== undefined, 'height-sum', 'Height with cliff offsets (the drawn surface)')
  picture(terrain, 'cliff-vertices', 'Cliff level of every vertex')
  picture(data.cliffLevel !== undefined, 'cliff-cells', 'Cliff level of every cell')
  picture(data.textureMasks !== undefined, 'texture', 'Texture masks')
  picture(data.textureMasks !== undefined, 'texture-overlay', 'Texture masks with objects, regions and water')
  picture(
    data.info !== undefined || data.objects !== undefined || data.regions !== undefined || data.water !== undefined,
    'overlay',
    'Objects, regions and water',
  )
  picture(data.cellFlags !== undefined, 'cell-flags', 'Cell flags')
  picture(data.paintedPathing?.paint !== undefined, 'painted-pathing', 'Painted pathing')
  picture(data.vertexColor !== undefined, 'vertex-color', 'Vertex colour')
  return Object.freeze(pictures)
}

/** A selector built on its first question: opening a map does not read its GameData for one. */
function lazySelector(make: () => Promise<SubjectSelectorSource>): SubjectSelectorSource {
  let made: Promise<SubjectSelectorSource> | undefined
  const selector = () => (made ??= make())
  return Object.freeze({
    summary: async (signal?: AbortSignal) => (await selector()).summary(signal),
    subjects: async (query: Parameters<SubjectSelectorSource['subjects']>[0], signal?: AbortSignal) =>
      (await selector()).subjects(query, signal),
    openFacts: async (subjectId: string, signal?: AbortSignal) => (await selector()).openFacts(subjectId, signal),
    openCalculations: async (...args: Parameters<SubjectSelectorSource['openCalculations']>) =>
      (await selector()).openCalculations(...args),
  })
}

async function extendMapInspection(extension: ExtensionContext, form: MapForm, catalog?: SubjectCatalogPort) {
  const parsed = await parseNamespace(extension)
  const parsedSummary = summary(parsed, form)
  const render = (input: JsonValue): OperationOutput => ({ kind: 'bytes', value: preview(parsed, input) })
  const editWorld = async (input: JsonValue, options?: { readonly signal?: AbortSignal }): Promise<OperationOutput> => {
    const signal = options?.signal ?? extension.context.signal
    signal?.throwIfAborted()
    const maximum = Math.min(Number(extension.context.budget.maxScalarBytes), Number(extension.context.budget.maxInputBytes))
    const documents: Array<{ path: string; bytes: Uint8Array }> = []
    const opened = new Map<string, Awaited<ReturnType<typeof openEntryBytes>>>()
    for (const entry of extension.entries) {
      if (entry.kind !== 'file' || !EDIT_BASENAMES.has(basename(entry.path))) continue
      const source = await openEntryBytes(extension.namespace, entry.path, maximum, signal)
      documents.push({ path: entry.path, bytes: source.bytes })
      opened.set(entry.path.toLowerCase(), source)
    }
    const request = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, JsonValue> : {}
    const semantic = await applyStarcraft2MapWorldEdits({
      ...request, documents, sourceRevision: extension.revision, signal,
      maxDocuments: Math.min(extension.context.budget.maxNodes, 1_024),
      maxDocumentBytes: maximum,
      maxTotalBytes: Math.min(Number(extension.context.budget.maxInputBytes), 1_073_741_824),
      maxNodes: extension.context.budget.maxNodes,
      maxTerrainCells: Math.min(extension.context.budget.maxNodes, 16_777_216),
    })
    // The game's synchronized heights are a separate document the writer does not recompute yet.
    const syncHeightStale =
      parsed.data.syncHeight !== undefined &&
      semantic.replacements.some((item: { path: string }) => ['t3heightmap', 'mapheightmap'].includes(basename(item.path)))
    const targets = []
    const edits = []
    for (const [index, replacement] of semantic.replacements.entries()) {
      const source = opened.get(replacement.path.toLowerCase())
      if (source === undefined) throw new TypeError(`edited SC2 map entry was not opened: ${replacement.path}`)
      const payload = Object.freeze({ kind: 'inline', bytes: replacement.bytes })
      const label = `apply semantic SC2 map edit to ${replacement.path}`
      if (form.topology === 'mounted-directory') {
        // A folder map is a directory namespace: the host commits a plan naming its files directly.
        const target = namespaceEntryEditTarget({
          root: extension.root,
          namespaceRevision: extension.revision as RevisionId,
          entry: { path: source.path, size: source.bytes.byteLength },
        })
        targets.push(target)
        edits.push(Object.freeze({ operation: 'replace', targetId: target.targetId, source: target.ownerSource, payload, label }))
        continue
      }
      // A packed map's entries go back through the MPQ container's container.pack.
      const targetId = `entry-${index}`
      targets.push(Object.freeze({ targetId, subjectUri: source.ref.uri, ownerSource: source.ref, semanticPath: Object.freeze([]), expectedRevision: entryRevision(source) }))
      edits.push(Object.freeze({ operation: 'replace', targetId, source: source.ref, payload, label }))
    }
    return {
      kind: 'edit-plan',
      plan: Object.freeze({
        planId: `sc2-map-world:${semantic.replacements.map((item: { outputDigest: string }) => item.outputDigest).join(':')}`,
        targets: Object.freeze(targets), edits: Object.freeze(edits),
        semantics: Object.freeze({ mutationMode: 'mutate', minimumGuarantee: 'atomic' }),
        fidelity: Object.freeze({
          roundTrip: semantic.fidelity.roundTrip,
          preservesUnknownData: semantic.fidelity.preservesUnknownData,
          notes: Object.freeze([
            ...semantic.fidelity.notes,
            ...semantic.fidelity.losses,
          ]),
        }),
        diagnostics: Object.freeze([
          Object.freeze({ severity: 'information', code: 'blizzard/sc2-map-edit-receipt', message: `${semantic.editsApplied} semantic edit(s), ${semantic.replacements.length} namespace entry replacement(s)` }),
          ...semantic.fidelity.losses.map((message: string) => Object.freeze({ severity: message.includes('normalized') ? 'warning' : 'information', code: 'blizzard/sc2-map-edit-fidelity-note', message })),
          ...(syncHeightStale
            ? [Object.freeze({ severity: 'warning', code: 'blizzard/sc2-map-sync-height-not-updated', message: 't3SyncHeightMap keeps its heights: the edit changes t3HeightMap only, so the game\'s synchronized heights differ from the terrain until the map is saved in the editor' })]
            : []),
        ]),
      }),
    }
  }
  return Object.freeze({
    summary: parsedSummary,
    factGroups: mapFactGroups(parsed, extension.root),
    dataSources: Object.freeze({
      // «Entity card…» on an open map, as on a mod: the map's own Base.SC2Data entities listed, any
      // entity of its mod context opened through the catalog (one-time consent of [SC2] Maps, 02.10).
      'common.view/subject-selector-source': lazySelector(async () => modEntitySelector({
        mod: await readSc2ModOfFiles(new Map([...parsed.files].filter(([path]) => isSemanticModEntry(path)))),
        root: extension.root,
        revision: extension.revision,
        ...(catalog === undefined ? {} : { catalog }),
      })),
    }),
    metadata: Object.freeze([
      Object.freeze({
        id: 'sc2-map-model', label: 'SC2 map model',
        entries: Object.freeze([
          Object.freeze({ key: 'modeledComponents', value: parsedSummary['modeledComponents'] }),
          Object.freeze({ key: 'parseFailures', value: parsed.parseFailures.length }),
          Object.freeze({ key: 'metadataFailures', value: parsed.metadataFailures.length }),
          Object.freeze({ key: 'versionFiles', value: Object.keys(parsed.versionFiles).length }),
          Object.freeze({ key: 'dataWizards', value: parsed.dataWizards.length }),
        ]),
      }),
    ]),
    traits: Object.freeze([
      Object.freeze({ id: 'structure.layers', parameters: { count: modeledComponents(parsed.data).length } }),
      Object.freeze({ id: 'content.metadata', parameters: { documentHeader: parsed.documentHeader !== undefined, versionFiles: Object.keys(parsed.versionFiles).length } }),
      ...(parsed.data.objects === undefined ? [] : [Object.freeze({ id: 'scene.objects', parameters: { count: parsed.data.objects.byId.size } })]),
    ]),
    handlers: Object.freeze({
      'detect-map': async () => json({ confidence: 1, evidence: ['namespace-world-documents'] }),
      'open-map': async () => json(parsedSummary),
      'embedded-map': async () => json(embeddedProjection(parsed)),
      'metadata-map': async () => json(metadataProjection(parsed)),
      validate: async () => json(parsed.parseFailures),
      thumbnail: async (input: JsonValue) => render(input),
      'render-preview': async (input: JsonValue) => render(input),
      'world-map': async () => json(worldProjection(parsed.data)),
      'extract-modeled': async (input: JsonValue): Promise<OperationOutput> => {
        const request = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, JsonValue> : {}
        const files = request['serialize'] === true ? serializeSc2MapDocuments(parsed.data) : parsed.files
        return { kind: 'bytes', value: encodeNamespace(files) }
      },
      'export-raw': async (): Promise<OperationOutput> => ({ kind: 'bytes', value: encodeNamespace(parsed.files) }),
      'map-layers': async () => {
        const pictures = mapPictures(parsed.data)
        return json({
          layers: [...mapLayers(parsed.data).values()].map(layer => layer.descriptor),
          ...(pictures.length === 0 ? {} : { pictures }),
        } as unknown as JsonValue)
      },
      'map-layer-read': async (input: JsonValue) => {
        const request = (input ?? {}) as unknown as MapLayerReadRequest
        const layer = typeof request.layer === 'string' ? mapLayers(parsed.data).get(request.layer) : undefined
        if (layer === undefined) throw new RangeError(`the map has no layer ${String(request.layer)}`)
        const window = mapLayerWindow(layer.descriptor, request)
        const all = layer.values()
        const values: number[] = []
        for (let row = window.y; row < window.y + window.height; row += 1) {
          values.push(...all.slice(row * layer.descriptor.width + window.x, row * layer.descriptor.width + window.x + window.width))
        }
        return json({
          layer: layer.descriptor.id,
          ...(request.x === undefined ? {} : { x: window.x, y: window.y }),
          width: window.width,
          height: window.height,
          values,
        })
      },
      'map-layer-write': async (input: JsonValue, options?: { readonly signal?: AbortSignal }) => {
        const grid = (input ?? {}) as unknown as MapLayerGrid & { readonly expectedSourceRevision?: unknown }
        const layer = typeof grid.layer === 'string' ? mapLayers(parsed.data).get(grid.layer) : undefined
        if (layer === undefined) throw new RangeError(`the map has no layer ${String(grid.layer)}`)
        const window = mapLayerWindow(layer.descriptor, grid)
        return editWorld({
          expectedSourceRevision: typeof grid.expectedSourceRevision === 'string' ? grid.expectedSourceRevision : extension.revision,
          edits: [{
            kind: 'grid.set', grid: grid.layer,
            ...(grid.x === undefined ? {} : { x: window.x, y: window.y }),
            width: window.width, height: window.height, values: grid.values,
          } as JsonValue],
        }, options)
      },
      'edit-world': async (input: JsonValue, options?: { readonly signal?: AbortSignal }): Promise<OperationOutput> => editWorld(input, options),
    }),
    diagnostics: Object.freeze([...parsed.parseFailures, ...parsed.metadataFailures].map((failure, index) => Object.freeze({
      id: `sc2-map.parse.${index}`,
      code: 'blizzard/sc2-map-entry-parse-failed',
      category: 'syntax', severity: 'warning',
      message: failure.message,
      data: { path: failure.path },
    }))),
    unsupportedFeatures: Object.freeze([
      'installed-editor-acceptance',
      'cross-codec-coordinated-rename',
      'resolved-localization-and-catalog-dependencies',
      'map-3d-scene',
    ]),
  })
}

export const abiVersion = 1

export function createSc2MapCodec(
  options: Readonly<{ loose?: boolean; id?: string }> = {},
  context?: ContributionContext,
) {
  const loose = options.loose === true
  return createSc2DirectoryCodec({
    id: options.id ?? ID,
    kind: 'map',
    formatId: loose ? 'sc2-map-directory' : 'sc2-map',
    displayName: loose ? 'StarCraft II loose map' : 'StarCraft II map',
    topology: loose ? 'mounted-directory' : 'mpq-namespace',
    packed: !loose,
    operations: operationsFor(options.id ?? ID),
    // A folder map reports its own format and topology.
    extendInspection: (extension: ExtensionContext) =>
      extendMapInspection(extension, {
        format: loose ? 'sc2-map-directory' : 'sc2-map',
        topology: loose ? 'mounted-directory' : 'mpq-namespace',
      }, context?.catalog),
  }, context)
}

export function createCodec(context?: ContributionContext) {
  return createSc2MapCodec({}, context)
}
