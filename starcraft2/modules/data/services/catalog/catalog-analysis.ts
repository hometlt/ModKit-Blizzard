/**
 * The SC2 catalog analysis core, owned by the resolved-data provider and shared with the Data
 * session of a loaded mod (owner decision 07.10: one holder of a mod's data).
 *
 * - Which documents the game loads and in what order (`loadedCatalogDocuments`): the standard
 *   catalogs, then each root's catalogs in the order its `GameData.xml` declares; EditorCategories.
 * - The typed declaration parse of one GameData document (`parseCatalogDocument`): entity patches
 *   typed through the canonical schema (attribute fields, positional and indexed slots, flags spelled
 *   as indexed entries, nested structures), inferred schema extensions for unverified types and
 *   fields, root-level structure defaults, duplicate-id errors, synthetic `@default:` identities of
 *   anonymous declarations; DTDs and custom entities are refused.
 *   Declaration/schema facts are eager; own typed fields and numeric lexemes are memoized on access.
 *   The cache projection (`storeCatalogDocument`/`restoreCatalogDocument`) preserves checked facts
 *   and native elements without materializing own values during structured-clone serialization.
 * - The ordered parse of a whole document list (`parseCatalogDocuments`) with the provider's
 *   document-invalid diagnostics, merged schema extensions and structure defaults.
 * - The effective schemas (`effectiveSchemas`): canonical resolution schemas extended by what the
 *   documents declared.
 * - Resolution through catalog-engine, the one SC2 Data resolver (`resolveThroughEngine`): each
 *   entity resolved and typed on demand, with its chain, sources, field and leaf provenance and the
 *   rows of the authoring index; `entities()` walks every entity in declaration order, as the full
 *   analysis needs, and keeps the diagnostics of missing parents in that order.
 *
 * Bounds: maxEntities and maxDepth come from the caller's request; cancellation is checked per
 * document and per declaration. This module reads no files, archives or installations.
 */
import type { JsonValue } from '@modkit/sdk'
import type { DataCatalogDiagnostic, DataEntitySource, DataTypeSchema } from '@modkit/sdk/data'
import { parseCatalogXmlElements } from '../../shared/catalog-engine/xml/index.js'
import { gameDataIncludePaths } from '../../shared/catalog-engine/gamedata-order.js'
import {
  createEngineCatalog,
  type EngineCatalog,
  type EngineCatalogDocument,
  type EngineProvenance,
  type EngineResolvedEntity,
  type EngineSource,
} from './engine-resolution.js'
import type { AuthoringIndexEntityInput, AuthoringOrigin } from './authoring-index.js'
import {
  resolveStarcraft2SchemaFields,
  resolveStarcraft2StructureFields,
  starcraft2NamespaceForType,
  starcraft2ResolutionField,
  STARCRAFT2_CATALOG_FILES,
  STARCRAFT2_DATA_SCHEMAS,
  STARCRAFT2_SCHEMA_BY_TYPE,
} from '../schema/full-data-schema.js'
import {
  isStarcraft2StructureDefaultTag,
  mergeStructureDefault,
  starcraft2StructureDefaultNamespace,
} from './struct-defaults.js'
import {
  EMPTY_EDITOR_CATEGORIES,
  mergeEditorCategories,
  parseEditorCategories,
} from '../../shared/catalog-engine/sc2-editor-core/editor-categories-runtime.js'

/** A schema field in its resolution shape, with the canonical schema's extra facts. */
export interface CatalogFieldShape {
  readonly fieldId: string
  readonly cardinality: 'scalar' | 'append' | 'indexed'
  readonly indexKey?: string
  readonly fields?: readonly CatalogFieldShape[]
  readonly valueKind?: string
  readonly positional?: boolean
  readonly unverified?: boolean
  readonly [fact: string]: unknown
}

/** A catalog XML element as the parser gives it, or as an attribute field spelled as one. */
export interface CatalogElement {
  readonly type?: string
  readonly name: string
  readonly attributes?: Readonly<Record<string, unknown>>
  readonly children?: readonly CatalogElement[]
  readonly text?: string
  readonly tokens?: readonly { readonly id: string; readonly type?: string; readonly value?: string }[]
}

/** One document of a catalog request. */
export interface CatalogDocument {
  readonly rootId: string
  readonly path: string
  readonly text: string
  readonly revision?: string
}

/** One typed declaration of a catalog document, in document order. */
export interface CatalogPatch {
  readonly namespace: string
  readonly typeId: string
  readonly entityId: string
  readonly parentEntityId?: string
  readonly fields: Readonly<Record<string, JsonValue>>
  readonly fieldLexemes: Readonly<Record<string, string>>
  readonly source: DataEntitySource
  readonly defaultTemplate?: true
  readonly tokens?: readonly { readonly id: string; readonly type?: string; readonly value?: string }[]
  readonly synthetic?: true
}

/** A structure default one document declares at its root. */
export interface CatalogStructureDefault {
  readonly namespace: string
  readonly structureType: string
  readonly value: unknown
  readonly source: DataEntitySource
}

type SchemaExtensions = Map<string, Map<string, CatalogFieldShape>>

/** What one document's typed parse produced. */
export interface ParsedCatalogDocument {
  readonly elements: readonly CatalogElement[]
  readonly patches: readonly CatalogPatch[]
  readonly structureDefaults: readonly CatalogStructureDefault[]
  readonly schemaExtensions: SchemaExtensions
  readonly unverifiedTypes: ReadonlySet<string>
  readonly unverifiedFields: ReadonlySet<string>
  readonly unsupportedElements: ReadonlySet<string>
  readonly anonymousEntities: number
  readonly diagnostics: readonly DataCatalogDiagnostic[]
}

const CATALOG_FILES: readonly string[] = STARCRAFT2_CATALOG_FILES
/** Where a root keeps its EditorCategories. */
export const EDITOR_CATEGORIES_PATH = 'base.sc2data/editordata/editorcategories.xml'
/** The standard catalog file names, which every root loads without declaring them. */
export const KNOWN_CATALOG_FILES: ReadonlySet<string> = new Set(CATALOG_FILES)
/** Where a root declares its own catalogs. */
export const GAMEDATA_INCLUDES_PATH = 'base.sc2data/gamedata.xml'
/** Canonical schemas in their resolution shape (positional lists as indexed slots). */
const RESOLUTION_SCHEMAS: readonly DataTypeSchema[] = Object.freeze(
  (STARCRAFT2_DATA_SCHEMAS as readonly DataTypeSchema[]).map(schema =>
    Object.freeze({ ...schema, fields: Object.freeze(schema.fields.map(starcraft2ResolutionField)) }),
  ),
)
const SCHEMA_BY_TYPE = STARCRAFT2_SCHEMA_BY_TYPE as ReadonlyMap<string, DataTypeSchema>

/** The EditorCategories document of a root. */
export function isEditorCategoriesDocument(document: { readonly path: string }): boolean {
  return document.path.replaceAll('\\', '/').toLowerCase().endsWith(EDITOR_CATEGORIES_PATH)
}

