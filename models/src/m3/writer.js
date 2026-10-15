// SPDX-License-Identifier: GPL-2.0-only
/**
 * Native-preserving M3/M3A writer for the MK3 host editing path.
 *
 * The typed section writer and semantic scale/sequence implementation are adapted from the
 * repository-local Modkit writer at pinned commit
 * 6a1f728413c8bc1effde56e9efb79c07a77a02cd. The writer receives a complete, digest-bound source
 * snapshot, produces a whole-source replacement plan, and leaves authorization and atomic commit
 * to the host. Untouched native sections, including unknown sections, remain in the graph.
 */

import { schemaText as embeddedSchemaText } from './runtime/schema.js'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import { encodeM3RenderModel, rememberM3SourceBytes } from '../../dist/m3/native/encoder.js'
import {
  appendM3Section,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from '../../dist/m3/native/structural.js'

const PROVIDER_ID = 'blizzard/m3-preserving-writer'
const OFFER_ID = 'm3-native-source'
const EVIDENCE_ID = 'm3-m3a-preserving-writer-v1'
const INTENT_KIND = 'm3-native-preserving-write-v1'
const UNKNOWN_DATA_POLICY = 'preserve-all-native-sections-and-unknown-section-bytes'
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u
const MAX_SEMANTIC_EDITS = 4096
const PORTABLE_TEXTURE_PATH =
  /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))(?![a-z][a-z0-9+.-]*:)[^\0]+$/iu

const diagnostic = (code, message) => Object.freeze({ severity: 'error', code, message })

const abort = signal => {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
}

const record = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined

function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unknown field ${key}`)
  }
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`${label} is missing ${key}`)
  }
}

function assertBudget(budget) {
  if (
    budget === undefined ||
    typeof budget.maxInputBytes !== 'bigint' ||
    budget.maxInputBytes <= 0n ||
    !Number.isSafeInteger(budget.maxScalarBytes) ||
    budget.maxScalarBytes <= 0 ||
    !Number.isSafeInteger(budget.maxNodes) ||
    budget.maxNodes <= 0 ||
    !Number.isSafeInteger(budget.maxDiagnostics) ||
    budget.maxDiagnostics <= 0
  ) {
    throw new TypeError('M3 writer requires positive host resource budgets')
  }
}

function assertSource(bytes, budget) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('M3 source snapshot must be Uint8Array')
  if (BigInt(bytes.byteLength) > budget.maxInputBytes) {
    throw new RangeError('M3 source snapshot exceeds maxInputBytes budget')
  }
  if (bytes.byteLength > budget.maxScalarBytes) {
    throw new RangeError('M3 source snapshot exceeds maxScalarBytes budget')
  }
  if (bytes.byteLength < 20) throw new TypeError('M3 source snapshot is truncated')
  const tag = String.fromCharCode(bytes[3], bytes[2], bytes[1], bytes[0]).replaceAll('\0', '')
  if (tag !== 'MD33' && tag !== 'MD34') throw new TypeError(`unsupported M3 header ${tag}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const indexOffset = view.getUint32(4, true)
  const indexCount = view.getUint32(8, true)
  const headerBytes = tag === 'MD33' ? 20 : 24
  const indexBytes = indexCount * 16
  if (
    !Number.isSafeInteger(indexBytes) ||
    indexCount > budget.maxNodes ||
    indexOffset < headerBytes ||
    indexOffset + indexBytes > bytes.byteLength
  ) {
    throw new RangeError('M3 section index is invalid or exceeds maxNodes budget')
  }
  return Object.freeze({ tag, indexCount })
}

