/**
 * Catalog entities as subjects of their own: the facts a card shows and the selector that lends
 * them from an open document.
 *
 * What goes on a card is the ported wiki assembler's knowledge (`wiki/cards.ts`: resolved names,
 * vitals, costs, weapons with their damage and DPS, the icon and model an entity is drawn with).
 * This file only restates an `EntityCard` in the shape every host already renders — groups of
 * facts, a `stats` group for the header, one relation per linked entity — so the card stays
 * generic and a GameData file and a whole mod lend entities the same way.
 *
 * Locales: the assembler resolves text for one locale at a time, so a card is built once per
 * locale the source has and the localized facts carry their locale. The host shows one and offers
 * the rest as a switch.
 */
import {
  createSubjectFactsSource,
  pageOf,
  parseSubjectId,
  provenanceOf,
} from '@modkit/codec-kit'
import { operationId } from '@modkit/core'
import { SC2_ENTITY_SUBJECT_SCOPE, sc2EntitySubjectId } from '../../../../../shared/language/entity-id.js'
import type { SubjectFactGroupInput } from '@modkit/codec-kit'
import type {
  AssetSourceRef,
  FieldEditable,
  FieldType,
  JsonValue,
  Lease,
  RelatedSubjectFact,
  SelectableSubject,
  SubjectFact,
  SubjectFactGroup,
  SubjectFactProvenance,
  SubjectFactSlot,
  SubjectFactSlots,
  SubjectFactsSource,
  SubjectSelectorSource,
} from '@modkit/sdk'
import type { EntityCard } from '../../../shared/format/wiki/cards.js'
import { starcraft2FieldKnowledgeTarget } from '../../../services/schema/data-schema-identity.js'

/** One owner of an entity's subject id, shared with the language commands (`shared/language/entity-id.ts`). */
export const ENTITY_SUBJECT_SCOPE = SC2_ENTITY_SUBJECT_SCOPE
export const entitySubjectId = sc2EntitySubjectId

/** `enus` → `enUS`: the assembler keys locales in lower case, a reader expects the FourCC. */
export function localeName(locale: string): string {
  return /^[a-z]{4}$/iu.test(locale)
    ? `${locale.slice(0, 2).toLowerCase()}${locale.slice(2).toUpperCase()}`
    : locale
}

/**
 * Game asset paths use backslashes; logical resource ids use forward slashes. An `@@Key` alias is
 * the path `Assets.txt`/`AssetsProduct.txt` give `Key` (as MK2's image resolution read it), when the
 * source has those tables; without them it names nothing a host can open and is left out.
 */
export function assetId(
  path: string | undefined,
  aliases?: ReadonlyMap<string, string>,
): string | undefined {
  let value = path?.trim()
  if (value?.startsWith('@@')) value = aliases?.get(value.slice(2))?.trim()
  value = value?.replaceAll('\\', '/')
  return value === undefined || value === '' || value.startsWith('@') ? undefined : value
}

function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .trim()
}

export interface EntityCardFactsOptions {
  readonly snapshotId: string
  /** The source's Assets(Product).txt aliases, for icons written as @@Key. */
  readonly assetAliases?: ReadonlyMap<string, string>
  readonly source: AssetSourceRef
  /** Route for the scalar fields the assembler marks editable; omitted for read-only sources. */
  readonly editOperation?: string
  /** Existing catalog inheritance, in root-first order. */
  readonly parentChain?: readonly { readonly namespace: string; readonly id: string }[]
  readonly partialParentChain?: boolean
  /** The chain was resolved along the whole mod chain, not only within the loaded catalog. */
  readonly resolvedParentChain?: boolean
  /** The id the card and its links name an entity by; this codec's subject id by default. */
  readonly subjectIdOf?: (namespace: string, id: string) => string
  /**
   * Where the value at a field path comes from, the entity's own path first. By default the one
   * source; a resolved workspace names every layer that declares it.
   */
  readonly provenanceOf?: (path: readonly string[]) => readonly SubjectFactProvenance[]
  /**
   * Where a provenance entry points: the publisher adds its file's address and the span declaring
   * the entity, so the card opens the declaration (parity plan 5.2). It applies to every fact,
   * relation and origin the card lists.
   */
  readonly declare?: (provenance: SubjectFactProvenance) => SubjectFactProvenance
  /**
   * Weapon facts the caller calculated, with their formula and inputs; they stand for the card's
   * own weapon estimates, so one card never shows two DPS values.
   */
  readonly weaponFacts?: readonly SubjectFact[]
  /** Groups the caller adds after the card's own. */
  readonly extraGroups?: readonly SubjectFactGroupInput[]
  /** Summary members the caller adds, such as completeness and warnings. */
  readonly summaryExtras?: Readonly<Record<string, JsonValue>>
  /**
   * The entity's edges as the caller knows them — direction, field, declaration, unresolved target.
   * They stand for the card's own `Uses …`/`Used by …` links, which come from the same references.
   */
  readonly edgeRelations?: readonly RelatedSubjectFact[]
}