/** EditorCategories as the bounded owner metadata of a snapshot or index. */
export function editorCategoriesMetadata(data: {
  readonly categories: ReadonlyMap<string, Iterable<string>>
  readonly objectUsage: ReadonlyMap<string, { readonly objects: readonly object[]; readonly fields: readonly object[] }>
}): JsonValue | undefined {
  if (data.categories.size === 0 && data.objectUsage.size === 0) return undefined
  const categories = Object.freeze(
    Object.fromEntries(
      [...data.categories.entries()].map(([name, values]) => [name, Object.freeze([...values])]),
    ),
  )
  const objectUsage = Object.freeze(
    Object.fromEntries(
      [...data.objectUsage.entries()].map(([namespace, usage]) => [
        namespace,
        Object.freeze({
          objects: Object.freeze(usage.objects.map(item => Object.freeze({ ...item }))),
          fields: Object.freeze(usage.fields.map(item => Object.freeze({ ...item }))),
        }),
      ]),
    ),
  )
  return Object.freeze({
    starcraft2: Object.freeze({
      editorCategories: Object.freeze({ categories, objectUsage }),
    }),
  }) as unknown as JsonValue
}

/** A root's `GameData.xml`. */
export function isGameDataIncludesDocument(document: { readonly path: string }): boolean {
  const path = document.path.replaceAll('\\', '/').toLowerCase()
  return path === GAMEDATA_INCLUDES_PATH || path.endsWith(`/${GAMEDATA_INCLUDES_PATH}`)
}

/**
 * The catalog documents the game loads, in its order: the standard catalogs as planned, then each
 * root's declared catalogs in the order its `GameData.xml` declares them. A candidate the root does
 * not declare is dropped, as the loader's chain Data (`chain-data.ts`) drops it. A root whose
 * `GameData.xml` is not among the documents keeps its documents as given.
 * ponytail: a root without GameData.xml keeps undeclared flat catalogs, as `SC2ModReader` does; the
 * stock ones (ActorSupportData.xml, ErrorData.xml) are empty `<Catalog/>`.
 */
export function loadedCatalogDocuments<Document extends CatalogDocument>(
  documents: readonly Document[],
): { readonly document: Document; readonly documentIndex: number; readonly order: readonly number[] }[] {
  const declared = new Map<string, string[]>()
  for (const document of documents) {
    if (!isGameDataIncludesDocument(document)) continue
    declared.set(document.rootId, gameDataIncludePaths(document.text).map(path => `base.sc2data/${path}`.toLowerCase()))
  }
  const firstOfRoot = new Map<string, number>()
  const kept: { readonly document: Document; readonly documentIndex: number; readonly order: readonly number[] }[] = []
  documents.forEach((document, documentIndex) => {
    if (!firstOfRoot.has(document.rootId)) firstOfRoot.set(document.rootId, documentIndex)
    if (isGameDataIncludesDocument(document)) return
    const path = document.path.replaceAll('\\', '/').toLowerCase()
    const flat = /\/base\.sc2data\/gamedata\/([^/]+)$/u.exec(`/${path}`)?.[1]
    const includes = declared.get(document.rootId)
    if (includes === undefined || isEditorCategoriesDocument(document) || !path.includes('base.sc2data/gamedata/') ||
        (flat !== undefined && KNOWN_CATALOG_FILES.has(flat))) {
      kept.push({ document, documentIndex, order: [firstOfRoot.get(document.rootId)!, 0, documentIndex] })
      return
    }
    const position = includes.findIndex(key => path === key || path.endsWith(`/${key}`))
    if (position !== -1) kept.push({ document, documentIndex, order: [firstOfRoot.get(document.rootId)!, 1, position] })
  })
  return kept.sort((left, right) =>
    left.order[0]! - right.order[0]! || left.order[1]! - right.order[1]! || left.order[2]! - right.order[2]!)
}

function elementChildren(node: CatalogElement): readonly CatalogElement[] {
  return node.children ?? []
}

function entityTokens(element: CatalogElement) {
  return Object.freeze(
    (element.tokens ?? []).filter(token => token.id.length > 0).map(token => Object.freeze({ ...token })),
  )
}

const ENTITY_METADATA_ATTRIBUTES = new Set(['id', 'parent', 'default'])

function entityFieldElements(element: CatalogElement): CatalogElement[] {
  const attributeFields = Object.entries(element.attributes ?? {})
    .filter(([name]) => !ENTITY_METADATA_ATTRIBUTES.has(name))
    .map(([name, value]): CatalogElement => ({
      type: 'element',
      name,
      attributes: { value: String(value) },
      children: [],
    }))
  return [...attributeFields, ...elementChildren(element)]
}

/**
 * Slot of a repeated field element. Positional lists follow the SC2 running index: a bare element
 * takes the next slot and an explicit numeric `index="N"` resets the counter to N + 1. Other
 * repeated fields keep their plain occurrence count.
 */
function nextOccurrence(counters: Map<string, number>, child: CatalogElement, field: CatalogFieldShape): number {
  const current = counters.get(child.name) ?? 0
  const explicit = child.attributes?.[field.indexKey ?? 'index']
  const slot =
    field.positional === true && explicit !== undefined && /^\d+$/u.test(String(explicit))
      ? Number(explicit)
      : current
  counters.set(child.name, slot + 1)
  return slot
}

function attributeValue(value: string): string | number {
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return value
}

// A field shape's nested shapes by id, once per shape: a value is parsed millions of times per chain.
const nestedShapes = new WeakMap<object, Map<string, CatalogFieldShape>>()
function nestedShapesOf(field: { readonly fields?: readonly CatalogFieldShape[] }): Map<string, CatalogFieldShape> {
  let nested = nestedShapes.get(field)
  if (nested === undefined) {
    nested = new Map((field.fields ?? []).map(item => [item.fieldId, item]))
    nestedShapes.set(field, nested)
  }
  return nested
}

function structuredValue(
  element: CatalogElement,
  field: { readonly fields?: readonly CatalogFieldShape[]; readonly indexKey?: string },
  depth: number,
  maxDepth: number,
): unknown {
  if (depth > maxDepth) throw new RangeError(`catalog XML exceeds nested field depth ${maxDepth}`)
  const indexKey = field.indexKey ?? 'index'
  const attributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(element.attributes ?? {}))
    if (key !== indexKey && key !== 'removed') attributes[key] = attributeValue(String(value))
  const nestedSchemas = nestedShapesOf(field)
  const nested: Record<string, unknown> = {}
  const occurrences = new Map<string, number>()
  for (const child of elementChildren(element)) {
    const childSchema = nestedSchemas.get(child.name)
    if (childSchema === undefined) continue
    const occurrence = nextOccurrence(occurrences, child, childSchema)
    const value = fieldValue(child, childSchema, occurrence, depth + 1, maxDepth)
    if (childSchema.cardinality === 'append' || childSchema.cardinality === 'indexed') {
      const current = Array.isArray(nested[child.name]) ? (nested[child.name] as unknown[]) : []
      current.push(value)
      nested[child.name] = current
    } else {
      nested[child.name] = value
    }
  }
  const combined: Record<string, unknown> = { ...attributes, ...nested }
  const keys = Object.keys(combined)
  if (keys.length === 1 && keys[0] === 'value') return combined['value']
  if (keys.length > 0) return combined
  const text = typeof element.text === 'string' ? element.text.trim() : ''
  return text.length > 0 ? text : ''
}

function fieldValue(element: CatalogElement, field: CatalogFieldShape, occurrence: number, depth: number, maxDepth: number): unknown {
  const value = structuredValue(element, field, depth, maxDepth)
  if (field.cardinality !== 'indexed') return value
  const indexKey = field.indexKey ?? 'index'
  const explicit = element.attributes?.[indexKey]
  const removed = element.attributes?.['removed']
  return {
    [indexKey]: explicit === undefined ? String(occurrence) : String(explicit),
    value,
    ...(removed === '1' || removed === 'true' ? { removed: true } : {}),
  }
}

