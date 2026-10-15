import { analyzeMapOverview, overviewCatalogQueries } from '../../../../dist/modules/map/shared/image/overview.js'
import { parseSc2MapDocuments } from '../../../../dist/modules/map/shared/coordinator.js'
import { catalogAssetLogicalId, modelVariationFor, catalogModelVariationLogicalId } from '../../../../shared/catalog-model.js'
import { catalogFieldValue, resolvedFieldRecord, commaSeparatedVector as waterVector, projectCatalogLight } from '../../../../shared/catalog-light.js'
import { parseXml } from '@rgrove/parse-xml'
import { initialActorPresentation } from './actor-presentation.js'
import { readVertexColor, vertexColorScalarGrid } from '../../../../dist/modules/map/shared/vertex-color.js'
import { readCellFlags } from '../../../../dist/modules/map/shared/format/formats/cell-flags.js'
import { cliffVertexLevels } from '../../../../dist/modules/map/shared/format/cliff-tiles.js'
import { MAP_SEMANTIC_ANALYSIS_CONTRACT, RESOLVED_MAP_WORKSPACE_CONTRACT } from '@modkit/sdk/maps'
import {
  buildSc2CliffPieces,
  sc2CliffSetIds,
} from '../../../../dist/modules/map/shared/cliffs.js'
import {
  buildSc2LavaPlanes,
  buildSc2Shorelines,
  sc2WaterTemplateIds,
} from '../../../../dist/modules/map/shared/shorelines.js'

const ANALYZER_ID = 'blizzard.starcraft2.maps'
const GAME_ID = 'blizzard/starcraft-2'
export const SC2_WORLD_SCENE_SOURCE_CONTRACT = 'blizzard.starcraft2/world-scene-source'
const MAXIMUM_DOCUMENTS = 20
// Real 256-cell SC2 maps carry a 2048², 64-layer nibble MASK at 16,777,280 bytes
// (64-byte header plus 16 MiB body), so a 16 MiB ceiling rejects a normal authored document.
const MAXIMUM_DOCUMENT_BYTES = 67_108_864
const MAXIMUM_TOTAL_BYTES = 134_217_728
const MAXIMUM_OBJECTS = 100_000
const MAXIMUM_REGIONS = 10_000
const MAXIMUM_TERRAIN_CELLS = 4_194_304
// Full native-grid publication remains caller-bounded by maxTerrainCells and ResourceBudget.maxNodes.
const MAXIMUM_TERRAIN_SAMPLES = MAXIMUM_TERRAIN_CELLS
const MAXIMUM_DEPTH = 128
const MAXIMUM_DIAGNOSTICS = 10_000
const textDecoder = new TextDecoder()

function recordOf(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function positiveLimit(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}`)
  }
  return value
}

function validateRequest(request) {
  const value = recordOf(request)
  if (value === undefined) throw new TypeError('semantic map request must be an object')
  nonEmptyString(value.workspaceId, 'workspaceId')
  nonEmptyString(value.mapId, 'mapId')
  if (value.gameId !== GAME_ID) {
    throw new TypeError(`StarCraft II map analysis cannot inspect ${String(value.gameId)}`)
  }
  const maxDocuments = positiveLimit(value.maxDocuments, 'maxDocuments', MAXIMUM_DOCUMENTS)
  const maxDocumentBytes = positiveLimit(
    value.maxDocumentBytes,
    'maxDocumentBytes',
    MAXIMUM_DOCUMENT_BYTES,
  )
  const maxTotalBytes = positiveLimit(value.maxTotalBytes, 'maxTotalBytes', MAXIMUM_TOTAL_BYTES)
  positiveLimit(value.maxObjects, 'maxObjects', MAXIMUM_OBJECTS)
  positiveLimit(value.maxRegions, 'maxRegions', MAXIMUM_REGIONS)
  positiveLimit(value.maxTerrainCells, 'maxTerrainCells', MAXIMUM_TERRAIN_CELLS)
  positiveLimit(value.maxTerrainSamples, 'maxTerrainSamples', MAXIMUM_TERRAIN_SAMPLES)
  positiveLimit(value.maxDepth, 'maxDepth', MAXIMUM_DEPTH)
  if (!Array.isArray(value.documents) || value.documents.length > maxDocuments) {
    throw new TypeError(
      `documents must be an array with at most maxDocuments (${maxDocuments}) entries`,
    )
  }
  let totalBytes = 0
  const paths = new Set()
  value.documents.forEach((document, index) => {
    const item = recordOf(document)
    if (item === undefined) throw new TypeError(`documents[${index}] must be an object`)
    const path = nonEmptyString(item.path, `documents[${index}].path`)
    if (!(item.bytes instanceof Uint8Array)) {
      throw new TypeError(`documents[${index}].bytes must be a Uint8Array`)
    }
    if (item.bytes.byteLength > maxDocumentBytes) {
      throw new TypeError(`documents[${index}] exceeds maxDocumentBytes (${maxDocumentBytes})`)
    }
    const normalized = path.replaceAll('\\', '/').toLowerCase()
    if (paths.has(normalized)) throw new TypeError(`documents contains duplicate path ${path}`)
    paths.add(normalized)
    totalBytes += item.bytes.byteLength
  })
  if (totalBytes > maxTotalBytes) {
    throw new TypeError(`document bytes exceeds maxTotalBytes (${totalBytes} > ${maxTotalBytes})`)
  }
  const catalog = value.catalog
  if (catalog !== undefined) {
    const snapshot = recordOf(catalog)
    if (
      snapshot?.schemaVersion !== 1 ||
      snapshot.workspaceId !== value.workspaceId ||
      snapshot.gameId !== value.gameId ||
      !Array.isArray(snapshot.entities)
    ) {
      throw new TypeError('catalog must be a matching semantic data snapshot')
    }
  }
  return value
}

function basename(path) {
  return path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
}

function immutablePlanDiagnostic(severity, code, message, path) {
  return Object.freeze({ severity, code, message, ...(path === undefined ? {} : { path }) })
}

/** Provider-owned logical document plan; the generic host owns every VFS/ResourceSession read. */
export async function planStarcraft2Map(request) {
  request?.signal?.throwIfAborted()
  const value = recordOf(request)
  if (value === undefined) throw new TypeError('semantic map plan request must be an object')
  const workspace = recordOf(value.workspace)
  if (
    workspace?.schemaVersion !== 1 ||
    workspace.gameId !== GAME_ID ||
    !Array.isArray(workspace.loadOrder)
  ) {
    throw new TypeError('workspace must be a StarCraft II ModWorkspaceLock')
  }
  const maxRequirements = positiveLimit(value.maxRequirements, 'maxRequirements', 64)
  const active = workspace.loadOrder.find(root => root?.rootId === workspace.activeRootId)
  if (active === undefined || typeof active.sourcePath !== 'string') {
    return Object.freeze({
      schemaVersion: 1,
      workspaceId: String(workspace.workspaceId ?? ''),
      gameId: GAME_ID,
      mapId: '',
      analyzerId: ANALYZER_ID,
      requirements: Object.freeze([]),
      diagnostics: Object.freeze([
        immutablePlanDiagnostic(
          'error',
          'blizzard.starcraft2/map-active-root-unavailable',
          'workspace activeRootId does not name one loadOrder root',
        ),
      ]),
      complete: false,
    })
  }
  const root = nonEmptyString(active.sourcePath, 'workspace active root sourcePath').replaceAll(
    '\\',
    '/',
  )
  const required = root.toLowerCase().endsWith('.sc2map') || active.kind === 'map'
  const requested = [
    ['map-objects', 'objects', 'objects', required],
    ['map-regions', 'regions', 'regions', required],
    ['map-terrain-height', 't3heightmap', 'terrain-height', required],
    ['map-terrain-native-parameters', 't3terrain.xml', 'terrain-native-parameters', false],
    ['map-navigation', 't3syncpathinginfo', 'navigation', false],
    ['map-terrain-materials', 't3synctextureinfo', 'terrain-materials', false],
    ['map-terrain-texture-masks', 't3texturemasks', 'terrain-texture-masks', false],
    ['map-water', 't3water', 'water', false],
    [
      'map-water-catalog',
      'base.sc2data/gamedata/waterdata.xml',
      'water-catalog',
      false,
      'workspace',
    ],
    ['map-cliffs', 't3syncclifflevel', 'cliffs', false],
    ['map-fluff-doodads', 't3fluffdoodad', 'fluff-doodads', false],
    ['map-terrain-vertex-color', 't3vertcol', 'terrain-vertex-color', false],
    ['map-terrain-cell-flags', 't3cellflags', 'terrain-cell-flags', false],
    ['map-overview-info','mapinfo','overview-info',false],
    ['map-overview-no-pathing','cellattribute_pnp','overview-no-pathing',false],
    ['map-overview-no-build','cellattribute_pnb','overview-no-build',false],
    ['map-overview-clear-pathing','cellattribute_pcl','overview-clear-pathing',false],
  ].map(([requirementId, name, kind, itemRequired, scope]) =>
    Object.freeze({
      requirementId,
      path: scope === 'workspace' ? name : `${root}/${name}`,
      kind,
      required: itemRequired,
      ...(scope === undefined ? {} : { scope }),
    }),
  )
  const complete = requested.length <= maxRequirements
  const requirements = Object.freeze(requested.slice(0, maxRequirements))
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: String(workspace.workspaceId),
    gameId: GAME_ID,
    mapId: root,
    analyzerId: ANALYZER_ID,
    requirements,
    diagnostics: Object.freeze(
      complete
        ? []
        : [
            immutablePlanDiagnostic(
              'error',
              'blizzard.starcraft2/map-plan-budget-exceeded',
              `map plan needs ${requested.length} requirements but maxRequirements is ${maxRequirements}`,
            ),
          ],
    ),
    complete,
  })
}

function elementChildren(node) {
  return (node.children ?? []).filter(child => child.type === 'element')
}

function xmlRoot(document, expectedName, maxDepth) {
  const text = textDecoder.decode(document.bytes)
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) {
    throw new TypeError(`${document.path}: DTD and custom entities are forbidden`)
  }
  const parsed = parseXml(text)
  const root = parsed.children?.find(child => child.type === 'element')
  if (root === undefined || root.name.toLowerCase() !== expectedName.toLowerCase()) {
    throw new TypeError(`${document.path}: expected ${expectedName} XML root`)
  }
  const stack = [{ node: root, depth: 1 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current.depth > maxDepth) {
      throw new TypeError(`${document.path}: XML depth exceeds maxDepth (${maxDepth})`)
    }
    for (const child of elementChildren(current.node)) {
      stack.push({ node: child, depth: current.depth + 1 })
    }
  }
  return root
}

/**
 * `<heightMap uvtiling="u v a b">` → material transform in terrain cell units. The first two values
 * are read as world units per texture repeat (Amphion authors 16.5); the meaning of the remaining
 * two is not yet confirmed, so they are not projected. V is flipped as in the game's
 * `shaders/terrainblend.fx` (`vUV0.y = 1 - vUV0.y`): unflipped, diagonal textures such as
 * CompoundMansion_2's planks run along the other diagonal than in the editor.
 */
/**
 * Terrain texture transform from `<heightMap uvtiling>`.
 *
 * uvtiling counts the texture REPEATS ACROSS THE MAP, not units per repeat: across twelve shipped
 * campaign maps (dim - 1) / uvtiling is exactly 32/3 = 10.667 units per repeat every time
 * (257/24, 153x201 / 14.25x18.75, 225x161 / 21x15, 137/12.75, …). Read as units per repeat it drew
 * Amphion's ground 16.5 / 10.667 = 1.55x too large. The V flip matches shaders/terrainblend.fx
 * (vUV0.y = 1 - vUV0.y). The third and fourth numbers are UV offsets; Amphion holds zeros there,
 * so they stay unread until a map with a non-zero one confirms their sign.
 */
function terrainUvTransform(document, maxDepth) {
  const root = xmlRoot(document, 'terrain', maxDepth)
  const heightMap = elementChildren(root).find(node => node.name.toLowerCase() === 'heightmap')
  const raw = heightMap?.attributes?.uvtiling
  if (typeof raw !== 'string') return undefined
  const [u, v] = raw.trim().split(/\s+/u).map(Number)
  if (!(Number.isFinite(u) && u > 0 && Number.isFinite(v) && v > 0)) return undefined
  const [dimX, dimY] = String(heightMap?.attributes?.dim ?? '')
    .trim()
    .split(/\s+/u)
    .map(Number)
  if (!(Number.isSafeInteger(dimX) && dimX > 1 && Number.isSafeInteger(dimY) && dimY > 1)) {
    return undefined
  }
  return Object.freeze({
    offset: Object.freeze([0, 1]),
    scale: Object.freeze([u / (dimX - 1), -v / (dimY - 1)]),
    rotation: 0,
  })
}

function terrainTextureNames(document, maxDepth) {
  const root = xmlRoot(document, 'terrain', maxDepth)
  const names = []
  const indices = new Set()
  const stack = [...elementChildren(root)]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.name.toLowerCase() === 'texture') {
      const index = Number(node.attributes?.i)
      const name = node.attributes?.name
      if (!Number.isSafeInteger(index) || index < 0 || typeof name !== 'string') {
        throw new TypeError(
          `${document.path}: texture entries require a non-negative index and string name`,
        )
      }
      if (indices.has(index)) {
        throw new TypeError(`${document.path}: duplicate texture index ${index}`)
      }
      indices.add(index)
      // Authored SC2 terrain lists retain empty reserved slots. The index is semantic; inventing
      // a catalog id is not. A stable display-only label keeps the 64-layer MASK aligned.
      names[index] = name === '' ? `Texture ${String(index)}` : name
    }
    stack.push(...elementChildren(node))
  }
  return names
}

function finiteNumber(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`)
  return number
}

function safeInteger(value, label, fallback) {
  const number = finiteNumber(value, label, fallback)
  if (!Number.isSafeInteger(number)) throw new TypeError(`${label} must be a safe integer`)
  return number
}

function vector(value, label, fallback) {
  const source = value ?? fallback
  const parts = String(source)
    .split(',')
    .map(item => Number(item.trim()))
  if ((parts.length !== 2 && parts.length !== 3) || parts.some(item => !Number.isFinite(item))) {
    throw new TypeError(`${label} must contain two or three finite comma-separated numbers`)
  }
  return Object.freeze({ x: parts[0], y: parts[1], z: parts[2] ?? 0 })
}

/**
 * A doodad's `TintColor="r,g,b"` (0..255) multiplies its model's colour; the editor's HDR tint adds a
 * brightness after a space, `"169,198,83 2.100000"`, which scales the colour past 1. The world scene
 * draws textures as stored, so the bytes are scaled to 0..1 without a transfer function.
 */
function tintColor(value, label) {
  const [color = '', intensity, ...rest] = String(value).trim().split(/\s+/u)
  const parts = color.split(',').map(item => Number(item.trim()))
  const scale = intensity === undefined ? 1 : Number(intensity)
  if (parts.length !== 3 || parts.some(item => !Number.isInteger(item) || item < 0 || item > 255) || rest.length > 0 || !(scale >= 0) || !Number.isFinite(scale)) {
    throw new TypeError(`${label} must be three integers 0..255, optionally followed by a non-negative HDR intensity`)
  }
  return Object.freeze(parts.map(item => (item / 255) * scale))
}

function optionalFinite(value, label) {
  return value === undefined ? undefined : finiteNumber(value, label)
}

