/**
 * Language services for `sc2-strings`, over `common.language/document-analysis@1`.
 *
 * Every rule here comes from the ported MK2 library and none is re-derived: `tokenizeStringKey` and
 * `tokenizeStringValue` know the markup grammar, `completeStringValue` and `completeStringKey` know
 * what may be typed where, `findTagOrAttrDocAt` carries the one-line documentation, and
 * `analyzeStringFile` produces the diagnostics. This file is the translation between that library's
 * shapes and the contract's, plus the one thing the library cannot know: where a line begins.
 *
 * A localization catalog is a line format, not a tree, and that shapes everything below. The library
 * works on one value at a time, so this walks the ordered line model and maps offsets within a value
 * back to positions in the document. Getting that mapping wrong shifts every squiggle and every
 * suggestion by the width of the key, which reads as "the checker is broken" rather than "the
 * translation is".
 */
import { servedLanguageFeature } from '@modkit/blizzard-starcraft2/language/served-feature'
import { servedRenameFeature } from '@modkit/blizzard-starcraft2/language/served-rename'
import { servedProjectDiagnostics } from '@modkit/blizzard-starcraft2/language/served-project-diagnostics'
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageCompletionItem,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDiagnosticList,
  LanguageDocument,
  LanguageDocumentSymbolList,
  LanguageFeatureRequest,
  LanguageHover,
  LanguagePosition,
  LanguagePositionRequest,
  LanguageProvider,
  LanguageReferencesRequest,
  LanguageRenameRequest,
  LanguageRange,
  LanguageSymbol,
  LanguageToken,
  LanguageTokenKind,
  LanguageWorkspaceSymbolsRequest,
} from '@modkit/sdk'
import { languageWorkspaceIsSemanticallyIncomplete } from '../../../../../shared/language/workspace-context.js'
import { parseColorLiteral } from '../../../../../shared/language/sc2-colors.js'
import {
  stringCatalogFromWorkspace,
  stringResolverFromWorkspace,
} from '../../../../../shared/language/string-workspace.js'
import { languageCompletionItem } from '../../../shared/completion-items.js'
import { parseSc2StringsOrdered } from '../../../shared/core/text-file.js'
import type { StringFileModel, StringLine } from '../../../shared/core/text-file.js'
import {
  analyzeStringFile,
  completeStringKey,
  completeStringValue,
  findColorSwatches,
  findSegmentAt,
  findTagOrAttrDocAt,
  resolveStringValue,
  tokenizeStringKey,
  tokenizeStringValue,
  type StringCatalog,
  type StringCompletion,
  type CatalogResolver,
  type TokenScope,
} from '../../../shared/core/index.js'
import { analyzeHotkeyStringFile } from '../../../shared/core/hotkeys.js'
import {
  prepareStringsRename,
  renameStrings,
  stringCatalogEntityAt,
  stringKeyDefinedIn,
  stringKeyUnder,
  stringsDefinition,
  stringsReferences,
  stringsServedLocations,
  stringsServedOtherCatalogs,
  stringsWorkspaceSymbols,
} from './workspace.js'
import {
  servedModContext,
  styleNameAt,
  styleNameDefinition,
  styleNameServable,
  styleNameServedDefinition,
  styleNamePrepareRename,
  styleNameReferences,
  styleNameServedReferences,
  styleNameRename,
  styleReferenceOccurrenceBatches,
} from '../../../../style/providers/language/src/style-names.js'
import {
  mergeReferenceOccurrenceBatches,
  sc2MixedReferenceOccurrenceBatches,
} from '../../../../../shared/language/typed-occurrences.js'

export const SC2_STRINGS_LANGUAGE_ID = 'sc2-strings'

const encoder = new TextEncoder()

/**
 * The library's own scopes, mapped onto the contract's token kinds.
 *
 * Several library scopes have no exact counterpart — `ref`, `stringref`, `galaxyvar` and `token` are
 * all references into other files, and the contract has one `variable` for that idea. Collapsing
 * them is honest; inventing kinds the contract does not define would make the tokens unusable by
 * any editor that consumes it.
 */
const TOKEN_KIND: Readonly<Record<TokenScope, LanguageTokenKind>> = Object.freeze({
  text: 'string',
  comment: 'comment',
  punctuation: 'operator',
  tag: 'keyword',
  attribute: 'property',
  string: 'string',
  operator: 'operator',
  ref: 'variable',
  stringref: 'variable',
  galaxyvar: 'variable',
  dynamic: 'variable',
  token: 'variable',
  hotkey: 'keyword',
  newline: 'operator',
  image: 'string',
  unknown: 'string',
})