function inferField(fieldId: string, elements: readonly CatalogElement[], depth: number, maxDepth: number): CatalogFieldShape {
  if (depth > maxDepth)
    throw new RangeError(`catalog XML exceeds inferred schema depth ${maxDepth}`)
  const indexed = elements.some(element => element.attributes?.['index'] !== undefined)
  const nestedElements = elements.flatMap(element => elementChildren(element))
  const nested = inferFields(nestedElements, depth + 1, maxDepth)
  return Object.freeze({
    fieldId,
    cardinality: indexed ? 'indexed' : elements.length > 1 ? 'append' : 'scalar',
    ...(indexed ? { indexKey: 'index' } : {}),
    ...(nested.length === 0 ? {} : { fields: nested }),
    unverified: true,
  })
}

function inferFields(elements: readonly CatalogElement[], depth: number, maxDepth: number): readonly CatalogFieldShape[] {
  if (depth > maxDepth)
    throw new RangeError(`catalog XML exceeds inferred schema depth ${maxDepth}`)
  const grouped = new Map<string, CatalogElement[]>()
  for (const element of elements) {
    const current = grouped.get(element.name) ?? []
    current.push(element)
    grouped.set(element.name, current)
  }
  return Object.freeze(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fieldId, values]) => inferField(fieldId, values, depth, maxDepth)),
  )
}

function mergeFieldShape(
  canonical: CatalogFieldShape | undefined,
  inferred: CatalogFieldShape,
  fieldPath: string,
  unverifiedFields: Set<string>,
  depth: number,
  maxDepth: number,
): CatalogFieldShape {
  if (depth > maxDepth)
    throw new RangeError(`catalog schema exceeds nested field depth ${maxDepth}`)
  if (canonical === undefined) {
    unverifiedFields.add(fieldPath)
    return inferred
  }
  // Blizzard serializes flag sets as repeated `<Field index="Flag" value="0|1"/>` entries even
  // though the generated type schema describes the logical value as one flags field. Preserve the
  // wire-level index during patch merge; collapsing it to a scalar loses which flag was changed.
  const effectiveCanonical: CatalogFieldShape =
    canonical.valueKind === 'flags' && inferred.cardinality === 'indexed'
      ? Object.freeze({ ...canonical, cardinality: 'indexed', indexKey: inferred.indexKey ?? 'index' })
      : canonical
  if ((inferred.fields ?? []).length === 0) return effectiveCanonical
  const canonicalNested = nestedShapesOf(effectiveCanonical)
  const inferredNested = new Map((inferred.fields ?? []).map(field => [field.fieldId, field]))
  const mergedNested: (CatalogFieldShape | undefined)[] = []
  for (const fieldId of new Set([...canonicalNested.keys(), ...inferredNested.keys()])) {
    const known = canonicalNested.get(fieldId)
    const discovered = inferredNested.get(fieldId)
    if (discovered === undefined) mergedNested.push(known)
    else {
      mergedNested.push(
        mergeFieldShape(
          known,
          discovered,
          `${fieldPath}.${fieldId}`,
          unverifiedFields,
          depth + 1,
          maxDepth,
        ),
      )
    }
  }
  return Object.freeze({
    ...effectiveCanonical,
    fields: Object.freeze(
      mergedNested
        .filter((field): field is CatalogFieldShape => field !== undefined)
        .sort((left, right) => left.fieldId.localeCompare(right.fieldId)),
    ),
  })
}

// The schema is fixed, so each class's resolution fields are computed once, not per declaration.
const resolutionFieldsByType = new Map<string, Map<string, CatalogFieldShape>>()

function resolutionFieldsOf(typeId: string): Map<string, CatalogFieldShape> {
  let fields = resolutionFieldsByType.get(typeId)
  if (fields === undefined) {
    fields = new Map((resolveStarcraft2SchemaFields(typeId) as readonly CatalogFieldShape[]).map(field => {
      const resolved = starcraft2ResolutionField(field) as CatalogFieldShape
      return [resolved.fieldId, resolved]
    }))
    resolutionFieldsByType.set(typeId, fields)
  }
  return fields
}

function parseFieldsForEntity(typeId: string, elements: readonly CatalogElement[], unverifiedFields: Set<string>, maxDepth: number) {
  return parseFieldsForShape(typeId, resolutionFieldsOf(typeId), elements, unverifiedFields, maxDepth)
}

/** Extend schema shapes only when native children or indexed flags need inference; known leaves
 * retain their canonical shape. Unknown fields still carry unverified evidence and depth bounds. */
function parseFieldsForShape(
  typeId: string,
  canonicalFields: ReadonlyMap<string, CatalogFieldShape> | readonly CatalogFieldShape[],
  elements: readonly CatalogElement[],
  unverifiedFields: Set<string>,
  maxDepth: number,
) {
  const canonical = canonicalFields instanceof Map
    ? canonicalFields
    : new Map((canonicalFields as readonly CatalogFieldShape[]).map(field => [field.fieldId, field]))
  const grouped = new Map<string, CatalogElement[]>()
  for (const element of elements) {
    const siblings = grouped.get(element.name) ?? []
    siblings.push(element)
    grouped.set(element.name, siblings)
  }
  const parsed = new Map<string, CatalogFieldShape>()
  const extensions = new Map<string, CatalogFieldShape>()
  for (const [fieldId, siblings] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    const known = canonical.get(fieldId)
    if (
      known !== undefined &&
      siblings.every(element => elementChildren(element).length === 0) &&
      !(known.valueKind === 'flags' && siblings.some(element => element.attributes?.['index'] !== undefined))
    ) {
      parsed.set(fieldId, known)
      continue
    }
    const field = inferField(fieldId, siblings, 0, maxDepth)
    const merged = mergeFieldShape(
      known,
      field,
      `${typeId}.${fieldId}`,
      unverifiedFields,
      0,
      maxDepth,
    )
    parsed.set(fieldId, merged)
    if (known === undefined || merged !== known) extensions.set(fieldId, merged)
  }
  return { fields: Object.freeze([...parsed.values()]), byId: parsed, extensions }
}

/** Native input of a typed projection; the parser has already checked its schema and depth. */
interface CatalogValueInput {
  readonly element: CatalogElement
  readonly typeId: string
  readonly maxDepth: number
}

/** One lazily typed value pair per declaration; shared accessors allocate no per-patch functions. */
interface CatalogValueState {
  readonly input: CatalogValueInput
  readonly knownFields?: ReadonlyMap<string, CatalogFieldShape>
  values?: ReturnType<typeof catalogValues>
}

/** Weak ownership avoids keeping declarations alive after their session/cache record is released. */
const catalogValueInputs = new WeakMap<object, CatalogValueState>()

