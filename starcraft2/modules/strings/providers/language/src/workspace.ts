/** Bounded workspace navigation for SC2 localization catalogs. */
import type {
  LanguageDocument,
  LanguageLocation,
  LanguageLocationList,
  LanguagePosition,
  LanguageRange,
  LanguageReferencesRequest,
  LanguageRenamePreparation,
  LanguageRenameRequest,
  LanguageWorkspaceEdit,
  LanguageWorkspaceSymbol,
  LanguageWorkspaceSymbolList,
  LanguageWorkspaceSymbolsRequest,
} from '@modkit/sdk'
import { languageWorkspaceIsSemanticallyIncomplete } from '../../../../../shared/language/workspace-context.js'
import { findSegmentAt } from '../../../shared/core/index.js'
import { catalogEntities } from '../../../../data/shared/format/language/entity.js'
import { starcraft2NamespaceForType } from '@modkit/blizzard-starcraft2/schema'
import { getAttr, scanXml } from '@modkit/codec-kit'
import { layoutTextReferences } from '../../../../../shared/language/layout-text-refs.js'
import { Parser, forEachChild, getKindName } from '@modkit/blizzard-starcraft2/galaxy/language-core'
import type { CallExpression, Identifier, Node, StringLiteral } from '@modkit/blizzard-starcraft2/galaxy/language-core'

interface LineView {
  readonly line: number
  readonly start: number
  readonly text: string
}

interface KeyTarget {
  readonly key: string
  readonly range: LanguageRange
}

interface KeyMatch {
  readonly start: number
  readonly end: number
  readonly kind: 'definition' | 'stringref'
}

interface CatalogTarget {
  readonly namespace: string
  readonly entityId: string
}

class LineIndex {
  readonly #starts: number[] = [0]

