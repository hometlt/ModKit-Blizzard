/**
 * SC2 GameData XML language provider, declared by ../provider.json under
 * common.language/document-analysis@1 for trusted Node and portable worker runtimes.
 *
 * Provides nested class/field/attribute/value completion and snippets, on-type quoting, syntax and
 * semantic diagnostics, hover/docs/wiki links, definitions/references, symbols, rename edits,
 * formatting, code actions/lenses and color previews. The shared format/language library owns XML
 * authoring rules; catalog-engine and services/schema own classes, fields and schema identity.
 *
 * Host supplies bounded documents or the synchronized ModContext, the live overlay and locales.
 * Semantic values and provenance come from that server's canonical Data session. Hover and semantic
 * completion opt into server-backed input; asset completion keeps the bounded file listing. Without
 * a loaded mod the bounded standalone snapshot remains. This adapter
 * does not load archives or resolve Data inheritance independently.
 * Its answer cache has state/entity/search and cumulative reply-size bounds, follows revisions
 * and ordered locale preference, while context
 * completeness governs whether absence is authoritative. Partial context cannot prove a missing
 * reference. Request result limits and cancellation remain part of the shared language lifecycle.
 * Rename/formatting return document edits; native persistence belongs to the owning writer/Host.
 */
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageCodeAction,
  LanguageCodeActionsRequest,
  LanguageCodeLens,
  LanguageCodeLensList,
  LanguageColorList,
  LanguageColorPresentationList,
  LanguageColorPresentationRequest,
  LanguageCompletionItem,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDiagnosticList,
  LanguageDocument,
  LanguageDocumentSymbolList,
  LanguageFeatureRequest,
  LanguageFormattingRequest,
  LanguageHover,
  LanguageLocation,
  LanguageLocationList,
  LanguagePosition,
  LanguagePositionRequest,
  LanguageProvider,
  LanguageRange,
  LanguageReferencesRequest,
  LanguageRenamePreparation,
  LanguageRenameRequest,
  LanguageSymbol,
  LanguageTextEditList,
  LanguageWorkspaceEdit,
  LanguageWorkspaceSymbol,
  LanguageWorkspaceSymbolList,
  LanguageWorkspaceSymbolsRequest,
} from '@modkit/sdk'
import { dataAuthoringSource, type ResolvedDataAuthoringIndex } from '@modkit/sdk/data'
import { languageWorkspaceIsSemanticallyIncomplete } from '../../../../../shared/language/workspace-context.js'
import { finalNewlineCodeActions } from '../../../../../shared/language/code-actions.js'
import { decimalColor, parseColorLiteral } from '../../../../../shared/language/sc2-colors.js'
import { colorSites } from '../../../../../modules/data/shared/format/language/colors.js'
import { fuzzyMatches } from '../../../../../shared/language/symbol-match.js'
import { SC2_ENTITY_ID, sc2EntitySubjectId } from '../../../../../shared/language/entity-id.js'
import { parseCatalogXmlElements } from '../../../../../modules/data/shared/catalog-engine/xml/parser.js'
/*
 * Imported from the modules that define them rather than through the library's barrel. The barrel
 * also re-exports the overlay and docs helpers, which reach a Node-only XML parser, and pulling
 * those in made this provider unbundleable for the browser — while its contribution advertised a
 * `portable` variant. A narrow import is the difference between that claim being true and not.
 */
import { catalogEntities } from '../../../../../modules/data/shared/format/language/entity.js'
import {
  catalogConstAliases,
  collectIssues,
  type Issue,
} from '../../../../../modules/data/shared/format/language/diagnostics.js'
import { nearestNames } from '../../../../../modules/data/shared/format/language/suggest.js'
import {
  computeCompletions,
  fieldElementBody,
  rootElementBody,
} from '../../../../../modules/data/shared/format/language/completion.js'
import {
  DEFAULT_DOCS_URL,
  fieldDoc,
  fieldTypeLabel,
} from '../../../../../modules/data/shared/format/language/docs.js'
import {
  computeEntityLenses,
  computeHover,
  type HoverCatalog,
} from '../../../../../modules/data/shared/format/language/hover.js'
import { definitionRequestAt } from '../../../../../modules/data/shared/format/language/definition.js'
import { attrAt, elementPathAt } from '../../../../../modules/data/shared/format/language/xml-scan.js'
import {
  collectAllRefs,
  referenceTargetAt,
  type RefMatch,
  type RefTarget,
} from '../../../../../modules/data/shared/format/language/references.js'
/*
 * The scanner comes from the kit, not from the ported library beside this file. They are the same
 * code — the kit's was ported from exactly this one — but only the kit's copy decodes entities in
 * attribute values, so reading GameData through the local copy meant a `&quot;` in an id or a
 * reference was compared as five characters of markup.
 */
import { getAttr, scanXml, type ScannedElement } from '@modkit/codec-kit'
import {
  catalogClassesForNamespace,
  catalogNamespaceForFileName,
  namespaceOfClass,
} from '../../../../../modules/data/shared/catalog-engine/sc2-catalog/schema-fields.js'
import { STARCRAFT2_DATA_SCHEMA_REVISION } from '../../../services/schema/data-schema-identity.js'
import { parseSc2Strings } from '../../../../strings/shared/core/text-file.js'
import { sc2MixedReferenceOccurrenceBatches } from '../../../../../shared/language/typed-occurrences.js'

export const SC2_DATA_LANGUAGE_ID = 'sc2-data'
const SC2_GAME_ID = 'blizzard/starcraft-2'

/*
 * Keep the provider source buildable against the extension repository's pinned SDK package while
 * the adjacent MK3 host already exposes this additive structural method. The shapes are the shared
 * language contract; this local alias carries no SC2 semantics and can disappear at the next SDK pin.
 */
interface DataOnTypeFormattingRequest extends LanguagePositionRequest {
  readonly ch: string
}

interface DataOnTypeEditResult extends LanguageTextEditList {
  readonly cursor?: LanguagePosition
  readonly requestCompletion?: boolean
}

