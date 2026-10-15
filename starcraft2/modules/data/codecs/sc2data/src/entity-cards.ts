/**
 * Entity cards, from the ported wiki assembler.
 *
 * `wiki/cards.ts` is 943 lines that turn a catalog entity into what a reader wants to see about it:
 * its costs, its weapons and abilities with their resolved numbers, its localized name and tooltip,
 * what produces it and what it produces. It was carried across and had no way in — the codec even
 * declared `blizzard/sc2-data.entity-cards` in its operation table and then skipped the handler, so
 * the operation existed and did nothing.
 *
 * Nothing here decides what belongs on a card. What this module does is bridge two shapes: the
 * assembler wants an `SC2Mod`, and MK3 has the `TypedCatalog` that an `SC2Mod` mostly wraps.
 *
 * It supplies the nine members the assembler actually reaches for rather than constructing the real
 * class, and that is a decision worth stating. `SC2Mod` is a whole-mod object: importing it pulls in
 * the layout parser, the document-metadata reader and the archive loader, none of which a GameData
 * session has or needs, and two of which are Node-only — the codec is declared portable, so that
 * import would break the claim. The nine members are listed below and checked against the port, so
 * the day the assembler reaches for a tenth this file fails to compile rather than answering wrong.
 *
 * The relation graph is built from the catalog directly rather than through `wiki/mod-relations`,
 * which composes catalog and SC2Layout references: layouts are a different codec's documents and
 * are not in a GameData session, so asking for them would add a dependency for an empty answer.
 * Producers come from `producers.ts` for the same reason — `wiki/mod-producers` adds the triggers
 * that *also* build a unit, and trigger documents are not in this session either. What that costs
 * is stated on the card rather than hidden: `triggers` is empty, meaning "not visible from here".
 */
import { buildEntityCard, entityIconAsset } from '../../../shared/format/wiki/cards.js'
import type { CardGraph, EntityCard } from '../../../shared/format/wiki/cards.js'
import { findCatalogUnitProducers } from '../../../shared/format/producers.js'
import {
  buildCatalogRelations,
  type CatalogRelationsSource,
} from '../../../shared/format/relations.js'
import {
  assetId,
  createEntitySelectorSource,
  entityCardFacts,
  entitySubjectId,
  localeName,
  type EntityCardFactsOptions,
} from './entity-facts.js'

export { entitySubjectId } from './entity-facts.js'
import {
  buildChain,
  type CatalogEntity,
  type TypedCatalog,
} from '../../../shared/catalog-engine/sc2-catalog/index.js'
import type {
  AssetSourceRef,
  DataEntityRef,
  DataResolvedEntity,
  JsonValue,
  ResolvedDataWorkspaceSnapshot,
  SubjectCatalogPort,
  SubjectFactProvenance,
  SubjectFactsSource,
} from '@modkit/sdk'
import { provenanceOf } from '@modkit/codec-kit'

/** One locale's strings, keyed by file stem then by key — the shape `SC2Mod.locales` holds. */
export type LocaleStrings = ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, string>>>

/**
 * The slice of `SC2Mod` the card assembler reads.
 *
 * Derived by reading it, not by guessing: `cards.ts`, `wiki.ts`, `coerce.ts`, `visuals.ts` and
 * `mod-producers.ts` between them touch exactly these.
 */
export interface CardMod {
  get(namespace: string, id: string): unknown
  getResolved(namespace: string, id: string): unknown
  all(namespace: string): readonly unknown[]
  namespaces(): string[]
  readonly locales: LocaleStrings
  readonly opaqueFiles: ReadonlyMap<string, Uint8Array>
  getTextConstant(name: string, locale?: string): string | undefined
  getTextStyle(name: string, locale?: string): unknown
  /** `Assets(Product).txt` aliases a whole mod carries (`SC2Mod.assetAliases`); a catalog has none. */
  readonly assetAliases?: ReadonlyMap<string, string>
}

export interface EntityCardOptions {
  /** Locale to resolve names and tooltips in. Defaults to `enUS`, as MK2 did. */
  readonly locale?: string
  /** Localized strings, when the caller has them; without them a card carries keys, not prose. */
  readonly locales?: LocaleStrings
  /** `FontStyles` constants, for the colours a tooltip names. */
  readonly textConstants?: Readonly<Record<string, string>>
}

/**
 * Present a catalog as the mod the assembler expects.
 *
 * The members past the catalog answer empty for a good reason: a GameData session holds catalog XML
 * and nothing else. A card built from it is complete about the data and silent about the rest,
 * which is honest; inventing files or styles would make a partial card look finished.
 */
