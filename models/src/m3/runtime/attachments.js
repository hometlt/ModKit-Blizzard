import { schemaText } from './schema.js'
import { M3SectionList } from '../../../dist/m3/native/binary/sections.js'

const RECORD_BYTES = Object.freeze({
  ATT_: Object.freeze({ 1: 20 }),
  ATVL: Object.freeze({ 0: 116 }),
})

function arrayBufferOf(bytes) {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
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
    sockets: Object.freeze([]),
    volumes: Object.freeze([]),
    primaryAnimationHash: 0,
    additionalAnimationHashes: Object.freeze([]),
    animationHashes: Object.freeze([]),
    rejectedNames: 0,
    rejectedBones: 0,
    rejectedVolumes: 0,
    decodedBytes: 0,
    issues: Object.freeze(issues),
    fatal,
  })
}

function attachmentPreflight(bytes, budget) {
  const tag = reversedTag(bytes, 0)
  const headerBytes = tag === 'MD34' ? 24 : tag === 'MD33' ? 20 : 0
  if (headerBytes === 0 || bytes.byteLength < headerBytes) {
    return {
      decodedBytes: 0,
      issue: issue('x3.m3/attachment-container-invalid', 'the M3 header is invalid or truncated'),
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const indexOffset = view.getUint32(4, true)
  const indexCount = view.getUint32(8, true)
  const indexBytes = indexCount * 16
  if (
    !Number.isSafeInteger(indexBytes) ||
    indexOffset < headerBytes ||
    indexOffset + indexBytes > bytes.byteLength
  ) {
    return {
      decodedBytes: 0,
      issue: issue(
        'x3.m3/attachment-container-invalid',
        'the M3 section index is outside the source',
      ),
    }
  }
  if (indexCount > budget.maxNodes) {
    return {
      decodedBytes: 0,
      issue: issue(
        'x3.m3/attachment-budget-exceeded',
        'the M3 section index exceeds maxNodes',
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
  for (const section of sections) {
    const known = RECORD_BYTES[section.tag]
    if (known === undefined) continue
    const recordBytes = known[section.version]
    if (recordBytes === undefined) {
      return {
        decodedBytes,
        issue: issue(
          'x3.m3/attachment-version-unsupported',
          `${section.tag} version ${section.version} is not supported`,
        ),
      }
    }
    const end = boundaries.find(offset => offset > section.offset) ?? bytes.byteLength
    const required = section.repetitions * recordBytes
    if (!Number.isSafeInteger(required) || required > Math.max(0, end - section.offset)) {
      return {
        decodedBytes,
        issue: issue(
          'x3.m3/attachment-table-truncated',
          `${section.tag} needs ${required} bytes outside its section`,
        ),
      }
    }
    nodes += section.repetitions
    decodedBytes += required
  }
  if (nodes > budget.maxNodes || decodedBytes > budget.maxScalarBytes) {
    return {
      decodedBytes,
      issue: issue(
        'x3.m3/attachment-budget-exceeded',
        'attachment tables exceed the decode budget',
        'warning',
        'performance',
      ),
    }
  }
  return { decodedBytes, issue: undefined }
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

function referencedString(sections, reference) {
  const records = declaredRecords(sections, reference, 'CHAR')
  if (records === null) return { value: null, bytes: Number(reference?.entries ?? 0) }
  const values = records.map(Number)
  while (values.at(-1) === 0) values.pop()
  if (
    values.length === 0 ||
    values.some(value => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return { value: null, bytes: records.length }
  }
  try {
    return {
      value: new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(values)),
      bytes: records.length,
    }
  } catch {
    return { value: null, bytes: records.length }
  }
}

function uint32Values(sections, reference) {
  const records = declaredRecords(sections, reference, 'U32_')
  if (records === null) return null
  const values = records.map(value => Number(value) >>> 0).filter(value => value !== 0)
  return Object.freeze(values)
}

/**
 * Decode ATT_/ATVL and the MODL M3A binding hashes through exact references.
 *
 * A socket uses the skeleton facet's `bone/<index>` part id as its target. M3 does not declare a
 * portable socket orientation; no axis is inferred from the name. ATVL dimensions/matrices do not
 * fit model-collision-source@1, so only their declared kind/identity is projected and the receipt
 * keeps the omitted native values visible.
 */
export async function decodeM3Attachments(bytes, budget, signal) {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
  const preflight = attachmentPreflight(bytes, budget)
  if (preflight.issue !== undefined) return emptyResult([preflight.issue], true)

  let sections
  try {
    sections = await M3SectionList.load(arrayBufferOf(bytes), await schemaText())
  } catch {
    return emptyResult(
      [issue('x3.m3/attachment-decode-failed', 'the schema-backed parser refused ATT_/ATVL')],
      true,
    )
  }
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')

  const attachments = declaredRecords(sections, sections.model?.attachment_points, 'ATT_')
  const volumes = declaredRecords(sections, sections.model?.attachment_volumes, 'ATVL')
  const hitTests = declaredRecords(sections, sections.model?.hittests, 'SSGS')
  const bones = declaredRecords(sections, sections.model?.bones, 'BONE')
  const extraHashes = uint32Values(sections, sections.model?.m3a_hashes)
  if (attachments === null || volumes === null || hitTests === null || bones === null || extraHashes === null) {
    return emptyResult(
      [
        issue(
          'x3.m3/attachment-reference-refused',
          'MODL attachment, bone, or M3A hash references do not address their declared types',
        ),
      ],
      true,
    )
  }

  const issues = []
  const sockets = []
  const collisionVolumes = []
  let decodedBytes = preflight.decodedBytes
  let rejectedNames = 0
  let rejectedBones = 0
  let rejectedVolumes = 0
  for (const [index, attachment] of attachments.entries()) {
    if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
    const name = referencedString(sections, attachment.name)
    decodedBytes += name.bytes
    const boneIndex = Number(attachment.bone)
    if (name.value === null) rejectedNames += 1
    if (!Number.isSafeInteger(boneIndex) || boneIndex < 0 || boneIndex >= bones.length) {
      rejectedBones += 1
      continue
    }
    sockets.push(
      Object.freeze({
        id: `m3-attachment-${index}`,
        nodeId: `bone/${boneIndex}`,
        role: 'attach',
        ...(name.value === null ? {} : { sourceName: name.value }),
      }),
    )
  }
  for (const [index, volume] of volumes.entries()) {
    const boneIndex = Number(volume.bone0)
    const shape = Number(volume.shape)
    if (
      !Number.isSafeInteger(boneIndex) ||
      boneIndex < 0 ||
      boneIndex >= bones.length ||
      !Number.isSafeInteger(shape)
    ) {
      rejectedVolumes += 1
      continue
    }
    collisionVolumes.push(
      Object.freeze({
        id: `m3-attachment-volume-${index}`,
        kind: `m3-shape-${shape}`,
        origin: 'declared-volume',
        types: Object.freeze(['attachment']),
      }),
    )
  }
  // SSGS hit tests: what a click or a projectile tests against, each on one bone.
  for (const [index, hit] of hitTests.entries()) {
    const boneIndex = Number(hit.bone)
    const shape = Number(hit.shape)
    if (!Number.isSafeInteger(boneIndex) || boneIndex < 0 || boneIndex >= bones.length || !Number.isSafeInteger(shape)) {
      rejectedVolumes += 1
      continue
    }
    collisionVolumes.push(
      Object.freeze({
        id: `m3-hittest-${index}`,
        kind: `m3-shape-${shape}`,
        origin: 'declared-volume',
        types: Object.freeze(['hit']),
      }),
    )
  }
  if (decodedBytes > budget.maxScalarBytes) {
    return emptyResult(
      [
        issue(
          'x3.m3/attachment-budget-exceeded',
          'attachment names exceed maxScalarBytes',
          'warning',
          'performance',
        ),
      ],
      true,
    )
  }
  if (rejectedNames > 0)
    issues.push(
      issue(
        'x3.m3/attachment-name-refused',
        `${rejectedNames} ATT_ name reference(s) were refused`,
      ),
    )
  if (rejectedBones > 0)
    issues.push(
      issue(
        'x3.m3/attachment-bone-refused',
        `${rejectedBones} ATT_ bone index/indices were outside MODL.bones`,
      ),
    )
  if (rejectedVolumes > 0)
    issues.push(
      issue(
        'x3.m3/attachment-volume-refused',
        `${rejectedVolumes} ATVL/SSGS record(s) had an invalid bone or shape`,
      ),
    )

  const primaryHash = Number(sections.model?.m3a_hash) >>> 0
  const animationHashes = [
    ...new Set([...(primaryHash === 0 ? [] : [primaryHash]), ...extraHashes]),
  ]
  return Object.freeze({
    sockets: Object.freeze(sockets),
    volumes: Object.freeze(collisionVolumes),
    primaryAnimationHash: primaryHash,
    additionalAnimationHashes: Object.freeze([...extraHashes]),
    animationHashes: Object.freeze(animationHashes),
    rejectedNames,
    rejectedBones,
    rejectedVolumes,
    decodedBytes,
    issues: Object.freeze(issues),
    fatal: false,
  })
}
