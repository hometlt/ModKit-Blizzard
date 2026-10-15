/**
 * Style, Constant and FontGroup names as typed targets, shared by every language that uses them.
 *
 * A style sheet declares the names; SC2 Strings catalogs and SC2Layout files apply them. Navigation
 * and rename have to give the same answer whichever of those documents the caret is in, so the
 * occurrence model lives here once and both the Style and the Strings providers call it. It names
 * the other languages by id rather than importing their providers, which keeps the modules acyclic.
 * Target detection, definitions and rename ranges index the primary document and declarations;
 * references and rename edits include every visible user. Full source scope and incomplete flags
 * stay with the request; this model does not cache authority or parse a second style vocabulary.
 */
import { scanXml, type ScannedElement as KitElement } from '@modkit/codec-kit'
import { lineStartOffsets, positionAt } from '../../../../../shared/xml/text-position.js'
import { parseFontStyles } from '../../../shared/font-styles.js'
import type {
  LanguageFeatureRequest,
  LanguageLocation,
  LanguageLocationList,
  LanguagePosition,
  LanguagePositionRequest,
  LanguageRange,
  LanguageReferencesRequest,
  LanguageRenamePreparation,
  LanguageRenameRequest,
  LanguageTextDocumentEdit,
  LanguageWorkspaceEdit,
} from '@modkit/sdk'
import { languageWorkspaceIsSemanticallyIncomplete } from '../../../../../shared/language/workspace-context.js'

export const SC2_STYLE_LANGUAGE_ID = 'sc2-style'
const SC2_STRINGS_LANGUAGE_ID = 'sc2-strings'

/**
 * Attributes whose value is a colour.
 *
 * A colour is a literal `RRGGBB[AA]`, a decimal `R,G,B[,A]`, a `#Constant`, or two of those either
 * side of a dash — a gradient, which is a quarter of the non-literal colours in Blizzard's sheets
 * and reads as a syntax error to anything that has not met it.
 */
export const COLOR_ATTRIBUTES = Object.freeze([
  'textcolor',
  'glowcolor',
  'highlightcolor',
  'disabledcolor',
  'hotkeycolor',
  'hyperlinkcolor',
  'outlinecolor',
  'highlightglowcolor',
  'disabledglowcolor',
])

/*
 * Attribute names are case-insensitive in this format and Blizzard's own sheets exercise it —
 * `textColor` and `textcolor` appear in the same file. Comparing them literally turns half a
 * shipped style sheet into warnings, so every lookup below folds case first.
 */
export function attributeOf(element: KitElement, name: string) {
  const wanted = name.toLowerCase()
  return element.attrs.find(item => item.name.toLowerCase() === wanted)
}

export const HEX_COLOR = /^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u
export const DECIMAL_COLOR = /^\d{1,3}(?:\s*,\s*\d{1,3}){2,3}$/u

export interface Flat {
  readonly element: KitElement
  readonly parent: string | undefined
}

/** The document as a flat, ordered list, because every rule here reads the parent name. */
/*
 * Element names are case-insensitive to the game: Blizzard's own core FontStyles writes `<style …>`
 * among thousands of `<Style …>`. Known tags are read under their canonical spelling so every rule
 * treats both the same, exactly as `parseFontStyles` already does.
 */
const CANONICAL_TAGS: ReadonlyMap<string, string> = new Map(
  ['StyleFile', 'Constant', 'FontGroup', 'CodepointRange', 'Style'].map(tag => [tag.toLowerCase(), tag]),
)

export function scanStyle(text: string): readonly Flat[] {
  const flat: Flat[] = []
  const walk = (nodes: readonly KitElement[], parent: string | undefined): void => {
    for (const node of nodes) {
      const tag = CANONICAL_TAGS.get(node.tag.toLowerCase()) ?? node.tag
      flat.push({ element: tag === node.tag ? node : { ...node, tag }, parent })
      walk(node.children, tag)
    }
  }
  walk(scanXml(text), undefined)
  return flat.sort((left, right) => left.element.start - right.element.start)
}