/** Type one declaration's values through the same inferred shapes, only when a consumer asks. */
function catalogValues(input: CatalogValueInput, knownFields?: ReadonlyMap<string, CatalogFieldShape>) {
  const children = entityFieldElements(input.element)
  const fieldSchemas = knownFields ?? parseFieldsForEntity(input.typeId, children, new Set(), input.maxDepth).byId
  const fields: Record<string, unknown> = {}
  const fieldLexemes: Record<string, string> = {}
  const occurrences = new Map<string, number>()
  for (const child of children) {
    const field = fieldSchemas.get(child.name)
    if (field === undefined) throw new TypeError(`${input.typeId}.${child.name} was not inferred`)
    const occurrence = nextOccurrence(occurrences, child, field)
    const value = fieldValue(child, field, occurrence, 0, input.maxDepth)
    if (field.cardinality === 'append' || field.cardinality === 'indexed') {
      const current = Array.isArray(fields[child.name]) ? (fields[child.name] as unknown[]) : []
      current.push(value)
      fields[child.name] = current
    } else {
      fields[child.name] = value
      if (field.cardinality === 'scalar' && field.valueKind === 'number' &&
          typeof child.attributes?.['value'] === 'string')
        fieldLexemes[child.name] = child.attributes['value'] as string
      else delete fieldLexemes[child.name]
    }
  }
  return { fields: Object.freeze(fields) as Readonly<Record<string, JsonValue>>, fieldLexemes: Object.freeze(fieldLexemes) }
}

/** Materialize both projections once, through the same parser used for resolved values. */
function readCatalogValues(patch: object) {
  const state = catalogValueInputs.get(patch)
  if (state === undefined) throw new TypeError('catalog patch has no canonical native input')
  return state.values ??= catalogValues(state.input, state.knownFields)
}

/** Shared enumerable accessors preserve the former public property shape. */
function catalogFields(this: object) { return readCatalogValues(this).fields }
/** Numeric lexemes use the same memoized projection as fields. */
function catalogFieldLexemes(this: object) { return readCatalogValues(this).fieldLexemes }

/** Attach ordinary enumerable projections without allocating a getter closure per declaration. */
function withCatalogValues<T extends object>(facts: T, input: CatalogValueInput, knownFields?: ReadonlyMap<string, CatalogFieldShape>) {
  const patch = Object.freeze(Object.defineProperties({ ...facts }, {
    fields: { enumerable: true, get: catalogFields },
    fieldLexemes: { enumerable: true, get: catalogFieldLexemes },
  })) as Readonly<T> & Pick<CatalogPatch, 'fields' | 'fieldLexemes'>
  catalogValueInputs.set(patch, { input, ...(knownFields === undefined ? {} : { knownFields }) })
  return patch
}

/** The cache stores native input and checked declaration facts, never enumerable value getters. */
export interface StoredCatalogDocument extends Omit<ParsedCatalogDocument, 'patches'> {
  readonly patches: readonly {
    readonly facts: Omit<CatalogPatch, 'fields' | 'fieldLexemes'>
    readonly input: CatalogValueInput
  }[]
}

/** Project an existing parse for structured-clone storage without reading any own typed value. */
export function storeCatalogDocument(parsed: ParsedCatalogDocument): StoredCatalogDocument {
  return { ...parsed, patches: parsed.patches.map(patch => {
    const state = catalogValueInputs.get(patch)
    if (state === undefined) throw new TypeError('catalog patch has no canonical native input')
    const facts = Object.fromEntries(Object.keys(patch)
      .filter(key => key !== 'fields' && key !== 'fieldLexemes')
      .map(key => [key, patch[key as keyof CatalogPatch]])) as Omit<CatalogPatch, 'fields' | 'fieldLexemes'>
    return { facts, input: state.input }
  }) }
}

/** Reattach the same memoized projections after a parser-fingerprinted cache record is decoded. */
export function restoreCatalogDocument(stored: StoredCatalogDocument): ParsedCatalogDocument {
  return { ...stored, patches: stored.patches.map(({ facts, input }) => {
    if (typeof input?.typeId !== 'string' || !Number.isSafeInteger(input.maxDepth) ||
        input.maxDepth < 0 || typeof input.element?.name !== 'string')
      throw new TypeError('invalid stored catalog value input')
    return withCatalogValues(facts, input)
  }) }
}

/** Infer one declaration's metadata without allocating a disposable lazy value projection. */
function catalogEntityFacts(
  element: CatalogElement,
  schema: DataTypeSchema,
  namespace: string,
  source: DataEntitySource,
  syntheticId: string,
  unverifiedFields: Set<string>,
  maxDepth: number,
) {
  const declaredId = element.attributes?.['id']
  const entityId =
    typeof declaredId === 'string' && declaredId.length > 0 ? declaredId : syntheticId
  // SC2 catalogs serialize many scalar fields directly on the entity declaration, notably
  // CWater material properties. Project them through the same schema-driven field parser as
  // child elements; a later child spelling remains the deterministic winner for scalar fields.
  const children = entityFieldElements(element)
  const parsing = parseFieldsForEntity(schema.typeId, children, unverifiedFields, maxDepth)
  const parent = element.attributes?.['parent']
  const defaultValue = element.attributes?.['default']
  const tokens = entityTokens(element)
  return {
    facts: {
      namespace,
      typeId: schema.typeId,
      entityId,
      ...(typeof parent === 'string' && parent.length > 0 ? { parentEntityId: parent } : {}),
      source: Object.freeze(source),
      schemaExtensions: parsing.extensions,
      synthetic: declaredId === undefined || (declaredId as string).length === 0,
      defaultTemplate: defaultValue === '1' || defaultValue === 'true',
      ...(tokens.length === 0 ? {} : { tokens }),
    },
    fields: parsing.byId,
  }
}

/** One declaration's schema facts now, with its typed values memoized on first access. */
export function parseCatalogEntity(
  element: CatalogElement,
  schema: DataTypeSchema,
  namespace: string,
  source: DataEntitySource,
  syntheticId: string,
  unverifiedFields: Set<string>,
  maxDepth: number,
) {
  const { facts, fields } = catalogEntityFacts(element, schema, namespace, source, syntheticId, unverifiedFields, maxDepth)
  return withCatalogValues(facts, { element, typeId: schema.typeId, maxDepth }, fields)
}