export function modOfCatalog(catalog: TypedCatalog, options: EntityCardOptions = {}): CardMod {
  const constants = options.textConstants ?? {}
  return {
    get: (namespace, id) => catalog.get(namespace, id),
    getResolved: (namespace, id) => catalog.getResolved(namespace, id),
    all: namespace => catalog.all(namespace),
    namespaces: () => catalog.namespaces(),
    locales: options.locales ?? new Map(),
    opaqueFiles: new Map(),
    getTextConstant: name => constants[name],
    getTextStyle: () => undefined,
  }
}

/**
 * A value of the host snapshot in the form the catalog parser writes.
 *
 * The snapshot keeps an indexed item as `{ index, value }` and types its scalars; the parser keeps a
 * struct item's fields beside its `index` and every scalar as the XML spelled it.
 */
function rawOf(value: JsonValue): unknown {
  if (Array.isArray(value)) {
    return value.map(item => {
      const pair = item as { index?: JsonValue; value?: JsonValue } | null
      if (pair === null || typeof pair !== 'object' || Array.isArray(pair) ||
        Object.keys(pair).length !== 2 || pair.index === undefined || pair.value === undefined) {
        return rawOf(item)
      }
      const inner = rawOf(pair.value)
      return inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? { index: String(pair.index), ...inner }
        : { index: String(pair.index), value: inner }
    })
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rawOf(item)]))
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(Number(value)) : value
}

/** `mods/liberty.sc2mod/base.sc2data/gamedata/unitdata.xml` → the package and the path in it. */
function entitySourceOf(path: string): { mod: string; file: string } {
  const match = /^(.*?\.sc2(?:mod|map|campaign))\/(.*)$/iu.exec(path)
  return match === null ? { mod: '', file: path } : { mod: match[1]!, file: match[2]! }
}

/**
 * The host's resolved-data snapshot as the mod the assembler expects.
 *
 * Its definitions are already resolved along the whole mod chain, so each becomes a parentless raw
 * entity: the assembler's own resolution then answers the snapshot's values rather than inheriting
 * a second time. Numbers go back through the provider's lexemes where it kept them. Style sheets
 * are not part of a Data snapshot, so text constants answer empty, as for a single catalog.
 */
/** One resolved definition's fields as the catalog parser would hold them. */
export function rawFieldsOfDefinition(
  definition: ResolvedDataWorkspaceSnapshot['definitions'][number],
): Record<string, unknown> {
  const lexemes = definition.fieldLexemes ?? {}
  return Object.fromEntries(
    Object.entries(definition.fields).map(([key, value]) => [key, lexemes[key] ?? rawOf(value)]),
  )
}

export function cardSourceOfSnapshot(snapshot: ResolvedDataWorkspaceSnapshot): EntityCardSource {
  const byNamespace = new Map<string, Map<string, CatalogEntity>>()
  for (const definition of snapshot.definitions) {
    const data = rawFieldsOfDefinition(definition)
    const declared = definition.sources[0]
    const entity = {
      id: definition.entityId,
      class: definition.typeId,
      namespace: definition.namespace,
      data,
      ...(definition.defaultTemplate === true ? { default: '1' } : {}),
      ...(declared === undefined ? {} : { source: entitySourceOf(declared.path) }),
    } as unknown as CatalogEntity
    let entities = byNamespace.get(definition.namespace)
    if (entities === undefined) byNamespace.set(definition.namespace, (entities = new Map()))
    entities.set(definition.entityId, entity)
  }
  // The host resolved every key in the locale it was asked for, falling back per key; filed under
  // the resolved locale, a fallback key would become a locale of its own that has no names.
  const locales = new Map<string, Map<string, Map<string, string>>>()
  for (const item of snapshot.localizedStrings) {
    const locale = item.requestedLocale.toLowerCase()
    const file = item.source.path.split('/').pop()?.replace(/\.txt$/iu, '') ?? 'GameStrings'
    let files = locales.get(locale)
    if (files === undefined) locales.set(locale, (files = new Map()))
    let strings = files.get(file)
    if (strings === undefined) files.set(file, (strings = new Map()))
    if (!strings.has(item.key)) strings.set(item.key, item.value)
  }
  const get = (namespace: string, id: string) => byNamespace.get(namespace)?.get(id)
  return {
    get,
    getResolved: (namespace, id) => get(namespace, id)?.data,
    all: namespace => [...(byNamespace.get(namespace)?.values() ?? [])],
    namespaces: () => [...byNamespace.keys()],
    locales,
    opaqueFiles: new Map(),
    getTextConstant: () => undefined,
    getTextStyle: () => undefined,
  }
}

