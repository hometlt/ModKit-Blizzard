// MK3 material projection refuses referenced REF_ without a supported color pass; native inspection is separate.
import { assertM3MaterialProjection, M3MaterialProjectionError } from '../../../dist/m3/native/builder/standard-material.js'
import { schemaText } from './schema.js'
import { createM3SectionResolver } from '../../../dist/m3/section-resolver.js'
import { readM3MaterialBindings } from '../../../dist/m3/material-batches.js'
import { M3SectionList } from '../../../dist/m3/native/binary/sections.js'
import {
  decodeMaterialParameters,
  readM3TexturePaths,
} from '../../../dist/m3/material-parameters.js'

const RECORD_BYTES = Object.freeze({
  MATM: Object.freeze({ 0: 8 }),
  MAT_: Object.freeze({ 15: 268, 16: 280, 17: 280, 18: 280, 19: 340, 20: 352 }),
  LAYR: Object.freeze({ 20: 356, 21: 356, 22: 356, 23: 428, 24: 436, 25: 468, 26: 464 }),
  DIV_: Object.freeze({ 2: 52 }),
  BAT_: Object.freeze({ 1: 14 }),
})

function bindShaderResources(shader, resources) {
  const bind = value => {
    if (Array.isArray(value)) return value.map(bind)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      (key === 'texturePath' || key === 'path') && typeof child === 'string'
        ? resources.get(normalizedResourceKey(child)) ?? child
        : bind(child),
    ]))
  }
  return Object.freeze({ ...shader, parameters: bind(shader.parameters) })
}

const MATERIAL_TYPES = Object.freeze({
  1: 'standard',
  2: 'displacement',
  3: 'composite',
  4: 'terrain',
  5: 'volume',
  6: 'volume-noise',
  7: 'creep',
  8: 'hair',
  9: 'splat-terrain-bake',
  10: 'reflection',
  11: 'lens-flare',
  12: 'buffer',
})

const BLEND_MODES = Object.freeze({
  0: 'opaque',
  1: 'blend',
  2: 'additive',
  3: 'add-alpha',
  4: 'modulate',
  5: 'modulate-2x',
})

const STANDARD_FLAGS = Object.freeze([
  Object.freeze({ mask: 0x0000_0001, name: 'vertex-color' }),
  Object.freeze({ mask: 0x0000_0002, name: 'vertex-alpha' }),
  Object.freeze({ mask: 0x0000_0004, name: 'unfogged' }),
  Object.freeze({ mask: 0x0000_0008, name: 'two-sided' }),
  Object.freeze({ mask: 0x0000_0010, name: 'unshaded' }),
  Object.freeze({ mask: 0x0000_0020, name: 'no-shadows-cast' }),
  Object.freeze({ mask: 0x0000_0040, name: 'no-hittest' }),
  Object.freeze({ mask: 0x0000_0080, name: 'no-shadows-receive' }),
  Object.freeze({ mask: 0x0000_0100, name: 'depth-prepass' }),
  Object.freeze({ mask: 0x0000_0200, name: 'terrain-hdr' }),
  Object.freeze({ mask: 0x0000_0400, name: 'unknown-0x400' }),
  Object.freeze({ mask: 0x0000_0800, name: 'simulate-roughness' }),
  Object.freeze({ mask: 0x0000_1000, name: 'pixel-forward-lighting' }),
  Object.freeze({ mask: 0x0000_2000, name: 'depth-fog' }),
  Object.freeze({ mask: 0x0000_4000, name: 'transparent-shadows' }),
  Object.freeze({ mask: 0x0000_8000, name: 'decal-lighting' }),
  Object.freeze({ mask: 0x0001_0000, name: 'transparent-depth-effects' }),
  Object.freeze({ mask: 0x0002_0000, name: 'transparent-local-lights' }),
  Object.freeze({ mask: 0x0004_0000, name: 'disable-soft' }),
  Object.freeze({ mask: 0x0008_0000, name: 'double-lambert' }),
  Object.freeze({ mask: 0x0010_0000, name: 'hair-layer-sorting' }),
  Object.freeze({ mask: 0x0020_0000, name: 'accept-splats' }),
  Object.freeze({ mask: 0x0040_0000, name: 'decal-low-required' }),
  Object.freeze({ mask: 0x0080_0000, name: 'emissive-low-required' }),
  Object.freeze({ mask: 0x0100_0000, name: 'specular-low-required' }),
  Object.freeze({ mask: 0x0200_0000, name: 'accept-splats-only' }),
  Object.freeze({ mask: 0x0400_0000, name: 'background-object' }),
  Object.freeze({ mask: 0x0800_0000, name: 'unknown-0x08000000' }),
  Object.freeze({ mask: 0x1000_0000, name: 'depth-prepass-low-required' }),
  Object.freeze({ mask: 0x2000_0000, name: 'no-highlighting' }),
  Object.freeze({ mask: 0x4000_0000, name: 'clamp-output' }),
  Object.freeze({ mask: 0x8000_0000, name: 'geometry-visible' }),
])
const STANDARD_FLAG_MASK = STANDARD_FLAGS.reduce((mask, item) => mask | item.mask, 0) >>> 0

