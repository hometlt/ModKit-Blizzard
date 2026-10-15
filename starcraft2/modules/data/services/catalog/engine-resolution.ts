/**
 * SC2 Data inheritance for the resolved-data provider, through the one resolver: catalog-engine
 * (owner decision 26.09, S3). The provider keeps its per-declaration analysis (schema typing,
 * diagnostics, localization keys); the values an entity resolves to — parents, class templates,
 * list slots and removals, tokens, constants, structure defaults — come from `TypedCatalog`.
 *
 * The documents are the ones the provider already read, so each file is parsed once. The catalog
 * also lists its Data spaces and each entity's class and parent, for a holder's declaration index. A resolved
 * entity comes back as one synthetic declaration (`element`): the provider types it with the same
 * code that types an authored declaration, so the snapshot keeps its field shapes.
 */
import {
  catalogFileOfElements,
  type CatalogXmlElement,
  type RawFields,
  type RawValue,
  type TokenDecl,
} from '../../shared/catalog-engine/xml/index.js'
import { TypedCatalog, type CatalogEntity, type EntitySource } from '../../shared/catalog-engine/sc2-catalog/index.js'
import { createBuiltinRegistry, type SchemaField, type SchemaFields } from '../../shared/catalog-engine/sc2-schema/index.js'
import {
  STARCRAFT2_STRUCTURE_DEFAULT_RULES,
  catalogStructureDefaultEntries,
} from '../../shared/format/structure-defaults.js'

export interface EngineCatalogDocument {
  readonly rootId: string
  readonly path: string
  readonly text: string
  /** Top-level elements from `parseCatalogXmlElements(text)`. */
  readonly elements: readonly CatalogXmlElement[]
}

/** A declaration site: the document's root and path, and the line of the declaration. */
export interface EngineSource {
  readonly rootId: string
  readonly path: string
  readonly line?: number
  /** The declaration's opening tag, as `DataEntitySource.range` carries it (0-based line). */
  readonly range?: { readonly utf16Offset: number; readonly utf16Length: number; readonly line: number; readonly column: number }
}

export interface EngineResolvedEntity {
  readonly typeId: string
  /** The resolved fields as one declaration, for the provider's field typing. */
  readonly element: CatalogXmlElement
  /** The declaration that last wrote each top-level field along the chain. */
  readonly fieldSources: Readonly<Record<string, EngineSource>>
  /** This entity's own declarations, in load order. */
  readonly sources: readonly EngineSource[]
  /** Root first, the entity last; a class template is `{ entityId: '', typeId }`. */
  readonly chain: readonly { readonly entityId: string; readonly typeId: string }[]
  /** Token declarations along the chain, the nearest one winning per id. */
  readonly tokens: readonly TokenDecl[]
  /** An explicit parent that no loaded document declares. */
  readonly missingParent?: string
  /** Top-level lists removals emptied: a declaration cannot spell an empty list, so they are named. */
  readonly emptyLists: readonly string[]
}

/** An entity of the chain behind a value: a class template has `entityId` `''`. */
export interface EngineOrigin {
  readonly source: EngineSource
  readonly entityId: string
  readonly typeId: string
}

/** Which declaration wrote each field and each leaf of an entity's resolved values. */
export interface EngineProvenance {
  /** Top-level fields the entity's own declarations write. */
  readonly own: ReadonlySet<string>
  field(fieldId: string): EngineOrigin | undefined
  leaf(fieldId: string, path: readonly string[]): EngineOrigin | undefined
  /** Slots the entity's own declarations remove, from the top-level field down. */
  readonly tombstones: readonly { readonly path: readonly string[]; readonly source: EngineSource }[]
}