/*
 * Key segments, in the token vocabulary the contract actually defines. There is no `namespace`
 * token kind — that word exists among *symbol* kinds, not token kinds — so the catalog segment is a
 * `type`, which is what it behaves like: the thing that says what the rest of the key is about.
 */
const KEY_KIND: Readonly<Record<string, LanguageTokenKind>> = Object.freeze({
  namespace: 'type',
  punctuation: 'operator',
  property: 'property',
  objectid: 'variable',
})

interface LineView {
  readonly index: number
  readonly line: StringLine
  /** Character offset of the value within the line, i.e. just past `key=`. */
  readonly valueColumn: number
}

interface LanguageColor {
  readonly red: number
  readonly green: number
  readonly blue: number
  readonly alpha: number
}

interface Sc2StringsColorProvider {
  documentColors(request: LanguageFeatureRequest): Promise<{
    readonly colors: readonly { readonly range: LanguageRange; readonly color: LanguageColor }[]
    readonly isIncomplete: boolean
  }>
  colorPresentations(request: LanguageFeatureRequest & {
    readonly color: LanguageColor
    readonly range: LanguageRange
  }): Promise<{
    readonly presentations: readonly { readonly label: string }[]
    readonly isIncomplete: boolean
  }>
}

/**
 * Where each entry's value starts on its line.
 *
 * The ordered line model keeps the raw text, so the column is measured from it rather than computed
 * from `key.length + 1`: a line may carry spaces around the separator, and assuming it does not is
 * how offsets drift on exactly the files that are hand-edited.
 */
function lineViews(model: StringFileModel): readonly LineView[] {
  const views: LineView[] = []
  model.lines.forEach((line, index) => {
    if (!line.isEntry) return
    const raw = line.raw ?? `${line.key}=${line.value}`
    const separator = raw.indexOf('=')
    views.push({ index, line, valueColumn: separator < 0 ? 0 : separator + 1 })
  })
  return views
}

function parse(text: string): { model: StringFileModel; views: readonly LineView[] } {
  const model = parseSc2StringsOrdered(encoder.encode(text))
  return { model, views: lineViews(model) }
}

const at = (line: number, character: number): LanguagePosition => ({ line, character })
const span = (line: number, from: number, to: number): LanguageRange => ({
  start: at(line, from),
  end: at(line, to),
})

function tokensFor(views: readonly LineView[]): readonly LanguageToken[] {
  const tokens: LanguageToken[] = []
  for (const view of views) {
    for (const token of tokenizeStringKey(view.line.key)) {
      tokens.push({
        range: span(view.index, token.start, token.end),
        kind: KEY_KIND[token.scope] ?? 'variable',
      })
    }
    for (const token of tokenizeStringValue(view.line.value)) {
      tokens.push({
        range: span(view.index, view.valueColumn + token.start, view.valueColumn + token.end),
        kind: TOKEN_KIND[token.scope] ?? 'string',
      })
    }
  }
  return tokens
}

/** `GameHotkeys.txt` binds commands to keys: its values are hotkeys, checked as such (parity plan 4.10). */
const HOTKEYS_FILE = /(?:^|[\\/])GameHotkeys\.txt$/iu

function diagnosticsFor(
  model: StringFileModel,
  views: readonly LineView[],
  uri: string,
  resolver?: CatalogResolver,
): readonly LanguageDiagnostic[] {
  const columnOf = new Map(views.map(view => [view.index, view.valueColumn]))
  // The codec's two analyzers; a duplicate key is the string analyzer's finding, reported once.
  const hotkeys = HOTKEYS_FILE.test(decodeURIComponent(uri))
    ? analyzeHotkeyStringFile(model).filter(item => item.code !== 'duplicate-key')
    : []
  return [...analyzeStringFile(model, resolver), ...hotkeys].map((item): LanguageDiagnostic => {
    const column = columnOf.get(item.line) ?? 0
    /*
     * A finding with no offsets is about the line as a whole — a duplicate key, say — so it covers
     * the key rather than an arbitrary point, which is where a reader looks for it.
     */
    const range =
      item.start === undefined
        ? span(item.line, 0, Math.max(1, item.key.length))
        : span(item.line, column + item.start, column + (item.end ?? item.start + 1))
    return {
      range,
      severity: item.severity,
      message: item.message,
      code: item.code,
      source: SC2_STRINGS_LANGUAGE_ID,
    }
  })
}