const LAYER_FLAGS = Object.freeze([
  Object.freeze({ mask: 0x0000_0004, name: 'uv-wrap-x' }),
  Object.freeze({ mask: 0x0000_0008, name: 'uv-wrap-y' }),
  Object.freeze({ mask: 0x0000_0010, name: 'color-invert' }),
  Object.freeze({ mask: 0x0000_0020, name: 'color-clamp' }),
  Object.freeze({ mask: 0x0000_0040, name: 'color-add' }),
  Object.freeze({ mask: 0x0000_0080, name: 'color-multiply' }),
  Object.freeze({ mask: 0x0000_0100, name: 'particle-uv-flipbook' }),
  Object.freeze({ mask: 0x0000_0200, name: 'video' }),
  Object.freeze({ mask: 0x0000_0400, name: 'color' }),
  Object.freeze({ mask: 0x0000_2000, name: 'unknown-0x2000' }),
  Object.freeze({ mask: 0x0000_4000, name: 'fresnel-transform' }),
  Object.freeze({ mask: 0x0000_8000, name: 'fresnel-normalize' }),
  Object.freeze({ mask: 0x0001_0000, name: 'fresnel-local-transform' }),
  Object.freeze({ mask: 0x0002_0000, name: 'fresnel-do-not-mirror' }),
])
const LAYER_FLAG_MASK = LAYER_FLAGS.reduce((mask, item) => mask | item.mask, 0) >>> 0

const STANDARD_LAYERS = Object.freeze([
  Object.freeze({ field: 'layer_diff', slot: 'diffuse' }),
  Object.freeze({ field: 'layer_decal', slot: 'decal' }),
  Object.freeze({ field: 'layer_spec', slot: 'specular' }),
  Object.freeze({ field: 'layer_gloss', slot: 'gloss' }),
  Object.freeze({ field: 'layer_emis1', slot: 'emissive-1' }),
  Object.freeze({ field: 'layer_emis2', slot: 'emissive-2' }),
  Object.freeze({ field: 'layer_envi', slot: 'environment' }),
  Object.freeze({ field: 'layer_envi_mask', slot: 'environment-mask' }),
  Object.freeze({ field: 'layer_alpha1', slot: 'alpha-1' }),
  Object.freeze({ field: 'layer_alpha2', slot: 'alpha-2' }),
  Object.freeze({ field: 'layer_norm', slot: 'normal' }),
  Object.freeze({ field: 'layer_height', slot: 'height' }),
  Object.freeze({ field: 'layer_light', slot: 'light' }),
  Object.freeze({ field: 'layer_ao', slot: 'ambient-occlusion' }),
  Object.freeze({ field: 'layer_norm_blend1_mask', slot: 'normal-blend-1-mask' }),
  Object.freeze({ field: 'layer_norm_blend2_mask', slot: 'normal-blend-2-mask' }),
  Object.freeze({ field: 'layer_norm_blend1', slot: 'normal-blend-1' }),
  Object.freeze({ field: 'layer_norm_blend2', slot: 'normal-blend-2' }),
])

function arrayBufferOf(bytes) {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function reversedTag(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.byteLength) return ''
  return String.fromCharCode(
    bytes[offset + 3],
    bytes[offset + 2],
    bytes[offset + 1],
    bytes[offset],
  ).replaceAll('\0', '')
}

function issue(code, message, severity = 'warning', category = 'structure') {
  return Object.freeze({ id: code, code, category, severity, message })
}