/** Line starts, so character offsets can be turned into positions and back. */
class LineIndex {
  readonly #starts: number[] = [0]
  constructor(text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) this.#starts.push(index + 1)
    }
  }

  positionAt(offset: number): LanguagePosition {
    let low = 0
    let high = this.#starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((this.#starts[middle] ?? 0) <= offset) low = middle
      else high = middle - 1
    }
    return { line: low, character: offset - (this.#starts[low] ?? 0) }
  }

  range(from: number, to: number): LanguageRange {
    return { start: this.positionAt(from), end: this.positionAt(to) }
  }

  offsetAt(position: LanguagePosition): number {
    return (this.#starts[position.line] ?? 0) + position.character
  }
}

/**
 * What the workspace snapshot knows about entities, built once per request.
 *
 * Only documents of this language are read: the contract may include others, and parsing a Galaxy
 * script as GameData XML would invent entities that do not exist.
 */
/** One entity as the snapshot declares it: its class, its parent and the fields set on it. */
interface EntityRecord {
  readonly namespace: string
  readonly entityId: string
  readonly classTag: string
  parent?: string
  readonly data: Map<string, unknown>
  readonly inheritanceChain?: readonly string[]
  readonly fieldOrigins?: ReadonlyMap<string, string>
  readonly definitionSource?: EntitySource
  readonly defaultTemplate?: boolean
  readonly tokens?: readonly EntityToken[]
}

interface EntityToken {
  readonly id: string
  readonly type?: string
  readonly value?: string
}

interface EditorCategoryView {
  readonly valuesByName: ReadonlyMap<string, readonly string[]>
  readonly applicableByNamespace: ReadonlyMap<
    string,
    readonly { readonly name: string; readonly values: string[] }[]
  >
}

interface EntitySource {
  readonly rootId: string
  readonly path: string
  readonly documentIndex: number
  /** The declaration's 0-based line and column, when the analysis recorded them (`range`). */
  readonly line?: number
  readonly column?: number
  /** The declaring file as the host addresses it, when the loaded mod's server named it. */
  readonly uri?: string
}

/** An entity's class and declaring file, as a completion item describes its target. */
interface EntitySummary {
  readonly classTag: string
  readonly path?: string
}

/** What a view holds: the catalog's ids and entities as maps. */
interface WorkspaceViewData {
  /** namespace → ids declared anywhere in the snapshot. */
  readonly idsByNamespace: ReadonlyMap<string, ReadonlySet<string>>
  /** id → what the snapshot declares for it, merged across files as the game merges them. */
  readonly entities: ReadonlyMap<string, EntityRecord>
  /** Whether the snapshot covered anything at all; drives "unknown" versus "absent". */
  readonly populated: boolean
  /** Whether absence in this view proves that a catalog entity does not exist. */
  readonly authoritative: boolean
  readonly editorCategories?: EditorCategoryView | undefined
  /** GameStrings the resolved Data context read for its entities, by key (parity plan 1.8). */
  readonly strings?: ReadonlyMap<string, string>
}

/**
 * A view and the questions features ask it beyond single entities. A view over a whole catalog
 * (`mapView`) answers them by walking its maps; the loaded mod's server answers them itself, so a
 * feature never walks a catalog it does not hold.
 */
interface WorkspaceView extends WorkspaceViewData {
  /** Whether the catalog declares this id. */
  hasId(namespace: string, id: string): boolean
  /** Whether the declaration is a class template; undefined for an entity the view does not know. */
  templateOf(namespace: string, id: string): boolean | undefined
  /** How many entities name this one as their parent. */
  heirCount(namespace: string, id: string): number
  /** The ids of a Data space declared as class templates, in the view's order. */
  defaultTemplateIds(namespace: string): readonly string[]
  /** An entity's class and declaring file. */
  summary(namespace: string, id: string): EntitySummary | undefined
  /** Named entities whose id fuzzily matches the (lower-case) needle, in the view's order. */
  matching(needle: string): Iterable<EntityRecord>
  /**
   * The exact range of an entity's first declaration in the document a server-named source points
   * at, when the loaded mod's server holds it and the request does not; undefined otherwise.
   */
  declarationRange?(source: EntitySource, namespace: string, id: string): LanguageRange | undefined
  /**
   * The `<const>` aliases the loaded mod's whole chain declares (`path\u0000id`), when its server
   * holds them; undefined otherwise (a snapshot reads its own documents).
   */
  constAliases?(): ReadonlySet<string> | undefined
}

/** The questions of a view over a whole catalog, answered from its maps (heirs counted once). */
function mapView(data: WorkspaceViewData): WorkspaceView {
  let heirs: Map<string, number> | undefined
  return {
    ...data,
    hasId: (namespace, id) => data.idsByNamespace.get(namespace)?.has(id) === true,
    templateOf(namespace, id) {
      const entity = data.entities.get(entityKey(namespace, id))
      return entity === undefined ? undefined : entity.defaultTemplate === true
    },
    heirCount(namespace, id) {
      if (heirs === undefined) {
        heirs = new Map()
        for (const record of data.entities.values()) {
          if (record.parent === undefined || record.parent === '') continue
          const parentKey = entityKey(record.namespace, record.parent)
          heirs.set(parentKey, (heirs.get(parentKey) ?? 0) + 1)
        }
      }
      return heirs.get(entityKey(namespace, id)) ?? 0
    },
    defaultTemplateIds: namespace =>
      [...data.entities.values()]
        .filter(entity => entity.namespace === namespace && entity.defaultTemplate === true)
        .map(entity => entity.entityId),
    summary(namespace, id) {
      const entity = data.entities.get(entityKey(namespace, id))
      return entity === undefined
        ? undefined
        : {
            classTag: entity.classTag,
            ...(entity.definitionSource === undefined ? {} : { path: entity.definitionSource.path }),
          }
    },
    *matching(needle) {
      for (const entity of data.entities.values()) {
        if (!isAnonymousEntityId(entity.entityId) && fuzzyMatches(entity.entityId, needle)) yield entity
      }
    },
  }
}

const entityKey = (namespace: string, id: string): string => `${namespace}\0${id}`

/**
 * The id the catalog owner gives an entity declared without one (`<CUnit default="1">` with no
 * `id`): `@default:<type>:<document>:<element>`. Its values still resolve, but no document can
 * name it, so it is never a completion, a link target or a suggested fix.
 */
const isAnonymousEntityId = (id: string): boolean => id.startsWith('@default:')

/** The entities a list of catalog texts declares, merged in order as the game merges them. */
function readCatalogTexts(texts: readonly string[]): {
  ids: Map<string, Set<string>>
  entities: Map<string, EntityRecord>
} {
  const ids = new Map<string, Set<string>>()
  const add = (namespace: string, id: string) => {
    if (id === '') return
    let set = ids.get(namespace)
    if (set === undefined) {
      set = new Set()
      ids.set(namespace, set)
    }
    set.add(id)
  }
  const entities = new Map<string, EntityRecord>()
  const read = (text: string) => {
    for (const entity of catalogEntities(scanXml(text))) {
      const namespace = namespaceOfClass(entity.tag)
      if (namespace === undefined) continue
      const id = getAttr(entity, 'id')?.value ?? ''
      add(namespace, id)
      if (id === '') continue
      const key = entityKey(namespace, id)
      let record = entities.get(key)
      if (record === undefined) {
        record = { namespace, entityId: id, classTag: entity.tag, data: new Map() }
        entities.set(key, record)
      }
      const parent = getAttr(entity, 'parent')?.value
      if (parent !== undefined) record.parent = parent
      for (const attribute of entity.attrs) {
        if (attribute.name !== 'id' && attribute.name !== 'parent')
          record.data.set(attribute.name, attribute.value)
      }
      // `<LifeMax value="55"/>`; a field with no `value` is kept as its own attribute list.
      for (const field of entity.children) {
        const value = getAttr(field, 'value')?.value
        record.data.set(
          field.tag,
          value ?? field.attrs.map(attribute => `${attribute.name}="${attribute.value}"`).join(' '),
        )
      }
    }
  }
  for (const text of texts) {
    read(text)
    for (const [key, tokens] of declaredTokens(text)) {
      const record = entities.get(key)
      if (record !== undefined) entities.set(key, { ...record, tokens: [...(record.tokens ?? []), ...tokens] })
    }
  }
  return { ids, entities }
}

/**
 * The `<?token?>` declarations of a text's entities by namespace and id, read by the catalog
 * engine's parser: what a template offers its children when no resolved snapshot does (plan 1.1).
 */
function declaredTokens(text: string): Map<string, EntityToken[]> {
  const declared = new Map<string, EntityToken[]>()
  // The tolerant scanner already read fields; only token instructions require the strict parser.
  if (!text.includes('<?token')) return declared
  let roots: ReturnType<typeof parseCatalogXmlElements>
  try {
    roots = parseCatalogXmlElements(text)
  } catch {
    return declared // a document being typed is often not well formed yet
  }
  for (const element of roots.flatMap(root => (root.name === 'Catalog' ? root.children : [root]))) {
    const id = element.attributes['id']
    const namespace = namespaceOfClass(element.name)
    if (element.tokens === undefined || id === undefined || id === '' || namespace === undefined) continue
    declared.set(
      entityKey(namespace, id),
      element.tokens.map(token => ({
        id: token.id,
        ...(token.type === undefined ? {} : { type: token.type }),
        ...(token.value === undefined ? {} : { value: token.value }),
      })),
    )
  }
  return declared
}

/*
 * The other documents' entities by their uri and version, kept between requests (parity plan 1.28):
 * every completion and hover read every Data document of the snapshot again, though only the edited
 * one changes while typing. Bounded; the least recently used goes first.
 */
const otherDocumentViews = new Map<string, { readonly texts: readonly string[]; readonly value: ReturnType<typeof readCatalogTexts> }>()

/*
 * The string keys of the snapshot's GameStrings documents, any locale (parity plan 1.22): what a
 * text link may name. Kept by their uris and versions; `undefined` when the snapshot has none.
 */
/**
 * A value of some documents, kept by their uris and versions and checked against their texts (a
 * version alone may repeat across snapshots). Bounded; the least recently used goes first.
 */
function keptForDocuments<T>(
  cache: Map<string, { readonly texts: readonly string[]; readonly value: T }>,
  documents: readonly LanguageDocument[],
  build: () => T,
): T {
  const key = documents.map(document => `${document.uri}@${document.version}`).join('\n')
  const kept = cache.get(key)
  const value =
    kept !== undefined && kept.texts.every((text, index) => text === documents[index]?.text) ? kept.value : build()
  cache.delete(key)
  cache.set(key, { texts: documents.map(document => document.text), value })
  while (cache.size > 4) cache.delete(cache.keys().next().value!)
  return value
}

const snapshotStringMaps = new Map<string, { readonly texts: readonly string[]; readonly value: ReadonlyMap<string, string> }>()

/** The snapshot's GameStrings, every key of every locale, the enUS value where it has one. */
function snapshotStrings(documents: readonly LanguageDocument[]): ReadonlyMap<string, string> | undefined {
  const enUs = (document: LanguageDocument) => (/enus\.sc2data/iu.test(document.uri) ? 1 : 0)
  const strings = documents
    .filter(
      document => document.languageId === 'sc2-strings' && /(?:^|[\\/])GameStrings\.txt$/iu.test(decodeURIComponent(document.uri)),
    )
    .sort((left, right) => enUs(left) - enUs(right))
  if (strings.length === 0) return undefined
  // enUS last, so its values win.
  return keptForDocuments(snapshotStringMaps, strings, () => new Map(strings.flatMap(document => [...parseSc2Strings(document.text)])))
}


function snapshotStringKeys(documents: readonly LanguageDocument[]): ((key: string) => boolean) | undefined {
  const values = snapshotStrings(documents)
  return values === undefined ? undefined : candidate => values.has(candidate)
}

/** Where a string key is written: its line in the snapshot's locale files, enUS first, Gender.txt aside. */
function stringKeyLocation(documents: readonly LanguageDocument[], key: string): LanguageLocation | undefined {
  const enUs = (document: LanguageDocument) => (/enus\.sc2data/iu.test(document.uri) ? 0 : 1)
  const files = documents
    .filter(document => document.languageId === 'sc2-strings' && !/gender\.txt$/iu.test(decodeURIComponent(document.uri)))
    .sort((left, right) => enUs(left) - enUs(right) || compareUtf8(left.uri, right.uri))
  for (const document of files) {
    let lineStart = 0
    for (const line of document.text.split('\n')) {
      const start = lineStart + (line.length - line.trimStart().length)
      lineStart += line.length + 1
      if (!document.text.startsWith(`${key}=`, start)) continue
      return { uri: document.uri, range: new LineIndex(document.text).range(start, start + key.length) }
    }
  }
  return undefined
}

/** Text views of a request by its documents, so a feature's later rounds do not read the texts again. */
const requestTextViews = new WeakMap<LanguageDocument, { readonly others: readonly LanguageDocument[]; readonly complete: boolean; readonly view: WorkspaceView }>()

function fallbackWorkspaceView(
  document: LanguageDocument,
  others: readonly LanguageDocument[],
  /** The snapshot holds the whole chain: only then can an id be absent from it. */
  complete: boolean,
): WorkspaceView {
  const known = requestTextViews.get(document)
  if (known !== undefined && known.others === others && known.complete === complete) return known.view
  const view = textWorkspaceView(document, others, complete)
  requestTextViews.set(document, { others, complete, view })
  return view
}

function textWorkspaceView(
  document: LanguageDocument,
  others: readonly LanguageDocument[],
  complete: boolean,
): WorkspaceView {
  const sameLanguage = others.filter(other => other.languageId === document.languageId)
  const rest = sameLanguage.filter(other => other.uri !== document.uri)
  const base = keptForDocuments(otherDocumentViews, rest, () => readCatalogTexts(rest.map(other => other.text)))
  // The edited document goes on top: copies, so the kept view stays as its documents say.
  const own = readCatalogTexts([document.text])
  const ids = new Map(base.ids)
  for (const [namespace, set] of own.ids) ids.set(namespace, new Set([...(base.ids.get(namespace) ?? []), ...set]))
  const entities = new Map(base.entities)
  for (const [entityId, record] of own.entities) {
    const prior = base.entities.get(entityId)
    entities.set(
      entityId,
      prior === undefined
        ? record
        : { ...prior, ...record, data: new Map([...prior.data, ...record.data]) },
    )
  }
  return mapView({
    idsByNamespace: ids,
    entities,
    populated: sameLanguage.length > 0,
    // A snapshot cut short (a dependency's documents left out) would call Marine unresolved.
    authoritative: sameLanguage.length > 0 && complete,
  })
}

interface SemanticInputLike {
  readonly kind: string
  readonly id?: string
  readonly revision?: string
  readonly payload?: unknown
}

interface WorkspaceContextLike {
  readonly id?: string
  readonly revision?: string
  readonly semanticComplete?: boolean
  readonly semanticInputs?: readonly SemanticInputLike[]
  readonly documentOrigins?: readonly {
    readonly uri: string
    readonly layerId: string
    readonly logicalId: string
    readonly precedence: number
  }[]
}

function workspaceContextOf(request: LanguageFeatureRequest): WorkspaceContextLike | undefined {
  return (request as LanguageFeatureRequest & { readonly workspaceContext?: WorkspaceContextLike })
    .workspaceContext
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function sourceKey(value: unknown): string | undefined {
  const source = recordOf(value)
  const rootId = source?.['rootId']
  const path = source?.['path']
  const documentIndex = source?.['documentIndex']
  return typeof rootId === 'string' && typeof path === 'string' && typeof documentIndex === 'number'
    ? `${rootId}\0${path}\0${documentIndex}`
    : undefined
}

function entitySource(value: unknown): EntitySource | undefined {
  const source = recordOf(value)
  const rootId = source?.['rootId']
  const path = source?.['path']
  const documentIndex = source?.['documentIndex']
  const range = recordOf(source?.['range'])
  const line = range?.['line']
  const column = range?.['column']
  return typeof rootId === 'string' && typeof path === 'string' && typeof documentIndex === 'number'
    ? {
        rootId,
        path,
        documentIndex,
        ...(typeof line === 'number' ? { line } : {}),
        ...(typeof column === 'number' ? { column } : {}),
      }
    : undefined
}

function entityTokens(value: unknown): readonly EntityToken[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tokens = value.flatMap(item => {
    const token = recordOf(item)
    const id = token?.['id']
    if (typeof id !== 'string' || id.length === 0) return []
    const type = token?.['type']
    const tokenValue = token?.['value']
    return [
      {
        id,
        ...(typeof type === 'string' ? { type } : {}),
        ...(typeof tokenValue === 'string' ? { value: tokenValue } : {}),
      },
    ]
  })
  return tokens.length === 0 ? undefined : tokens
}

function editorCategoryView(
  payload: Readonly<Record<string, unknown>>,
): EditorCategoryView | undefined {
  const owner = recordOf(payload['ownerMetadata'])
  const starcraft2 = recordOf(owner?.['starcraft2'])
  const editorCategories = recordOf(starcraft2?.['editorCategories'])
  const categories = recordOf(editorCategories?.['categories'])
  const objectUsage = recordOf(editorCategories?.['objectUsage'])
  if (categories === undefined || objectUsage === undefined) return undefined

  const valuesByName = new Map<string, readonly string[]>()
  for (const [name, value] of Object.entries(categories)) {
    if (!Array.isArray(value)) continue
    valuesByName.set(
      name,
      value.filter((item): item is string => typeof item === 'string'),
    )
  }
  const applicableByNamespace = new Map<
    string,
    readonly { readonly name: string; readonly values: string[] }[]
  >()
  for (const [namespace, value] of Object.entries(objectUsage)) {
    const usage = recordOf(value)
    const objects = usage?.['objects']
    if (!Array.isArray(objects)) continue
    const applicable = objects.flatMap(item => {
      const entry = recordOf(item)
      const category = entry?.['category']
      if (entry?.['source'] !== 'External' || typeof category !== 'string') return []
      return [{ name: category, values: [...(valuesByName.get(category) ?? [])] }]
    })
    applicableByNamespace.set(namespace, applicable)
  }
  return valuesByName.size === 0 && applicableByNamespace.size === 0
    ? undefined
    : { valuesByName, applicableByNamespace }
}

/** A document a loaded mod's server named: its layer, its layer-relative path, the host's URI. */
interface ServerDocument {
  readonly layerId: string
  readonly path: string
  readonly uri?: string
}

/**
 * Project canonical index rows and provenance; current request completeness is applied at lookup.
 * Rows from a loaded mod's server name their documents through `documentOf` (by the index's own
 * document number): a source then carries the layer, its layer-relative path and the host's URI.
 */
function authoringIndexView(
  payload: Readonly<Record<string, unknown>>,
  documentOf?: (sourceDocument: number) => ServerDocument | undefined,
): WorkspaceView | undefined {
  const rows = payload['entities']
  const rawSources = payload['sourceTable']
  if (!Array.isArray(rows) || !Array.isArray(rawSources) ||
    (payload['schemaVersion'] !== 1 && payload['schemaVersion'] !== 2) ||
    (payload['schemaVersion'] === 2 && !Array.isArray(payload['sourceDocuments']))) return undefined
  const index = payload as unknown as ResolvedDataAuthoringIndex
  const sources = rawSources.map((raw, position): EntitySource | undefined => {
    const source = entitySource(dataAuthoringSource(index, position))
    const document = documentOf === undefined || !Array.isArray(raw) || typeof raw[0] !== 'number'
      ? undefined
      : documentOf(raw[0])
    return source === undefined || document === undefined
      ? source
      : {
          ...source,
          rootId: document.layerId,
          path: document.path,
          ...(document.uri === undefined ? {} : { uri: document.uri }),
        }
  })
  const ids = new Map<string, Set<string>>()
  const entities = new Map<string, EntityRecord>()
  for (const value of rows) {
    const row = recordOf(value)
    const namespace = row?.['namespace']
    const typeId = row?.['typeId']
    const id = row?.['entityId']
    const source = row?.['source']
    if (
      row === undefined ||
      typeof namespace !== 'string' ||
      typeof typeId !== 'string' ||
      typeof id !== 'string' ||
      typeof source !== 'number'
    ) {
      continue
    }
    let namespaceIds = ids.get(namespace)
    if (namespaceIds === undefined) {
      namespaceIds = new Set()
      ids.set(namespace, namespaceIds)
    }
    if (!isAnonymousEntityId(id)) namespaceIds.add(id)
    const data = new Map<string, unknown>()
    const fieldOrigins = new Map<string, string>()
    const fields = row['fields']
    if (Array.isArray(fields)) {
      for (const item of fields) {
        const field = recordOf(item)
        const fieldId = field?.['fieldId']
        const origin = field?.['originEntityId']
        if (typeof fieldId !== 'string' || !('value' in (field ?? {}))) continue
        data.set(fieldId, field?.['value'])
        if (typeof origin === 'string') fieldOrigins.set(fieldId, origin)
      }
    }
    const parent = row['parentEntityId']
    const tokens = entityTokens(row['tokens'])
    entities.set(entityKey(namespace, id), {
      namespace,
      entityId: id,
      classTag: typeId,
      ...(typeof parent === 'string' ? { parent } : {}),
      data,
      fieldOrigins,
      ...(sources[source] === undefined ? {} : { definitionSource: sources[source] }),
      ...(row['defaultTemplate'] === true ? { defaultTemplate: true } : {}),
      ...(tokens === undefined ? {} : { tokens }),
    })
  }
  const chainFor = (entity: EntityRecord): readonly string[] => {
    const chain: string[] = []
    const seen = new Set<string>()
    let current: EntityRecord | undefined = entity
    while (current !== undefined && !seen.has(current.entityId) && chain.length < 256) {
      seen.add(current.entityId)
      chain.unshift(current.entityId)
      current =
        current.parent === undefined
          ? undefined
          : entities.get(entityKey(current.namespace, current.parent))
    }
    return chain
  }
  for (const [key, entity] of entities) {
    entities.set(key, { ...entity, inheritanceChain: chainFor(entity) })
  }
  const editorCategories = payload === undefined ? undefined : editorCategoryView(payload)
  return mapView({
    idsByNamespace: ids,
    entities,
    populated: rows.length > 0,
    authoritative: payload['complete'] === true && payload['valuesComplete'] === true,
    ...(editorCategories === undefined ? {} : { editorCategories }),
  })
}

/*
 * The loaded mod's server (owner decision 07.10). A request whose document belongs to a loaded mod
 * names that mod's server (`workspaceContext.modContext`); the provider asks it through the port it
 * was activated with (`ContributionContext.modContexts`) for what the feature needs and nothing
 * else. The feature runs against a view that answers from what the server has said and notes what
 * it has not been asked yet; those notes become one `data.language` question, and the feature runs
 * again on the answer. A hover asks once: its entity with the ancestors, the strings it shows.
 */

/** The host's port to the loaded mod servers (`ContributionContext.modContexts`). */
export interface ModServerPort {
  query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown>
}

/** What a feature reads: the catalog view, GameStrings by key, and whether its answer may be partial. */
interface FeatureData {
  readonly view: WorkspaceView | undefined
  readonly strings: ReadonlyMap<string, string> | undefined
  /** Whether a string key exists anywhere; only where an answer can prove that one does not. */
  readonly hasString: ((key: string) => boolean) | undefined
  readonly incomplete: boolean
}

/** Whether a frozen Data document parses strictly; a retained input is the same object across requests. */
const strictParses = new WeakMap<LanguageDocument, boolean>()

/**
 * Whether the catalog parser reads this Data document. One that it refuses (a line being typed)
 * leaves the catalog unfinished, as the mod server's Data session marks it: the snapshot's answers
 * may then be partial, and a rename is refused rather than missing what that document declares.
 */
function parsesStrictly(document: LanguageDocument): boolean {
  const known = strictParses.get(document)
  if (known !== undefined) return known
  let parses = true
  try {
    parseCatalogXmlElements(document.text)
  } catch {
    parses = false
  }
  if (Object.isFrozen(document)) strictParses.set(document, parses)
  return parses
}

/**
 * The data of a request no loaded mod's server answers (a file outside any mod, a host without the
 * port): only its own snapshot, so the features read the documents it holds. A Data document the
 * catalog parser refuses makes it incomplete, as the server's session would.
 */
function snapshotData(request: LanguageFeatureRequest): FeatureData {
  const incomplete =
    languageWorkspaceIsSemanticallyIncomplete(request) ||
    [request.document, ...request.workspaceDocuments].some(
      document => document.languageId === SC2_DATA_LANGUAGE_ID && !parsesStrictly(document),
    )
  return {
    view: undefined,
    strings: snapshotStrings(request.workspaceDocuments),
    hasString: incomplete ? undefined : snapshotStringKeys(request.workspaceDocuments),
    incomplete,
  }
}

/** Rounds of questions one feature may ask: a feature that still misses data after them is a defect. */
const SERVER_ROUNDS = 6
/** References, keys or Data spaces one part of a question carries; more wait for the next round. */
const SERVER_PART_LIMIT = 16_384
const SERVER_NAMESPACE_LIMIT = 64

/** What the server answered for one request so far: null marks what it said does not exist. */
interface ServerAnswers {
  /** Conservative cumulative UTF-16 wire size; charged only when a new reply is merged. */
  retainedBytes: number
  revision?: string
  complete?: boolean
  readonly entities: Map<string, EntityRecord | null>
  readonly ids: Map<string, ReadonlySet<string>>
  readonly summaries: Map<string, ReadonlyMap<string, EntitySummary>>
  readonly defaults: Map<string, readonly string[]>
  readonly exists: Map<string, { readonly known: boolean; readonly defaultTemplate: boolean }>
  readonly heirs: Map<string, number>
  metadata?: EditorCategoryView | null
  readonly strings: Map<string, string | null>
  readonly search: Map<string, readonly EntityRecord[]>
  /** Declaration ranges by [layerId, path, namespace, entityId]; null when the document has none. */
  readonly declarations: Map<string, LanguageRange | null>
  /** The chain's `<const>` aliases, once asked. */
  constAliases?: ReadonlySet<string>
}

/** What one round of a feature missed. */
interface ServerAsk {
  readonly entities: Map<string, { readonly namespace: string; readonly entityId: string }>
  readonly ids: Set<string>
  readonly summaries: Set<string>
  readonly defaults: Set<string>
  readonly exists: Map<string, { readonly namespace: string; readonly entityId: string }>
  readonly heirs: Map<string, { readonly namespace: string; readonly entityId: string }>
  readonly strings: Set<string>
  readonly declarations: Map<string, { readonly layerId: string; readonly path: string; readonly namespace: string; readonly entityId: string }>
  metadata: boolean
  constAliases: boolean
  search?: string
  status: boolean
}

const refOfKey = (key: string): { readonly namespace: string; readonly entityId: string } => {
  const at = key.indexOf('\0')
  return { namespace: key.slice(0, at), entityId: key.slice(at + 1) }
}

/** A map read by key whose misses become questions; walking it is not something a server answers. */
class AskingMap<V> implements ReadonlyMap<string, V> {
  constructor(
    private readonly known: ReadonlyMap<string, V | null>,
    private readonly miss: (key: string) => void,
  ) {}

  get(key: string): V | undefined {
    const value = this.known.get(key)
    if (value === undefined) {
      this.miss(key)
      return undefined
    }
    return value ?? undefined
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  get size(): number {
    return AskingMap.walk()
  }

  forEach(): void {
    AskingMap.walk()
  }

  entries(): never {
    return AskingMap.walk()
  }

  keys(): never {
    return AskingMap.walk()
  }

  values(): never {
    return AskingMap.walk()
  }

  [Symbol.iterator](): never {
    return AskingMap.walk()
  }

  private static walk(): never {
    throw new TypeError('a loaded mod is asked by key; a feature walking its whole catalog is a defect')
  }
}

/** The view one round reads: what the server answered, the rest noted in `ask`. */
function serverView(answers: ServerAnswers, ask: ServerAsk, requestIncomplete: boolean): WorkspaceView {
  const entities = new AskingMap(answers.entities, key => {
    const ref = refOfKey(key)
    // An id no document can name (a template without one) is no question for the server.
    if (ref.entityId === '' || ref.namespace === '') answers.entities.set(key, null)
    else {
      ask.entities.set(key, ref)
      // How many inherit from it is a number per entity, and a lens asks it right after the entity.
      if (!answers.heirs.has(key)) ask.heirs.set(key, ref)
    }
  })
  const knownEntity = (namespace: string, id: string): EntityRecord | null | undefined =>
    answers.entities.get(entityKey(namespace, id))
  return {
    idsByNamespace: new AskingMap(answers.ids, namespace => ask.ids.add(namespace)),
    entities,
    populated: true,
    get authoritative() {
      if (answers.complete === undefined) {
        ask.status = true
        return false
      }
      return answers.complete && !requestIncomplete
    },
    get editorCategories() {
      if (answers.metadata === undefined) {
        ask.metadata = true
        return undefined
      }
      return answers.metadata ?? undefined
    },
    strings: new AskingMap(answers.strings, key => ask.strings.add(key)),
    hasId(namespace, id) {
      const known = knownEntity(namespace, id)
      if (known !== undefined) return known !== null
      const ids = answers.ids.get(namespace)
      if (ids !== undefined) return ids.has(id)
      const exists = answers.exists.get(entityKey(namespace, id))
      if (exists !== undefined) return exists.known
      if (id !== '') ask.exists.set(entityKey(namespace, id), { namespace, entityId: id })
      return false
    },
    templateOf(namespace, id) {
      const known = knownEntity(namespace, id)
      if (known !== undefined) return known === null ? undefined : known.defaultTemplate === true
      const exists = answers.exists.get(entityKey(namespace, id))
      if (exists !== undefined) return exists.known ? exists.defaultTemplate : undefined
      if (id !== '') ask.exists.set(entityKey(namespace, id), { namespace, entityId: id })
      return undefined
    },
    heirCount(namespace, id) {
      const count = answers.heirs.get(entityKey(namespace, id))
      if (count !== undefined) return count
      if (id !== '') ask.heirs.set(entityKey(namespace, id), { namespace, entityId: id })
      return 0
    },
    defaultTemplateIds(namespace) {
      const ids = answers.defaults.get(namespace)
      if (ids !== undefined) return ids
      ask.defaults.add(namespace)
      return []
    },
    summary(namespace, id) {
      const summaries = answers.summaries.get(namespace)
      if (summaries !== undefined) return summaries.get(id)
      ask.summaries.add(namespace)
      return undefined
    },
    matching(needle) {
      const found = answers.search.get(needle)
      if (found !== undefined) return found
      ask.search = needle
      return []
    },
    declarationRange(source, namespace, id) {
      // Only a document the server named (by its layer) is one it can read.
      if (source.uri === undefined || id === '') return undefined
      const key = JSON.stringify([source.rootId, source.path, namespace, id])
      const known = answers.declarations.get(key)
      if (known !== undefined) return known ?? undefined
      ask.declarations.set(key, { layerId: source.rootId, path: source.path, namespace, entityId: id })
      return undefined
    },
    constAliases() {
      if (answers.constAliases !== undefined) return answers.constAliases
      ask.constAliases = true
      return undefined
    },
  }
}

const emptyAsk = (): ServerAsk => ({
  entities: new Map(),
  ids: new Set(),
  summaries: new Set(),
  defaults: new Set(),
  exists: new Map(),
  heirs: new Map(),
  strings: new Set(),
  declarations: new Map(),
  metadata: false,
  constAliases: false,
  status: false,
})

/** The locales the request reads strings in (its `locale-set` input), preferred first. */
function requestLocales(request: LanguageFeatureRequest): readonly string[] | undefined {
  const input = workspaceContextOf(request)?.semanticInputs?.find(item => item.kind === 'locale-set')
  const locales = recordOf(input?.payload)?.['locales']
  return Array.isArray(locales) && locales.length > 0 && locales.every(locale => typeof locale === 'string')
    ? (locales as readonly string[])
    : undefined
}

/** One `data.language` question for what a round missed, or nothing when it missed nothing. */
function serverQuestion(ask: ServerAsk, locales: readonly string[] | undefined): Readonly<Record<string, unknown>> | undefined {
  const first = <T>(values: Iterable<T>, limit = SERVER_PART_LIMIT): T[] => [...values].slice(0, limit)
  const question: Record<string, unknown> = { kind: 'data.language' }
  if (ask.entities.size > 0) question['authoring'] = { refs: first(ask.entities.values()), chains: true }
  if (ask.ids.size > 0) question['ids'] = first(ask.ids, SERVER_NAMESPACE_LIMIT)
  if (ask.summaries.size > 0) question['summaries'] = first(ask.summaries, SERVER_NAMESPACE_LIMIT)
  if (ask.defaults.size > 0) question['defaults'] = first(ask.defaults, SERVER_NAMESPACE_LIMIT)
  if (ask.exists.size > 0) question['exists'] = first(ask.exists.values())
  if (ask.heirs.size > 0) question['heirs'] = first(ask.heirs.values())
  if (ask.metadata) question['metadata'] = true
  if (ask.strings.size > 0) {
    question['strings'] = { keys: first(ask.strings), ...(locales === undefined ? {} : { locales }) }
  }
  if (ask.search !== undefined) question['search'] = { needle: ask.search, limit: 65_536 }
  if (ask.declarations.size > 0) question['declarations'] = first(ask.declarations.values())
  if (ask.constAliases) question['constAliases'] = true
  return Object.keys(question).length > 1 || ask.status ? question : undefined
}

/** Take a server's answer into what the request knows. */
function mergeServerAnswer(answers: ServerAnswers, question: Readonly<Record<string, unknown>>, answer: unknown): void {
  const record = recordOf(answer)
  if (record === undefined || typeof record['revision'] !== 'string' || typeof record['complete'] !== 'boolean') {
    throw new TypeError('the loaded mod answered a data.language question without its revision and completeness')
  }
  answers.revision = record['revision']
  answers.complete = record['complete']
  // Charge new replies, never reserialize the accumulated catalog on a warm request. Repeated
  // metadata is deliberately overcounted: dropping a derived cache only causes another query.
  answers.retainedBytes += JSON.stringify(answer).length * 2
  const documents: (ServerDocument | undefined)[] = (Array.isArray(record['documents']) ? record['documents'] : []).map(item => {
    const document = recordOf(item)
    const layerId = document?.['layerId']
    const path = document?.['path']
    const uri = document?.['uri']
    return typeof layerId === 'string' && typeof path === 'string'
      ? { layerId, path, ...(typeof uri === 'string' ? { uri } : {}) }
      : undefined
  })
  const documentAt = (value: unknown): ServerDocument | undefined =>
    typeof value === 'number' ? documents[value] : undefined
  const asked = <T>(part: string): readonly T[] => {
    const value = question[part]
    const list = recordOf(value)?.['refs'] ?? recordOf(value)?.['keys'] ?? value
    return Array.isArray(list) ? (list as readonly T[]) : []
  }

  const constAliases = record['constAliases']
  if (Array.isArray(constAliases) && constAliases.every(item => typeof item === 'string')) {
    answers.constAliases = new Set(constAliases as readonly string[])
  }
  const declarations = record['declarations']
  if (Array.isArray(declarations)) {
    asked<{ layerId: string; path: string; namespace: string; entityId: string }>('declarations').forEach((item, at) => {
      const range = recordOf(declarations[at])
      answers.declarations.set(
        JSON.stringify([item.layerId, item.path, item.namespace, item.entityId]),
        range === undefined ? null : (range as unknown as LanguageRange),
      )
    })
  }
  const index = recordOf(record['index'])
  if (index !== undefined) {
    const indexDocuments = Array.isArray(record['indexDocuments']) ? record['indexDocuments'] : []
    const view = authoringIndexView(index, sourceDocument => documentAt(indexDocuments[sourceDocument]))
    if (view === undefined) throw new TypeError('the loaded mod answered with an authoring index this provider cannot read')
    for (const [key, entity] of view.entities as ReadonlyMap<string, EntityRecord>) answers.entities.set(key, entity)
  }
  for (const ref of asked<{ namespace: string; entityId: string }>('authoring')) {
    const key = entityKey(ref.namespace, ref.entityId)
    if (!answers.entities.has(key)) answers.entities.set(key, null)
  }
  for (const [namespace, ids] of Object.entries(recordOf(record['ids']) ?? {})) {
    if (!Array.isArray(ids)) continue
    answers.ids.set(namespace, new Set(ids.filter((id): id is string => typeof id === 'string' && !isAnonymousEntityId(id))))
  }
  for (const [namespace, value] of Object.entries(recordOf(record['summaries']) ?? {})) {
    const summary = recordOf(value)
    const ids = summary?.['ids']
    const types = summary?.['types']
    const places = summary?.['documents']
    if (!Array.isArray(ids) || !Array.isArray(types) || !Array.isArray(places)) continue
    const byId = new Map<string, EntitySummary>()
    ids.forEach((id, at) => {
      const classTag = types[at]
      if (typeof id !== 'string' || typeof classTag !== 'string') return
      const path = documentAt(places[at])?.path
      byId.set(id, { classTag, ...(path === undefined ? {} : { path }) })
    })
    answers.summaries.set(namespace, byId)
  }
  for (const [namespace, ids] of Object.entries(recordOf(record['defaults']) ?? {})) {
    if (Array.isArray(ids)) answers.defaults.set(namespace, ids.filter((id): id is string => typeof id === 'string'))
  }
  const exists = Array.isArray(record['exists']) ? record['exists'] : []
  asked<{ namespace: string; entityId: string }>('exists').forEach((ref, at) => {
    const answer = recordOf(exists[at])
    answers.exists.set(entityKey(ref.namespace, ref.entityId), {
      known: answer?.['known'] === true,
      defaultTemplate: answer?.['defaultTemplate'] === true,
    })
  })
  const heirs = Array.isArray(record['heirs']) ? record['heirs'] : []
  asked<{ namespace: string; entityId: string }>('heirs').forEach((ref, at) => {
    const count = heirs[at]
    answers.heirs.set(entityKey(ref.namespace, ref.entityId), typeof count === 'number' ? count : 0)
  })
  if (question['metadata'] === true) {
    const metadata = recordOf(record['metadata'])
    answers.metadata = metadata === undefined ? null : (editorCategoryView({ ownerMetadata: metadata }) ?? null)
  }
  const strings = Array.isArray(record['strings']) ? record['strings'] : []
  for (const value of strings) {
    const entry = recordOf(value)
    const key = entry?.['key']
    const text = entry?.['value']
    if (typeof key === 'string' && typeof text === 'string') answers.strings.set(key, text)
  }
  for (const key of asked<string>('strings')) if (!answers.strings.has(key)) answers.strings.set(key, null)
  const search = recordOf(question['search'])
  if (search !== undefined && typeof search['needle'] === 'string') {
    const rows = Array.isArray(record['search']) ? record['search'] : []
    answers.search.set(
      search['needle'],
      rows.flatMap((value): EntityRecord[] => {
        const row = recordOf(value)
        const namespace = row?.['namespace']
        const entityId = row?.['entityId']
        const classTag = row?.['typeId']
        if (typeof namespace !== 'string' || typeof entityId !== 'string' || typeof classTag !== 'string') return []
        const document = documentAt(row?.['document'])
        const line = row?.['line']
        const column = row?.['column']
        return [{
          namespace,
          entityId,
          classTag,
          data: new Map(),
          ...(document === undefined
            ? {}
            : {
                definitionSource: {
                  rootId: document.layerId,
                  path: document.path,
                  documentIndex: row?.['document'] as number,
                  ...(typeof line === 'number' ? { line } : {}),
                  ...(typeof column === 'number' ? { column } : {}),
                  ...(document.uri === undefined ? {} : { uri: document.uri }),
                },
              }),
        }]
      }),
    )
  }
}

/** The loaded mod's server a request names, if any, and the server's revision it was synchronized at. */
function requestModContext(request: LanguageFeatureRequest): { readonly scope: string; readonly revision?: string } | undefined {
  const modContext = recordOf((workspaceContextOf(request) as { readonly modContext?: unknown } | undefined)?.modContext)
  const scope = modContext?.['scope']
  const revision = modContext?.['revision']
  return typeof scope === 'string' && scope !== ''
    ? { scope, ...(typeof revision === 'string' ? { revision } : {}) }
    : undefined
}

const emptyAnswers = (): ServerAnswers => ({
  retainedBytes: 0,
  entities: new Map(),
  ids: new Map(),
  summaries: new Map(),
  defaults: new Map(),
  exists: new Map(),
  heirs: new Map(),
  strings: new Map(),
  search: new Map(),
  declarations: new Map(),
})

/** States of a provider's servers by scope, revision and ordered locale preference, the latest few. */
type KeptAnswers = Map<string, ServerAnswers>
const KEPT_STATES = 4
/** A state with more entities than this is not kept: a lens pass over a stock catalog file. */
const KEPT_ENTITIES = 50_000
/** Search needles otherwise grow forever at one revision, even when every result is empty. */
const KEPT_SEARCHES = 64
/** Reply payload estimate per state, not a measured heap size or an active-request result limit. */
const KEPT_REPLY_BYTES = 16 * 1_024 * 1_024

/** Keep only bounded derived answers under the revision/locale key they actually represent. */
function retainServerAnswers(kept: KeptAnswers, key: string, answers: ServerAnswers): void {
  const retain = answers.entities.size <= KEPT_ENTITIES &&
    answers.search.size <= KEPT_SEARCHES && answers.retainedBytes <= KEPT_REPLY_BYTES
  for (const [oldKey, value] of kept) {
    if (value === answers && (oldKey !== key || !retain)) kept.delete(oldKey)
  }
  if (!retain) return
  kept.delete(key)
  kept.set(key, answers)
  while (kept.size > KEPT_STATES) kept.delete(kept.keys().next().value!)
}

/**
 * What a server said at one revision and locale order stays true until either changes. A second
 * hover asks nothing, but switching languages must not reuse translations from the previous order.
 */
function keptAnswers(kept: KeptAnswers, scope: string, revision: string | undefined, locales: readonly string[] | undefined): ServerAnswers {
  const key = revision === undefined ? undefined : JSON.stringify([scope, revision, locales])
  const answers = (key === undefined ? undefined : kept.get(key)) ?? emptyAnswers()
  if (key !== undefined) {
    retainServerAnswers(kept, key, answers)
  }
  return answers
}

/**
 * Run a feature on what the loaded mod's server answers: each round notes what the feature missed,
 * one question asks for all of it, and the feature runs again until it misses nothing. Without a
 * server (no loaded mod, a host that gives no port) the feature reads the request's own inputs.
 */
async function withData<T>(
  request: LanguageFeatureRequest,
  server: { readonly port: ModServerPort | undefined; readonly kept: KeptAnswers },
  run: (data: FeatureData) => T | Promise<T>,
  /** The feature needs only to know whether the answer is whole: ask that before running it once. */
  statusFirst = false,
): Promise<T> {
  const modContext = requestModContext(request)
  const port = server.port
  if (port === undefined || modContext === undefined) return run(snapshotData(request))
  const requestIncomplete = languageWorkspaceIsSemanticallyIncomplete(request)
  const locales = requestLocales(request)
  let answers = keptAnswers(server.kept, modContext.scope, modContext.revision, locales)
  /** Ask, and keep the answer with the state of the revision it reflects. */
  const ask = async (question: Readonly<Record<string, unknown>>): Promise<void> => {
    request.signal?.throwIfAborted()
    const answer = await port.query(modContext.scope, question, request.signal)
    const revision = recordOf(answer)?.['revision']
    // The server moved on since this request's state (another buffer's edit): start from that revision.
    if (typeof revision === 'string' && answers.revision !== undefined && answers.revision !== revision) {
      answers = keptAnswers(server.kept, modContext.scope, revision, locales)
    }
    mergeServerAnswer(answers, question, answer)
    // Kept under the revision the answers reflect.
    const key = answers.revision === undefined ? undefined : JSON.stringify([modContext.scope, answers.revision, locales])
    if (key !== undefined) retainServerAnswers(server.kept, key, answers)
  }
  if (statusFirst && answers.complete === undefined) await ask({ kind: 'data.language' })
  for (let round = 0; ; round += 1) {
    const missed = emptyAsk()
    const state = answers
    const view = serverView(state, missed, requestIncomplete)
    const incomplete = (): boolean => {
      if (state.complete === undefined) {
        missed.status = true
        return true
      }
      return requestIncomplete || !state.complete
    }
    const result = await run({
      view,
      strings: view.strings,
      get hasString() {
        return incomplete() ? undefined : (key: string) => view.strings?.get(key) !== undefined
      },
      get incomplete() {
        return incomplete()
      },
    })
    const question = serverQuestion(missed, locales)
    if (question === undefined) return result
    if (round >= SERVER_ROUNDS) {
      throw new Error(`the loaded mod's answers did not settle after ${SERVER_ROUNDS} questions`)
    }
    await ask(question)
  }
}

const COMPLETION_KIND = Object.freeze({
  fields: 'field',
  classes: 'class',
  attributes: 'property',
  values: 'enum',
  assets: 'file',
} as const)

function completionItems(
  result: ReturnType<typeof computeCompletions>,
  index: LineIndex,
  text: string,
  offset: number,
  contentPaths: readonly string[],
  describeLink?: (namespace: string, id: string) => { readonly detail?: string; readonly name?: string },
): readonly LanguageCompletionItem[] {
  if (result.kind === 'none') return []
  const replacementRange = index.range(result.replaceStart, result.replaceEnd)
  if (result.kind === 'fields' || result.kind === 'attributes') {
    const candidates = result.kind === 'fields' ? result.fields : result.attributes
    return candidates.map(candidate => ({
      label: candidate.name,
      kind: COMPLETION_KIND[result.kind],
      detail: fieldTypeLabel(candidate.info),
      documentation: fieldDoc(candidate.info, '', candidate.name),
      replacementRange,
      ...(result.kind === 'attributes'
        ? { insertText: `${candidate.name}="$0"`, insertTextFormat: 'snippet' as const }
        : result.snippet
          ? {
              insertText: `${result.lead ? '<' : ''}${fieldElementBody(candidate)}`,
              insertTextFormat: 'snippet' as const,
            }
          : { insertText: candidate.name, insertTextFormat: 'plain-text' as const }),
    }))
  }
  if (result.kind === 'classes') {
    const structures = new Set(result.structures ?? [])
    return [...result.classes, ...structures].map(name => {
      const structure = structures.has(name)
      return {
        label: name,
        kind: name === 'const' ? 'constant' : structure ? 'struct' : COMPLETION_KIND.classes,
        detail:
          name === 'Catalog'
            ? 'GameData document root'
            : name === 'const'
              ? 'catalog constant'
              : structure
                ? 'structure default'
                : 'catalog class',
        documentation: `[Reference](${DEFAULT_DOCS_URL}#${name})`,
        replacementRange,
        sortText: `0_${name}`,
        ...(result.snippet
          ? {
              insertText: `${result.lead ? '<' : ''}${rootElementBody(name, structure)}`,
              insertTextFormat: 'snippet' as const,
            }
          : { insertText: name, insertTextFormat: 'plain-text' as const }),
      }
    })
  }
  if (result.kind === 'values') {
    const preferred = new Set(result.preferred ?? [])
    // An entity link describes its target — class, file, name — not the field type (parity plan 1.3).
    const linked =
      result.info.kind === 'link' && result.info.linkNamespace && !result.info.isTextLink && !result.info.isFileLink
        ? result.info.linkNamespace
        : undefined
    return result.values.map(value => {
      const target = linked === undefined ? undefined : describeLink?.(linked, value)
      return {
      label: value,
      // A default template reads as a constant, as MK2 showed it (plan 1.2).
      kind: preferred.has(value) ? 'constant' : COMPLETION_KIND.values,
      detail: preferred.has(value) ? 'default template' : (target?.detail ?? fieldTypeLabel(result.info)),
      documentation: [target?.name === undefined ? undefined : `**${target.name}**`, fieldDoc(result.info, '', value)]
        .filter(Boolean)
        .join('\n\n'),
      insertText: result.quote === true ? `"${value}"` : value,
      insertTextFormat: 'plain-text',
      replacementRange,
      // A template entity a `parent` may name is offered before the rest, as MK2 marked it.
      ...(preferred.has(value) ? { sortText: `0_${value}` } : {}),
      }
    })
  }
  const extensions = result.extensions.map(extension => extension.toLowerCase())
  const prefix = text.slice(result.replaceStart, offset).replaceAll('\\', '/').toLowerCase()
  const matchingPaths = contentPaths
    .filter(
      path =>
        extensions.length === 0 ||
        extensions.some(extension => path.toLowerCase().endsWith(extension)),
    )
    .map(path => path.replaceAll('/', '\\'))
    .filter(path => path.replaceAll('\\', '/').toLowerCase().startsWith(prefix))
  // Only files that exist; a bare `.dds` is not a path anyone can use (parity plan 1.4).
  return matchingPaths.map(label => ({
    label,
    kind: COMPLETION_KIND.assets,
    detail: 'content asset',
    insertText: label,
    insertTextFormat: 'plain-text',
    replacementRange,
    // A picture the host draws when the item is resolved, not in the list.
    ...(PICTURE_PATH.test(label) ? { asset: { path: label } } : {}),
  }))
}

/** A picture the host can draw for a path the game spells (`Assets\Textures\btn-unit-terran-marine.dds`). */
const PICTURE_PATH = /\.(?:dds|tga|png|jpe?g)$/iu

/** The texture path in the attribute value under the caret, as the document spells it. */
function texturePathAt(text: string, offset: number): string | undefined {
  const value = attrAt(elementPathAt(text, offset).at(-1) as never, offset)?.value.trim()
  return value !== undefined && PICTURE_PATH.test(value) ? value : undefined
}

/** The host's `dependency-closure` layers: where each layer of the mod context lives, weaker first. */
function contextLayers(request: LanguageFeatureRequest, pathIndexId?: string): readonly (Readonly<Record<string, unknown>> | undefined)[] {
  const inputs = workspaceContextOf(request)?.semanticInputs?.filter(item => item.kind === 'dependency-closure') ?? []
  const input = (pathIndexId === undefined ? undefined : inputs.find(item =>
    pathIndexId === item.id || pathIndexId.startsWith(`${item.id}/paths/`))) ?? inputs[0]
  const layers = recordOf(input?.payload)?.['layers']
  return Array.isArray(layers) ? layers.map(recordOf) : []
}

/** A layer's file as the host addresses it, open or not: `content-source://<source>/<layer path>/<path>`. */
function layerFileUri(layer: Readonly<Record<string, unknown>> | undefined, path: string): string | undefined {
  const sourceId = layer?.['sourceId']
  const sourcePath = layer?.['sourcePath']
  if (typeof sourceId !== 'string' || typeof sourcePath !== 'string') return undefined
  const segments = [...sourcePath.split('/'), ...path.split('/')].filter(segment => segment !== '')
  return `content-source://${encodeURIComponent(sourceId)}/${segments.map(encodeURIComponent).join('/')}`
}

/**
 * An entity's declaration in a dependency the snapshot holds no document of (parity plan 1.10):
 * its layer's file at the line the analysis recorded.
 */
function layerDeclarationLocation(request: LanguageFeatureRequest, source: EntitySource): LanguageLocation | undefined {
  if (source.line === undefined) return undefined
  // The loaded mod's server named the file as the host addresses it.
  if (source.uri !== undefined) {
    const at = { line: source.line, character: source.column ?? 0 }
    return { uri: source.uri, range: { start: at, end: at } }
  }
  const uri = layerFileUri(contextLayers(request).find(layer => layer?.['layerId'] === source.rootId), source.path)
  const at = { line: source.line, character: source.column ?? 0 }
  return uri === undefined ? undefined : { uri, range: { start: at, end: at } }
}

/**
 * Where an entity is declared: the document its resolved source names, in the snapshot or in its
 * dependency layer (1.10), else the first snapshot document that declares it.
 */
function entityDeclaration(
  request: LanguageFeatureRequest,
  view: WorkspaceView | undefined,
  namespace: string,
  id: string,
  definitionRanges?: Map<LanguageDocument, ReadonlyMap<string, LanguageRange>>,
): LanguageLocation | undefined {
  const source = view?.entities.get(entityKey(namespace, id))?.definitionSource
  if (source !== undefined) {
    const document = documentForSource(request, source)
    const range = document === undefined ? undefined : entityDefinitionRange(document, namespace, id, definitionRanges)
    if (document !== undefined && range !== undefined) return { uri: document.uri, range }
    // A request the loaded mod's server answers holds no copy of the file: the server gives the range.
    const served = document === undefined ? view?.declarationRange?.(source, namespace, id) : undefined
    if (served !== undefined && source.uri !== undefined) return { uri: source.uri, range: served }
    const elsewhere = layerDeclarationLocation(request, source)
    if (elsewhere !== undefined) return elsewhere
  }
  for (const document of documentsOf(request)) {
    if (document.languageId !== SC2_DATA_LANGUAGE_ID) continue
    const range = entityDefinitionRange(document, namespace, id, definitionRanges)
    if (range !== undefined) return { uri: document.uri, range }
  }
  return undefined
}

/**
 * The file an asset path names (parity plan 1.12): the host's content path index lists every path
 * of the context with the layer it is read from, the strongest; the asset is the path that ends
 * with what the field spells (`Assets\Textures\x.dds` in `Base.SC2Assets/Assets/Textures/x.dds`).
 */
function assetFileLocation(request: LanguageFeatureRequest, assetPath: string): LanguageLocation | undefined {
  const wanted = assetPath.replaceAll('\\', '/').replace(/^\/+/u, '').toLowerCase()
  if (wanted === '') return undefined
  for (const input of workspaceContextOf(request)?.semanticInputs ?? []) {
    if (input.kind !== 'content-path-index') continue
    const index = recordOf(input.payload)
    const paths = index?.['paths']
    const owners = index?.['layers']
    if (!Array.isArray(paths) || !Array.isArray(owners)) continue
    const layers = contextLayers(request, input.id)
    for (const [at, path] of paths.entries()) {
      if (typeof path !== 'string') continue
      const folded = path.toLowerCase()
      if (folded !== wanted && !folded.endsWith(`/${wanted}`)) continue
      const owner = owners[at]
      const uri = typeof owner === 'number' ? layerFileUri(layers[owner], path) : undefined
      if (uri !== undefined) return { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }
    }
  }
  return undefined
}

function workspaceContentPaths(request: LanguageFeatureRequest): readonly string[] {
  const paths = new Set<string>()
  const context = workspaceContextOf(request)
  for (const input of context?.semanticInputs ?? []) {
    if (input.kind !== 'content-path-index') continue
    const payload = input.payload
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue
    const candidates = (payload as Readonly<Record<string, unknown>>)['paths']
    if (!Array.isArray(candidates)) continue
    for (const path of candidates) {
      if (typeof path !== 'string' || path.length === 0) continue
      const normalized = path.replaceAll('\\', '/')
      paths.add(normalized)
      const parts = normalized.split('/')
      const packageIndex = parts.findLastIndex(part =>
        /\.sc2(?:data|assets|map|mod|campaign)$/iu.test(part),
      )
      if (packageIndex >= 0 && packageIndex + 1 < parts.length) {
        paths.add(parts.slice(packageIndex + 1).join('/'))
      }
    }
  }
  return Object.freeze([...paths].sort())
}

const SEVERITY = Object.freeze({
  error: 'error',
  warning: 'warning',
  info: 'information',
} as const)

function symbolsOf(text: string, index: LineIndex): readonly LanguageSymbol[] {
  const symbols: LanguageSymbol[] = []
  const walk = (entity: ScannedElement) => {
    const id = getAttr(entity, 'id')
    const range = index.range(entity.start, entity.end)
    symbols.push({
      name: id?.value === undefined || id.value === '' ? entity.tag : id.value,
      kind: 'class',
      detail: entity.tag,
      range,
      // The id is the entity's name, so the outline selects it, not the class tag (plan 1.16).
      selectionRange:
        id === undefined || id.value === ''
          ? index.range(entity.tagStart, entity.tagEnd)
          : index.range(id.valueStart, id.valueEnd),
    })
  }
  for (const entity of catalogEntities(scanXml(text))) walk(entity)
  return symbols
}

/**
 * The primary document plus its neighbours, each counted once.
 *
 * A host may or may not put the open document into the snapshot it sends — both readings are in use
 * — so a scan that walks `[document, ...workspaceDocuments]` blindly reports every hit in the open
 * file twice. Deduplicating by uri is what makes the answer independent of that choice.
 */
function documentsOf(request: {
  readonly document: LanguageDocument
  readonly workspaceDocuments: readonly LanguageDocument[]
}): readonly LanguageDocument[] {
  const seen = new Set([request.document.uri])
  const documents = [request.document]
  for (const document of request.workspaceDocuments) {
    if (seen.has(document.uri)) continue
    seen.add(document.uri)
    documents.push(document)
  }
  return documents
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  const count = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < count; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0)
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

/** Map a resolver source back to the exact language document that produced it. */
function documentForSource(
  request: LanguageFeatureRequest,
  source: EntitySource,
): LanguageDocument | undefined {
  const documents = documentsOf(request).filter(
    document => document.languageId === SC2_DATA_LANGUAGE_ID,
  )
  // A source the loaded mod's server named is its document by URI, when the snapshot holds it.
  if (source.uri !== undefined) return documents.find(document => document.uri === source.uri)
  const origins = workspaceContextOf(request)?.documentOrigins ?? []
  const originsByUri = new Map(origins.map(origin => [origin.uri, origin]))
  const ordered = documents
    .flatMap(document => {
      const origin = originsByUri.get(document.uri)
      return origin === undefined ? [] : [{ document, origin }]
    })
    .sort(
      (left, right) =>
        left.origin.precedence - right.origin.precedence ||
        compareUtf8(left.origin.logicalId, right.origin.logicalId) ||
        compareUtf8(left.document.uri, right.document.uri),
    )
  const indexed = ordered[source.documentIndex]
  if (indexed?.origin.layerId === source.rootId && indexed.origin.logicalId === source.path) {
    return indexed.document
  }
  const exact = ordered.filter(
    item => item.origin.layerId === source.rootId && item.origin.logicalId === source.path,
  )
  return exact.length === 1 ? exact[0]?.document : undefined
}

/**
 * Every reference of an immutable document (the host's frozen capture, the same object while its
 * text is the same) grouped by entity, in text order, kept while the document lives: references,
 * rename and declaration ranges read the groups instead of scanning each catalog file again.
 */
const frozenReferences = new WeakMap<LanguageDocument, ReadonlyMap<string, readonly RefMatch[]>>()

/** One document's references grouped by entity (the canonical scanner's), kept when frozen. */
function referencesByEntity(document: LanguageDocument): ReadonlyMap<string, readonly RefMatch[]> {
  const kept = frozenReferences.get(document)
  if (kept !== undefined) return kept
  const grouped = new Map<string, RefMatch[]>()
  for (const ref of collectAllRefs(document.text)) {
    const key = entityKey(ref.namespace, ref.id)
    const group = grouped.get(key)
    if (group === undefined) grouped.set(key, [ref])
    else group.push(ref)
  }
  if (Object.isFrozen(document)) frozenReferences.set(document, grouped)
  return grouped
}

/** The references to one entity in a document, as `findReferences` gives them. */
function referencesIn(
  document: LanguageDocument,
  target: RefTarget,
  includeDeclaration: boolean,
): readonly RefMatch[] {
  const group = referencesByEntity(document).get(entityKey(target.namespace, target.id)) ?? []
  return includeDeclaration ? group : group.filter(ref => ref.kind !== 'definition')
}

/**
 * Declaration ranges of an immutable document, kept while the document lives: a lens pass over a
 * stock catalog file, a feature's later rounds and the next request read them instead of scanning
 * megabytes again.
 */
const frozenDefinitionRanges = new WeakMap<LanguageDocument, ReadonlyMap<string, LanguageRange>>()

/** Each declared entity's first declaration range in one document. */
function declarationRanges(document: LanguageDocument): ReadonlyMap<string, LanguageRange> {
  const index = new LineIndex(document.text)
  const collected = new Map<string, LanguageRange>()
  for (const [key, refs] of referencesByEntity(document)) {
    // Match the historical first-declaration lookup if this file declares an id twice.
    const first = refs.find(ref => ref.kind === 'definition')
    if (first !== undefined) collected.set(key, index.range(first.start, first.end))
  }
  return collected
}

function entityDefinitionRange(
  document: LanguageDocument,
  namespace: string,
  id: string,
  definitionRanges?: Map<LanguageDocument, ReadonlyMap<string, LanguageRange>>,
): LanguageRange | undefined {
  if (Object.isFrozen(document)) {
    let ranges = frozenDefinitionRanges.get(document)
    if (ranges === undefined) {
      ranges = declarationRanges(document)
      frozenDefinitionRanges.set(document, ranges)
    }
    return ranges.get(entityKey(namespace, id))
  }
  if (definitionRanges !== undefined) {
    let ranges = definitionRanges.get(document)
    if (ranges === undefined) {
      ranges = declarationRanges(document)
      definitionRanges.set(document, ranges)
    }
    return ranges.get(entityKey(namespace, id))
  }
  const match = collectAllRefs(document.text).find(
    candidate =>
      candidate.kind === 'definition' && candidate.namespace === namespace && candidate.id === id,
  )
  return match === undefined
    ? undefined
    : new LineIndex(document.text).range(match.start, match.end)
}

/** A {@link HoverCatalog} over the snapshot: parent chains and resolved values, merged as the game merges them. */
function hoverCatalog(view: WorkspaceView): HoverCatalog {
  const chainOf = (namespace: string, id: string): EntityRecord[] => {
    const declared = view.entities.get(entityKey(namespace, id))
    if (declared?.inheritanceChain !== undefined) {
      return declared.inheritanceChain.flatMap(ancestorId => {
        const ancestor = view.entities.get(entityKey(namespace, ancestorId))
        return ancestor === undefined ? [] : [ancestor]
      })
    }
    const chain: EntityRecord[] = []
    const seen = new Set<string>()
    let current = declared
    while (current !== undefined && !seen.has(id)) {
      seen.add(id)
      chain.unshift(current)
      const parent = current.parent
      if (parent === undefined || seen.has(parent)) break
      id = parent
      current = view.entities.get(entityKey(namespace, parent))
    }
    return chain
  }
  const idsOf = (namespace: string, id: string): string[] => {
    const declared = view.entities.get(entityKey(namespace, id))
    if (declared?.inheritanceChain !== undefined) return [...declared.inheritanceChain]
    const ids: string[] = []
    const seen = new Set<string>()
    let current: EntityRecord | undefined = declared
    while (current !== undefined && !seen.has(id)) {
      seen.add(id)
      ids.unshift(id)
      if (current.parent === undefined) break
      const next: string = current.parent
      current = view.entities.get(entityKey(namespace, next))
      id = next
    }
    return ids
  }
  return {
    namespaceOf: (classTag, id) => {
      const namespace = namespaceOfClass(classTag)
      return namespace !== undefined && view.entities.has(entityKey(namespace, id))
        ? namespace
        : undefined
    },
    resolvedField(namespace, id, field) {
      const chain = chainOf(namespace, id)
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const value = chain[index]?.data.get(field)
        if (value !== undefined) return value
      }
      return undefined
    },
    fieldOrigin(namespace, id, field) {
      const exact = view.entities.get(entityKey(namespace, id))?.fieldOrigins?.get(field)
      if (exact !== undefined) return exact
      const ids = idsOf(namespace, id)
      const chain = chainOf(namespace, id)
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        if (chain[index]?.data.has(field) === true) return ids[index]
      }
      return undefined
    },
    parentChain: (namespace, id) => idsOf(namespace, id),
    inheritedFieldCount(namespace, id) {
      const chain = chainOf(namespace, id)
      const own = chain.at(-1)?.data
      if (own === undefined) return 0
      // `default="1"` marks the template itself; a child does not inherit it.
      const all = new Set<string>()
      for (const record of chain) for (const field of record.data.keys()) if (field !== 'default') all.add(field)
      return Math.max(0, all.size - [...own.keys()].filter(field => field !== 'default').length)
    },
    defaultTemplate: (namespace, id) =>
      view.entities.get(entityKey(namespace, id))?.defaultTemplate === true,
    entityTokens: (namespace, id) => view.entities.get(entityKey(namespace, id))?.tokens ?? [],
  }
}

export interface Sc2DataLanguageProviderOptions {
  /** The host's port to the loaded mod servers, from the provider's activation context. */
  readonly modContexts?: ModServerPort
}

export function createSc2DataLanguageProvider(options: Sc2DataLanguageProviderOptions = {}): LanguageProvider {
  const port = Object.freeze({ port: options.modContexts, kept: new Map() as KeptAnswers })
  const analyzeText = (
    document: LanguageDocument,
    others: readonly LanguageDocument[],
    semanticView?: WorkspaceView,
    hasString?: (key: string) => boolean,
    complete = false,
  ): {
    index: LineIndex
    issues: readonly Issue[]
    view: WorkspaceView
    diagnostics: readonly LanguageDiagnostic[]
  } => {
    const index = new LineIndex(document.text)
    const view = semanticView ?? fallbackWorkspaceView(document, others, complete)
    /*
     * Reference checking is offered only when the snapshot actually holds other documents. With a
     * single file open, every link into another catalog would read as unresolved — the checker
     * would be loudest exactly when it knows least.
     */
    const catalogHas = view.authoritative
      ? (namespace: string, id: string) => view.hasId(namespace, id)
      : undefined
    const fileName = document.uri.split('/').at(-1)
    const editorCats = view.editorCategories
      ? (namespace: string) => [
          ...(view.editorCategories?.applicableByNamespace.get(namespace) ?? []),
        ]
      : undefined
    // The chain's aliases from the loaded mod's server, else from the documents the snapshot holds.
    const servedAliases = view.populated ? view.constAliases?.() : undefined
    const refs = {
      ...(view.populated
        ? {
            isConstAlias: servedAliases !== undefined
              ? (path: string, id: string) => servedAliases.has(`${path}\u0000${id}`)
              : catalogConstAliases([document, ...others].map(item => item.text)),
          }
        : {}),
      ...(view.editorCategories === undefined
        ? {}
        : {
            editorCategoryValues: (name: string) => view.editorCategories?.valuesByName.get(name),
          }),
      ...(hasString === undefined ? {} : { hasString }),
      isDefaultEntity: (namespace: string, id: string) => view.templateOf(namespace, id),
    }
    const issues = collectIssues(document.text, catalogHas, editorCats, fileName, refs)
    return {
      index,
      issues,
      view,
      diagnostics: issues.map(issue => ({
        range: index.range(issue.start, issue.end),
        severity: SEVERITY[issue.severity] ?? 'warning',
        message: issue.message,
        code: issue.code,
        source: SC2_DATA_LANGUAGE_ID,
      })),
    }
  }

  /** The issues the diagnostics request would report, with what their fixes need. */
  const analyzeRequest = (request: LanguageFeatureRequest, data: FeatureData) =>
    analyzeText(
      request.document,
      request.workspaceDocuments,
      data.view,
      // Only a complete answer can say a key exists nowhere: a dependency's strings may be missing.
      data.hasString,
      !data.incomplete,
    )

  return {
    contract: 'common.language/document-analysis',
    languageIds: [SC2_DATA_LANGUAGE_ID],
    semanticInputs: [
      {
        kind: 'schema',
        id: 'blizzard/sc2-data-schema@1',
        revision: STARCRAFT2_DATA_SCHEMA_REVISION,
      },
      { kind: 'provider', id: 'blizzard/sc2-data-language', revision: '3' },
    ],
    // The loaded mod's server answers what each feature needs (owner decision 07.10). The SDK this
    // extension is built on names the requirement from the next vendor hop on.
    semanticContextRequirements: [{ kind: 'mod-context', gameId: SC2_GAME_ID }] as unknown as LanguageProvider['semanticContextRequirements'],
    // Definition of an entity comes from the server too (owner decision 10.10, no second copy): its
    // declaration and exact range; a text key or an asset path keeps the snapshot (locale files, the
    // host's content listing). Needs a Host that knows `definition` (modkit-core 83958462).
    // A document's diagnostics too: the chain's ids and `<const>` aliases come from the server.
    // Needs a Host that serves diagnostics (modkit-core 8c2bdbeb).
    // References too: the server answers the host's index and this provider's part together.
    modContextFeatures: ['hover', 'completion', 'definition', 'diagnostics', 'references'] as unknown as LanguageProvider['modContextFeatures'],
    async modContextFeatureApplies(request: { readonly feature: string } & Pick<LanguagePositionRequest, 'document' | 'position'>) {
      if (request.feature !== 'definition') return true
      const text = request.document.text
      const offset = new LineIndex(text).offsetAt(request.position)
      const wanted = definitionRequestAt(text, offset)
      return wanted?.kind !== 'text' && wanted?.kind !== 'file' && referenceTargetAt(text, offset) !== undefined
    },

    /** The canonical completion engine identifies positions that require the host's asset listing. */
    async modContextCompletionApplies(request) {
      request.signal?.throwIfAborted()
      const text = request.document.text
      const offset = new LineIndex(text).offsetAt(request.position)
      const namespace = catalogNamespaceForFileName(request.document.uri)
      const result = computeCompletions(
        text, offset, undefined, undefined, undefined,
        namespace === undefined ? { kind: 'untyped' } : { kind: 'typed', namespace },
      )
      return result.kind !== 'assets'
    },

    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      const { index, diagnostics } = analyzeText(request.document, [])
      const include = request.include
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens: [],
        diagnostics: include?.diagnostics === false ? [] : diagnostics,
        symbols: include?.symbols === false ? [] : symbolsOf(request.document.text, index),
      }
    },

    async diagnostics(request: LanguageFeatureRequest): Promise<LanguageDiagnosticList> {
      return withData(request, port, data => {
        const { diagnostics } = analyzeRequest(request, data)
        const items = diagnostics.slice(0, request.maxResults)
        return {
          diagnostics: items,
          isIncomplete: items.length < diagnostics.length || data.incomplete,
        }
      })
    },

    async referenceOccurrences(request: LanguageFeatureRequest) {
      return sc2MixedReferenceOccurrenceBatches(request)
    },

    async documentSymbols(request: LanguageFeatureRequest): Promise<LanguageDocumentSymbolList> {
      const index = new LineIndex(request.document.text)
      const all = symbolsOf(request.document.text, index)
      const items = all.slice(0, request.maxResults)
      return { symbols: items, isIncomplete: items.length < all.length }
    },

    async completionContext(
      request: Pick<LanguagePositionRequest, 'document' | 'position' | 'signal'>,
    ): Promise<'document' | 'workspace'> {
      request.signal?.throwIfAborted()
      const text = request.document.text
      const offset = new LineIndex(text).offsetAt(request.position)
      const namespace = catalogNamespaceForFileName(request.document.uri)
      // Ask the same canonical completion engine, without supplying dependency callbacks.
      const result = computeCompletions(
        text, offset, undefined, undefined, undefined,
        namespace === undefined ? { kind: 'untyped' } : { kind: 'typed', namespace },
      )
      if (result.kind === 'classes' || result.kind === 'fields') return 'document'
      // Entity attributes may include tokens inherited from a parent in another file.
      if (result.kind === 'attributes' && elementPathAt(text, offset).length > 2) return 'document'
      if (result.kind === 'values' && (result.info.kind === 'bool' || result.info.kind === 'enum' || result.info.kind === 'flags')) {
        return 'document'
      }
      return 'workspace'
    },

    async completion(request: LanguagePositionRequest): Promise<LanguageCompletionList> {
      return withData(request, port, data => {
      const text = request.document.text
      const index = new LineIndex(text)
      const offset = index.offsetAt(request.position)
      const semanticView = data.view
      // A complete synchronized server already owns the live document. Keep text recovery only
      // for standalone/incomplete input, where malformed XML may still offer local declarations.
      const localView = semanticView !== undefined && !data.incomplete
        ? undefined
        : fallbackWorkspaceView(request.document, request.workspaceDocuments, !data.incomplete)
      const strings = data.strings
      const linkIds = (namespace: string) => [
        ...new Set([
          ...(semanticView?.idsByNamespace.get(namespace) ?? []),
          ...(localView?.idsByNamespace.get(namespace) ?? []),
        ]),
      ]
      const editorCats = semanticView?.editorCategories
        ? (wanted: string) => [
            ...(semanticView.editorCategories?.applicableByNamespace.get(wanted) ?? []),
          ]
        : undefined
      // A resolved entity's tokens are already effective; without a snapshot, the declarations
      // along the parent chain in the documents at hand (plan 1.1).
      const inheritedTokens = semanticView
        ? (wanted: string, parentId: string) =>
            semanticView.entities
              .get(entityKey(wanted, parentId))
              ?.tokens?.map(token => token.id) ?? []
        : (wanted: string, parentId: string) => {
            const found = new Set<string>()
            const seen = new Set<string>()
            for (let current: string | undefined = parentId; current !== undefined && !seen.has(current); ) {
              seen.add(current)
              const record: EntityRecord | undefined = localView?.entities.get(entityKey(wanted, current))
              for (const token of record?.tokens ?? []) found.add(token.id)
              current = record?.parent
            }
            return [...found]
          }
      const defaultTemplates = semanticView
        ? (wanted: string) => [...semanticView.defaultTemplateIds(wanted)]
        : undefined
      const namespace = catalogNamespaceForFileName(request.document.uri)
      const all = completionItems(
        computeCompletions(
          text,
          offset,
          linkIds,
          editorCats,
          inheritedTokens,
          namespace === undefined ? { kind: 'untyped' } : { kind: 'typed', namespace },
          defaultTemplates,
        ),
        index,
        text,
        offset,
        workspaceContentPaths(request),
        (linked, id) => {
          const entity = semanticView?.summary(linked, id) ?? localView?.summary(linked, id)
          const path = entity?.path
          const where =
            path === undefined
              ? undefined
              : [/[^/\\]+\.sc2(?:mod|map|campaign)(?=[/\\])/iu.exec(path)?.[0], path.split(/[/\\]/u).at(-1)].filter(Boolean).join(' · ')
          const name = strings?.get(`${linked}/Name/${id}`)
          return {
            ...(entity === undefined ? {} : { detail: [entity.classTag, where].filter(Boolean).join(' · ') }),
            ...(name === undefined ? {} : { name }),
          }
        },
      )
      const items = all.slice(0, request.maxResults)
      return {
        items,
        isIncomplete: items.length < all.length || data.incomplete,
      }
      })
    },

    async onTypeFormatting(request: DataOnTypeFormattingRequest): Promise<DataOnTypeEditResult> {
      const text = request.document.text
      const index = new LineIndex(text)
      const offset = index.offsetAt(request.position)
      if (
        request.ch !== '=' ||
        offset === 0 ||
        text[offset - 1] !== '=' ||
        text[offset] === '"' ||
        text[offset] === "'"
      ) {
        return { edits: [], isComplete: true }
      }
      const namespace = catalogNamespaceForFileName(request.document.uri)
      const result = computeCompletions(
        text,
        offset,
        undefined,
        undefined,
        undefined,
        namespace === undefined ? { kind: 'untyped' } : { kind: 'typed', namespace },
      )
      if (result.kind !== 'values' || result.quote !== true) {
        return { edits: [], isComplete: true }
      }
      return {
        edits: [{ range: index.range(offset, offset), newText: '""' }],
        isComplete: true,
        cursor: { line: request.position.line, character: request.position.character + 1 },
        requestCompletion: true,
      }
    },

    async definition(request: LanguagePositionRequest): Promise<LanguageLocationList> {
      return withData(request, port, data => {
      const text = request.document.text
      const index = new LineIndex(text)
      const offset = index.offsetAt(request.position)
      const wanted = definitionRequestAt(text, offset)
      /*
       * Only entity definitions can be resolved from a bounded text snapshot. A text key lives in a
       * locale catalog and an asset path on disk; both need the workspace, and answering with a
       * guess would send the reader to the wrong file.
       */
      // A text link goes to its key's line in the snapshot's locale files, enUS first (parity plan 1.11).
      if (wanted?.kind === 'text') {
        const location = stringKeyLocation(request.workspaceDocuments, wanted.key)
        return {
          locations: location === undefined ? [] : [location],
          isIncomplete: location === undefined && data.incomplete,
        }
      }
      // An asset path goes to its file in the mod context, read from the strongest layer (1.12).
      if (wanted?.kind === 'file') {
        const location = assetFileLocation(request, wanted.path)
        return {
          locations: location === undefined ? [] : [location],
          isIncomplete: location === undefined && data.incomplete,
        }
      }
      const target = referenceTargetAt(text, offset)
      if (target === undefined) {
        return {
          locations: [],
          isIncomplete: wanted !== undefined || data.incomplete,
        }
      }

      const semanticView = data.view
      if (semanticView !== undefined) {
        const entity = semanticView.entities.get(entityKey(target.namespace, target.id))
        if (entity === undefined) {
          if (!semanticView.authoritative) {
            const range = entityDefinitionRange(request.document, target.namespace, target.id)
            if (range !== undefined) {
              return { locations: [{ uri: request.document.uri, range }], isIncomplete: true }
            }
          }
          return {
            locations: [],
            isIncomplete: data.incomplete,
          }
        }
        // Its document in the snapshot, else its dependency layer's file (1.10).
        const location = entityDeclaration(request, semanticView, target.namespace, target.id)
        return {
          locations: location === undefined ? [] : [location],
          isIncomplete: location === undefined || data.incomplete,
        }
      }

      const locations = []
      for (const document of documentsOf(request)) {
        if (document.languageId !== request.document.languageId) continue
        const range = entityDefinitionRange(document, target.namespace, target.id)
        if (range === undefined) continue
        locations.push({ uri: document.uri, range })
        if (locations.length >= request.maxResults) {
          return { locations, isIncomplete: true }
        }
      }
      return { locations, isIncomplete: data.incomplete }
      })
    },

    async references(request: LanguageReferencesRequest): Promise<LanguageLocationList> {
      const served = recordOf((workspaceContextOf(request) as { readonly modContext?: unknown } | undefined)?.modContext)
      const place = recordOf(served?.['document'])
      if (port.port !== undefined && typeof served?.['scope'] === 'string' && typeof place?.['layerId'] === 'string' &&
          typeof place['path'] === 'string') {
        // The loaded mod's server holds the chain's catalogs and their link index: it answers what
        // the host's index and this provider answer together over a snapshot.
        const answer = recordOf(await port.port.query(served['scope'], {
          kind: 'data.references',
          document: { layerId: place['layerId'], path: place['path'] },
          offset: new LineIndex(request.document.text).offsetAt(request.position),
          includeDeclaration: request.includeDeclaration ?? false,
          maxResults: request.maxResults,
          incomplete: languageWorkspaceIsSemanticallyIncomplete(request),
        }, request.signal))
        if (answer === undefined || answer['revision'] !== served['revision']) throw new Error('data.references answered another revision')
        const documents = answer['documents'] as readonly { readonly uri?: unknown }[]
        const locations = (answer['locations'] as readonly { readonly document: number; readonly range: LanguageRange }[]).map(item => {
          const uri = documents[item.document]?.uri
          if (typeof uri !== 'string') throw new TypeError('data.references named a document without a URI')
          return { uri, range: item.range }
        })
        return { locations, isIncomplete: answer['isIncomplete'] === true }
      }
      // Scanning every document is the work here; the server only says whether the answer is whole.
      return withData(request, port, data => {
      const text = request.document.text
      const index = new LineIndex(text)
      const target = referenceTargetAt(text, index.offsetAt(request.position))
      if (target === undefined) return { locations: [], isIncomplete: false }
      const include = request.includeDeclaration ?? false
      const locations = []
      for (const document of documentsOf(request)) {
        if (document.languageId !== request.document.languageId) continue
        const matches = referencesIn(document, target, include)
        if (matches.length === 0) continue
        const documentIndex = document === request.document ? index : new LineIndex(document.text)
        for (const match of matches) {
          locations.push({ uri: document.uri, range: documentIndex.range(match.start, match.end) })
          if (locations.length >= request.maxResults) {
            return { locations, isIncomplete: true }
          }
        }
      }
      return { locations, isIncomplete: data.incomplete }
      }, true)
    },

    async prepareRename(
      request: LanguagePositionRequest,
    ): Promise<LanguageRenamePreparation | undefined> {
      const text = request.document.text
      const index = new LineIndex(text)
      const offset = index.offsetAt(request.position)
      const target = referenceTargetAt(text, offset)
      if (target === undefined) return undefined
      /*
       * The range offered is the identifier under the caret, found among this document's own
       * matches. Offering the whole attribute would have the editor replace the quotes too.
       */
      const here = collectAllRefs(text).find(
        match =>
          match.namespace === target.namespace &&
          match.id === target.id &&
          offset >= match.start &&
          offset <= match.end,
      )
      if (here === undefined) return undefined
      return { range: index.range(here.start, here.end), placeholder: target.id }
    },

    async rename(request: LanguageRenameRequest): Promise<LanguageWorkspaceEdit | undefined> {
      /*
       * Refused outright on a partial snapshot, as the contract requires. A rename that reaches
       * only the files that happen to be open leaves the rest pointing at an id that no longer
       * exists — worse than not renaming, because it looks finished.
       */
      if (await withData(request, port, data => data.incomplete, true)) return undefined
      if (!SC2_ENTITY_ID.test(request.newName)) return undefined
      const text = request.document.text
      const target = referenceTargetAt(text, new LineIndex(text).offsetAt(request.position))
      if (target === undefined) return undefined
      const documentChanges = []
      let total = 0
      for (const document of documentsOf(request)) {
        if (document.languageId !== request.document.languageId) continue
        const matches = referencesIn(document, target, true)
        if (matches.length === 0) continue
        const documentIndex = new LineIndex(document.text)
        const edits = matches.map(match => ({
          range: documentIndex.range(match.start, match.end),
          newText: request.newName,
        }))
        if (edits.length === 0) continue
        total += edits.length
        if (total > request.maxEdits) return undefined
        documentChanges.push({
          uri: document.uri,
          documentVersion: document.version,
          edits,
        })
      }
      if (documentChanges.length === 0) return undefined
      return { documentChanges, isComplete: true }
    },

    /** Preserve authored XML and apply only the requested final-newline policy. */
    async formatting(request: LanguageFormattingRequest): Promise<LanguageTextEditList> {
      request.signal?.throwIfAborted()
      const desired = request.options.finalNewline
      if (desired === undefined) return { edits: [], isComplete: true }
      const text = request.document.text
      const hasFinalNewline = /(?:\r?\n)$/u.test(text)
      if (desired === hasFinalNewline) return { edits: [], isComplete: true }
      const index = new LineIndex(text)
      const offset = text.length
      return {
        edits: desired
          ? [{ range: index.range(offset, offset), newText: '\n' }]
          : [
              {
                range: index.range(text.replace(/(?:\r?\n)+$/u, '').length, offset),
                newText: '',
              },
            ],
        isComplete: true,
      }
    },

    /**
     * Quick fixes for the diagnostics under the cursor (parity plan 1.21): the nearest valid name
     * for a field, enum value, editor category or reference; removing an unknown attribute; and
     * creating a missing entity where this file may declare it.
     */
    async codeActions(request: LanguageCodeActionsRequest) {
      const source = await finalNewlineCodeActions(request)
      return withData(request, port, data => {
      const { index, issues, view } = analyzeRequest(request, data)
      const text = request.document.text
      const from = index.offsetAt(request.range.start)
      const to = index.offsetAt(request.range.end)
      const fix = (
        title: string,
        issue: Issue,
        edits: readonly { start: number; end: number; newText: string }[],
        preferred = false,
      ): LanguageCodeAction => ({
        title,
        kind: 'quickfix',
        diagnosticCodes: [issue.code],
        ...(preferred ? { isPreferred: true } : {}),
        edit: {
          isComplete: true,
          documentChanges: [
            {
              uri: request.document.uri,
              documentVersion: request.document.version,
              edits: edits.map(item => ({ range: index.range(item.start, item.end), newText: item.newText })),
            },
          ],
        },
      })
      const fileNamespace = catalogNamespaceForFileName(request.document.uri)
      const entities = catalogEntities(scanXml(text))
      const actions: LanguageCodeAction[] = []
      for (const issue of issues) {
        if (issue.end < from || issue.start > to) continue
        const wrong = text.slice(issue.start, issue.end)
        const candidates =
          issue.candidates ?? (issue.namespace === undefined ? undefined : view.idsByNamespace.get(issue.namespace))
        nearestNames(wrong, candidates ?? []).forEach((name, rank) => {
          const edits = [{ start: issue.start, end: issue.end, newText: name }]
          if (issue.closingTag !== undefined) edits.push({ ...issue.closingTag, newText: name })
          actions.push(fix(`Change to '${name}'`, issue, edits, rank === 0))
        })
        if (issue.removal !== undefined) {
          actions.push(fix(`Remove attribute '${wrong}'`, issue, [{ ...issue.removal, newText: '' }]))
        }
        // A parent takes the class of its child. A reference names only a namespace: one action per
        // class when there are a few (CUnit, CUnitHero), none for Effect or Actor, where choosing
        // among dozens is the author's call. Never into a file of another namespace.
        if (issue.namespace === undefined || (fileNamespace !== undefined && fileNamespace !== issue.namespace)) continue
        const entity = entities.find(item => item.start <= issue.start && issue.start < item.end)
        const classes = catalogClassesForNamespace(issue.namespace)
        const tags =
          issue.code === 'sc2-data/unresolved-parent' ? [entity?.tag ?? ''] : classes.length <= 3 ? classes : []
        if (entity === undefined) continue
        const lineStart = text.lastIndexOf('\n', entity.start - 1) + 1
        const indent = text.slice(lineStart, entity.start)
        if (/\S/u.test(indent)) continue
        const newline = text.includes('\r\n') ? '\r\n' : '\n'
        for (const tag of tags.filter(Boolean)) {
          actions.push(
            fix(`Create ${tag} '${wrong}'`, issue, [
              { start: entity.start, end: entity.start, newText: `<${tag} id="${wrong}"/>${newline}${indent}` },
            ]),
          )
        }
      }
      return { actions: [...actions, ...source.actions], isIncomplete: false }
      })
    },

    /** Swatches on `CColor` (`A,R,G,B`) and `CColorRGB`/`CColorHDR` (`R,G,B`) values. */
    async documentColors(request: LanguageFeatureRequest): Promise<LanguageColorList> {
      const index = new LineIndex(request.document.text)
      const all = colorSites(request.document.text).flatMap(({ attr }) => {
        const parsed = parseColorLiteral(attr.value)
        return parsed === undefined || !parsed.decimal
          ? []
          : [{ range: index.range(attr.valueStart, attr.valueEnd), color: parsed.color }]
      })
      const colors = all.slice(0, request.maxResults)
      return { colors, isIncomplete: colors.length < all.length }
    },

    /** The picked colour with as many channels as the value had: an RGB field takes no alpha. */
    async colorPresentations(
      request: LanguageColorPresentationRequest,
    ): Promise<LanguageColorPresentationList> {
      const index = new LineIndex(request.document.text)
      const authored = request.document.text.slice(
        index.offsetAt(request.range.start),
        index.offsetAt(request.range.end),
      )
      const parsed = parseColorLiteral(authored.trim())
      if (parsed === undefined || !parsed.decimal) return { presentations: [], isIncomplete: false }
      const color = parsed.includesAlpha ? request.color : { ...request.color, alpha: 1 }
      const label = decimalColor(color, parsed.includesAlpha)
      return { presentations: [{ label, textEdit: { range: request.range, newText: label } }], isIncomplete: false }
    },

    async workspaceSymbols(
      request: LanguageWorkspaceSymbolsRequest,
    ): Promise<LanguageWorkspaceSymbolList> {
      return withData(request, port, data => {
      const needle = request.query.toLocaleLowerCase()
      const found: LanguageWorkspaceSymbol[] = []
      const semanticView = data.view
      if (semanticView !== undefined) {
        let unresolvedSource = false
        // One scan per document for all its matches: a needle like 'marine' matches thousands.
        const definitionRanges = new Map<LanguageDocument, ReadonlyMap<string, LanguageRange>>()
        for (const entity of semanticView.matching(needle)) {
          if (isAnonymousEntityId(entity.entityId) || !fuzzyMatches(entity.entityId, needle)) {
            continue
          }
          const document =
            entity.definitionSource === undefined
              ? undefined
              : documentForSource(request, entity.definitionSource)
          const range =
            document === undefined
              ? undefined
              : entityDefinitionRange(document, entity.namespace, entity.entityId, definitionRanges)
          if (document === undefined || range === undefined) {
            unresolvedSource = true
            continue
          }
          found.push({
            name: entity.entityId,
            kind: 'class',
            detail: entity.classTag,
            containerName: entity.namespace,
            location: { uri: document.uri, range },
          })
          if (found.length >= request.maxResults) {
            return { symbols: found, isIncomplete: true }
          }
        }
        return {
          symbols: found,
          isIncomplete: unresolvedSource || data.incomplete,
        }
      }
      for (const document of documentsOf(request)) {
        if (document.languageId !== request.document.languageId) continue
        const index = new LineIndex(document.text)
        for (const entity of catalogEntities(scanXml(document.text))) {
          const id = getAttr(entity, 'id')?.value ?? ''
          if (id === '' || !fuzzyMatches(id, needle)) continue
          found.push({
            name: id,
            kind: 'class',
            detail: entity.tag,
            location: { uri: document.uri, range: index.range(entity.tagStart, entity.tagEnd) },
          })
          if (found.length >= request.maxResults) {
            return { symbols: found, isIncomplete: true }
          }
        }
      }
      return { symbols: found, isIncomplete: data.incomplete }
      })
    },

    /**
     * Above each entity (parity plan 1.17, 1.18, MK2 D38–D42): the ancestors it inherits from and
     * how many fields, opening its resolved values; its card; its relation graph. The same commands
     * the hover offers on a reference, by the id the facts use (`Unit/Marine`).
     */
    async codeLenses(request: LanguageFeatureRequest): Promise<LanguageCodeLensList> {
      return withData(request, port, data => {
      const text = request.document.text
      const index = new LineIndex(text)
      const view =
        data.view ??
        fallbackWorkspaceView(
          request.document,
          request.workspaceDocuments ?? [],
          !data.incomplete,
        )
      const catalog = hoverCatalog(view)
      const inherited = new Map(computeEntityLenses(text, catalog).map(lens => [lens.start, lens]))
      const all: LanguageCodeLens[] = []
      // Shared ancestors (including missing declarations) are resolved once in this snapshot.
      // Keep the memo request-local so edits and dependency revisions cannot reuse stale locations.
      const ancestorLocations = new Map<string, LanguageLocation | undefined>()
      const definitionRanges = new Map<LanguageDocument, ReadonlyMap<string, LanguageRange>>()
      for (const entity of catalogEntities(scanXml(text))) {
        const id = getAttr(entity, 'id')?.value
        const namespace = id === undefined || id === '' ? undefined : catalog.namespaceOf(entity.tag, id)
        if (id === undefined || namespace === undefined) continue
        // The id its card opens on, so the application opens the card without searching for it.
        const subjectId = sc2EntitySubjectId(namespace, id)
        const range = index.range(entity.start, entity.start)
        const lens = inherited.get(entity.start)
        if (lens !== undefined) {
          all.push({
            range,
            title: `${lens.inherited} inherited`,
            command: { kind: 'open-subject', subjectId, view: 'resolved' },
          })
          // The ancestors, root first, each going to its declaration, else to its card (1.19).
          for (const [at, ancestor] of lens.chain.slice(0, -1).entries()) {
            const ancestorKey = entityKey(namespace, ancestor)
            if (ancestor !== '' && !ancestorLocations.has(ancestorKey)) {
              ancestorLocations.set(ancestorKey, entityDeclaration(request, view, namespace, ancestor, definitionRanges))
            }
            const location = ancestorLocations.get(ancestorKey)
            all.push({
              range,
              title: `${at === 0 ? '↑' : '→'} ${ancestor === '' ? '(default)' : ancestor}`,
              ...(location !== undefined
                ? { command: { kind: 'open-location', location } }
                : ancestor === ''
                  ? {}
                  : { command: { kind: 'open-subject', subjectId: sc2EntitySubjectId(namespace, ancestor), view: 'card' } }),
            })
          }
        }
        // How many entities inherit from this one, which MK2 counted but never showed (1.20).
        const heirs = view.heirCount(namespace, id)
        if (heirs > 0) {
          all.push({ range, title: `${heirs} heir${heirs === 1 ? '' : 's'}`, command: { kind: 'open-subject', subjectId, view: 'graph' } })
        }
        all.push({ range, title: 'Card', command: { kind: 'open-subject', subjectId, view: 'card' } })
        all.push({ range, title: 'Graph', command: { kind: 'open-subject', subjectId, view: 'graph' } })
      }
      const lenses = all.slice(0, request.maxResults)
      return { lenses, isIncomplete: lenses.length < all.length }
      })
    },

    async hover(request: LanguagePositionRequest): Promise<LanguageHover | undefined> {
      return withData(request, port, data => {
      const text = request.document.text
      const index = new LineIndex(text)
      const offset = index.offsetAt(request.position)
      /*
       * On a field, the useful answer is the value the game ends up with and which ancestor set it;
       * `computeHover` produces exactly that from a catalog, which the snapshot can now back.
       */
      const semanticView = data.view
      const localView = fallbackWorkspaceView(
        request.document,
        request.workspaceDocuments ?? [],
        !data.incomplete,
      )
      const resolved =
        (semanticView === undefined
          ? undefined
          : computeHover(text, offset, hoverCatalog(semanticView))) ??
        computeHover(text, offset, hoverCatalog(localView))
      const target = referenceTargetAt(text, offset)
      /*
       * What the host draws or opens with the text: the picture of a texture path under the caret,
       * and the entity under it as a card, a relation graph or its resolved view, by the subject id
       * its card opens on (`sc2EntitySubjectId`).
       */
      const picture = texturePathAt(text, offset)
      const extras = {
        ...(picture === undefined ? {} : { assets: [{ path: picture }] }),
        ...(target === undefined
          ? {}
          : {
              commands: (['card', 'graph', 'resolved'] as const).map(view => ({
                title: view === 'card' ? 'Card' : view === 'graph' ? 'Relation graph' : 'Resolved values',
                command: { kind: 'open-subject' as const, subjectId: sc2EntitySubjectId(target.namespace, target.id), view },
              })),
            }),
      }
      /*
       * What the player reads (parity plan 1.8): the GameStrings text of a text-link value, or the
       * name of the entity a reference names, as written, markup included.
       */
      const strings = data.strings
      const wanted = definitionRequestAt(text, offset)
      const said =
        wanted?.kind === 'text'
          ? strings?.get(wanted.key)
          : target === undefined
            ? undefined
            : strings?.get(`${target.namespace}/Name/${target.id}`)
      const shown = said === undefined ? '' : `\n\n\`\`\`\n${said}\n\`\`\``
      if (resolved !== undefined) return { markdown: `${resolved}${shown}`, provenance: 'blizzard/sc2-data', ...extras }
      if (picture !== undefined) return { markdown: `\`${picture}\``, provenance: 'blizzard/sc2-data', ...extras }
      /*
       * `computeHover` explains a field with its resolved value and inheritance, which needs a
       * loaded mod. What a single document supports is the reference under the caret — which entity
       * it names and in which namespace — so that is what is answered, rather than a fabricated
       * inheritance chain.
       */
      if (target === undefined) return undefined
      const declared = collectAllRefs(text).find(
        match =>
          match.namespace === target.namespace &&
          match.id === target.id &&
          match.kind === 'definition',
      )
      const where = declared === undefined ? 'not declared in this file' : 'declared in this file'
      return {
        markdown: `**${target.namespace}** \`${target.id}\` — ${where}.${shown}`,
        provenance: 'blizzard/sc2-data',
        ...extras,
      }
      })
    },
  } as LanguageProvider
}

export const sc2DataLanguageProvider: LanguageProvider = createSc2DataLanguageProvider()
