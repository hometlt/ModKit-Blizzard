import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { JsonObject } from '@modkit/sdk'
import type { M3EffectsSource } from './effects.js'
import type { M3EffectsBudget, M3EffectsPrimitive } from '../runtime/effects.js'

export interface M3EffectSidecarSource {
  readonly logicalId: string
  /** Same base emitter definitions, projected against this sidecar's animation tables. */
  readonly projection: M3EffectsSource
  readonly nativeSequenceCount: number
  readonly proof: readonly JsonObject[]
}
interface Description {
  readonly history: { readonly name: string; readonly primitive?: boolean }
  readonly fields: Readonly<Record<string, { readonly name: string }>>
}
interface NativeRecord extends Record<string, unknown> {
  readonly desc: Description
}
interface Section {
  readonly desc: Description
  readonly content: readonly unknown[]
  readonly indexEntry: { readonly repetitions: number }
}
interface Sections extends ReadonlyArray<Section> {
  readonly model: NativeRecord | null
  getSectionByReference(reference: unknown): Section | null
}
interface Resolved {
  readonly stcIndex: number
  readonly sdIndex: number
  readonly sdField: string
  readonly sd: NativeRecord
}
interface NativeBridge {
  readonly M3AnimationEvaluator: new (
    model: NativeRecord,
    sections: Sections,
  ) => {
    resolveAnimRef(sequence: number, id: number): Resolved | null
  }
  projectM3Effects(
    sections: {
      readonly model: NativeRecord
      getSectionByReference(reference: unknown): Section | null
    },
    primitives: readonly M3EffectsPrimitive[],
    budget: M3EffectsBudget,
    signal?: AbortSignal,
  ): M3EffectsSource
}
interface AnimationReference {
  readonly id: number
  readonly path: string
  readonly type: string
  readonly reference: NativeRecord
}
const animationTables = [
  'sequences',
  'sequence_transformation_groups',
  'sequence_transformation_collections',
  'sts',
] as const
const effectTables = [
  'particle_systems',
  'particle_copies',
  'ribbons',
  'forces',
  'warps',
  'projections',
] as const
const sdTypes: Readonly<Record<string, string>> = {
  Vector3AnimationReference: 'sd3v',
  Vector2AnimationReference: 'sd2v',
  QuaternionAnimationReference: 'sd4q',
  UInt32AnimationReference: 'sdu3',
  Int32AnimationReference: 'sds3',
  UInt16AnimationReference: 'sdu6',
  Int16AnimationReference: 'sds6',
  FloatAnimationReference: 'sdr3',
  ColorAnimationReference: 'sdcc',
  FlagAnimationReference: 'sdfg',
  BNDSAnimationReference: 'sdmb',
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('M3 effect binding record absent')
  return value as Record<string, unknown>
}
function record(value: unknown): NativeRecord | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ArrayBuffer.isView(value)
  )
    return undefined
  const candidate = value as Record<string, unknown>
  return candidate['desc'] === undefined ? undefined : (candidate as NativeRecord)
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`invalid M3 effect ${label}`)
  return value
}
function section(sections: Sections, reference: unknown): Section | null {
  if (reference === undefined || reference === null) return null
  const count = integer(object(reference)['entries'], 'reference entries')
  if (count === 0) return null
  const result = sections.getSectionByReference(reference)
  if (result === null || result.content.length !== count || result.indexEntry.repetitions !== count)
    throw new TypeError('M3 effect binding requires complete native references')
  return result
}
function preflight(bytes: Uint8Array, budget: M3EffectsBudget, signal?: AbortSignal): number {
  signal?.throwIfAborted()
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 24 ||
    bytes.length > Math.min(budget.maxInputBytes, budget.maxScalarBytes)
  )
    throw new RangeError('M3 effect binding source exceeds byte budget')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = view.getUint32(0, true),
    offset = view.getUint32(4, true),
    count = view.getUint32(8, true)
  if (
    (tag !== 0x4d443333 && tag !== 0x4d443334) ||
    count === 0 ||
    count > budget.maxNodes ||
    offset < (tag === 0x4d443333 ? 20 : 24) ||
    offset + count * 16 > bytes.length
  )
    throw new RangeError('invalid M3 effect binding section index')
  let nodes = count
  for (let index = 0; index < count; index++) {
    nodes += view.getUint32(offset + index * 16 + 8, true)
    if (view.getUint32(offset + index * 16 + 4, true) >= offset || nodes > budget.maxNodes)
      throw new RangeError('M3 effect binding native records exceed budget')
  }
  return nodes
}
function identities(sections: Sections, budget: M3EffectsBudget, signal?: AbortSignal) {
  const owns = new WeakSet<object>(),
    references = new Map<number, AnimationReference[]>()
  const bySection = new Map<Section, AnimationReference[]>()
  let count = 0
  for (const [sectionIndex, nativeSection] of sections.entries()) {
    const local: AnimationReference[] = []
    const visit = (value: unknown, path: string, depth: number): void => {
      signal?.throwIfAborted()
      const item = record(value)
      if (item === undefined || owns.has(item)) return
      if (++count > budget.maxNodes || depth > budget.maxDepth)
        throw new RangeError('M3 effect reference graph exceeds budget')
      owns.add(item)
      const type = item.desc.history.name
      if (type.endsWith('AnimationReference') && item['header'] !== undefined) {
        const id = integer(object(item['header'])['id'], 'animation id')
        const reference = { id, type, path, reference: item },
          existing = references.get(id) ?? []
        existing.push(reference)
        references.set(id, existing)
        local.push(reference)
      }
      for (const field of Object.values(item.desc.fields))
        visit(item[field.name], `${path}.${field.name}`, depth + 1)
    }
    for (const [ordinal, value] of nativeSection.content.entries())
      visit(value, `${nativeSection.desc.history.name}[${ordinal}]@${sectionIndex}`, 0)
    bySection.set(nativeSection, local)
  }
  return { owns, references, bySection }
}
function effectSections(
  base: Sections,
  budget: M3EffectsBudget,
  signal?: AbortSignal,
): ReadonlySet<Section> {
  const model = object(base.model),
    visited = new Set<Section>(),
    pending: Section[] = []
  for (const field of effectTables) {
    const root = section(base, model[field])
    if (root !== null) pending.push(root)
  }
  let scanned = 0
  const visit = (value: unknown, depth: number): void => {
    signal?.throwIfAborted()
    const item = record(value)
    if (item === undefined) return
    if (++scanned > budget.maxNodes || depth > budget.maxDepth)
      throw new RangeError('M3 effect native reachability exceeds budget')
    if (item.desc.history.name === 'Reference' || item.desc.history.name === 'SmallReference') {
      const target = section(base, item)
      if (target !== null && !target.desc.history.primitive && !visited.has(target))
        pending.push(target)
      return
    }
    for (const field of Object.values(item.desc.fields)) visit(item[field.name], depth + 1)
  }
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || visited.has(current)) continue
    visited.add(current)
    for (const value of current.content) visit(value, 0)
  }
  return visited
}

