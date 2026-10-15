/**
 * Native adapter for SC2 localization catalogs.
 *
 * This file projects the ported MK2 library into MK3 host contracts and does not re-derive any of
 * its behaviour. That distinction is the whole point of the migration and it was previously lost
 * here: the earlier adapter validated markup with a single inline regular expression and hotkeys
 * with another, while `core/markup.ts` (575 lines, with the real tag grammar), `core/hotkeys.ts`
 * (the key-name table and modifier parsing) and `core/analysis.ts` sat beside them, imported by
 * tests only. Two implementations of the same rules cannot stay in agreement, and the one the
 * product ran was the weaker of the two.
 *
 * So everything below routes to `../lib/mk2/codecs/sc2-strings/src/core`. Where a capability needs
 * something this session cannot supply — a catalog resolver for cross-file reference checking, a
 * translation service — the operation says so and refuses, rather than shipping a lesser answer
 * under the same name.
 */
import {
  createInspectionCodec,
  createRelationGraphSource,
  createSubjectFactsSource,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromBinding,
  editPlanFromBindings,
  fact,
  replaceBytes,
  subjectIdFor,
} from '@modkit/codec-kit'
import { addStringEntry, effectiveValue, parseSc2StringsOrdered, removeStringKey, renameStringKey, serializeStringModel, setStringValue } from '../../../shared/core/text-file.js'
import type { StringFileModel } from '../../../shared/core/text-file.js'
import type { ValueSpan } from '@modkit/sdk'
import { operationId } from '@modkit/core'
import { catalogResolverFromSnapshot } from '../../../../../shared/language/catalog-resolver.js'
import {
  stringCatalogFromWorkspace,
  stringResolverFromWorkspace,
  type WorkspaceDocumentLike,
} from '../../../../../shared/language/string-workspace.js'
import { styleRefsOf } from '../../../../../shared/language/style-refs.js'
import { textRunsOf } from '../../../../layout/shared/preview-text.js'
import { languageCompletionItem } from '../../../shared/completion-items.js'
import { tokenizeStringValue } from '../../../shared/core/tokenize.js'
import type { TokenScope } from '../../../shared/core/tokenize.js'
import {
  analyzeStringFile,
  changedStringsText,
  compareLocales,
  completeStringValue,
  diffStringTexts,
  markupCatalogRefs,
  parseMarkup,
  renderMarkupHtml,
  resolveStringValue,
  protectMarkup,
  restoreMarkup,
  validateMarkupSyntax,
  validateStringRefs,
  type CatalogResolver,
  type StringDiagnostic,
} from '../../../shared/core/index.js'
import { analyzeHotkeyStringFile, validateHotkeyValue } from '../../../shared/core/hotkeys.js'
import {
  canonicalLocale,
  canonicalStringFile,
  isStringCatalog,
  localeInfo,
  SC2_LOCALES,
} from '../../../shared/core/constants.js'

const ID = 'blizzard/sc2-strings'
const EDIT_FIELD = operationId('edit.field', { contributionId: ID })
const EDIT_CONTENT = operationId('edit.content', { contributionId: ID })
const COMPARE = operationId('asset.compare', { contributionId: ID })
const TRANSLATE = operationId('blizzard/sc2-strings.translate', { contributionId: ID })
const RENDER = operationId('blizzard/sc2-strings.render', { contributionId: ID })
const HIGHLIGHT = operationId('blizzard/sc2-strings.highlight', { contributionId: ID })
const COMPLETE = operationId('blizzard/sc2-strings.complete', { contributionId: ID })
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