/**
 * The graph a card needs: what an entity points at, what points at it, and what builds it.
 *
 * `incoming` flips the edge, because the raw graph keeps orientation and every consumer of a card
 * asks for "the other end". Getting that backwards is silent — the card renders with empty sections
 * rather than failing — which is why the ported `collect.ts` states it too.
 */
export function cardGraphOfCatalog(catalog: TypedCatalog | CatalogRelationsSource): CardGraph {
  const relations = buildCatalogRelations(catalog as never)
  return {
    outgoing: (namespace, id) =>
      relations.outgoing(namespace, id).map(ref => ({ to: ref.to, path: ref.path })),
    incoming: (namespace, id) =>
      relations.incoming(namespace, id).map(ref => ({ to: ref.from, path: ref.path })),
    unitProducers: id =>
      findCatalogUnitProducers(catalog as never, id, { graph: relations }).map(producer => ({
        kind: producer.kind,
        category: producer.category,
        creator: producer.creator,
        path: producer.path,
        routes: producer.routes,
        // A GameData session has no trigger documents; an empty list says so without guessing.
        triggers: [],
      })),
  }
}

/** One entity, assembled into a card. */
export function entityCard(
  catalog: TypedCatalog,
  namespace: string,
  entityId: string,
  options: EntityCardOptions = {},
): EntityCard {
  if (catalog.get(namespace, entityId) === undefined) {
    throw new TypeError(`no entity ${namespace}/${entityId} in this catalog`)
  }
  const mod = modOfCatalog(catalog, options)
  return buildEntityCard(
    {
      mod: mod as never,
      locale: options.locale ?? 'enUS',
      graph: cardGraphOfCatalog(catalog),
    },
    namespace,
    entityId,
  )
}

/** Anything the assembler and the relation walker can read: a GameData catalog or a whole mod. */
export type EntityCardSource = CardMod & CatalogRelationsSource

export interface EntitySubjectsOptions {
  readonly snapshotId: string
  readonly source: AssetSourceRef
  readonly editOperation?: string
  /**
   * The subject's mod context, when the host placed it in one: a card is then drawn from the values
   * the whole dependency chain gives the entity (parents, overrides, Liberty under a mod), not from
   * this document alone (parity plan 5.7).
   */
  readonly catalog?: SubjectCatalogPort
  /** Where a provenance entry of this document declares its entity (see `entityCardFacts`). */
  readonly declare?: NonNullable<EntityCardFactsOptions['declare']>
  /**
   * An entity's display name in the source's locale (its `Name` string), or `''` without one. The
   * selector lists entities by it, as the wiki does (parity plan 5.25); the id stays the fallback.
   */
  readonly nameOf?: (namespace: string, id: string) => string
  /**
   * The address of a file in a layer of the mod context, by the layer's root id and the file's path
   * in its package: a card from the context then names, for each field, the file of the layer that
   * sets it, not the document the selector was opened on. `undefined` keeps the document.
   */
  readonly sourceOf?: (rootId: string, file: string) => AssetSourceRef | undefined
}

/**
 * Where each field of a mod context card comes from: the file of the layer that sets the field (its
 * `fieldSources` entry), else of the layer that declares the entity last, as `sourceOf` addresses it.
 */
function chainProvenance(
  resolved: DataResolvedEntity,
  sourceOf: NonNullable<EntitySubjectsOptions['sourceOf']>,
  fallback: AssetSourceRef,
): (segments: readonly string[]) => readonly SubjectFactProvenance[] {
  return segments => {
    const field = segments[0]
    const declared = (field === undefined ? undefined : resolved.fieldSources?.[field]) ?? resolved.sources.at(-1)
    const source = declared === undefined ? undefined : sourceOf(declared.rootId, entitySourceOf(declared.path).file)
    const provenance = provenanceOf(source ?? fallback, [resolved.namespace, resolved.entityId, ...segments])
    const range = source === undefined ? undefined : declared?.range
    return range === undefined ? provenance : provenance.map(item => Object.freeze({ ...item, range }))
  }
}

/** How far a chain card follows references (unit → weapon → effect → …) and how many it asks for. */
const CHAIN_CARD_DEPTH = 3
const CHAIN_CARD_ENTITIES = 512
const CATALOG_PORT_BATCH = 1024

/**
 * One entity as its mod context resolves it, with the entities its card follows, as a snapshot the
 * one card projection (`snapshotEntityFacts`) reads. The references to follow come from the ported
 * relation walker itself: it walks what was fetched over a source that records every entity it
 * looks for and does not have yet, and those are asked of the catalog next, a level at a time.
 * `undefined` when the context does not know the entity.
 */