// Neutral objects draw without team color: psmateriallayer.fx lerps diffuse team-color layers by
// pow(alpha, p_fTeamColorIntensity), and in-game neutral geysers keep their green (normal) and
// purple (rich) steam textures under the white TeamColor00, i.e. intensity 0.
const SC2_NEUTRAL_PRESENTATION = Object.freeze({
  presentationTeamColor: Object.freeze([1, 1, 1]),
  presentationTeamColorIntensity: 0,
})

/** Placed objects; one with an attribute it cannot read is left out with a warning, not the whole document. */
function parseObjects(document, request, diagnostics = []) {
  const root = xmlRoot(document, 'PlacedObjects', request.maxDepth)
  const objects = []
  const skipped = []
  for (const element of elementChildren(root)) {
    if (objects.length >= request.maxObjects) {
      diagnostics.push(Object.freeze({
        severity: 'warning',
        code: 'blizzard.starcraft2/map-objects-truncated',
        message: `${document.path}: placed objects exceed maxObjects (${request.maxObjects}); the rest are not drawn`,
        path: document.path,
      }))
      break
    }
    try {
      const object = parsePlacedObject(document, element)
      if (object !== undefined) objects.push(object)
    } catch (error) {
      skipped.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (skipped.length > 0) {
    diagnostics.push(Object.freeze({
      severity: 'warning',
      code: 'blizzard.starcraft2/map-object-invalid',
      message: `${skipped.length} placed object(s) left out: ${skipped.slice(0, 4).join('; ')}`,
      path: document.path,
    }))
  }
  return objects
}

function parsePlacedObject(document, element) {
  const attributes = element.attributes ?? {}
  const objectId = safeInteger(attributes.Id, `${document.path}:${element.name}.Id`, 0)
  const common = {
    objectId,
    position: vector(attributes.Position, `${document.path}:${objectId}.Position`, '0,0,0'),
  }
  let object
  if (element.name === 'ObjectUnit') {
    const player = safeInteger(attributes.Player, `${document.path}:${objectId}.Player`, 0)
    object = {
      ...common,
      kind: 'unit',
      typeId: String(attributes.UnitType ?? ''),
      player,
      ...(attributes.Resources === undefined ? {} : { resources: finiteNumber(attributes.Resources, `${document.path}:${objectId}.Resources`) }),
      ...(player === 0 ? SC2_NEUTRAL_PRESENTATION : {}),
      variation: safeInteger(attributes.Variation, `${document.path}:${objectId}.Variation`, 0),
      scale: vector(attributes.Scale, `${document.path}:${objectId}.Scale`, '1,1,1'),
      rotation: optionalFinite(attributes.Rotation, `${document.path}:${objectId}.Rotation`),
      nativeRotationUnit: 'radians',
      heightReference: 'terrain-surface',
    }
  } else if (element.name === 'ObjectDoodad') {
    object = {
      ...common,
      kind: 'doodad',
      typeId: String(attributes.Type ?? ''),
      variation: safeInteger(attributes.Variation, `${document.path}:${objectId}.Variation`, 0),
      scale: vector(attributes.Scale, `${document.path}:${objectId}.Scale`, '1,1,1'),
      rotation: optionalFinite(attributes.Rotation, `${document.path}:${objectId}.Rotation`),
      nativeRotationUnit: 'radians',
      // Objects stores world Z for every doodad; `HeightAbsolute` only keeps the editor from
      // re-seating it on terrain edits. Amphion: 2055 flagged doodads sit within 0.1 of the ground,
      // and the 2 unflagged sand drifts at z 5.44 on ground 6.0 floated 5.4 up as terrain-relative.
      heightReference: 'absolute',
      ...SC2_NEUTRAL_PRESENTATION,
      // The CTerrain whose TextureProp picks the model's declared texture variants; the map's by default.
      ...(typeof attributes.TileSet === 'string' && attributes.TileSet.length > 0 ? { tileSet: attributes.TileSet } : {}),
      ...(attributes.TintColor === undefined
        ? {}
        : { presentationTint: tintColor(attributes.TintColor, `${document.path}:${objectId}.TintColor`) }),
    }
  } else if (element.name === 'ObjectPoint') {
    object = {
      ...common,
      kind: 'point',
      typeId: String(attributes.Type ?? ''),
      name: attributes.Name,
      scale: vector(attributes.Scale, `${document.path}:${objectId}.Scale`, '1,1,1'),
      rotation: optionalFinite(attributes.Rotation, `${document.path}:${objectId}.Rotation`),
      nativeRotationUnit: 'radians',
    }
  } else if (element.name === 'ObjectCamera') {
    object = {
      ...common,
      kind: 'camera',
      name: attributes.Name,
      scale:
        attributes.Scale === undefined
          ? undefined
          : vector(attributes.Scale, `${document.path}:${objectId}.Scale`, '1,1,1'),
      rotation: optionalFinite(attributes.Rotation, `${document.path}:${objectId}.Rotation`),
      nativeRotationUnit: 'radians',
    }
  }
  if (object === undefined) return undefined
  return Object.freeze(
    Object.fromEntries(Object.entries(object).filter(([, item]) => item !== undefined)),
  )
}

function childValue(node, name) {
  const child = elementChildren(node).find(item => item.name.toLowerCase() === name.toLowerCase())
  const value = child?.attributes?.value
  return value === undefined ? undefined : String(value)
}

function parseRegions(document, request) {
  const root = xmlRoot(document, 'Regions', request.maxDepth)
  const regions = []
  for (const element of elementChildren(root)) {
    if (element.name.toLowerCase() !== 'region') continue
    if (regions.length >= request.maxRegions) {
      throw new TypeError(`${document.path}: regions exceeds maxRegions (${request.maxRegions})`)
    }
    const regionId = safeInteger(element.attributes?.id, `${document.path}:region.id`, 0)
    const shapes = elementChildren(element)
      .filter(child => child.name.toLowerCase() === 'shape')
      .map(shape =>
        Object.freeze({
          type: String(shape.attributes?.type ?? 'unknown'),
          parameters: Object.freeze(
            Object.fromEntries(
              elementChildren(shape).flatMap(child => {
                const value = child.attributes?.value
                return value === undefined ? [] : [[child.name, String(value)]]
              }),
            ),
          ),
        }),
      )
    const color = childValue(element, 'color')
    regions.push(
      Object.freeze({
        regionId,
        name: childValue(element, 'name') ?? '',
        ...(color === undefined ? {} : { color }),
        shapes: Object.freeze(shapes),
      }),
    )
  }
  return regions
}

function parseTerrain(document, request) {
  const bytes = document.bytes
  if (bytes.byteLength < 32) throw new TypeError(`${document.path}: HMAP header is truncated`)
  if (textDecoder.decode(bytes.subarray(0, 4)) !== 'HMAP') {
    throw new TypeError(`${document.path}: HMAP magic is missing`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  if (version !== 101) throw new TypeError(`${document.path}: unsupported HMAP version ${version}`)
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  const cellCount = width * height
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0 || cellCount > request.maxTerrainCells) {
    throw new TypeError(
      `${document.path}: terrain cells exceeds maxTerrainCells (${cellCount} > ${request.maxTerrainCells})`,
    )
  }
  const required = 32 + cellCount * 6
  if (!Number.isSafeInteger(required) || required > bytes.byteLength) {
    throw new TypeError(`${document.path}: HMAP cell array is truncated`)
  }
  const sampleCount = Math.min(cellCount, request.maxTerrainSamples)
  const retainsFullGrid = sampleCount === cellCount
  const sampleIndices = new Set()
  if (!retainsFullGrid) {
    for (let index = 0; index < sampleCount; index += 1) {
      sampleIndices.add(
        sampleCount === 1 ? 0 : Math.floor((index * (cellCount - 1)) / (sampleCount - 1)),
      )
    }
  }
  let minimumHeightBase = 0xffff
  let maximumHeightBase = 0
  let minimumHeightAdjustment = 0xffff
  let maximumHeightAdjustment = 0
  let cliffCellCount = 0
  const samples = []
  for (let index = 0; index < cellCount; index += 1) {
    const offset = 32 + index * 6
    const heightBase = view.getUint16(offset, true)
    const heightAdjustment = view.getUint16(offset + 2, true)
    const mask = view.getUint16(offset + 4, true)
    minimumHeightBase = Math.min(minimumHeightBase, heightBase)
    maximumHeightBase = Math.max(maximumHeightBase, heightBase)
    minimumHeightAdjustment = Math.min(minimumHeightAdjustment, heightAdjustment)
    maximumHeightAdjustment = Math.max(maximumHeightAdjustment, heightAdjustment)
    if ((mask & 0x9000) !== 0) cliffCellCount += 1
    if (retainsFullGrid || sampleIndices.has(index)) {
      samples.push(
        Object.freeze({
          x: index % width,
          y: Math.floor(index / width),
          heightBase,
          heightAdjustment,
          mask,
        }),
      )
    }
  }
  return Object.freeze({
    version,
    width,
    height,
    cellCount,
    minimumHeightBase,
    maximumHeightBase,
    minimumHeightAdjustment,
    maximumHeightAdjustment,
    cliffCellCount,
    trailingBytes: bytes.byteLength - required,
    samples: Object.freeze(samples),
  })
}

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u

function requiredAttribute(node, name, label) {
  const value = node.attributes?.[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label}.${name} must be present`)
  }
  return value.trim()
}

function strictFinite(value, label) {
  if (!DECIMAL_NUMBER.test(value)) throw new TypeError(`${label} must be a decimal finite number`)
  const number = Number(value)
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`)
  return number
}

function whitespaceVector(value, count, label) {
  const parts = value.split(/\s+/u)
  if (parts.length !== count) {
    throw new TypeError(`${label} must contain exactly ${count} whitespace-separated numbers`)
  }
  return parts.map((item, index) => strictFinite(item, `${label}[${index}]`))
}

function oneChild(parent, name, label) {
  const matches = elementChildren(parent).filter(
    child => child.name.toLowerCase() === name.toLowerCase(),
  )
  if (matches.length !== 1) {
    throw new TypeError(`${label} must contain exactly one ${name} element`)
  }
  return matches[0]
}

function exactTerrainGrid(terrain) {
  if (terrain.samples.length !== terrain.cellCount) return false
  return terrain.samples.every(
    (sample, index) =>
      sample.x === index % terrain.width && sample.y === Math.floor(index / terrain.width),
  )
}

function mapNativePosition(sample, heightMap, vertData) {
  const base = sample.heightBase * vertData.quantizeScale - vertData.quantizeBias
  const adjustment = sample.heightAdjustment * vertData.quantizeScale - vertData.quantizeBias
  const position = Object.freeze({
    x: heightMap.offset.x + sample.x * heightMap.scale.x,
    y: heightMap.offset.y + sample.y * heightMap.scale.y,
    z: base * heightMap.scale.z + heightMap.offset.z + adjustment,
  })
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    throw new TypeError('t3Terrain.xml native terrain mapping produced a non-finite position')
  }
  return position
}

function parseTerrainTransform(document, terrain, heightDocumentPath, snapshotId, request) {
  const root = xmlRoot(document, 'terrain', request.maxDepth)
  const descriptorVersion = strictFinite(
    requiredAttribute(root, 'version', `${document.path}:terrain`),
    `${document.path}:terrain.version`,
  )
  if (!Number.isSafeInteger(descriptorVersion) || descriptorVersion <= 0) {
    throw new TypeError(`${document.path}:terrain.version must be a positive safe integer`)
  }
  const heightMapElement = oneChild(root, 'heightMap', `${document.path}:terrain`)
  const vertDataElement = oneChild(
    heightMapElement,
    'vertData',
    `${document.path}:terrain.heightMap`,
  )
  const dimValues = whitespaceVector(
    requiredAttribute(heightMapElement, 'dim', `${document.path}:terrain.heightMap`),
    2,
    `${document.path}:terrain.heightMap.dim`,
  )
  if (!dimValues.every(item => Number.isSafeInteger(item) && item > 0)) {
    throw new TypeError(
      `${document.path}:terrain.heightMap.dim must contain positive safe integers`,
    )
  }
  const offsetValues = whitespaceVector(
    requiredAttribute(heightMapElement, 'offset', `${document.path}:terrain.heightMap`),
    3,
    `${document.path}:terrain.heightMap.offset`,
  )
  const scaleValues = whitespaceVector(
    requiredAttribute(heightMapElement, 'scale', `${document.path}:terrain.heightMap`),
    3,
    `${document.path}:terrain.heightMap.scale`,
  )
  if (!scaleValues.every(item => item > 0)) {
    throw new TypeError(`${document.path}:terrain.heightMap.scale must contain positive numbers`)
  }
  const vertData = Object.freeze({
    quantizeBias: strictFinite(
      requiredAttribute(
        vertDataElement,
        'quantizeBias',
        `${document.path}:terrain.heightMap.vertData`,
      ),
      `${document.path}:terrain.heightMap.vertData.quantizeBias`,
    ),
    quantizeScale: strictFinite(
      requiredAttribute(
        vertDataElement,
        'quantizeScale',
        `${document.path}:terrain.heightMap.vertData`,
      ),
      `${document.path}:terrain.heightMap.vertData.quantizeScale`,
    ),
    standardHeight: strictFinite(
      requiredAttribute(
        vertDataElement,
        'standardHeight',
        `${document.path}:terrain.heightMap.vertData`,
      ),
      `${document.path}:terrain.heightMap.vertData.standardHeight`,
    ),
  })
  if (vertData.quantizeScale <= 0) {
    throw new TypeError(
      `${document.path}:terrain.heightMap.vertData.quantizeScale must be positive`,
    )
  }
  const dim = Object.freeze([dimValues[0], dimValues[1]])
  if (dim[0] !== terrain.width || dim[1] !== terrain.height) {
    throw new TypeError(
      `${document.path}: terrain dim ${dim.join('x')} does not match HMAP ${terrain.width}x${terrain.height}`,
    )
  }
  const heightMap = Object.freeze({
    dim,
    offset: Object.freeze({ x: offsetValues[0], y: offsetValues[1], z: offsetValues[2] }),
    scale: Object.freeze({ x: scaleValues[0], y: scaleValues[1], z: scaleValues[2] }),
  })
  if (!exactTerrainGrid(terrain)) return undefined

  let minimum = Object.freeze({ x: Infinity, y: Infinity, z: Infinity })
  let maximum = Object.freeze({ x: -Infinity, y: -Infinity, z: -Infinity })
  for (const sample of terrain.samples) {
    const position = mapNativePosition(sample, heightMap, vertData)
    minimum = Object.freeze({
      x: Math.min(minimum.x, position.x),
      y: Math.min(minimum.y, position.y),
      z: Math.min(minimum.z, position.z),
    })
    maximum = Object.freeze({
      x: Math.max(maximum.x, position.x),
      y: Math.max(maximum.y, position.y),
      z: Math.max(maximum.z, position.z),
    })
  }
  return Object.freeze({
    schemaVersion: 1,
    snapshotId,
    descriptorVersion,
    source: Object.freeze({
      terrainDocumentPath: document.path,
      heightDocumentPath,
      rootElement: 'terrain',
      heightMapElement: 'heightMap',
      quantizationElement: 'vertData',
    }),
    heightMap,
    vertData,
    mapping: Object.freeze({
      horizontal: 'offset-plus-grid-index-times-scale',
      vertical: 'dequantized-base-times-scale-plus-offset-plus-dequantized-adjustment',
    }),
    bounds: Object.freeze({ coordinateSpaceId: 'map-native', minimum, maximum }),
  })
}

const SC2_WORLD_ORACLE = Object.freeze({
  kind: 'adapter-qualification',
  method: 'sealed-legacy-differential',
  oracle: 'modkit@1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
  corpus: 'StarCraft II 5.0.16.97563/TArcade.SC2Map',
  sourceDigests: Object.freeze({
    t3HeightMap: 'sha256:e4223f50d2350a350ac046395368470540f63b02cfa281ec4732d5c47738e83e',
    t3Terrain: 'sha256:994658707b6a56dd2b6261e9114b61ee10095a0801d57cbdc0dcec82181bcc6f',
  }),
  tupleCount: 66_049,
  comparison: 'ieee-754-binary64-exact',
  nativeTupleDigest: 'sha256:c3419baf0f7834682342035b3d1d485a21a0f30adc7712e6a7424dc3c075e8e7',
  presentationTupleDigest:
    'sha256:4befdf3b649b32c3e9f96c927df9a18b73f35a2c49db57148056ba5d6422794a',
  canonicalTupleDigest: 'sha256:dc1cb1b5d7a09b797721b79f158039141828cb567f2b8fd733d0a2dff108ba5b',
})

/** Candidate transform ratified by multiverse/specs world ADR-WORLD-001. */
function sc2WorldCanonicalTransform(transform) {
  const { dim, offset, scale } = transform.heightMap
  if (scale.x !== scale.y) return undefined
  const canonicalNumber = value => (value === 0 ? 0 : value)
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: transform.snapshotId,
    sourceCoordinateSpaceId: 'map-native',
    targetCoordinateSpaceId: 'uvw-canonical',
    basis: Object.freeze({
      handedness: 'right',
      upAxis: 'y',
      forwardAxis: '+z',
      unit: 'source-unit',
      sourceUnit: 'sc2-game-unit',
      unitsPerCell: scale.x,
    }),
    axes: Object.freeze({
      x: Object.freeze({ sourceAxis: 'x', scale: 1, offset: 0 }),
      y: Object.freeze({ sourceAxis: 'z', scale: 1, offset: 0 }),
      z: Object.freeze({ sourceAxis: 'y', scale: -1, offset: 0 }),
    }),
    heightfield: Object.freeze({
      columns: dim[0],
      rows: dim[1],
      cellSize: scale.x,
      origin: Object.freeze([
        canonicalNumber(offset.x),
        0,
        canonicalNumber(-(offset.y + (dim[1] - 1) * scale.y)),
      ]),
      sourceRowOrder: 'reverse',
    }),
    bounds: Object.freeze({
      coordinateSpaceId: 'uvw-canonical',
      minimum: Object.freeze({
        x: canonicalNumber(transform.bounds.minimum.x),
        y: canonicalNumber(transform.bounds.minimum.z),
        z: canonicalNumber(-transform.bounds.maximum.y),
      }),
      maximum: Object.freeze({
        x: canonicalNumber(transform.bounds.maximum.x),
        y: canonicalNumber(transform.bounds.maximum.z),
        z: canonicalNumber(-transform.bounds.minimum.y),
      }),
    }),
    proof: SC2_WORLD_ORACLE,
  })
}

