/** Bounded SC2 Unit projection from the one resolved Data model, for the first Runtime slice.
 * The UV owner supplies the normative decimal→Q32.32 function in the composing process.
 * This projection is deliberately not a full catalog export: omitted fields are reported.
 */
import type { DataEntityRef, DataResolvedEntity, ResolvedDataWorkspaceSnapshot } from '@modkit/sdk/data'
import { resolveStarcraft2SchemaFields } from '../schema/full-data-schema.js'

const NAMESPACE = 'blizzard.sc2'
const I64_MIN = -(1n << 63n)
const I64_MAX = (1n << 63n) - 1n
const encoder = new TextEncoder()

function uvdName(nativeId: string): string {
  const bytes = encoder.encode(nativeId)
  if (bytes.length === 0 || bytes.length > 256) throw new RangeError('SC2 entity id exceeds UVD address budget')
  return `e-${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function fixed(value: unknown, lexeme: unknown, path: string, quantize: (decimal: string) => string): string {
  if ((typeof value !== 'number' || !Number.isFinite(value)) && typeof value !== 'string')
    throw new TypeError(`${path} is not a resolved decimal`)
  if (typeof lexeme !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(lexeme) ||
      Number(lexeme) !== Number(value))
    throw new TypeError(`${path} has no matching exact source decimal lexeme`)
  const quantum = quantize(lexeme)
  if (typeof quantum !== 'string' || !/^(0|-?[1-9]\d*)$/.test(quantum))
    throw new TypeError(`${path} returned a noncanonical Q32.32 quantum`)
  const integer = BigInt(quantum)
  if (integer < I64_MIN || integer > I64_MAX)
    throw new RangeError(`${path} exceeds signed i64 Q32.32`)
  return quantum
}

function weaponLinks(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('Unit.WeaponArray is not a resolved list')
  return value.map((item, index) => {
    const entry = item as { value?: { Link?: unknown } } | null
    const link = entry?.value?.Link
    if (typeof link !== 'string' || link.length === 0)
      throw new TypeError(`Unit.WeaponArray[${index}] has no resolved Link`)
    return link
  })
}

function requireCanonicalFields(typeId: string): void {
  const fields = new Map(resolveStarcraft2SchemaFields(typeId).map(field => [field.fieldId, field]))
  for (const name of ['LifeMax', 'LifeStart', 'Speed']) {
    const field = fields.get(name)
    if (field?.cardinality !== 'scalar' || field.valueKind !== 'number')
      throw new TypeError(`SC2 Data schema no longer declares ${typeId}.${name} as a scalar number`)
  }
  if (fields.get('WeaponArray')?.cardinality !== 'append')
    throw new TypeError(`SC2 Data schema no longer declares ${typeId}.WeaponArray as an append list`)
}

export interface Sc2UnitSliceResult {
  readonly kindSchema: unknown
  readonly definitions: Readonly<{
    uv: Readonly<{ format: 'UVD'; version: '1.0' }>
    namespace: string
    role: 'definitions'
    definitions: readonly Readonly<{
      kind: 'unit'; kindVersion: 1; name: string; fields: Readonly<Record<string, unknown>>
    }>[]
  }>
  readonly receipt: Readonly<{
    profile: 'sc2-unit-movement-v1'
    snapshotId: string
    sourceEntity: DataEntityRef
    sourceTypeId: string
    fieldSources: DataResolvedEntity['fieldSources']
    inheritanceChain: DataResolvedEntity['inheritanceChain']
    omittedNativeFields: readonly string[]
    quantization: 'SPEC_UV_FIXED_POINT/round-half-even/Q32.32'
    completeCatalogExport: false
  }>
}

/** Select one resolved CUnit-family record; dependency ordering and XML parsing stay in Data. */
export function lowerSc2UnitSlice(
  snapshot: ResolvedDataWorkspaceSnapshot,
  ref: DataEntityRef,
  quantizeFixed64Decimal: (decimal: string) => string,
): Sc2UnitSliceResult {
  if (snapshot.gameId !== 'blizzard/starcraft-2' || !snapshot.complete)
    throw new TypeError('Runtime unit lowering requires a complete SC2 resolved-data snapshot')
  if (ref.namespace !== 'Unit') throw new TypeError('Runtime unit lowering requires a Unit entity')
  const entity = snapshot.definitions.find(row => row.namespace === ref.namespace && row.entityId === ref.entityId)
  if (entity === undefined || !entity.complete) throw new TypeError(`Unit/${ref.entityId} is not completely resolved`)
  requireCanonicalFields(entity.typeId)
  const health = entity.fields['LifeMax']
  if (health === undefined) throw new TypeError(`Unit/${ref.entityId} has no resolved LifeMax`)
  for (const name of ['LifeMax', 'LifeStart', 'Speed', 'WeaponArray']) {
    if (entity.fields[name] !== undefined && entity.fieldSources?.[name] === undefined)
      throw new TypeError(`Unit/${ref.entityId}.${name} has no winning source provenance`)
  }
  const fields: Record<string, unknown> = {
    healthMax: fixed(health, entity.fieldLexemes?.['LifeMax'], 'Unit.LifeMax', quantizeFixed64Decimal),
  }
  if (entity.fields['LifeStart'] !== undefined)
    fields['healthStart'] = fixed(entity.fields['LifeStart'], entity.fieldLexemes?.['LifeStart'],
      'Unit.LifeStart', quantizeFixed64Decimal)
  if (entity.fields['Speed'] !== undefined)
    fields['movementSpeed'] = fixed(entity.fields['Speed'], entity.fieldLexemes?.['Speed'],
      'Unit.Speed', quantizeFixed64Decimal)
  if (entity.fields['WeaponArray'] !== undefined)
    fields['weaponLinks'] = weaponLinks(entity.fields['WeaponArray'])
  const kindSchema = {
    uv: { format: 'UVD', version: '1.0' }, namespace: NAMESPACE, role: 'kind-schema',
    kinds: [{ kind: 'unit', version: 1, fields: [
      { name: 'healthMax', type: 'fixed64', required: true, unit: 'sc2-life' },
      { name: 'healthStart', type: 'fixed64', unit: 'sc2-life' },
      { name: 'movementSpeed', type: 'fixed64', unit: 'sc2-map-units-per-second' },
      { name: 'weaponLinks', type: 'list', itemType: 'string', presentation: true },
    ] }],
  }
  const definitions: Sc2UnitSliceResult['definitions'] = {
    uv: { format: 'UVD', version: '1.0' }, namespace: NAMESPACE, role: 'definitions',
    definitions: [{ kind: 'unit', kindVersion: 1, name: uvdName(entity.entityId), fields }],
  }
  return {
    kindSchema,
    definitions,
    receipt: {
      profile: 'sc2-unit-movement-v1', snapshotId: snapshot.snapshotId,
      sourceEntity: { namespace: entity.namespace, entityId: entity.entityId },
      sourceTypeId: entity.typeId,
      fieldSources: entity.fieldSources,
      inheritanceChain: entity.inheritanceChain,
      omittedNativeFields: Object.keys(entity.fields).filter(name =>
        !['LifeMax', 'LifeStart', 'Speed', 'WeaponArray'].includes(name)).sort(),
      quantization: 'SPEC_UV_FIXED_POINT/round-half-even/Q32.32',
      completeCatalogExport: false,
    },
  }
}

/** One snapshot and one UVD kind schema for all requested Units. Field resolution stays above. */
export function lowerSc2UnitSlices(
  snapshot: ResolvedDataWorkspaceSnapshot,
  refs: readonly DataEntityRef[],
  quantizeFixed64Decimal: (decimal: string) => string,
): Readonly<{
  kindSchema: Sc2UnitSliceResult['kindSchema']
  definitions: Sc2UnitSliceResult['definitions']
  receipts: readonly Sc2UnitSliceResult['receipt'][]
}> {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 256
      || refs.some(ref => ref?.namespace !== 'Unit' || typeof ref.entityId !== 'string' || !ref.entityId))
    throw new TypeError('Runtime unit lowering requires 1..256 Unit references')
  const ordered = [...refs].sort((a, b) => a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0)
  if (ordered.some((ref, index) => index > 0 && ref.entityId === ordered[index - 1]!.entityId))
    throw new TypeError('Runtime unit lowering requires distinct Unit references')
  const slices = ordered.map(ref => lowerSc2UnitSlice(snapshot, ref, quantizeFixed64Decimal))
  return {
    kindSchema: slices[0]!.kindSchema,
    definitions: { ...slices[0]!.definitions,
      definitions: slices.flatMap(slice => slice.definitions.definitions) },
    receipts: slices.map(slice => slice.receipt),
  }
}