/** The typed declarations of one GameData document, in document order. */
export function parseCatalogDocument(
  document: CatalogDocument,
  documentIndex: number,
  signal: AbortSignal | undefined,
  maxDepth: number,
): ParsedCatalogDocument {
  signal?.throwIfAborted()
  if (/<!DOCTYPE|<!ENTITY/iu.test(document.text)) {
    throw new TypeError(`${document.path}: DTD and custom entities are forbidden`)
  }
  const elements = parseCatalogXmlElements(document.text) as unknown as readonly CatalogElement[]
  const root = elements[0]
  if (root === undefined) throw new TypeError(`${document.path}: XML root element is missing`)
  const patches: CatalogPatch[] = []
  const schemaExtensions: SchemaExtensions = new Map()
  const unverifiedTypes = new Set<string>()
  const unverifiedFields = new Set<string>()
  const unsupportedElements = new Set<string>()
  let anonymousEntities = 0
  const diagnostics: DataCatalogDiagnostic[] = []
  const seen = new Set<string>()
  const structureDefaults: CatalogStructureDefault[] = []
  const rootElements = elementChildren(root)
  for (const [elementIndex, element] of rootElements.entries()) {
    signal?.throwIfAborted()
    const source: DataEntitySource = {
      rootId: document.rootId,
      path: document.path,
      documentIndex,
      ...(document.revision === undefined ? {} : { revision: document.revision as NonNullable<DataEntitySource['revision']> }),
    }
    if (element.name === 'const' && typeof element.attributes?.['id'] === 'string' && typeof element.attributes?.['value'] === 'string') {
      continue
    }
    if (isStarcraft2StructureDefaultTag(element.name)) {
      const namespace = starcraft2StructureDefaultNamespace(
        document.path,
        rootElements.map(item => item.name),
      )
      if (namespace === undefined) unsupportedElements.add(element.name)
      else {
        // Same wire-shape inference as entity fields (flags spelled as indexed entries).
        const parsing = parseFieldsForShape(
          element.name,
          (resolveStarcraft2StructureFields(element.name) as readonly CatalogFieldShape[]).map(
            field => starcraft2ResolutionField(field) as CatalogFieldShape,
          ),
          entityFieldElements(element),
          unverifiedFields,
          maxDepth,
        )
        structureDefaults.push({
          namespace,
          structureType: element.name,
          value: structuredValue(element, { fields: parsing.fields }, 0, maxDepth),
          source: Object.freeze(source),
        })
      }
      continue
    }
    const canonicalSchema = SCHEMA_BY_TYPE.get(element.name)
    const namespace = starcraft2NamespaceForType(element.name) as string | undefined
    if (namespace === undefined) {
      unsupportedElements.add(element.name)
      continue
    }
    if (canonicalSchema === undefined) unverifiedTypes.add(element.name)
    const schema: DataTypeSchema =
      canonicalSchema ??
      Object.freeze({ typeId: element.name, parentTypeId: 'CBase', fields: Object.freeze([]) })
    const { facts: patch } = catalogEntityFacts(
      element,
      schema,
      namespace,
      {
        ...source,
      },
      `@default:${element.name}:${documentIndex}:${elementIndex}`,
      unverifiedFields,
      maxDepth,
    )
    if (patch.synthetic) anonymousEntities += 1
    const key = `${patch.namespace}\0${patch.entityId}`
    if (seen.has(key)) {
      diagnostics.push(
        Object.freeze({
          severity: 'error',
          code: 'blizzard.starcraft2/catalog-id-duplicate',
          message: `${document.path} declares ${patch.namespace}/${patch.entityId} more than once`,
          namespace: patch.namespace,
          typeId: patch.typeId,
          entityId: patch.entityId,
          source: patch.source,
        }),
      )
    }
    seen.add(key)
    const extensions = schemaExtensions.get(patch.typeId) ?? new Map<string, CatalogFieldShape>()
    for (const [fieldId, field] of patch.schemaExtensions) extensions.set(fieldId, field)
    schemaExtensions.set(patch.typeId, extensions)
    patches.push(
      withCatalogValues({
        namespace: patch.namespace,
        typeId: patch.typeId,
        entityId: patch.entityId,
        ...(patch.parentEntityId === undefined ? {} : { parentEntityId: patch.parentEntityId }),
        source: patch.source,
        ...(patch.defaultTemplate ? { defaultTemplate: true as const } : {}),
        ...(patch.tokens === undefined ? {} : { tokens: patch.tokens }),
        ...(patch.synthetic ? { synthetic: true as const } : {}),
      }, { element, typeId: patch.typeId, maxDepth }),
    )
  }
  return {
    elements,
    patches,
    structureDefaults,
    schemaExtensions,
    unverifiedTypes,
    unverifiedFields,
    unsupportedElements,
    anonymousEntities,
    diagnostics,
  }
}

function combineSchemaField(left: CatalogFieldShape | undefined, right: CatalogFieldShape): CatalogFieldShape {
  if (left === undefined) return right
  const leftNested = new Map((left.fields ?? []).map(field => [field.fieldId, field]))
  for (const field of right.fields ?? []) {
    leftNested.set(field.fieldId, combineSchemaField(leftNested.get(field.fieldId), field))
  }
  const cardinality =
    left.cardinality === 'indexed' || right.cardinality === 'indexed'
      ? 'indexed'
      : left.cardinality === 'append' || right.cardinality === 'append'
        ? 'append'
        : 'scalar'
  return Object.freeze({
    ...right,
    ...left,
    cardinality,
    ...(cardinality === 'indexed' ? { indexKey: left.indexKey ?? right.indexKey ?? 'index' } : {}),
    ...(leftNested.size === 0
      ? {}
      : {
          fields: Object.freeze(
            [...leftNested.values()].sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
          ),
        }),
  })
}

/** Merge one document's schema extensions into the request's, earlier documents winning facts. */
export function mergeSchemaExtensions(target: SchemaExtensions, incoming: SchemaExtensions): void {
  for (const [typeId, fields] of incoming) {
    const current = target.get(typeId) ?? new Map<string, CatalogFieldShape>()
    for (const [fieldId, field] of fields) {
      current.set(fieldId, combineSchemaField(current.get(fieldId), field))
    }
    target.set(typeId, current)
  }
}

/** The canonical resolution schemas extended by what the documents declared. */
export function effectiveSchemas(extensions: SchemaExtensions): readonly DataTypeSchema[] {
  const schemas: DataTypeSchema[] = []
  for (const canonical of RESOLUTION_SCHEMAS) {
    const additions = extensions.get(canonical.typeId)
    if (additions === undefined || additions.size === 0) {
      schemas.push(canonical)
      continue
    }
    const fields = new Map((canonical.fields as readonly CatalogFieldShape[]).map(field => [field.fieldId, field]))
    for (const [fieldId, field] of additions) {
      fields.set(fieldId, combineSchemaField(fields.get(fieldId), field))
    }
    schemas.push(
      Object.freeze({
        ...canonical,
        fields: Object.freeze(
          [...fields.values()].sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
        ),
      }) as DataTypeSchema,
    )
  }
  for (const [typeId, additions] of extensions) {
    if (SCHEMA_BY_TYPE.has(typeId)) continue
    schemas.push(
      Object.freeze({
        typeId,
        parentTypeId: 'CBase',
        fields: Object.freeze(
          [...additions.values()].sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
        ),
      }) as DataTypeSchema,
    )
  }
  return Object.freeze(schemas)
}

/** A type's fields with its schema parents', the nearest declaration of a field winning. */
export function resolvedFieldsForSchemas(
  typeId: string,
  schemas: ReadonlyMap<string, DataTypeSchema>,
  visiting: ReadonlySet<string> = new Set(),
): readonly DataTypeSchema['fields'][number][] {
  if (visiting.has(typeId)) throw new TypeError(`SC2 effective schema cycle includes ${typeId}`)
  const schema = schemas.get(typeId)
  if (schema === undefined) return Object.freeze([])
  const next = new Set(visiting)
  next.add(typeId)
  const fields = new Map<string, DataTypeSchema['fields'][number]>()
  if (schema.parentTypeId !== undefined) {
    for (const field of resolvedFieldsForSchemas(schema.parentTypeId, schemas, next)) {
      fields.set(field.fieldId, field)
    }
  }
  for (const field of schema.fields) fields.set(field.fieldId, field)
  return Object.freeze([...fields.values()])
}

/** The documents of a request, parsed in load order, with the provider's catalog-wide facts. */
export interface ParsedCatalog {
  readonly patches: readonly CatalogPatch[]
  /** The documents again, for catalog-engine, each with its parsed elements. */
  readonly engineDocuments: readonly EngineCatalogDocument[]
  /** namespace → structure type → default, later documents (dependents) layered over earlier ones. */
  readonly structureDefaults: ReadonlyMap<string, ReadonlyMap<string, { readonly value: unknown; readonly source: DataEntitySource }>>
  readonly schemaExtensions: SchemaExtensions
  readonly unverifiedTypes: ReadonlySet<string>
  readonly unverifiedFields: ReadonlySet<string>
  readonly unsupportedElements: ReadonlySet<string>
  readonly anonymousEntities: number
  readonly editorCategories: ReturnType<typeof parseEditorCategories>
}