export class Positions {
  readonly #starts: number[]
  constructor(text: string) {
    this.#starts = lineStartOffsets(text)
  }

  at(offset: number): LanguagePosition {
    const position = positionAt(this.#starts, offset)
    return { line: position.line, character: position.character }
  }

  range(from: number, to: number): LanguageRange {
    return { start: this.at(from), end: this.at(to) }
  }

  offset(position: LanguagePosition): number {
    return (this.#starts[position.line] ?? 0) + position.character
  }
}

/**
 * Names a style sheet may refer to without declaring them.
 *
 * SC2 merges style sheets along the dependency chain, so a mod's own sheet legitimately builds on
 * `InternationalTemplate` and on colour constants it never declares. Whether that is a broken
 * reference or an inherited one is not knowable from this file alone — it is knowable from the
 * workspace snapshot the request carries, which is why the check reads it instead of guessing.
 */
export function inheritedNames(documents: readonly { readonly text: string }[]): {
  constants: Set<string>
  fontGroups: Set<string>
  styles: Set<string>
} {
  const constants = new Set<string>()
  const fontGroups = new Set<string>()
  const styles = new Set<string>()
  for (const document of documents) {
    const sheet = parseFontStyles(document.text)
    for (const name of sheet.constants.keys()) constants.add(name)
    for (const name of sheet.fontGroups.keys()) fontGroups.add(name)
    for (const name of sheet.styles.keys()) styles.add(name)
  }
  return { constants, fontGroups, styles }
}

/**
 * What a name in a style sheet or a catalog names.
 *
 * The three kinds share one namespace of spellings and nothing else: `Title` may be a Style and a
 * Constant at once, and renaming one must not touch the other. Every navigation and edit below
 * compares kind *and* name, which is why an occurrence carries both.
 */
export type StyleNameKind = 'style' | 'constant' | 'font-group'

export interface StyleNameOccurrence {
  readonly kind: StyleNameKind
  readonly name: string
  /** Offsets of the bare name — never the `#` in front of a constant reference. */
  readonly start: number
  readonly end: number
  readonly declaration: boolean
}

export interface DeclaredNames {
  readonly constants: ReadonlySet<string>
  readonly fontGroups: ReadonlySet<string>
  readonly styles: ReadonlySet<string>
}

const DECLARING_KIND: Readonly<Record<string, StyleNameKind>> = Object.freeze({
  Style: 'style',
  Constant: 'constant',
  FontGroup: 'font-group',
})

/** The whitespace-trimmed terms of a colour value — one, or two either side of a gradient dash. */
export function colorTerms(value: string, valueStart: number): { text: string; start: number }[] {
  return [...value.matchAll(/[^-]+/gu)].flatMap(match => {
    const text = match[0].trim()
    return text === ''
      ? []
      : [{ text, start: valueStart + (match.index ?? 0) + match[0].indexOf(text) }]
  })
}

/**
 * Every declaration of and reference to a Style, Constant or FontGroup in one sheet, typed.
 *
 * The reference rules are the ones Blizzard's core FontStyles actually exercises:
 * - `template` names a Style;
 * - `#Name` names a Constant — in a colour term, a `font`, or another constant's `val`. A `#Name`
 *   with no Constant but a FontGroup of that name is the FontGroup, which is how the diagnostics
 *   already resolve it;
 * - a bare `font` on a Style (`font="DebugGlyphTypeFontGroup"`) or a bare Constant `val`
 *   (`FontStandard="StandardFontGroup"`) names a FontGroup — but only when one is declared, because
 *   the same attribute otherwise holds a font file path, and renaming a path would be a guess.
 *
 * `declared` spans every visible sheet, not only this one: whether `#X` is a constant or a font
 * group is decided by the declarations, and those merge across dependencies.
 */
export function styleOccurrences(text: string, declared: DeclaredNames): readonly StyleNameOccurrence[] {
  const found: StyleNameOccurrence[] = []
  const push = (kind: StyleNameKind, name: string, start: number, declaration = false): void => {
    if (name === '' || text.slice(start, start + name.length) !== name) return
    found.push({ kind, name, start, end: start + name.length, declaration })
  }
  const reference = (raw: string, start: number, bareFontGroup: boolean): void => {
    if (raw.startsWith('#')) {
      const name = raw.slice(1)
      const kind =
        !declared.constants.has(name) && declared.fontGroups.has(name) ? 'font-group' : 'constant'
      push(kind, name, start + 1)
    } else if (bareFontGroup && declared.fontGroups.has(raw)) {
      push('font-group', raw, start)
    }
  }

  for (const { element } of scanStyle(text)) {
    for (const attribute of element.attrs) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value
      const start = attribute.valueStart
      const declaring = DECLARING_KIND[element.tag]
      if (name === 'name' && declaring !== undefined) {
        push(declaring, value, start, true)
      } else if (element.tag === 'Style' && name === 'template') {
        if (value.startsWith('#')) reference(value, start, false)
        else push('style', value, start)
      } else if (element.tag === 'Style' && COLOR_ATTRIBUTES.includes(name)) {
        for (const term of colorTerms(value, start)) reference(term.text, term.start, false)
      } else if (name === 'font' && (element.tag === 'Style' || element.tag === 'CodepointRange')) {
        reference(value, start, element.tag === 'Style')
      } else if (element.tag === 'Constant' && name === 'val') {
        // A constant may alias a gradient of constants; a bare value may still name a FontGroup.
        if (value.includes('-')) {
          for (const term of colorTerms(value, start)) reference(term.text, term.start, false)
        } else {
          reference(value, start, true)
        }
      }
    }
  }
  return found
}

/**
 * Every style and constant use in one localization catalog, with its exact span.
 *
 * `<s val="Name">` applies a Style and `<c val="Name">` or `<c val="#Name">` a Constant; a line may
 * carry several of each, and every one is a separate edit. Literal colours are not references —
 * the rule is `styleRefsOf`'s, repeated here only because that parser reports names, not offsets.
 */
export function catalogOccurrences(text: string): readonly StyleNameOccurrence[] {
  const found: StyleNameOccurrence[] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0 && !line.startsWith('//')) {
      for (const match of line.matchAll(/<([sc])\s+val\s*=\s*(["'])([^"']*)\2/giu)) {
        if ((match.index ?? 0) < separator) continue
        const raw = match[3] ?? ''
        const valueStart = lineStart + (match.index ?? 0) + match[0].length - 1 - raw.length
        if (match[1]?.toLowerCase() === 's') {
          if (raw !== '') {
            found.push({ kind: 'style', name: raw, start: valueStart, end: valueStart + raw.length, declaration: false })
          }
          continue
        }
        const hash = raw.startsWith('#') ? 1 : 0
        const name = raw.slice(hash)
        if (HEX_COLOR.test(name) || DECIMAL_COLOR.test(name) || !/^[A-Za-z_][\w-]*$/u.test(name)) {
          continue
        }
        const start = valueStart + hash
        found.push({ kind: 'constant', name, start, end: start + name.length, declaration: false })
      }
    }
    lineStart += line.length + 1
  }
  return found
}

export const SC2_LAYOUT_LANGUAGE_ID = 'sc2-layout'

/**
 * Every Style name a layout applies, with the span of the bare name.
 *
 * The forms are the ones the layout schema types as `Style` and Blizzard's 377 core layouts use:
 * a `<Style val>` field, the `style1`/`style2` of a `<Controller type="Style">`, and the `Style`
 * property of `<Action type="SetProperty">`. A value may carry `@`, `@@` or `@@@` in front of a
 * declared style name; `#Name` is a layout constant, not a style, and is left alone.
 */
export function layoutOccurrences(text: string): readonly StyleNameOccurrence[] {
  const found: StyleNameOccurrence[] = []
  const walk = (nodes: readonly KitElement[]): void => {
    for (const element of nodes) {
      const type = attributeOf(element, 'type')?.value.toLowerCase()
      const names =
        element.tag === 'Style'
          ? ['val']
          : element.tag === 'Controller' && type === 'style'
            ? ['style1', 'style2']
            : element.tag === 'Action' && type === 'setproperty'
              ? ['style']
              : []
      for (const attribute of element.attrs) {
        if (!names.includes(attribute.name.toLowerCase())) continue
        const prefix = /^@*/u.exec(attribute.value)?.[0].length ?? 0
        const name = attribute.value.slice(prefix)
        const start = attribute.valueStart + prefix
        if (name === '' || name.startsWith('#') || text.slice(start, start + name.length) !== name) {
          continue
        }
        found.push({ kind: 'style', name, start, end: start + name.length, declaration: false })
      }
      walk(element.children)
    }
  }
  walk(scanXml(text))
  return found
}

export interface NamedDocument {
  readonly uri: string
  readonly version: number
  readonly text: string
  readonly occurrences: readonly StyleNameOccurrence[]
}

/*
 * Catalog and layout occurrences depend on the document's text alone. A host that leaves its
 * documents with this worker between calls (retained call values) hands every request the same
 * deep-frozen object until its text changes, so a closure's hundreds of catalogs and layouts are
 * scanned once per revision instead of on every request. Only frozen documents are kept: a caller's
 * mutable object could change under the cache. Kept occurrences are frozen and never mutated.
 */
const catalogOccurrenceCache = new WeakMap<object, readonly StyleNameOccurrence[]>()
const layoutOccurrenceCache = new WeakMap<object, readonly StyleNameOccurrence[]>()

function textOccurrences(
  cache: WeakMap<object, readonly StyleNameOccurrence[]>,
  document: { readonly text: string },
  read: (text: string) => readonly StyleNameOccurrence[],
): readonly StyleNameOccurrence[] {
  if (!Object.isFrozen(document)) return read(document.text)
  const cached = cache.get(document)
  if (cached !== undefined) return cached
  const found = Object.freeze(read(document.text).map(item => Object.freeze(item)))
  cache.set(document, found)
  return found
}

/**
 * The sheets and their users (catalogs, layouts) one request can see, each indexed once.
 *
 * The primary document comes first and the rest in URI order, so the answer to "where is this
 * declared?" does not depend on the order the host happened to collect the snapshot in.
 * Target-only requests still select all documents by URI before skipping unrelated user scans.
 */
export function styleWorkspace(request: LanguageFeatureRequest, includeUsers = true): {
  readonly sheets: readonly NamedDocument[]
  readonly catalogs: readonly NamedDocument[]
} {
  const byUri = new Map<string, LanguageFeatureRequest['document']>()
  for (const document of [request.document, ...request.workspaceDocuments]) {
    if (!byUri.has(document.uri)) byUri.set(document.uri, document)
  }
  const ordered = [...byUri.values()].sort((left, right) =>
    left.uri === request.document.uri
      ? -1
      : right.uri === request.document.uri
        ? 1
        : left.uri.localeCompare(right.uri),
  )
  const sheetDocuments = ordered.filter(item => item.languageId === SC2_STYLE_LANGUAGE_ID)
  const declared = inheritedNames(sheetDocuments)
  return {
    sheets: sheetDocuments.map(item => ({ ...item, occurrences: styleOccurrences(item.text, declared) })),
    // Catalogs and layouts only ever use names, so both count as "users" of the sheets.
    catalogs: (includeUsers ? ordered : ordered.filter(item => item.uri === request.document.uri)).flatMap(item =>
      item.languageId === SC2_STRINGS_LANGUAGE_ID
        ? [{ ...item, occurrences: textOccurrences(catalogOccurrenceCache, item, catalogOccurrences) }]
        : item.languageId === SC2_LAYOUT_LANGUAGE_ID
          ? [{ ...item, occurrences: textOccurrences(layoutOccurrenceCache, item, layoutOccurrences) }]
          : [],
    ),
  }
}

interface WorkspaceOriginCompat {
  readonly uri: string
  readonly sourceRevision: string
}

interface WorkspaceContextCompat {
  readonly id: string
  readonly revision: string
  readonly semanticComplete: boolean
  readonly documentOrigins: readonly WorkspaceOriginCompat[]
}

interface ReferenceBatchCompat {
  readonly contextId: string
  readonly contextRevision: string
  readonly semanticComplete: boolean
  readonly sourceUri: string
  readonly sourceRevision: string
  readonly occurrences: readonly unknown[]
}

/** Project the canonical Style/String/Layout occurrence model into the host typed-reference DTO. */
export function styleReferenceOccurrenceBatches(
  request: LanguageFeatureRequest,
): readonly ReferenceBatchCompat[] {
  const context = (request as LanguageFeatureRequest & {
    readonly workspaceContext?: WorkspaceContextCompat
  }).workspaceContext
  if (context === undefined) return Object.freeze([])
  const origins = new Map(context.documentOrigins.map(origin => [origin.uri, origin]))
  const workspace = styleWorkspace(request)
  return Object.freeze([...workspace.sheets, ...workspace.catalogs].flatMap(document => {
    const origin = origins.get(document.uri)
    if (origin === undefined) return []
    // One line index per document: building it per occurrence made this quadratic in sheet size.
    let index: Positions | undefined
    const occurrences = document.occurrences.map(item => {
      index ??= new Positions(document.text)
      const at = index.at(item.start)
      return Object.freeze({
        target: Object.freeze({
          owner: 'blizzard/sc2-style',
          kind: 'style-name',
          typeId: item.kind,
          id: item.name,
          workspace: context.id,
        }),
        source: Object.freeze({
          uri: document.uri,
          sourceRevision: origin.sourceRevision,
          span: Object.freeze({
            utf16Offset: item.start,
            utf16Length: item.end - item.start,
            line: at.line,
            column: at.character,
          }),
          origin,
        }),
        semanticPath: Object.freeze([item.kind, item.name]),
        role: item.declaration ? 'declaration' : 'reference',
        form: 'literal',
        provenance: 'blizzard/sc2-style-names',
        ...(item.declaration
          ? {
              subject: Object.freeze({
                workspace: context.id,
                source: Object.freeze({ id: document.uri }),
                identity: Object.freeze({
                  kind: 'blizzard/sc2-style-name',
                  key: `${item.kind}/${item.name}`,
                }),
              }),
            }
          : {}),
      })
    })
    return [Object.freeze({
      contextId: context.id,
      contextRevision: context.revision,
      semanticComplete: !languageWorkspaceIsSemanticallyIncomplete(request),
      sourceUri: document.uri,
      sourceRevision: origin.sourceRevision,
      occurrences: Object.freeze(occurrences),
    })]
  }))
}

/** The occurrence under the caret; a caret on the `#` of `#Name` is on that name. */
export function occurrenceAt(document: NamedDocument, position: LanguagePosition) {
  const offset = new Positions(document.text).offset(position)
  return document.occurrences.find(item => {
    const from = document.text[item.start - 1] === '#' ? item.start - 1 : item.start
    return offset >= from && offset <= item.end
  })
}

export const sameName = (left: StyleNameOccurrence, right: StyleNameOccurrence): boolean =>
  left.kind === right.kind && left.name === right.name

/**
 * A new name every reference form can still carry.
 *
 * A catalog only reads `<c val>` as a reference when it starts like an identifier and is not a colour
 * literal, and a dash would split a colour attribute into a gradient. A name outside that set would
 * be written successfully and silently stop resolving, so it is refused instead.
 */
export function acceptableNewName(kind: StyleNameKind, name: string): boolean {
  if (!/^[A-Za-z_]\w*$/u.test(name)) return false
  return kind !== 'constant' || !HEX_COLOR.test(name)
}

export function locationsOf(
  documents: readonly NamedDocument[],
  target: StyleNameOccurrence,
  keep: (item: StyleNameOccurrence) => boolean,
): LanguageLocation[] {
  return documents.flatMap(document => {
    const index = new Positions(document.text)
    return document.occurrences
      .filter(item => sameName(item, target) && keep(item))
      .map(item => ({ uri: document.uri, range: index.range(item.start, item.end) }))
  })
}

export function boundedLocations(
  all: readonly LanguageLocation[],
  request: LanguageFeatureRequest,
): LanguageLocationList {
  const locations = all.slice(0, request.maxResults)
  return {
    locations,
    isIncomplete:
      locations.length < all.length || languageWorkspaceIsSemanticallyIncomplete(request),
  }
}

/** Locate the primary name; only references and rename edits need unrelated catalogs/layouts. */
function targetOf(request: LanguagePositionRequest, includeUsers: boolean) {
  const workspace = styleWorkspace(request, includeUsers)
  const primary = [...workspace.sheets, ...workspace.catalogs].find(
    item => item.uri === request.document.uri,
  )
  const target = primary === undefined ? undefined : occurrenceAt(primary, request.position)
  return { ...workspace, primary, target }
}

/** Whether the caret is on a Style, Constant or FontGroup name this model owns. */
export function styleNameAt(request: LanguagePositionRequest): boolean {
  return targetOf(request, false).target !== undefined
}

/**
 * Where a Style, Constant or FontGroup is declared, across every visible sheet.
 *
 * Sheets merge by name and the last declaration wins, so every declaration is a real answer.
 * An incomplete workspace stays incomplete: a dependency the host did not send may declare it
 * again, and "declared only here" would be a claim this snapshot cannot back.
 */
export function styleNameDefinition(request: LanguagePositionRequest): LanguageLocationList {
  const { sheets, target } = targetOf(request, false)
  if (target === undefined) return { locations: [], isIncomplete: false }
  return boundedLocations(locationsOf(sheets, target, item => item.declaration), request)
}

/** The loaded mod a served request names: its server scope and revision and the document's place. */
interface ServedModContext {
  readonly scope: string
  readonly revision: string
  readonly document?: { readonly layerId: string; readonly path: string }
}

/** A port to loaded mods' servers, as a provider receives it (`ContributionContext.modContexts`). */
interface StyleModContextPort {
  query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown>
}

/** The loaded mod a request names with its document's place, if any. */
export function servedModContext(request: LanguageFeatureRequest): ServedModContext | undefined {
  const served = (request.workspaceContext as { readonly modContext?: ServedModContext } | undefined)?.modContext
  return served?.document === undefined ? undefined : served
}

/**
 * Whether the caret is on a name the loaded mod's server can define from the live document alone: a
 * Style, Constant or FontGroup a catalog (Strings) or a layout names. A sheet's own names need the
 * other sheets.
 */
export function styleNameServable(request: Pick<LanguagePositionRequest, 'document' | 'position'>): boolean {
  if (request.document.languageId !== SC2_STRINGS_LANGUAGE_ID && request.document.languageId !== SC2_LAYOUT_LANGUAGE_ID) return false
  return styleNameAt({ ...request, workspaceDocuments: [request.document] } as unknown as LanguagePositionRequest)
}

/**
 * `styleNameDefinition` answered by the loaded mod's server, which holds the chain's sheets
 * (`served-definitions.ts`): the same target from the live document, the same declarations, ordered
 * as the snapshot orders sheets (by URI; a catalog is never a sheet) and bounded the same way.
 */
export async function styleNameServedDefinition(
  request: LanguagePositionRequest,
  modContexts: StyleModContextPort,
  served: ServedModContext,
): Promise<LanguageLocationList> {
  const { target } = targetOf(request, false)
  if (target === undefined || served.document === undefined) return { locations: [], isIncomplete: false }
  const answer = (await modContexts.query(
    served.scope,
    { kind: 'style.definition', styleKind: target.kind, name: target.name },
    request.signal,
  )) as {
    readonly revision?: unknown
    readonly documents: readonly { readonly uri?: unknown }[]
    readonly definitions: readonly { readonly document: number; readonly range: LanguageRange }[]
  }
  if (answer.revision !== served.revision) throw new Error('style.definition answered another revision')
  const located = answer.definitions.map(item => {
    const uri = answer.documents[item.document]?.uri
    if (typeof uri !== 'string') throw new TypeError('style.definition named a sheet without a URI')
    return { uri, range: item.range }
  })
  const order = [...new Set(located.map(item => item.uri))].sort((left, right) => left.localeCompare(right))
  const rank = new Map(order.map((uri, index) => [uri, index]))
  return boundedLocations([...located].sort((left, right) => rank.get(left.uri)! - rank.get(right.uri)!), request)
}

/** Every declaration and use of the typed name in sheets, catalogs and layouts. */
export function styleNameReferences(request: LanguageReferencesRequest): LanguageLocationList {
  const { sheets, catalogs, target } = targetOf(request, true)
  if (target === undefined) return { locations: [], isIncomplete: false }
  const keep = (item: StyleNameOccurrence): boolean =>
    request.includeDeclaration !== false || !item.declaration
  return boundedLocations(
    [...locationsOf(sheets, target, keep), ...locationsOf(catalogs, target, keep)],
    request,
  )
}

/** References answered by the retained chain owner, with its revision and Host-owned URI mapping. */
export async function styleNameServedReferences(request: LanguageReferencesRequest, port: StyleModContextPort,
  served: ServedModContext): Promise<LanguageLocationList> {
  const answer = await port.query(served.scope, { kind: 'style.references', document: served.document,
    position: request.position, includeDeclaration: request.includeDeclaration !== false,
    maxResults: request.maxResults, incomplete: languageWorkspaceIsSemanticallyIncomplete(request) }, request.signal) as {
      revision: string; documents: readonly { uri?: string }[];
      references: readonly { document: number; range: LanguageLocation['range'] }[]; isIncomplete: boolean
    }
  if (answer.revision !== served.revision) throw new Error('style.references answered another revision')
  return { locations: answer.references.map(location => {
    const uri = answer.documents[location.document]?.uri
    if (typeof uri !== 'string') throw new TypeError('style.references named a document without a URI')
    return { uri, range: location.range }
  }), isIncomplete: answer.isIncomplete }
}

export function styleNamePrepareRename(
  request: LanguagePositionRequest,
): LanguageRenamePreparation | undefined {
  const { primary, target } = targetOf(request, false)
  if (primary === undefined || target === undefined) return undefined
  return {
    range: new Positions(primary.text).range(target.start, target.end),
    placeholder: target.name,
  }
}

/**
 * Rename one typed name everywhere this request can prove it is used.
 *
 * A complete workspace renames declarations and uses in every sheet, catalog and layout. An
 * incomplete one renames only the primary document — the bounded case the host accepts — because a
 * document it did not send may use the name, and editing some of the uses would break the rest.
 */
export function styleNameRename(request: LanguageRenameRequest): LanguageWorkspaceEdit | undefined {
  const { sheets, catalogs, primary, target } = targetOf(request, true)
  if (primary === undefined || target === undefined || target.name === request.newName) {
    return undefined
  }
  if (request.workspaceIncomplete) return undefined
  if (!acceptableNewName(target.kind, request.newName)) return undefined
  const declarations = sheets.flatMap(document => document.occurrences).filter(item => item.declaration)
  if (declarations.some(item => item.kind === target.kind && item.name === request.newName)) return undefined
  if (declarations.filter(item => sameName(item, target)).length !== 1) return undefined
  const documents = [...sheets, ...catalogs]
  const documentChanges: LanguageTextDocumentEdit[] = []
  let editCount = 0
  for (const document of documents) {
    const index = new Positions(document.text)
    const edits = document.occurrences
      .filter(item => sameName(item, target))
      .map(item => ({ range: index.range(item.start, item.end), newText: request.newName }))
    if (edits.length === 0) continue
    editCount += edits.length
    if (editCount > request.maxEdits || documentChanges.length >= request.maxDocuments) {
      return undefined
    }
    documentChanges.push({ uri: document.uri, documentVersion: document.version, edits })
  }
  return documentChanges.length === 0 ? undefined : { documentChanges, isComplete: true }
}