function assertSemanticModel(model, budget, signal) {
  if (record(model) === undefined) throw new TypeError('M3 semantic model must be an object')
  const seen = new WeakSet()
  const stack = [{ value: model, depth: 0 }]
  let nodes = 0
  let scalarBytes = 0
  while (stack.length > 0) {
    if ((nodes & 0x3ff) === 0) abort(signal)
    const current = stack.pop()
    if (current === undefined) break
    const { value, depth } = current
    if (depth > budget.maxDepth) throw new RangeError('M3 semantic model exceeds maxDepth budget')
    if (typeof value === 'string') {
      scalarBytes += new TextEncoder().encode(value).byteLength
      continue
    }
    if (ArrayBuffer.isView(value)) {
      scalarBytes += value.byteLength
      continue
    }
    if (value === null || typeof value !== 'object') {
      scalarBytes += 8
      continue
    }
    // Shared immutable arrays (for example one identity matrix reused by several physics records)
    // count once. This also makes cyclic non-JSON input finite; the encoder will only observe the
    // supported acyclic fields it reads explicitly.
    if (seen.has(value)) continue
    seen.add(value)
    nodes += 1
    if (nodes > budget.maxNodes) throw new RangeError('M3 semantic model exceeds maxNodes budget')
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      stack.push({ value: child, depth: depth + 1 })
    }
    if (scalarBytes > budget.maxScalarBytes) {
      throw new RangeError('M3 semantic model exceeds maxScalarBytes budget')
    }
  }
  if (scalarBytes > budget.maxScalarBytes) {
    throw new RangeError('M3 semantic model exceeds maxScalarBytes budget')
  }
}

function numericArray(value, label, budget, maximum) {
  if (!Array.isArray(value) || value.length > Math.min(budget.maxNodes, budget.maxScalarBytes)) {
    throw new RangeError(`${label} must be a bounded numeric array`)
  }
  const numbers = value.map((item, index) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new TypeError(`${label}[${index}] must be a finite number`)
    }
    if (maximum !== undefined && (!Number.isInteger(item) || item < 0 || item > maximum)) {
      throw new RangeError(`${label}[${index}] is outside 0..${maximum}`)
    }
    return item
  })
  return numbers
}

function float32(value, label, budget) {
  const result = Float32Array.from(numericArray(value, label, budget))
  if (result.some(item => !Number.isFinite(item))) {
    throw new RangeError(`${label} contains a number outside the Float32 range`)
  }
  return result
}

const uint16 = (value, label, budget) =>
  Uint16Array.from(numericArray(value, label, budget, 0xffff))

function indices(value, label, budget) {
  const numbers = numericArray(value, label, budget, 0xffff_ffff)
  let maximum = 0
  for (const number of numbers) maximum = Math.max(maximum, number)
  return maximum <= 0xffff ? Uint16Array.from(numbers) : Uint32Array.from(numbers)
}

function optionalFloatFields(value, fields, label, budget) {
  const normalized = { ...value }
  for (const field of fields) {
    if (value[field] !== undefined)
      normalized[field] = float32(value[field], `${label}.${field}`, budget)
  }
  return normalized
}