async function chainCardSnapshot(
  catalog: SubjectCatalogPort,
  namespace: string,
  id: string,
  signal?: AbortSignal,
): Promise<ResolvedDataWorkspaceSnapshot | undefined> {
  const keyOf = (ns: string, entityId: string) => `${ns}/${entityId}`
  const fetched = new Map<string, DataResolvedEntity>()
  const asked = new Set<string>()
  const snapshotOf = () =>
    ({ definitions: [...fetched.values()], localizedStrings: [] }) as unknown as ResolvedDataWorkspaceSnapshot
  let wanted: DataEntityRef[] = [{ namespace, entityId: id }]
  for (let depth = 0; depth <= CHAIN_CARD_DEPTH && wanted.length > 0; depth += 1) {
    const batch = wanted
      .filter(ref => !asked.has(keyOf(ref.namespace, ref.entityId)))
      .slice(0, CHAIN_CARD_ENTITIES - asked.size)
    for (const ref of batch) asked.add(keyOf(ref.namespace, ref.entityId))
    for (let start = 0; start < batch.length; start += CATALOG_PORT_BATCH) {
      for (const entity of await catalog.entities(batch.slice(start, start + CATALOG_PORT_BATCH), signal))
        fetched.set(keyOf(entity.namespace, entity.entityId), entity)
    }
    if (!fetched.has(keyOf(namespace, id))) return undefined
    if (depth === CHAIN_CARD_DEPTH || asked.size >= CHAIN_CARD_ENTITIES) break
    const known = cardSourceOfSnapshot(snapshotOf())
    const next = new Map<string, DataEntityRef>()
    buildCatalogRelations({
      ...known,
      get: (ns: string, entityId: string) => {
        const found = known.get(ns, entityId)
        if (found !== undefined || entityId === '') return found
        const key = keyOf(ns, entityId)
        if (!asked.has(key)) next.set(key, { namespace: ns, entityId })
        return undefined
      },
    } as never)
    wanted = [...next.values()]
  }
  return snapshotOf()
}

type ContextString = ResolvedDataWorkspaceSnapshot['localizedStrings'][number]

/** A file's strings that note every key the card builder looks up, answering what is known. */
class RecordingStrings extends Map<string, string> {
  constructor(
    private readonly asked: Set<string>,
    private readonly known: ReadonlyMap<string, ContextString>,
  ) {
    super()
  }
  override get(key: string): string | undefined {
    this.asked.add(key)
    return this.known.get(key)?.value
  }
}

/**
 * The localized strings a chain card reads — names, tooltips, hotkeys — asked of the subject's mod
 * context. Which keys a card needs is the card builder's business, so it is run over the snapshot
 * with strings that only note what is looked up, and those keys are asked; a second round asks
 * what the answers themselves name. A context without strings leaves the card to its ids.
 */
async function withContextStrings(
  catalog: SubjectCatalogPort,
  snapshot: ResolvedDataWorkspaceSnapshot,
  namespace: string,
  id: string,
  signal?: AbortSignal,
): Promise<ResolvedDataWorkspaceSnapshot> {
  if (catalog.strings === undefined) return snapshot
  const answered = new Map<string, ContextString>()
  const requested = new Set<string>()
  const source = cardSourceOfSnapshot(snapshot)
  const graph = cardGraphOfCatalog(source)
  for (let round = 0; round < 2; round += 1) {
    const asked = new Set<string>()
    const recording = new Map([['enus', new Map([['GameStrings', new RecordingStrings(asked, answered)]])]])
    localizedCards({ ...source, locales: recording }, graph, namespace, id)
    const missing = [...asked].filter(key => !requested.has(key))
    if (missing.length === 0) break
    for (const key of missing) requested.add(key)
    for (const item of await catalog.strings(missing, undefined, signal)) answered.set(item.key, item)
  }
  return { ...snapshot, localizedStrings: [...answered.values()] } as ResolvedDataWorkspaceSnapshot
}

/**
 * Every entity of a source as a subject: a selector that lists them and lends each one's card.
 *
 * The relation graph is built once, on the first card anyone opens, and shared by every card after
 * it; a document nobody opens an entity of pays nothing.
 */
/** The locales a source has strings in, `enUS` first; `enUS` alone when it has none. */
function cardLocales(mod: CardMod): readonly string[] {
  const locales = [...mod.locales.keys()].sort((left, right) =>
    left.toLowerCase() === 'enus'
      ? -1
      : right.toLowerCase() === 'enus'
        ? 1
        : left.localeCompare(right),
  )
  return locales.length === 0 ? ['enUS'] : locales
}

