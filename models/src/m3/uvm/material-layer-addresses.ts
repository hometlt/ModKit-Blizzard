// Models owns native material-layer addresses, original CMS ordinal mapping, and fresh-write
// loss refusal. These bounded carriers describe omitted projection; they do not restore REF_.
export const LAYER_FIELDS = [
  ['diffuse', 'layer_diff'], ['decal', 'layer_decal'], ['specular', 'layer_spec'],
  ['gloss', 'layer_gloss'], ['emissive1', 'layer_emis1'], ['emissive2', 'layer_emis2'],
  ['envi', 'layer_envi'], ['enviMask', 'layer_envi_mask'], ['alpha1', 'layer_alpha1'],
  ['alpha2', 'layer_alpha2'], ['normal', 'layer_norm'], ['height', 'layer_height'],
  ['lightMap', 'layer_light'], ['ao', 'layer_ao'], ['normalBlend1Mask', 'layer_norm_blend1_mask'],
  ['normalBlend2Mask', 'layer_norm_blend2_mask'], ['normalBlend1', 'layer_norm_blend1'],
  ['normalBlend2', 'layer_norm_blend2'],
] as const

interface NativeReference {
  readonly entries: number
  readonly index: number
}
interface NativeSection {
  readonly content: readonly unknown[]
}
interface NativeSections extends ReadonlyArray<NativeSection> {
  readonly model: Readonly<Record<string, unknown>> | null
  getSectionByReference(reference: NativeReference | null | undefined): NativeSection | null
}
type NativeRecord = Record<string, unknown>
/** Validate producer-owned projected-pass → original-CMS ordinals without classifying materials. */
export function nativeCompositePassIndices(metadata: unknown, count: number): readonly number[] {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new TypeError('M3 projected pass count is invalid')
  const value = nativeRecord(metadata) ? metadata['m3NativeCompositePassIndices'] : undefined
  if (value === undefined) return Array.from({ length: count }, (_, index) => index)
  if (!Array.isArray(value) || value.length !== count ||
      value.some((index, offset) => !Number.isSafeInteger(index) || index < 0 ||
        (offset > 0 && index <= value[offset - 1])))
    throw new TypeError('M3 original CMS pass mapping is invalid')
  return value as number[]
}

/** Refuse native output when projection omitted a material family; metadata is not a residual. */
export function assertM3MaterialWritable(metadata: unknown): void {
  if (nativeRecord(metadata) && metadata['m3UnsupportedMaterialFamilies'] !== undefined)
    throw new TypeError('fresh M3 refuses unsupported native material REF_; original-source preserving writer required')
}

export interface MaterialLayerAddress {
  readonly materialIndex: number
  readonly slot: string
  readonly passIndex?: number
}
interface MaterialLayerRecord {
  readonly record: NativeRecord
  readonly materialLayer: MaterialLayerAddress
}
interface TraversalOptions {
  readonly maxNodes?: number
  readonly signal?: AbortSignal
  readonly passIndices?: readonly (readonly number[] | undefined)[]
}
function nativeRecord(value: unknown): value is NativeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function nativeReference(value: unknown): value is NativeReference {
  return nativeRecord(value) && typeof value['entries'] === 'number' && typeof value['index'] === 'number'
}
export function materialLayerKey(address: MaterialLayerAddress): string {
  return `${address.materialIndex}/${address.passIndex ?? ''}/${address.slot}`
}

/** Follow native references rather than physical LAYR order, which changes with MAT_ versions. */
export function materialLayerRecords(sections: NativeSections, {
  maxNodes = sections.reduce((count, section) => count + section.content.length, 0) * LAYER_FIELDS.length,
  signal,
  passIndices,
}: TraversalOptions = {}): MaterialLayerRecord[] {
  const records = (reference: unknown): readonly unknown[] => nativeReference(reference)
    ? sections.getSectionByReference(reference)?.content ?? [] : []
  const matms = records(sections.model?.['material_references'])
  const standards = records(sections.model?.['materials_standard'])
  const displacements = records(sections.model?.['materials_displacement'])
  const composites = records(sections.model?.['materials_composite'])
  const result: MaterialLayerRecord[] = []
  let steps = 0
  const visit = (matmIndex: number, address: Omit<MaterialLayerAddress, 'slot'>, visiting: ReadonlySet<number>): void => {
    signal?.throwIfAborted()
    if (++steps > maxNodes) throw new RangeError('M3 material layer traversal exceeds node budget')
    if (visiting.has(matmIndex)) throw new TypeError('M3 composite material reference cycle')
    const matm = matms[matmIndex]
    if (!nativeRecord(matm)) return
    const type = matm['type'], materialIndex = matm['material_index']
    if (typeof materialIndex !== 'number') return
    if (type === 3) {
      // The common composite projection contains surface passes, never nested composites.
      if (address.passIndex !== undefined) return
      const next = new Set(visiting).add(matmIndex)
      const composite = composites[materialIndex]
      const passes = records(nativeRecord(composite) ? composite['sections'] : undefined)
      const originalIndices = nativeCompositePassIndices(
        passIndices?.[address.materialIndex] === undefined ? undefined
          : { m3NativeCompositePassIndices: passIndices[address.materialIndex] }, passes.length)
      for (const [projectedIndex, pass] of passes.entries()) {
        const passIndex = originalIndices[projectedIndex]!
        const referenceIndex = nativeRecord(pass) ? pass['material_reference_index'] : undefined
        if (typeof referenceIndex === 'number') visit(referenceIndex, { ...address, passIndex }, next)
      }
      return
    }
    const source = type === 1 ? standards[materialIndex]
      : type === 2 ? displacements[materialIndex] : undefined
    if (!nativeRecord(source) || (address.passIndex !== undefined && type !== 1)) return
    const fields = type === 1 ? LAYER_FIELDS : [['normal', 'layer_norm'], ['height', 'layer_strength']] as const
    for (const [slot, field] of fields) {
      signal?.throwIfAborted()
      const record = records(source[field])[0]
      if (nativeRecord(record)) {
        if (result.length >= maxNodes) throw new RangeError('M3 material layer addresses exceed node budget')
        result.push({ record, materialLayer: { ...address, slot } })
      }
    }
  }
  for (let materialIndex = 0; materialIndex < matms.length; materialIndex++)
    visit(materialIndex, { materialIndex }, new Set())
  return result
}