function parseNavigation(document, request) {
  const bytes = document.bytes
  if (bytes.byteLength < 32) throw new TypeError(`${document.path}: PATH header is truncated`)
  if (textDecoder.decode(bytes.subarray(0, 4)) !== 'PATH') {
    throw new TypeError(`${document.path}: PATH magic is missing`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  const cellCount = width * height
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0 || cellCount > request.maxTerrainCells) {
    throw new TypeError(
      `${document.path}: navigation cells exceeds maxTerrainCells (${cellCount} > ${request.maxTerrainCells})`,
    )
  }
  const required = 32 + cellCount * 2
  if (!Number.isSafeInteger(required) || required > bytes.byteLength) {
    throw new TypeError(`${document.path}: PATH cell array is truncated`)
  }
  const sampleCount = Math.min(cellCount, request.maxTerrainSamples)
  const sampleIndices = new Set()
  for (let index = 0; index < sampleCount; index += 1) {
    sampleIndices.add(
      sampleCount === 1 ? 0 : Math.floor((index * (cellCount - 1)) / (sampleCount - 1)),
    )
  }
  let minimumFlags = 0xffff
  let maximumFlags = 0
  const samples = []
  for (let index = 0; index < cellCount; index += 1) {
    const flags = view.getUint16(32 + index * 2, true)
    minimumFlags = Math.min(minimumFlags, flags)
    maximumFlags = Math.max(maximumFlags, flags)
    if (sampleIndices.has(index)) {
      samples.push(Object.freeze({ x: index % width, y: Math.floor(index / width), flags }))
    }
  }
  return Object.freeze({
    version,
    width,
    height,
    cellCount,
    minimumFlags,
    maximumFlags,
    trailingBytes: bytes.byteLength - required,
    samples: Object.freeze(samples),
  })
}

function ascii(bytes) {
  const end = bytes.indexOf(0)
  return new TextDecoder('ascii').decode(end < 0 ? bytes : bytes.subarray(0, end))
}

function waterField(element, name) {
  const direct = element.attributes?.[name]
  if (direct !== undefined) return direct
  const child = elementChildren(element).find(
    node => node.name.toLowerCase() === name.toLowerCase(),
  )
  return child?.attributes?.value ?? child?.attributes?.Value
}

function waterMaterialId(templateId) {
  const body = templateId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return `water-${body || 'default'}`
}

function waterMaterialIds(templateIds) {
  const groups = new Map()
  for (const templateId of templateIds) {
    const base = waterMaterialId(templateId)
    const group = groups.get(base) ?? new Set()
    group.add(templateId)
    groups.set(base, group)
  }
  const result = new Map()
  for (const [base, group] of groups) {
    const ids = [...group].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    for (const templateId of ids) {
      if (ids.length === 1) {
        result.set(templateId, base)
        continue
      }
      // The readable slug is not injective (for example A-B and A_B). A double-hyphen can never
      // occur in the normalized base, and the full ASCII byte spelling makes the suffix collision
      // free without depending on document order or a probabilistic hash.
      const encoded = [...new TextEncoder().encode(templateId)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
      result.set(templateId, `${base}--${encoded}`)
    }
  }
  return result
}

function parseWaterTemplates(document, request) {
  if (document === undefined) return new Map()
  const root = xmlRoot(document, 'Catalog', request.maxDepth)
  const templates = new Map()
  const waters = elementChildren(root).filter(node => node.name.toLowerCase() === 'cwater')
  const materialIds = waterMaterialIds(
    waters.flatMap(water =>
      typeof water.attributes?.id === 'string' && water.attributes.id.length > 0
        ? [water.attributes.id]
        : [],
    ),
  )
  for (const water of waters) {
    const templateId = water.attributes?.id
    if (typeof templateId !== 'string' || templateId.length === 0) continue
    const states = elementChildren(water).filter(node => node.name.toLowerCase() === 'state')
    const state =
      states.find(
        node =>
          String(node.attributes?.index ?? '0') === '0' && waterField(node, 'Height') !== undefined,
      ) ?? states.find(node => waterField(node, 'Height') !== undefined)
    if (state === undefined) continue
    const elevation = finiteNumber(
      waterField(state, 'Height'),
      `${document.path}:CWater[${templateId}].State.Height`,
    )
    const color = waterVector(
      waterField(state, 'Color'),
      4,
      `${document.path}:CWater[${templateId}].State.Color`,
    )
    const optionalNumber = (value, label) =>
      value === undefined
        ? undefined
        : finiteNumber(value, `${document.path}:CWater[${templateId}].${label}`)
    const tiling = waterVector(
      waterField(water, 'TilingFreq'),
      4,
      `${document.path}:CWater[${templateId}].TilingFreq`,
    )
    const scroll = waterVector(
      waterField(water, 'ScrollVectors'),
      4,
      `${document.path}:CWater[${templateId}].ScrollVectors`,
    )
    const causticsScale = waterVector(
      waterField(water, 'CausticsTilingFreq'),
      2,
      `${document.path}:CWater[${templateId}].CausticsTilingFreq`,
    )
    const colorFalloff = optionalNumber(waterField(state, 'ColorFallOff'), 'State.ColorFallOff')
    const specularity = optionalNumber(waterField(state, 'Specularity'), 'State.Specularity')
    const specularScale = optionalNumber(waterField(state, 'SpecularScaler'), 'State.SpecularScaler')
    const reflectivityPower = optionalNumber(
      waterField(state, 'ReflectivityPower'),
      'State.ReflectivityPower',
    )
    const causticsFramesPerSecond = optionalNumber(waterField(water, 'CausticsFPS'), 'CausticsFPS')
    const causticsFalloff = optionalNumber(waterField(state, 'CausticsFallOff'), 'State.CausticsFallOff')
    const caustics = waterCaustics(waterField(water, 'TextureKey'), causticsFalloff)
    const lava = waterField(water, 'IsLava') === '1'
    const waves = lava ? {} : waterWaves(waterField(water, 'TextureKey'))
    const receiveShadows = waterField(water, 'ReceiveShadows')
    const beachModel = textField(waterField(water, 'BeachShoreline'))
    const cliffModel = textField(waterField(water, 'CliffShoreline'))
    // Core's CWater default names the lava model the map's own template inherits.
    const lavaModel = lava ? textField(waterField(water, 'LavaModel')) ?? 'DefaultLava' : undefined
    templates.set(
      templateId,
      Object.freeze({
        elevation,
        ...(beachModel === undefined ? {} : { beachModel }),
        ...(cliffModel === undefined ? {} : { cliffModel }),
        ...(lavaModel === undefined ? {} : { lavaModel }),
        ...(color === undefined
          ? {}
          : {
              material: Object.freeze({
                materialId: materialIds.get(templateId),
                label: templateId,
                classification: lava ? 'lava' : 'water',
                shorelineMode: 'terrain-clipped',
                color,
                ...(tiling === undefined ? {} : { uvScale: tiling }),
                ...(scroll === undefined ? {} : { scroll }),
                ...(colorFalloff === undefined ? {} : { colorFalloff }),
                ...(specularity === undefined ? {} : { specularity }),
                ...(specularScale === undefined ? {} : { specularScale }),
                ...(reflectivityPower === undefined ? {} : { reflectivityPower }),
                ...(causticsScale === undefined ? {} : { causticsScale }),
                ...(causticsFramesPerSecond === undefined ? {} : { causticsFramesPerSecond }),
                ...caustics,
                ...waves,
                ...(receiveShadows === undefined ? {} : { receiveShadows: receiveShadows === '1' }),
              }),
            }),
      }),
    )
  }
  return templates
}

/*
 * CWater.TextureKey is a stem, never a colour image: as a base colour it multiplied every sea by a
 * blue normal map (Amphion's Avernus went dark green, its BelShir ponds near black). Core ships
 * `DefaultWater01…44.dds` (the cheap flip-book water, played at FramesPerSec),
 * `DefaultWaterNormal.dds` (the wave normals of Water.fx: two normals in one image, scrolled by
 * ScrollVectors) and `DefaultWaterCaustics_001…032.dds`.
 */

/** The wave normals of Water.fx: `Normal` after the TextureKey stem. */
function waterWaves(textureKey) {
  const logicalId = catalogAssetLogicalId(undefined, 'TextureKey', catalogFieldValue(textureKey))
  if (logicalId === undefined) return {}
  const dot = logicalId.lastIndexOf('.')
  const stem = dot > logicalId.lastIndexOf('/') ? logicalId.slice(0, dot) : logicalId
  const extension = dot > logicalId.lastIndexOf('/') ? logicalId.slice(dot) : '.dds'
  const normalLogicalId = `${stem}Normal${extension}`
  const normalResourceId = `sc2-water-normal:${encodeURIComponent(normalLogicalId)}`
  return {
    normalResourceId,
    normalResource: Object.freeze({
      id: normalResourceId,
      logicalId: normalLogicalId,
      role: 'texture',
      scopes: Object.freeze(['current-mount', 'enclosing-container', 'workspace-dependency-layer']),
    }),
  }
}

/** Frames of the caustics flip-book; the engine appends `Caustics_%3.3d` to the TextureKey stem. */
const WATER_CAUSTICS_FRAMES = 32

/*
 * The light the surface throws on the bottom (Water.fx: saturate(CausticsFallOff x depth)): Core's
 * DefaultWater.dds plays DefaultWaterCaustics_001...032.dds at CausticsFPS. A state without
 * CausticsFallOff casts none, so its frames are not requested.
 */
function waterCaustics(textureKey, causticsFalloff) {
  if (causticsFalloff === undefined || !(causticsFalloff > 0)) return {}
  const logicalId = catalogAssetLogicalId(undefined, 'TextureKey', catalogFieldValue(textureKey))
  if (logicalId === undefined) return {}
  const dot = logicalId.lastIndexOf('.')
  const stem = dot > logicalId.lastIndexOf('/') ? logicalId.slice(0, dot) : logicalId
  const extension = dot > logicalId.lastIndexOf('/') ? logicalId.slice(dot) : '.dds'
  const frames = Array.from({ length: WATER_CAUSTICS_FRAMES }, (_, index) => {
    const frameLogicalId = `${stem}Caustics_${String(index + 1).padStart(3, '0')}${extension}`
    return Object.freeze({
      id: `sc2-water-caustics:${encodeURIComponent(frameLogicalId)}`,
      logicalId: frameLogicalId,
      role: 'texture',
      scopes: Object.freeze(['current-mount', 'enclosing-container', 'workspace-dependency-layer']),
    })
  })
  return {
    causticsFalloff,
    causticsResourceId: frames[0].id,
    causticsResource: frames[0],
    causticsFrameResourceIds: Object.freeze(frames.map(frame => frame.id)),
    causticsFrameResources: Object.freeze(frames),
  }
}

function catalogWaterTemplates(catalog) {
  const waters = (catalog?.definitions ?? catalog?.entities ?? []).filter(
    entity => entity.namespace === 'Water',
  )
  const materialIds = waterMaterialIds(waters.map(entity => entity.entityId))
  const templates = new Map()
  for (const water of waters) {
    const states = Array.isArray(water.fields?.State)
      ? water.fields.State
      : water.fields?.State === undefined
        ? []
        : [water.fields.State]
    // A resolved list holds indexed slots ({ index, value }); a raw one holds the states themselves.
    const state = states
      .map(item => recordOf(catalogFieldValue(item)))
      .find(candidate => candidate?.Height !== undefined)
    if (state === undefined) continue
    const templateId = water.entityId
    const elevation = finiteNumber(state.Height, `catalog:Water[${templateId}].State.Height`)
    const color = waterVector(state.Color, 4, `catalog:Water[${templateId}].State.Color`)
    const optionalNumber = (value, label) =>
      value === undefined ? undefined : finiteNumber(value, `catalog:Water[${templateId}].${label}`)
    const tiling = waterVector(
      water.fields?.TilingFreq,
      4,
      `catalog:Water[${templateId}].TilingFreq`,
    )
    const scroll = waterVector(
      water.fields?.ScrollVectors,
      4,
      `catalog:Water[${templateId}].ScrollVectors`,
    )
    const causticsScale = waterVector(
      water.fields?.CausticsTilingFreq,
      2,
      `catalog:Water[${templateId}].CausticsTilingFreq`,
    )
    const colorFalloff = optionalNumber(state.ColorFallOff, 'State.ColorFallOff')
    const specularity = optionalNumber(state.Specularity, 'State.Specularity')
    const specularScale = optionalNumber(state.SpecularScaler, 'State.SpecularScaler')
    const reflectivityPower = optionalNumber(state.ReflectivityPower, 'State.ReflectivityPower')
    const causticsFramesPerSecond = optionalNumber(water.fields?.CausticsFPS, 'CausticsFPS')
    const causticsFalloff = optionalNumber(state.CausticsFallOff, 'State.CausticsFallOff')
    const caustics = waterCaustics(water.fields?.TextureKey, causticsFalloff)
    const lava = String(water.fields?.IsLava ?? '0') === '1'
    const waves = lava ? {} : waterWaves(water.fields?.TextureKey)
    const beachModel = textField(catalogFieldValue(water.fields?.BeachShoreline))
    const cliffModel = textField(catalogFieldValue(water.fields?.CliffShoreline))
    const lavaModel = lava
      ? textField(catalogFieldValue(water.fields?.LavaModel)) ?? 'DefaultLava'
      : undefined
    templates.set(
      templateId,
      Object.freeze({
        elevation,
        ...(beachModel === undefined ? {} : { beachModel }),
        ...(cliffModel === undefined ? {} : { cliffModel }),
        ...(lavaModel === undefined ? {} : { lavaModel }),
        ...(color === undefined
          ? {}
          : {
              material: Object.freeze({
                materialId: materialIds.get(templateId),
                label: templateId,
                classification: lava ? 'lava' : 'water',
                shorelineMode: 'terrain-clipped',
                color,
                ...(tiling === undefined ? {} : { uvScale: tiling }),
                ...(scroll === undefined ? {} : { scroll }),
                ...(colorFalloff === undefined ? {} : { colorFalloff }),
                ...(specularity === undefined ? {} : { specularity }),
                ...(specularScale === undefined ? {} : { specularScale }),
                ...(reflectivityPower === undefined ? {} : { reflectivityPower }),
                ...(causticsScale === undefined ? {} : { causticsScale }),
                ...(causticsFramesPerSecond === undefined ? {} : { causticsFramesPerSecond }),
                ...caustics,
                ...waves,
                ...(water.fields?.ReceiveShadows === undefined
                  ? {}
                  : { receiveShadows: String(water.fields.ReceiveShadows) === '1' }),
              }),
            }),
      }),
    )
  }
  return templates
}

function parseWater(document, request, templateDocument, catalog) {
  const bytes = document.bytes
  if (bytes.byteLength < 32 || textDecoder.decode(bytes.subarray(0, 4)) !== 'WATR') {
    throw new TypeError(`${document.path}: WATR header is missing or truncated`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  const count = view.getUint32(8, true)
  const required = 32 + count * 56
  if (
    !Number.isSafeInteger(required) ||
    count > request.maxTerrainCells ||
    required > bytes.length
  ) {
    throw new TypeError(`${document.path}: WATR zone array is invalid or exceeds maxTerrainCells`)
  }
  // The resolved catalog already contains dependency inheritance and local patches. A raw local
  // WaterData document is only a fallback for templates absent from that effective snapshot;
  // replacing the catalog wholesale here silently discarded inherited retail material fields.
  const templates = catalogWaterTemplates(catalog)
  if (templateDocument !== undefined) {
    for (const [templateId, template] of parseWaterTemplates(templateDocument, request)) {
      if (!templates.has(templateId)) templates.set(templateId, template)
    }
  }
  const zones = []
  for (let index = 0; index < count; index += 1) {
    const offset = 32 + index * 56
    const startX = view.getFloat32(offset + 40, true)
    const startY = view.getFloat32(offset + 44, true)
    const endX = view.getFloat32(offset + 48, true)
    const endY = view.getFloat32(offset + 52, true)
    if (![startX, startY, endX, endY].every(Number.isFinite)) {
      throw new TypeError(`${document.path}: water zone ${index} contains a non-finite bound`)
    }
    const templateId = ascii(bytes.subarray(offset, offset + 40))
    const template = templates.get(templateId)
    const elevation = template?.elevation
    zones.push(
      Object.freeze({
        zoneId: index,
        templateId,
        minimum: Object.freeze({ x: Math.min(startX, endX), y: Math.min(startY, endY) }),
        maximum: Object.freeze({ x: Math.max(startX, endX), y: Math.max(startY, endY) }),
        ...(elevation === undefined ? {} : { elevation }),
        ...(template?.material === undefined ? {} : { materialId: template.material.materialId }),
      }),
    )
  }
  return Object.freeze({
    version,
    zones: Object.freeze(zones),
    materials: Object.freeze(
      [...new Set(zones.map(zone => zone.materialId).filter(Boolean))]
        .map(
          materialId =>
            [...templates.values()].find(item => item.material?.materialId === materialId)
              ?.material,
        )
        .filter(Boolean),
    ),
    allTemplateElevationsResolved: zones.every(zone => zone.elevation !== undefined),
    allTemplateMaterialsResolved: zones.every(zone => zone.materialId !== undefined),
  })
}

function boundedGridIndices(cellCount, maximum) {
  const count = Math.min(cellCount, maximum)
  if (count === cellCount) return undefined
  const selected = new Set()
  for (let index = 0; index < count; index += 1) {
    selected.add(count === 1 ? 0 : Math.floor((index * (cellCount - 1)) / (count - 1)))
  }
  return selected
}

/** Synchronized cliff levels per band: A, B, C, D are 0, 4, 8, 12 and ramps step between them. */
const CLIFF_LEVEL_BAND = 4

function parseCliffs(document, terrain, request) {
  const bytes = document.bytes
  if (bytes.byteLength < 32 || textDecoder.decode(bytes.subarray(0, 4)) !== 'CLIF') {
    throw new TypeError(`${document.path}: CLIF header is missing or truncated`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  const cellCount = width * height
  const required = 32 + cellCount * 2
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    cellCount > request.maxTerrainCells ||
    required > bytes.length
  ) {
    throw new TypeError(`${document.path}: CLIF grid is invalid or exceeds maxTerrainCells`)
  }
  const selected = boundedGridIndices(cellCount, request.maxTerrainSamples)
  const terrainSamples = new Map(
    (terrain?.width === width && terrain?.height === height ? terrain.samples : []).map(sample => [
      `${sample.x}:${sample.y}`,
      sample,
    ]),
  )
  const samples = []
  for (let index = 0; index < cellCount; index += 1) {
    if (selected !== undefined && !selected.has(index)) continue
    const x = index % width
    const y = Math.floor(index / width)
    const raw = view.getUint16(32 + index * 2, true)
    const terrainSample = terrainSamples.get(`${x}:${y}`)
    const level = ((raw + 8) >> 4) & 0xffff
    samples.push(
      Object.freeze({
        x,
        y,
        level,
        authored: terrainSample === undefined ? false : (terrainSample.mask & 0x9000) !== 0,
        // Cliff levels come in bands of four (`<ramp lo hi>` counts in fours); a ramp steps
        // through the levels between two bands, where no cliff stands (Amphion: 5–7, 9–11).
        ...(level % CLIFF_LEVEL_BAND === 0 ? {} : { ramp: true }),
      }),
    )
  }
  return Object.freeze({
    version,
    width,
    height,
    cellCount,
    samples: Object.freeze(samples),
    exact: samples.length === cellCount,
  })
}

function parseTerrainMaterials(document, terrainDocument, request) {
  const bytes = document.bytes
  if (bytes.byteLength < 16 || textDecoder.decode(bytes.subarray(0, 4)) !== 'RTXT') {
    throw new TypeError(`${document.path}: RTXT header is missing or truncated`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  const cellCount = width * height
  const cellBytes = cellCount * 4
  const cellsOffset = bytes.length - cellBytes
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    cellCount > request.maxTerrainCells ||
    cellsOffset < 16
  ) {
    throw new TypeError(`${document.path}: RTXT grid is invalid or exceeds maxTerrainCells`)
  }
  const textureNames = []
  let nameOffset = 16
  while (nameOffset < cellsOffset) {
    let end = nameOffset
    while (end < cellsOffset && bytes[end] !== 0) end += 1
    const name = textDecoder.decode(bytes.subarray(nameOffset, end))
    if (name.length > 0) textureNames.push(name)
    nameOffset = end + 1
  }
  if (textureNames.length === 0 && terrainDocument !== undefined) {
    textureNames.push(...terrainTextureNames(terrainDocument, request.maxDepth))
  }
  const selected = boundedGridIndices(cellCount, request.maxTerrainSamples)
  const samples = []
  for (let index = 0; index < cellCount; index += 1) {
    if (selected !== undefined && !selected.has(index)) continue
    const textureIndex = view.getUint32(cellsOffset + index * 4, true)
    const textureName = textureNames[textureIndex]
    samples.push(
      Object.freeze({
        x: index % width,
        y: Math.floor(index / width),
        textureIndex,
        ...(textureName === undefined ? {} : { textureName }),
      }),
    )
  }
  return Object.freeze({
    version,
    width,
    height,
    cellCount,
    textureNames: Object.freeze(textureNames),
    samples: Object.freeze(samples),
    exact: samples.length === cellCount,
    weightEncoding: 'dominant-only',
  })
}

function textureMaskWeight(body, blocksPerLayer, tilesX, layer, x, y) {
  const tileX = Math.floor(x / 64)
  const tileY = Math.floor(y / 64)
  const localX = x % 64
  const localY = y % 64
  const block = layer * blocksPerLayer + tileY * tilesX + tileX
  const byte = body[block * 2048 + localY * 32 + (localX >> 1)] ?? 0
  return (localX & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f
}

const MAXIMUM_TERRAIN_WEIGHT_RASTER_BYTES = 64 * 1024 * 1024
const MAXIMUM_TERRAIN_WEIGHT_RASTER_CELLS = MAXIMUM_TERRAIN_WEIGHT_RASTER_BYTES / 4

function textureMaskRasters(body, blocksPerLayer, tilesX, width, height, layers) {
  const groups = Math.ceil(layers / 4)
  const bytesPerRaster = width * height * 4
  const totalBytes = bytesPerRaster * groups
  if (
    !Number.isSafeInteger(bytesPerRaster) ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > MAXIMUM_TERRAIN_WEIGHT_RASTER_BYTES
  ) {
    return undefined
  }
  return Object.freeze(
    Array.from({ length: groups }, (_, group) => {
      const rgba = new Uint8Array(bytesPerRaster)
      const materialIds = []
      for (let channel = 0; channel < 4; channel += 1) {
        const layer = group * 4 + channel
        if (layer >= layers) break
        materialIds.push(`material-${String(layer)}`)
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            rgba[(y * width + x) * 4 + channel] =
              textureMaskWeight(body, blocksPerLayer, tilesX, layer, x, y) * 17
          }
        }
      }
      return Object.freeze({
        resourceId: `sc2-terrain-splat:${String(group)}`,
        width,
        height,
        materialIds: Object.freeze(materialIds),
        encoding: 'rgba8-unorm',
        normalization: 'sum',
        rgba,
      })
    }),
  )
}

function parseTerrainTextureMasks(document, terrainDocument, request, terrainGrid) {
  const bytes = document.bytes
  if (bytes.byteLength < 64 || textDecoder.decode(bytes.subarray(0, 4)) !== 'MASK') {
    throw new TypeError(`${document.path}: MASK header is missing or truncated`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  const width = view.getUint32(12, true)
  const height = view.getUint32(16, true)
  const cellCount = width * height
  // MASK resolution is an authored splat-raster resolution, not the heightfield cell count.
  // Samples remain bounded by maxTerrainSamples and decoded RGBA storage by the raster byte ceiling.
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    cellCount > MAXIMUM_TERRAIN_WEIGHT_RASTER_CELLS
  ) {
    throw new TypeError(`${document.path}: MASK grid is invalid or exceeds the raster byte ceiling`)
  }
  const tilesX = Math.ceil(width / 64)
  const tilesY = Math.ceil(height / 64)
  const blocksPerLayer = tilesX * tilesY
  const totalBlocks = Math.floor((bytes.byteLength - 64) / 2048)
  const layers = Math.floor(totalBlocks / blocksPerLayer)
  if (!Number.isSafeInteger(layers) || layers <= 0 || layers > 256) {
    throw new TypeError(`${document.path}: MASK layer count is invalid or unsupported`)
  }
  const bodyLength = layers * blocksPerLayer * 2048
  if (!Number.isSafeInteger(bodyLength) || 64 + bodyLength > bytes.byteLength) {
    throw new TypeError(`${document.path}: MASK layer blocks are truncated`)
  }
  const body = bytes.subarray(64, 64 + bodyLength)
  const weightRasters = textureMaskRasters(body, blocksPerLayer, tilesX, width, height, layers)
  const textureNames =
    terrainDocument === undefined ? [] : terrainTextureNames(terrainDocument, request.maxDepth)
  const uvTransform =
    terrainDocument === undefined ? undefined : terrainUvTransform(terrainDocument, request.maxDepth)
  const materials = Object.freeze(
    Array.from({ length: layers }, (_, sourceIndex) =>
      Object.freeze({
        materialId: `material-${String(sourceIndex)}`,
        sourceIndex,
        label: textureNames[sourceIndex] ?? `Texture ${String(sourceIndex)}`,
        ...(uvTransform === undefined ? {} : { uvTransform }),
      }),
    ),
  )
  const previewGrid =
    cellCount > request.maxTerrainSamples &&
    Number.isSafeInteger(terrainGrid?.width) &&
    Number.isSafeInteger(terrainGrid?.height) &&
    terrainGrid.width >= 2 &&
    terrainGrid.height >= 2 &&
    terrainGrid.width * terrainGrid.height <= request.maxTerrainSamples
      ? Object.freeze({ width: terrainGrid.width, height: terrainGrid.height })
      : undefined
  const outputWidth = previewGrid?.width ?? width
  const outputHeight = previewGrid?.height ?? height
  const outputCellCount = outputWidth * outputHeight
  const selected =
    previewGrid === undefined ? boundedGridIndices(cellCount, request.maxTerrainSamples) : undefined
  const samples = []
  for (let outputIndex = 0; outputIndex < outputCellCount; outputIndex += 1) {
    const x = outputIndex % outputWidth
    const y = Math.floor(outputIndex / outputWidth)
    const sourceX =
      previewGrid === undefined
        ? x
        : Math.min(width - 1, Math.round((x * width) / (outputWidth - 1)))
    const sourceY =
      previewGrid === undefined
        ? y
        : Math.min(height - 1, Math.round((y * height) / (outputHeight - 1)))
    const sourceIndex = sourceY * width + sourceX
    if (selected !== undefined && !selected.has(sourceIndex)) continue
    const raw = Array.from({ length: layers }, (_, layer) =>
      textureMaskWeight(body, blocksPerLayer, tilesX, layer, sourceX, sourceY),
    )
    const total = raw.reduce((sum, weight) => sum + weight, 0)
    const normalized =
      total === 0 ? raw.map((_, layer) => (layer === 0 ? 1 : 0)) : raw.map(weight => weight / total)
    let textureIndex = 0
    for (let layer = 1; layer < normalized.length; layer += 1) {
      if (normalized[layer] > normalized[textureIndex]) textureIndex = layer
    }
    samples.push(
      Object.freeze({
        x,
        y,
        textureIndex,
        textureName: materials[textureIndex].label,
        weights: Object.freeze(
          normalized.flatMap((weight, layer) =>
            weight === 0
              ? []
              : [
                  Object.freeze({
                    materialId: `material-${String(layer)}`,
                    weight,
                  }),
                ],
          ),
        ),
      }),
    )
  }
  return Object.freeze({
    version,
    width: outputWidth,
    height: outputHeight,
    cellCount: outputCellCount,
    textureNames: Object.freeze(materials.map(material => material.label)),
    materials,
    samples: Object.freeze(samples),
    exact: previewGrid === undefined && samples.length === cellCount,
    weightEncoding: 'normalized-exact',
    maskResolution: Object.freeze({ width, height, layers }),
    ...(weightRasters === undefined ? {} : { weightRasters }),
  })
}

function bindTerrainMaterialResources(summary, catalog, diagnostics) {
  if (summary === undefined) return undefined
  const entities = new Map(
    (catalog?.definitions ?? catalog?.entities ?? [])
      .filter(entity => entity.namespace === 'TerrainTex')
      .map(entity => [entity.entityId, entity]),
  )
  let unresolved = 0
  const materials = (summary.materials ?? []).map(material => {
    const entity = entities.get(material.label)
    const logicalId = catalogAssetLogicalId(entity, 'Texture', entity?.fields?.Texture)
    if (logicalId === undefined) {
      unresolved += 1
      return material
    }
    const resourceId = `sc2-terrain-texture:${encodeURIComponent(material.label)}`
    const normalLogicalId = catalogAssetLogicalId(entity, 'Normalmap', entity?.fields?.Normalmap)
    const normalResourceId = `sc2-terrain-normal:${encodeURIComponent(material.label)}`
    return Object.freeze({
      ...material,
      baseColorResourceId: resourceId,
      baseColorResource: Object.freeze({
        id: resourceId,
        logicalId,
        role: 'texture',
        scopes: Object.freeze([
          'current-mount',
          'enclosing-container',
          'workspace-dependency-layer',
        ]),
      }),
      ...(normalLogicalId === undefined
        ? {}
        : {
            normalResourceId,
            // Terrain normal maps ship DXN-swizzled: Shaders/TerrainBlend.fx UnSwizzleNormals reads
            // X from alpha and Y from green and rebuilds Z (red carries height for the
            // NORMALHEIGHT blend mode, blue is unused).
            normalEncoding: 'xy-in-alpha-green',
            normalResource: Object.freeze({
              id: normalResourceId,
              logicalId: normalLogicalId,
              role: 'texture',
              scopes: Object.freeze([
                'current-mount',
                'enclosing-container',
                'workspace-dependency-layer',
              ]),
            }),
          }),
    })
  })
  if (unresolved > 0) {
    diagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.starcraft2/map-terrain-texture-catalog-required',
        message: `${String(unresolved)} terrain materials require resolved TerrainTex catalog entities for raster binding`,
      }),
    )
  }
  return Object.freeze({ ...summary, materials: Object.freeze(materials) })
}

function lightingInformation(diagnostics, code, message, path) {
  diagnostics.push(
    Object.freeze({
      severity: 'information',
      code,
      message,
      ...(path === undefined ? {} : { path }),
    }),
  )
}

/**
 * The tileset's height fog: CTerrain FogEnabled, FogColor ("A,R,G,B" bytes), FogDensity, FogFalloff and
 * FogStartingHeight, as a map overrides them in its own TerrainData (Highland: white fog over the low
 * ground). Heights are map-native z, the same values as the UVW up axis. Shaders/Common.fx FogDensity
 * and PSFog.fx apply it; an unreadable field leaves the fog out with a notice.
 */
function terrainFog(terrain, tileSet, diagnostics, path) {
  const fields = terrain?.fields ?? {}
  const enabled = catalogFieldValue(fields.FogEnabled)
  if (enabled === undefined || Number(enabled) === 0) return undefined
  const color = String(catalogFieldValue(fields.FogColor) ?? '').split(',').map(part => Number(part.trim()))
  const number = name => {
    const value = catalogFieldValue(fields[name])
    return value === undefined ? 0 : Number(value)
  }
  const density = number('FogDensity'), falloff = number('FogFalloff'), startingHeight = number('FogStartingHeight')
  if (color.length !== 4 || color.some(part => !Number.isInteger(part) || part < 0 || part > 255) ||
    !(density >= 0) || !(falloff >= 0) || !Number.isFinite(density) || !Number.isFinite(falloff) || !Number.isFinite(startingHeight)) {
    lightingInformation(diagnostics, 'blizzard.starcraft2/map-fog-unreadable',
      `tileset ${tileSet} CTerrain fog fields are not readable (FogColor "A,R,G,B" bytes, non-negative FogDensity and FogFalloff)`, path)
    return undefined
  }
  if (density === 0) return undefined
  return Object.freeze({
    color: Object.freeze([color[1] / 255, color[2] / 255, color[3] / 255]),
    density,
    falloff,
    startingHeight,
  })
}

/** Resolve the map tileset's dependency-merged CTerrain -> CLight chain into the common static facet. */
function resolveCatalogLighting(terrainDocument, catalog, maxDepth, diagnostics) {
  if (terrainDocument === undefined || catalog === undefined) return undefined
  const root = xmlRoot(terrainDocument, 'terrain', maxDepth)
  const heightMap = oneChild(root, 'heightMap', `${terrainDocument.path}:terrain`)
  const tileSet = heightMap.attributes?.tileSet
  if (typeof tileSet !== 'string' || tileSet.length === 0) {
    lightingInformation(
      diagnostics,
      'blizzard.starcraft2/map-lighting-tileset-unavailable',
      'world lighting is unavailable because t3Terrain.xml does not name a tileset',
      terrainDocument.path,
    )
    return undefined
  }
  const definitions = catalog.definitions ?? catalog.entities ?? []
  const terrain = definitions.find(
    entity => entity.namespace === 'Terrain' && entity.entityId === tileSet,
  )
  const lightId = catalogFieldValue(terrain?.fields?.Lighting)
  if (typeof lightId !== 'string' || lightId.length === 0) {
    lightingInformation(
      diagnostics,
      'blizzard.starcraft2/map-lighting-catalog-required',
      `tileset ${tileSet} has no resolved CTerrain.Lighting catalog link`,
      terrainDocument.path,
    )
    return undefined
  }
  const light = definitions.find(
    entity => entity.namespace === 'Light' && entity.entityId === lightId,
  )
  if (light === undefined) {
    lightingInformation(
      diagnostics,
      'blizzard.starcraft2/map-lighting-catalog-required',
      `tileset ${tileSet} references unresolved CLight ${lightId}`,
      terrainDocument.path,
    )
    return undefined
  }
  const projection = projectCatalogLight(light)
  if (projection.status === 'no-static-key') {
    lightingInformation(
      diagnostics,
      'blizzard.starcraft2/map-lighting-state-unavailable',
      `CLight ${lightId} has no static state with a Key direction`,
      terrainDocument.path,
    )
    return undefined
  }
  if (projection.status === 'no-ambient') {
    lightingInformation(
      diagnostics,
      'blizzard.starcraft2/map-lighting-state-unavailable',
      `CLight ${lightId} selected state has no ambient color`,
      terrainDocument.path,
    )
    return undefined
  }
  if (projection.status === 'no-directional') return undefined
  if (projection.hasTimeOfDayStates) {
    lightingInformation(
      diagnostics,
      'blizzard.starcraft2/map-lighting-static-state-selected',
      `CLight ${lightId} contains ${String(projection.stateCount)} authored states; the last state with a complete Key direction is published as the static preview environment`,
      terrainDocument.path,
    )
  }
  const shadowRange = gameCameraShadowRange(definitions)
  const fog = terrainFog(terrain, tileSet, diagnostics, terrainDocument.path)
  return Object.freeze({
    lighting: Object.freeze({
      ...projection.lighting,
      ...(shadowRange === undefined ? {} : { shadowRange }),
      ...(fog === undefined ? {} : { fog }),
    }),
    hasTimeOfDayStates: projection.hasTimeOfDayStates,
  })
}

function duplicateIdentityDiagnostics(items, key, label, path) {
  const seen = new Set()
  const diagnostics = []
  for (const item of items) {
    const identity = item[key]
    if (seen.has(identity)) {
      diagnostics.push(
        Object.freeze({
          severity: 'error',
          code: `blizzard.starcraft2/map-${label}-id-duplicate`,
          message: `${path}: duplicate ${label} identity ${String(identity)}`,
          path,
          [`${label}Id`]: identity,
        }),
      )
    }
    seen.add(identity)
  }
  return diagnostics
}

function catalogEntityKey(namespace, entityId) {
  return `${namespace}\u0000${entityId}`
}

function textField(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}


const ACTOR_UNIT_CREATION_EVENTS = new Set(['unitbirth', 'unitconstruction', 'unitrevive'])

function actorUnitAssociations(actor) {
  const fields = actor?.fields ?? {}
  const unitName = textField(fields.unitName)?.toLowerCase()
  const associations = new Map()
  let otherCreate = false
  const on = Array.isArray(fields.On) ? fields.On : []
  for (const entry of on) {
    const item = resolvedFieldRecord(entry)
    if (
      String(item?.Send ?? '')
        .trim()
        .toLowerCase() !== 'create'
    )
      continue
    const [event, argument] = String(item?.Terms ?? '')
      .split(';')[0]
      .trim()
      .split('.')
    const eventId = event.toLowerCase()
    const creation = ACTOR_UNIT_CREATION_EVENTS.has(eventId)
    const death = eventId === 'unitdeath'
    if (!creation && !death) {
      otherCreate = true
      continue
    }
    const unitId = argument !== undefined && argument !== '*' ? argument.toLowerCase() : unitName
    if (unitId === undefined || unitId.length === 0) continue
    const association = associations.get(unitId) ?? {
      creation: false,
      death: false,
      viaUnitName: unitId === unitName,
    }
    if (creation) association.creation = true
    if (death) association.death = true
    associations.set(unitId, association)
  }
  if (unitName !== undefined && !associations.has(unitName)) {
    associations.set(unitName, { creation: false, death: false, viaUnitName: true })
  }
  return [...associations.entries()].map(([unitId, association]) => ({
    unitId,
    association: Object.freeze({ ...association, otherCreate }),
  }))
}

function actorCandidateScore(candidate) {
  let score = 0
  if (candidate.association.creation) score += 100
  if (
    candidate.association.death &&
    !candidate.association.creation &&
    !candidate.association.otherCreate
  )
    score -= 50
  // A unit's main actor must outrank a hosted decal/effect that also listens to UnitBirth.
  // Its own creation row can be supplied by a macro (or replaced by a quality ModelSwap).
  if (candidate.actor.typeId === 'CActorUnit') score += 100
  if (candidate.association.viaUnitName) score += 5
  return score
}

/**
 * The models an actor shows in the game, in the order to try them. `EditorModel` is what only the
 * editor draws: a doodad's weather helper (RainEmitterMedium, Sunrays: WeatherHelper), a logo
 * placeholder whose game model is Invisible, a vision or pathing blocker's marker. The world is the
 * game's, so it is never taken; a unit falls back to its placement ghost, which is its own model.
 */
function actorModelIds(actor, objectKind) {
  const fields = actor?.fields ?? {}
  const fieldOrder = objectKind === 'doodad' ? ['Model'] : ['Model', 'PlacementModel']
  return [
    ...new Set(
      fieldOrder
        .map(fieldId => textField(fields[fieldId]))
        .filter(modelId => modelId !== undefined && !modelId.includes('##')),
    ),
  ]
}



function addCatalogQuery(queries, queryKeys, namespace, entityId) {
  const ref = Object.freeze({ namespace, entityId })
  const key = catalogEntityKey(namespace, entityId)
  if (!queryKeys.has(key)) {
    queryKeys.add(key)
    queries.push(ref)
  }
  return key
}

/**
 * Models of the splats a unit's actor creates at rest (CActorSplat through a `Create` message): a mineral
 * field's scatter of small crystals (MineralFieldSplat[Small] by its resource level). Other created actors —
 * sounds, lights, effects — are not models the map shows. SC2 picks the splat's variation at random;
 * here the object id picks it, so copies differ and a reopened map looks the same.
 */
function createdSplatResources(object, createdActors, entities, queries, queryKeys) {
  const resources = []
  for (const actorId of createdActors) {
    const actor = entities.get(addCatalogQuery(queries, queryKeys, 'Actor', actorId))
    if (actor?.typeId !== 'CActorSplat') continue
    for (const modelId of actorModelIds(actor, 'doodad')) {
      const model = entities.get(addCatalogQuery(queries, queryKeys, 'Model', modelId))
      const catalogLogicalId = catalogAssetLogicalId(model, 'Model', model?.fields?.Model)
      if (catalogLogicalId === undefined) continue
      const count = Number(model?.fields?.VariationCount)
      const variation = Number.isSafeInteger(count) && count > 1 ? Math.abs(object.objectId) % count : undefined
      resources.push(Object.freeze({
        id: `sc2-map-model:${encodeURIComponent(actorId)}:${encodeURIComponent(modelId)}${variation === undefined ? '' : `:variation-${String(variation).padStart(2, '0')}`}`,
        logicalId: catalogModelVariationLogicalId(catalogLogicalId, variation),
        role: 'sidecar',
        scopes: Object.freeze(['current-mount', 'enclosing-container', 'workspace-dependency-layer']),
      }))
      break
    }
  }
  return resources
}

/**
 * The texture variants a placed model loads: its CModel TextureDeclares name textures by prefix and
 * substring (DecalProtoss00_ + _Diffuse), and the CTerrain of the placement's TileSet (the map's
 * when it names none) gives the TextureProp that suffixes them (DecalProtoss00_Diffuse_monlyth.dds).
 * A tileset without TextureProp (the Wings of Liberty ones) keeps the textures as named.
 */
function modelTextureVariantFor(model, object, mapTileSet, entities, queries, queryKeys) {
  const declares = Array.isArray(model?.fields?.TextureDeclares) ? model.fields.TextureDeclares : []
  if (declares.length === 0) return undefined
  const tileSet = object.tileSet ?? mapTileSet
  if (typeof tileSet !== 'string' || tileSet.length === 0) return undefined
  const terrain = entities.get(addCatalogQuery(queries, queryKeys, 'Terrain', tileSet))
  const prop = catalogFieldValue(terrain?.fields?.TextureProp)
  if (typeof prop !== 'string' || prop.length === 0) return undefined
  const names = []
  for (const entry of declares) {
    const declare = recordOf(catalogFieldValue(entry))
    const prefix = declare?.Prefix
    if (typeof prefix !== 'string' || prefix.length === 0) continue
    for (const adaption of Array.isArray(declare.Adaptions) ? declare.Adaptions : []) {
      // An adaption without TriggerOnSubstring takes every texture of the prefix (Bush: bush_).
      const contains = recordOf(catalogFieldValue(adaption))?.TriggerOnSubstring ?? ''
      if (typeof contains === 'string') names.push(Object.freeze({ prefix, contains }))
    }
  }
  return names.length === 0 ? undefined : Object.freeze({ suffix: `_${prop}`, names: Object.freeze(names) })
}

function modelResourceFor(object, entities, actorByUnit, queries, queryKeys, modelTyped = false, mapTileSet = undefined) {
  let candidates = []
  // A fluff doodad names its CModel directly (a TerrainTex DoodadEntry); it has no actor to ask for.
  if (object.kind === 'doodad' && !modelTyped) {
    const actor = entities.get(catalogEntityKey('Actor', object.typeId))
    if (actor !== undefined) candidates = [{ actor }]
    addCatalogQuery(queries, queryKeys, 'Actor', object.typeId)
  } else if (object.kind === 'unit') {
    candidates = actorByUnit.get(object.typeId.toLowerCase()) ?? []
    // Retail CActorUnit templates commonly keep unitName/Model tokenized in the normalized
    // catalog snapshot even though the concrete standing actor and model use the unit id. Keep
    // an explicit association/event match authoritative, but admit the shipped same-id actor as
    // a deterministic fallback when the tokenized reverse index cannot name the unit yet.
    if (candidates.length === 0) {
      const actor = entities.get(catalogEntityKey('Actor', object.typeId))
      if (actor !== undefined) candidates = [{ actor }]
      addCatalogQuery(queries, queryKeys, 'Actor', object.typeId)
    }
  }

  const attempts = []
  let presentation
  let createdActors
  for (const candidate of candidates) {
    const actor = candidate.actor
    addCatalogQuery(queries, queryKeys, 'Actor', actor.entityId)
    const initial = initialActorPresentation(object, actor, (namespace, id) =>
      entities.get(addCatalogQuery(queries, queryKeys, namespace, id)))
    presentation ??= initial.presentationAnimation
    createdActors ??= initial.createdActors
    if (initial.modelId !== undefined) attempts.push(initial.modelId)
    for (const modelId of actorModelIds(actor, object.kind)) attempts.push(modelId)
  }
  const splats = createdSplatResources(object, createdActors ?? [], entities, queries, queryKeys)
  // Shipped doodad actors and tokenized CActorUnit templates commonly omit a concrete Model in
  // this normalized view and use the like-named CModel entry.
  if (object.kind === 'doodad' || object.kind === 'unit') attempts.push(object.typeId)
  for (const modelId of new Set(attempts)) {
    const modelKey = addCatalogQuery(queries, queryKeys, 'Model', modelId)
    const model = entities.get(modelKey)
    const catalogLogicalId = catalogAssetLogicalId(model, 'Model', model?.fields?.Model)
    const variation = modelVariationFor(model, object)
    const logicalId =
      catalogLogicalId === undefined
        ? undefined
        : catalogModelVariationLogicalId(catalogLogicalId, variation)
    if (logicalId !== undefined) {
      const textureVariant = modelTextureVariantFor(model, object, mapTileSet, entities, queries, queryKeys)
      return Object.freeze({
        ...(presentation === undefined ? {} : { presentationAnimation: presentation }),
        ...(splats.length === 0 ? {} : { modelResources: Object.freeze(splats) }),
        ...(textureVariant === undefined ? {} : { modelTextureVariant: textureVariant }),
        modelResource: Object.freeze({
        id: `sc2-map-model:${encodeURIComponent(object.typeId)}:${encodeURIComponent(modelId)}${variation === undefined ? '' : `:variation-${String(variation).padStart(2, '0')}`}${textureVariant === undefined ? '' : `:textures${encodeURIComponent(textureVariant.suffix)}`}`,
        logicalId,
        role: 'sidecar',
        scopes: Object.freeze([
          'current-mount',
          'enclosing-container',
          'workspace-dependency-layer',
        ]),
        }),
      })
    }
  }
  return undefined
}

function bindCatalog(objects, catalog, diagnostics, modelTyped = new Set(), mapTileSet = undefined) {
  const queries = []
  const queryKeys = new Set()
  for (const object of objects) {
    if (!['unit', 'doodad'].includes(object.kind) || object.typeId.length === 0) continue
    const ref = Object.freeze({
      namespace: object.kind === 'unit' ? 'Unit' : modelTyped.has(object) ? 'Model' : 'Actor',
      entityId: object.typeId,
    })
    const key = catalogEntityKey(ref.namespace, ref.entityId)
    if (!queryKeys.has(key)) {
      queryKeys.add(key)
      queries.push(ref)
    }
  }
  const entities = new Map(
    (catalog?.definitions ?? catalog?.entities ?? []).map(entity => [
      catalogEntityKey(entity.namespace, entity.entityId),
      entity,
    ]),
  )
  const actorByUnit = new Map()
  for (const entity of entities.values()) {
    if (entity.namespace !== 'Actor') continue
    for (const binding of actorUnitAssociations(entity)) {
      const candidates = actorByUnit.get(binding.unitId) ?? []
      candidates.push({ actor: entity, association: binding.association })
      actorByUnit.set(binding.unitId, candidates)
    }
  }
  for (const candidates of actorByUnit.values()) {
    candidates.sort(
      (left, right) =>
        actorCandidateScore(right) - actorCandidateScore(left) ||
        left.actor.entityId.localeCompare(right.actor.entityId),
    )
  }
  const missing = new Map()
  let resolvedCatalogObjects = 0
  const bound = objects.map(placed => {
    // The TileSet only picks texture variants; the placed object does not publish it.
    const { tileSet: _tileSet, ...object } = placed
    if (!['unit', 'doodad'].includes(object.kind) || object.typeId.length === 0) return placed.tileSet === undefined ? placed : Object.freeze(object)
    const namespace = object.kind === 'unit' ? 'Unit' : modelTyped.has(placed) ? 'Model' : 'Actor'
    const ref = Object.freeze({ namespace, entityId: object.typeId })
    const entity = entities.get(catalogEntityKey(ref.namespace, ref.entityId))
    if (entity === undefined) missing.set(catalogEntityKey(ref.namespace, ref.entityId), ref)
    else if (object.kind === 'unit') resolvedCatalogObjects += 1
    const presentation =
      catalog === undefined
        ? undefined
        : modelResourceFor(placed, entities, actorByUnit, queries, queryKeys, modelTyped.has(placed), mapTileSet)
    return Object.freeze({
      ...object,
      catalog: Object.freeze({ ref, ...(entity === undefined ? {} : { entity }) }),
      ...presentation,
    })
  })
  if (queries.length > 0 && catalog === undefined) {
    diagnostics.push({
      severity: 'information',
      code: 'blizzard.starcraft2/map-catalog-required',
      message: `reopen with the ${queries.length} catalogQueries to bind placed units to schema entities`,
    })
  } else {
    for (const ref of missing.values()) {
      diagnostics.push({
        severity: 'error',
        code: 'blizzard.starcraft2/map-catalog-entity-unresolved',
        message: `placed objects reference unavailable catalog entity ${ref.namespace}/${ref.entityId}`,
        catalogRef: ref,
      })
    }
  }
  return {
    objects: Object.freeze(bound),
    catalogQueries: Object.freeze(queries),
    resolvedCatalogObjects,
  }
}

/** SC2's game camera. Core CameraData gives it ShadowClip 75 at a 27.8° field of view. */
const GAME_CAMERA_ID = 'Dflt'

/**
 * Where SC2 draws shadows: within the game camera's ShadowClip of the eye (its FieldOfView frames
 * the view). Zoomed out past it, as the editor's whole-map view is, no shadow shows. Undefined when
 * the catalog does not resolve both parameters.
 */
function gameCameraShadowRange(definitions) {
  const camera = definitions.find(entity => entity.namespace === 'Camera' && entity.entityId === GAME_CAMERA_ID)
  const entries = Array.isArray(camera?.fields?.ParamInitial) ? camera.fields.ParamInitial : []
  const parameters = new Map(entries.map(entry => [String(entry?.index), Number(catalogFieldValue(entry))]))
  const distance = parameters.get('ShadowClip'), fieldOfViewDegrees = parameters.get('FieldOfView')
  return Number.isFinite(distance) && distance > 0 && Number.isFinite(fieldOfViewDegrees) && fieldOfViewDegrees > 0
    ? Object.freeze({ distance, fieldOfViewDegrees })
    : undefined
}

function lightingCatalogQueries(terrainDocument, catalog, maxDepth) {
  if (terrainDocument === undefined) return Object.freeze([])
  const root = xmlRoot(terrainDocument, 'terrain', maxDepth)
  const heightMap = oneChild(root, 'heightMap', `${terrainDocument.path}:terrain`)
  const tileSet = heightMap.attributes?.tileSet
  if (typeof tileSet !== 'string' || tileSet.length === 0) return Object.freeze([])
  // The game camera bounds where shadows are drawn (see `gameCameraShadowRange`).
  const queries = [{ namespace: 'Terrain', entityId: tileSet }, { namespace: 'Camera', entityId: GAME_CAMERA_ID }]
  const definitions = catalog?.definitions ?? catalog?.entities ?? []
  const terrain = definitions.find(
    entity => entity.namespace === 'Terrain' && entity.entityId === tileSet,
  )
  const lightId = catalogFieldValue(terrain?.fields?.Lighting)
  if (typeof lightId === 'string' && lightId.length > 0) {
    queries.push({ namespace: 'Light', entityId: lightId })
  }
  return Object.freeze(queries.map(query => Object.freeze(query)))
}

function catalogDefinition(catalog, namespace, entityId) {
  return (catalog?.definitions ?? catalog?.entities ?? []).find(
    entity => entity.namespace === namespace && entity.entityId === entityId,
  )
}

/** `CCliff.CliffMesh` (default `##id##`) and `CCliffMesh.ModelPath` (default `Assets\Cliffs\##id##\`). */
function cliffMeshFor(catalog, cliffSetId) {
  const cliff = catalogDefinition(catalog, 'Cliff', cliffSetId)
  if (cliff === undefined) return undefined
  const meshId = String(catalogFieldValue(cliff.fields?.CliffMesh) ?? '##id##').replaceAll(
    '##id##',
    cliffSetId,
  )
  const mesh = catalogDefinition(catalog, 'CliffMesh', meshId)
  if (mesh === undefined) return undefined
  const modelPath = String(
    catalogFieldValue(mesh.fields?.ModelPath) ?? 'Assets\\Cliffs\\##id##\\',
  ).replaceAll('##id##', meshId)
  // The set skins the shared mesh family: default `Assets\Cliffs\##id##_Material\##id##_Material.m3`.
  const materialPath = String(
    catalogFieldValue(cliff.fields?.CliffMaterial) ??
      'Assets\\Cliffs\\##id##_Material\\##id##_Material.m3',
  ).replaceAll('##id##', cliffSetId)
  // CliffHeights[0]: level A's height from the standard height, the mesh's own (-8, Korhal's -20).
  const heights = Array.isArray(mesh.fields?.CliffHeights) ? mesh.fields.CliffHeights : []
  const levelA = heights.find(entry => String(entry?.index) === '0')
  const levelAHeight = levelA === undefined ? undefined : Number(catalogFieldValue(levelA))
  return {
    meshId,
    modelPath,
    materialPath,
    ...(levelAHeight !== undefined && Number.isFinite(levelAHeight) ? { levelAHeight } : {}),
  }
}

function cliffCatalogQueries(terrainDocument, catalog) {
  if (terrainDocument === undefined) return Object.freeze([])
  const queries = []
  for (const setId of sc2CliffSetIds(textDecoder.decode(terrainDocument.bytes))) {
    queries.push(Object.freeze({ namespace: 'Cliff', entityId: setId }))
    const cliff = catalogDefinition(catalog, 'Cliff', setId)
    if (cliff !== undefined)
      queries.push(
        Object.freeze({
          namespace: 'CliffMesh',
          entityId: String(catalogFieldValue(cliff.fields?.CliffMesh) ?? '##id##').replaceAll(
            '##id##',
            setId,
          ),
        }),
      )
  }
  return Object.freeze(queries)
}

function diagnosticFor(error, path) {
  return Object.freeze({
    severity: 'error',
    code: 'blizzard.starcraft2/map-document-invalid',
    message: error instanceof Error ? error.message : String(error),
    path,
  })
}

/** Object ids of fluff doodads sit above any `Objects` id (Amphion's largest is 3 866). */
const FLUFF_OBJECT_ID_BASE = 1_000_000
/** Shoreline models sit above the fluff doodads (one per `t3FluffDoodad` entry, well under a million). */
const SHORELINE_OBJECT_ID_BASE = 2_000_000

/**
 * The shoreline models the engine lays along each water zone's waterline (`CWater.BeachShoreline`,
 * `CliffShoreline`; see `buildSc2Shorelines`): presentation doodads naming their CModel, like fluff.
 * They loop `Stand` from their own start each, as the engine's copies do not wave in step.
 */
function shorelineObjects(input) {
  const shore = buildSc2Shorelines(input)
  return {
    dropped: shore.dropped,
    objects: shore.placements.map((placement, index) =>
      Object.freeze({
        objectId: SHORELINE_OBJECT_ID_BASE + index,
        kind: 'doodad',
        typeId: placement.modelId,
        position: Object.freeze({ x: placement.x, y: placement.y, z: placement.z }),
        variation: 0,
        scale: Object.freeze({ x: 1, y: 1, z: 1 }),
        rotation: placement.yaw,
        nativeRotationUnit: 'radians',
        heightReference: 'absolute',
        presentationAnimation: Object.freeze({
          name: 'Stand',
          groups: Object.freeze([]),
          loop: true,
          speed: 1,
          randomStart: true,
        }),
        ...SC2_NEUTRAL_PRESENTATION,
      }),
    ),
  }
}

/** Lava tiles sit above the shoreline models. */
const LAVA_OBJECT_ID_BASE = 3_000_000

/**
 * The lava model tiles of lava zones (`CWater.IsLava` → `LavaModel`; see `buildSc2LavaPlanes`), as
 * presentation doodads naming their CModel. They loop `Stand` in step, so the flow runs on across
 * the tile seams.
 */
function lavaObjects(input) {
  const lava = buildSc2LavaPlanes(input)
  return {
    dropped: lava.dropped,
    objects: lava.placements.map((placement, index) =>
      Object.freeze({
        objectId: LAVA_OBJECT_ID_BASE + index,
        kind: 'doodad',
        typeId: placement.modelId,
        position: Object.freeze({ x: placement.x, y: placement.y, z: placement.z }),
        variation: 0,
        scale: Object.freeze({ x: 1, y: 1, z: 1 }),
        rotation: 0,
        nativeRotationUnit: 'radians',
        heightReference: 'absolute',
        presentationAnimation: Object.freeze({
          name: 'Stand',
          groups: Object.freeze([]),
          loop: true,
          speed: 1,
        }),
        ...SC2_NEUTRAL_PRESENTATION,
      }),
    ),
  }
}

/**
 * `t3FluffDoodad` (DLFT): the scrub the editor scatters with the texture brush — one position and
 * the index of the terrain texture that placed it. The texture's `CTerrainTex` `DoodadEntry` list
 * names the models (Amphion: ShakurasSand → RockMixShakuras at 0.5, PlantMixShakuras at 0.1). Which
 * entry a position took is not stored, so it is drawn by a position hash weighted by the entries'
 * probabilities, and so is its rotation when the entry allows a random one.
 */
function parseFluffDoodads(document, terrainParameterDocument, catalog, budget) {
  const bytes = document.bytes
  if (bytes.byteLength < 28 || textDecoder.decode(bytes.subarray(0, 4)) !== 'DLFT') {
    throw new TypeError(`${document.path}: DLFT header is missing or truncated`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(24, true)
  if (!Number.isSafeInteger(count) || 28 + count * 9 > bytes.byteLength) {
    throw new TypeError(`${document.path}: DLFT entry array is invalid`)
  }
  const textureNames = new Map()
  const xml = textDecoder.decode(terrainParameterDocument.bytes)
  for (const match of xml.matchAll(/<texture i="([0-9]+)" name="([^"]*)"/gu))
    textureNames.set(Number(match[1]), match[2])
  const entriesByTexture = new Map()
  const textures = []
  const entriesFor = index => {
    const cached = entriesByTexture.get(index)
    if (cached !== undefined) return cached
    const name = textureNames.get(index)
    const entity = name === undefined || name.length === 0 ? undefined : catalogDefinition(catalog, 'TerrainTex', name)
    if (name !== undefined && name.length > 0) textures.push(name)
    const raw = entity?.fields?.DoodadEntry
    // The normalized catalog lists a repeated struct as `[{ index, value: { … } }]`.
    const entries = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .map(entry => {
        const fields = recordOf(recordOf(entry)?.value ?? entry) ?? {}
        const probability = Number(catalogFieldValue(fields.Probability) ?? 1)
        return {
          model: textField(catalogFieldValue(fields.Model)),
          probability: Number.isFinite(probability) ? probability : 1,
          randomRotation: String(catalogFieldValue(fields.RandomRotation) ?? '0') === '1',
        }
      })
      .filter(entry => entry.model !== undefined && entry.probability > 0)
    entriesByTexture.set(index, entries)
    return entries
  }
  const objects = []
  let unplaced = 0
  let dropped = 0
  for (let index = 0; index < count; index += 1) {
    const offset = 28 + index * 9
    const x = view.getFloat32(offset, true)
    const y = view.getFloat32(offset + 4, true)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError(`${document.path}: fluff doodad ${index} has a non-finite position`)
    }
    const entries = entriesFor(bytes[offset + 8])
    if (entries.length === 0) {
      unplaced += 1
      continue
    }
    if (objects.length >= budget) {
      dropped += 1
      continue
    }
    const hash =
      (Math.imul(Math.round(x * 16), 73856093) ^ Math.imul(Math.round(y * 16), 19349663)) >>> 0
    // Each entry rolls its own probability in list order; a position whose rolls all fail stays
    // bare (ShakurasSand: rock 0.5, plant 0.1 → about half the positions carry something), which
    // is the sparse scatter the editor shows.
    let chosen
    let roll = (hash & 0xffff) / 0x10000
    for (const entry of entries) {
      if (roll < entry.probability) {
        chosen = entry
        break
      }
      roll = (roll - entry.probability) / Math.max(1e-6, 1 - entry.probability)
    }
    if (chosen === undefined) continue
    objects.push(
      Object.freeze({
        objectId: FLUFF_OBJECT_ID_BASE + index,
        kind: 'doodad',
        typeId: chosen.model,
        position: Object.freeze({ x, y, z: 0 }),
        variation: 0,
        scale: Object.freeze({ x: 1, y: 1, z: 1 }),
        ...(chosen.randomRotation ? { rotation: ((hash >>> 16) / 0x10000) * Math.PI * 2 } : {}),
        nativeRotationUnit: 'radians',
        heightReference: 'terrain-surface',
        ...SC2_NEUTRAL_PRESENTATION,
      }),
    )
  }
  return { objects, unplaced, dropped, textures }
}

export async function openStarcraft2Map(request) {
  request.signal?.throwIfAborted()
  const value = validateRequest(request)
  const diagnostics = []
  const documents = new Map(value.documents.map(document => [basename(document.path), document]))
  const objectsDocument = documents.get('objects') ?? documents.get('mapobjects')
  const regionsDocument = documents.get('regions')
  const terrainDocument = documents.get('t3heightmap') ?? documents.get('mapheightmap')
  const terrainParameterDocument = documents.get('t3terrain.xml')
  let objects = []
  let regions = []
  let terrain
  for (const [label, document, parse, assign, required] of [
    ['Objects', objectsDocument, parseObjects, result => (objects = result), true],
    ['Regions', regionsDocument, parseRegions, result => (regions = result), false],
    ['t3HeightMap', terrainDocument, parseTerrain, result => (terrain = result), true],
  ]) {
    request.signal?.throwIfAborted()
    if (document === undefined) {
      diagnostics.push(
        Object.freeze({
          severity: required ? 'error' : 'information',
          code: required
            ? 'blizzard.starcraft2/map-document-missing'
            : 'blizzard.starcraft2/map-optional-document-missing',
          message: required
            ? `required map document ${label} is missing`
            : `optional map document ${label} is absent`,
        }),
      )
      continue
    }
    try {
      assign(parse(document, value, diagnostics))
    } catch (error) {
      diagnostics.push(diagnosticFor(error, document.path))
    }
  }
  request.signal?.throwIfAborted()
  const vertexDocument = documents.get('t3vertcol') ?? documents.get('mapvertexcolor')
  if (vertexDocument !== undefined && terrain !== undefined) {
    try {
      const grid = vertexColorScalarGrid(readVertexColor(vertexDocument.bytes), terrain.width, terrain.height)
      terrain = Object.freeze({ ...terrain, samples: Object.freeze(terrain.samples.map(sample => Object.freeze({
        ...sample, ambientOcclusion: grid[sample.y * terrain.width + sample.x] / 255,
      }))) })
    } catch (error) { diagnostics.push(diagnosticFor(error, vertexDocument.path)) }
  }
  // Fluff doodads need the catalog for their texture's DoodadEntry list; the first, catalog-less
  // pass only asks for the TerrainTex entities so the next pass can place them.
  const fluffDocument = documents.get('t3fluffdoodad') ?? documents.get('mapfluffdoodad')
  let fluffQueries = []
  let fluffObjects = new Set()
  if (fluffDocument !== undefined && terrainParameterDocument !== undefined) {
    try {
      const fluff = parseFluffDoodads(
        fluffDocument,
        terrainParameterDocument,
        value.catalog,
        Math.max(0, value.maxObjects - objects.length),
      )
      fluffQueries = fluff.textures.map(name =>
        Object.freeze({ namespace: 'TerrainTex', entityId: name }),
      )
      if (value.catalog !== undefined) {
        objects = [...objects, ...fluff.objects]
        fluffObjects = new Set(fluff.objects)
        diagnostics.push(
          Object.freeze({
            severity: fluff.dropped > 0 ? 'warning' : 'information',
            code: 'blizzard.starcraft2/map-fluff-doodads',
            message: `${fluff.objects.length} fluff doodads placed; ${fluff.unplaced} without a texture DoodadEntry; ${fluff.dropped} beyond maxObjects`,
            path: fluffDocument.path,
          }),
        )
      }
    } catch (error) {
      diagnostics.push(diagnosticFor(error, fluffDocument.path))
    }
  }
  // The shoreline needs the zones' CWater templates from the catalog; the catalog-less pass asks for them.
  const waterDocument = documents.get('t3water') ?? documents.get('mapwater')
  let shorelineQueries = []
  const modelTyped = new Set(fluffObjects)
  if (waterDocument !== undefined && terrainDocument !== undefined && terrainParameterDocument !== undefined) {
    try {
      const zoneTemplates = sc2WaterTemplateIds(waterDocument.bytes)
      shorelineQueries = zoneTemplates.map(templateId => Object.freeze({ namespace: 'Water', entityId: templateId }))
      if (value.catalog !== undefined && zoneTemplates.length > 0) {
        const templates = catalogWaterTemplates(value.catalog)
        const rawDocument = documents.get('waterdata.xml')
        if (rawDocument !== undefined)
          for (const [templateId, template] of parseWaterTemplates(rawDocument, value))
            if (!templates.has(templateId)) templates.set(templateId, template)
        const cliffLevelDocument = documents.get('t3syncclifflevel') ?? documents.get('mapsyncclifflevel')
        const shore = shorelineObjects({
          terrainXml: textDecoder.decode(terrainParameterDocument.bytes),
          heightMap: terrainDocument.bytes,
          ...(cliffLevelDocument === undefined ? {} : { cliffLevel: cliffLevelDocument.bytes }),
          water: waterDocument.bytes,
          templateFor: templateId => templates.get(templateId),
          maxPlacements: Math.max(0, value.maxObjects - objects.length),
        })
        if (shore.objects.length > 0 || shore.dropped > 0) {
          objects = [...objects, ...shore.objects]
          for (const object of shore.objects) modelTyped.add(object)
          diagnostics.push(
            Object.freeze({
              severity: shore.dropped > 0 ? 'warning' : 'information',
              code: 'blizzard.starcraft2/map-water-shorelines',
              message: `${shore.objects.length} shoreline models laid along the waterline; ${shore.dropped} beyond maxObjects`,
              path: waterDocument.path,
            }),
          )
        }
        const lava = lavaObjects({
          water: waterDocument.bytes,
          templateFor: templateId => templates.get(templateId),
          maxPlacements: Math.max(0, value.maxObjects - objects.length),
        })
        if (lava.objects.length > 0 || lava.dropped > 0) {
          objects = [...objects, ...lava.objects]
          for (const object of lava.objects) modelTyped.add(object)
          diagnostics.push(
            Object.freeze({
              severity: lava.dropped > 0 ? 'warning' : 'information',
              code: 'blizzard.starcraft2/map-water-lava',
              message: `${lava.objects.length} lava model tiles laid over the lava zones; ${lava.dropped} beyond maxObjects`,
              path: waterDocument.path,
            }),
          )
        }
      }
    } catch (error) {
      diagnostics.push(diagnosticFor(error, waterDocument.path))
    }
  }
  // The map's tileset: its CTerrain TextureProp picks the texture variants of doodads that name no TileSet.
  let mapTileSet
  try {
    const tileSet = terrainParameterDocument === undefined
      ? undefined
      : oneChild(xmlRoot(terrainParameterDocument, 'terrain', value.maxDepth), 'heightMap', `${terrainParameterDocument.path}:terrain`).attributes?.tileSet
    if (typeof tileSet === 'string' && tileSet.length > 0) mapTileSet = tileSet
  } catch {
    // The lighting pass reports an unreadable t3Terrain.xml; without it no texture variant applies.
  }
  const bound = bindCatalog(objects, value.catalog, diagnostics, modelTyped, mapTileSet)
  let lightingQueries = Object.freeze([])
  try {
    lightingQueries = lightingCatalogQueries(
      terrainParameterDocument,
      value.catalog,
      value.maxDepth,
    )
  } catch (error) {
    diagnostics.push(diagnosticFor(error, terrainParameterDocument?.path ?? 't3Terrain.xml'))
  }
  let cliffQueries = Object.freeze([])
  try {
    cliffQueries = cliffCatalogQueries(terrainParameterDocument, value.catalog)
  } catch (error) {
    diagnostics.push(diagnosticFor(error, terrainParameterDocument?.path ?? 't3Terrain.xml'))
  }
  const catalogQueries = Object.freeze(
    [...bound.catalogQueries, ...lightingQueries, ...cliffQueries, ...fluffQueries, ...shorelineQueries].filter(
      (query, index, queries) =>
        queries.findIndex(
          candidate =>
            candidate.namespace === query.namespace && candidate.entityId === query.entityId,
        ) === index,
    ),
  )
  const unitCount = bound.objects.filter(object => object.kind === 'unit').length
  const immutableDiagnostics = Object.freeze(diagnostics.map(item => Object.freeze(item)))
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    gameId: value.gameId,
    mapId: value.mapId,
    analyzerId: ANALYZER_ID,
    documentPaths: Object.freeze(value.documents.map(document => document.path)),
    modelMetersPerSourceUnit: 1,
    ...(terrain === undefined ? {} : { terrain }),
    regions: Object.freeze(regions),
    objects: bound.objects,
    catalogQueries,
    resolvedCatalogObjects: bound.resolvedCatalogObjects,
    diagnostics: immutableDiagnostics,
    complete:
      immutableDiagnostics.every(item => item.severity !== 'error') &&
      terrain !== undefined &&
      bound.objects.length > 0 &&
      (unitCount === 0 || bound.resolvedCatalogObjects === unitCount),
  })
}

function stringArray(value, label) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new TypeError(`${label} must be an array of strings`)
  }
  return value
}

