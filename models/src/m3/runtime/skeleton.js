import { schemaText } from './schema.js'
import { M3SectionList } from '../../../dist/m3/native/binary/sections.js'
import { projectM3SkeletonBindings } from '../../../dist/m3/skeleton-projection.js'

const MD34_BONE_BYTES = 160
const MD33_BONE_BYTES = 156
const KNOWN_BONE_FLAGS = Object.freeze([
  Object.freeze({ mask: 0x0001, name: 'inheritTranslation' }),
  Object.freeze({ mask: 0x0002, name: 'inheritScale' }),
  Object.freeze({ mask: 0x0004, name: 'inheritRotation' }),
  Object.freeze({ mask: 0x0010, name: 'billboard1' }),
  Object.freeze({ mask: 0x0040, name: 'billboard2' }),
  Object.freeze({ mask: 0x0100, name: 'project_2d' }),
  Object.freeze({ mask: 0x0200, name: 'animated' }),
  Object.freeze({ mask: 0x0400, name: 'ik' }),
  Object.freeze({ mask: 0x0800, name: 'skinned' }),
  Object.freeze({ mask: 0x2000, name: 'real' }),
  Object.freeze({ mask: 0x4000, name: 'batch1' }),
  Object.freeze({ mask: 0x8000, name: 'batch2' }),
])
const KNOWN_BONE_FLAG_MASK = KNOWN_BONE_FLAGS.reduce((mask, item) => mask | item.mask, 0) >>> 0

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
    bones: Object.freeze([]),
    bindings: Object.freeze([]),
    sceneNodes: Object.freeze([]),
    rejectedLocalPoses: 0,
    roots: 0,
    rejectedNames: 0,
    rejectedParentLinks: 0,
    rejectedRestPoses: 0,
    unknownFlagRecords: 0,
    hierarchyComplete: false,
    restPoseComplete: false,
    decodedBytes: 0,
    issues: Object.freeze(issues),
    fatal,
  })
}