export interface EngineCatalog {
  resolve(namespace: string, entityId: string): EngineResolvedEntity | undefined
  /** The class's `default="1"` template, resolved along its own chain of class templates. */
  resolveTemplate(typeId: string): EngineResolvedEntity | undefined
  provenance(namespace: string, entityId: string): EngineProvenance | undefined
  templateProvenance(typeId: string): EngineProvenance | undefined
  /** The structure types this catalog's Data space declares defaults for. */
  structureDefaultTypes(namespace: string): ReadonlySet<string>
  /** The loaded Data spaces. */
  namespaces(): readonly string[]
  /** Each entity of a Data space, with its class and its parent as its merged declarations name it. */
  declarations(namespace: string): readonly { readonly entityId: string; readonly typeId: string; readonly parent?: string }[]
  /** The loaded catalog as the chain declares it — entities and resolved values — read only. */
  readonly entries: EngineCatalogEntries
  /** An entity's class and last declaration, as resolving it names them, without resolving it. */
  declared(namespace: string, entityId: string): { readonly typeId: string; readonly source?: EngineSource } | undefined
}

function sourceOf(source: EntitySource): EngineSource {
  const line = source.line === undefined || source.line === 0 ? undefined : source.line
  return Object.freeze({
    rootId: source.mod,
    path: source.file,
    ...(line === undefined ? {} : { line }),
    ...(line === undefined || source.span === undefined
      ? {}
      : { range: Object.freeze({ utf16Offset: source.span.offset, utf16Length: source.span.length, line: line - 1, column: source.span.column }) }),
  })
}

/**
 * One field as elements. A nested value the schema declares a list is written as child elements,
 * the way XML spells a list; any other nested scalar as an attribute. Both spellings mean the same
 * to SC2, but the provider types an attribute as a plain value and an element by its schema.
 */
function fieldElements(name: string, value: RawValue, field: SchemaField | undefined): CatalogXmlElement[] {
  if (Array.isArray(value)) return (value as readonly RawValue[]).flatMap(item => fieldElements(name, item, field))
  if (typeof value === 'string') return [{ name, attributes: { value }, children: [], text: '' }]
  const attributes: Record<string, string> = {}
  const children: CatalogXmlElement[] = []
  for (const [key, item] of Object.entries(value)) {
    const nested = field?.fields?.[key]
    if (typeof item === 'string' && nested?.isArray !== true) attributes[key] = item
    else children.push(...fieldElements(key, item, nested))
  }
  return [{ name, attributes, children, text: '' }]
}

/** Resolved raw fields spelled as one catalog declaration of `typeId`. */
export function declarationOf(typeId: string, entityId: string, fields: RawFields, schema?: SchemaFields): CatalogXmlElement {
  return {
    name: typeId,
    attributes: { id: entityId },
    children: Object.entries(fields).flatMap(([name, value]) => fieldElements(name, value, schema?.[name])),
    text: '',
  }
}

/** What a reader of the whole catalog (the mod's Resources) asks: the catalog-engine view, read only. */
export interface EngineCatalogEntries {
  namespaces(): string[]
  all(namespace: string): CatalogEntity[]
  getResolved(namespace: string, entityId: string): RawFields | undefined
  getStructureDefaults(namespace: string): ReadonlyMap<string, RawValue>
}