/**
 * One entity, from its per-locale cards (the first entry is the primary locale).
 */
export function entityCardFacts(
  cards: ReadonlyMap<string, EntityCard>,
  options: EntityCardFactsOptions,
): SubjectFactsSource {
  const [primary] = cards.values()
  if (primary === undefined) throw new TypeError('an entity card needs at least one locale')
  const { ns, id } = primary
  const subjectIdOf = options.subjectIdOf ?? entitySubjectId
  const path = (...segments: string[]) =>
    options.provenanceOf?.(segments) ?? provenanceOf(options.source, [ns, id, ...segments])
  const fact = (
    factId: string,
    label: string,
    value: JsonValue,
    extra: {
      readonly note?: string
      readonly locale?: string
      readonly path?: readonly string[]
      readonly editable?: boolean
      readonly slot?: SubjectFactSlot
      readonly type?: FieldType
    } = {},
  ): SubjectFact =>
    Object.freeze({
      id: factId,
      label,
      value,
      provenance: path(...(extra.path ?? [])),
      ...(extra.type === undefined ? {} : { type: extra.type }),
      ...(extra.note === undefined ? {} : { note: extra.note }),
      ...(extra.locale === undefined ? {} : { locale: extra.locale }),
      ...(extra.slot === undefined ? {} : { slot: Object.freeze(extra.slot) }),
      ...(extra.editable === true && options.editOperation !== undefined
        ? {
            type: { kind: typeof value === 'number' ? 'number' : 'text' },
            editable: {
              write: {
                operation: operationId(options.editOperation, {
                  contributionId: ENTITY_SUBJECT_SCOPE,
                }),
              },
              editor: 'scalar',
            } as unknown as FieldEditable,
          }
        : {}),
    }) as SubjectFact

  const stats: SubjectFact[] = []
  for (const vital of primary.vitals) {
    const name = vital.name.toLowerCase()
    const notes = [
      vital.start === undefined ? undefined : `starts at ${vital.start}`,
      vital.regen === undefined ? undefined : `regenerates ${vital.regen}/s`,
    ].filter(Boolean)
    stats.push(
      fact(name, vital.name, vital.max, {
        path: [`${vital.name}Max`],
        editable: true,
        ...(notes.length === 0 ? {} : { note: notes.join(', ') }),
      }),
    )
    if (vital.armor !== undefined)
      stats.push(
        fact(`${name}-armor`, `${vital.name} armor`, vital.armor, {
          path: [`${vital.name}Armor`],
          editable: true,
        }),
      )
  }
  const speed = primary.fields.find(field => field.name === 'Speed')
  if (speed !== undefined)
    stats.push(
      fact(
        'speed',
        'Speed',
        Number.isFinite(Number(speed.value)) ? Number(speed.value) : speed.value,
        { path: ['Speed'], editable: speed.editable === true },
      ),
    )
  const cost = primary.cost ?? {}
  if (cost.minerals !== undefined)
    stats.push(fact('minerals', 'Minerals', cost.minerals, { path: ['CostResource', 'Minerals'] }))
  if (cost.vespene !== undefined)
    stats.push(fact('vespene', 'Vespene', cost.vespene, { path: ['CostResource', 'Vespene'] }))
  if (cost.supply !== undefined) stats.push(fact('food', 'Supply', cost.supply, { path: ['Food'] }))
  if (cost.time !== undefined) stats.push(fact('time', 'Build time', cost.time))

  const overview: SubjectFact[] = []
  const labels: Record<string, string> = {}
  for (const [locale, card] of cards) {
    labels[locale] = card.name
    overview.push(fact('name', 'Name', card.name, { locale, path: ['Name'] }))
    if (card.descriptionRuns !== undefined && card.descriptionRuns.length > 0) {
      // As it reads in the game: colours, emphasis, inline icons (5.9); an icon by the logical id
      // the card's other images use, or its path marked when it names nothing a host can open.
      const runs = card.descriptionRuns.map(run => {
        if (run.asset === undefined) return run
        const asset = assetId(run.asset, options.assetAliases)
        return asset === undefined ? { text: run.asset, unresolved: 'not an asset path' } : { ...run, asset }
      })
      overview.push(
        fact('description', 'Description', runs as unknown as JsonValue, {
          locale,
          path: ['Description'],
          type: { kind: 'text-runs' },
        }),
      )
    } else if (card.descriptionHtml !== undefined) {
      overview.push(
        fact('description', 'Description', plainText(card.descriptionHtml), {
          locale,
          path: ['Description'],
        }),
      )
    }
  }
  overview.push(fact('id', 'Id', id), fact('class', 'Class', primary.className))
  if (options.parentChain !== undefined) {
    overview.push(
      fact(
        'parent-chain',
        'Parent chain',
        options.parentChain.map(
          item => `${item.namespace}/${item.id === '' ? '(default)' : item.id}`,
        ),
        {
          note:
            options.partialParentChain === true
              ? 'Loaded catalog only; a parent is missing or cyclic.'
              : options.resolvedParentChain === true
                ? 'Inheritance along the loaded mod chain.'
                : 'Inheritance within the loaded catalog; workspace dependency completeness is not established.',
        },
      ),
    )
  }
  if (primary.attributes.length > 0)
    overview.push(fact('attributes', 'Attributes', primary.attributes, { path: ['Attributes'] }))
  const icon = assetId(primary.iconAsset, options.assetAliases)
  if (icon !== undefined) overview.push(fact('icon', 'Icon', icon))
  const model = assetId(primary.modelAsset, options.assetAliases)
  if (model !== undefined)
    overview.push(
      fact('model', 'Model', model, { note: 'Resolved through the Actor and Model entries' }),
    )
  const sources = primary.sources ?? (primary.source === undefined ? [] : [primary.source])
  if (sources.length > 0)
    overview.push(
      fact(
        'sources',
        'Declared in',
        sources.map(
          item => `${item.mod}/${item.file}${item.line === undefined ? '' : `:${item.line}`}`,
        ),
      ),
    )

  const weapons = primary.weapons.map((weapon, index) =>
    fact(`weapon-${index}`, weapon.label, {
      ...(weapon.damage === undefined ? {} : { damage: weapon.damage }),
      ...(weapon.attacks === undefined ? {} : { attacks: weapon.attacks }),
      ...(weapon.dps === undefined ? {} : { dps: Math.round(weapon.dps * 100) / 100 }),
      ...(weapon.range === undefined ? {} : { range: weapon.range }),
      ...(weapon.period === undefined ? {} : { cooldown: weapon.period }),
      ...(weapon.bonuses === undefined || weapon.bonuses.length === 0
        ? {}
        : {
            bonus: weapon.bonuses.map(bonus => `+${bonus.amount} vs ${bonus.attribute}`).join(', '),
          }),
      ...(weapon.targets === undefined ? {} : { targets: weapon.targets }),
    }),
  )

  // Each field with its help, keyed by its place in the schema, and a link with the namespace it
  // names, so a card says what it points at and an editor offers that namespace (5.16).
  const fields = primary.fields.map(field =>
    Object.freeze({
      ...fact(`field-${field.name}`, field.name, field.value, {
        path: [field.name],
        editable: field.editable === true,
      }),
      knowledgeTarget: starcraft2FieldKnowledgeTarget(primary.className, [field.name]),
      ...(field.linkNs === undefined ? {} : { type: { kind: 'subject-ref', subjectKind: field.linkNs } }),
    }) as SubjectFact,
  )

  // The command card as the game lays it out: a 3 × 5 grid per page, a submenu button opening its
  // page and Cancel returning to the first; a page is named by the button that opens it.
  const firstPage = primary.commandCards[0]?.id
  const commandSlots: SubjectFactSlots | undefined =
    firstPage === undefined
      ? undefined
      : {
          rows: Math.max(3, ...primary.commandCards.flatMap(page => page.buttons.map(button => button.row + 1))),
          columns: Math.max(5, ...primary.commandCards.flatMap(page => page.buttons.map(button => button.col + 1))),
          ...(primary.commandCards.length < 2
            ? {}
            : {
                pages: primary.commandCards.map(page => {
                  const opener = primary.commandCards
                    .flatMap(other => other.buttons)
                    .find(button => button.submenuCardId === page.id)
                  return {
                    id: page.id,
                    label: page.id === firstPage ? 'Commands' : (opener && plainText(opener.nameHtml)) || page.id,
                  }
                }),
              }),
        }
  const commands: SubjectFact[] = []
  for (const [locale, card] of cards) {
    for (const page of card.commandCards) {
      page.buttons.forEach((button, index) =>
        commands.push(
          fact(
            `command-${page.id}-${index}`,
            plainText(button.nameHtml) || button.face,
            {
              page: page.id,
              row: button.row,
              column: button.col,
              type: button.type,
              face: button.face,
              description: plainText(button.tooltipHtml),
              ...(assetId(button.iconAsset, options.assetAliases) === undefined
                ? {}
                : { icon: assetId(button.iconAsset, options.assetAliases)! }),
              ...(button.hotkey === undefined ? {} : { hotkey: button.hotkey }),
              ...(button.abil === undefined
                ? {}
                : { ability: subjectIdOf('Abil', button.abil) }),
              ...(button.submenuCardId === undefined ? {} : { submenu: button.submenuCardId }),
              ...(button.produces === undefined
                ? {}
                : { produces: subjectIdOf(button.produces.ns, button.produces.id) }),
              ...(button.cost === undefined ? {} : { cost: { ...button.cost } }),
              ...(button.cooldown === undefined ? {} : { cooldown: button.cooldown }),
              ...(button.range === undefined ? {} : { range: button.range }),
              ...(button.time === undefined ? {} : { time: button.time }),
              ...(button.targets === undefined ? {} : { targets: button.targets }),
            },
            {
              locale,
              path: ['CardLayouts'],
              slot: commandSlot(button, page.id, commandSlots, firstPage, assetId(button.iconAsset, options.assetAliases), subjectIdOf),
            },
          ),
        ),
      )
    }
  }
  // A route reads as the chain it is, one line each; its links are the card's relations
  // (Produced by, Production mechanism), so the value never needs to be a structure.
  const producers = primary.producers.map((producer, index) =>
    fact(
      `producer-${index}`,
      producer.creator.label,
      producer.routes.length === 0
        ? [producer.creator.label]
        : producer.routes.map(route => {
            // The mechanism ends the chain; a route may already name it as its last step.
            const chain = [route.producer, ...route.via]
            const last = chain.at(-1)
            if (last?.ns !== producer.creator.ns || last.id !== producer.creator.id) chain.push(producer.creator)
            return chain.map(link => link.label).join(' → ')
          }),
      {
        note: `${producer.kind} · ${producer.category} · ${producer.path}. Catalog production routes; trigger-only producers are outside this view.`,
      },
    ),
  )

  const relations = new Map<string, RelatedSubjectFact>()
  const relate = (
    role: string,
    target: { readonly ns: string; readonly id: string; readonly label: string },
  ) => {
    const subjectId = subjectIdOf(target.ns, target.id)
    const key = `${role}\u0000${subjectId}`
    if (!relations.has(key))
      relations.set(
        key,
        Object.freeze({ role, subjectId, label: target.label || target.id, kind: target.ns }),
      )
  }
  for (const weapon of primary.weapons) relate('Weapons', weapon)
  for (const ability of primary.abilities) relate('Abilities', ability)
  for (const behavior of primary.behaviors) relate('Behaviors', behavior)
  for (const producer of primary.producers) {
    relate('Production mechanism', producer.creator)
    if (producer.routes.length === 0) relate('Produced by', producer.creator)
    for (const route of producer.routes) relate('Produced by', route.producer)
  }
  for (const page of primary.commandCards)
    for (const button of page.buttons) {
      relate('Command buttons', {
        ns: 'Button',
        id: button.face,
        label: plainText(button.nameHtml),
      })
      if (button.abil !== undefined)
        relate('Command abilities', { ns: 'Abil', id: button.abil, label: button.abil })
      if (button.produces !== undefined) relate('Produces', button.produces)
    }
  for (const parent of options.parentChain ?? []) {
    // Empty ids are implicit defaults; the shared subject-id parser cannot address them.
    if (parent.id === '' || (parent.namespace === ns && parent.id === id)) continue
    relate('Parent chain', { ns: parent.namespace, id: parent.id, label: parent.id || '(default)' })
  }
  if (options.edgeRelations === undefined) {
    for (const group of primary.relationsOut)
      for (const link of group.links) relate(`Uses ${group.ns}`, link)
    for (const group of primary.relationsIn)
      for (const link of group.links) relate(`Used by ${group.ns}`, link)
  }
  // What the entity sounds like (5.15): the Sounds its actors play, each opening as its own card,
  // and their files, which open as audio.
  for (const sound of primary.sounds) relate('Sounds', { ns: 'Sound', id: sound.id, label: sound.label })
  const sounds = primary.sounds.map(sound =>
    Object.freeze({
      ...fact(`sound-${sound.id}`, sound.label, sound.files),
      type: { kind: 'array', item: { kind: 'asset-ref', accepts: {} } },
    }) as SubjectFact,
  )
  // Each Uses/Used by group's exact size: the card lists a bounded number of its links (5.16).
  const references: SubjectFact[] =
    options.edgeRelations !== undefined
      ? []
      : [
          ...primary.relationsOut.map(group => [`uses-${group.ns}`, `Uses ${group.ns}`, group] as const),
          ...primary.relationsIn.map(group => [`used-by-${group.ns}`, `Used by ${group.ns}`, group] as const),
        ].map(([factId, label, group]) =>
          fact(factId, label, group.total, group.links.length < group.total ? { note: `${group.total - group.links.length} more not listed` } : {}),
        )

  const declare = options.declare
  const declared = <Item extends { readonly provenance?: readonly SubjectFactProvenance[] }>(item: Item): Item =>
    declare === undefined || item.provenance === undefined
      ? item
      : { ...item, provenance: item.provenance.map(declare) }
  const source = createSubjectFactsSource({
    snapshotId: options.snapshotId,
    subjectId: subjectIdOf(ns, id),
    label: primary.name || id,
    kind: ns,
    type: primary.className,
    source: options.source,
    groups: [
      { id: 'stats', label: 'Stats', facts: stats },
      { id: 'overview', label: 'Overview', facts: overview },
      { id: 'weapons', label: 'Weapons', facts: options.weaponFacts ?? weapons },
      { id: 'command-card', label: 'Command card', facts: commands },
      { id: 'producers', label: 'Production routes', facts: producers },
      { id: 'sounds', label: 'Sounds', facts: sounds },
      { id: 'references', label: 'References', facts: references },
      { id: 'fields', label: 'Fields', facts: fields },
      ...(options.extraGroups ?? []),
    ].map(group => (declare === undefined ? group : { ...group, facts: group.facts.map(declared) })),
    relations: [...relations.values(), ...(options.edgeRelations ?? [])].map(declared),
  })
  // The portrait, the model and the localized titles are identity facts newer than the kit's
  // builder; the host resolves the model through this subject's resources and lends it to the card.
  const extra = {
    ...(icon === undefined ? {} : { portrait: icon }),
    // SC2 models are authored in game units, which the map scene also treats as meters.
    ...(model === undefined ? {} : { model, modelMetersPerSourceUnit: 1 }),
    localizedLabels: Object.freeze(labels),
  }
  return Object.freeze({
    ...source,
    async summary(signal?: AbortSignal) {
      const summary = await source.summary(signal)
      return Object.freeze({
        ...summary,
        ...(options.summaryExtras ?? {}),
        identity: Object.freeze({
          ...summary.identity,
          ...(options.provenanceOf === undefined ? {} : { origins: declared({ provenance: path() }).provenance }),
          ...extra,
        }),
      })
    },
    // The kit's group builder carries no presentation; the command card says it is a grid here.
    async groups(page: Parameters<SubjectFactsSource['groups']>[0], signal?: AbortSignal) {
      const groups = await source.groups(page, signal)
      if (commandSlots === undefined) return groups
      return Object.freeze({
        ...groups,
        items: Object.freeze(
          groups.items.map(group =>
            group.id === 'command-card'
              ? (Object.freeze({ ...group, presentation: 'slots', slots: commandSlots }) as SubjectFactGroup)
              : group,
          ),
        ),
      })
    },
  })
}