/** Convert the JSON wire form used by codec operations into the encoder's typed-array model. */
function semanticModelFromJson(value, budget) {
  const model = record(value)
  if (model === undefined) throw new TypeError('model.write requires a model object')
  if (!Array.isArray(model.meshes)) throw new TypeError('model.write model.meshes must be an array')
  const skeleton = record(model.skeleton)
  if (skeleton === undefined || !Array.isArray(skeleton.bones)) {
    throw new TypeError('model.write model.skeleton.bones must be an array')
  }

  const meshes = model.meshes.map((item, meshIndex) => {
    const mesh = record(item)
    if (mesh === undefined) {
      throw new TypeError(`model.write model.meshes[${meshIndex}] must be an object`)
    }
    const normalized = optionalFloatFields(
      mesh,
      [
        'positions',
        'normals',
        'tangents',
        'uvs',
        'uvs1',
        'uvs2',
        'uvs3',
        'colors',
        'boneWeights',
        'morphWeights',
      ],
      `model.write model.meshes[${meshIndex}]`,
      budget,
    )
    if (normalized.positions === undefined || mesh.indices === undefined) {
      throw new TypeError(`model.write model.meshes[${meshIndex}] requires positions and indices`)
    }
    normalized.indices = indices(
      mesh.indices,
      `model.write model.meshes[${meshIndex}].indices`,
      budget,
    )
    if (mesh.boneIndices !== undefined) {
      normalized.boneIndices = uint16(
        mesh.boneIndices,
        `model.write model.meshes[${meshIndex}].boneIndices`,
        budget,
      )
    }
    if (Array.isArray(mesh.morphTargets)) {
      normalized.morphTargets = mesh.morphTargets.map((target, targetIndex) => {
        const morph = record(target)
        if (morph === undefined) {
          throw new TypeError(
            `model.write model.meshes[${meshIndex}].morphTargets[${targetIndex}] must be an object`,
          )
        }
        return optionalFloatFields(
          morph,
          ['positions', 'normals', 'tangents'],
          `model.write model.meshes[${meshIndex}].morphTargets[${targetIndex}]`,
          budget,
        )
      })
    }
    return normalized
  })

  const bones = skeleton.bones.map((item, index) => {
    const bone = record(item)
    if (bone === undefined) {
      throw new TypeError(`model.write model.skeleton.bones[${index}] must be an object`)
    }
    return bone.inverseBindMatrix === undefined
      ? { ...bone }
      : {
          ...bone,
          inverseBindMatrix: float32(
            bone.inverseBindMatrix,
            `model.write model.skeleton.bones[${index}].inverseBindMatrix`,
            budget,
          ),
        }
  })

  const effects = record(model.effects)
  const particles = Array.isArray(effects?.particles)
    ? effects.particles.map((item, particleIndex) => {
        const particle = record(item)
        if (particle === undefined) {
          throw new TypeError(
            `model.write model.effects.particles[${particleIndex}] must be an object`,
          )
        }
        if (!Array.isArray(particle.emitShapeMeshes)) return { ...particle }
        return {
          ...particle,
          emitShapeMeshes: particle.emitShapeMeshes.map((item, shapeIndex) => {
            const shape = record(item)
            if (shape === undefined) {
              throw new TypeError(
                `model.write model.effects.particles[${particleIndex}].emitShapeMeshes[${shapeIndex}] must be an object`,
              )
            }
            return {
              ...shape,
              positions: float32(
                shape.positions,
                `model.write model.effects.particles[${particleIndex}].emitShapeMeshes[${shapeIndex}].positions`,
                budget,
              ),
              indices: indices(
                shape.indices,
                `model.write model.effects.particles[${particleIndex}].emitShapeMeshes[${shapeIndex}].indices`,
                budget,
              ),
            }
          }),
        }
      })
    : effects?.particles

  return {
    ...model,
    meshes,
    skeleton: { ...skeleton, bones },
    ...(effects === undefined
      ? {}
      : { effects: { ...effects, ...(particles === undefined ? {} : { particles }) } }),
  }
}

async function schemaText(signal) {
  abort(signal)
  return embeddedSchemaText()
}