function emptyResult(issues = [], fatal = false) {
  return Object.freeze({
    materials: Object.freeze([]),
    resourceReferences: Object.freeze({ names: Object.freeze([]), truncated: fatal }),
    primitiveBindings: Object.freeze([]),
    standardMaterials: 0,
    exoticMaterials: 0,
    exoticTypes: Object.freeze([]),
    decodedLayers: 0,
    linkedLayers: 0,
    rejectedNames: 0,
    rejectedLayerReferences: 0,
    unresolvedLayerResources: 0,
    rejectedMaterialReferences: 0,
    ambiguousPrimitiveBindings: 0,
    unsupportedBlendModes: 0,
    unknownFlagRecords: 0,
    decodedBytes: 0,
    shaderMaterials: 0,
    shaderParametersComplete: false,
    issues: Object.freeze(issues),
    fatal,
  })
}

function materialIndexPreflight(bytes, budget) {
  const tag = reversedTag(bytes, 0)
  const headerBytes = tag === 'MD34' ? 24 : tag === 'MD33' ? 20 : 0
  if (headerBytes === 0 || bytes.byteLength < headerBytes) {
    return {
      present: false,
      decodedBytes: 0,
      issue: issue('x3.m3/material-container-invalid', 'the M3 header is invalid or truncated'),
    }
  }
  const view = viewOf(bytes)
  const indexOffset = view.getUint32(4, true)
  const indexCount = view.getUint32(8, true)
  const indexBytes = indexCount * 16
  if (
    !Number.isSafeInteger(indexBytes) ||
    indexOffset < headerBytes ||
    indexOffset + indexBytes > bytes.byteLength
  ) {
    return {
      present: false,
      decodedBytes: 0,
      issue: issue(
        'x3.m3/material-container-invalid',
        'the M3 section index is invalid or outside the source',
      ),
    }
  }
  if (indexCount > budget.maxNodes) {
    return {
      present: false,
      decodedBytes: 0,
      issue: issue(
        'x3.m3/material-budget-exceeded',
        'the M3 section index exceeds the maxNodes budget',
        'warning',
        'performance',
      ),
    }
  }

  const sections = []
  for (let index = 0; index < indexCount; index += 1) {
    const offset = indexOffset + index * 16
    sections.push({
      tag: reversedTag(bytes, offset),
      offset: view.getUint32(offset + 4, true),
      repetitions: view.getUint32(offset + 8, true),
      version: view.getUint32(offset + 12, true),
    })
  }
  const boundaries = [...new Set([...sections.map(section => section.offset), indexOffset])]
    .filter(offset => offset >= headerBytes && offset <= bytes.byteLength)
    .sort((left, right) => left - right)
  let nodes = 0
  let decodedBytes = 0
  let present = false
  for (const section of sections) {
    const versions = RECORD_BYTES[section.tag]
    if (versions === undefined) continue
    present ||= section.tag === 'MATM' || section.tag === 'MAT_'
    const recordBytes = versions[section.version]
    if (recordBytes === undefined) {
      return {
        present,
        decodedBytes,
        issue: issue(
          'x3.m3/material-version-unsupported',
          `${section.tag} version ${section.version} is not supported`,
        ),
      }
    }
    const end = boundaries.find(offset => offset > section.offset) ?? bytes.byteLength
    const available = Math.max(0, end - section.offset)
    const required = section.repetitions * recordBytes
    if (!Number.isSafeInteger(required) || required > available) {
      const part = section.tag.toLowerCase().replaceAll('_', '')
      return {
        present,
        decodedBytes,
        issue: issue(
          `x3.m3/material-${part}-truncated`,
          `the ${section.tag} table needs ${required} bytes but only ${available} are available`,
        ),
      }
    }
    nodes += section.repetitions
    decodedBytes += required
  }
  if (nodes > budget.maxNodes) {
    return {
      present,
      decodedBytes,
      issue: issue(
        'x3.m3/material-budget-exceeded',
        'the material tables exceed the maxNodes budget',
        'warning',
        'performance',
      ),
    }
  }
  if (decodedBytes > budget.maxScalarBytes) {
    return {
      present,
      decodedBytes,
      issue: issue(
        'x3.m3/material-budget-exceeded',
        'the material tables exceed the maxScalarBytes budget',
        'warning',
        'performance',
      ),
    }
  }
  return { present, decodedBytes, issue: undefined }
}

