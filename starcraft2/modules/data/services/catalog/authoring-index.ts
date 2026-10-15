/**
 * The compact SC2 authoring index (`ResolvedDataAuthoringIndex`) built from catalog-engine, the one
 * Data resolver (owner decision 26.09, S3): values are the resolved snapshot's, typed the same way;
 * which declaration and which entity wrote each field and each leaf of it is the engine's
 * provenance. A row carries the fields an entity writes itself and those its catalog's structure
 * defaults complete; inherited values stay on the ancestor's row.
 * Leaf origins are omitted only when every leaf has the field's winning source/entity. Mixed
 * origins retain every leaf in canonical path order. Bounds preserve identities and explicitly
 * report incomplete values; this portable projection does not read or mutate native documents.
 * Source-table identities include declaration spans, so two declarations in one XML retain
 * their separate locations for entity, field, leaf and removal provenance.
 * Version 2 stores each document identity once and uses compact complete span tuples. Empty
 * field/removal arrays are omitted; all values and mixed leaf provenance remain unchanged.
 */
import {
  RESOLVED_DATA_AUTHORING_INDEX_KIND,
  type DataAuthoringFieldDelta,
  type DataAuthoringIndexEntity,
  type DataAuthoringUnsetTombstone,
  type DataAuthoringValueOrigin,
  type DataAuthoringSourceLocation,
  type DataCatalogDiagnostic,
  type DataEntitySource,
  type DataEntityToken,
  type DataSchemaField,
  type DataTypeSchema,
  type ResolvedDataAuthoringIndex,
} from '@modkit/sdk/data'
import type { JsonValue } from '@modkit/sdk'

export interface AuthoringOrigin {
  readonly source: DataEntitySource
  readonly originEntityId: string
}

export interface AuthoringIndexEntityInput {
  readonly namespace: string
  readonly typeId: string
  readonly entityId: string
  readonly parentEntityId?: string
  readonly defaultTemplate?: boolean
  readonly tokens?: readonly DataEntityToken[]
  /** The entity's winning (last) declaration. */
  readonly source: DataEntitySource
  readonly complete: boolean
  /** Resolved values, typed as in the snapshot. */
  readonly fields: Readonly<Record<string, JsonValue>>
  readonly rowFields: ReadonlySet<string>
  /** Behind a field without provenance (a structure default completes it). */
  readonly fallback: AuthoringOrigin
  fieldOrigin(fieldId: string): AuthoringOrigin | undefined
  leafOrigin(fieldId: string, path: readonly string[]): AuthoringOrigin | undefined
  readonly tombstones: readonly { readonly path: readonly string[]; readonly source: DataEntitySource }[]
}

export interface AuthoringIndexInput {
  readonly workspaceId: string
  readonly gameId: string
  readonly analyzerId: string
  readonly snapshotId: string
  readonly schemas: readonly DataTypeSchema[]
  readonly entities: readonly AuthoringIndexEntityInput[]
  readonly patchCount: number
  readonly diagnostics: readonly DataCatalogDiagnostic[]
  readonly ownerMetadata?: JsonValue
  readonly complete: boolean
  readonly maxOutputBytes: number
}

/** Distinguish structured field records from arrays and scalar catalog values. */
const recordOf = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined

/** Freeze a detached value tree so consumers cannot mutate the resolver's authoring projection. */
function immutable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable))
  const record = recordOf(value)
  if (record === undefined) return value
  return Object.freeze(Object.fromEntries(Object.entries(record).map(([key, item]) => [key, immutable(item)])))
}

/** Every leaf path of a structured value, below `path`. */
function visitStructured(
  value: JsonValue,
  nested: readonly DataSchemaField[] | undefined,
  path: readonly string[],
  visit: (path: readonly string[]) => void,
  ignored: ReadonlySet<string> = new Set(),
): void {
  const record = recordOf(value)
  if (record !== undefined) {
    const fields = new Map((nested ?? []).map(field => [field.fieldId, field]))
    let visited = false
    for (const [key, child] of Object.entries(record)) {
      if (ignored.has(key)) continue
      visited = true
      const field = fields.get(key)
      if (field === undefined) visitStructured(child, undefined, [...path, key], visit)
      else visitField(child, field, [...path, key], visit)
    }
    if (!visited) visit(path)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) visit(path)
    else value.forEach((item, index) => visitStructured(item, nested, [...path, String(index)], visit))
    return
  }
  visit(path)
}