/*
 * The map codecs name the world edit after themselves: a packed map declares
 * `blizzard/sc2-map.edit-world`, a folder map `blizzard/sc2-map-directory.edit-world`. The route
 * names the one the opened subject declares, or none; without the host's list it keeps the packed
 * map's name.
 */
const WORLD_EDIT_OPERATIONS = Object.freeze([
  'blizzard/sc2-map.edit-world',
  'blizzard/sc2-map-directory.edit-world',
])

function worldEditOperationId(subjectOperationIds) {
  if (subjectOperationIds === undefined) return WORLD_EDIT_OPERATIONS[0]
  return WORLD_EDIT_OPERATIONS.find(id => subjectOperationIds.includes(id))
}

/** Additive workspace result; the frozen semantic snapshot is produced by the authoritative v1. */
export async function analyzeStarcraft2MapWorkspace(request) {
  request?.signal?.throwIfAborted()
  const value = validateRequest(request)
  const editOperationId = worldEditOperationId(
    value.subjectOperationIds === undefined
      ? undefined
      : stringArray(value.subjectOperationIds, 'subjectOperationIds'),
  )
  const snapshotId = nonEmptyString(value.snapshotId, 'snapshotId')
  const unresolvedRequirementIds = stringArray(
    value.unresolvedRequirementIds,
    'unresolvedRequirementIds',
  )
  const requiredRequirementIds = new Set(
    stringArray(value.requiredRequirementIds, 'requiredRequirementIds'),
  )
  const maxDiagnostics = positiveLimit(value.maxDiagnostics, 'maxDiagnostics', MAXIMUM_DIAGNOSTICS)
  const semantic = await openStarcraft2Map(request)
  const documents = new Map(value.documents.map(document => [basename(document.path), document]))
  const navigationDocument = documents.get('t3syncpathinginfo') ?? documents.get('mappathinginfo')
  const terrainParameterDocument = documents.get('t3terrain.xml')
  const terrainMaterialDocument =
    documents.get('t3synctextureinfo') ?? documents.get('mapsynctextureinfo')
  const terrainTextureMaskDocument =
    documents.get('t3texturemasks') ?? documents.get('maptexturemasks')
  const waterDocument = documents.get('t3water') ?? documents.get('mapwater')
  const waterCatalogDocument = documents.get('waterdata.xml')
  const cliffDocument = documents.get('t3syncclifflevel') ?? documents.get('mapsyncclifflevel')
  const heightDocument = documents.get('t3heightmap') ?? documents.get('mapheightmap')
  let navigation
  let terrainMaterials
  let water
  let cliffs
  let terrainTransform
  let uvwTransform
  let lightingResult
  const diagnostics = []
  if (navigationDocument === undefined) {
    diagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.starcraft2/map-navigation-unavailable',
        message: 'navigation facet is unavailable because no PATH document resolved',
      }),
    )
  } else {
    try {
      navigation = parseNavigation(navigationDocument, value)
    } catch (error) {
      diagnostics.push(diagnosticFor(error, navigationDocument.path))
    }
  }
  if (terrainParameterDocument !== undefined && semantic.terrain !== undefined) {
    try {
      terrainTransform = parseTerrainTransform(
        terrainParameterDocument,
        semantic.terrain,
        documents.get('t3heightmap')?.path ?? documents.get('mapheightmap')?.path ?? 't3HeightMap',
        snapshotId,
        value,
      )
      if (terrainTransform !== undefined) {
        uvwTransform = sc2WorldCanonicalTransform(terrainTransform)
        if (uvwTransform === undefined) {
          diagnostics.push(
            Object.freeze({
              severity: 'information',
              code: 'blizzard.starcraft2/uvw-non-uniform-cell-size',
              message:
                'UVW candidate materialization requires equal t3Terrain horizontal scale.x and scale.y',
              path: terrainParameterDocument.path,
            }),
          )
        }
      }
    } catch (error) {
      diagnostics.push(diagnosticFor(error, terrainParameterDocument.path))
    }
  }
  if (terrainTextureMaskDocument !== undefined) {
    try {
      terrainMaterials = parseTerrainTextureMasks(
        terrainTextureMaskDocument,
        terrainParameterDocument,
        value,
        semantic.terrain,
      )
    } catch (error) {
      diagnostics.push(diagnosticFor(error, terrainTextureMaskDocument.path))
    }
  }
  if (terrainMaterials === undefined && terrainMaterialDocument !== undefined) {
    try {
      terrainMaterials = parseTerrainMaterials(
        terrainMaterialDocument,
        terrainParameterDocument,
        value,
      )
    } catch (error) {
      diagnostics.push(diagnosticFor(error, terrainMaterialDocument.path))
    }
  }
  terrainMaterials = bindTerrainMaterialResources(terrainMaterials, value.catalog, diagnostics)
  try {
    lightingResult = resolveCatalogLighting(
      terrainParameterDocument,
      value.catalog,
      value.maxDepth,
      diagnostics,
    )
  } catch (error) {
    diagnostics.push(diagnosticFor(error, terrainParameterDocument?.path ?? 't3Terrain.xml'))
  }
  if (waterDocument !== undefined) {
    try {
      water = parseWater(waterDocument, value, waterCatalogDocument, value.catalog)
      // A zone whose template carries no State.Height has no surface to draw; say so instead of
      // dropping it silently.
      const unresolvedWater = [
        ...new Set(
          water.zones.filter(zone => zone.elevation === undefined).map(zone => zone.templateId),
        ),
      ]
      if (unresolvedWater.length > 0)
        diagnostics.push(
          Object.freeze({
            severity: 'warning',
            code: 'blizzard.starcraft2/map-water-template-unresolved',
            message: `water templates without a CWater State.Height: ${unresolvedWater.join(", ")}; their zones are not drawn`,
            path: waterDocument.path,
          }),
        )
    } catch (error) {
      diagnostics.push(diagnosticFor(error, waterDocument.path))
    }
  }
  let presentedTerrain = semantic.terrain
  if (cliffDocument !== undefined) {
    try {
      cliffs = parseCliffs(cliffDocument, semantic.terrain, value)
      if (
        terrainParameterDocument !== undefined &&
        heightDocument !== undefined &&
        value.catalog !== undefined
      ) {
        const authored = buildSc2CliffPieces({
          terrainXml: textDecoder.decode(terrainParameterDocument.bytes),
          cliffLevel: cliffDocument.bytes,
          heightMap: heightDocument.bytes,
          meshForCliffSet: setId => cliffMeshFor(value.catalog, setId),
          maxPieces: value.maxObjects,
        })
        diagnostics.push(...authored.diagnostics.map(item => Object.freeze({ ...item })))
        if (authored.pieces.length > 0)
          cliffs = Object.freeze({
            ...cliffs,
            pieceModels: Object.freeze(authored.pieceModels),
            pieces: Object.freeze(authored.pieces),
          })
      }
    } catch (error) {
      diagnostics.push(diagnosticFor(error, cliffDocument.path))
    }
  }
  // t3CellFlags value 3 cuts a cell out of the ground so a cliff model stands in it cleanly. Under a
  // piece the renderer cuts what the piece covers. A cut cell with a corner on cliff level A is the void
  // below a space platform, or ground that would fall into it: Lockdown's 8380 void cells, and the
  // edge cells under its ZergCliffWeb doodads, whose ground sloped down into the void and left the
  // webs hanging over it in the air. No piece covers those and SC2 shows the void. Cut cells with no
  // corner on A (under walls between higher levels) keep their ground. The sample at the cell's low
  // corner carries it.
  const cellFlagsDocument = documents.get('t3cellflags') ?? documents.get('mapcellflags')
  if (
    cellFlagsDocument !== undefined &&
    presentedTerrain !== undefined &&
    exactTerrainGrid(presentedTerrain) &&
    terrainTransform !== undefined &&
    'vertData' in terrainTransform
  ) {
    try {
      const flags = readCellFlags(cellFlagsDocument.bytes)
      const { width, height } = presentedTerrain
      const vertexLevels = cliffVertexLevels(
        {
          sizeX: width,
          sizeY: height,
          cells: presentedTerrain.samples.map(sample => ({ heightAdjustments: sample.heightAdjustment })),
        },
        terrainTransform.vertData,
      ).levels
      const onA = (x, y) => x < width && y < height && vertexLevels[y * width + x] === 0
      const hidden = sample =>
        sample.x < flags.sizeX &&
        sample.y < flags.sizeY &&
        flags.types[sample.y * flags.sizeX + sample.x] === 3 &&
        (onA(sample.x, sample.y) ||
          onA(sample.x + 1, sample.y) ||
          onA(sample.x, sample.y + 1) ||
          onA(sample.x + 1, sample.y + 1))
      if (presentedTerrain.samples.some(hidden))
        presentedTerrain = Object.freeze({
          ...presentedTerrain,
          samples: Object.freeze(
            presentedTerrain.samples.map(sample =>
              hidden(sample) ? Object.freeze({ ...sample, presentationCellHidden: true }) : sample,
            ),
          ),
        })
    } catch (error) {
      diagnostics.push(diagnosticFor(error, cellFlagsDocument.path))
    }
  }
  diagnostics.push(
    ...duplicateIdentityDiagnostics(
      semantic.objects,
      'objectId',
      'object',
      documents.get('objects')?.path ?? 'Objects',
    ),
    ...duplicateIdentityDiagnostics(
      semantic.regions,
      'regionId',
      'region',
      documents.get('regions')?.path ?? 'Regions',
    ),
  )
  for (const requirementId of unresolvedRequirementIds) {
    diagnostics.push(
      Object.freeze({
        severity: requiredRequirementIds.has(requirementId) ? 'error' : 'information',
        code: 'blizzard.starcraft2/map-planned-resource-unresolved',
        message: `planned map resource ${requirementId} did not resolve through the resource session`,
      }),
    )
  }
  let latticeCoverage
  if (heightDocument !== undefined && terrainParameterDocument !== undefined) {
    try {
      const parsed = parseSc2MapDocuments(new Map(value.documents.map(document => [document.path.split(/[\\/]/u).at(-1),document.bytes])))
      const overview = analyzeMapOverview(parsed,{pixelsPerCell:8,...(value.catalog===undefined?{}:{catalog:value.catalog})})
      latticeCoverage = Object.freeze({overview:Object.freeze({...overview,coordinateSpaceId:'map-native'})})
    } catch(error) {
      diagnostics.push(diagnosticFor(error,terrainParameterDocument.path))
    }
  }
  const totalDiagnostics = semantic.diagnostics.length + diagnostics.length
  const diagnosticsTruncated = totalDiagnostics > maxDiagnostics
  const retained = diagnosticsTruncated ? Math.max(0, maxDiagnostics - 1) : maxDiagnostics
  const semanticCount = Math.min(semantic.diagnostics.length, retained)
  const additiveCount = Math.min(diagnostics.length, retained - semanticCount)
  // Terrain textures and water templates are read from the catalog too: name them, so a consumer
  // that feeds only the queried entities back (never the whole catalog) still binds them.
  const workspaceQueries = [
    ...overviewCatalogQueries(value.catalog),
    ...(terrainMaterials?.materials ?? []).map(material => ({ namespace: 'TerrainTex', entityId: material.label })),
    ...(water?.zones ?? []).map(zone => ({ namespace: 'Water', entityId: zone.templateId })),
  ].filter(
    query =>
      typeof query.entityId === 'string' &&
      query.entityId.length > 0 &&
      !semantic.catalogQueries.some(
        known => known.namespace === query.namespace && known.entityId === query.entityId,
      ),
  )
  const catalogQueries = Object.freeze([
    ...semantic.catalogQueries,
    ...workspaceQueries
      .filter(
        (query, index) =>
          workspaceQueries.findIndex(
            other => other.namespace === query.namespace && other.entityId === query.entityId,
          ) === index,
      )
      .map(query => Object.freeze(query)),
  ])
  const presentedSemantic =
    presentedTerrain === semantic.terrain && catalogQueries.length === semantic.catalogQueries.length
      ? semantic
      : Object.freeze({
          ...semantic,
          ...(presentedTerrain === undefined ? {} : { terrain: presentedTerrain }),
          catalogQueries,
        })
  const boundedSemantic =
    diagnosticsTruncated || semanticCount !== semantic.diagnostics.length
      ? Object.freeze({
          ...presentedSemantic,
          diagnostics: Object.freeze(semantic.diagnostics.slice(0, semanticCount)),
          complete: false,
        })
      : presentedSemantic
  const immutableDiagnostics = Object.freeze([
    ...diagnostics.slice(0, additiveCount).map(item => Object.freeze(item)),
    ...(diagnosticsTruncated
      ? [
          Object.freeze({
            severity: 'warning',
            code: 'blizzard.starcraft2/map-diagnostics-truncated',
            message: `workspace map diagnostics were truncated to maxDiagnostics ${maxDiagnostics}`,
          }),
        ]
      : []),
  ])
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: semantic.workspaceId,
    gameId: semantic.gameId,
    mapId: semantic.mapId,
    analyzerId: ANALYZER_ID,
    snapshotId,
    semantic: boundedSemantic,
    ...(navigation === undefined ? {} : { navigation }),
    ...(terrainMaterials === undefined ? {} : { terrainMaterials }),
    ...(water === undefined ? {} : { water }),
    ...(cliffs === undefined ? {} : { cliffs }),
    ...(terrainTransform === undefined ? {} : { terrainTransform }),
    ...(uvwTransform === undefined ? {} : { uvwTransform }),
    ...(lightingResult === undefined ? {} : { lighting: lightingResult.lighting }),
    ...(latticeCoverage === undefined ? {} : {latticeCoverage}),
    worldCandidate: Object.freeze({
      contract: SC2_WORLD_SCENE_SOURCE_CONTRACT,
      major: 1,
      maturity: 'publisher-candidate',
      coordinateSpaces: Object.freeze([
        Object.freeze({
          id: 'map-native',
          horizontalAxes: Object.freeze(['x', 'y']),
          verticalAxis: 'z',
          handedness: 'right',
          linearUnit: 'sc2-game-unit',
          rotationUnit: 'native-scalar',
          origin: 't3terrain-heightmap-offset',
        }),
        Object.freeze({
          id: 'uvw-canonical',
          horizontalAxes: Object.freeze(['x', 'z']),
          verticalAxis: 'y',
          handedness: 'right',
          linearUnit: 'sc2-game-unit',
          rotationUnit: 'radian',
          origin: 'adr-world-001-heightfield-origin',
        }),
        Object.freeze({
          id: 'height-grid',
          horizontalAxes: Object.freeze(['column', 'row']),
          verticalAxis: 'height-pair',
          handedness: 'array-row-major',
          linearUnit: 'grid-index',
          rotationUnit: 'not-applicable',
          origin: 'grid-zero',
        }),
        Object.freeze({
          id: 'navigation-grid',
          horizontalAxes: Object.freeze(['column', 'row']),
          verticalAxis: 'not-applicable',
          handedness: 'array-row-major',
          linearUnit: 'grid-index',
          rotationUnit: 'not-applicable',
          origin: 'grid-zero',
        }),
      ]),
      crossSpaceTransforms: Object.freeze([
        Object.freeze({
          from: 'height-grid',
          to: 'map-native',
          state: terrainTransform === undefined ? 'unknown' : 'known',
          ...(terrainTransform === undefined
            ? {
                reason:
                  'an exact HMAP grid and matching t3Terrain.xml native parameters are unavailable',
              }
            : {}),
        }),
        Object.freeze({
          from: 'navigation-grid',
          to: 'map-native',
          state: 'unknown',
          reason: 'navigation cell size and origin are not normalized',
        }),
        Object.freeze({
          from: 'map-native',
          to: 'uvw-canonical',
          state: uvwTransform === undefined ? 'unknown' : 'known',
          ...(uvwTransform === undefined
            ? {
                reason:
                  'a validated exact native terrain transform with uniform horizontal cell size is unavailable',
              }
            : {}),
        }),
      ]),
      unknownFacets: Object.freeze([
        ...(terrainMaterials === undefined ? ['terrain-material-layers'] : []),
        ...(terrainMaterials?.weightEncoding === 'normalized-exact' &&
        (terrainMaterials.exact || (terrainMaterials.weightRasters?.length ?? 0) > 0)
          ? []
          : ['terrain-material-splat-weights']),
        ...(water === undefined
          ? ['water']
          : water.allTemplateElevationsResolved
            ? []
            : ['water-template-elevation']),
        ...(water === undefined || water.allTemplateMaterialsResolved
          ? []
          : ['water-template-material']),
        ...(cliffs === undefined ? ['cliffs-normalized'] : []),
        'pathing-flag-semantics',
        'trigger-volumes',
        ...(lightingResult === undefined ? ['lighting'] : []),
        ...(lightingResult?.hasTimeOfDayStates ? ['lighting-time-of-day-animation'] : []),
        'physics',
      ]),
      ...(editOperationId === undefined
        ? {}
        : { edit: Object.freeze({ operationId: editOperationId, moveObjectKind: 'object.update' }) }),
    }),
    unresolvedRequirementIds: Object.freeze([...unresolvedRequirementIds]),
    diagnostics: immutableDiagnostics,
    diagnosticsTruncated,
    complete:
      boundedSemantic.complete &&
      !diagnosticsTruncated &&
      immutableDiagnostics.every(item => item.severity !== 'error') &&
      unresolvedRequirementIds.every(item => !requiredRequirementIds.has(item)),
  })
}