/** Load the documents, in the provider's order, into one catalog. */
export function createEngineCatalog(documents: readonly EngineCatalogDocument[]): EngineCatalog {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry(), structureDefaults: STARCRAFT2_STRUCTURE_DEFAULT_RULES })
  for (const document of documents) {
    const file = catalogFileOfElements(document.elements, document.text, { filePath: document.path, trackSource: true })
    catalog.loadFromFiles([file], { mod: document.rootId })
    for (const item of catalogStructureDefaultEntries(document.text, document.path, file.rootTypes)) {
      catalog.addStructureDefault(item.namespace, item.structureType, item.fields)
    }
  }
  // One declaration supplies many fields and leaf origins. Keep its immutable projection within
  // this catalog, so the provider's existing source interning also sees the same declaration.
  const projectedSources = new WeakMap<EntitySource, EngineSource>()
  /** Preserve the complete declaration identity and span once per catalog-owned source. */
  const projectedSource = (source: EntitySource): EngineSource => {
    let projected = projectedSources.get(source)
    if (projected === undefined) {
      projected = sourceOf(source)
      projectedSources.set(source, projected)
    }
    return projected
  }
  const resolved = (entity: CatalogEntity, fields: RawFields): EngineResolvedEntity => {
    const chain = catalog.chainOf(entity)
    const tokens = new Map<string, TokenDecl>()
    for (const link of chain) for (const token of link.tokens ?? []) tokens.set(token.id, token)
    const root = chain[0]
    const missingParent = root?.parent !== undefined && catalog.get(entity.namespace, root.parent) === undefined
      ? root.parent
      : undefined
    return {
      typeId: entity.class,
      element: declarationOf(entity.class, entity.id, fields, catalog.schema.resolveFields(entity.class)),
      fieldSources: Object.fromEntries(
        Object.entries(catalog.resolvedSourcesOf(entity)).map(([field, source]) => [field, projectedSource(source)]),
      ),
      sources: (entity.sources ?? (entity.source === undefined ? [] : [entity.source])).map(projectedSource),
      chain: chain.map(link => ({ entityId: link.id, typeId: link.class })),
      tokens: [...tokens.values()],
      ...(missingParent === undefined ? {} : { missingParent }),
      emptyLists: Object.entries(fields).filter(([, value]) => Array.isArray(value) && value.length === 0).map(([name]) => name),
    }
  }
  const provenance = (entity: CatalogEntity): EngineProvenance => {
    const traced = catalog.provenanceOf(entity)
    const origin = (source: EntitySource, link: CatalogEntity): EngineOrigin =>
      ({ source: projectedSource(source), entityId: link.id, typeId: link.class })
    return {
      own: traced.own,
      field(fieldId) {
        const field = traced.fields.get(fieldId)
        return field === undefined ? undefined : origin(field.source, field.entity)
      },
      leaf(fieldId, path) {
        const leaf = traced.fields.get(fieldId)?.originAt(path)
        return leaf === undefined ? undefined : origin(leaf.source, leaf.entity)
      },
      tombstones: traced.tombstones.map(tombstone => ({ path: tombstone.path, source: projectedSource(tombstone.source) })),
    }
  }
  return {
    provenance(namespace, entityId) {
      const entity = catalog.get(namespace, entityId)
      return entity === undefined ? undefined : provenance(entity)
    },
    templateProvenance(typeId) {
      const template = catalog.getClassDefault(typeId)
      return template === undefined ? undefined : provenance(template)
    },
    structureDefaultTypes(namespace) {
      return new Set(catalog.getStructureDefaults(namespace).keys())
    },
    namespaces: () => catalog.namespaces(),
    entries: Object.freeze({
      namespaces: () => catalog.namespaces(),
      all: (namespace: string) => catalog.all(namespace),
      getResolved: (namespace: string, entityId: string) => catalog.getResolved(namespace, entityId),
      getStructureDefaults: (namespace: string) => catalog.getStructureDefaults(namespace),
    }),
    declarations: namespace =>
      catalog.all(namespace).map(entity => ({
        entityId: entity.id,
        typeId: entity.class,
        ...(entity.parent === undefined ? {} : { parent: entity.parent }),
      })),
    declared(namespace, entityId) {
      const entity = catalog.get(namespace, entityId)
      if (entity === undefined) return undefined
      const last = (entity.sources ?? (entity.source === undefined ? [] : [entity.source])).at(-1)
      return { typeId: entity.class, ...(last === undefined ? {} : { source: projectedSource(last) }) }
    },
    resolve(namespace, entityId) {
      const entity = catalog.get(namespace, entityId)
      const fields = catalog.getResolved(namespace, entityId)
      return entity === undefined || fields === undefined ? undefined : resolved(entity, fields)
    },
    resolveTemplate(typeId) {
      const template = catalog.getClassDefault(typeId)
      return template === undefined ? undefined : resolved(template, catalog.resolveEntityFields(template))
    },
  }
}