/** Leaf paths of one schema field's value: keyed slots by key, appended items by position. */
function visitField(value: JsonValue, field: DataSchemaField, path: readonly string[], visit: (path: readonly string[]) => void): void {
  if (field.cardinality === 'indexed') {
    const indexKey = field.indexKey ?? 'index'
    let visited = false
    for (const item of Array.isArray(value) ? value : [value]) {
      const record = recordOf(item)
      const selector = record?.[indexKey]
      if (record === undefined || (typeof selector !== 'string' && typeof selector !== 'number') || record['removed'] !== undefined) continue
      visited = true
      const wrapped = record['value']
      visitStructured(wrapped === undefined ? item : wrapped, field.fields, [...path, String(selector)], visit,
        wrapped === undefined ? new Set([indexKey, 'removed']) : new Set())
    }
    if (!visited) visit(path)
    return
  }
  if (field.cardinality === 'append') {
    const values = Array.isArray(value) ? value : [value]
    if (values.length === 0) visit(path)
    else values.forEach((item, index) => visitStructured(item, field.fields, [...path, String(index)], visit))
    return
  }
  visitStructured(value, field.fields, path, visit)
}

/** Resolve inherited field schemas once per type, stopping cycles at the current traversal. */
function schemaFields(schemas: readonly DataTypeSchema[]): (typeId: string) => ReadonlyMap<string, DataSchemaField> {
  const byType = new Map(schemas.map(schema => [schema.typeId, schema]))
  const cache = new Map<string, ReadonlyMap<string, DataSchemaField>>()
  /** Include inherited fields once while retaining the child's override of a field schema. */
  const resolve = (typeId: string, visiting: ReadonlySet<string>): ReadonlyMap<string, DataSchemaField> => {
    const cached = cache.get(typeId)
    if (cached !== undefined) return cached
    const schema = byType.get(typeId)
    const fields = new Map<string, DataSchemaField>()
    if (schema?.parentTypeId !== undefined && !visiting.has(schema.parentTypeId)) {
      for (const [id, field] of resolve(schema.parentTypeId, new Set([...visiting, typeId]))) fields.set(id, field)
    }
    for (const field of schema?.fields ?? []) fields.set(field.fieldId, field)
    cache.set(typeId, fields)
    return fields
  }
  return typeId => resolve(typeId, new Set())
}

/** Bound diagnostic text while preserving exact counts for the complete resolver result. */
function diagnosticSummary(diagnostics: readonly DataCatalogDiagnostic[]): ResolvedDataAuthoringIndex['diagnostics'] {
  const counts = { error: 0, warning: 0, information: 0 }
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1
  const items = diagnostics.slice(0, 64).map(diagnostic => Object.freeze({
    severity: diagnostic.severity,
    code: diagnostic.code.slice(0, 256),
    message: diagnostic.message.replaceAll(String.fromCharCode(0), '').slice(0, 2_048),
  }))
  return Object.freeze({
    errorCount: counts.error,
    warningCount: counts.warning,
    informationCount: counts.information,
    items: Object.freeze(items),
    truncated: diagnostics.length > items.length,
  })
}