function symbolsFor(views: readonly LineView[]): readonly LanguageSymbol[] {
  return views.map((view): LanguageSymbol => {
    const range = span(view.index, 0, view.valueColumn + view.line.value.length)
    return {
      name: view.line.key,
      kind: 'field',
      range,
      selectionRange: span(view.index, 0, view.line.key.length),
    }
  })
}

function hexToColor(value: string): LanguageColor | undefined {
  const bare = value.replace(/^#/u, '')
  const hex = bare.length === 6 ? `${bare}ff` : bare
  if (!/^[0-9a-fA-F]{8}$/u.test(hex)) return undefined
  return {
    red: Number.parseInt(hex.slice(0, 2), 16) / 255,
    green: Number.parseInt(hex.slice(2, 4), 16) / 255,
    blue: Number.parseInt(hex.slice(4, 6), 16) / 255,
    alpha: Number.parseInt(hex.slice(6, 8), 16) / 255,
  }
}

const NAMED_COLOR = /<c\s+val\s*=\s*["']([^"']*)["']/giu
const LITERAL_COLOR = /^#?[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u

function colorsFor(
  views: readonly LineView[],
  catalog: StringCatalog | undefined,
): readonly { readonly range: LanguageRange; readonly color: LanguageColor }[] {
  const colors: { range: LanguageRange; color: LanguageColor }[] = []
  for (const view of views) {
    for (const swatch of findColorSwatches(view.line.value)) {
      const color = hexToColor(swatch.hex)
      if (color === undefined) continue
      colors.push({
        range: span(
          view.index,
          view.valueColumn + swatch.start,
          view.valueColumn + swatch.end,
        ),
        color,
      })
    }
    if (catalog?.colorHex === undefined) continue
    for (const match of view.line.value.matchAll(NAMED_COLOR)) {
      const raw = match[1] ?? ''
      const name = raw.trim().replace(/^#/u, '')
      if (name === '' || LITERAL_COLOR.test(raw.trim())) continue
      // A named colour is a FontStyles constant, written the way layouts and style sheets write
      // colours (eight digits are AARRGGBB), so it is read by their parser, not as markup.
      const color = parseColorLiteral(catalog.colorHex(name) ?? '')?.color
      if (color === undefined) continue
      const inside = match[0].indexOf(raw)
      const start = view.valueColumn + (match.index ?? 0) + inside
      colors.push({ range: span(view.index, start, start + raw.length), color })
    }
  }
  return colors
}

function colorLabel(color: LanguageColor, includeAlpha: boolean): string {
  const byte = (value: number): string =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `${byte(color.red)}${byte(color.green)}${byte(color.blue)}${
    includeAlpha ? byte(color.alpha) : ''
  }`
}

/** The entry a position falls on, and whether it is in the key or the value. */
function locate(views: readonly LineView[], position: LanguagePosition) {
  const view = views.find(item => item.index === position.line)
  if (view === undefined) return undefined
  return {
    view,
    inValue: position.character >= view.valueColumn,
    offset: Math.max(0, position.character - view.valueColumn),
  }
}

export interface Sc2StringsLanguageOptions {
  /**
   * Workspace vocabulary for completion.
   *
   * A host that already resolved the mod passes it here. When it is absent the provider builds one
   * from the documents the request carries — see `stringCatalogFromWorkspace` — so a snapshot with
   * `FontStyles.SC2Style` and a GameData catalog in it produces real style, colour and entity names
   * without the host wiring anything further. Absent both, the format's own vocabulary is all that
   * is offered, which is honest rather than empty.
   */
  readonly catalog?: StringCatalog
  /**
   * Loaded mods' servers (`ContributionContext.modContexts`). With it, a style name's definition
   * and a GameStrings key's definition, references and hover come from the server that holds the
   * chain's style sheets, catalogs and layouts instead of a snapshot carrying them.
   */
  readonly modContexts?: {
    query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

export function createSc2StringsLanguageProvider(
  options: Sc2StringsLanguageOptions = {},
): LanguageProvider & Sc2StringsColorProvider {
  const completionItems = (result: { items: StringCompletion[] }): LanguageCompletionItem[] =>
    result.items.map(languageCompletionItem)

  const catalogFor = (
    request: LanguageFeatureRequest,
    views: readonly LineView[],
  ): StringCatalog | undefined =>
    options.catalog ??
    (request.workspaceDocuments.length > 0
      ? stringCatalogFromWorkspace(
          request.workspaceDocuments,
          views.map(view => view.line.key),
        )
      : undefined)

  return {
    contract: 'common.language/document-analysis',
    languageIds: [SC2_STRINGS_LANGUAGE_ID],
    semanticInputs: [
      { kind: 'format-spec', id: 'blizzard/sc2-strings@1', revision: 'mk3-language-2' },
      { kind: 'provider', id: 'blizzard/sc2-strings-language', revision: '2' },
    ],
    // Layouts apply the same styles a catalog does, and layouts and Galaxy scripts (StringExternal)
    // name GameStrings keys: a style or key rename from here must reach them too.
    workspaceLanguageIds: [SC2_STRINGS_LANGUAGE_ID, 'sc2-style', 'sc2-data', 'sc2-layout', 'galaxy'],
    // The outline is the file's own keys: no workspace (owner decision 10.10, no second copy).
    documentLocalFeatures: ['documentSymbols', 'colorPresentations'],
    // A style name's definition and a key's definition, references and key hover come from the
    // loaded mod's server, including Data links, markup, vocabulary, colours and style usages.
    // Install compatible SDK/Host feature vocabularies; standalone keeps the canonical implementations.
    ...((options.modContexts === undefined
      ? {}
      : {
          semanticContextRequirements: [{ kind: 'mod-context', gameId: 'blizzard/starcraft-2' }],
          modContextFeatures: ['definition', 'references', 'hover', 'diagnostics', 'rename', 'prepareRename', 'projectDiagnostics', 'workspaceSymbols', 'completion', 'documentColors'],
          projectDiagnostics: (request: LanguageFeatureRequest) => servedProjectDiagnostics(request, options.modContexts!),
          async modContextFeatureApplies() { return true
          },
        }) as unknown as Partial<LanguageProvider>),

    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      const { model, views } = parse(request.document.text)
      const include = request.include
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens: include?.tokens === false ? [] : tokensFor(views),
        diagnostics: include?.diagnostics === false ? [] : diagnosticsFor(model, views, request.document.uri),
        symbols: include?.symbols === false ? [] : symbolsFor(views),
      }
    },

    async diagnostics(request: LanguageFeatureRequest): Promise<LanguageDiagnosticList> {
      const served = options.modContexts === undefined ? undefined : servedModContext(request)
      if (served?.document !== undefined) {
        // The loaded mod's server resolves markup over the chain's catalogs, sheets and Data.
        const answer = (await options.modContexts!.query(served.scope, {
          kind: 'strings.diagnostics',
          document: { layerId: served.document.layerId, path: served.document.path },
          uri: request.document.uri,
          maxResults: request.maxResults,
          incomplete: languageWorkspaceIsSemanticallyIncomplete(request),
        }, request.signal)) as { readonly revision?: unknown; readonly incomplete?: boolean; readonly diagnostics: LanguageDiagnosticList }
        if (answer.revision !== served.revision) throw new Error('strings.diagnostics answered another revision')
        return { diagnostics: answer.diagnostics.diagnostics, isIncomplete: answer.diagnostics.isIncomplete || answer.incomplete === true }
      }
      const hasCatalogSnapshot = request.workspaceDocuments.some(
        document => document.languageId === 'sc2-data',
      )
      const resolver = hasCatalogSnapshot
        ? stringResolverFromWorkspace([
            request.document,
            ...request.workspaceDocuments.filter(item => item.uri !== request.document.uri),
          ])
        : undefined
      return sc2StringsDiagnosticsWith(request.document, resolver, request.maxResults,
        languageWorkspaceIsSemanticallyIncomplete(request))
    },

    async referenceOccurrences(request: LanguageFeatureRequest) {
      const mixed = sc2MixedReferenceOccurrenceBatches(request)
      const styles = styleReferenceOccurrenceBatches(request)
      return mergeReferenceOccurrenceBatches(mixed, styles)
    },

    async documentSymbols(request: LanguageFeatureRequest): Promise<LanguageDocumentSymbolList> {
      const all = symbolsFor(parse(request.document.text).views)
      const items = all.slice(0, request.maxResults)
      return { symbols: items, isIncomplete: items.length < all.length }
    },

    async documentColors(request) {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'documentColors')
      const { views } = parse(request.document.text)
      const all = colorsFor(views, catalogFor(request, views))
      const colors = all.slice(0, request.maxResults)
      return {
        colors,
        isIncomplete: colors.length < all.length || languageWorkspaceIsSemanticallyIncomplete(request),
      }
    },

    async colorPresentations(request) {
      const line = request.document.text.split(/\r?\n/u)[request.range.start.line] ?? ''
      const selected = line.slice(request.range.start.character, request.range.end.character)
      return {
        presentations: [
          { label: colorLabel(request.color, selected.replace(/^#/u, '').length === 8) },
        ],
        isIncomplete: false,
      }
    },

    async completion(request: LanguagePositionRequest): Promise<LanguageCompletionList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'completion')
      const { views } = parse(request.document.text)
      const found = locate(views, request.position)
      if (found === undefined) {
        return { items: [], isIncomplete: languageWorkspaceIsSemanticallyIncomplete(request) }
      }
      /*
       * The document's own keys are part of the vocabulary: property segments like `Tooltip` are a
       * convention rather than a schema, so what this file already uses is the best evidence of
       * what belongs under a namespace.
       */
      const catalog = catalogFor(request, views)
      const result = found.inValue
        ? completeStringValue({
            text: found.view.line.value,
            offset: found.offset,
            ...(catalog === undefined ? {} : { catalog }),
          })
        : completeStringKey({
            text: found.view.line.key,
            offset: Math.min(request.position.character, found.view.line.key.length),
            ...(catalog === undefined ? {} : { catalog }),
          })
      const items = completionItems(result).slice(0, request.maxResults)
      return {
        items,
        isIncomplete:
          items.length < result.items.length || languageWorkspaceIsSemanticallyIncomplete(request),
      }
    },

    /*
     * A caret on `<s val="Name">` or `<c val="#Name">` is on a style-sheet name, not a string key.
     * Those four requests go to the same typed model the Style provider answers from, so going to a
     * style from a catalog and finding a catalog from the style can never disagree.
     */
    async definition(request: LanguagePositionRequest) {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined && stringCatalogEntityAt(request.document, request.position)) return servedLanguageFeature(request, options.modContexts, 'definition')
      const served = options.modContexts === undefined ? undefined : servedModContext(request)
      if (!styleNameAt(request)) {
        return served !== undefined && !stringCatalogEntityAt(request.document, request.position)
          ? stringsServedLocations(request as LanguageReferencesRequest, options.modContexts!, served as never, { definitions: true, uses: false })
          : stringsDefinition(request as LanguageReferencesRequest)
      }
      return served !== undefined && styleNameServable(request)
        ? styleNameServedDefinition(request, options.modContexts!, served)
        : styleNameDefinition(request)
    },

    async references(request: LanguageReferencesRequest) {
      const served = options.modContexts === undefined ? undefined : servedModContext(request)
      if (styleNameAt(request)) return served !== undefined
        ? styleNameServedReferences(request, options.modContexts!, served) : styleNameReferences(request)
      return served !== undefined
        ? stringsServedLocations(request, options.modContexts!, served as never, { definitions: request.includeDeclaration === true, uses: true })
        : stringsReferences(request)
    },

    async prepareRename(request: LanguagePositionRequest) {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedRenameFeature(request, options.modContexts, 'prepareRename')
      return styleNameAt(request)
        ? styleNamePrepareRename(request)
        : prepareStringsRename(request.document, request.position)
    },

    async rename(request: LanguageRenameRequest) {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedRenameFeature(request, options.modContexts, 'rename')
      return styleNameAt(request) ? styleNameRename(request) : renameStrings(request)
    },

    async workspaceSymbols(request: LanguageWorkspaceSymbolsRequest) {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'workspaceSymbols')
      return stringsWorkspaceSymbols(request)
    },

    async hover(request: LanguagePositionRequest): Promise<LanguageHover | undefined> {
      const { views } = parse(request.document.text)
      const found = locate(views, request.position)
      if (found === undefined) return undefined
      if (!found.inValue) {
        // On the key: the value is the answer, plus the other catalogs that translate it.
        const key = found.view.line.key
        if (key === '') return undefined
        const served = options.modContexts === undefined ? undefined : servedModContext(request)
        const elsewhere = served !== undefined
          ? await stringsServedOtherCatalogs(request, options.modContexts!, served as never, key)
          : request.workspaceDocuments.filter(
            item =>
              item.uri !== request.document.uri &&
              item.languageId === request.document.languageId &&
              stringKeyDefinedIn(item.text, key),
          ).length
        return {
          markdown: [
            `**${key}**`,
            found.view.line.value,
            ...(elsewhere === 0 ? [] : [`Also defined in ${elsewhere} other catalog(s).`]),
          ].join('\n\n'),
          range: span(found.view.index, 0, Math.max(0, found.view.valueColumn - 1)),
          provenance: 'blizzard/sc2-strings',
        }
      }
      const served = options.modContexts === undefined ? undefined : servedModContext(request)
      if (served?.document !== undefined) {
        const answer = await options.modContexts!.query(served.scope, {
          kind: 'strings.hover', document: served.document, uri: request.document.uri,
          position: request.position, maxResults: request.maxResults,
          incomplete: languageWorkspaceIsSemanticallyIncomplete(request),
        }, request.signal) as { readonly revision?: string; readonly hover?: LanguageHover }
        if (answer.revision !== served.revision) throw new Error('strings.hover answered another revision')
        return answer.hover
      }
      return sc2StringsValueHoverWith(request, stringResolverFromWorkspace([
        request.document, ...request.workspaceDocuments.filter(item => item.uri !== request.document.uri),
      ]))
    },
  } as LanguageProvider & Sc2StringsColorProvider
}