/**
 * A command button's cell: its page when the card has several, its hotkey, its icon, and where a
 * click goes — the page a submenu opens or Cancel returns to, otherwise the button's own card.
 */
function commandSlot(
  button: EntityCard['commandCards'][number]['buttons'][number],
  page: string,
  slots: SubjectFactSlots | undefined,
  firstPage: string | undefined,
  image: string | undefined,
  subjectIdOf: (namespace: string, id: string) => string,
): SubjectFactSlot {
  // GameHotkeys may hold two keys for a button ("H /// H"); the cell shows the first.
  const hotkey = button.hotkey?.split('///')[0]?.trim()
  const opensPage =
    button.type === 'Submenu' ? button.submenuCardId : button.type === 'CancelSubmenu' ? firstPage : undefined
  return {
    row: button.row,
    column: button.col,
    ...(slots?.pages === undefined ? {} : { page }),
    ...(hotkey ? { hotkey } : {}),
    ...(image === undefined ? {} : { image }),
    ...(opensPage === undefined ? {} : { opensPage }),
    subjectId: subjectIdOf('Button', button.face),
  }
}

export interface EntitySelectorOptions {
  readonly snapshotId: string
  /** Every entity the source can open, cheapest first; labels may be ids. */
  entities(): readonly SelectableSubject[]
  /** One entity's icon as a logical image id, asked for the returned page only (a wiki's tiles). */
  portraitOf?(namespace: string, id: string): string | undefined
  /** Facts for one entity, or `undefined` when the source does not have it. */
  open(
    namespace: string,
    id: string,
    signal?: AbortSignal,
  ): SubjectFactsSource | undefined | Promise<SubjectFactsSource | undefined>
}

