import { pureYawQuaternion } from '@modkit/codec-kit/model-math/transform'
/** SC2 Maps owner: bounded UVW spatial conversion, explicit target mappings/losses and
 * fresh MPQ verification. Rectangular water uses the native WATR 110 entry writer,
 * with no authored shoreline/wave bodies. This geometry profile does not qualify
 * complete native terrain companions or editor/game acceptance. */
import { decodeXmlEntities, encodeXmlAttribute } from '@modkit/codec-kit'
import { writeWater } from '../../../shared/format/formats/water.js'
import { serializeTriggerLibrary } from '../../../../triggers/shared/trigger-document/trigger-xml.js'
import {
  canonicalizeUvwProfile,
  unretainedWorldFields,
  createUvwConversionReceipt,
  parseUvwProfile,
  preflightUvwConversionProfile,
} from '@modkit/uv/world'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { readNativeMpqSnapshot } from '@modkit/blizzard-mpq/native-preserving'

const text = new TextEncoder()
const IDENTITY_UV = Object.freeze({ offset: [0, 0], scale: [1, 1], rotation: 0 })

const refusal = (code, message, path) =>
  Object.freeze({
    code,
    message,
    ...(path === undefined ? {} : { path }),
  })

function conversionResult(result, requestedProfile) {
  const verification =
    result.state === 'converted'
      ? Object.freeze({
          ...result.verification,
          targetLoaded: result.verification?.targetLoaded === true,
        })
      : result.verification
  return Object.freeze({
    ...result,
    ...(verification === undefined ? {} : { verification }),
    requestedProfile,
    receipt: createUvwConversionReceipt({
      targetGameId: 'blizzard/starcraft-2',
      artifactKind: 'sc2map',
      requestedProfile,
      ...(result.state === 'converted' ? { achievedProfile: 'geometry' } : {}),
      status: result.state,
      losses: result.losses,
      refusals: result.refusals,
      verification,
    }),
  })
}

function fail(refusals, code, message, path) {
  refusals.push(refusal(code, message, path))
}

function same(left, right) {
  return (
    Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 32
  )
}

function exactInteger(value, minimum, maximum) {
  const rounded = Math.round(value)
  return same(value, rounded) && rounded >= minimum && rounded <= maximum ? rounded : undefined
}

function nativeId(value, prefix) {
  const match = new RegExp(`^(?:${prefix}-)?([0-9]+)$`, 'u').exec(value)
  if (match === null) return undefined
  const result = Number(match[1])
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined
}

function xml(value) {
  return encodeXmlAttribute(String(value), '"')
}

function mapInfoBoundaryOffset(source, width, height) {
  const bodyOffset = 24
  const printable = value => value >= 0x20 && value < 0x7f
  const scanLimit = Math.min(bodyOffset + 64, source.byteLength)
  for (let start = bodyOffset; start < scanLimit; start += 1) {
    let offset = start
    let valid = true
    for (let stringIndex = 0; stringIndex < 2 && valid; stringIndex += 1) {
      const runStart = offset
      while (offset < source.byteLength && printable(source[offset])) offset += 1
      if (offset - runStart < 2 || offset >= source.byteLength || source[offset] !== 0)
        valid = false
      else offset += 1
    }
    if (!valid || offset + 16 > source.byteLength) continue
    const view = new DataView(source.buffer, source.byteOffset + offset, 16)
    const left = view.getUint32(0, true)
    const bottom = view.getUint32(4, true)
    const right = view.getUint32(8, true)
    const top = view.getUint32(12, true)
    if (
      left < right &&
      bottom < top &&
      right <= width &&
      top <= height &&
      (right - left) * 4 >= width
    )
      return offset
  }
  return undefined
}

function targetPlayableBoundary(requested, width, height) {
  const boundary =
    requested === 'full-map' ? { left: 0, bottom: 0, right: width, top: height } : requested
  if (
    boundary === null ||
    typeof boundary !== 'object' ||
    Array.isArray(boundary) ||
    !['left', 'bottom', 'right', 'top'].every(key => Number.isSafeInteger(boundary[key])) ||
    boundary.left < 0 ||
    boundary.bottom < 0 ||
    boundary.left >= boundary.right ||
    boundary.bottom >= boundary.top ||
    boundary.right > width ||
    boundary.top > height
  )
    throw new RangeError('target playableBoundary must be full-map or an in-map uint32 rectangle')
  return Object.freeze({
    left: boundary.left,
    bottom: boundary.bottom,
    right: boundary.right,
    top: boundary.top,
  })
}

function rewriteMapInfoDimensions(source, width, height, playableBoundary) {
  if (source.byteLength < 24 || new TextDecoder('ascii').decode(source.subarray(0, 4)) !== 'IpaM')
    throw new TypeError('target MapInfo has no valid IpaM fixed header')
  const bytes = Uint8Array.from(source)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sourceWidth = view.getUint32(16, true)
  const sourceHeight = view.getUint32(20, true)
  const boundaryOffset = mapInfoBoundaryOffset(bytes, sourceWidth, sourceHeight)
  view.setUint32(16, width, true)
  view.setUint32(20, height, true)
  let boundary
  if (playableBoundary !== undefined) {
    if (boundaryOffset === undefined)
      throw new TypeError('target MapInfo body has no proven playable-boundary record')
    boundary = targetPlayableBoundary(playableBoundary, width, height)
    view.setUint32(boundaryOffset, boundary.left, true)
    view.setUint32(boundaryOffset + 4, boundary.bottom, true)
    view.setUint32(boundaryOffset + 8, boundary.right, true)
    view.setUint32(boundaryOffset + 12, boundary.top, true)
  } else if (boundaryOffset !== undefined && (sourceWidth !== width || sourceHeight !== height)) {
    throw new TypeError(
      'target MapInfo dimensions changed but its playable boundary has no explicit replacement',
    )
  }
  if (view.getUint32(16, true) !== width || view.getUint32(20, true) !== height)
    throw new TypeError('rewritten MapInfo dimensions did not reopen exactly')
  if (boundary !== undefined && mapInfoBoundaryOffset(bytes, width, height) !== boundaryOffset)
    throw new TypeError('rewritten MapInfo playable boundary did not reopen exactly')
  return Object.freeze({ bytes, boundary })
}