/** Project resolved catalog rows with exact values/provenance and explicit transfer completeness. */
export function buildStarcraft2AuthoringIndex(input: AuthoringIndexInput): ResolvedDataAuthoringIndex {
  const fieldsOf = schemaFields(input.schemas)
  const documents: Omit<DataEntitySource, 'range'>[] = []
  const documentIndexes = new Map<string, number>()
  const sources: DataAuthoringSourceLocation[] = []
  const sourceIndexes = new Map<string, number>()
  /** Intern complete declaration identities without changing first-visit order or winning locations. */
  const sourceIndex = (source: DataEntitySource): number => {
    const range = source.range
    const span = range === undefined ? ''
      : [range.byteOffset, range.byteLength, range.utf16Offset, range.utf16Length, range.line, range.column].join(String.fromCharCode(0))
    const documentKey = [source.rootId, source.path, source.documentIndex, String(source.revision ?? '')].join(String.fromCharCode(0))
    const key = [documentKey, span].join(String.fromCharCode(0))
    const known = sourceIndexes.get(key)
    if (known !== undefined) return known
    let document = documentIndexes.get(documentKey)
    if (document === undefined) {
      document = documents.length
      documentIndexes.set(documentKey, document)
      const { range: _range, ...identity } = source
      documents.push(Object.freeze(identity))
    }
    sourceIndexes.set(key, sources.length)
    sources.push(Object.freeze(range === undefined
      ? [document] as const
      : range.byteOffset !== undefined
        ? [document, Object.freeze({ ...range })] as const
        : [document, range.utf16Offset, range.utf16Length, range.line, range.column] as const))
    return sources.length - 1
  }

  const rows = [...input.entities]
    .sort((left, right) => left.namespace.localeCompare(right.namespace) || left.entityId.localeCompare(right.entityId))
    .map((entity): DataAuthoringIndexEntity => {
      const typeFields = fieldsOf(entity.typeId)
      const fields = [...entity.rowFields]
        .filter(fieldId => entity.fields[fieldId] !== undefined)
        .sort((left, right) => left.localeCompare(right))
        .map((fieldId): DataAuthoringFieldDelta => {
          const value = entity.fields[fieldId]!
          const field = entity.fieldOrigin(fieldId) ?? entity.fallback
          const fieldSource = sourceIndex(field.source)
          const origins: DataAuthoringValueOrigin[] = []
          const visit = (path: readonly string[]): void => {
            const origin = entity.leafOrigin(fieldId, path) ?? field
            origins.push(Object.freeze({ path: Object.freeze([...path]), source: sourceIndex(origin.source), originEntityId: origin.originEntityId }))
          }
          const schema = typeFields.get(fieldId)
          if (schema === undefined) visitStructured(value, undefined, [], visit)
          else visitField(value, schema, [], visit)
          const uniform = origins.every(origin => origin.source === fieldSource && origin.originEntityId === field.originEntityId)
          // Uniform origins are omitted; sorting them would only allocate strings that never leave this owner.
          if (!uniform) origins.sort((left, right) => JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)))
          return Object.freeze({
            fieldId,
            value: immutable(value),
            source: fieldSource,
            originEntityId: field.originEntityId,
            ...(uniform
              ? {}
              : { origins: Object.freeze(origins) }),
          })
        })
      const tombstones: DataAuthoringUnsetTombstone[] = entity.tombstones
        .filter(tombstone => typeFields.has(tombstone.path[0] ?? ''))
        .map(tombstone => Object.freeze({ path: Object.freeze([...tombstone.path]), source: sourceIndex(tombstone.source) }))
      const tokens = [...(entity.tokens ?? [])].sort((left, right) => left.id.localeCompare(right.id))
      return Object.freeze({
        identity: `${entity.namespace}${String.fromCharCode(0)}${entity.entityId}`,
        namespace: entity.namespace,
        typeId: entity.typeId,
        entityId: entity.entityId,
        ...(entity.parentEntityId === undefined ? {} : { parentEntityId: entity.parentEntityId }),
        ...(entity.defaultTemplate === true ? { defaultTemplate: true } : {}),
        ...(tokens.length === 0 ? {} : { tokens: Object.freeze(tokens.map(token => Object.freeze({ ...token }))) }),
        source: sourceIndex(entity.source),
        complete: entity.complete,
        ...(fields.length === 0 ? {} : { fields: Object.freeze(fields) }),
        ...(tombstones.length === 0 ? {} : { tombstones: Object.freeze(tombstones) }),
      })
    })

  const namespaceCounts = new Map<string, number>()
  for (const entity of input.entities) namespaceCounts.set(entity.namespace, (namespaceCounts.get(entity.namespace) ?? 0) + 1)
  const namespaces = Object.freeze([...namespaceCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([namespace, entityCount]) => Object.freeze({ namespace, entityCount })))
  const complete = input.complete &&
    input.diagnostics.every(diagnostic => diagnostic.severity !== 'error') &&
    rows.every(row => row.complete)
  const index = (entities: readonly DataAuthoringIndexEntity[], diagnostics: readonly DataCatalogDiagnostic[], valuesComplete: boolean): ResolvedDataAuthoringIndex =>
    Object.freeze({
      schemaVersion: 2,
      kind: RESOLVED_DATA_AUTHORING_INDEX_KIND,
      workspaceId: input.workspaceId,
      gameId: input.gameId,
      analyzerId: input.analyzerId,
      snapshotId: input.snapshotId,
      sourceTable: Object.freeze(sources),
      sourceDocuments: Object.freeze(documents),
      namespaces,
      entityCount: entities.length,
      patchCount: input.patchCount,
      entities: Object.freeze(entities),
      diagnostics: diagnosticSummary(diagnostics),
      ...(input.ownerMetadata === undefined ? {} : { ownerMetadata: immutable(input.ownerMetadata) }),
      complete,
      valuesComplete,
    })
  const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
  const valued = index(rows, input.diagnostics, true)
  const requiredBytes = bytes(valued)
  if (requiredBytes <= input.maxOutputBytes) return valued

  // Past the budget, every identity and winning source stays; the values go.
  const identities = rows.map(({ fields: _fields, tombstones: _tombstones, ...identity }) => Object.freeze(identity))
  const identityOnly = index(identities, [...input.diagnostics, {
    severity: 'warning',
    code: 'common.data/authoring-index-values-truncated',
    message: `authoring values need ${requiredBytes} bytes, exceeding the ${input.maxOutputBytes} byte output budget; identity and source rows remain complete`,
  }], false)
  if (bytes(identityOnly) > input.maxOutputBytes) {
    throw new TypeError(`authoring identity index exceeds maxOutputBytes ${input.maxOutputBytes}`)
  }
  return identityOnly
}
