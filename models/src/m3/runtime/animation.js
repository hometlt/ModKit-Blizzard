import { schemaText } from './schema.js'
import { projectM3Animations } from '../../../dist/m3/animation-projection.js'
import { M3SectionList } from '../../../dist/m3/native/binary/sections.js'

const RECORD_BYTES = Object.freeze({
  SEQS: Object.freeze({ 1: 96, 2: 92 }),
  STC_: Object.freeze({ 4: 204 }),
  STG_: Object.freeze({ 0: 24 }),
  STS_: Object.freeze({ 0: 28 }),
})

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

function emptyResult(issues = [], fatal = false, declaredSequences = 0) {
  return Object.freeze({
    declaredSequences,
    clips: Object.freeze([]),
    timelineContainers: Object.freeze([]),
    supportedChannels: 0,
    unsupportedChannels: 0,
    unsupportedChannelReasons: Object.freeze({}),
    unsupportedChannelDataKinds: Object.freeze({}),
    invalidBounds: 0,
    rejectedTargets: 0,
    animationEvents: Object.freeze([]),
    residualAnimationTracks: Object.freeze([]),
    decodedBytes: 0,
    issues: Object.freeze(issues),
    fatal,
  })
}

function animationIndexPreflight(bytes, budget) {
  const tag = reversedTag(bytes, 0)
  const headerBytes = tag === 'MD34' ? 24 : tag === 'MD33' ? 20 : 0
  if (headerBytes === 0 || bytes.byteLength < headerBytes) {
    return {
      present: false,
      decodedBytes: 0,
      issue: issue('x3.m3/animation-container-invalid', 'the M3 header is invalid or truncated'),
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
        'x3.m3/animation-container-invalid',
        'the M3 section index is invalid or outside the source',
      ),
    }
  }
  if (indexCount > budget.maxNodes) {
    return {
      present: false,
      decodedBytes: 0,
      issue: issue(
        'x3.m3/animation-budget-exceeded',
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
    present ||= section.tag === 'SEQS' || section.tag === 'STC_'
    const recordBytes = versions[section.version]
    if (recordBytes === undefined) {
      return {
        present,
        decodedBytes,
        issue: issue(
          'x3.m3/animation-version-unsupported',
          `${section.tag} version ${section.version} is not supported`,
        ),
      }
    }
    const end = boundaries.find(offset => offset > section.offset) ?? bytes.byteLength
    const available = Math.max(0, end - section.offset)
    const required = section.repetitions * recordBytes
    if (!Number.isSafeInteger(required) || required > available) {
      return {
        present,
        decodedBytes,
        issue: issue(
          `x3.m3/animation-${section.tag === 'SEQS' ? 'seqs' : 'stc'}-truncated`,
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
        'x3.m3/animation-budget-exceeded',
        'the animation tables exceed the maxNodes budget',
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
        'x3.m3/animation-budget-exceeded',
        'the animation tables exceed the maxScalarBytes budget',
        'warning',
        'performance',
      ),
    }
  }
  return { present, decodedBytes, issue: undefined }
}

export async function decodeM3Animations(bytes, budget, signal, bindingBaseBytes, animationNames) {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
  if (bindingBaseBytes !== undefined && (bindingBaseBytes.byteLength + bytes.byteLength > budget.maxScalarBytes || BigInt(bindingBaseBytes.byteLength + bytes.byteLength) > budget.maxInputBytes))
    return emptyResult([issue('x3.m3/animation-budget-exceeded', 'M3A binding sources exceed aggregate byte budget')], true)
  const basePreflight = bindingBaseBytes === undefined ? undefined : animationIndexPreflight(bindingBaseBytes, budget)
  if (basePreflight?.issue !== undefined) return emptyResult([basePreflight.issue], true)
  const preflight = animationIndexPreflight(bytes, budget)
  if (preflight.issue !== undefined) return emptyResult([preflight.issue], true)
  if (!preflight.present) return emptyResult()

  let sections
  try {
    sections = await M3SectionList.load(arrayBufferOf(bytes), await schemaText())
  } catch {
    return emptyResult(
      [
        issue(
          'x3.m3/animation-decode-failed',
          'the schema-backed parser refused the animation tables',
        ),
      ],
      true,
    )
  }
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')

  let projection
  try {
    // Sidecar admission also verifies the base skeleton; this reader independently checks its
    // container/animation index before the added parse and charges both decoded table sets.
    const bindingBase = bindingBaseBytes === undefined ? undefined : await M3SectionList.load(arrayBufferOf(bindingBaseBytes), await schemaText())
    if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
    projection = projectM3Animations(
      sections,
      {
        ...budget,
        maxScalarBytes: budget.maxScalarBytes - preflight.decodedBytes - (basePreflight?.decodedBytes ?? 0),
      },
      signal,
      bindingBase,
      animationNames,
    )
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return emptyResult(
      [
        issue(
          error instanceof RangeError
            ? 'x3.m3/animation-budget-exceeded'
            : 'x3.m3/animation-reference-refused',
          error instanceof Error ? error.message : 'the sequence projection was refused',
        ),
      ],
      true,
    )
  }
  const issues = []
  if (projection.boundaryResampledChannels > 0)
    issues.push(issue('x3.m3/animation-boundary-resampled', `${projection.boundaryResampledChannels} leading duplicate-time channels use native samples at 0 and 1 ms for strict glTF timing; the open (0,1 ms) interval is approximate. Native source bytes remain unchanged.`))
  if (projection.invalidBounds > 0)
    issues.push(
      issue(
        'x3.m3/animation-bounds-refused',
        `${projection.invalidBounds} SEQS record(s) have invalid millisecond bounds and were not published`,
      ),
    )
  if (projection.unsupportedChannels > 0)
    issues.push(
      issue(
        'x3.m3/animation-channels-partial',
        `${projection.unsupportedChannels} STC reference(s) could not be projected into common animation or bounded residual tracks`,
        'information',
      ),
    )
  return Object.freeze({
    ...projection,
    supportedChannels: projection.clips.reduce((sum, clip) => sum + clip.channels.length, 0),
    rejectedTargets: 0,
    decodedBytes:
      preflight.decodedBytes +
      new TextEncoder().encode(JSON.stringify(projection.clips)).byteLength,
    issues: Object.freeze(issues),
    fatal: false,
  })
}
