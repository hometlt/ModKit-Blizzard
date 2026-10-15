// Native field correspondences only; evaluation and simulation belong to shared scene.
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { JsonObject, JsonValue } from '@modkit/sdk'

interface Sections {
  readonly model: Readonly<Record<string, unknown>> | null
  getSectionByReference(reference: unknown): {
    readonly content: readonly unknown[]
    readonly desc: { readonly history: { readonly name: string }; readonly version: number }
  } | null
}
interface Budget {
  readonly maxNodes: number
  readonly maxDepth: number
  readonly maxScalarBytes: number
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('native effect field record absent')
  return value as Record<string, unknown>
}
/** The caller supplies the existing pinned M3AnimationReferenceTrackExtractor.extract bound to
 * this exact source/sequence context. It owns STC/STS/SD resolution and boundary/wrap semantics. */
export function addM3FieldTracks(
  effects: JsonObject,
  sections: Sections,
  extract: (reference: unknown) => unknown,
  budget: Budget,
  signal?: AbortSignal,
): JsonObject {
  let output = snapshotJson(
    effects,
    { maxNodes: budget.maxNodes, maxDepth: budget.maxDepth, maxBytes: budget.maxScalarBytes },
    signal,
  ) as JsonObject
  // Each added track shares one aggregate output allowance. Snapshotting each field against
  // the full budget would permit many individually bounded fields to accumulate unboundedly.
  let remainingNodes = budget.maxNodes,
    remainingBytes = budget.maxScalarBytes
  const charge = (nodes: number, bytes: number): void => {
    remainingNodes -= nodes
    remainingBytes -= bytes
    if (remainingNodes < 0 || remainingBytes < 0)
      throw new RangeError('native field tracks exceed aggregate budget')
  }
  const textBytes = (text: string): number => {
    let bytes = 0
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0
      bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4
    }
    return bytes
  }
  const reserve = (value: JsonValue): void => {
    charge(1, 0)
    if (value === null || typeof value !== 'object') {
      charge(0, textBytes(JSON.stringify(value)))
      return
    }
    charge(0, 2)
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (index > 0) charge(0, 1)
        reserve(item)
      }
    } else {
      let first = true
      for (const [key, item] of Object.entries(value)) {
        charge(0, textBytes(JSON.stringify(key)) + 1 + Number(!first))
        first = false
        reserve(item)
      }
    }
  }
  reserve(output)
  const model = object(sections.model)
  let work = 0
  for (const spec of [
    {
      kind: 'forces',
      table: 'forces',
      tag: 'FOR_',
      versions: [1, 2],
      fields: ['strength', 'width', 'height', 'length'],
    },
    { kind: 'warps', table: 'warps', tag: 'WRP_', versions: [1], fields: ['radius', 'strength'] },
    {
      kind: 'projectors',
      table: 'projections',
      tag: 'PROJ',
      versions: [4, 5],
      fields: [
        'offset',
        'pitch',
        'yaw',
        'roll',
        'field_of_view',
        'aspect_ratio',
        'near',
        'far',
        'box_offset_z_bottom',
        'box_offset_z_top',
        'box_offset_x_left',
        'box_offset_x_right',
        'box_offset_y_front',
        'box_offset_y_back',
        'active',
      ],
    },
  ]) {
    const reference = model[spec.table],
      count = object(reference)['entries']
    if (count === 0) continue
    const section = sections.getSectionByReference(reference),
      projected = output[spec.kind]
    if (
      !section ||
      section.desc.history.name !== spec.tag ||
      !spec.versions.includes(section.desc.version) ||
      !Number.isSafeInteger(count) ||
      count !== section.content.length ||
      !Array.isArray(projected) ||
      projected.length !== count
    )
      throw new TypeError('native field effect correspondence differs')
    const targets: JsonValue[] = []
    for (const [index, raw] of section.content.entries()) {
      const record = object(raw),
        target = { ...object(projected[index]) },
        tracks: Record<string, JsonValue> = {}
      if (target['sequenceAnimation'] !== undefined)
        throw new TypeError('native field tracks already supplied')
      for (const field of spec.fields) {
        signal?.throwIfAborted()
        if (++work > budget.maxNodes) throw new RangeError('native field tracks exceed budget')
        const ref = object(record[field]),
          desc = object(ref['desc'])
        const expected =
          spec.kind !== 'projectors'
            ? 'FloatAnimationReference'
            : field === 'offset'
              ? 'Vector3AnimationReference'
              : field === 'active'
                ? 'UInt32AnimationReference'
                : 'FloatAnimationReference'
        if (object(desc['history'])['name'] !== expected || desc['version'] !== 0)
          throw new TypeError(`unsupported native effect reference ${spec.tag}.${field}`)
        const sourceTracks = extract(ref)
        if (!Array.isArray(sourceTracks))
          throw new TypeError('native field extractor returned no list')
        if (sourceTracks.length === 0) continue
        const extracted = snapshotJson(
          sourceTracks,
          { maxNodes: remainingNodes, maxDepth: budget.maxDepth, maxBytes: remainingBytes },
          signal,
        )
        if (!Array.isArray(extracted))
          throw new TypeError('native field extractor returned no list')
        if (extracted.length > 0) {
          reserve(extracted)
          // Quoted ASCII field key, colon and a conservative leading comma.
          const key =
            spec.kind === 'projectors'
              ? field.replace(/_([a-z])/g, (_match: string, letter: string) => letter.toUpperCase())
              : field
          charge(0, key.length + 4)
          tracks[key] = extracted
        }
      }
      if (Object.keys(tracks).length > 0) {
        charge(1, JSON.stringify('sequenceAnimation').length + 4)
        target['sequenceAnimation'] = tracks
      }
      targets.push(target as JsonObject)
    }
    output = { ...output, [spec.kind]: targets }
  }
  return snapshotJson(
    output,
    { maxNodes: budget.maxNodes, maxDepth: budget.maxDepth, maxBytes: budget.maxScalarBytes },
    signal,
  ) as JsonObject
}