export const abiVersion = 1
export const provides = Object.freeze([
  MAP_SEMANTIC_ANALYSIS_CONTRACT,
  RESOLVED_MAP_WORKSPACE_CONTRACT,
])

export function createProvider(selection) {
  if (
    (selection.contract !== MAP_SEMANTIC_ANALYSIS_CONTRACT &&
      selection.contract !== RESOLVED_MAP_WORKSPACE_CONTRACT) ||
    selection.major !== 1
  ) {
    throw new TypeError(
      `unsupported semantic-map selection ${selection.contract}@${selection.major}`,
    )
  }
  const value =
    selection.contract === MAP_SEMANTIC_ANALYSIS_CONTRACT
      ? Object.freeze({
          contract: MAP_SEMANTIC_ANALYSIS_CONTRACT,
          analyzerId: ANALYZER_ID,
          gameIds: Object.freeze([GAME_ID]),
          open: openStarcraft2Map,
        })
      : Object.freeze({
          contract: RESOLVED_MAP_WORKSPACE_CONTRACT,
          analyzerId: ANALYZER_ID,
          gameIds: Object.freeze([GAME_ID]),
          plan: planStarcraft2Map,
          analyze: analyzeStarcraft2MapWorkspace,
        })
  return Object.freeze({
    value,
    release: async () => undefined,
  })
}