/**
 * Parse every catalog document of a request in the order the game loads them. A document that
 * fails to parse is an error diagnostic of the workspace analysis and is skipped; without workspace
 * facets it fails the request. `parse` lets a holder reuse an unchanged document's parse.
 */
export function parseCatalogDocuments(
  documents: readonly CatalogDocument[],
  options: {
    readonly includeWorkspaceFacets: boolean
    readonly maxDepth: number
    readonly maxEntities: number
    readonly signal?: AbortSignal
    readonly diagnostics: DataCatalogDiagnostic[]
    readonly parse?: (document: CatalogDocument, documentIndex: number) => ParsedCatalogDocument
  },
): ParsedCatalog {
  const patches: CatalogPatch[] = []
  const schemaExtensions: SchemaExtensions = new Map()
  const unverifiedTypes = new Set<string>()
  const unverifiedFields = new Set<string>()
  const unsupportedElements = new Set<string>()
  let anonymousEntities = 0
  const structureDefaults = new Map<string, Map<string, { value: unknown; source: DataEntitySource }>>()
  const engineDocuments: EngineCatalogDocument[] = []
  let editorCategories = EMPTY_EDITOR_CATEGORIES as ReturnType<typeof parseEditorCategories>
  const parse = options.parse ??
    ((document: CatalogDocument, documentIndex: number) => parseCatalogDocument(document, documentIndex, options.signal, options.maxDepth))
  loadedCatalogDocuments(documents).forEach(({ document, documentIndex }) => {
    options.signal?.throwIfAborted()
    if (isEditorCategoriesDocument(document)) {
      editorCategories = mergeEditorCategories(
        editorCategories,
        parseEditorCategories(document.text),
      )
      return
    }
    let parsed: ParsedCatalogDocument
    try {
      parsed = parse(document, documentIndex)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (!options.includeWorkspaceFacets) throw error
      options.diagnostics.push(
        Object.freeze({
          severity: 'error',
          code: 'blizzard.starcraft2/data-document-invalid',
          message:
            `${document.path}: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              2_048,
            ),
          source: Object.freeze({
            rootId: document.rootId,
            path: document.path,
            documentIndex,
            ...(document.revision === undefined ? {} : { revision: document.revision as NonNullable<DataEntitySource['revision']> }),
          }),
        }),
      )
      return
    }
    patches.push(...parsed.patches)
    engineDocuments.push({ rootId: document.rootId, path: document.path, text: document.text, elements: parsed.elements as EngineCatalogDocument['elements'] })
    for (const item of parsed.structureDefaults) {
      const byType = structureDefaults.get(item.namespace) ?? new Map<string, { value: unknown; source: DataEntitySource }>()
      byType.set(item.structureType, {
        value: mergeStructureDefault(byType.get(item.structureType)?.value, item.value),
        source: item.source,
      })
      structureDefaults.set(item.namespace, byType)
    }
    options.diagnostics.push(...parsed.diagnostics)
    mergeSchemaExtensions(schemaExtensions, parsed.schemaExtensions)
    for (const typeId of parsed.unverifiedTypes) unverifiedTypes.add(typeId)
    for (const fieldId of parsed.unverifiedFields) unverifiedFields.add(fieldId)
    for (const elementName of parsed.unsupportedElements) unsupportedElements.add(elementName)
    anonymousEntities += parsed.anonymousEntities
    if (patches.length > options.maxEntities) {
      throw new TypeError(
        `parsed entities exceeds maxEntities (${patches.length} > ${options.maxEntities})`,
      )
    }
  })
  return {
    patches,
    engineDocuments,
    structureDefaults,
    schemaExtensions,
    unverifiedTypes,
    unverifiedFields,
    unsupportedElements,
    anonymousEntities,
    editorCategories,
  }
}

/** One entity of a resolution: its flat typed declaration and what produced it. */
interface ResolvedEntry {
  readonly flat: CatalogPatch & { readonly fieldLexemes?: Readonly<Record<string, string>> }
  readonly own?: CatalogPatch
  readonly entity?: EngineResolvedEntity
  readonly chain?: readonly { readonly namespace: string; readonly entityId: string }[]
  readonly fieldLexemes?: Readonly<Record<string, string>>
  readonly diagnostic?: DataCatalogDiagnostic
}

/** The catalog resolved through catalog-engine: each entity on demand, or all in declaration order. */
export interface CatalogResolution {
  readonly engine: EngineCatalog
  /** Whether any document declares this entity. */
  has(namespace: string, entityId: string): boolean
  /** The entity's first declaration, which decides how it resolves. */
  patch(namespace: string, entityId: string): CatalogPatch | undefined
  /** The entity's inheritance chain, root first and the entity last (a class template by its own id). */
  chain(namespace: string, entityId: string): readonly { readonly namespace: string; readonly entityId: string }[] | undefined
  /** Every entity's first declaration, in declaration order. */
  firstPatches(): ReadonlyMap<string, CatalogPatch>
  /** Every entity, in declaration order; diagnostics of missing parents go to the analysis in that order. */
  entities(): readonly CatalogPatch[]
  /** One entity's flat typed declaration (its resolved values typed as an authored one). */
  flat(namespace: string, entityId: string): CatalogPatch | undefined
  /** An entity's class and the declaration its index row names, without resolving its values. */
  summary(namespace: string, entityId: string): { readonly typeId: string; readonly source: DataEntitySource } | undefined
  /** A definition enriched with its parent, chain, declaration sites and field sources. */
  enrich<Definition extends { readonly namespace: string; readonly entityId: string }>(
    definition: Definition,
    withFieldSources: boolean,
  ): Definition
  provenance<Snapshot extends { readonly definitions?: readonly { readonly namespace: string; readonly entityId: string }[]; readonly entities: readonly { readonly namespace: string; readonly entityId: string }[] }>(
    snapshot: Snapshot,
    withFieldSources: boolean,
  ): Snapshot
  /** One entity's row input of the authoring index. */
  authoringEntity(namespace: string, entityId: string, structureDefaults: ParsedCatalog['structureDefaults']): AuthoringIndexEntityInput | undefined
  /** Rows of every entity, in declaration order. */
  authoringEntities(structureDefaults: ParsedCatalog['structureDefaults']): readonly AuthoringIndexEntityInput[]
}

/**
 * Resolve the catalog through catalog-engine, the one SC2 Data resolver (owner decision 26.09),
 * and hand the common snapshot builder one flat declaration per entity: the resolved values typed
 * by the same code as an authored declaration, without a parent, so the common builder shapes
 * fields, relations and localization but inherits nothing itself. Class templates stay their own
 * declarations. `provenance` then restores what inheritance produced — parent, chain, own
 * declaration sites, the declaration behind each field. Entities resolve when first asked.
 */
export function resolveThroughEngine(
  patches: readonly CatalogPatch[],
  documents: readonly EngineCatalogDocument[],
  value: { readonly documents: readonly CatalogDocument[]; readonly maxDepth: number },
  diagnostics: DataCatalogDiagnostic[],
  engine: EngineCatalog = createEngineCatalog(documents),
): CatalogResolution {
  const keyOf = (rootId: string, path: string) => `${rootId}\u0000${path}`
  const documentIndexes = new Map(value.documents.map((document, index) => [keyOf(document.rootId, document.path), index]))
  // Every field of a declaration names the same source object: one answer per object, not per field
  // (a melee chain has ~1.5 M field sources; making each anew cost ~1 s and as much in GC).
  const sources = new WeakMap<EngineSource, DataEntitySource>()
  const sourceOf = (source: EngineSource): DataEntitySource => {
    let answer = sources.get(source)
    if (answer === undefined) sources.set(source, (answer = sourceFor(source)))
    return answer
  }
  const sourceFor = (source: EngineSource): DataEntitySource => {
    const index = documentIndexes.get(keyOf(source.rootId, source.path))
    const document = index === undefined ? undefined : value.documents[index]
    return Object.freeze({
      rootId: source.rootId,
      path: source.path,
      ...(index === undefined ? {} : { documentIndex: index }),
      ...(document?.revision === undefined ? {} : { revision: document.revision }),
      // Where the declaration sits in that document (sdk `DataEntitySource.range`).
      ...(source.range === undefined ? {} : { range: Object.freeze({ ...source.range }) }),
    }) as DataEntitySource
  }
  // A class template in the engine's chain is the last `default="1"` declaration of its class;
  // one of its values, the declaration (by class and document) that wrote it.
  const templateOfClass = new Map<string, string>()
  const templateDeclarations = new Map<string, string>()
  for (const patch of patches) {
    if (!patch.synthetic || !patch.defaultTemplate) continue
    templateOfClass.set(patch.typeId, patch.entityId)
    templateDeclarations.set(keyOf(patch.typeId, `${patch.source.rootId}\u0000${patch.source.path}`), patch.entityId)
  }
  // The first declaration of each entity decides how it resolves, in declaration order.
  const firstPatches = new Map<string, CatalogPatch>()
  for (const patch of patches) {
    const key = keyOf(patch.namespace, patch.entityId)
    if (!firstPatches.has(key)) firstPatches.set(key, patch)
  }
  const resolved = new Map<string, ResolvedEntry>()
  const ignoredFields = new Set<string>()
  const entryFor = (key: string, patch: CatalogPatch): ResolvedEntry => {
    const known = resolved.get(key)
    if (known !== undefined) return known
    // A class template resolves as its class's template in the engine, whichever of its
    // declarations this is; another anonymous declaration is no template and stays as written.
    const entity = !patch.synthetic
      ? engine.resolve(patch.namespace, patch.entityId)
      : patch.defaultTemplate
        ? engine.resolveTemplate(patch.typeId)
        : undefined
    if (entity === undefined) {
      // Kept as written: its own declaration is its whole provenance.
      const { parentEntityId: _parent, ...own } = patch
      const entry: ResolvedEntry = { flat: Object.freeze(own) as CatalogPatch, own: own as CatalogPatch }
      resolved.set(key, entry)
      return entry
    }
    const schema =
      SCHEMA_BY_TYPE.get(entity.typeId) ??
      Object.freeze({ typeId: entity.typeId, parentTypeId: 'CBase', fields: Object.freeze([]) })
    const parsed = parseCatalogEntity(entity.element as unknown as CatalogElement, schema, patch.namespace, patch.source, patch.entityId, ignoredFields, value.maxDepth)
    const typed = entity.emptyLists.length === 0
      ? parsed
      : { ...parsed, fields: Object.freeze({ ...parsed.fields, ...Object.fromEntries(entity.emptyLists.map(name => [name, Object.freeze([])])) }) }
    const chain = entity.chain.map((link, index) =>
      Object.freeze({
        namespace: patch.namespace,
        entityId: index === entity.chain.length - 1
          ? patch.entityId
          : link.entityId === '' ? (templateOfClass.get(link.typeId) ?? '') : link.entityId,
      }),
    )
    const diagnostic: DataCatalogDiagnostic | undefined = entity.missingParent === undefined
      ? undefined
      : Object.freeze({
          severity: 'error',
          code: 'common.data/entity-parent-unavailable',
          message: `${patch.namespace}/${chain[0]?.entityId ?? patch.entityId} names unavailable parent ${entity.missingParent}`,
          namespace: patch.namespace,
          typeId: entity.typeId,
          entityId: patch.entityId,
        })
    const entry: ResolvedEntry = {
      entity,
      chain,
      fieldLexemes: typed.fieldLexemes,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      flat: Object.freeze({
        namespace: patch.namespace,
        typeId: entity.typeId,
        entityId: patch.entityId,
        fields: typed.fields,
        fieldLexemes: typed.fieldLexemes,
        source: entity.sources.length === 0 ? patch.source : sourceOf(entity.sources.at(-1)!),
        ...(patch.defaultTemplate ? { defaultTemplate: true as const } : {}),
        ...(patch.synthetic ? { synthetic: true as const } : {}),
        ...(entity.tokens.length === 0 ? {} : { tokens: Object.freeze(entity.tokens.map(token => Object.freeze({ ...token }))) }),
      }) as CatalogPatch,
    }
    resolved.set(key, entry)
    return entry
  }
  let all: readonly CatalogPatch[] | undefined
  const entities = (): readonly CatalogPatch[] => {
    if (all !== undefined) return all
    const flat: CatalogPatch[] = []
    for (const [key, patch] of firstPatches) {
      const entry = entryFor(key, patch)
      if (entry.diagnostic !== undefined) diagnostics.push(entry.diagnostic)
      flat.push(entry.flat)
    }
    all = Object.freeze(flat)
    return all
  }
  const enrich = <Definition extends { readonly namespace: string; readonly entityId: string }>(
    definition: Definition,
    withFieldSources: boolean,
  ): Definition => {
    const known = resolved.get(keyOf(definition.namespace, definition.entityId))
    if (known === undefined) return definition
    if (known.own !== undefined) {
      const { own } = known
      return Object.freeze({
        ...definition,
        inheritanceChain: Object.freeze([Object.freeze({ namespace: own.namespace, entityId: own.entityId })]),
        sources: Object.freeze([own.source]),
        ...(withFieldSources
          ? {
              fieldSources: Object.freeze(Object.fromEntries(Object.keys(own.fields).map(field => [field, own.source]))),
              fieldLexemes: own.fieldLexemes ?? Object.freeze({}),
            }
          : {}),
      })
    }
    const { entity, chain, fieldLexemes } = known as Required<Pick<ResolvedEntry, 'entity' | 'chain'>> & ResolvedEntry
    const parent = chain.at(-2)?.entityId
    return Object.freeze({
      ...definition,
      ...(parent === undefined || parent === '' ? {} : { parentEntityId: parent }),
      inheritanceChain: Object.freeze(chain),
      sources: Object.freeze(entity.sources.map(sourceOf)),
      ...(withFieldSources
        ? {
            fieldSources: Object.freeze(
              Object.fromEntries(Object.entries(entity.fieldSources).map(([field, source]) => [field, sourceOf(source)])),
            ),
            fieldLexemes,
          }
        : {}),
    })
  }
  const provenance: CatalogResolution['provenance'] = (snapshot, withFieldSources) => Object.freeze({
    ...snapshot,
    ...(snapshot.definitions === undefined ? {} : { definitions: Object.freeze(snapshot.definitions.map(definition => enrich(definition, withFieldSources))) }),
    entities: Object.freeze(snapshot.entities.map(definition => enrich(definition, withFieldSources))),
  })
  // A field a structure default completes, at any depth, has an entity-specific value (its
  // `##id##`), so it belongs on the entity's own row even when an ancestor wrote the rest.
  const defaultedByNamespace = new Map<string, { readonly types: ReadonlySet<string>; readonly completing: Map<string, boolean> }>()
  const defaultedIn = (namespace: string) => {
    let known = defaultedByNamespace.get(namespace)
    if (known === undefined) {
      known = { types: engine.structureDefaultTypes(namespace), completing: new Map() }
      defaultedByNamespace.set(namespace, known)
    }
    return known
  }
  const completedByDefaults = (field: { readonly structureType?: string }, namespace: string, seen: ReadonlySet<string> = new Set()): boolean => {
    const type = field.structureType
    if (type === undefined || seen.has(type)) return false
    const { types, completing } = defaultedIn(namespace)
    if (types.has(type)) return true
    const known = completing.get(type)
    if (known !== undefined) return known
    const next = new Set(seen).add(type)
    const result = ((resolveStarcraft2StructureFields(type) ?? []) as readonly { readonly structureType?: string }[])
      .some(child => completedByDefaults(child, namespace, next))
    completing.set(type, result)
    return result
  }
  // A typed list of `{index, value}` records is addressed by position; the engine keys the same
  // slot by its index (`MismatchFlags/0/value` is `MismatchFlags/Id`).
  const keyedPath = (value: unknown, path: readonly string[]): string[] => {
    const keyed: string[] = []
    let node: unknown = value
    for (let at = 0; at < path.length; at += 1) {
      const part = path[at]!
      const item = Array.isArray(node) && /^\d+$/u.test(part) ? (node as unknown[])[Number(part)] : undefined
      if (item !== null && typeof item === 'object' && !Array.isArray(item) && typeof (item as { index?: unknown }).index === 'string') {
        keyed.push((item as { index: string }).index)
        if (path[at + 1] === 'index' || path[at + 1] === 'value') {
          at += 1
          node = (item as { value?: unknown }).value
        } else node = item
        continue
      }
      keyed.push(part)
      node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
    }
    return keyed
  }
  /** Row input of the authoring index: values as typed above, provenance from the engine. */
  const authoringEntityOf = (patch: CatalogPatch, structureDefaults: ParsedCatalog['structureDefaults']): AuthoringIndexEntityInput => {
    const key = keyOf(patch.namespace, patch.entityId)
    const known = resolved.get(key)
    const ownSource = patch.source
    const defaultsSource = [...(structureDefaults.get(patch.namespace)?.values() ?? [])].at(-1)?.source
    const fallback: AuthoringOrigin = { source: defaultsSource ?? ownSource, originEntityId: patch.entityId }
    if (known === undefined || known.own !== undefined) {
      const origin: AuthoringOrigin = { source: ownSource, originEntityId: patch.entityId }
      return {
        namespace: patch.namespace, typeId: patch.typeId, entityId: patch.entityId,
        ...(patch.defaultTemplate ? { defaultTemplate: true } : {}),
        ...(patch.tokens === undefined ? {} : { tokens: patch.tokens }),
        source: ownSource, complete: true, fields: patch.fields, rowFields: new Set(Object.keys(patch.fields)), fallback,
        fieldOrigin: () => origin, leafOrigin: () => origin, tombstones: [],
      }
    }
    const { entity, chain } = known as Required<Pick<ResolvedEntry, 'entity' | 'chain'>> & ResolvedEntry
    const template = patch.synthetic && patch.defaultTemplate
    const trace: EngineProvenance | undefined = template ? engine.templateProvenance(patch.typeId) : engine.provenance(patch.namespace, patch.entityId)
    // A class template's value names the very declaration that wrote it.
    const idOf = (link: { readonly entityId: string; readonly typeId: string; readonly source: EngineSource }): string =>
      link.entityId !== ''
        ? link.entityId
        : templateDeclarations.get(keyOf(link.typeId, `${link.source.rootId}\u0000${link.source.path}`)) ??
          (template && link.typeId === patch.typeId ? patch.entityId : (templateOfClass.get(link.typeId) ?? ''))
    const originOf = (link: { readonly entityId: string; readonly typeId: string; readonly source: EngineSource } | undefined): AuthoringOrigin | undefined =>
      link === undefined ? undefined : { source: sourceOf(link.source), originEntityId: idOf(link) }
    const rowFields = new Set(trace?.own ?? [])
    // A scalar structure with a default of its own exists on every entity: what no declaration
    // wrote there is the entity's, from the defaults. Defaults inside an authored value follow it.
    const baseFields = new Set<string>()
    const defaulted = defaultedIn(patch.namespace).types
    for (const field of resolveStarcraft2SchemaFields(patch.typeId) as readonly { readonly fieldId: string; readonly cardinality: string; readonly structureType?: string }[]) {
      if (!completedByDefaults(field, patch.namespace)) continue
      rowFields.add(field.fieldId)
      if (field.cardinality === 'scalar' && field.structureType !== undefined && defaulted.has(field.structureType)) baseFields.add(field.fieldId)
    }
    const parent = chain.at(-2)?.entityId
    return {
      namespace: patch.namespace, typeId: patch.typeId, entityId: patch.entityId,
      ...(parent === undefined || parent === '' ? {} : { parentEntityId: parent }),
      ...(patch.defaultTemplate ? { defaultTemplate: true } : {}),
      ...(patch.tokens === undefined ? {} : { tokens: patch.tokens }),
      source: patch.source,
      complete: entity.missingParent === undefined,
      fields: patch.fields,
      rowFields,
      fallback,
      fieldOrigin: fieldId => originOf(trace?.field(fieldId)),
      leafOrigin: (fieldId, path) =>
        originOf(trace?.leaf(fieldId, path) ?? trace?.leaf(fieldId, keyedPath(patch.fields[fieldId], path))) ??
        (baseFields.has(fieldId) ? fallback : undefined),
      tombstones: (trace?.tombstones ?? []).map(tombstone => ({ path: tombstone.path, source: sourceOf(tombstone.source) })),
    }
  }
  return {
    engine,
    has: (namespace, entityId) => firstPatches.has(keyOf(namespace, entityId)),
    patch: (namespace, entityId) => firstPatches.get(keyOf(namespace, entityId)),
    chain(namespace, entityId) {
      const key = keyOf(namespace, entityId)
      const patch = firstPatches.get(key)
      if (patch === undefined) return undefined
      const entry = entryFor(key, patch)
      return entry.chain ?? [{ namespace: entry.flat.namespace, entityId: entry.flat.entityId }]
    },
    firstPatches: () => firstPatches,
    entities,
    flat(namespace, entityId) {
      const key = keyOf(namespace, entityId)
      const patch = firstPatches.get(key)
      return patch === undefined ? undefined : entryFor(key, patch).flat
    },
    summary(namespace, entityId) {
      const key = keyOf(namespace, entityId)
      const patch = firstPatches.get(key)
      if (patch === undefined) return undefined
      // A resolved or anonymous entity names them in its flat declaration (a template resolves as
      // its class's); the engine names any other's without resolving its values.
      const known = resolved.get(key) ?? (patch.synthetic ? entryFor(key, patch) : undefined)
      if (known !== undefined) return { typeId: known.flat.typeId, source: known.flat.source }
      const declared = engine.declared(patch.namespace, patch.entityId)
      if (declared === undefined) return { typeId: patch.typeId, source: patch.source }
      return { typeId: declared.typeId, source: declared.source === undefined ? patch.source : sourceOf(declared.source) }
    },
    enrich,
    provenance,
    authoringEntity(namespace, entityId, structureDefaults) {
      const key = keyOf(namespace, entityId)
      const patch = firstPatches.get(key)
      return patch === undefined ? undefined : authoringEntityOf(entryFor(key, patch).flat, structureDefaults)
    },
    authoringEntities: structureDefaults => entities().map(patch => authoringEntityOf(patch, structureDefaults)),
  }
}