function boneIndexPreflight(bytes, budget) {
  const tag = reversedTag(bytes, 0)
  const headerBytes = tag === 'MD34' ? 24 : tag === 'MD33' ? 20 : 0
  if (headerBytes === 0 || bytes.byteLength < headerBytes) {
    return {
      entries: [],
      issue: issue('x3.m3/skeleton-container-invalid', 'the M3 header is invalid or truncated'),
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
      entries: [],
      issue: issue(
        'x3.m3/skeleton-container-invalid',
        'the M3 section index is invalid or outside the source',
      ),
    }
  }
  if (indexCount > budget.maxNodes) {
    return {
      entries: [],
      issue: issue(
        'x3.m3/skeleton-budget-exceeded',
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
  const entries = []
  let bones = 0
  let scalarBytes = 0
  for (const section of sections) {
    if (section.tag !== 'BONE') continue
    if (section.version !== 1) {
      return {
        entries: [],
        issue: issue(
          'x3.m3/skeleton-version-unsupported',
          `BONE version ${section.version} is not supported`,
        ),
      }
    }
    const recordBytes = tag === 'MD34' ? MD34_BONE_BYTES : MD33_BONE_BYTES
    const end = boundaries.find(offset => offset > section.offset) ?? bytes.byteLength
    const available = Math.max(0, end - section.offset)
    const required = section.repetitions * recordBytes
    if (!Number.isSafeInteger(required) || required > available) {
      return {
        entries: [],
        issue: issue(
          'x3.m3/skeleton-truncated',
          `the BONE table needs ${required} bytes but only ${available} are available`,
        ),
      }
    }
    bones += section.repetitions
    scalarBytes += required
    entries.push(section)
  }
  if (bones > budget.maxNodes) {
    return {
      entries: [],
      issue: issue(
        'x3.m3/skeleton-budget-exceeded',
        'the BONE table exceeds the maxNodes budget',
        'warning',
        'performance',
      ),
    }
  }
  if (scalarBytes > budget.maxScalarBytes) {
    return {
      entries: [],
      issue: issue(
        'x3.m3/skeleton-budget-exceeded',
        'the BONE table exceeds the maxScalarBytes budget',
        'warning',
        'performance',
      ),
    }
  }
  return { entries, issue: undefined }
}

function charsFromReference(sections, reference) {
  if (reference === null || typeof reference !== 'object') {
    return { value: null, bytes: 0 }
  }
  const entries = Number(reference.entries)
  const index = Number(reference.index)
  if (
    reference.__refTo !== 'CHAR' ||
    !Number.isSafeInteger(entries) ||
    entries <= 0 ||
    !Number.isSafeInteger(index) ||
    index < 0
  ) {
    return { value: null, bytes: 0 }
  }
  const section = sections.getSectionByReference(reference)
  if (
    section?.desc.history.name !== 'CHAR' ||
    !Array.isArray(section.content) ||
    entries > section.content.length
  ) {
    return { value: null, bytes: entries }
  }
  const values = section.content.slice(0, entries).map(item => Number(item))
  while (values.length > 0 && values.at(-1) === 0) values.pop()
  if (values.length === 0 || values.some(value => value < 0 || value > 255)) {
    return { value: null, bytes: entries }
  }
  const chunks = []
  for (let offset = 0; offset < values.length; offset += 0x4000) {
    chunks.push(String.fromCharCode(...values.slice(offset, offset + 0x4000)))
  }
  return { value: chunks.join(''), bytes: entries }
}

function rejectedCycles(parents, rejected) {
  const cycleLinks = new Set()
  const complete = new Uint8Array(parents.length)
  for (let start = 0; start < parents.length; start += 1) {
    if (complete[start] !== 0 || rejected.has(start)) continue
    const path = []
    const positions = new Map()
    let current = start
    while (current >= 0 && complete[current] === 0 && !rejected.has(current)) {
      const seenAt = positions.get(current)
      if (seenAt !== undefined) {
        for (const index of path.slice(seenAt)) cycleLinks.add(index)
        break
      }
      positions.set(current, path.length)
      path.push(current)
      current = parents[current]
    }
    for (const index of path) complete[index] = 1
  }
  return cycleLinks
}

/**
 * Decode the BONE table addressed by `MODL.bones` and its exact IREF rest-pose table.
 *
 * This is Node-only for the same reason as geometry: the schema-backed parser loads structures.xml.
 * Parent links, named/native flags and finite 4×4 IREF matrices are published by the optional
 * fields of `model-skeleton-source@1`. A malformed or count-mismatched IREF table is refused rather
 * than positionally joined to a different bone.
 */
export async function decodeM3Skeleton(bytes, budget, signal) {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
  const preflight = boneIndexPreflight(bytes, budget)
  if (preflight.issue !== undefined) return emptyResult([preflight.issue], true)
  if (preflight.entries.length === 0) return emptyResult()

  let sections
  try {
    sections = await M3SectionList.load(arrayBufferOf(bytes), await schemaText())
  } catch {
    return emptyResult(
      [issue('x3.m3/skeleton-decode-failed', 'the schema-backed parser refused the BONE table')],
      true,
    )
  }
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')

  const modelReference = sections.model?.bones
  // A valid empty reference does not address a section. Unused BONE sections may remain in an
  // authored animation bundle; their presence cannot turn MODL's explicit zero count into damage.
  if (modelReference?.entries === 0) return emptyResult()
  const boneSection = sections.getSectionByReference(modelReference)
  if (boneSection?.desc.history.name !== 'BONE') {
    return emptyResult([
      issue('x3.m3/skeleton-reference-refused', 'MODL.bones does not address a BONE table'),
    ])
  }
  const declared = Number(modelReference?.entries)
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > boneSection.content.length) {
    return emptyResult(
      [
        issue(
          'x3.m3/skeleton-reference-refused',
          'MODL.bones declares an invalid count for the addressed BONE table',
        ),
      ],
      true,
    )
  }
  if (declared > budget.maxNodes) {
    return emptyResult(
      [
        issue(
          'x3.m3/skeleton-budget-exceeded',
          'MODL.bones exceeds the maxNodes budget',
          'warning',
          'performance',
        ),
      ],
      true,
    )
  }
  const sourceBones = boneSection.content.slice(0, declared)
  const restReference = sections.model?.bone_rests
  const restDeclared = Number(restReference?.entries ?? 0)
  const restSection = restDeclared > 0 ? sections.getSectionByReference(restReference) : undefined
  const restRecords =
    Number.isSafeInteger(restDeclared) &&
    restDeclared === declared &&
    restSection?.desc.history.name === 'IREF' &&
    restDeclared <= restSection.content.length
      ? restSection.content.slice(0, restDeclared)
      : []
  const restPoseComplete = declared > 0 && restRecords.length === declared
  let rejectedRestPoses =
    restDeclared > 0 && !restPoseComplete ? Math.max(declared, restDeclared) : 0
  const bones = []
  let scalarBytes = preflight.entries.reduce(
    (total, section) =>
      total + section.repetitions * (sections.mdVersion === 34 ? MD34_BONE_BYTES : MD33_BONE_BYTES),
    0,
  )
  let rejectedNames = 0
  let unknownFlagRecords = 0
  scalarBytes += restRecords.length * 64
  for (const [index, bone] of sourceBones.entries()) {
    const name = charsFromReference(sections, bone.name)
    scalarBytes += name.bytes
    if (scalarBytes > budget.maxScalarBytes) {
      return emptyResult(
        [
          issue(
            'x3.m3/skeleton-budget-exceeded',
            'BONE names exceed the maxScalarBytes budget',
            'warning',
            'performance',
          ),
        ],
        true,
      )
    }
    if (name.value === null) rejectedNames += 1
    const flags = Number(bone.flags ?? 0) >>> 0
    const unknownFlagMask = (flags & ~KNOWN_BONE_FLAG_MASK) >>> 0
    if (unknownFlagMask !== 0) unknownFlagRecords += 1
    const matrix = restRecords[index]?.matrix
    const restMatrix =
      matrix === undefined
        ? undefined
        : [matrix.x, matrix.y, matrix.z, matrix.w].flatMap(row =>
            ['x', 'y', 'z', 'w'].map(component => Number(row?.[component])),
          )
    if (restMatrix !== undefined && restMatrix.some(value => !Number.isFinite(value))) {
      rejectedRestPoses += 1
    }
    bones.push(
      Object.freeze({
        index,
        name: name.value,
        parentIndex: Number(bone.parent ?? -1),
        flags,
        flagNames: Object.freeze(
          KNOWN_BONE_FLAGS.filter(item => (flags & item.mask) !== 0).map(item => item.name),
        ),
        unknownFlagMask,
        ...(restMatrix === undefined || restMatrix.some(value => !Number.isFinite(value))
          ? {}
          : { restMatrix: Object.freeze(restMatrix) }),
      }),
    )
  }

  const parents = bones.map(bone => bone.parentIndex)
  const rejectedParents = new Set()
  for (const bone of bones) {
    if (
      !Number.isSafeInteger(bone.parentIndex) ||
      bone.parentIndex < -1 ||
      bone.parentIndex >= bones.length ||
      bone.parentIndex === bone.index
    ) {
      rejectedParents.add(bone.index)
    }
  }
  const cycles = rejectedCycles(parents, rejectedParents)
  for (const index of cycles) rejectedParents.add(index)
  const hierarchyComplete = rejectedParents.size === 0
  const hierarchyId = 'm3/bone-table'
  const bindings = bones.map(bone =>
    Object.freeze({
      partId: `bone/${bone.index}`,
      boneIndex: bone.index,
      boneName: bone.name,
      provenance: bone.name === null ? 'absent' : 'direct',
      ...(hierarchyComplete ? { hierarchyId } : {}),
      ...(hierarchyComplete
        ? { parentBoneIndex: bone.parentIndex === -1 ? null : bone.parentIndex }
        : {}),
      nativeFlags: bone.flags,
      flagNames: bone.flagNames,
      ...(bone.restMatrix === undefined ? {} : { restMatrix: bone.restMatrix }),
    }),
  )
  const issues = []
  const projection = projectM3SkeletonBindings(
    sourceBones,
    bindings,
    budget,
    signal,
    billboardBehaviours(sections),
  )
  if (projection.rejectedLocalPoses > 0)
    issues.push(
      issue(
        'x3.m3/skeleton-local-pose-refused',
        `${projection.rejectedLocalPoses} BONE record(s) lack finite authored local TRS; no scene hierarchy published`,
      ),
    )
  if (rejectedNames > 0) {
    issues.push(
      issue(
        'x3.m3/skeleton-name-refused',
        `${rejectedNames} BONE name reference(s) do not address their declared CHAR data`,
      ),
    )
  }
  if (rejectedParents.size > 0) {
    issues.push(
      issue(
        'x3.m3/skeleton-parent-refused',
        `${rejectedParents.size} BONE parent link(s) are out of range, self-referential, or cyclic`,
      ),
    )
  }
  if (unknownFlagRecords > 0) {
    issues.push(
      issue(
        'x3.m3/skeleton-flags-partial',
        `${unknownFlagRecords} BONE record(s) use flag bits outside the schema's named mask`,
        'information',
      ),
    )
  }
  if (rejectedRestPoses > 0) {
    issues.push(
      issue(
        'x3.m3/skeleton-rest-pose-refused',
        `${rejectedRestPoses} IREF rest-pose record(s) could not be joined exactly to finite BONE matrices`,
      ),
    )
  }
  return Object.freeze({
    bones: Object.freeze(bones),
    bindings: projection.bindings,
    sceneNodes: projection.sceneNodes,
    rejectedLocalPoses: projection.rejectedLocalPoses,
    roots: bones.filter(bone => bone.parentIndex === -1).length,
    rejectedNames,
    rejectedParentLinks: rejectedParents.size,
    rejectedRestPoses,
    unknownFlagRecords,
    hierarchyComplete,
    restPoseComplete,
    decodedBytes: scalarBytes,
    issues: Object.freeze(issues),
    fatal: false,
  })
}

/** The model's BBSC records, as the billboard rule of their bones; an unreadable table is none. */
function billboardBehaviours(sections) {
  const reference = sections.model?.billboards
  if (reference === undefined || reference?.entries === 0) return []
  const section = sections.getSectionByReference(reference)
  if (section?.desc?.history?.name !== 'BBSC') return []
  const quaternion = value =>
    value === undefined || value === null
      ? undefined
      : [Number(value.x), Number(value.y), Number(value.z), Number(value.w)]
  return (section.content ?? []).map(record => ({
    bone: Number(record.bone),
    type: Number(record.billboard_type),
    cameraLookAt: Number(record.camera_look_at ?? 1) !== 0,
    ...(quaternion(record.up) === undefined ? {} : { up: quaternion(record.up) }),
    ...(quaternion(record.forward) === undefined ? {} : { forward: quaternion(record.forward) }),
  }))
}