export const operations = Object.freeze([
  Object.freeze({ id: 'view.inspect', handlerId: 'inspect', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'export.convert', handlerId: 'export-convert', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes', 'json']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'edit-strings', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
  Object.freeze({ id: 'blizzard/sc2-strings.references', handlerId: 'references', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'blizzard/sc2-strings.resolve-fallback', handlerId: 'resolve-fallback', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'asset.compare', handlerId: 'compare-locales', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'blizzard/sc2-strings.render', handlerId: 'render-markup', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  // A value while a table cell edits it: its syntax runs and problems, then completion at the caret.
  Object.freeze({ id: 'blizzard/sc2-strings.highlight', handlerId: 'highlight-value', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'blizzard/sc2-strings.complete', handlerId: 'complete-value', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  /*
   * The surfaces (tree, table, properties) write one value through `edit.field`; this is the same
   * translation the bank codec performs, so a field edit and an `edit.content` set produce the same
   * bytes through the same ordered line model.
   */
  Object.freeze({ id: 'edit.field', handlerId: 'edit-field', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
  /*
   * Machine translation, the last MK2 operation this codec was missing.
   *
   * It reads rather than writes: the translated value is returned for a human to accept, and
   * accepting it is an ordinary `edit.field`. That separation is MK2's and it is the right one —
   * a translator that wrote straight into the file would put unreviewed text into a shipped mod.
   *
   * It asks for no network permission of its own: reaching a service is the translation provider's
   * business, and that provider declares `network` where the request actually leaves the machine.
   * A codec that also claimed it would be asking for a capability it never exercises.
   */
  // The host must supply a provider it can authorize without granting ambient I/O to this codec.
  Object.freeze({ id: 'blizzard/sc2-strings.translate', handlerId: 'translate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
])

type Entry = Readonly<{ key: string; value: string; line: number; duplicate: boolean }>
type Diagnostic = Readonly<{
  id: string
  severity: 'warning' | 'error'
  category: 'syntax' | 'structure'
  code: string
  message: string
  data?: Readonly<{ line?: number; start?: number; end?: number }>
}>

/*
 * The placeholder form the translation contract agrees on.
 *
 * `protectMarkup` masks with private-use sentinels, which survive a translation endpoint but confuse
 * a chat model — and the provider's prompt names `[[MK0]]`. Converting at this boundary keeps both
 * halves honest: the library keeps its own masking, and the service sees only what it was told to
 * preserve.
 */
const SENTINEL_OPEN = String.fromCharCode(0xe000)
const SENTINEL_CLOSE = String.fromCharCode(0xe001)
// Doubled backslashes: this is a template literal, where a lone `\s` is just the letter s.
const SENTINEL_RE = new RegExp(`${SENTINEL_OPEN}\\s*(\\d+)\\s*${SENTINEL_CLOSE}`, 'gu')
const CONTRACT_PLACEHOLDER_RE = /\[\[\s*MK\s*(\d+)\s*\]\]/giu

function placeholderAt(index: number): string {
  return `${SENTINEL_OPEN}${index}${SENTINEL_CLOSE}`
}

function toContractPlaceholders(masked: string): string {
  return masked.replace(SENTINEL_RE, (_, index: string) => `[[MK${Number(index)}]]`)
}

function fromContractPlaceholders(text: string): string {
  return text.replace(CONTRACT_PLACEHOLDER_RE, (_, index: string) => placeholderAt(Number(index)))
}

/**
 * The value as a reader sees it in the game, without a catalog.
 *
 * MK2's strings editor had two views of every row — the markup a modder writes and the text a player
 * reads — and a toggle between them, because they answer different questions: one is what you edit,
 * the other is what you shipped. This is the second, computed with an empty resolver so it works on
 * a file opened by itself.
 *
 * What an empty resolver costs is stated rather than hidden: a `<d ref>` that cannot resolve renders
 * as `?`, so a value built mostly from data references previews mostly as question marks. That is
 * the truth about what this session can see, and it is deliberately visible — supplying a resolver
 * through the catalog service is what fills them in.
 */
const EMPTY_RESOLVER: CatalogResolver = { getResolved: () => undefined }

function previewText(value: string): string {
  /*
   * The `///` comment is a translator's note, not part of the string, and MK2 stripped it from the
   * preview for the same reason: it is never shown to a player.
   */
  const comment = value.indexOf('///')
  return (comment >= 0 ? value.slice(0, comment) : value).replace(/[ 	]+$/u, '')
}

function previewOf(value: string): string {
  const withoutComment = previewText(value)
  try {
    return resolveStringValue(withoutComment, EMPTY_RESOLVER).rendered
  } catch {
    // A value whose markup does not parse has no rendering; the raw text is the honest fallback.
    return withoutComment
  }
}

/**
 * The path a subject URI names. A member of a package or an archive carries its path inside the
 * container as a percent-encoded `vfs-path` query, so the raw URI holds one opaque segment and a
 * catalog there would look like prose in an unknown place.
 */
function subjectPath(uri: string) {
  const inner = /[?&]vfs-path=([^&#]*)/u.exec(uri)?.[1]
  if (inner === undefined) return uri
  try {
    return decodeURIComponent(inner)
  } catch {
    return inner
  }
}

function normalizePath(uri: string) {
  return subjectPath(uri).replaceAll('\\', '/').toLowerCase()
}

/** `GameHotkeys.txt` carries key bindings, not prose, and is checked by different rules. */
function isHotkeyPath(uri: string) {
  return /(?:^|\/)gamehotkeys\.txt$/iu.test(normalizePath(uri))
}

/**
 * Which SC2 catalog and locale this path names, using the ported canonicalization tables rather
 * than a hand-written pattern — those tables know every catalog stem and every locale directory
 * the game ships, including the ones nobody remembers.
 */
function catalogContext(uri: string): { catalog?: string; locale?: string } {
  const path = subjectPath(uri).replaceAll('\\', '/')
  const file = path.split('/').at(-1) ?? ''
  /*
   * `canonicalStringFile` normalises a stem, it does not judge one: it returns an unknown stem
   * unchanged, so asking it alone made every key/value text file a catalog.
   */
  const stem = file.replace(/\.txt$/iu, '')
  const catalog = isStringCatalog(stem) ? canonicalStringFile(stem) : undefined
  /*
   * The locale is a directory somewhere above the file, not necessarily its parent: a catalog lives
   * at `enUS.SC2Data/LocalizedData/GameStrings.txt`, so the parent is `LocalizedData`. Each segment
   * is offered to the canonicalization table, with its `.SC2Data` suffix removed, and the first one
   * the table recognises wins. `parseIndexSc2Locale` is not used here — it reads a DocumentInfo
   * XML, not a path.
   */
  const locale = path
    .split('/')
    .map(segment => canonicalLocale(segment.replace(/\.sc2data$/iu, '')))
    .find(candidate => candidate !== undefined && candidate !== null)
  return {
    ...(catalog === undefined ? {} : { catalog }),
    ...(locale === undefined || locale === null ? {} : { locale }),
  }
}

function sourceText(bytes: Uint8Array, max: number) {
  if (bytes.byteLength > max) throw new RangeError('SC2 strings exceeds maxScalarBytes budget')
  if (bytes.includes(0)) throw new TypeError('SC2 strings contains a NUL byte')
  return decoder.decode(bytes)
}

function hasEntries(bytes: Uint8Array) {
  try {
    return parseSc2StringsOrdered(bytes).lines.some(line => line.isEntry)
  } catch {
    return false
  }
}

function effectiveEntries(model: StringFileModel): readonly Entry[] {
  const result: Entry[] = []
  for (const [key, lines] of model.index) {
    const line = lines.at(-1)
    if (line !== undefined) {
      result.push(
        Object.freeze({
          key,
          value: line.value,
          line: model.lines.indexOf(line),
          duplicate: lines.length > 1,
        }),
      )
    }
  }
  return Object.freeze(result.sort((left, right) => left.key.localeCompare(right.key)))
}

/**
 * The library's diagnostics, mapped onto the host's shape.
 *
 * `analyzeStringFile` covers duplicate keys and markup; `analyzeHotkeyStringFile` covers binding
 * files. Both are the MK2 implementations, so a catalog this codec calls clean is one MK2 called
 * clean. Broken cross-file references need a `CatalogResolver` the codec is not given here, and
 * that limitation is stated in `unsupportedFeatures` instead of being silently skipped.
 */
function diagnosticsFor(model: StringFileModel, hotkeys: boolean): readonly Diagnostic[] {
  // Both analyzers report a duplicate key in a hotkey file, so the id names its analyzer; the
  // host rejects a descriptor whose diagnostic ids repeat.
  const found: (StringDiagnostic & { source: string })[] = [
    ...analyzeStringFile(model).map(item => ({ ...item, source: '' })),
    ...(hotkeys ? analyzeHotkeyStringFile(model).map(item => ({ ...item, source: 'hotkeys.' })) : []),
  ]
  return Object.freeze(
    found.map((item): Diagnostic => {
      const span =
        item.start === undefined
          ? {}
          : { start: item.start, ...(item.end === undefined ? {} : { end: item.end }) }
      return Object.freeze({
        id: `sc2-strings.${item.source}${item.code}.${item.line}.${item.start ?? 0}`,
        severity: item.severity,
        category: item.code === 'duplicate-key' ? 'structure' : 'syntax',
        code: `blizzard.sc2-strings/${item.code}`,
        message: item.message,
        data: Object.freeze({ line: item.line, ...span }),
      })
    }),
  )
}

/**
 * Catalog references, from the library's markup parser rather than a second regular expression.
 *
 * The shape is the one MK2 reports — namespace, entity, field — and it is deliberately not the
 * character range the previous adapter invented. `markupCatalogRefs` walks nested colour, style,
 * list and container segments and reads `ref`, `time`, `dynamic` and token expressions, so it finds
 * references the old top-level `<d ref=…>` pattern could not see; those have no single offset in
 * the source text, and reporting a made-up one would be worse than reporting none.
 */
function references(entries: readonly Entry[]) {
  const result: { key: string; line: number; ns: string; entity: string; field: string }[] = []
  for (const entry of entries) {
    for (const ref of markupCatalogRefs(entry.value)) {
      result.push({ key: entry.key, line: entry.line, ns: ref.ns, entity: ref.entity, field: ref.field })
    }
  }
  return Object.freeze(result)
}

/**
 * A catalog resolver built from what a caller supplied, or nothing.
 *
 * The real resolver belongs to the data codec and reaches this one as a host service; until that
 * service exists a caller may hand over the two lookups markup actually needs. Returning
 * `undefined` rather than an empty resolver matters: an empty one would answer "no such entity" to
 * every reference and report a healthy catalog as broken.
 */
function catalogResolverOf(input: unknown): CatalogResolver | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const supplied = input as {
    entities?: unknown
    strings?: unknown
    snapshot?: unknown
    styles?: unknown
  }

  /*
   * A catalog-analysis snapshot is the real route: `common.data/catalog-analysis@1` already
   * publishes resolved entities and localized strings, and the SC2 data provider already implements
   * it. Handing one over is how a caller says "resolve against this mod".
   */
  if (supplied.snapshot !== null && typeof supplied.snapshot === 'object') {
    return catalogResolverFromSnapshot(
      supplied.snapshot as never,
      (supplied.styles ?? {}) as never,
    ).resolver
  }

  /*
   * The literal form stays for callers that hold a handful of values and no analyzer — a test, a
   * script, a preview of one string. It is deliberately not the primary path.
   */
  const entities =
    supplied.entities !== null && typeof supplied.entities === 'object' && !Array.isArray(supplied.entities)
      ? (supplied.entities as Record<string, Record<string, unknown>>)
      : {}
  const strings =
    supplied.strings !== null && typeof supplied.strings === 'object' && !Array.isArray(supplied.strings)
      ? (supplied.strings as Record<string, string>)
      : {}
  if (Object.keys(entities).length === 0 && Object.keys(strings).length === 0 && supplied.styles === undefined) return undefined
  return {
    ...catalogResolverFromSnapshot({}, (supplied.styles ?? {}) as never).resolver,
    getResolved(ns: string, id: string) {
      return entities[`${ns}/${id}`]
    },
    getString(key: string) {
      return strings[key]
    },
  }
}

/**
 * The library's markup scopes, mapped onto the contract's token kinds for a one-line cell.
 *
 * The same mapping the language provider uses, and for the same reason: several scopes name a
 * reference into another file and the contract has one word for that idea. Only the runs worth
 * seeing in a narrow cell are emitted — plain text is left alone, because colouring everything
 * colours nothing.
 */
const CELL_TOKEN: Readonly<Partial<Record<TokenScope, ValueSpanKind>>> = Object.freeze({
  comment: 'comment',
  tag: 'keyword',
  attribute: 'property',
  ref: 'variable',
  stringref: 'variable',
  galaxyvar: 'variable',
  dynamic: 'variable',
  token: 'variable',
  hotkey: 'keyword',
  image: 'string',
})

/*
 * The contract's own span type rather than a local copy of its shape. They agreed by accident until
 * the table moved onto the kit's shared source, which types the cell it returns — and a local type
 * that merely looks the same is exactly the drift that check exists to catch.
 */
type ValueSpanKind = ValueSpan['kind']

/** Syntax runs over one stored string, for the tree and the table. */
function valueSpans(value: string): readonly ValueSpan[] | undefined {
  const spans: ValueSpan[] = []
  for (const token of tokenizeStringValue(value)) {
    const kind = CELL_TOKEN[token.scope]
    if (kind === undefined) continue
    spans.push({ from: token.start, to: token.end, kind })
  }
  return spans.length === 0 ? undefined : Object.freeze(spans)
}

/**
 * The catalog as a translator reads it: one row per key, one column per locale of the mod.
 *
 * Paging and search are the kit's shared table. What is about strings is the rest: locale columns
 * carry markup and are edited in place through `edit.field`, the preview renders the base locale,
 * and the status column says which rows need a translator. The shape also names the operations a
 * surface may call over the rows, so the surface needs no knowledge of this codec.
 */
const CATALOG_BATCH = 1024
/** How long a page of rows waits for the reference check before it goes out without it. */
const BROKEN_REF_WAIT_MS = 2_000

/**
 * The keys whose `<d ref>`/`<s ref>` names an entity the subject's mod context does not have, asked
 * once, the first time the table's rows are read. A cold mod context resolves its whole chain first
 * (Liberty: ~45 s), so a page waits for the answer only briefly (`BROKEN_REF_WAIT_MS`) and pages
 * read after it arrives carry it; a warm context answers within the wait. Only a
 * missing entity condemns a row: a missing field may be a structure default the resolved fields
 * leave out. Without a mod context, or when it cannot answer, nothing is called broken.
 */
function brokenRefKeysOf(
  variants: readonly Variant[],
  catalog: StringsContribution['catalog'],
): ((signal?: AbortSignal) => Promise<ReadonlySet<string>>) | undefined {
  if (catalog === undefined) return undefined
  const perVariant = variants.map(variant =>
    effectiveEntries(variant.model).map(entry => [entry.key, entry.value] as [string, string]),
  )
  const refs = [
    ...new Map(
      perVariant
        .flat()
        .flatMap(([, value]) => markupCatalogRefs(value))
        .map(ref => ({ namespace: ref.ns, entityId: ref.entity.replace(/@.*$/u, '') }))
        .map(ref => [`${ref.namespace}/${ref.entityId}`, ref] as const),
    ).values(),
  ]
  if (refs.length === 0) return undefined
  let asked: Promise<ReadonlySet<string>> | undefined
  return signal =>
    (asked ??= (async () => {
      const entities: unknown[] = []
      for (let start = 0; start < refs.length; start += CATALOG_BATCH)
        entities.push(...(await catalog.entities(refs.slice(start, start + CATALOG_BATCH), signal)))
      const resolver = catalogResolverFromSnapshot({
        entities: entities.filter(
          (entity): entity is CatalogEntity =>
            typeof (entity as CatalogEntity | null)?.namespace === 'string' &&
            typeof (entity as CatalogEntity).entityId === 'string' &&
            typeof (entity as CatalogEntity).fields === 'object',
        ),
      }).resolver
      const broken = new Set<string>()
      for (const entries of perVariant)
        for (const issue of validateStringRefs(entries, resolver))
          if (issue.error.startsWith('entity-not-found:')) broken.add(issue.key)
      return broken
    })().catch(() => {
      asked = undefined
      return new Set<string>()
    }))
}

function tableDataSource(
  variants: readonly Variant[],
  base: Variant,
  rows: readonly LocaleRow[],
  brokenRefKeys?: (signal?: AbortSignal) => Promise<ReadonlySet<string>>,
) {
  const baseIndex = variants.indexOf(base)
  const source = createTableDataSource({
    header: ['Key', ...variants.map(variant => variant.locale), 'Preview', 'Status'],
    rows: rows.map(row => [
      row.key,
      ...row.values.map(value => value ?? ''),
      previewOf(row.values[baseIndex] ?? ''),
      row.status,
    ]),
    cellFacts: (coord, value) => {
      if (coord.column < 1 || coord.column > variants.length) return undefined
      const spans = valueSpans(value)
      return {
        type: { kind: 'text' as const, multiline: value.includes('\n') },
        editable: { write: { operation: EDIT_FIELD }, editor: 'scalar' },
        ...(spans === undefined ? {} : { spans }),
      }
    },
  })
  // The check is asked once; only the first page waits for it (briefly), later pages take what is known.
  let known: ReadonlySet<string> | undefined
  let waited = false
  const brokenRefs =
    brokenRefKeys === undefined
      ? undefined
      : async (signal?: AbortSignal): Promise<ReadonlySet<string> | undefined> => {
          const check = brokenRefKeys().then(keys => (known = keys))
          if (known !== undefined || waited) return known
          waited = true
          let timer: ReturnType<typeof setTimeout> | undefined
          const answer = await Promise.race([
            check,
            new Promise<undefined>(resolve => {
              timer = setTimeout(() => resolve(undefined), BROKEN_REF_WAIT_MS)
            }),
          ]).finally(() => clearTimeout(timer))
          signal?.throwIfAborted()
          return answer
        }
  const columnInfo = Object.freeze([
    { role: 'key' },
    ...variants.map(variant => {
      const language = localeInfo(variant.locale)?.iso639
      return {
        role: 'variant',
        variant: variant.locale,
        ...(language === undefined ? {} : { language }),
        ...(variant === base ? { base: true } : {}),
      }
    }),
    { role: 'detail' },
    { role: 'status' },
  ])
  const actions = Object.freeze({
    addRow: EDIT_CONTENT,
    compareVariants: COMPARE,
    translateVariant: TRANSLATE,
    renderValues: RENDER,
    highlightValue: HIGHLIGHT,
    completeValue: COMPLETE,
  })
  return Object.freeze({
    ...source,
    async shape() {
      return { ...(await source.shape()), columnInfo, actions, keySeparator: '/' }
    },
    // A row naming an entity the mod context lacks carries `broken-ref` for the table's filters (7.36).
    async rows(request: Parameters<typeof source.rows>[0], signal?: AbortSignal) {
      const page = await source.rows(request, signal)
      const broken = await brokenRefs?.(signal)
      signal?.throwIfAborted()
      if (broken === undefined || broken.size === 0) return page
      return Object.freeze({
        ...page,
        items: Object.freeze(
          page.items.map(row =>
            broken.has(row.cells[0] ?? '')
              ? Object.freeze({
                  ...row,
                  cells: Object.freeze(
                    row.cells.map((cell, index) =>
                      index === row.cells.length - 1 ? [cell, 'broken-ref'].filter(Boolean).join(' ') : cell,
                    ),
                  ),
                })
              : row,
          ),
        ),
      })
    },
  })
}

/** The documents a host put around the subject, as `view.template` receives them. */
function workspaceDocumentsOf(input: unknown): WorkspaceDocumentLike[] {
  const documents = (input as { workspaceDocuments?: unknown } | null)?.workspaceDocuments
  if (!Array.isArray(documents)) return []
  return documents.filter(
    (document): document is WorkspaceDocumentLike =>
      typeof document?.uri === 'string' &&
      typeof document.languageId === 'string' &&
      typeof document.text === 'string',
  )
}

type CatalogEntity = { namespace: string; entityId: string; fields: Record<string, unknown> }

/**
 * The table's rendered values, as runs a generic surface draws.
 *
 * Styles and localized strings come from the documents around the subject; `<d ref>` values come
 * from the host's answer to `catalogQueries`, which are authoritative (parents applied) and so win
 * over an entity a GameData document in the snapshot declares. Until the answer arrives the values
 * still render, each missing value as a `?` run that says why.
 */
function renderValues(input: { items: unknown[]; catalogEntities?: unknown }) {
  const texts = input.items.map((item, index) => {
    const text = (item as { text?: unknown } | null)?.text
    if (typeof text !== 'string') throw new TypeError(`render item ${index} requires text`)
    return previewText(text)
  })
  const answered = Array.isArray(input.catalogEntities)
  const entities = answered
    ? (input.catalogEntities as unknown[]).filter(
        (entity): entity is CatalogEntity =>
          typeof (entity as CatalogEntity | null)?.namespace === 'string' &&
          typeof (entity as CatalogEntity).entityId === 'string' &&
          typeof (entity as CatalogEntity).fields === 'object',
      )
    : []
  // ponytail: the snapshot is parsed per call; one call covers every visible cell, cache if typing lags.
  const fromDocuments = stringResolverFromWorkspace(workspaceDocumentsOf(input))
  const fromCatalog = catalogResolverFromSnapshot({ entities }).resolver
  const resolver: CatalogResolver = {
    ...fromDocuments,
    getResolved: (namespace, id) =>
      fromCatalog.getResolved(namespace, id) ?? fromDocuments.getResolved(namespace, id),
  }
  const items = texts.map(text => {
    try {
      return { runs: textRunsOf(resolveStringValue(text, resolver).segments) }
    } catch {
      // Markup that does not parse has no rendering; the raw text is the honest fallback.
      return { runs: text === '' ? [] : [{ text }] }
    }
  })
  const queries = answered
    ? []
    : [
        ...new Map(
          texts
            .flatMap(markupCatalogRefs)
            .map(ref => ({ namespace: ref.ns, entityId: ref.entity.replace(/@.*$/u, '') }))
            .map(ref => [`${ref.namespace}/${ref.entityId}`, ref]),
        ).values(),
      ]
  return { items, ...(queries.length === 0 ? {} : { catalogQueries: queries }) }
}

function highlightValue(input: unknown) {
  const text = (input as { text?: unknown } | null)?.text
  if (typeof text !== 'string') throw new TypeError('highlight requires text')
  return {
    spans: valueSpans(text) ?? [],
    // The same rule `asset.validate` reports per line, at the characters of this one value.
    diagnostics: validateMarkupSyntax(text).map(issue => ({
      from: issue.offset,
      to: issue.offset + issue.raw.length,
      message: issue.message,
      severity: 'error' as const,
      code: issue.code,
    })),
  }
}

function completeValue(input: unknown, keys: readonly string[]) {
  const request = input as { text?: unknown; offset?: unknown } | null
  const text = request?.text
  const offset = request?.offset
  if (typeof text !== 'string' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new TypeError('completion requires text and an offset inside it')
  }
  const documents = workspaceDocumentsOf(input)
  const result = completeStringValue({
    text,
    offset,
    // As the language provider does: this catalog's own keys are part of the vocabulary.
    ...(documents.length === 0 ? {} : { catalog: stringCatalogFromWorkspace(documents, keys) }),
  })
  return { from: offset - result.replaceLength, to: offset, items: result.items.map(languageCompletionItem) }
}

/** A locale supplied as JSON, turned into the same ordered model the library works in. */
function modelOfLocale(input: unknown): { locale: string; model: StringFileModel } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('locale input must be an object')
  }
  const value = input as { entries?: unknown; locale?: unknown }
  if (!Array.isArray(value.entries)) throw new TypeError('locale entries must be an array')
  const lines = value.entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`locale entry ${index} must be an object`)
    }
    const record = entry as { key?: unknown; value?: unknown }
    if (typeof record.key !== 'string' || typeof record.value !== 'string') {
      throw new TypeError(`locale entry ${index} requires string key and value`)
    }
    return `${record.key}=${record.value}`
  })
  return {
    locale: typeof value.locale === 'string' ? value.locale : 'secondary',
    model: parseSc2StringsOrdered(encoder.encode(lines.join('\n'))),
  }
}

function edit(model: StringFileModel, input: unknown) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('edit.content requires an action object')
  }
  const request = input as {
    action?: unknown
    key?: unknown
    value?: unknown
    oldKey?: unknown
    newKey?: unknown
    afterKey?: unknown
  }
  if (request.action === 'set' && typeof request.key === 'string' && typeof request.value === 'string') {
    return { changed: setStringValue(model, request.key, request.value), action: 'set' }
  }
  if (
    request.action === 'rename' &&
    typeof request.oldKey === 'string' &&
    typeof request.newKey === 'string'
  ) {
    return { changed: renameStringKey(model, request.oldKey, request.newKey) > 0, action: 'rename' }
  }
  if (request.action === 'delete' && typeof request.key === 'string') {
    return { changed: removeStringKey(model, request.key) > 0, action: 'delete' }
  }
  if (
    request.action === 'add' &&
    typeof request.key === 'string' &&
    typeof request.value === 'string' &&
    (request.afterKey === undefined || typeof request.afterKey === 'string')
  ) {
    if (effectiveValue(model, request.key) !== undefined) {
      throw new TypeError(`"${request.key}" already exists in this catalog`)
    }
    addStringEntry(model, request.key, request.value, request.afterKey)
    return { changed: true, action: 'add' }
  }
  // A batch into one locale (accepted translations): set each key, add the ones it lacks.
  if (request.action === 'set-many' && Array.isArray((request as { entries?: unknown }).entries)) {
    let changed = false
    for (const entry of (request as { entries: unknown[] }).entries) {
      const item = entry as { key?: unknown; value?: unknown }
      if (typeof item?.key !== 'string' || typeof item.value !== 'string') {
        throw new TypeError('set-many entries require string key and value')
      }
      if (effectiveValue(model, item.key) === undefined) {
        addStringEntry(model, item.key, item.value)
        changed = true
      } else changed = setStringValue(model, item.key, item.value) || changed
    }
    return { changed, action: 'set-many' }
  }
  throw new TypeError(
    'edit.content requires set {key,value}, rename {oldKey,newKey}, delete {key}, add {key,value,afterKey?} or set-many {entries}',
  )
}

/*
 * The other locales of this catalog, as host-issued bindings.
 *
 * A catalog lives at `<locale>.SC2Data/LocalizedData/<file>`, and its translations are the same
 * file under the other locale directories of the same mod. The codec names them as exact
 * container-relative paths and the host decides whether and where they exist — inside an archive,
 * or inside a loose `Foo.SC2Mod` folder. The codec never lists a directory.
 */
const LOCALES_REQUIREMENT = 'locales'

/** `…/enUS.SC2Data/LocalizedData/GameStrings.txt` → its locale and file name. */
function localizedPath(uri: string): { locale: string; file: string } | undefined {
  let path = uri
  try {
    path = decodeURIComponent(uri)
  } catch {
    // an undecodable URI is read as written
  }
  const parts = path.replaceAll(String.fromCharCode(92), '/').split('/')
  const file = parts.at(-1)
  const data = parts.at(-3)?.split(/[?#=]/u).at(-1)
  if (file === undefined || data === undefined) return undefined
  if (parts.at(-2)?.toLowerCase() !== 'localizeddata' || !/\.sc2data$/iu.test(data)) return undefined
  const locale = canonicalLocale(data.slice(0, -'.sc2data'.length))
  return locale === undefined || file === '' ? undefined : { locale, file }
}

function plannedLocales(uri: string) {
  const single = Object.freeze({
    originKind: 'single' as const,
    candidate: Object.freeze({ bindingId: 'content', role: 'content', ownership: 'owned' as const }),
    requirements: Object.freeze([]),
  })
  const here = localizedPath(uri)
  if (here === undefined) return single
  return Object.freeze({
    originKind: 'bundle' as const,
    candidate: single.candidate,
    requirements: Object.freeze([
      Object.freeze({
        id: LOCALES_REQUIREMENT,
        role: 'localization',
        // Owned: the table writes a translation into its own locale file.
        ownership: 'owned' as const,
        patterns: Object.freeze(
          SC2_LOCALES.filter(locale => locale.id !== here.locale).map(
            locale => `${locale.id}.SC2Data/LocalizedData/${here.file}`,
          ),
        ),
        scopes: Object.freeze(['enclosing-container', 'current-mount'] as const),
        cardinality: 'many' as const,
        required: false as const,
      }),
    ]),
  })
}

/** One locale of the catalog: its bytes, its model and the binding a write goes to. */
interface Variant {
  readonly locale: string
  readonly bindingId: string
  readonly bytes: Uint8Array
  readonly model: StringFileModel
}

async function readSource(source: any, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of source.stream(undefined, signal) as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > max) throw new RangeError('SC2 strings locale exceeds maxScalarBytes budget')
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** The primary first, then every bound sibling locale in the game's own locale order. */
async function variantsOf(bytes: Uint8Array, model: StringFileModel, context: any): Promise<Variant[]> {
  const input = context.input
  const own = catalogContext(String(context.primary.source.uri)).locale ?? 'value'
  const variants: Variant[] = [{ locale: own, bindingId: input.primaryBindingId, bytes, model }]
  for (const binding of input.bindingsFor?.(LOCALES_REQUIREMENT) ?? []) {
    const locale = localizedPath(String(binding.source.uri))?.locale
    if (locale === undefined || variants.some(variant => variant.locale === locale)) continue
    const lease = await input.openBinding(binding.bindingId, context.signal)
    try {
      if (lease.value.kind !== 'bytes') continue
      const read = await readSource(lease.value, context.budget.maxScalarBytes, context.signal)
      variants.push({ locale, bindingId: binding.bindingId, bytes: read, model: parseSc2StringsOrdered(read) })
    } finally {
      await lease.release()
    }
  }
  const rank = (locale: string) => SC2_LOCALES.findIndex(item => item.id === locale)
  return [variants[0]!, ...variants.slice(1).sort((left, right) => rank(left.locale) - rank(right.locale))]
}

/** The locale others are compared with and translated from: enUS when the mod has it. */
function baseOf(variants: readonly Variant[]): Variant {
  return variants.find(variant => variant.locale === 'enUS') ?? variants[0]!
}

interface LocaleRow {
  readonly key: string
  readonly values: readonly (string | undefined)[]
  readonly status: string
}

/** Every key of every locale, with the status tokens `TableRowStatus` defines. */
function localeRows(variants: readonly Variant[], base: Variant, hotkeys = false): readonly LocaleRow[] {
  const maps = variants.map(variant => new Map(effectiveEntries(variant.model).map(entry => [entry.key, entry])))
  const baseMap = maps[variants.indexOf(base)]!
  const keys = [...new Set(maps.flatMap(map => [...map.keys()]))].sort((left, right) => left.localeCompare(right))
  return keys.map(key => {
    const values = maps.map(map => map.get(key)?.value)
    const baseValue = baseMap.get(key)?.value
    const others = values.filter((_, index) => maps[index] !== baseMap)
    const status = [
      ...(variants.length > 1 && (baseValue === undefined || others.some(value => value === undefined || (value === '' && baseValue !== '')))
        ? ['missing']
        : []),
      ...(baseValue !== undefined && baseValue !== '' && others.some(value => value === baseValue) ? ['untranslated'] : []),
      ...(maps.some(map => map.get(key)?.duplicate === true) ? ['duplicate'] : []),
      // A value the game cannot read as written, for the table's Errors filter (plan 7.36).
      ...(values.some(value => value !== undefined && (hotkeys ? validateHotkeyValue(value) : validateMarkupSyntax(value)).length > 0)
        ? ['error']
        : []),
    ].join(' ')
    return { key, values, status }
  })
}

function variantRequest(input: any): string | undefined {
  return typeof input?.variant === 'string' ? input.variant : undefined
}

type StringsContribution = {
  contracts?: { resolve(selection: unknown): Promise<unknown> }
  /** The subject's mod context, when the host placed it in one (`ContributionContext.catalog`). */
  catalog?: { entities(refs: readonly { namespace: string; entityId: string }[], signal?: AbortSignal): Promise<readonly unknown[]> }
}

const definition = (contribution: StringsContribution | undefined): any => Object.freeze({
  id: ID,
  format: Object.freeze({
    id: 'sc2-strings',
    label: 'StarCraft II Localization Strings',
    mediaType: 'text/x-sc2-strings',
  }),
  operations,
  async planInput(source: any) {
    return plannedLocales(String(source?.ref?.uri ?? ''))
  },
  async detect(prefix: Uint8Array, uri: string) {
    if (!hasEntries(prefix)) {
      return { confidence: 0, kind: 'structure', note: 'no-sc2-key-value-entries' }
    }
    if (isHotkeyPath(uri)) {
      return { confidence: 0.99, kind: 'context', note: 'gamehotkeys-path-and-entries' }
    }
    /*
     * A catalog is recognised by the ported canonicalization tables: a known stem such as
     * `GameStrings` and a known locale directory. Both raise confidence independently, because a
     * mod can put a catalog somewhere unusual and a locale directory can hold an unusual stem.
     */
    const context = catalogContext(uri)
    if (context.catalog !== undefined && context.locale !== undefined) {
      return { confidence: 0.995, kind: 'context', note: 'known-catalog-and-locale' }
    }
    if (context.catalog !== undefined) {
      return { confidence: 0.9, kind: 'context', note: 'known-catalog-stem' }
    }
    if (context.locale !== undefined) {
      return { confidence: 0.6, kind: 'context', note: 'known-locale-directory' }
    }
    return { confidence: 0, kind: 'structure', note: 'key-value-text-without-sc2-path-context' }
  },
  async inspect(bytes: Uint8Array, context: any) {
    sourceText(bytes, context.budget.maxScalarBytes)
    const model = parseSc2StringsOrdered(bytes)
    const entries = effectiveEntries(model)
    if (entries.length === 0) throw new TypeError('SC2 strings contains no key/value entries')
    if (entries.length > context.budget.maxNodes) {
      throw new RangeError('SC2 strings entries exceed maxNodes budget')
    }
    const uri = String(context.primary.source.uri)
    const hotkeys = isHotkeyPath(uri)
    const catalog = catalogContext(uri)
    const refs = references(entries)
    const diagnostics = diagnosticsFor(model, hotkeys)
    const serialized = encoder.encode(serializeStringModel(model))
    const variants = await variantsOf(bytes, model, context)
    const base = baseOf(variants)
    const rows = localeRows(variants, base, hotkeys)
    const variantFor = (locale: unknown) => variants.find(variant => variant.locale === locale)

    /**
     * Build the edit plan for one change, whichever handler asked for it.
     *
     * The plan replaces the whole file, which is not wasteful here: the ordered line model
     * round-trips byte for byte, so replacing an untouched region writes the bytes that were
     * already there — and that is what makes the fidelity claim below one the model can keep.
     */
    const planFor = async (request: unknown, variant: Variant = variants[0]!) => {
      const edited = parseSc2StringsOrdered(variant.bytes)
      const result = edit(edited, request)
      const output = encoder.encode(serializeStringModel(edited))
      return {
        kind: 'edit-plan' as const,
        // One plan writes one locale file; every other bound locale stays a revision guard.
        plan: editPlanFromBinding(context.input, variant.bindingId, {
          planId: `${ID}:${context.input.revisions.revision}:${variant.locale}:${result.action}:${result.changed ? 'changed' : 'unchanged'}`,
          edits: [replaceBytes(0, variant.bytes.byteLength, output, 'lossless SC2 strings edit')],
          fidelity: {
            roundTrip: 'byte-identical',
            preservesUnknownData: true,
            notes: [
              'The canonical ordered line model preserves BOM, comments, blank lines, per-line terminators, duplicate order, and untouched values.',
            ],
          },
        }),
      }
    }
    /*
     * Values across several bound locales as one atomic plan: each touched locale file gets one
     * lossless rewrite (the same `set-many` a single locale takes: a key it lacks is added), every
     * other bound locale stays a revision guard. VS Code's "Replace all" over a table writes this;
     * a series of single-locale plans would conflict on the revision after the first.
     */
    const planForVariants = async (entries: unknown) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new TypeError('set-variants requires entries [{ key, variant, value }]')
      }
      const byVariant = new Map<Variant, { key: string; value: string }[]>()
      for (const entry of entries) {
        const item = entry as { key?: unknown; variant?: unknown; value?: unknown }
        if (typeof item?.key !== 'string' || typeof item.variant !== 'string' || typeof item.value !== 'string') {
          throw new TypeError('set-variants entries require string key, variant and value')
        }
        const variant = variantFor(item.variant)
        if (variant === undefined) throw new TypeError(`this catalog has no bound locale "${item.variant}"`)
        const items = byVariant.get(variant) ?? []
        items.push({ key: item.key, value: item.value })
        byVariant.set(variant, items)
      }
      return planAcross(
        new Map([...byVariant].map(([variant, items]) => [variant, { action: 'set-many', entries: items }])),
        'set-variants',
      )
    }
    /*
     * A key renamed or deleted in every bound locale that holds it, as one plan (parity plan 7.34:
     * the table's key column). A rename onto a key some locale already holds is refused rather
     * than merging two keys' lines.
     */
    const planForKey = async (input: { action: string; key?: unknown; oldKey?: unknown; newKey?: unknown }) => {
      const key = input.action === 'rename-variants' ? input.oldKey : input.key
      if (typeof key !== 'string' || key === '') throw new TypeError(`${input.action} requires a key`)
      const holders = variants.filter(variant => variant.model.index.has(key))
      if (holders.length === 0) throw new TypeError(`no string "${key}" in this catalog`)
      if (input.action === 'delete-variants') {
        return planAcross(new Map(holders.map(variant => [variant, { action: 'delete', key }])), 'delete-variants')
      }
      const newKey = input.newKey
      if (typeof newKey !== 'string' || newKey === '' || newKey.includes('=') || /[\r\n]/u.test(newKey)) {
        throw new TypeError('rename-variants requires a new key without "=" or line breaks')
      }
      const taken = variants.find(variant => variant.model.index.has(newKey))
      if (taken !== undefined && newKey !== key) {
        throw new TypeError(`"${newKey}" already exists in locale ${taken.locale}`)
      }
      return planAcross(
        new Map(holders.map(variant => [variant, { action: 'rename', oldKey: key, newKey }])),
        'rename-variants',
      )
    }
    /*
     * One plan over several bound locales: each locale given a change gets one lossless rewrite,
     * every other bound locale stays a revision guard. A series of single-locale plans would
     * conflict on the revision after the first.
     */
    const planAcross = (changes: ReadonlyMap<Variant, unknown>, label: string) => {
      let changed = false
      const edits = [...changes].map(([variant, request]) => {
        const edited = parseSc2StringsOrdered(variant.bytes)
        changed = edit(edited, request).changed || changed
        const output = encoder.encode(serializeStringModel(edited))
        return {
          ...replaceBytes(0, variant.bytes.byteLength, output, `lossless SC2 strings edit (${variant.locale})`),
          targetId: variant.bindingId,
        }
      })
      return {
        kind: 'edit-plan' as const,
        plan: editPlanFromBindings(context.input, [...changes.keys()].map(variant => variant.bindingId), {
          planId: `${ID}:${context.input.revisions.revision}:${[...changes.keys()].map(variant => variant.locale).join('+')}:${label}:${changed ? 'changed' : 'unchanged'}`,
          edits,
          fidelity: {
            roundTrip: 'byte-identical',
            preservesUnknownData: true,
            notes: [
              'The canonical ordered line model preserves BOM, comments, blank lines, per-line terminators, duplicate order, and untouched values.',
            ],
          },
        }),
      }
    }
    const tree = createTreeDataSource({
      kind: 'sc2-strings-catalog',
      label: 'SC2 localization catalog',
      preview: `${entries.length} keys`,
      children: stringKeyTree(entries),
    })
    return {
      summary: Object.freeze({
        format: 'sc2-strings',
        entries: entries.length,
        duplicateKeys: entries.filter(entry => entry.duplicate).length,
        references: refs.length,
        ...(catalog.catalog === undefined ? {} : { catalog: catalog.catalog }),
        ...(catalog.locale === undefined ? {} : { locale: catalog.locale }),
        byteExact:
          serialized.length === bytes.length && serialized.every((value, index) => value === bytes[index]),
      }),
      metadata: [
        Object.freeze({
          id: 'catalog',
          label: 'SC2 localization catalog',
          entries: Object.freeze([
            { key: 'entries', value: entries.length },
            { key: 'duplicates', value: entries.filter(entry => entry.duplicate).length },
            { key: 'references', value: refs.length },
            ...(catalog.catalog === undefined ? [] : [{ key: 'catalog', value: catalog.catalog }]),
            ...(catalog.locale === undefined ? [] : [{ key: 'locale', value: catalog.locale }]),
          ]),
        }),
      ],
      traits: [
        Object.freeze({
          id: 'content.text',
          parameters: { language: 'sc2-strings', encoding: 'utf-8' },
        }),
        Object.freeze({ id: 'game.localization', parameters: { entries: entries.length } }),
        Object.freeze({ id: 'structure.hierarchy', parameters: { kind: 'catalog' } }),
        Object.freeze({
          id: 'table.cells',
          parameters: { rows: rows.length, locales: variants.map(variant => variant.locale) },
        }),
      ],
      text: decoder.decode(bytes),
      dataSources: {
        'common.view/table-data-source': tableDataSource(variants, base, rows, brokenRefKeysOf(variants, contribution?.catalog)),
        'common.view/tree-data-source': tree,
        /*
         * The card for a localization file. What a reader wants at a glance is coverage and health:
         * how many keys, which locale and catalog they belong to, how many carry markup or refer
         * into the game data, and whether any key is defined twice — a duplicate is the one defect
         * in this format that silently changes which string the game shows.
         */
        /*
         * The graph that ties a localization file to the style sheet it draws with.
         *
         * A modder editing a style wants to know which strings use it, and one editing a string
         * wants to see the style it applies; the two questions are the same edge read from either
         * end. The style nodes are addressed with the shared subject id, so a host that can open a
         * style sheet can follow the link — which is what makes this a graph rather than a list of
         * names.
         */
        'common.view/relation-graph-source': createRelationGraphSource({
          snapshotId: String(context.input.revisions.revision),
          nodes: [
            ...entries.map(entry => ({
              id: subjectIdFor(ID, ['key', entry.key]),
              label: entry.key,
              type: 'String',
              kind: 'string-key',
            })),
            ...[
              ...new Map(
                entries
                  .flatMap(entry => styleRefsOf(entry.value))
                  .map(ref => [`${ref.kind}:${ref.name}`, ref]),
              ).values(),
            ].map(ref => ({
              id: subjectIdFor('blizzard/sc2-style', [ref.kind === 'style' ? 'Style' : 'Constant', ref.name]),
              label: ref.name,
              type: ref.kind === 'style' ? 'Style' : 'Constant',
              kind: ref.kind === 'style' ? 'sc2-style-style' : 'sc2-style-constant',
            })),
          ],
          edges: [
            ...new Map(
              entries.flatMap(entry =>
                styleRefsOf(entry.value).map(ref => {
                  const from = subjectIdFor(ID, ['key', entry.key])
                  const to = subjectIdFor('blizzard/sc2-style', [
                    ref.kind === 'style' ? 'Style' : 'Constant',
                    ref.name,
                  ])
                  return [`${from} ${to} ${ref.kind}`, { from, to, role: ref.kind }] as const
                }),
              ),
            ).values(),
          ],
          /*
           * Partial on purpose: the style sheet is a different document, so this graph knows the
           * names a string applies and not whether they resolve. Saying "complete" would turn "not
           * in this session" into "does not exist".
           */
          completeness: 'partial',
          reason: 'style declarations live in a sheet this session does not hold',
        }),
        'common.view/subject-facts-source': createSubjectFactsSource({
          snapshotId: String(context.input.revisions.revision),
          subjectId: context.primary.source.id,
          label: uri.slice(uri.lastIndexOf('/') + 1),
          kind: 'sc2-strings-catalog',
          type: 'StarCraft II localization catalog',
          source: context.primary.source,
          groups: [
            {
              id: 'identity',
              label: 'Catalog',
              facts: [
                ...(catalog.catalog === undefined
                  ? []
                  : [fact(context.primary.source, 'catalog', 'Catalog', catalog.catalog)]),
                ...(catalog.locale === undefined
                  ? []
                  : [fact(context.primary.source, 'locale', 'Locale', catalog.locale)]),
                fact(context.primary.source, 'entries', 'Keys', entries.length),
              ],
            },
            {
              id: 'content',
              label: 'Content',
              facts: [
                fact(
                  context.primary.source,
                  'markup',
                  'Keys with markup',
                  entries.filter(entry => entry.value.includes('<')).length,
                ),
                fact(context.primary.source, 'references', 'Data references', refs.length),
              ],
            },
            {
              id: 'integrity',
              label: 'Integrity',
              facts: [
                fact(
                  context.primary.source,
                  'duplicates',
                  'Duplicate keys',
                  entries.filter(entry => entry.duplicate).length,
                ),
              ],
            },
          ],
        }),
      },
      diagnostics,
      unsupportedFeatures: Object.freeze([
        'broken cross-file references need a CatalogResolver this session is not given',
        'machine translation needs a permissioned host translation service',
      ]),
      handlers: {
        inspect: async () => ({
          kind: 'json',
          value: {
            entries: entries.length,
            // Kept from the previous adapter: a caller counts duplicates from this, and dropping
            // the field while rewriting the handler is exactly the kind of silent loss the native
            // surface test exists to catch. It caught it.
            duplicateKeys: entries.filter(entry => entry.duplicate).length,
            references: refs.length,
            ...catalog,
          },
        }),
        /*
         * Reference checking needs a catalog, so it is offered rather than assumed: without one the
         * answer is the structural diagnostics, with one it also includes every `<d ref>` that
         * resolves to nothing. Running it against an empty catalog would condemn a healthy file.
         */
        validate: async (input: any) => {
          const resolver = catalogResolverOf(input?.catalog)
          if (resolver === undefined) return { kind: 'json', value: diagnostics }
          const references = validateStringRefs(
            entries.map(entry => [entry.key, entry.value] as [string, string]),
            resolver,
          )
          return {
            kind: 'json',
            value: [
              ...diagnostics,
              ...references.map(issue =>
                Object.freeze({
                  id: `sc2-strings.broken-ref.${issue.key}.${issue.ns}.${issue.entity}`,
                  severity: 'error' as const,
                  category: 'structure' as const,
                  code: 'blizzard.sc2-strings/broken-ref',
                  message: `"${issue.key}" references ${issue.ns},${issue.entity},${issue.field}, which the catalog does not resolve`,
                }),
              ),
            ],
          }
        },
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'export-convert': async (input: any) =>
          input?.format === 'entries'
            ? {
                kind: 'json',
                value: entries.map(entry => ({ key: entry.key, value: entry.value })),
              }
            : { kind: 'bytes', value: serialized },
        references: async (input: any) => ({
          kind: 'json',
          value: input?.key === undefined ? refs : refs.filter(item => item.key === input.key),
        }),
        /*
         * Markup, resolved as far as it can be without a catalog. `parseMarkup` gives the segments
         * and `renderMarkupHtml` the display form; `validateMarkupSyntax` reports what is wrong
         * with the tags themselves. Anything needing a resolver is left to the host.
         */
        'highlight-value': async (input: unknown) => ({ kind: 'json', value: highlightValue(input) }),
        'complete-value': async (input: unknown) => ({
          kind: 'json',
          value: completeValue(input, rows.map(row => row.key)),
        }),
        'render-markup': async (input: any) => {
          // The table's form: values it holds, drawn as runs (`TableActions.renderValues`).
          if (Array.isArray(input?.items)) return { kind: 'json', value: renderValues(input) }
          const key = typeof input?.key === 'string' ? input.key : undefined
          if (key === undefined) throw new TypeError('render requires a key')
          const named = variantRequest(input)
          const variant = named === undefined ? variants[0]! : variantFor(named)
          if (variant === undefined) throw new TypeError(`this catalog has no bound locale "${named}"`)
          const stored = effectiveValue(variant.model, key)
          const value = stored === undefined ? undefined : previewText(stored)
          if (value === undefined) throw new TypeError(`no string "${key}" in this catalog`)
          /*
           * Syntax is always available; rendering is not. `renderMarkupHtml` works on *resolved*
           * segments, and resolving `<d ref>` needs a catalog this codec is not given. A caller
           * that has one may pass it; otherwise the HTML is reported as unavailable with the
           * reason, which is the truth, rather than a half-resolved string that looks finished.
           */
          const resolver = catalogResolverOf(input?.catalog)
          const needsCatalog = markupCatalogRefs(value).length > 0
          const resolved = resolver === undefined && needsCatalog
            ? undefined
            : resolveStringValue(value, resolver ?? EMPTY_RESOLVER)
          return {
            kind: 'json',
            value: {
              key,
              segments: parseMarkup(value),
              issues: validateMarkupSyntax(value),
              ...(resolved === undefined
                ? { html: null, plain: null, unavailable: 'rendering needs a catalog resolver' }
                : { html: renderMarkupHtml(resolved.segments), plain: resolved.rendered }),
            },
          }
        },
        /*
         * One key, machine-translated with its markup intact.
         *
         * The split of work is the point. Which parts of a value are markup is this format's
         * knowledge, so masking stays here: `protectMarkup` replaces every `<d ref>`, `<img>` and
         * `$Token$` with a sentinel, and a round-trip check afterwards refuses a result whose
         * placeholders came back moved or missing. Talking to a translation service is nobody's
         * format-specific business, so it is a resolved provider — the same one any other
         * localization format uses, rather than six backends copied into each codec.
         *
         * The sentinels are converted to the `[[MK0]]` form the contract agrees on, because that is
         * what the provider's prompt tells a model to preserve. A raw private-use sentinel survives
         * a translation endpoint and confuses a chat model.
         */
        translate: async (input: any) => {
          const contracts = contribution?.contracts
          // Asked before a translate control is offered: is there a service that can answer?
          if (input?.probe === true) {
            return { kind: 'json', value: await translationAvailability(contracts) }
          }
          const key = typeof input?.key === 'string' ? input.key : undefined
          if (key === undefined) throw new TypeError('translate requires a key')
          const source =
            input?.sourceVariant === undefined ? variants[0]! : variantFor(input.sourceVariant)
          if (source === undefined) {
            throw new TypeError(`this catalog has no bound locale "${String(input.sourceVariant)}"`)
          }
          const value = effectiveValue(source.model, key)
          if (value === undefined) throw new TypeError(`no string "${key}" in this catalog`)
          const sourceLanguage =
            typeof input?.sourceLanguage === 'string'
              ? input.sourceLanguage
              : typeof input?.sourceLang === 'string'
                ? input.sourceLang
                : undefined
          const targetLanguage =
            typeof input?.targetLanguage === 'string'
              ? input.targetLanguage
              : typeof input?.targetLang === 'string'
                ? input.targetLang
                : undefined
          if (sourceLanguage === undefined || targetLanguage === undefined) {
            throw new TypeError('translate requires sourceLanguage and targetLanguage')
          }
          if (contracts === undefined) {
            throw new TypeError('translate needs an activated contribution context')
          }

          const { masked, tokens } = protectMarkup(value)
          const withPlaceholders = toContractPlaceholders(masked)
          const lease = (await contracts.resolve({
            contract: 'common.language/translation',
            major: 1,
            facet: {
              ...(typeof input?.backend === 'string' ? { backend: input.backend } : {}),
              sourceLanguage,
              targetLanguage,
            },
          } as never)) as { value: unknown; release(): Promise<void> }
          let translated: string
          let backend: string
          try {
            const result = await (lease.value as {
              translate(request: unknown): Promise<{ text: string; backend: string }>
            }).translate({
              text: withPlaceholders,
              sourceLanguage,
              targetLanguage,
              ...(typeof input?.backend === 'string' ? { backend: input.backend } : {}),
              ...(typeof input?.context === 'string' ? { context: input.context } : {}),
              key,
            })
            translated = result.text
            backend = result.backend
          } finally {
            await lease.release()
          }

          /*
           * The self-test MK2 wrote, kept where it belongs. A placeholder that did not come back is
           * a translation that would silently drop a reference or a colour, so the original value
           * stands instead — a refused translation is recoverable, a corrupted string is not.
           */
          const restored = fromContractPlaceholders(translated)
          const returned = [...restored.matchAll(SENTINEL_RE)].map(match => Number(match[1]))
          const safe = returned.length === tokens.length && returned.every((index, position) => index === position)
          const finalText = safe ? restoreMarkup(restored, tokens) : value

          return {
            kind: 'json',
            value: {
              key,
              source: value,
              translated: finalText,
              sourceLanguage,
              targetLanguage,
              backend,
              changed: finalText !== value,
              // Said out loud: the service answered, and its answer was thrown away.
              ...(safe ? {} : { refused: 'markup placeholders were missing, duplicated, unknown, or reordered by the translation' }),
            },
          }
        },
        'resolve-fallback': async (input: any) => {
          const request = Array.isArray(input?.entries)
            ? modelOfLocale(input)
            : variantFor(variantRequest(input) ?? input?.locale)
          if (request === undefined) throw new TypeError(`this catalog has no bound locale "${String(variantRequest(input) ?? input?.locale)}"`)
          const key = typeof input?.key === 'string' ? input.key : undefined
          if (key === undefined) throw new TypeError('resolve-fallback requires key')
          const primary = effectiveValue(model, key)
          const fromPrimary = primary !== undefined && primary !== ''
          const secondary = effectiveValue(request.model, key)
          const fallback = secondary !== undefined && secondary !== ''
          return {
            kind: 'json',
            value: {
              key,
              // As in MK2: a fallback counts only when it is non-empty; otherwise the primary
              // value (possibly empty or absent) is the answer.
              value: fromPrimary || !fallback ? primary : secondary,
              locale: fromPrimary || !fallback ? 'primary' : request.locale,
              fromPrimary,
            },
          }
        },
        /*
         * `compareLocales` is the MK2 implementation, and it answers the four questions a
         * translator actually asks — missing, orphaned, identical (so untranslated) and empty —
         * with a translated count. The previous hand-rolled version reported "changed", which is
         * not one of them.
         */
        'compare-locales': async (input: any) => {
          /*
           * One locale file against an earlier text of itself — the caller reads it from git or a
           * cache; the codec does no I/O. Key-level changes, and the added and modified keys as a
           * `key=value` file to hand a translator (MK2 "Extract Changed Strings").
           */
          if (input?.since !== undefined) {
            const since = input.since as { text?: unknown; label?: unknown }
            if (typeof since?.text !== 'string') throw new TypeError('since.text must be the earlier file text')
            if (encoder.encode(since.text).byteLength > context.budget.maxScalarBytes) {
              throw new RangeError('since.text exceeds maxScalarBytes budget')
            }
            const named = variantRequest(input)
            const variant = named === undefined ? variants[0]! : variantFor(named)
            if (variant === undefined) throw new TypeError(`this catalog has no bound locale "${named}"`)
            const changes = diffStringTexts(since.text, decoder.decode(variant.bytes))
            const count = (kind: string) => changes.filter(change => change.kind === kind).length
            return {
              kind: 'json',
              value: {
                locale: variant.locale,
                ...(typeof since.label === 'string' ? { since: since.label } : {}),
                added: count('added'),
                modified: count('modified'),
                deleted: count('deleted'),
                changes,
                staged: changedStringsText(changes),
              },
            }
          }
          // A bound locale of this mod, compared with the base locale the table shows.
          if (!Array.isArray(input?.entries)) {
            const locale = variantRequest(input) ?? input?.locale
            const bound = variantFor(locale)
            if (bound === undefined) {
              throw new TypeError(`this catalog has no bound locale "${String(locale)}"`)
            }
            return {
              kind: 'json',
              value: {
                baseLocale: base.locale,
                targetLocale: bound.locale,
                ...compareLocales(base.model, bound.model),
              },
            }
          }
          const target = modelOfLocale(input)
          return {
            kind: 'json',
            value: { targetLocale: target.locale, ...compareLocales(model, target.model) },
          }
        },
        /*
         * One value, written by a surface. It resolves the key the tree published and then takes
         * exactly the path `edit.content` takes, so a field edit and a scripted set produce the
         * same bytes through the same ordered line model — there is no second writer here.
         */
        'edit-field': async (input: any) => {
          const request = input as { groupId?: unknown; key?: unknown; path?: unknown; value?: unknown }
          const path = Array.isArray(request.path) ? request.path.map(String) : []
          // The table addresses a cell as [row, column]; a locale missing the key gains it.
          if (request.groupId === 'table') {
            const row = rows[Number(path[0])]
            const variant = variants[Number(path[1]) - 1]
            if (row === undefined || variant === undefined) {
              throw new TypeError('this table cell is not a locale value')
            }
            const action = effectiveValue(variant.model, row.key) === undefined ? 'add' : 'set'
            return planFor({ action, key: row.key, value: String(request.value ?? '') }, variant)
          }
          // The tree publishes `['keys', <key>]`; a caller may also name the key directly.
          const key = path.at(-1) ?? (typeof request.key === 'string' ? request.key : undefined)
          if (key === undefined) throw new TypeError('a strings field write needs a key')
          if (effectiveValue(model, key) === undefined) {
            throw new TypeError(`no string "${key}" in this catalog`)
          }
          return planFor({ action: 'set', key, value: String(request.value ?? '') })
        },
        'edit-strings': async (input: any) => {
          if (input?.action === 'set-variants') return planForVariants(input.entries)
          if (input?.action === 'rename-variants' || input?.action === 'delete-variants') return planForKey(input)
          const named = variantRequest(input)
          const variant = named === undefined ? variants[0] : variantFor(named)
          if (variant === undefined) throw new TypeError(`this catalog has no bound locale "${named}"`)
          return planFor(input, variant)
        },
      },
    }
  },
})

/**
 * The catalog by key path, not as eight thousand flat rows.
 *
 * A localization key is a path — `Abil/Name/Beacon` — and a catalog has thousands of them, so the
 * flat list this used to publish was unusable for the thing a translator actually does: work
 * through one area at a time. Groups carry their key count because that is the number a translator
 * is deciding against, and a leaf keeps everything it had: the stored value, its markup spans and
 * the edit route, because the leaf is still the row that gets written.
 *
 * A duplicate key stays a separate leaf. The format allows it, the validator reports it, and
 * merging the two here would hide the one a reader needs to delete.
 */
function stringKeyTree(entries: readonly { key: string; value: string; duplicate?: boolean }[]): readonly any[] {
  interface Group {
    readonly children: Map<string, Group>
    readonly leaves: { entry: (typeof entries)[number]; label: string }[]
    count: number
  }
  const makeGroup = (): Group => ({ children: new Map(), leaves: [], count: 0 })
  const root = makeGroup()
  for (const entry of entries) {
    const segments = entry.key.split('/').filter(part => part.length > 0)
    const leafLabel = segments.at(-1) ?? entry.key
    let node = root
    node.count += 1
    for (const segment of segments.slice(0, -1)) {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = makeGroup()
        node.children.set(segment, child)
      }
      child.count += 1
      node = child
    }
    node.leaves.push({ entry, label: leafLabel })
  }
  const render = (group: Group, prefix: readonly string[]): readonly any[] => [
    ...[...group.children].map(([segment, child]) => ({
      kind: 'sc2-strings-group',
      label: segment,
      preview: String(child.count),
      semanticPath: ['keys', ...prefix, segment],
      children: render(child, [...prefix, segment]),
    })),
    ...group.leaves.map(({ entry, label }) => ({
      kind: 'sc2-string-entry',
      label,
      // The rendered form, so a reader can see the string without reading its markup.
      preview: previewOf(entry.value).slice(0, 160),
      semanticPath: ['keys', entry.key],
      // The stored string is a value a reader may edit; markup stays text, as the format has it.
      value: entry.value,
      type: { kind: 'text' as const, multiline: entry.value.includes('\n') },
      editable: { write: { operation: operationId('edit.field', { contributionId: ID }) }, editor: 'scalar' },
      /*
       * Markup is shown as markup, coloured. The resolved rendering needs a catalog and belongs
       * to `render`; a half-resolved preview here would show a value the file does not contain.
       */
      ...(valueSpans(entry.value) === undefined ? {} : { spans: valueSpans(entry.value) }),
    })),
  ]
  return render(root, [])
}

interface TranslationBackendChoice {
  readonly id: string
  readonly label: string
  readonly available: boolean
}

/**
 * Whether a translation service can answer here, and if not, why — before anything is sent — and
 * the backends it offers, so a surface can let the user pick one for `backend` (plan 7.35).
 */
async function translationAvailability(
  contracts: { resolve(selection: unknown): Promise<unknown> } | undefined,
): Promise<{ available: boolean; reason?: string; backends?: readonly TranslationBackendChoice[] }> {
  if (contracts === undefined) {
    return { available: false, reason: 'translation needs an activated contribution context' }
  }
  let lease: { value: unknown; release(): Promise<void> }
  try {
    lease = (await contracts.resolve({
      contract: 'common.language/translation',
      major: 1,
      facet: {},
    })) as typeof lease
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { available: false, reason: `no translation service: ${message}` }
  }
  try {
    const service = lease.value as { backends?(): Promise<readonly any[]> }
    const backends = (await service.backends?.()) ?? []
    const choices = backends
      .filter(backend => typeof backend?.id === 'string' && backend.id !== '')
      .map(backend => ({
        id: String(backend.id),
        label: String(backend.label ?? backend.id),
        available: backend.available === true,
      }))
    if (choices.some(choice => choice.available)) return { available: true, backends: choices }
    const names = backends.map(backend => String(backend?.label ?? backend?.id)).join(', ')
    return {
      available: false,
      ...(choices.length === 0 ? {} : { backends: choices }),
      reason:
        names === ''
          ? 'the translation service offers no backend'
          : `no translation backend is configured (${names} need credentials)`,
    }
  } finally {
    await lease.release()
  }
}

export const abiVersion = 1

export const createCodec = (context?: unknown) => {
  // A provider lease belongs to this activation, even if another host opens a codec concurrently.
  return createInspectionCodec(definition(context as StringsContribution | undefined), context as never)
}