function referencedString(sections, reference) {
  if (reference === null || typeof reference !== 'object') {
    return { state: 'invalid', value: null, bytes: 0 }
  }
  const entries = Number(reference.entries)
  const index = Number(reference.index)
  if (!Number.isSafeInteger(entries) || entries < 0 || !Number.isSafeInteger(index) || index < 0) {
    return { state: 'invalid', value: null, bytes: 0 }
  }
  if (entries === 0) return { state: 'absent', value: null, bytes: 0 }
  const section = sections.getSectionByReference(reference)
  if (
    reference.__refTo !== 'CHAR' ||
    section?.desc.history.name !== 'CHAR' ||
    !Array.isArray(section.content) ||
    entries > section.content.length
  ) {
    return { state: 'invalid', value: null, bytes: entries }
  }
  const values = section.content.slice(0, entries).map(item => Number(item))
  while (values.length > 0 && values.at(-1) === 0) values.pop()
  if (values.some(value => value < 0 || value > 255)) {
    return { state: 'invalid', value: null, bytes: entries }
  }
  const chunks = []
  for (let offset = 0; offset < values.length; offset += 0x4000) {
    chunks.push(String.fromCharCode(...values.slice(offset, offset + 0x4000)))
  }
  return { state: values.length === 0 ? 'absent' : 'value', value: chunks.join(''), bytes: entries }
}

function declaredRecords(sections, reference, expectedTag) {
  if (reference === null || typeof reference !== 'object') return null
  const entries = Number(reference.entries)
  if (!Number.isSafeInteger(entries) || entries < 0) return null
  if (entries === 0) return Object.freeze([])
  const section = sections.getSectionByReference(reference)
  if (section?.desc.history.name !== expectedTag || entries > section.content.length) return null
  return Object.freeze(section.content.slice(0, entries))
}

function resourceLookup(resourceIds) {
  const lookup = new Map()
  for (const id of resourceIds) lookup.set(id.toLowerCase(), id)
  return lookup
}

function normalizedResourceKey(value) {
  const normalized = value.trim().split(String.fromCharCode(92)).join('/')
  if (
    normalized.length === 0 ||
    /^[A-Za-z]:|^[\\/]|(?:^|[\\/])\.\.(?:[\\/]|$)|^[a-z][a-z0-9+.-]*:/u.test(normalized)
  ) {
    return null
  }
  return normalized.toLowerCase()
}

function namedBits(value, definitions) {
  return Object.freeze(definitions.filter(item => (value & item.mask) !== 0).map(item => item.name))
}

function materialTypeName(type) {
  return MATERIAL_TYPES[type] ?? `unknown-${type}`
}

/**
 * Decode M3 material identity, standard-material metadata, layer slots and BAT → primitive links.
 *
 * Layer texture strings are used only to join against the authoritative resource ids supplied by
 * `model-resource-refs-source`; returned layers retain that foreign key and never duplicate a path.
 */