function parseTargetDocumentInfo(xmlSource) {
  const stack = []
  let root
  const dependencies = []
  const expression = /<\s*(\/?)([A-Za-z_][A-Za-z0-9_]*)\s*>|([^<]+)/gu
  let match
  while ((match = expression.exec(xmlSource)) !== null) {
    if (match[3] !== undefined) {
      const value = decodeXmlEntities(match[3].trim())
      if (value.length > 0 && stack.at(-1) === 'Value' && stack.at(-2) === 'Dependencies')
        dependencies.push(value)
      continue
    }
    const closing = match[1] === '/'
    const name = match[2]
    if (!closing) {
      root ??= name
      stack.push(name)
    } else if (stack.pop() !== name) {
      throw new TypeError(`DocumentInfo XML tag mismatch at </${name}>`)
    }
  }
  if (root !== 'DocInfo' || stack.length > 0)
    throw new TypeError('DocumentInfo must contain one closed DocInfo root')
  return Object.freeze(dependencies)
}

function encodeTargetMetadataPreset(preset, terrain, refusals) {
  if (preset === undefined) return undefined
  if (
    preset === null ||
    typeof preset !== 'object' ||
    Array.isArray(preset) ||
    typeof preset.id !== 'string' ||
    preset.id.length === 0 ||
    preset.id.length > 256 ||
    !(preset.mapInfoBytes instanceof Uint8Array) ||
    preset.mapInfoBytes.byteLength === 0 ||
    (typeof preset.documentInfo !== 'string' && !(preset.documentInfo instanceof Uint8Array))
  ) {
    fail(
      refusals,
      'target-metadata-preset-invalid',
      'SC2 targetMetadataPreset requires a bounded id, MapInfo bytes and DocumentInfo XML',
      'options.targetMetadataPreset',
    )
    return undefined
  }
  try {
    const width = terrain.columns - 1
    const height = terrain.rows - 1
    if (width <= 0 || height <= 0)
      throw new RangeError('SC2 MapInfo requires at least one terrain cell per axis')
    const rewrittenMapInfo = rewriteMapInfoDimensions(
      preset.mapInfoBytes,
      width,
      height,
      preset.playableBoundary,
    )
    const documentInfoBytes =
      typeof preset.documentInfo === 'string'
        ? text.encode(preset.documentInfo)
        : Uint8Array.from(preset.documentInfo)
    const documentInfoText = new TextDecoder('utf-8', { fatal: true }).decode(documentInfoBytes)
    const dependencies = parseTargetDocumentInfo(documentInfoText)
    return Object.freeze({
      id: preset.id,
      mapInfoBytes: rewrittenMapInfo.bytes,
      playableBoundary: rewrittenMapInfo.boundary,
      documentInfoBytes,
      dependencies,
    })
  } catch (error) {
    fail(
      refusals,
      'target-metadata-preset-invalid',
      error instanceof Error ? error.message : 'SC2 target metadata preset is invalid',
      'options.targetMetadataPreset',
    )
    return undefined
  }
}

function encodeHeightMap(terrain, cliffs, options, refusals) {
  const quantizeScale = options.quantizeScale ?? 1
  const verticalScale = options.verticalScale ?? 1
  const verticalOffset = options.verticalOffset ?? 0
  if (
    ![quantizeScale, verticalScale].every(value => Number.isFinite(value) && value > 0) ||
    !Number.isFinite(verticalOffset)
  ) {
    fail(
      refusals,
      'height-quantization-invalid',
      'SC2 target height quantization must be finite and positive',
      'options',
    )
    return undefined
  }
  const cells = terrain.columns * terrain.rows
  const bytes = new Uint8Array(32 + cells * 6)
  bytes.set(text.encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, terrain.columns, true)
  view.setUint32(12, terrain.rows, true)
  for (let nativeY = 0; nativeY < terrain.rows; nativeY += 1) {
    const uvwY = terrain.rows - 1 - nativeY
    for (let x = 0; x < terrain.columns; x += 1) {
      const height = terrain.samples[uvwY][x]
      const base = exactInteger(
        (height - verticalOffset) / (quantizeScale * verticalScale),
        0,
        0xffff,
      )
      if (base === undefined) {
        fail(
          refusals,
          'height-unrepresentable',
          `height ${String(height)} is not exact in the selected SC2 uint16 quantization`,
          `heightfield.samples[${String(uvwY)}][${String(x)}]`,
        )
        continue
      }
      const index = nativeY * terrain.columns + x
      const authored = cliffs?.authored[uvwY]?.[x] ?? false
      view.setUint16(32 + index * 6, base, true)
      view.setUint16(34 + index * 6, 0, true)
      view.setUint16(36 + index * 6, authored ? 0x9000 : 0, true)
    }
  }
  return Object.freeze({ bytes, quantizeScale, verticalScale, verticalOffset })
}

function encodeTerrainXml(space, terrain, materialData, quantization, tileSetId) {
  const offsetX = terrain.origin[0]
  const offsetY = -terrain.origin[2] - (terrain.rows - 1) * terrain.cellSize
  const names = (materialData?.ordered ?? [])
    .map(
      (material, index) =>
        `<texture i="${String(index)}" name="${xml(material.label ?? material.id)}"/>`,
    )
    .join('')
  return text.encode(
    `<terrain version="1"><heightMap${tileSetId === undefined ? '' : ` tileSet="${xml(tileSetId)}"`} dim="${terrain.columns} ${terrain.rows}" ` +
      `offset="${offsetX} ${offsetY} ${quantization.verticalOffset}" ` +
      `scale="${terrain.cellSize} ${terrain.cellSize} ${quantization.verticalScale}">` +
      `<vertData quantizeBias="0" quantizeScale="${quantization.quantizeScale}" standardHeight="0"/>` +
      `</heightMap><textureList>${names}</textureList></terrain>`,
  )
}

const GENERATED_TERRAIN_ID = 'UVWGeneratedTerrain'
const GENERATED_LIGHT_ID = 'UVWGeneratedLight'