  constructor(readonly text: string) {
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

  line(position: LanguagePosition): LineView | undefined {
    const start = this.#starts[position.line]
    if (start === undefined) return undefined
    const next = this.#starts[position.line + 1] ?? this.text.length
    const raw = this.text.slice(start, next).replace(/[\r\n]+$/u, '')
    return { line: position.line, start, text: raw }
  }
}

function documentsOf(request: {
  readonly document: LanguageDocument
  readonly workspaceDocuments: readonly LanguageDocument[]
}): readonly LanguageDocument[] {
  // Catalogs only, the primary first when it is one; a layout primary names keys but defines none.
  const documents = request.document.languageId === 'sc2-strings' ? [request.document] : []
  const seen = new Set(documents.map(document => document.uri))
  for (const document of request.workspaceDocuments) {
    if (document.languageId !== 'sc2-strings' || seen.has(document.uri)) continue
    seen.add(document.uri)
    documents.push(document)
  }
  return documents
}

/**
 * Layouts that name GameStrings keys (`<Text val="@Key">` and the other Text-typed forms). A key is
 * used there as much as in a `<d stringref>`, so references and a complete rename include them.
 */
function layoutDocumentsOf(request: {
  readonly document: LanguageDocument
  readonly workspaceDocuments: readonly LanguageDocument[]
}) {
  const seen = new Set<string>()
  return [request.document, ...request.workspaceDocuments].filter(document => {
    if (document.languageId !== 'sc2-layout' || seen.has(document.uri)) return false
    seen.add(document.uri)
    return true
  })
}

function layoutKeyMatches(text: string, key: string): readonly KeyMatch[] {
  // A layout names a key verbatim (`layoutTextReferences` checks the text): no copy, no match.
  if (!text.includes(key)) return []
  return layoutTextReferences(text)
    .filter(item => item.key === key)
    .map(item => ({ start: item.start, end: item.end, kind: 'stringref' as const }))
}

/**
 * Galaxy scripts that may name GameStrings keys (`StringExternal("Key")`), in the request's set: a
 * key is used there as much as in a layout, so references and a complete rename include them.
 */
function galaxyDocumentsOf(request: {
  readonly document: LanguageDocument
  readonly workspaceDocuments: readonly LanguageDocument[]
}) {
  const seen = new Set<string>()
  return [request.document, ...request.workspaceDocuments].filter(document => {
    if (document.languageId !== 'galaxy' || seen.has(document.uri)) return false
    seen.add(document.uri)
    return true
  })
}

const galaxyKeyViews = new WeakMap<object, {
  readonly text: string
  readonly references: readonly { readonly key: string; readonly start: number; readonly end: number }[]
}>()

/**
 * The GameStrings keys a Galaxy script names by literal: the first argument of `StringExternal`
 * (Blizzard NativeLib), read with the canonical Galaxy parser so comments and other strings never
 * count. A key computed at run time names nothing a rename could follow; like a layout's computed
 * text it is left out, not reported as incomplete. Cached per document while its text is the same.
 */
function galaxyKeyReferences(document: StringKeyDocument) {
  const held = galaxyKeyViews.get(document)
  if (held?.text === document.text) return held.references
  const references: { key: string; start: number; end: number }[] = []
  const visit = (node: Node): void => {
    // kinds by name: the parser's SyntaxKind is a const enum a consumer under verbatimModuleSyntax cannot read
    if (getKindName(node.kind) === 'CallExpression') {
      const call = node as CallExpression
      const callee = call.expression as Identifier | undefined
      const argument = call.arguments?.[0] as StringLiteral | undefined
      if (callee !== undefined && getKindName(callee.kind) === 'Identifier' && callee.name === 'StringExternal' &&
          argument !== undefined && getKindName(argument.kind) === 'StringLiteral') {
        const raw = document.text.slice(argument.pos, argument.end)
        const open = raw.indexOf('"')
        const close = raw.lastIndexOf('"')
        // only a plain literal: an escape would make the spelled text differ from the key
        if (open >= 0 && close > open && !raw.includes('\\')) {
          references.push({ key: raw.slice(open + 1, close), start: argument.pos + open + 1, end: argument.pos + close })
        }
      }
    }
    forEachChild(node, child => {
      visit(child)
      return undefined
    })
  }
  visit(new Parser().parseFile(document.uri, document.text))
  galaxyKeyViews.set(document, { text: document.text, references })
  return references
}

function galaxyKeyMatches(document: StringKeyDocument, key: string): readonly KeyMatch[] {
  // A script names a key verbatim inside the call: without both words there is nothing to parse.
  if (!document.text.includes(key) || !document.text.includes('StringExternal')) return []
  return galaxyKeyReferences(document)
    .filter(item => item.key === key)
    .map(item => ({ start: item.start, end: item.end, kind: 'stringref' as const }))
}

const STRINGREF = /stringref/iu
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function keyToTuple(key: string): { ns: string; entity: string; field: string } | undefined {
  const parts = key.split('/')
  if (parts.length !== 3 || parts.some(part => part === '')) return undefined
  return { ns: parts[0]!, field: parts[1]!, entity: parts[2]! }
}

const layoutKeyViews = new WeakMap<LanguageDocument, {
  readonly text: string
  readonly index: LineIndex
  readonly references: ReturnType<typeof layoutTextReferences>
}>()

/** Reuse the canonical Text-reference projection while this document's contents stay unchanged. */
function layoutKeyView(document: LanguageDocument) {
  const held = layoutKeyViews.get(document)
  if (held?.text === document.text) return held
  const view = { text: document.text, index: new LineIndex(document.text), references: layoutTextReferences(document.text) }
  layoutKeyViews.set(document, view)
  return view
}

/** The GameStrings key under the caret in a layout's Text-typed value, without its `@` prefix. */
function layoutTargetAt(document: LanguageDocument, position: LanguagePosition): KeyTarget | undefined {
  const { index, references } = layoutKeyView(document)
  const line = index.line(position)
  if (line === undefined) return undefined
  const offset = line.start + position.character
  const found = references.find(
    item => offset >= item.start - 1 && offset <= item.end,
  )
  return found === undefined ? undefined : { key: found.key, range: index.range(found.start, found.end) }
}

/** Whether the caret is on a GameStrings key this module navigates — in a catalog, a layout or a script. */
export function stringKeyAt(document: LanguageDocument, position: LanguagePosition): boolean {
  return targetAt(document, position) !== undefined
}

/** The GameStrings key under the caret, in a catalog, a layout or a script; undefined elsewhere. */
export function stringKeyUnder(document: LanguageDocument, position: LanguagePosition): string | undefined {
  return targetAt(document, position)?.key
}

/** Whether the caret in a catalog is on a data entity a value names (`<d ref>`, `<d stringref>`). */
export function stringCatalogEntityAt(document: LanguageDocument, position: LanguagePosition): boolean {
  return document.languageId === 'sc2-strings' && catalogTargetAt(document, position) !== undefined
}

/** A document a key's locations are searched in. */
export interface StringKeyDocument {
  readonly uri: string
  readonly text: string
}

/**
 * Where a key is defined (`Key=` lines of catalogs, with `definitions`) and used (`<d stringref>` in
 * catalogs, `@Key` in layouts and `StringExternal("Key")` in Galaxy scripts, with `uses`): catalogs
 * first, then layouts, then scripts, each in document order. `capped` when `maxResults` stopped the
 * search. The snapshot path and the loaded mod's server (`served-keys.ts`) both answer through this.
 */
export function stringKeyLocations(
  key: string,
  catalogs: readonly StringKeyDocument[],
  layouts: readonly StringKeyDocument[],
  mode: { readonly definitions: boolean; readonly uses: boolean },
  maxResults: number,
  scripts: readonly StringKeyDocument[] = [],
): { readonly locations: readonly LanguageLocation[]; readonly capped: boolean } {
  const locations: LanguageLocation[] = []
  for (const document of catalogs) {
    const matches = matchesIn(document.text, key)
    // Line starts only for a document that has a match: most of a chain's catalogs have none.
    const index = matches.length === 0 ? undefined : new LineIndex(document.text)
    for (const match of matches) {
      if (match.kind === 'definition' ? !mode.definitions : !mode.uses) continue
      locations.push({ uri: document.uri, range: index!.range(match.start, match.end) })
      if (locations.length >= maxResults) return { locations, capped: true }
    }
  }
  if (!mode.uses) return { locations, capped: false }
  for (const document of layouts) {
    const matches = layoutKeyMatches(document.text, key)
    const index = matches.length === 0 ? undefined : new LineIndex(document.text)
    for (const match of matches) {
      locations.push({ uri: document.uri, range: index!.range(match.start, match.end) })
      if (locations.length >= maxResults) return { locations, capped: true }
    }
  }
  for (const document of scripts) {
    const matches = galaxyKeyMatches(document, key)
    const index = matches.length === 0 ? undefined : new LineIndex(document.text)
    for (const match of matches) {
      locations.push({ uri: document.uri, range: index!.range(match.start, match.end) })
      if (locations.length >= maxResults) return { locations, capped: true }
    }
  }
  return { locations, capped: false }
}

/** The loaded mod a served request names, and a port to its server (`ContributionContext.modContexts`). */
export interface StringsServedContext {
  readonly scope: string
  readonly revision: string
  readonly document: { readonly layerId: string; readonly path: string }
}
export interface StringsModContextPort {
  query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown>
}

/**
 * `stringsDefinition` (`definitions` only) or `stringsReferences` answered by the loaded mod's
 * server, which holds the chain's catalogs and layouts (`served-keys.ts`): the key under the caret
 * from the live document, the same locations in the same order, under the URIs the host gives.
 */
export async function stringsServedLocations(
  request: LanguageReferencesRequest,
  modContexts: StringsModContextPort,
  served: StringsServedContext,
  mode: { readonly definitions: boolean; readonly uses: boolean },
): Promise<LanguageLocationList> {
  const key = stringKeyUnder(request.document, request.position)
  if (key === undefined) return { locations: [], isIncomplete: false }
  const answer = (await modContexts.query(served.scope, {
    kind: 'strings.keys',
    action: 'locations',
    key,
    document: { layerId: served.document.layerId, path: served.document.path },
    definitions: mode.definitions,
    uses: mode.uses,
    maxResults: request.maxResults,
  }, request.signal)) as {
    readonly revision?: unknown
    readonly capped: boolean
    readonly documents: readonly { readonly uri?: unknown }[]
    readonly locations: readonly { readonly document: number; readonly range: LanguageRange }[]
  }
  if (answer.revision !== served.revision) throw new Error('strings.keys answered another revision')
  const locations = answer.locations.map(item => {
    const uri = answer.documents[item.document]?.uri
    if (typeof uri !== 'string') throw new TypeError('strings.keys named a document without a URI')
    return { uri, range: item.range }
  })
  return { locations, isIncomplete: answer.capped || languageWorkspaceIsSemanticallyIncomplete(request) }
}

/** How many catalogs other than the request's define `key`, from the loaded mod's server. */
export async function stringsServedOtherCatalogs(
  request: { readonly signal?: AbortSignal },
  modContexts: StringsModContextPort,
  served: StringsServedContext,
  key: string,
): Promise<number> {
  const answer = (await modContexts.query(served.scope, {
    kind: 'strings.keys',
    action: 'count',
    key,
    document: { layerId: served.document.layerId, path: served.document.path },
  }, request.signal)) as { readonly revision?: unknown; readonly count: number }
  if (answer.revision !== served.revision) throw new Error('strings.keys answered another revision')
  return answer.count
}

/** Whether a catalog's text defines a key on a line of its own (`Key=`), as a key's hover counts it. */
export function stringKeyDefinedIn(text: string, key: string): boolean {
  return text.includes(`${key}=`) && text.split('\n').some(line => line.startsWith(`${key}=`))
}

/** The GameStrings key under the caret in a script's `StringExternal("Key")` literal. */
function galaxyTargetAt(document: LanguageDocument, position: LanguagePosition): KeyTarget | undefined {
  if (!document.text.includes('StringExternal')) return undefined
  const index = new LineIndex(document.text)
  const line = index.line(position)
  if (line === undefined) return undefined
  const offset = line.start + position.character
  const found = galaxyKeyReferences(document).find(item => offset >= item.start && offset <= item.end)
  return found === undefined ? undefined : { key: found.key, range: index.range(found.start, found.end) }
}

function targetAt(document: LanguageDocument, position: LanguagePosition): KeyTarget | undefined {
  if (document.languageId === 'sc2-layout') return layoutTargetAt(document, position)
  if (document.languageId === 'galaxy') return galaxyTargetAt(document, position)
  const index = new LineIndex(document.text)
  const line = index.line(position)
  if (line === undefined || /^\s*\/\//u.test(line.text)) return undefined
  const separator = line.text.indexOf('=')
  if (separator <= 0) return undefined

  if (position.character <= separator) {
    const key = line.text.slice(0, separator).trim()
    if (key === '') return undefined
    const start = line.start + line.text.indexOf(key)
    return { key, range: index.range(start, start + key.length) }
  }

  const valueStart = separator + 1
  const found = findSegmentAt(line.text.slice(valueStart), position.character - valueStart)
  if (found?.segment.kind !== 'stringref') return undefined
  const tuple = `${found.segment.ns},${found.segment.entity},${found.segment.field}`
  const tupleStart = found.segment.raw.indexOf(tuple)
  if (tupleStart < 0) return undefined
  const start = line.start + valueStart + found.start + tupleStart
  return {
    key: `${found.segment.ns}/${found.segment.field}/${found.segment.entity}`,
    range: index.range(start, start + tuple.length),
  }
}

function catalogTargetAt(
  document: LanguageDocument,
  position: LanguagePosition,
): CatalogTarget | undefined {
  const index = new LineIndex(document.text)
  const line = index.line(position)
  if (line === undefined) return undefined
  const separator = line.text.indexOf('=')
  if (separator < 0 || position.character <= separator) return undefined
  const valueStart = separator + 1
  const relative = position.character - valueStart
  const found = findSegmentAt(line.text.slice(valueStart), relative)
  if (found === undefined) return undefined
  if (found.segment.kind === 'stringref') {
    return { namespace: found.segment.ns, entityId: found.segment.entity }
  }
  if (found.segment.kind !== 'ref' && found.segment.kind !== 'time') return undefined
  const within = relative - found.start
  for (const match of found.segment.raw.matchAll(/([A-Za-z_]\w*),([A-Za-z_][\w@]*),[\w.[\]]+/gu)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (within >= start && within <= end) {
      return { namespace: match[1]!, entityId: match[2]! }
    }
  }
  return undefined
}

function matchesIn(text: string, key: string): readonly KeyMatch[] {
  const matches: KeyMatch[] = []
  // A definition spells the key verbatim and a use spells `stringref`: a catalog with neither is
  // skipped before its lines are scanned (a mod chain holds about 100 MiB of catalogs).
  if (text.includes(key)) {
    const definition = new RegExp(`^[ \\t]*(${escapeRegExp(key)})[ \\t]*=`, 'gmu')
    for (let match = definition.exec(text); match !== null; match = definition.exec(text)) {
      const start = match.index + match[0].indexOf(match[1]!)
      matches.push({ start, end: start + key.length, kind: 'definition' })
    }
  }
  const tuple = keyToTuple(key)
  if (tuple !== undefined && STRINGREF.test(text)) {
    const encoded = `${tuple.ns},${tuple.entity},${tuple.field}`
    const reference = new RegExp(
      `<d\\s+stringref\\s*=\\s*["'](${escapeRegExp(encoded)})["']`,
      'gimu',
    )
    for (let match = reference.exec(text); match !== null; match = reference.exec(text)) {
      const start = match.index + match[0].indexOf(match[1]!)
      matches.push({ start, end: start + encoded.length, kind: 'stringref' })
    }
  }
  return matches.sort((left, right) => left.start - right.start)
}

export function prepareStringsRename(
  document: LanguageDocument,
  position: LanguagePosition,
): LanguageRenamePreparation | undefined {
  const target = targetAt(document, position)
  return target === undefined ? undefined : { range: target.range, placeholder: target.key }
}

export function stringsDefinition(
  request: LanguageReferencesRequest,
): LanguageLocationList {
  const catalogTarget =
    request.document.languageId === 'sc2-strings'
      ? catalogTargetAt(request.document, request.position)
      : undefined
  if (catalogTarget !== undefined) {
    const locations: LanguageLocation[] = []
    for (const document of request.workspaceDocuments) {
      if (document.languageId !== 'sc2-data') continue
      const index = new LineIndex(document.text)
      for (const entity of catalogEntities(scanXml(document.text))) {
        if (
          starcraft2NamespaceForType(entity.tag) !== catalogTarget.namespace ||
          getAttr(entity, 'id')?.value !== catalogTarget.entityId
        ) {
          continue
        }
        const id = getAttr(entity, 'id')!
        locations.push({ uri: document.uri, range: index.range(id.valueStart, id.valueEnd) })
        if (locations.length >= request.maxResults) return { locations, isIncomplete: true }
      }
    }
    return { locations, isIncomplete: languageWorkspaceIsSemanticallyIncomplete(request) }
  }
  const target = targetAt(request.document, request.position)
  if (target === undefined) return { locations: [], isIncomplete: false }
  const found = stringKeyLocations(target.key, documentsOf(request), [], { definitions: true, uses: false }, request.maxResults)
  return { locations: [...found.locations], isIncomplete: found.capped || languageWorkspaceIsSemanticallyIncomplete(request) }
}

export function stringsReferences(request: LanguageReferencesRequest): LanguageLocationList {
  const target = targetAt(request.document, request.position)
  if (target === undefined) return { locations: [], isIncomplete: false }
  const found = stringKeyLocations(
    target.key,
    documentsOf(request),
    layoutDocumentsOf(request),
    { definitions: request.includeDeclaration === true, uses: true },
    request.maxResults,
    galaxyDocumentsOf(request),
  )
  return { locations: [...found.locations], isIncomplete: found.capped || languageWorkspaceIsSemanticallyIncomplete(request) }
}

export function renameStrings(request: LanguageRenameRequest): LanguageWorkspaceEdit | undefined {
  if (request.workspaceIncomplete || !/^[^\s=]+$/u.test(request.newName)) return undefined
  const target = targetAt(request.document, request.position)
  if (target === undefined) return undefined
  const oldTuple = keyToTuple(target.key)
  const newTuple = keyToTuple(request.newName)
  if (oldTuple !== undefined && newTuple === undefined) return undefined

  const documentChanges = []
  let editCount = 0
  for (const document of documentsOf(request)) {
    const index = new LineIndex(document.text)
    const edits = matchesIn(document.text, target.key).map(match => {
      const newText =
        match.kind === 'stringref'
          ? `${newTuple!.ns},${newTuple!.entity},${newTuple!.field}`
          : request.newName
      return { range: index.range(match.start, match.end), newText }
    })
    if (edits.length === 0) continue
    editCount += edits.length
    if (editCount > request.maxEdits) return undefined
    documentChanges.push({ uri: document.uri, documentVersion: document.version, edits })
  }
  const layouts = layoutDocumentsOf(request)
  // A layout carries the key inside a quoted XML attribute; a name that would break it is refused.
  if (layouts.length > 0 && /["<>&]/u.test(request.newName)) return undefined
  for (const document of layouts) {
    const index = new LineIndex(document.text)
    const edits = layoutKeyMatches(document.text, target.key).map(match => ({
      range: index.range(match.start, match.end),
      newText: request.newName,
    }))
    if (edits.length === 0) continue
    editCount += edits.length
    if (editCount > request.maxEdits) return undefined
    documentChanges.push({ uri: document.uri, documentVersion: document.version, edits })
  }
  for (const document of galaxyDocumentsOf(request)) {
    const matches = galaxyKeyMatches(document, target.key)
    if (matches.length === 0) continue
    // A script carries the key inside a Galaxy string literal; a name that would break it is refused.
    if (/["\\\r\n]/u.test(request.newName)) return undefined
    const index = new LineIndex(document.text)
    const edits = matches.map(match => ({ range: index.range(match.start, match.end), newText: request.newName }))
    editCount += edits.length
    if (editCount > request.maxEdits) return undefined
    documentChanges.push({ uri: document.uri, documentVersion: document.version, edits })
  }
  return documentChanges.length === 0 ? undefined : { documentChanges, isComplete: true }
}

function fuzzyMatch(candidate: string, query: string): boolean {
  const haystack = candidate.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  let at = 0
  for (let index = 0; index < haystack.length && at < needle.length; index += 1) {
    if (haystack[index] === needle[at]) at += 1
  }
  return at === needle.length
}

export function stringsWorkspaceSymbols(
  request: LanguageWorkspaceSymbolsRequest,
): LanguageWorkspaceSymbolList {
  if (request.query.length < 2) {
    return { symbols: [], isIncomplete: languageWorkspaceIsSemanticallyIncomplete(request) }
  }
  const symbols: LanguageWorkspaceSymbol[] = []
  for (const document of documentsOf(request)) {
    const index = new LineIndex(document.text)
    const seen = new Set<string>()
    for (const match of /^\s*([^\s/=][^=]*?)\s*=/gmu[Symbol.matchAll](document.text)) {
      const key = match[1]?.trim() ?? ''
      if (key === '' || seen.has(key) || !fuzzyMatch(key, request.query)) continue
      seen.add(key)
      const start = match.index! + match[0].indexOf(key)
      symbols.push({
        name: key,
        kind: 'field',
        containerName: document.uri.split('/').at(-1)!,
        location: { uri: document.uri, range: index.range(start, start + key.length) },
      })
      if (symbols.length >= request.maxResults) return { symbols, isIncomplete: true }
    }
  }
  return { symbols, isIncomplete: languageWorkspaceIsSemanticallyIncomplete(request) }
}