export async function decodeM3Materials(bytes, budget, signal, resourceIds) {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
  const preflight = materialIndexPreflight(bytes, budget)
  if (preflight.issue !== undefined) return emptyResult([preflight.issue], true)
  if (!preflight.present) return emptyResult()

  let sections
  try {
    sections = await M3SectionList.load(arrayBufferOf(bytes), await schemaText())
  } catch {
    return emptyResult(
      [
        issue(
          'x3.m3/material-decode-failed',
          'the schema-backed parser refused the material tables',
        ),
      ],
      true,
    )
  }
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')

  const materialReferences = declaredRecords(sections, sections.model?.material_references, 'MATM')
  const standardRecords = declaredRecords(sections, sections.model?.materials_standard, 'MAT_')
  if (materialReferences === null || standardRecords === null) {
    return emptyResult(
      [
        issue(
          'x3.m3/material-reference-refused',
          'MODL material references do not address their declared MATM and MAT_ tables',
        ),
      ],
      true,
    )
  }
  if (materialReferences.length + standardRecords.length > budget.maxNodes) {
    return emptyResult(
      [
        issue(
          'x3.m3/material-budget-exceeded',
          'referenced material tables exceed the maxNodes budget',
          'warning',
          'performance',
        ),
      ],
      true,
    )
  }

  let texturePaths = []
  let texturePathsRefused = false
  try {
    texturePaths = readM3TexturePaths(sections, budget, signal)
  } catch (error) {
    if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
    if (error instanceof RangeError)
      return emptyResult(
        [
          issue(
            'x3.m3/material-budget-exceeded',
            'referenced texture paths exceed the material decode budget',
            'warning',
            'performance',
          ),
        ],
        true,
      )
    texturePathsRefused = true
  }
  const declaredTexturePaths = new Set(
    texturePaths.filter(path => normalizedResourceKey(path) !== null),
  )
  const resources = resourceLookup(resourceIds ?? [...declaredTexturePaths])
  const materials = []
  const exoticTypes = new Set()
  let decodedBytes = preflight.decodedBytes
  let decodedLayers = 0
  let linkedLayers = 0
  let rejectedNames = 0
  let rejectedLayerReferences = 0
  let unresolvedLayerResources = 0
  let rejectedMaterialReferences = 0
  let unsupportedBlendModes = 0
  let unknownFlagRecords = 0
  for (const [materialReferenceIndex, reference] of materialReferences.entries()) {
    if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
    const type = Number(reference.type)
    const sourceIndex = Number(reference.material_index)
    const typeName = materialTypeName(type)
    if (
      !Number.isSafeInteger(type) ||
      type < 0 ||
      !Number.isSafeInteger(sourceIndex) ||
      sourceIndex < 0
    ) {
      rejectedMaterialReferences += 1
      continue
    }
    if (type !== 1) {
      exoticTypes.add(typeName)
      materials.push(
        Object.freeze({
          id: `material-${materialReferenceIndex}`,
          referenceIndex: materialReferenceIndex,
          name: `M3 ${typeName} material ${sourceIndex}`,
          type,
          typeName,
          sourceIndex,
          layers: Object.freeze([]),
        }),
      )
      continue
    }
    const standard = standardRecords[sourceIndex]
    if (standard === undefined) {
      rejectedMaterialReferences += 1
      continue
    }
    const decodedName = referencedString(sections, standard.name)
    decodedBytes += decodedName.bytes
    if (decodedName.state === 'invalid') rejectedNames += 1
    const layers = []
    for (const definition of STANDARD_LAYERS) {
      const layerReference = standard[definition.field]
      // Older MAT_ versions do not carry the later gloss/normal-blend fields at all. Their
      // absence is a versioned schema fact, not a malformed reference.
      if (layerReference === undefined) continue
      const records = declaredRecords(sections, layerReference, 'LAYR')
      if (records === null) {
        rejectedLayerReferences += 1
        continue
      }
      for (const layer of records) {
        decodedLayers += 1
        const bitmap = referencedString(sections, layer.color_bitmap)
        decodedBytes += bitmap.bytes
        let resourceId
        if (bitmap.state === 'invalid') {
          rejectedLayerReferences += 1
        } else if (bitmap.state === 'value') {
          const key = normalizedResourceKey(bitmap.value)
          resourceId = key === null ? undefined : resources.get(key)
          if (resourceId === undefined) unresolvedLayerResources += 1
          else linkedLayers += 1
        }
        const flags = Number(layer.flags ?? 0) >>> 0
        const unknownFlagMask = (flags & ~LAYER_FLAG_MASK) >>> 0
        if (unknownFlagMask !== 0) unknownFlagRecords += 1
        layers.push(
          Object.freeze({
            slot: definition.slot,
            flags,
            flagNames: namedBits(flags, LAYER_FLAGS),
            unknownFlagMask,
            uvSource: Number(layer.uv_source ?? 0),
            colorChannels: Number(layer.color_channels ?? 0) >>> 0,
            ...(resourceId === undefined ? {} : { resourceId }),
          }),
        )
      }
    }
    const flags = Number(standard.flags ?? 0) >>> 0
    const unknownFlagMask = (flags & ~STANDARD_FLAG_MASK) >>> 0
    if (unknownFlagMask !== 0) unknownFlagRecords += 1
    const blendMode = Number(standard.blend_mode)
    const blendModeName = BLEND_MODES[blendMode]
    if (blendModeName === undefined) unsupportedBlendModes += 1
    materials.push(
      Object.freeze({
        id: `material-${materialReferenceIndex}`,
        referenceIndex: materialReferenceIndex,
        ...(decodedName.value === null ? {} : { name: decodedName.value }),
        type,
        typeName,
        sourceIndex,
        flags,
        flagNames: namedBits(flags, STANDARD_FLAGS),
        unknownFlagMask,
        blendMode,
        ...(blendModeName === undefined ? {} : { blendModeName }),
        priority: Number(standard.priority ?? 0),
        layers: Object.freeze(layers),
      }),
    )
  }

  if (decodedBytes > budget.maxScalarBytes) {
    return emptyResult(
      [
        issue(
          'x3.m3/material-budget-exceeded',
          'material names and layer resource joins exceed the maxScalarBytes budget',
          'warning',
          'performance',
        ),
      ],
      true,
    )
  }
  let primitiveBindings
  try {
    primitiveBindings = readM3MaterialBindings(sections, materials, budget, signal)
  } catch (error) {
    if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
    if (error instanceof RangeError) {
      return emptyResult(
        [
          issue(
            'x3.m3/material-budget-exceeded',
            'material batch expansion exceeded the bounded decoder capacity',
            'warning',
            'performance',
          ),
        ],
        true,
      )
    }
    primitiveBindings = { bindings: [], rejected: 1, ambiguous: 0 }
  }
  rejectedMaterialReferences += primitiveBindings.rejected
  const issues = []
  let rejectedTexturePaths = texturePaths.length - declaredTexturePaths.size
  if (texturePathsRefused)
    issues.push(
      issue(
        'x3.m3/material-texture-references-refused',
        'the declared material texture graph could not be traversed completely',
      ),
    )
  if (rejectedNames > 0) {
    issues.push(
      issue(
        'x3.m3/material-name-refused',
        `${rejectedNames} MAT_ name reference(s) do not address their declared CHAR data`,
      ),
    )
  }
  if (rejectedLayerReferences > 0) {
    issues.push(
      issue(
        'x3.m3/material-layer-refused',
        `${rejectedLayerReferences} MAT_/LAYR reference(s) do not address their declared data`,
      ),
    )
  }
  if (rejectedMaterialReferences > 0) {
    issues.push(
      issue(
        'x3.m3/material-binding-refused',
        `${rejectedMaterialReferences} MATM or BAT_ material reference(s) are invalid`,
      ),
    )
  }
  let parameterData
  if (rejectedNames === 0 && rejectedLayerReferences === 0 && rejectedMaterialReferences === 0) {
    try {
      parameterData = decodeMaterialParameters(
        sections,
        {
          ...budget,
          maxScalarBytes: budget.maxScalarBytes - decodedBytes,
        },
        signal,
      )
      decodedBytes += new TextEncoder().encode(JSON.stringify(parameterData)).byteLength
      // The builder repeats a code per MATM; descriptor diagnostic ids must stay unique.
      const repeats = new Map()
      for (const diagnostic of parameterData.diagnostics) {
        const code = `x3.m3/${diagnostic.code}`
        const ordinal = (repeats.get(code) ?? 0) + 1
        repeats.set(code, ordinal)
        const item = issue(code, diagnostic.message, 'information')
        issues.push(ordinal === 1 ? item : Object.freeze({ ...item, id: `${code}#${ordinal}` }))
      }
    } catch (error) {
      if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
      if (error instanceof RangeError) {
        return emptyResult(
          [
            issue(
              'x3.m3/material-budget-exceeded',
              'material parameter expansion exceeded the bounded decoder capacity',
              'warning',
              'performance',
            ),
          ],
          true,
        )
      }
      issues.push(
        issue(
          'x3.m3/material-parameters-refused',
          'the pinned builder refused the material parameter graph',
        ),
      )
    }
  }
  if (parameterData !== undefined && parameterData.unsupportedMaterialProjections.length > 0) {
    try {
      const byId = new Map(materials.map(material => [material.id, material.referenceIndex]))
      const used = primitiveBindings.bindings.filter(binding => !binding.hidden)
        .map(binding => byId.get(binding.materialId))
      const resolver = createM3SectionResolver(sections, budget, signal)
      for (const field of ['particle_systems', 'ribbons', 'projections'])
        for (const effect of resolver.getSectionByReference(sections.model[field])?.content ?? [])
          used.push(effect.material_reference_index)
      assertM3MaterialProjection(parameterData.unsupportedMaterialProjections, used)
    } catch (error) {
      if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
      return emptyResult([issue(error instanceof RangeError ? 'x3.m3/material-budget-exceeded'
        : error instanceof M3MaterialProjectionError ? 'x3.m3/material-projection-unsupported'
        : 'x3.m3/material-parameters-refused',
        error instanceof Error ? error.message : 'M3 material projection refused', 'warning')], true)
    }
  }
  // Specialized/composite builders expose their own exact layer paths through the same vocabulary.
  for (const parameter of parameterData?.materials ?? [])
    for (const layer of parameter.layers) {
      const path = layer.path.replaceAll('\\', '/')
      const key = normalizedResourceKey(path)
      if (key === null) {
        rejectedTexturePaths++
        continue
      }
      declaredTexturePaths.add(path)
      if (resourceIds === undefined && !resources.has(key)) resources.set(key, path)
    }
  const resourceNames = [...declaredTexturePaths]
  decodedBytes += new TextEncoder().encode(JSON.stringify(resourceNames)).byteLength
  if (decodedBytes > budget.maxScalarBytes || resourceNames.length > budget.maxNodes) {
    return emptyResult(
      [
        issue(
          'x3.m3/material-budget-exceeded',
          'texture reference expansion exceeds the material decode budget',
          'warning',
          'performance',
        ),
      ],
      true,
    )
  }
  if (rejectedTexturePaths > 0)
    issues.push(
      issue(
        'x3.m3/material-texture-path-refused',
        `${rejectedTexturePaths} texture path(s) cannot be used as scoped relative resource identifiers`,
      ),
    )
  const publishedMaterials = materials.map(material => {
    const parameters = parameterData?.materials[material.referenceIndex]
    if (parameters?.shader === undefined) return material
    // Standard layers already carry checked native flags. Composite/specialized texture layers
    // are joined against the same authoritative resource vocabulary; no resource is opened here.
    const layers =
      material.type === 1
        ? material.layers
        : parameters.layers.map(layer => {
            decodedLayers++
            const key = normalizedResourceKey(layer.path)
            const resourceId = key === null ? undefined : resources.get(key)
            if (resourceId === undefined) unresolvedLayerResources++
            else linkedLayers++
            return Object.freeze({
              slot: layer.label,
              ...(resourceId === undefined ? {} : { resourceId }),
            })
          })
    return Object.freeze({
      ...material,
      name: parameters.name,
      layers: Object.freeze(layers),
      // SC2 paths are case-insensitive. The resource table chooses ONE spelling, which both
      // native layer refs and shader samplers must use (e.g. ResourceCrystalDiff vs resourcecrystaldiff).
      shader: bindShaderResources(parameters.shader, resources),
    })
  })
  const shaderMaterials = publishedMaterials.filter(
    material => material.shader !== undefined,
  ).length
  if (unresolvedLayerResources > 0) {
    issues.push(
      issue(
        'x3.m3/material-resource-unresolved',
        `${unresolvedLayerResources} non-empty material texture reference(s) have no published resource id`,
        'information',
      ),
    )
  }
  const shaderParametersComplete =
    shaderMaterials === materialReferences.length &&
    shaderMaterials > 0 &&
    parameterData?.diagnostics.length === 0
  if (shaderMaterials < materialReferences.length) {
    issues.push(
      issue(
        'x3.m3/material-types-partial',
        `${materialReferences.length - shaderMaterials} material(s) have no safe shader parameter projection`,
        'information',
      ),
    )
  }
  if (unsupportedBlendModes > 0 || unknownFlagRecords > 0) {
    issues.push(
      issue(
        'x3.m3/material-semantics-partial',
        `${unsupportedBlendModes} blend mode(s) and ${unknownFlagRecords} flag record(s) lack named semantics`,
        'information',
      ),
    )
  }
  return Object.freeze({
    materials: Object.freeze(publishedMaterials),
    resourceReferences: Object.freeze({
      names: Object.freeze(resourceNames),
      truncated: texturePathsRefused || rejectedTexturePaths > 0,
    }),
    primitiveBindings: Object.freeze(primitiveBindings.bindings),
    standardMaterials: materialReferences.filter(reference => Number(reference.type) === 1).length,
    exoticMaterials: materialReferences.filter(reference => Number(reference.type) !== 1).length,
    exoticTypes: Object.freeze([...exoticTypes].sort()),
    decodedLayers,
    linkedLayers,
    rejectedNames,
    rejectedLayerReferences,
    unresolvedLayerResources,
    rejectedMaterialReferences,
    ambiguousPrimitiveBindings: primitiveBindings.ambiguous,
    unsupportedBlendModes,
    unknownFlagRecords,
    decodedBytes,
    shaderMaterials,
    shaderParametersComplete,
    issues: Object.freeze(issues),
    fatal: false,
  })
}