function encodeLighting(layer, losses) {
  if (layer === undefined) return Object.freeze({ documents: Object.freeze([]) })
  if (layer.directional.length === 0) {
    losses.push(
      Object.freeze({
        feature: `layers.${layer.id}`,
        reason: 'SC2 CLight requires a Key directional light for deterministic reopen',
        replacement: 'omitted',
      }),
    )
    return Object.freeze({ documents: Object.freeze([]) })
  }
  const roles = ['Key', 'Fill', 'Back']
  for (const field of ['model', 'unlitColor', 'toneMapping', 'terrain']) {
    if (layer[field] !== undefined) losses.push(Object.freeze({
      feature: `layers.${layer.id}.${field}`,
      reason: `SC2 CLight writer does not encode portable ${field}`,
      replacement: field === 'model' ? 'native lit CLight' : 'omitted',
    }))
  }
  for (const [index, light] of layer.directional.slice(0, roles.length).entries()) {
    for (const field of ['specularColor', 'specularIntensity', 'useAmbientOcclusion']) {
      if (light[field] !== undefined) losses.push(Object.freeze({
        feature: `layers.${layer.id}.directional[${index}].${field}`,
        reason: `SC2 CLight writer does not encode portable ${field}`,
        replacement: 'native CLight default',
      }))
    }
  }
  if (layer.directional.length > roles.length) {
    losses.push(
      Object.freeze({
        feature: `layers.${layer.id}.directional`,
        reason: `SC2 CLight exposes only Key, Fill and Back roles; ${String(layer.directional.length - roles.length)} additional directional lights were omitted`,
        replacement: 'first three lights retained in source order',
      }),
    )
  }
  const directional = layer.directional
    .slice(0, roles.length)
    .map((light, index) => {
      const nativeDirection = [light.direction[0], -light.direction[2], light.direction[1]]
      return (
        `<DirectionalLight index="${roles[index]}">` +
        `<Color value="${light.color.map(xml).join(',')}"/>` +
        `<ColorMultiplier value="${xml(light.intensity)}"/>` +
        `<Direction value="${nativeDirection.map(xml).join(',')}"/>` +
        `</DirectionalLight>`
      )
    })
    .join('')
  const lightData = text.encode(
    `<?xml version="1.0" encoding="utf-8"?><Catalog>` +
      `<CLight id="${GENERATED_LIGHT_ID}"><ToDInfoArray index="0" ` +
      `AmbientColor="${layer.ambientColor.map(xml).join(',')}" ` +
      `AmbientEnvironmentMultiplier="${xml(layer.ambientIntensity)}">` +
      `${directional}</ToDInfoArray></CLight></Catalog>`,
  )
  const terrainData = text.encode(
    `<?xml version="1.0" encoding="utf-8"?><Catalog>` +
      `<CTerrain id="${GENERATED_TERRAIN_ID}"><Lighting value="${GENERATED_LIGHT_ID}"/>` +
      `</CTerrain></Catalog>`,
  )
  return Object.freeze({
    tileSetId: GENERATED_TERRAIN_ID,
    documents: Object.freeze([
      Object.freeze({ path: 'Base.SC2Data/GameData/LightData.xml', bytes: lightData }),
      Object.freeze({ path: 'Base.SC2Data/GameData/TerrainData.xml', bytes: terrainData }),
    ]),
  })
}

function materialEncoding(materials, terrain, refusals) {
  if (materials === undefined) return undefined
  if (
    materials.columns !== terrain.columns ||
    materials.rows !== terrain.rows ||
    materials.cellSize !== terrain.cellSize ||
    !materials.origin.every((value, index) => same(value, terrain.origin[index]))
  ) {
    fail(
      refusals,
      'material-grid-unrepresentable',
      'SC2 texture masks must share the exact height grid',
      'terrain-materials',
    )
    return undefined
  }
  const ordered = [...materials.materials].sort(
    (left, right) => (left.sourceIndex ?? Infinity) - (right.sourceIndex ?? Infinity),
  )
  if (
    ordered.length === 0 ||
    ordered.length > 256 ||
    ordered.some((material, index) => material.sourceIndex !== index)
  ) {
    fail(
      refusals,
      'material-indices-unrepresentable',
      'SC2 texture layers require contiguous sourceIndex values beginning at zero',
      'terrain-materials.materials',
    )
    return undefined
  }
  const byId = new Map(ordered.map((material, index) => [material.id, index]))
  const raw = []
  let reportedUvTransform = false
  for (let y = 0; y < materials.rows; y += 1) {
    const row = []
    for (let x = 0; x < materials.columns; x += 1) {
      const sample = materials.samples[y][x]
      const transform = sample.uvTransform ?? IDENTITY_UV
      if (
        !transform.offset.every(value => same(value, 0)) ||
        !transform.scale.every(value => same(value, 1)) ||
        !same(transform.rotation, 0)
      ) {
        if (!reportedUvTransform) {
          reportedUvTransform = true
          fail(
            refusals,
            'material-uv-unrepresentable',
            'SC2 MASK geometry profile does not encode per-cell UV transforms',
            `terrain-materials.samples[${String(y)}][${String(x)}].uvTransform`,
          )
        }
      }
      const layers = new Array(ordered.length).fill(0)
      for (const weight of sample.weights) {
        const layer = byId.get(weight.materialId)
        const nibble = exactInteger(weight.weight * 15, 0, 15)
        if (layer === undefined || nibble === undefined) {
          fail(
            refusals,
            'material-weight-unrepresentable',
            'SC2 exact MASK weights must be multiples of 1/15 and name a target layer',
            `terrain-materials.samples[${String(y)}][${String(x)}].weights`,
          )
          continue
        }
        layers[layer] = nibble
      }
      if (layers.reduce((sum, value) => sum + value, 0) !== 15) {
        fail(
          refusals,
          'material-weight-unrepresentable',
          'SC2 exact MASK nibbles must sum to 15',
          `terrain-materials.samples[${String(y)}][${String(x)}].weights`,
        )
      }
      row.push(layers)
    }
    raw.push(row)
  }
  return Object.freeze({ ordered, raw })
}

function encodeTextureDocuments(materials, terrain, encoded) {
  if (materials === undefined || encoded === undefined) return []
  const names = text.encode(
    `${encoded.ordered.map(material => material.label ?? material.id).join('\0')}\0`,
  )
  const sync = new Uint8Array(16 + names.length + terrain.columns * terrain.rows * 4)
  sync.set(text.encode('RTXT'))
  const syncView = new DataView(sync.buffer)
  syncView.setUint32(4, 2, true)
  syncView.setUint32(8, terrain.columns, true)
  syncView.setUint32(12, terrain.rows, true)
  sync.set(names, 16)
  for (let nativeY = 0; nativeY < terrain.rows; nativeY += 1) {
    const uvwY = terrain.rows - 1 - nativeY
    for (let x = 0; x < terrain.columns; x += 1) {
      const weights = encoded.raw[uvwY][x]
      let dominant = 0
      for (let layer = 1; layer < weights.length; layer += 1)
        if (weights[layer] > weights[dominant]) dominant = layer
      syncView.setUint32(16 + names.length + (nativeY * terrain.columns + x) * 4, dominant, true)
    }
  }
  const tilesX = Math.ceil(terrain.columns / 64)
  const tilesY = Math.ceil(terrain.rows / 64)
  const blocksPerLayer = tilesX * tilesY
  const masks = new Uint8Array(64 + encoded.ordered.length * blocksPerLayer * 2048)
  masks.set(text.encode('MASK'))
  const maskView = new DataView(masks.buffer)
  maskView.setUint32(4, 1, true)
  maskView.setUint32(12, terrain.columns, true)
  maskView.setUint32(16, terrain.rows, true)
  for (let nativeY = 0; nativeY < terrain.rows; nativeY += 1) {
    const uvwY = terrain.rows - 1 - nativeY
    for (let x = 0; x < terrain.columns; x += 1) {
      const tileX = Math.floor(x / 64)
      const tileY = Math.floor(nativeY / 64)
      const localX = x % 64
      const localY = nativeY % 64
      for (let layer = 0; layer < encoded.ordered.length; layer += 1) {
        const block = layer * blocksPerLayer + tileY * tilesX + tileX
        const offset = 64 + block * 2048 + localY * 32 + (localX >> 1)
        const value = encoded.raw[uvwY][x][layer]
        masks[offset] =
          (localX & 1) === 0
            ? (masks[offset] & 0x0f) | (value << 4)
            : (masks[offset] & 0xf0) | value
      }
    }
  }
  return [
    Object.freeze({ path: 't3SyncTextureInfo', bytes: sync }),
    Object.freeze({ path: 't3TextureMasks', bytes: masks }),
  ]
}