/** A document's entities, lendable one at a time as subjects. */
export function createEntitySelectorSource(options: EntitySelectorOptions): SubjectSelectorSource {
  let listed: readonly SelectableSubject[] | undefined
  const all = () => (listed ??= Object.freeze(options.entities()))
  const unsupported = async (): Promise<never> => {
    throw new TypeError('SC2 entity calculations are published by the resolved-data service')
  }
  return Object.freeze({
    async summary(signal?: AbortSignal) {
      signal?.throwIfAborted()
      // The namespaces in listing order with their sizes: a wiki's left column.
      const kinds = new Map<string, number>()
      for (const item of all()) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
      return Object.freeze({
        snapshotId: options.snapshotId,
        totalSubjects: all().length,
        completeness: 'complete' as const,
        kinds: Object.freeze([...kinds].map(([kind, count]) => Object.freeze({ kind, count }))),
      })
    },
    async subjects(query: Parameters<SubjectSelectorSource['subjects']>[0], signal?: AbortSignal) {
      const text = query.text?.toLowerCase()
      const matched = all().filter(
        item =>
          (query.kind === undefined || item.kind === query.kind) &&
          (query.type === undefined || item.type === query.type) &&
          (text === undefined ||
            item.label.toLowerCase().includes(text) ||
            item.subjectId.toLowerCase().includes(text)),
      )
      const page = pageOf(matched, query, signal)
      const portraitOf = options.portraitOf
      if (portraitOf === undefined) return page
      return Object.freeze({
        ...page,
        items: Object.freeze(page.items.map(item => {
          const [namespace, id] = parseSubjectId(item.subjectId)?.path ?? []
          const portrait = namespace === undefined || id === undefined ? undefined : portraitOf(namespace, id)
          return portrait === undefined ? item : Object.freeze({ ...item, portrait })
        })),
      })
    },
    async openFacts(subjectId: string, signal?: AbortSignal): Promise<Lease<SubjectFactsSource>> {
      signal?.throwIfAborted()
      const parsed = parseSubjectId(subjectId)
      const [namespace, id] = parsed?.path ?? []
      const facts =
        parsed?.scope === ENTITY_SUBJECT_SCOPE &&
        parsed.path.length === 2 &&
        namespace !== undefined &&
        id !== undefined
          ? await options.open(namespace, id, signal)
          : undefined
      if (facts === undefined) throw new RangeError(`no entity ${subjectId} in this source`)
      return Object.freeze({ value: facts, release: async () => undefined })
    },
    openCalculations: unsupported,
  }) as SubjectSelectorSource
}