/** Call only for a sidecar already admitted by the existing native hash/skeleton/resource
 * resolver. Exact anim-ID ownership and SD type are proved here; paths/names never match emitters. */
export async function decodeM3EffectSidecarBinding(
  baseBytes: Uint8Array,
  sidecarBytes: Uint8Array,
  logicalId: string,
  budget: M3EffectsBudget,
  signal?: AbortSignal,
  primitives: readonly M3EffectsPrimitive[] = [],
): Promise<M3EffectSidecarSource> {
  for (const value of [
    budget.maxInputBytes,
    budget.maxScalarBytes,
    budget.maxNodes,
    budget.maxDepth,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError('M3 effect binding budget must be positive')
  if (
    preflight(baseBytes, budget, signal) + preflight(sidecarBytes, budget, signal) >
    budget.maxNodes
  )
    throw new RangeError('M3 effect aggregate native records exceed budget')
  if (
    baseBytes.length + sidecarBytes.length >
    Math.min(budget.maxInputBytes, budget.maxScalarBytes)
  )
    throw new RangeError('M3 effect binding aggregate sources exceed budget')
  if (
    typeof logicalId !== 'string' ||
    logicalId.length === 0 ||
    logicalId.length * 2 > budget.maxScalarBytes
  )
    throw new TypeError('M3 effect sidecar requires a bounded source identity')
  let meshBytes = 0
  if (primitives.length > budget.maxNodes)
    throw new RangeError('M3 effect mesh count exceeds budget')
  for (const primitive of primitives) {
    signal?.throwIfAborted()
    if (
      !(primitive.positions instanceof Float32Array) ||
      !(primitive.indices instanceof Uint16Array || primitive.indices instanceof Uint32Array)
    )
      throw new TypeError('M3 effects require native REGN typed geometry')
    meshBytes += primitive.positions.byteLength + primitive.indices.byteLength
    if (meshBytes + baseBytes.length + sidecarBytes.length > budget.maxScalarBytes)
      throw new RangeError('M3 effect source meshes exceed aggregate budget')
  }
  const baseSnapshot = Uint8Array.from(baseBytes),
    sidecarSnapshot = Uint8Array.from(sidecarBytes)
  const ownedPrimitives = primitives.map(primitive => {
    signal?.throwIfAborted()
    return {
      ...primitive,
      positions: Float32Array.from(primitive.positions),
      indices:
        primitive.indices instanceof Uint16Array
          ? Uint16Array.from(primitive.indices)
          : Uint32Array.from(primitive.indices),
    }
  })
  const imported = await import('../../../src/m3/runtime/native-effect-binding.js'),
    native = imported as unknown as NativeBridge
  const base = (await imported.M3SectionList.load(
    baseSnapshot.buffer,
    imported.schemaText(),
  )) as Sections
  const sidecar = (await imported.M3SectionList.load(
    sidecarSnapshot.buffer,
    imported.schemaText(),
  )) as Sections
  signal?.throwIfAborted()
  if (base.model === null || sidecar.model === null)
    throw new TypeError('M3 effect binding requires model records')
  const baseIds = identities(base, budget, signal),
    sidecarIds = identities(sidecar, budget, signal)
  const targets = [...effectSections(base, budget, signal)].flatMap(
    item => baseIds.bySection.get(item) ?? [],
  )
  const nativeSequenceCount = section(sidecar, sidecar.model['sequences'])?.content.length ?? 0
  if (targets.length * nativeSequenceCount > budget.maxNodes)
    throw new RangeError('M3 effect animation lookup work exceeds node budget')
  const stcs = section(sidecar, sidecar.model['sequence_transformation_collections'])?.content ?? []
  const evaluator = new native.M3AnimationEvaluator(sidecar.model, sidecar)
  const proof: JsonObject[] = []
  for (const target of targets) {
    for (let sequenceIndex = 0; sequenceIndex < nativeSequenceCount; sequenceIndex++) {
      signal?.throwIfAborted()
      const resolved = evaluator.resolveAnimRef(sequenceIndex, target.id)
      if (resolved === null) continue
      if ((baseIds.references.get(target.id)?.length ?? 0) !== 1)
        throw new TypeError(`ambiguous M3 base effect animation id ${target.id}`)
      const declarations = sidecarIds.references.get(target.id) ?? []
      if (declarations.length > 1 || declarations.some(item => item.type !== target.type))
        throw new TypeError(`ambiguous or incompatible M3A effect declaration ${target.id}`)
      if (sdTypes[target.type] !== resolved.sdField)
        throw new TypeError(`incompatible M3A effect SD type for ${target.path}`)
      const stc = object(stcs[resolved.stcIndex]),
        ids = section(sidecar, stc['anim_ids'])?.content ?? []
      const refs = section(sidecar, stc['anim_refs'])?.content ?? []
      if (ids.length !== refs.length || ids.filter(id => id === target.id).length !== 1)
        throw new TypeError(`ambiguous M3A STC animation id ${target.id}`)
      const frames = section(sidecar, resolved.sd['frames'])?.content ?? []
      const keys = section(sidecar, resolved.sd['keys'])?.content ?? []
      if (frames.length === 0 || frames.length !== keys.length)
        throw new TypeError(`incomplete M3A effect SD keys for ${target.path}`)
      if (proof.length >= budget.maxNodes)
        throw new RangeError('M3A effect proof exceeds node budget')
      proof.push({
        proofKind: 'native-animation-resolution',
        animId: target.id,
        nativePath: target.path,
        nativeType: target.type,
        nativeSequenceIndex: sequenceIndex,
        stcIndex: resolved.stcIndex,
        sdField: resolved.sdField,
        sdIndex: resolved.sdIndex,
      })
    }
  }
  const model = Object.assign(
    Object.create(Object.getPrototypeOf(base.model)),
    base.model,
  ) as NativeRecord
  for (const field of animationTables) model[field] = sidecar.model[field]
  const resolver = {
    model,
    getSectionByReference(reference: unknown): Section | null {
      if (reference === null || reference === undefined) return null
      const value = object(reference)
      if (sidecarIds.owns.has(value)) return section(sidecar, value)
      if (baseIds.owns.has(value)) return section(base, value)
      throw new TypeError('M3 effect reference has no exact source identity')
    },
  }
  const projection = native.projectM3Effects(resolver, ownedPrimitives, budget, signal)
  return snapshotJson(
    { logicalId, projection, nativeSequenceCount, proof },
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxScalarBytes,
    },
    signal,
  ) as unknown as M3EffectSidecarSource
}