function yaw(rotation, path, refusals) {
  const angle = Array.isArray(rotation) ? pureYawQuaternion(rotation) : undefined
  if (angle === undefined) {
    fail(
      refusals,
      'object-rotation-unrepresentable',
      'SC2 placed objects support only canonical yaw in this profile',
      path,
    )
    return undefined
  }
  return angle
}

function encodeObjects(layer, refusals, losses) {
  const entries = []
  const derivedCliffs = (layer?.instances ?? []).filter(instance => instance.derivedFrom === 'cliffs').length
  if (derivedCliffs > 0)
    losses.push(Object.freeze({ feature: 'objects.instances.derivedFrom',
      reason: `${String(derivedCliffs)} derived cliff meshes are presentation, not authored SC2 placements`,
      replacement: 'target cliff geometry; source mesh appearance is not qualified' }))
  for (const [index, instance] of (layer?.instances ?? []).entries()) {
    if (instance.derivedFrom === 'cliffs') continue
    const path = `objects.instances[${String(index)}]`
    const id = nativeId(instance.id, 'instance')
    const rotation = yaw(instance.rotation, `${path}.rotation`, refusals)
    if (id === undefined)
      fail(
        refusals,
        'object-id-unrepresentable',
        'SC2 object id must be numeric or instance-N',
        `${path}.id`,
      )
    if (!['unit', 'doodad', 'point', 'camera'].includes(instance.objectKind)) {
      fail(
        refusals,
        'object-kind-unrepresentable',
        `SC2 fresh spatial profile cannot encode ${instance.objectKind}`,
        `${path}.objectKind`,
      )
    }
    if (
      id === undefined ||
      rotation === undefined ||
      !['unit', 'doodad', 'point', 'camera'].includes(instance.objectKind)
    )
      continue
    if ((instance.objectKind === 'unit' || instance.objectKind === 'doodad') && !instance.typeId) {
      fail(
        refusals,
        'object-type-missing',
        'SC2 unit/doodad requires an explicit typeId mapping',
        `${path}.typeId`,
      )
      continue
    }
    const retained = new Set(['id', 'objectKind', 'position', 'rotation', 'scale',
      ...(instance.objectKind === 'unit' || instance.objectKind === 'doodad' ? ['typeId', 'variation'] : []),
      ...(instance.objectKind === 'unit' ? ['player'] : []),
      ...(instance.objectKind === 'point' ? ['typeId', 'name'] : []),
      ...(instance.objectKind === 'camera' ? ['name'] : [])])
    for (const field of unretainedWorldFields(instance, (field, value) => retained.has(field) ||
      (field === 'resourceIds' && Array.isArray(value) && value.length === 0)))
      losses.push(Object.freeze({ feature: `${path}.${field}`,
        reason: 'the fresh SC2 placement writer does not encode this authored field',
        replacement: 'omitted; target placement/catalog defaults apply' }))
    const position = `${instance.position[0]},${-instance.position[2]},${instance.position[1]}`
    const scale = `${instance.scale[0]},${instance.scale[2]},${instance.scale[1]}`
    const common = `Id="${id}" Position="${position}" Scale="${scale}" Rotation="${rotation}"`
    if (instance.objectKind === 'unit')
      entries.push(
        `<ObjectUnit ${common} Variation="${instance.variation ?? 0}" UnitType="${xml(instance.typeId)}" Player="${instance.player ?? 0}"/>`,
      )
    else if (instance.objectKind === 'doodad')
      // UVW stores the resolved world-space transform. Mark the emitted SC2 placement absolute so
      // reopening it does not add the terrain height a second time.
      entries.push(
        `<ObjectDoodad ${common} Variation="${instance.variation ?? 0}" Type="${xml(instance.typeId)}">` +
          '<Flag Index="HeightAbsolute" Value="1"/></ObjectDoodad>',
      )
    else if (instance.objectKind === 'point')
      entries.push(
        `<ObjectPoint ${common} Type="${xml(instance.typeId ?? '')}" Name="${xml(instance.name ?? '')}"/>`,
      )
    else entries.push(`<ObjectCamera ${common} Name="${xml(instance.name ?? '')}"/>`)
  }
  return text.encode(
    `<?xml version="1.0" encoding="utf-8"?><PlacedObjects Version="26">${entries.join('')}</PlacedObjects>`,
  )
}

function encodeRegions(layer, refusals) {
  const entries = []
  for (const [index, region] of (layer?.regions ?? []).entries()) {
    const path = `regions.regions[${String(index)}]`
    const id = nativeId(region.id, 'region')
    if (id === undefined) {
      fail(
        refusals,
        'region-id-unrepresentable',
        'SC2 region id must be numeric or region-N',
        `${path}.id`,
      )
      continue
    }
    const shapes = []
    for (const [shapeIndex, shape] of region.shapes.entries()) {
      if (shape.kind === 'circle') {
        shapes.push(
          `<shape type="circle"><center value="${shape.center[0]},${-shape.center[1]}"/><radius value="${shape.radius}"/></shape>`,
        )
      } else if (shape.kind === 'rectangle') {
        shapes.push(
          `<shape type="rect"><min value="${shape.minimum[0]},${-shape.maximum[1]}"/><max value="${shape.maximum[0]},${-shape.minimum[1]}"/></shape>`,
        )
      } else {
        fail(
          refusals,
          'region-shape-unrepresentable',
          'SC2 fresh spatial profile currently supports circle and rectangle regions',
          `${path}.shapes[${String(shapeIndex)}]`,
        )
      }
    }
    entries.push(
      `<region id="${id}"><name value="${xml(region.name)}"/>${region.color === undefined ? '' : `<color value="${xml(region.color)}"/>`}${shapes.join('')}</region>`,
    )
  }
  return text.encode(`<?xml version="1.0" encoding="utf-8"?><Regions>${entries.join('')}</Regions>`)
}

