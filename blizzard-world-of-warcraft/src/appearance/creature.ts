/**
 * CreatureDisplayInfo → CreatureModelData → M2/replaceable textures (GAME-WOW).
 * Consumes typed rows from the one WDC5/DBD reader, under the same selected installation context.
 * No table-position guesses, default display selection, CASC access or rendering occurs here.
 * Slots 11/12/13 are the three native creature texture variations. Geoset/particle/NPC composite
 * references are reported as unresolved semantics until their native table profiles are admitted.
 * This native resolver is not yet registered as a public product operation.
 */
import type { WdcRow, WdcRows, WdcValue } from '../db2/rows.js'

export interface WowDataContext {
  readonly sourceId: string
  readonly product: string
  readonly build: string
  readonly buildRevision: string
  readonly locale: number
}
export interface WowTypedTable {
  readonly table: string
  readonly context: WowDataContext
  readonly revision: string
  readonly layoutHash: number
  readonly decoded: WdcRows
}
export interface WowAppearanceValue {
  readonly table: string
  readonly rowId: number
  readonly field: string
  readonly value: WdcValue
  readonly revision: string
  readonly layoutHash: number
}
export interface WowCreatureAppearance {
  readonly context: WowDataContext
  readonly displayId: number
  readonly modelId: number
  readonly modelFileDataId: number
  readonly displayScale: number
  readonly modelScale: number
  readonly replaceableTextures: ReadonlyMap<number, string>
  readonly provenance: readonly WowAppearanceValue[]
  readonly unresolved: readonly { readonly field: string; readonly value: number; readonly reason: string }[]
}

/** Native lookup failures retain their origin and cannot masquerade as a selected default. */
export class WowAppearanceError extends TypeError {
  constructor(readonly reason: 'context-mismatch' | 'missing-row' | 'encrypted-row' | 'schema-field' | 'invalid-value',
    readonly sourcePath: string, message: string) { super(message); this.name = 'WowAppearanceError' }
}

/** A selected context is authoritative for both ends of every appearance foreign key. */
function sameContext(expected: WowDataContext, actual: WowDataContext): boolean {
  return expected.sourceId === actual.sourceId && expected.product === actual.product && expected.build === actual.build &&
    expected.buildRevision === actual.buildRevision && expected.locale === actual.locale
}
function uint(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new WowAppearanceError('invalid-value', path, 'Expected an unsigned native identifier')
  return value
}
/** Resolve a row or distinguish an unavailable encrypted section from a missing identifier. */
function row(table: WowTypedTable, id: number): WdcRow {
  const value = table.decoded.rows.get(id)
  if (value !== undefined) return value
  const encrypted = table.decoded.unavailable.some(section => section.ids.includes(id))
  throw new WowAppearanceError(encrypted ? 'encrypted-row' : 'missing-row', `${table.table}#${String(id)}`,
    `${table.table} row ${String(id)} is ${encrypted ? 'encrypted' : 'missing'}`)
}

/** Select one explicit display ID, with provenance for every effective model/texture/scale value. */
export function resolveCreatureAppearance(context: WowDataContext, displayId: number,
  displayTable: WowTypedTable, modelTable: WowTypedTable): WowCreatureAppearance {
  uint(displayId, 'CreatureDisplayInfo.ID')
  if (displayTable.table !== 'CreatureDisplayInfo' || modelTable.table !== 'CreatureModelData' ||
    !sameContext(context, displayTable.context) || !sameContext(context, modelTable.context))
    throw new WowAppearanceError('context-mismatch', 'CreatureDisplayInfo/CreatureModelData', 'Appearance tables belong to another selected context or table')
  const provenance: WowAppearanceValue[] = []
  const read = (table: WowTypedTable, selected: WdcRow, field: string): WdcValue => {
    const value = selected.values[field]
    if (value === undefined) throw new WowAppearanceError('schema-field', `${table.table}#${String(selected.id)}/${field}`, 'Selected schema has no required appearance field')
    provenance.push({ table: table.table, rowId: selected.id, field, value, revision: table.revision, layoutHash: table.layoutHash })
    return value
  }
  const display = row(displayTable, displayId)
  const modelId = uint(read(displayTable, display, 'ModelID'), 'CreatureDisplayInfo.ModelID')
  const model = row(modelTable, modelId)
  const modelFileDataId = uint(read(modelTable, model, 'FileDataID'), 'CreatureModelData.FileDataID')
  if (modelFileDataId === 0) throw new WowAppearanceError('invalid-value', 'CreatureModelData.FileDataID', 'Selected creature has no model resource')
  const scales = [read(displayTable, display, 'CreatureModelScale'), read(modelTable, model, 'ModelScale')]
  if (scales.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
    throw new WowAppearanceError('invalid-value', 'CreatureModelScale/ModelScale', 'Creature scales must be positive and finite')
  const ids = read(displayTable, display, 'TextureVariationFileDataID')
  if (!Array.isArray(ids) || ids.length !== 3)
    throw new WowAppearanceError('schema-field', 'CreatureDisplayInfo.TextureVariationFileDataID', 'Creature texture profile requires exactly three native variations')
  const replaceableTextures = new Map<number, string>()
  ids.forEach((value, index) => {
    const id = uint(value, `TextureVariationFileDataID[${String(index)}]`)
    if (id !== 0) replaceableTextures.set(11 + index, `filedataid/${String(id)}`)
  })
  const unresolved: { field: string; value: number; reason: string }[] = []
  for (const [table, selected, field, reason] of [
    [displayTable, display, 'CreatureGeosetData', 'native-geoset-selection-profile'],
    [displayTable, display, 'ParticleColorID', 'particle-colour-table'],
    [displayTable, display, 'ExtendedDisplayInfoID', 'npc-composite-appearance'],
    [modelTable, model, 'CreatureGeosetDataID', 'native-geoset-table'],
  ] as const) {
    if (selected.values[field] === undefined) continue
    const value = uint(read(table, selected, field), `${table.table}.${field}`)
    if (value !== 0) unresolved.push({ field: `${table.table}.${field}`, value, reason })
  }
  // Preserve both native scale fields; their client composition must be qualified before UVM use.
  return { context, displayId, modelId, modelFileDataId, displayScale: scales[0] as number,
    modelScale: scales[1] as number, replaceableTextures, provenance, unresolved }
}