function arrayBufferOf(bytes) {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

async function sha256(bytes, signal) {
  abort(signal)
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw new TypeError('WebCrypto SHA-256 is unavailable')
  const result = await subtle.digest('SHA-256', bytes)
  abort(signal)
  const hex = [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

function safeText(value, label, maximumLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`${label} must contain 1..${maximumLength} characters`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0 || code > 0x7f) throw new TypeError(`${label} must be non-null ASCII`)
  }
  return value
}

function safeTexturePath(value, label, budget) {
  const path = safeText(value, label, Math.min(4096, budget.maxScalarBytes))
  if (!PORTABLE_TEXTURE_PATH.test(path)) {
    throw new TypeError(`${label} must be a relative asset path without dot or location segments`)
  }
  const normalized = path.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${label} must be a normalized relative asset path`)
  }
  return normalized
}

function normalizeSemanticEdits(value, budget) {
  if (!Array.isArray(value)) throw new TypeError('semanticIntent.edits must be an array')
  const limit = Math.min(MAX_SEMANTIC_EDITS, budget.maxNodes)
  if (value.length > limit) throw new RangeError(`M3 edit count exceeds ${limit}`)
  const edits = []
  const sequenceIndexes = new Set()
  const texturePaths = new Set()
  let hasScale = false
  for (let index = 0; index < value.length; index += 1) {
    const edit = record(value[index])
    if (edit === undefined) throw new TypeError(`semanticIntent.edits[${index}] must be an object`)
    if (edit.kind === 'scale-model-v1') {
      exactKeys(edit, ['kind', 'factor'], [], `semanticIntent.edits[${index}]`)
      if (hasScale) throw new TypeError('M3 change may contain only one scale-model-v1 edit')
      if (typeof edit.factor !== 'number' || !Number.isFinite(edit.factor) || edit.factor <= 0) {
        throw new RangeError('M3 scale factor must be a positive finite number')
      }
      hasScale = true
      edits.push(Object.freeze({ kind: edit.kind, factor: edit.factor }))
      continue
    }
    if (edit.kind === 'rename-sequence-v1') {
      exactKeys(edit, ['kind', 'index', 'name'], [], `semanticIntent.edits[${index}]`)
      if (!Number.isSafeInteger(edit.index) || edit.index < 0 || edit.index >= budget.maxNodes) {
        throw new RangeError('M3 sequence index is outside maxNodes budget')
      }
      if (sequenceIndexes.has(edit.index))
        throw new TypeError(`M3 sequence ${edit.index} is edited twice`)
      sequenceIndexes.add(edit.index)
      edits.push(
        Object.freeze({
          kind: edit.kind,
          index: edit.index,
          name: safeText(edit.name, 'M3 sequence name', Math.min(4096, budget.maxScalarBytes)),
        }),
      )
      continue
    }
    if (edit.kind === 'rename-texture-v1') {
      exactKeys(edit, ['kind', 'oldPath', 'newPath'], [], `semanticIntent.edits[${index}]`)
      const oldPath = safeTexturePath(edit.oldPath, 'M3 old texture path', budget)
      const newPath = safeTexturePath(edit.newPath, 'M3 new texture path', budget)
      const key = oldPath.toLowerCase()
      if (texturePaths.has(key)) throw new TypeError(`M3 texture ${oldPath} is edited twice`)
      texturePaths.add(key)
      edits.push(Object.freeze({ kind: edit.kind, oldPath, newPath }))
      continue
    }
    throw new TypeError(`unsupported M3 semantic edit ${String(edit.kind)}`)
  }
  return Object.freeze(edits)
}

function sourceOf(change, budget) {
  if (change.targets.length !== 1 || change.edits.length !== 1) {
    throw new TypeError('M3 writer requires one target and one complete source snapshot')
  }
  const target = change.targets[0]
  const edit = change.edits[0]
  if (
    edit.operation !== 'replace' ||
    edit.range !== undefined ||
    edit.targetId !== target.targetId ||
    edit.source.id !== target.ownerSource.id ||
    edit.source.uri !== target.ownerSource.uri ||
    edit.payload.kind !== 'inline'
  ) {
    throw new TypeError('M3 writer requires one whole-source inline replacement of its own target')
  }
  assertSource(edit.payload.bytes, budget)
  return Object.freeze({ target, edit, bytes: edit.payload.bytes })
}

function intentOf(value, budget) {
  const intent = record(value)
  if (intent === undefined) throw new TypeError('M3 semanticIntent must be an object')
  exactKeys(
    intent,
    ['kind', 'sourceComplete', 'sourceContentDigest', 'unknownDataPolicy', 'edits'],
    [],
    'semanticIntent',
  )
  if (
    intent.kind !== INTENT_KIND ||
    intent.sourceComplete !== true ||
    typeof intent.sourceContentDigest !== 'string' ||
    !SHA256_DIGEST.test(intent.sourceContentDigest) ||
    intent.unknownDataPolicy !== UNKNOWN_DATA_POLICY
  ) {
    throw new TypeError('M3 semanticIntent identity or source proof is invalid')
  }
  return Object.freeze({
    sourceContentDigest: intent.sourceContentDigest,
    edits: normalizeSemanticEdits(intent.edits, budget),
  })
}

function stringOf(sections, reference) {
  if (record(reference) === undefined || Number(reference.entries) <= 0) return undefined
  const section = sections.getSectionByReference(reference)
  if (section?.desc.history.name !== 'CHAR') return undefined
  const values = section.content.slice(0, Number(reference.entries)).map(Number)
  while (values.at(-1) === 0) values.pop()
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 0xff)) return undefined
  return new TextDecoder('ascii').decode(Uint8Array.from(values))
}

function appendString(sections, value) {
  return appendM3Section(sections, 'CHAR', 0, [...new TextEncoder().encode(`${value}\0`)])
}

function renameTexturePaths(sections, edits) {
  const replacements = new Map(edits.map(edit => [edit.oldPath.toLowerCase(), edit]))
  const targets = new Map()
  const counts = new Map(edits.map(edit => [edit.oldPath.toLowerCase(), 0]))
  for (const section of sections) {
    if (section.desc.history.name !== 'LAYR') continue
    for (const layer of section.content) {
      if (record(layer) === undefined || record(layer.color_bitmap) === undefined) continue
      const current = stringOf(sections, layer.color_bitmap)
      if (current === undefined) continue
      const key = current.replaceAll('\\', '/').toLowerCase()
      const replacement = replacements.get(key)
      if (replacement === undefined) continue
      let target = targets.get(replacement.newPath)
      if (target === undefined) {
        target = appendString(sections, replacement.newPath)
        targets.set(replacement.newPath, target)
      }
      pointM3ReferenceAtSection(sections, layer.color_bitmap, target)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  for (const edit of edits) {
    if ((counts.get(edit.oldPath.toLowerCase()) ?? 0) === 0) {
      throw new TypeError(`M3 texture path «${edit.oldPath}» was not found in any LAYR record`)
    }
  }
  return Object.freeze(
    edits.map(edit =>
      Object.freeze({
        oldPath: edit.oldPath,
        newPath: edit.newPath,
        references: counts.get(edit.oldPath.toLowerCase()) ?? 0,
      }),
    ),
  )
}

function sequenceCount(sections) {
  const reference = sections.model?.sequences
  const section = sections.getSectionByReference(reference)
  return section?.content.length ?? 0
}

async function applySemanticEdits(sourceBytes, edits, budget, signal) {
  abort(signal)
  const xml = await schemaText(signal)
  let bytes = sourceBytes.slice()
  const scale = edits.find(edit => edit.kind === 'scale-model-v1')?.factor ?? 1
  const sequenceEdits = edits.filter(edit => edit.kind === 'rename-sequence-v1')
  const sourceSections = await M3SectionList.load(arrayBufferOf(bytes), xml)
  if (sourceSections.length > budget.maxNodes)
    throw new RangeError('M3 sections exceed maxNodes budget')
  const count = sequenceCount(sourceSections)
  const animationNames = []
  for (const edit of sequenceEdits) {
    if (edit.index >= count)
      throw new RangeError(`M3 sequence index ${edit.index} exceeds ${count}`)
    animationNames[edit.index] = edit.name
  }
  abort(signal)
  if (scale !== 1 || sequenceEdits.length > 0) {
    const semanticModel = Object.freeze({ materials: Object.freeze([]) })
    rememberM3SourceBytes(semanticModel, bytes)
    const encoded = await encodeM3RenderModel(
      semanticModel,
      { scale, animationNames, includeTextures: false },
      { structuresXml: xml },
    )
    bytes = encoded.bytes
  }
  abort(signal)
  const textureEdits = edits.filter(edit => edit.kind === 'rename-texture-v1')
  let textureChanges = Object.freeze([])
  if (textureEdits.length > 0) {
    const sections = await M3SectionList.load(arrayBufferOf(bytes), xml)
    textureChanges = renameTexturePaths(sections, textureEdits)
    bytes = serializeM3SectionGraph(sections)
  }
  assertSource(bytes, budget)
  await M3SectionList.load(arrayBufferOf(bytes), xml)
  abort(signal)
  return Object.freeze({ bytes, scale, sequenceEdits: sequenceEdits.length, textureChanges })
}

async function prepare(change, context, signal) {
  abort(context.signal)
  abort(signal)
  const budget = context.budgets
  assertBudget(budget)
  const source = sourceOf(change, budget)
  const intent = intentOf(change.semanticIntent, budget)
  const beforeDigest = await sha256(source.bytes, signal)
  if (beforeDigest !== intent.sourceContentDigest) {
    throw new TypeError('M3 source snapshot does not match semanticIntent.sourceContentDigest')
  }
  const result = await applySemanticEdits(source.bytes, intent.edits, budget, signal)
  if ((await sha256(source.bytes, signal)) !== beforeDigest) {
    throw new TypeError('M3 writer mutated its source snapshot')
  }
  return Object.freeze({ ...source, ...result, sourceDigest: beforeDigest })
}

async function validationOf(change, context, signal) {
  try {
    await prepare(change, context, signal)
    return Object.freeze({ valid: true, diagnostics: Object.freeze([]) })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([
        diagnostic(
          'blizzard/m3-native-write-invalid',
          cause instanceof Error ? cause.message : String(cause),
        ),
      ]),
    })
  }
}

function createWriter(context) {
  const providerIdentity = context.providerIdentity
  if (
    providerIdentity === undefined ||
    providerIdentity.providerId !== PROVIDER_ID ||
    typeof providerIdentity.providerVersion !== 'string' ||
    providerIdentity.providerVersion.length === 0 ||
    typeof providerIdentity.artifactDigest !== 'string' ||
    providerIdentity.artifactDigest.length === 0
  ) {
    throw new TypeError('M3 writer requires its exact host-attested provider identity')
  }
  const identity = Object.freeze({
    ...providerIdentity,
    formatId: 'm3',
    representationId: 'source',
  })
  const fidelity = Object.freeze({
    roundTrip: 'semantic',
    preservesUnknownData: true,
    notes: Object.freeze([
      'a no-op complete source snapshot is byte-identical',
      'semantic scale and sequence-name edits use the pinned native section-graph writer',
      'texture renames retarget exact LAYR-to-CHAR references and may grow paths without byte patching',
      'known sections are relocated deterministically and unknown section payload bytes are preserved',
      'source digest, resource budgets, edit bounds and relative texture paths are checked before planning',
    ]),
  })
  return Object.freeze({
    identity,
    offer: Object.freeze({
      providerId: PROVIDER_ID,
      fidelityEvidenceId: EVIDENCE_ID,
      formatId: 'm3',
      representationId: 'source',
      mutationMode: 'mutate',
      minimumRoundTrip: 'semantic',
    }),
    async validate(change, signal) {
      return await validationOf(change, context, signal)
    },
    async plan(change, signal) {
      const prepared = await prepare(change, context, signal)
      return Object.freeze({
        planId: `${PROVIDER_ID}:${prepared.target.targetId}:${prepared.sourceDigest}`,
        targets: change.targets,
        edits: Object.freeze([
          Object.freeze({
            operation: 'replace',
            targetId: prepared.target.targetId,
            source: prepared.target.ownerSource,
            payload: Object.freeze({ kind: 'inline', bytes: prepared.bytes }),
            label: 'validated native-preserving M3/M3A semantic write',
          }),
        ]),
        semantics: Object.freeze({ mutationMode: 'mutate', minimumGuarantee: 'atomic' }),
        fidelity,
        diagnostics: Object.freeze([]),
      })
    },
  })
}

export const abiVersion = 1
export const provides = Object.freeze(['common.edit/writer'])

export function createProvider(selection, context) {
  if (
    selection.contract !== 'common.edit/writer' ||
    selection.major !== 1 ||
    selection.offerId !== OFFER_ID
  ) {
    throw new TypeError(`unknown M3 writer offer ${selection.offerId}`)
  }
  return Object.freeze({ value: createWriter(context), release: async () => undefined })
}

export const M3_NATIVE_WRITE_INTENT = Object.freeze({
  kind: INTENT_KIND,
  unknownDataPolicy: UNKNOWN_DATA_POLICY,
  supportedEdits: Object.freeze(['scale-model-v1', 'rename-sequence-v1', 'rename-texture-v1']),
  legacyWriterCommit: '6a1f728413c8bc1effde56e9efb79c07a77a02cd',
})

/** Build one immutable, digest-bound whole-source change for the ordinary MK3 editor workflow. */
export async function snapshotM3SemanticEdit(options) {
  const { sourceBytes, target, edits, budget, signal } = options
  abort(signal)
  assertBudget(budget)
  assertSource(sourceBytes, budget)
  if (
    target?.expectedRevision === undefined ||
    typeof target.targetId !== 'string' ||
    record(target.ownerSource) === undefined
  ) {
    throw new TypeError('M3 writer target must be a revision-pinned host editing target')
  }
  const normalized = normalizeSemanticEdits(edits, budget)
  const snapshot = sourceBytes.slice()
  const sourceContentDigest = await sha256(snapshot, signal)
  abort(signal)
  return Object.freeze({
    targets: Object.freeze([target]),
    edits: Object.freeze([
      Object.freeze({
        operation: 'replace',
        targetId: target.targetId,
        source: target.ownerSource,
        payload: Object.freeze({ kind: 'inline', bytes: snapshot }),
      }),
    ]),
    semanticIntent: Object.freeze({
      kind: INTENT_KIND,
      sourceComplete: true,
      sourceContentDigest,
      unknownDataPolicy: UNKNOWN_DATA_POLICY,
      edits: normalized,
    }),
    provenance: Object.freeze({
      actor: 'user',
      note: 'bounded native-preserving M3/M3A semantic edit',
    }),
  })
}

/**
 * Product API for authoring a new M3 from the same RenderModel-shaped semantic input supported by
 * the legacy writer. The returned bytes must still be committed through a host writer target.
 */
export async function encodeM3SemanticModel(model, options, budget, signal) {
  abort(signal)
  assertBudget(budget)
  assertSemanticModel(model, budget, signal)
  const xml = await schemaText(signal)
  const result = await encodeM3RenderModel(model, options, { structuresXml: xml })
  assertSource(result.bytes, budget)
  abort(signal)
  return result
}

/** Bounded JSON operation adapter for authoring a new M3 without exposing host objects. */
export async function encodeM3JsonModel(model, options, budget, signal) {
  abort(signal)
  assertBudget(budget)
  assertSemanticModel(model, budget, signal)
  const encodeOptions = options === undefined ? {} : record(options)
  if (encodeOptions === undefined) throw new TypeError('model.write options must be an object')
  if ('assetResolver' in encodeOptions || encodeOptions.includeTextures === true) {
    throw new TypeError(
      'model.write JSON operation does not accept resource resolvers or companion writes',
    )
  }
  return await encodeM3SemanticModel(
    semanticModelFromJson(model, budget),
    { ...encodeOptions, includeTextures: false },
    budget,
    signal,
  )
}