function encodeCliffs(layer, terrain, refusals) {
  if (layer === undefined) return undefined
  if (
    layer.columns !== terrain.columns ||
    layer.rows !== terrain.rows ||
    layer.cellSize !== terrain.cellSize ||
    !layer.origin.every((value, index) => same(value, terrain.origin[index]))
  ) {
    fail(
      refusals,
      'cliff-grid-unrepresentable',
      'SC2 cliffs must share the exact height grid',
      'cliffs',
    )
    return undefined
  }
  const bytes = new Uint8Array(32 + terrain.columns * terrain.rows * 2)
  bytes.set(text.encode('CLIF'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 1, true)
  view.setUint32(8, terrain.columns, true)
  view.setUint32(12, terrain.rows, true)
  for (let nativeY = 0; nativeY < terrain.rows; nativeY += 1) {
    const uvwY = terrain.rows - 1 - nativeY
    for (let x = 0; x < terrain.columns; x += 1) {
      const raw = exactInteger(layer.levels[uvwY][x] * 16, 0, 0xffff)
      if (raw === undefined)
        fail(
          refusals,
          'cliff-level-unrepresentable',
          'SC2 cliff levels must encode as uint16 multiples of 16',
          `cliffs.levels[${String(uvwY)}][${String(x)}]`,
        )
      else view.setUint16(32 + (nativeY * terrain.columns + x) * 2, raw, true)
    }
  }
  return bytes
}

function encodeNavigation(layer, terrain, refusals, crossGame) {
  const bytes = new Uint8Array(32 + terrain.columns * terrain.rows * 2)
  bytes.set(text.encode('PATH'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 1, true)
  view.setUint32(8, terrain.columns, true)
  view.setUint32(12, terrain.rows, true)
  if (layer === undefined) return bytes
  if ((layer.flagEncoding !== undefined && layer.flagEncoding !== 'blizzard/sc2-sync-pathing@1') ||
    (crossGame && layer.flagEncoding === undefined)) {
    fail(refusals, 'navigation-flag-encoding-unrepresentable',
      'SC2 pathing needs its declared vocabulary; foreign or unknown flags require a qualified mapping', 'navigation.flagEncoding')
    return bytes
  }
  if (
    layer.columns !== terrain.columns ||
    layer.rows !== terrain.rows ||
    layer.cellSize !== terrain.cellSize ||
    !layer.origin.every((value, index) => same(value, terrain.origin[index]))
  ) {
    fail(
      refusals,
      'navigation-grid-unrepresentable',
      'SC2 navigation must share the exact height grid',
      'navigation',
    )
    return bytes
  }
  for (let nativeY = 0; nativeY < terrain.rows; nativeY += 1) {
    const uvwY = terrain.rows - 1 - nativeY
    for (let x = 0; x < terrain.columns; x += 1) {
      const flags = exactInteger(layer.samples[uvwY][x], 0, 0xffff)
      if (flags === undefined)
        fail(
          refusals,
          'navigation-flags-unrepresentable',
          'SC2 pathing flags must be uint16',
          `navigation.samples[${String(uvwY)}][${String(x)}]`,
        )
      else view.setUint16(32 + (nativeY * terrain.columns + x) * 2, flags, true)
    }
  }
  return bytes
}

function encodeWater(layer, templateId, refusals, losses) {
  if (layer === undefined || layer.zones.length === 0) return []
  if (
    typeof templateId !== 'string' ||
    templateId.length === 0 ||
    text.encode(templateId).length >= 40
  ) {
    fail(
      refusals,
      'water-template-mapping-missing',
      'SC2 water requires an explicit target waterTemplateId shorter than 40 UTF-8 bytes',
      'options.waterTemplateId',
    )
    return []
  }
  const templateIdBytes = new Uint8Array(40)
  templateIdBytes.set(text.encode(templateId))
  const elevations = new Set()
  const zones = layer.zones.map(zone => {
    elevations.add(zone.elevation)
    return { templateId, templateIdBytes: templateIdBytes.slice(), startX: zone.minimum[0],
      startY: -zone.maximum[1], endX: zone.maximum[0], endY: -zone.minimum[1] }
  })
  const bytes = writeWater({ version: 110, zones,
    _raw: { zero: new Uint8Array(20), trailing: new Uint8Array() } })
  if (elevations.size !== 1) {
    fail(
      refusals,
      'water-elevation-unrepresentable',
      'one SC2 target CWater template cannot preserve multiple zone elevations',
      'water.zones',
    )
    return []
  }
  const elevation = [...elevations][0]
  const materialIds = new Set(
    layer.zones.flatMap(zone => (zone.materialId === undefined ? [] : [zone.materialId])),
  )
  if (materialIds.size > 1) {
    fail(
      refusals,
      'water-material-unrepresentable',
      'one SC2 target CWater template cannot preserve multiple UVW water materials',
      'water.zones',
    )
    return []
  }
  const materialId = [...materialIds][0]
  const material =
    materialId === undefined
      ? undefined
      : layer.materials?.find(candidate => candidate.id === materialId)
  if (materialId !== undefined && material === undefined) {
    fail(
      refusals,
      'water-material-missing',
      `water zone references missing material ${materialId}`,
      'water.materials',
    )
    return []
  }
  // A target template does not imply that portable images or other omitted authored fields
  // have been transferred into that template's native catalog resources.
  const retained = new Set(['id', 'label', 'color', 'uvScale', 'scroll', 'causticsScale',
    'causticsFramesPerSecond', 'receiveShadows', 'classification', 'colorFalloff',
    'specularity', 'specularScale', 'reflectivityPower'])
  for (const [field, value] of Object.entries(material ?? {})) {
    if (value === undefined || retained.has(field)) continue
    losses.push(Object.freeze({ feature: `water.materials.${field}`,
      reason: 'the SC2 geometry writer does not transfer this portable water material field',
      replacement: 'explicit target CWater template; source appearance is not qualified' }))
  }
  const attribute = (name, value) => (value === undefined ? '' : ` ${name}="${xml(String(value))}"`)
  const vectorAttribute = (name, value) =>
    value === undefined ? '' : attribute(name, value.join(','))
  const waterAttributes =
    material === undefined
      ? ''
      : [
          vectorAttribute('TilingFreq', material.uvScale),
          vectorAttribute('ScrollVectors', material.scroll),
          vectorAttribute('CausticsTilingFreq', material.causticsScale),
          attribute('CausticsFPS', material.causticsFramesPerSecond),
          attribute(
            'ReceiveShadows',
            material.receiveShadows === undefined ? undefined : material.receiveShadows ? 1 : 0,
          ),
          attribute('IsLava', material.classification === 'lava' ? 1 : 0),
        ].join('')
  const stateAttributes =
    material === undefined
      ? ''
      : [
          vectorAttribute('Color', material.color),
          attribute('ColorFallOff', material.colorFalloff),
          attribute('Specularity', material.specularity),
          attribute('SpecularScaler', material.specularScale),
          attribute('ReflectivityPower', material.reflectivityPower),
        ].join('')
  return [
    Object.freeze({ path: 't3Water', bytes }),
    Object.freeze({
      path: 'Base.SC2Data/GameData/WaterData.xml',
      bytes: text.encode(
        `<Catalog><CWater id="${xml(templateId)}"${waterAttributes}><State index="0" Height="${elevation}"${stateAttributes}/></CWater></Catalog>`,
      ),
    }),
  ]
}

function crossGameLayers(space, scale, options, refusals, losses) {
  const materialMappings = options.materialMappings
  const objectMappings = options.objectMappings
  if (
    options.materialUvTransformPolicy !== undefined &&
    options.materialUvTransformPolicy !== 'discard'
  )
    fail(
      refusals,
      'material-uv-policy-invalid',
      'Cross-game SC2 materialUvTransformPolicy must be discard when supplied',
      'options.materialUvTransformPolicy',
    )
  return space.layers.map(layer => {
    if (layer.kind === 'heightfield')
      return Object.freeze({
        ...layer,
        cellSize: layer.cellSize * scale,
        origin: Object.freeze(layer.origin.map(value => value * scale)),
        samples: Object.freeze(
          layer.samples.map(row => Object.freeze(row.map(value => value * scale))),
        ),
      })
    if (layer.kind === 'terrain-materials') {
      const targets = new Map()
      const targetIds = new Map()
      for (const material of layer.materials) {
        const mapped = materialMappings?.[material.id]
        if (mapped === undefined) {
          fail(
            refusals,
            'material-mapping-missing',
            'Cross-game SC2 output requires an explicit material sourceIndex mapping',
            `terrain-materials.materials.${material.id}`,
          )
          continue
        }
        if (
          mapped === null ||
          typeof mapped !== 'object' ||
          Array.isArray(mapped) ||
          !Number.isSafeInteger(mapped.sourceIndex) ||
          mapped.sourceIndex < 0 ||
          mapped.sourceIndex > 255 ||
          (mapped.label !== undefined &&
            (typeof mapped.label !== 'string' ||
              mapped.label.length === 0 ||
              mapped.label.includes('\0')))
        ) {
          fail(
            refusals,
            'material-mapping-invalid',
            'SC2 material mapping requires sourceIndex 0..255 and an optional non-empty, NUL-free label',
            `options.materialMappings.${material.id}`,
          )
          continue
        }
        const candidate = Object.freeze({ ...material, ...mapped, id: material.id })
        const target = targets.get(mapped.sourceIndex) ?? candidate
        if ((target.label ?? target.id) !== (candidate.label ?? candidate.id)) {
          fail(
            refusals,
            'material-mapping-conflict',
            'SC2 materials sharing a target sourceIndex must name the same target texture',
            `options.materialMappings.${material.id}`,
          )
        }
        targets.set(mapped.sourceIndex, target)
        targetIds.set(material.id, target.id)
      }
      if (targetIds.size === layer.materials.length && targets.size < layer.materials.length)
        losses.push(
          Object.freeze({
            feature: `layers.${layer.id}.materials`,
            reason: `${String(layer.materials.length)} source material identities map to ${String(targets.size)} SC2 terrain textures`,
            replacement: 'explicit target palette; weights of shared target materials are summed',
          }),
        )
      const hasUvTransforms = layer.samples.some(row =>
        row.some(sample => {
          const transform = sample.uvTransform
          return (
            transform !== undefined &&
            (!transform.offset.every(value => same(value, 0)) ||
              !transform.scale.every(value => same(value, 1)) ||
              !same(transform.rotation, 0))
          )
        }),
      )
      if (hasUvTransforms && options.materialUvTransformPolicy === 'discard')
        losses.push(
          Object.freeze({
            feature: `layers.${layer.id}.samples.uvTransform`,
            reason: 'SC2 MASK has no per-cell flip/quarter-turn representation',
            replacement: 'identity UV transform',
          }),
        )
      return Object.freeze({
        ...layer,
        cellSize: layer.cellSize * scale,
        origin: Object.freeze(layer.origin.map(value => value * scale)),
        materials: Object.freeze([...targets.values()]),
        samples: Object.freeze(
          layer.samples.map(row =>
            Object.freeze(
              row.map(sample => {
                const weights = new Map()
                for (const weight of sample.weights) {
                  const targetId = targetIds.get(weight.materialId) ?? weight.materialId
                  weights.set(targetId, (weights.get(targetId) ?? 0) + weight.weight)
                }
                return Object.freeze({
                  ...sample,
                  weights: Object.freeze(
                    [...weights].map(([materialId, weight]) =>
                      Object.freeze({ materialId, weight }),
                    ),
                  ),
                  ...(hasUvTransforms && options.materialUvTransformPolicy === 'discard'
                    ? { uvTransform: IDENTITY_UV }
                    : {}),
                })
              }),
            ),
          ),
        ),
      })
    }
    if (layer.kind === 'objects')
      return Object.freeze({
        ...layer,
        instances: Object.freeze(
          layer.instances.map((instance, index) => {
            const mapped = objectMappings?.[`${instance.objectKind}:${instance.typeId ?? ''}`]
            if (mapped === undefined && instance.derivedFrom !== 'cliffs') {
              fail(
                refusals,
                'object-mapping-missing',
                'Cross-game SC2 output requires an explicit object kind/type mapping',
                `objects.instances[${String(index)}].typeId`,
              )
            }
            return Object.freeze({
              ...instance,
              position: Object.freeze(instance.position.map(value => value * scale)),
              ...(mapped === undefined
                ? {}
                : { objectKind: mapped.objectKind, typeId: mapped.typeId }),
            })
          }),
        ),
      })
    if (layer.kind === 'regions')
      return Object.freeze({
        ...layer,
        regions: Object.freeze(
          layer.regions.map(region =>
            Object.freeze({
              ...region,
              shapes: Object.freeze(
                region.shapes.map(shape => {
                  if (shape.kind === 'circle')
                    return Object.freeze({
                      ...shape,
                      center: Object.freeze(shape.center.map(value => value * scale)),
                      radius: shape.radius * scale,
                    })
                  if (shape.kind === 'rectangle')
                    return Object.freeze({
                      ...shape,
                      minimum: Object.freeze(shape.minimum.map(value => value * scale)),
                      maximum: Object.freeze(shape.maximum.map(value => value * scale)),
                    })
                  return Object.freeze({
                    ...shape,
                    points: Object.freeze(
                      shape.points.map(point => Object.freeze(point.map(value => value * scale))),
                    ),
                  })
                }),
              ),
            }),
          ),
        ),
      })
    if (layer.kind === 'water')
      return Object.freeze({
        ...layer,
        zones: Object.freeze(
          layer.zones.map(zone =>
            Object.freeze({
              ...zone,
              minimum: Object.freeze(zone.minimum.map(value => value * scale)),
              maximum: Object.freeze(zone.maximum.map(value => value * scale)),
              elevation: zone.elevation * scale,
            }),
          ),
        ),
      })
    if (layer.kind === 'navigation' || layer.kind === 'cliffs') {
      fail(
        refusals,
        `${layer.kind}-mapping-missing`,
        `Cross-game SC2 output requires an explicit ${layer.kind} mapping`,
        `layers.${layer.id}`,
      )
    }
    return layer
  })
}

async function digest(bytes, signal) {
  signal?.throwIfAborted()
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  signal?.throwIfAborted()
  return `sha256:${Array.from(result, value => value.toString(16).padStart(2, '0')).join('')}`
}

/** Convert a strict source-free UVW spatial profile into a fresh, independently reopened SC2Map MPQ. */
async function convertUvwToStarcraft2MapCore(input, options = {}) {
  const maxOutputBytes = options.maxOutputBytes ?? 268_435_456
  const maxNodes = options.maxNodes ?? 4_194_304
  const signal = options.signal
  signal?.throwIfAborted()
  const document =
    input instanceof Uint8Array
      ? parseUvwProfile(input, { maxBytes: maxOutputBytes, maxSamples: maxNodes, signal })
      : canonicalizeUvwProfile(input, { maxSamples: maxNodes, signal })
  const refusals = []
  const losses = []
  if (document.spaces.length !== 1)
    fail(
      refusals,
      'space-count-unrepresentable',
      'SC2 fresh map requires exactly one heightfield space',
      'spaces',
    )
  const space = document.spaces[0]
  const terrainLayers = space?.layers.filter(layer => layer.kind === 'heightfield' && layer.role !== 'query') ?? []
  const sourceTerrain = terrainLayers[0]
  if (terrainLayers.length !== 1 || sourceTerrain === undefined)
    fail(
      refusals,
      'terrain-layer-invalid',
      'SC2 fresh map requires exactly one rendered ground heightfield layer',
      'spaces[0].layers',
    )
  const nativeCoordinates =
    space !== undefined &&
    sourceTerrain !== undefined &&
    space.basis.unit === 'source-unit' &&
    space.basis.sourceUnit === 'sc2-game-unit' &&
    space.basis.unitsPerCell === sourceTerrain.cellSize &&
    sourceTerrain.origin[1] === 0
  const mapping = options.coordinateMapping
  const coordinateScale = nativeCoordinates ? 1 : mapping?.scale
  const crossGame = !nativeCoordinates
  const mappedCoordinates =
    space !== undefined &&
    sourceTerrain !== undefined &&
    mapping !== undefined &&
    space.basis.unit === 'source-unit' &&
    mapping.sourceUnit === space.basis.sourceUnit &&
    mapping.targetUnit === 'sc2-game-unit' &&
    Number.isFinite(mapping.scale) &&
    mapping.scale > 0 &&
    sourceTerrain.origin[1] === 0
  if (!nativeCoordinates && !mappedCoordinates)
    fail(
      refusals,
      'coordinate-profile-unrepresentable',
      'UVW basis/grid requires the exact SC2 profile or an explicit coordinateMapping',
      'spaces[0]',
    )
  if (sourceTerrain?.noDataValue !== undefined)
    fail(
      refusals,
      'terrain-holes-unrepresentable',
      'SC2 HMAP geometry profile does not encode UVW noData holes',
      'heightfield.noDataValue',
    )
  if (
    space === undefined ||
    sourceTerrain === undefined ||
    coordinateScale === undefined ||
    refusals.length > 0
  ) {
    return Object.freeze({
      state: 'refused',
      refusals: Object.freeze(refusals),
      refusalCodes: Object.freeze(refusals.map(item => item.code)),
      losses: Object.freeze(losses),
    })
  }
  const effectiveLayers = nativeCoordinates
    ? space.layers
    : crossGameLayers(space, coordinateScale, options, refusals, losses)
  const effectiveSpace = nativeCoordinates
    ? space
    : Object.freeze({
        ...space,
        basis: Object.freeze({
          ...space.basis,
          sourceUnit: 'sc2-game-unit',
          unitsPerCell: sourceTerrain.cellSize * coordinateScale,
        }),
        bounds: Object.freeze({
          min: Object.freeze(space.bounds.min.map(value => value * coordinateScale)),
          max: Object.freeze(space.bounds.max.map(value => value * coordinateScale)),
        }),
        layers: Object.freeze(effectiveLayers),
      })
  const layer = kind => effectiveLayers.find(candidate => candidate.kind === kind)
  const terrain = effectiveLayers.find(candidate => candidate.kind === 'heightfield' && candidate.role !== 'query')
  if (terrain === undefined) throw new TypeError('effective SC2 terrain disappeared during mapping')
  const materials = layer('terrain-materials')
  const cliffs = layer('cliffs')
  const navigation = layer('navigation')
  const retainedSpaceFields = new Set(['id', 'topology', 'basis', 'bounds', 'layers'])
  for (const field of unretainedWorldFields(space, field => retainedSpaceFields.has(field)))
    losses.push(Object.freeze({ feature: `spaces[0].${field}`,
      reason: 'the fresh SC2 spatial writer does not encode this space metadata', replacement: 'omitted' }))
  const objects = layer('objects')
  const regions = layer('regions')
  const water = layer('water')
  const lighting = layer('lighting')
  const materialData = materialEncoding(materials, terrain, refusals)
  const height = encodeHeightMap(terrain, cliffs, options, refusals)
  const cliffBytes = encodeCliffs(cliffs, terrain, refusals)
  const navigationBytes = encodeNavigation(navigation, terrain, refusals, crossGame)
  const objectBytes = encodeObjects(objects, refusals, losses)
  const regionBytes = encodeRegions(regions, refusals)
  const waterDocuments = encodeWater(water, options.waterTemplateId, refusals, losses)
  const lightingDocuments = encodeLighting(lighting, losses)
  const targetMetadata = encodeTargetMetadataPreset(options.targetMetadataPreset, terrain, refusals)
  const retainedLayers = new Set([terrain, materials, cliffs, navigation, objects, regions, water, lighting])
  for (const extra of effectiveLayers) {
    if (retainedLayers.has(extra)) continue
    losses.push(
      Object.freeze({
        feature: `layers.${extra.id}`,
        reason: `unselected ${extra.kind} layer has no fresh SC2 spatial document mapping`,
        replacement: 'omitted',
      }),
    )
  }
  if (targetMetadata === undefined)
    losses.push(
      Object.freeze({
        feature: 'MapInfo/DocumentInfo',
        reason: 'no target editor/game metadata preset was supplied by the UVW spatial profile',
        replacement: 'omitted; output guarantee is semantic spatial reopen, not editor-load',
      }),
    )
  losses.push(
    Object.freeze({
      feature: 'Triggers/GameData scenario',
      reason: 'UVW contains spatial world state, not UVD/UVS gameplay logic',
      replacement: 'empty map trigger component; gameplay logic omitted',
    }),
  )
  if (refusals.length > 0 || height === undefined) {
    return Object.freeze({
      state: 'refused',
      refusals: Object.freeze(refusals),
      refusalCodes: Object.freeze([...new Set(refusals.map(item => item.code))]),
      losses: Object.freeze(losses),
    })
  }
  const documents = Object.freeze(
    [
      Object.freeze({ path: 't3HeightMap', bytes: height.bytes }),
      Object.freeze({
        path: 't3Terrain.xml',
        bytes: encodeTerrainXml(
          effectiveSpace,
          terrain,
          materialData,
          height,
          lightingDocuments.tileSetId,
        ),
      }),
      ...encodeTextureDocuments(materials, terrain, materialData),
      ...(cliffBytes === undefined
        ? []
        : [Object.freeze({ path: 't3SyncCliffLevel', bytes: cliffBytes })]),
      Object.freeze({ path: 't3SyncPathingInfo', bytes: navigationBytes }),
      // The editor needs a map-owned trigger root even when UVW supplies no gameplay.
      Object.freeze({
        path: 'Triggers',
        bytes: text.encode(serializeTriggerLibrary({ id: 'UVWMap', implicit: true, items: [], elements: {} })),
      }),
      Object.freeze({ path: 'Objects', bytes: objectBytes }),
      Object.freeze({ path: 'Regions', bytes: regionBytes }),
      Object.freeze({ path: 'Preload', bytes: text.encode('<Preload/>') }),
      ...(targetMetadata === undefined
        ? []
        : [
            Object.freeze({ path: 'MapInfo', bytes: targetMetadata.mapInfoBytes }),
            Object.freeze({ path: 'DocumentInfo', bytes: targetMetadata.documentInfoBytes }),
          ]),
      ...waterDocuments,
      ...lightingDocuments.documents,
    ].sort((left, right) => left.path.localeCompare(right.path)),
  )
  const bytes = encodeFreshMpq(documents, maxOutputBytes)
  const reopened = await readNativeMpqSnapshot({
    sourceBytes: bytes,
    maxArchiveBytes: maxOutputBytes,
    maxBlocks: Math.min(maxNodes, 1_000_000),
    maxEntries: 64,
    maxEntryBytes: maxOutputBytes,
    maxTotalBytes: maxOutputBytes,
    signal,
  })
  const reopenedByPath = new Map(
    reopened.entries.map(entry => [entry.path.toLowerCase(), entry.bytes]),
  )
  if (documents.some(entry => !reopenedByPath.has(entry.path.toLowerCase()))) {
    throw new TypeError('fresh SC2Map independent reopen omitted a generated document')
  }
  return Object.freeze({
    state: 'converted',
    profile: crossGame ? 'sc2-cross-game-geometry-v1' : 'sc2-spatial-geometry-v1',
    bytes,
    documents,
    losses: Object.freeze(losses),
    refusals: Object.freeze([]),
    refusalCodes: Object.freeze([]),
    verification: Object.freeze({
      archiveReopened: true,
      archiveEntries: reopened.entries.length,
      archiveDigest: await digest(bytes, signal),
      columns: terrain.columns,
      rows: terrain.rows,
      objectCount: (objects?.instances ?? []).filter(instance => instance.derivedFrom !== 'cliffs').length,
      regionCount: regions?.regions.length ?? 0,
      ...(targetMetadata === undefined
        ? {}
        : {
            targetMetadataPreset: targetMetadata.id,
            dependencyCount: targetMetadata.dependencies.length,
            dependencies: targetMetadata.dependencies,
            ...(targetMetadata.playableBoundary === undefined
              ? {}
              : { playableBoundary: targetMetadata.playableBoundary }),
          }),
      coordinateMapping: Object.freeze({
        sourceUnit: space.basis.sourceUnit,
        targetUnit: 'sc2-game-unit',
        scale: coordinateScale,
      }),
    }),
  })
}

export async function convertUvwToStarcraft2Map(input, options = {}) {
  const preflight = preflightUvwConversionProfile(options.profile, ['geometry'])
  if (!preflight.accepted && 'refusal' in preflight)
    return conversionResult(
      Object.freeze({
        state: 'refused',
        refusalCodes: Object.freeze([preflight.refusal.code]),
        refusals: Object.freeze([preflight.refusal]),
        losses: Object.freeze([]),
      }),
      preflight.requestedProfile ?? null,
    )
  return conversionResult(
    await convertUvwToStarcraft2MapCore(input, options),
    preflight.requestedProfile,
  )
}

/** Project an accepted exact UVW plan onto the existing SC2 writer after live snapshots are reacquired. */
export function toSc2ObjectMappings(plan, currentSnapshots) {
  if (!plan.accepted || plan.refusals.length || !plan.writerBindings.length)
    throw new Error('No accepted object mapping table')
  const current = new Map(currentSnapshots.map(snapshot => [snapshot.bindingId, snapshot]))
  if (current.size !== currentSnapshots.length || current.size !== plan.snapshots.length)
    throw new Error('Snapshot bindings changed before native writing')
  for (const pinned of plan.snapshots) {
    const live = current.get(pinned.bindingId)
    if (
      !live ||
      live.revision !== pinned.revision ||
      live.compositionFingerprint !== pinned.compositionFingerprint ||
      live.subjectUri !== pinned.subjectUri ||
      live.role !== pinned.role
    )
      throw new Error(`Snapshot ${pinned.bindingId} changed before native writing`)
  }
  const mappings = Object.create(null)
  for (const { sourceWriterKey, target } of plan.writerBindings) {
    if (
      target.ref.namespace !== 'Unit' ||
      !target.ref.entityId ||
      Object.hasOwn(mappings, sourceWriterKey)
    )
      throw new Error(`SC2 Unit binding unavailable for ${sourceWriterKey}`)
    mappings[sourceWriterKey] = Object.freeze({ objectKind: 'unit', typeId: target.ref.entityId })
  }
  return Object.freeze(mappings)
}