/** One entity's card in every locale of its source. */
function localizedCards(
  mod: EntityCardSource,
  graph: CardGraph,
  namespace: string,
  id: string,
): ReadonlyMap<string, EntityCard> {
  return new Map(
    cardLocales(mod).map(locale => [
      localeName(locale),
      buildEntityCard({ mod: mod as never, graph, locale }, namespace, id),
    ]),
  )
}

const snapshotSources = new WeakMap<
  ResolvedDataWorkspaceSnapshot,
  { readonly source: EntityCardSource; graph?: CardGraph }
>()

/**
 * One entity of a host resolved-data snapshot, as the same card a GameData file lends: the one SC2
 * entity projection, over values resolved along the whole mod chain. The snapshot's card source and
 * relation graph are built once and shared by every card opened from it. `undefined` when the
 * snapshot does not define the entity.
 */
export function snapshotEntityFacts(
  snapshot: ResolvedDataWorkspaceSnapshot,
  namespace: string,
  id: string,
  options: EntityCardFactsOptions,
): SubjectFactsSource | undefined {
  let cached = snapshotSources.get(snapshot)
  if (cached === undefined) snapshotSources.set(snapshot, (cached = { source: cardSourceOfSnapshot(snapshot) }))
  if (cached.source.get(namespace, id) === undefined) return undefined
  cached.graph ??= cardGraphOfCatalog(cached.source)
  return entityCardFacts(localizedCards(cached.source, cached.graph, namespace, id), options)
}

export function entitySubjects(mod: EntityCardSource, options: EntitySubjectsOptions) {
  let graph: CardGraph | undefined
  return createEntitySelectorSource({
    snapshotId: options.snapshotId,
    // Each namespace by display name, then id: the order a wiki lists a namespace in.
    entities: () =>
      mod.namespaces().flatMap(namespace =>
        (mod.all(namespace) as readonly { readonly id: string; readonly class?: string }[])
          .filter(entity => entity.id !== '')
          .map(entity => ({
            subjectId: entitySubjectId(namespace, entity.id),
            label: options.nameOf?.(namespace, entity.id) || entity.id,
            kind: namespace,
            ...(entity.class === undefined ? {} : { type: entity.class }),
          }))
          .sort((left, right) => left.label.localeCompare(right.label) || left.subjectId.localeCompare(right.subjectId)),
      ),
    // The icon a card shows: the entity's own, else that of a button representing it.
    portraitOf(namespace, id) {
      graph ??= cardGraphOfCatalog(mod)
      return assetId(entityIconAsset(mod as never, namespace, id, graph), mod.assetAliases)
    },
    async open(namespace, id, signal) {
      if (options.catalog !== undefined) {
        const fetched = await chainCardSnapshot(options.catalog, namespace, id, signal)
        const snapshot =
          fetched === undefined ? undefined : await withContextStrings(options.catalog, fetched, namespace, id, signal)
        const resolved = snapshot?.definitions.find(
          item => item.namespace === namespace && item.entityId === id,
        )
        if (snapshot !== undefined && resolved !== undefined) {
          const { catalog: _catalog, ...card } = options
          // Only what this document declares can be written through it.
          const writable = mod.get(namespace, id) !== undefined
          return snapshotEntityFacts(snapshot, namespace, id, {
            snapshotId: card.snapshotId,
            source: card.source,
            ...(writable && card.editOperation !== undefined ? { editOperation: card.editOperation } : {}),
            ...(mod.assetAliases === undefined ? {} : { assetAliases: mod.assetAliases }),
            parentChain: resolved.inheritanceChain.map(ref => ({ namespace: ref.namespace, id: ref.entityId })),
            resolvedParentChain: true,
            ...(card.sourceOf === undefined ? {} : { provenanceOf: chainProvenance(resolved, card.sourceOf, card.source) }),
          })
        }
      }
      const entity = mod.get(namespace, id) as CatalogEntity | undefined
      if (entity === undefined) return undefined
      const chain = buildChain(
        entity,
        (ns, entityId) => mod.get(ns, entityId) as CatalogEntity | undefined,
      )
      graph ??= cardGraphOfCatalog(mod)
      return entityCardFacts(localizedCards(mod, graph, namespace, id), {
        ...options,
        ...(mod.assetAliases === undefined ? {} : { assetAliases: mod.assetAliases }),
        parentChain: chain.map(item => ({ namespace: item.namespace, id: item.id })),
        partialParentChain: chain[0]?.parent !== undefined,
      })
    },
  })
}