/** Value-markup hover through the canonical resolver, shared by standalone and served requests. */
export function sc2StringsValueHoverWith(
  request: Pick<LanguagePositionRequest, 'document' | 'position'>,
  resolver: CatalogResolver,
): LanguageHover | undefined {
  const found = locate(parse(request.document.text).views, request.position)
  if (found === undefined || !found.inValue) return undefined
  const segmentAt = findSegmentAt(found.view.line.value, found.offset)
  if (segmentAt !== undefined && (
    segmentAt.segment.kind === 'ref' ||
    segmentAt.segment.kind === 'time' ||
    segmentAt.segment.kind === 'stringref' ||
    segmentAt.segment.kind === 'galaxyvar'
  )) {
    const segment = segmentAt.segment
    let markdown =
      segment.kind === 'ref'
        ? `**Computed value**: \`${segment.expr}\``
        : segment.kind === 'time'
          ? `**Time**: \`${segment.expr}\``
          : segment.kind === 'stringref'
            ? `**String reference**: \`${segment.ns},${segment.entity},${segment.field}\``
            : `**Galaxy variable**: \`${segment.kind === 'galaxyvar' ? segment.name : ''}\``

    const resolved = resolveStringValue(segment.raw, resolver).segments[0]
    if (resolved !== undefined && 'error' in resolved && resolved.error) {
      markdown += `\n\n⚠️ ${resolved.error}`
    } else if (resolved !== undefined && 'value' in resolved && resolved.value !== undefined) {
      markdown += `\n\nValue: \`${String(resolved.value)}\``
    } else if (resolved !== undefined && 'text' in resolved && resolved.text) {
      markdown += `\n\nValue: ${resolved.text}`
    }
    return {
      markdown,
      range: span(
        found.view.index,
        found.view.valueColumn + segmentAt.start,
        found.view.valueColumn + segmentAt.end,
      ),
      provenance: 'blizzard/sc2-strings',
    }
  }
  const doc = findTagOrAttrDocAt(found.view.line.value, found.offset)
  if (doc === undefined) return undefined
  return {
    markdown: `**${doc.label}** — ${doc.doc}`,
    range: span(
      found.view.index,
      found.view.valueColumn + doc.start,
      found.view.valueColumn + doc.end,
    ),
    provenance: 'blizzard/sc2-strings',
  }
}

export const sc2StringsLanguageProvider: LanguageProvider = createSc2StringsLanguageProvider()

/**
 * A catalog's diagnostics with a markup resolver over its workspace (undefined: the workspace holds
 * no Data catalog), within `maxResults`. The snapshot path and the loaded mod's server
 * (`served-diagnostics.ts`, a resolver kept per revision) both answer through it.
 */
export function sc2StringsDiagnosticsWith(
  document: Pick<LanguageDocument, 'uri' | 'text'>,
  resolver: CatalogResolver | undefined,
  maxResults: number,
  incomplete: boolean,
): LanguageDiagnosticList {
  const { model, views } = parse(document.text)
  const all = diagnosticsFor(model, views, document.uri, resolver)
  const items = all.slice(0, maxResults)
  return { diagnostics: items, isIncomplete: items.length < all.length || incomplete }
}

/** The key a hover on a catalog line's key names (the part before `=`); undefined elsewhere. */
function keyHoverAt(request: Pick<LanguagePositionRequest, 'document' | 'position'>): string | undefined {
  const found = locate(parse(request.document.text).views, request.position)
  return found === undefined || found.inValue || found.view.line.key === '' ? undefined : found.view.line.key
}
