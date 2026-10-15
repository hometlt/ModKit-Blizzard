import {
  analyzeGalaxyLanguage,
  formatGalaxySource,
  galaxyCompletionsAt,
  galaxyHoverAt,
  galaxyRenameRangeAt,
  galaxySymbolHoverMarkdown,
  galaxySignatureAt,
  galaxyWordAt,
} from './language-service.js'
import { GalaxyWorkspaceIndex } from '@modkit/blizzard-starcraft2/galaxy/analysis/workspace-index.js'
import { SyntaxKind, forEachChild, normalizeGalaxyIncludeIdentity } from '@modkit/blizzard-starcraft2/galaxy/language-core'
import { createSc2WorkspaceLinkIndex, hasSc2CatalogLinkAt } from './sc2-workspace-links.js'
// The GameStrings owner answers for a `StringExternal("Key")` literal: its catalogs define the key.
import {
  prepareStringsRename,
  renameStrings,
  stringKeyUnder,
  stringsDefinition,
  stringsReferences,
  stringsServedLocations,
} from '@modkit/blizzard-starcraft2/strings/language-keys'
import { languageWorkspaceIsSemanticallyIncomplete } from '../../../shared/language/workspace-context.js'
import {
  GALAXY_NATIVE_API_PROVENANCE,
  GALAXY_NATIVE_API_SOURCE,
  GALAXY_NATIVE_API_SUMMARIES,
  GALAXY_NATIVE_API_URI,
} from './native-api.js'

const MAX_DOCUMENT_CHARS = 2 * 1024 * 1024
const MAX_WORKSPACE_CHARS = 16 * 1024 * 1024

const nativeDocument = Object.freeze({
  uri: GALAXY_NATIVE_API_URI,
  languageId: 'galaxy',
  version: 1,
  text: GALAXY_NATIVE_API_SOURCE,
})
const nativeAnalysis = analyzeGalaxyLanguage(nativeDocument.text, nativeDocument.uri)
if (nativeAnalysis.diagnostics.length > 0) {
  throw new Error(
    `generated Galaxy API catalog has ${nativeAnalysis.diagnostics.length} parser diagnostic(s)`,
  )
}
const nativeIndexedFile = Object.freeze({
  fileName: nativeDocument.uri,
  code: nativeDocument.text,
  index: nativeAnalysis,
})

/*
 * `setTimeout(0)` waits for the next OS timer tick — ~15 ms on Windows, so a snapshot of 247 Void
 * documents spent 3.7 s of every request yielding (plan 2.14). `setImmediate` (Node, the host's
 * worker) yields the same turn to inbound frames without the wait.
 */
export const nextTurn = globalThis.setImmediate ?? (resolve => setTimeout(resolve, 0))

const checkpoint = async signal => {
  signal?.throwIfAborted()
  await new Promise(resolve => nextTurn(resolve))
  signal?.throwIfAborted()
}

function assertRequest(request, positioned = false) {
  request.signal?.throwIfAborted()
  if (request.document?.languageId !== 'galaxy') {
    throw new TypeError(`Galaxy provider cannot inspect ${request.document?.languageId}`)
  }
  if (
    !Number.isSafeInteger(request.maxResults) ||
    request.maxResults < 1 ||
    !Number.isSafeInteger(request.maxDocuments) ||
    request.maxDocuments < 1 ||
    request.workspaceDocuments.length > request.maxDocuments
  ) {
    throw new RangeError('Galaxy semantic request bounds are invalid')
  }
  if (
    request.editableDocumentUris !== undefined &&
    (!Array.isArray(request.editableDocumentUris) ||
      request.editableDocumentUris.length > request.maxDocuments ||
      request.editableDocumentUris.some(
        uri =>
          typeof uri !== 'string' ||
          !request.workspaceDocuments.some(document => document.uri === uri),
      ))
  ) {
    throw new RangeError('Galaxy editable document set is invalid')
  }
  if (
    positioned &&
    (!Number.isSafeInteger(request.position?.line) ||
      request.position.line < 0 ||
      !Number.isSafeInteger(request.position?.character) ||
      request.position.character < 0)
  ) {
    throw new RangeError('Galaxy semantic request position is invalid')
  }
}

function lineStarts(text) {
  const starts = [0]
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === '\n') starts.push(offset + 1)
  }
  return starts
}

function positionAt(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle] <= offset) low = middle + 1
    else high = middle - 1
  }
  const line = Math.max(0, high)
  return { line, character: Math.max(0, offset - starts[line]) }
}

const rangeAt = (document, start, end) => {
  const starts = lineStarts(document.text)
  return { start: positionAt(starts, start), end: positionAt(starts, end) }
}

function offsetAt(document, position) {
  const starts = lineStarts(document.text)
  const start = starts[position.line]
  if (start === undefined) throw new RangeError('Galaxy semantic position is outside the document')
  const lineEnd = document.text.indexOf('\n', start)
  const end = lineEnd < 0 ? document.text.length : lineEnd
  const contentEnd = end > start && document.text[end - 1] === '\r' ? end - 1 : end
  if (position.character > contentEnd - start) {
    throw new RangeError('Galaxy semantic position is outside the document')
  }
  return start + position.character
}

function symbolKind(kind) {
  switch (kind) {
    case 'function':
      return 'function'
    case 'property':
      return 'property'
    case 'struct':
      return 'struct'
    case 'include':
      return 'module'
    case 'typedef':
      return 'class'
    default:
      return 'variable'
  }
}

function completionKind(kind) {
  if (kind === 'typedef') return 'type'
  if (kind === 'include') return 'module'
  const supported = new Set([
    'class',
    'constant',
    'enum',
    'field',
    'function',
    'interface',
    'keyword',
    'module',
    'namespace',
    'parameter',
    'property',
    'snippet',
    'struct',
    'text',
    'type',
    'variable',
  ])
  return supported.has(kind) ? kind : 'text'
}

/**
 * Galaxy snippets, MK2's set, offered by the provider so the LSP and MCP have them as VS Code does
 * (plan 2.12): [prefix, name, body lines]. A body uses the editor snippet syntax.
 */
const GALAXY_SNIPPETS = Object.freeze([
  ['inc', 'include', ['include "$1"']],
  ['for', 'for iterator', ['for (${1:i} = ${2:0}; ${1:i} < ${3:1}; ${1:i} += 1) {', '\t${4:// TODO:}', '}']],
  ['forp', 'for players', [
    'for (${1:i} = 1; ${1:i} <= PlayerGroupCount(${2:PlayerGroupActive()}); ${1:i} += 1) {',
    '\t${3:tmp_player} = PlayerGroupPlayer(${2:PlayerGroupActive()}, ${1:i});',
    '}',
  ]],
  ['foru', 'for units', [
    'for (${1:i} = 1; ${1:i} <= UnitGroupCount(${2:group}, c_unitCountAll); ${1:i} += 1) {',
    '\t${3:tmp_unit} = UnitGroupUnit(${2:group}, ${1:i});',
    '}',
  ]],
  ['tgc', 'trigger complete declaration', [
    'bool ${1:name}(bool test_conds, bool run_actions)',
    '{',
    '\tif (test_conds) {',
    '\t}',
    '',
    '\tif (!run_actions) {',
    '\t\treturn true;',
    '\t}',
    '',
    '\t${0}return true;',
    '}',
  ]],
  ['tgs', 'trigger simplistic declaration', [
    'bool ${1:name}(bool test_conds, bool run_actions)',
    '{',
    '\t${0}return true;',
    '}',
  ]],
  ['its', 'IntToString', ['IntToString($1)']],
  ['itf', 'IntToFixed', ['IntToFixed($1)']],
  ['fts', 'FixedToString', ['FixedToString($1, ${2:-1})']],
  ['fti', 'FixedToInt', ['FixedToInt($1)']],
  ['stt', 'StringToText', ['StringToText($1)']],
].map(([prefix, name, body]) =>
  Object.freeze({
    label: prefix,
    kind: 'snippet',
    detail: name,
    insertText: body.join('\n'),
    sortText: `95:${prefix}`,
  }),
))

const FUNCTION_EXPANSIONS = new Set([
  'None',
  'Parenthesis',
  'ArgumentsNull',
  'ArgumentsDefault',
])

function functionParameterDefaults(detail) {
  const parameters = /\(([^()]*)\)/u.exec(detail ?? '')?.[1]?.trim()
  if (!parameters) return []
  return parameters.split(',').map(parameter => {
    const type = parameter.trim().split(/\s+/u)[0]
    if (type === 'int' || type === 'byte') return '0'
    if (type === 'fixed') return '0.0'
    if (type === 'string') return '""'
    if (type === 'bool') return 'false'
    return 'null'
  })
}

function configuredFunctionInsertText(item, request) {
  if (item.kind !== 'function') return item.insertText
  const mode = request.functionExpand
  if (mode === undefined) return item.insertText
  if (!FUNCTION_EXPANSIONS.has(mode)) throw new RangeError('Unknown Galaxy function expansion mode')
  if (mode === 'None') return item.label
  if (mode === 'Parenthesis') return `${item.label}($0)`
  const defaults = functionParameterDefaults(item.detail)
  const parameters = defaults.map((value, index) => `\${${index + 1}:${value}}`)
  return `${item.label}(${parameters.join(', ')})$0`
}

/** The `//` lines right above a declaration, read upwards from it — not the whole file split per item. */
function precedingDocumentation(code, start) {
  const documentation = []
  let end = start
  for (let first = true; ; first = false) {
    const lineStart = end > 0 ? code.lastIndexOf('\n', end - 1) + 1 : 0
    const line = code.slice(lineStart, end).replace(/\r$/u, '')
    if (!(first && line.trim() === '')) {
      const match = /^\s*\/\/\s?(.*)$/u.exec(line)
      if (match === null) break
      documentation.unshift(match[1])
    }
    if (lineStart === 0) break
    end = lineStart - 1
  }
  return documentation.length === 0 ? undefined : documentation.join('  \n')
}

function completionDocumentation(context, item) {
  if (item.documentation !== undefined) return item.documentation
  const nativeSummary = GALAXY_NATIVE_API_SUMMARIES[item.label]
  if (nativeSummary !== undefined) return nativeSummary
  const definition = context.index.uniqueDefinitionByName(item.label, context.key)
  if (definition === undefined) return undefined
  const file = context.index.getFile(definition.fileName)
  return file === undefined ? undefined : precedingDocumentation(file.code, definition.symbol.start)
}

function includeCompletion(context, request) {
  const match = /\binclude\s+"([^"\r\n]*)$/u.exec(
    context.document.text.slice(0, context.offset),
  )
  if (match === null) return undefined
  const query = match[1].replace(/\\/gu, '/')
  const slash = query.lastIndexOf('/')
  const directory = slash < 0 ? '' : query.slice(0, slash + 1)
  const prefix = query.slice(slash + 1).toLocaleLowerCase()
  const seen = new Set()
  const items = []
  for (const document of context.byUri.values()) {
    if (document.languageId !== 'galaxy' || document.uri === context.document.uri) continue
    let pathname
    try {
      pathname = decodeURIComponent(new URL(document.uri).pathname).replace(/\\/gu, '/')
    } catch {
      pathname = document.uri.replace(/\\/gu, '/')
    }
    const withoutExtension = pathname.replace(/\.galaxy$/iu, '')
    let candidate
    if (directory) {
      const marker = `/${directory}`.toLocaleLowerCase()
      const at = withoutExtension.toLocaleLowerCase().lastIndexOf(marker)
      if (at < 0) continue
      candidate = withoutExtension.slice(at + marker.length).split('/')[0]
    } else {
      candidate = withoutExtension.split('/').at(-1)
    }
    if (!candidate || !candidate.toLocaleLowerCase().startsWith(prefix) || seen.has(candidate))
      continue
    seen.add(candidate)
    items.push({
      label: candidate,
      kind: 'module',
      detail: document.uri,
      insertText: candidate,
      sortText: `00:${candidate.toLocaleLowerCase()}`,
    })
  }
  const result = bounded(items, request)
  return Object.freeze({
    items: result.items,
    isIncomplete: result.isIncomplete,
  })
}

function triggerHandlerCompletion(context, request) {
  const match = /\b(?:TriggerCreate|TriggerFind)\s*\(\s*"([A-Za-z_]\w*)?$/u.exec(
    context.document.text.slice(0, context.offset),
  )
  if (match === null) return undefined
  const prefix = (match[1] ?? '').toLocaleLowerCase()
  const seen = new Set()
  const items = []
  for (const file of context.index.listFiles()) {
    for (const { symbol } of flattenSymbols(file.index.symbols)) {
      if (
        symbol.kind !== 'function' ||
        symbol.parameters?.length !== 2 ||
        symbol.parameters.some(parameter => parameter.type !== 'bool') ||
        !/^bool\s/u.test(symbol.detail ?? '') ||
        (file.fileName !== context.key && isFileLocalSymbol(file, symbol)) ||
        !symbol.name.toLocaleLowerCase().startsWith(prefix) ||
        seen.has(symbol.name)
      ) continue
      seen.add(symbol.name)
      items.push({
        label: symbol.name,
        kind: 'function',
        detail: symbol.detail,
        insertText: symbol.name,
        sortText: `00:${symbol.name.toLocaleLowerCase()}`,
      })
    }
  }
  const result = bounded(items, request)
  return Object.freeze({
    items: result.items,
    isIncomplete: result.isIncomplete,
  })
}

function propertyCompletion(context, request) {
  const match = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)?$/u.exec(
    context.document.text.slice(0, context.offset),
  )
  if (match === null) return undefined
  const variableName = match[1]
  const prefix = (match[2] ?? '').toLocaleLowerCase()
  const scope = localDeclarations(context)
  const local = scope?.declarations
    .filter(
      declaration =>
        declaration.name?.name === variableName && declaration.name.pos <= context.offset,
    )
    .sort((left, right) => right.name.pos - left.name.pos)[0]
  let typeName =
    local === undefined
      ? undefined
      : context.document.text.slice(local.type.pos, local.type.end).trim()
  if (typeName === undefined) {
    const variable = context.index.uniqueDefinitionByName(variableName, context.key)
      ?.symbol
    if (variable?.kind === 'variable') typeName = variable.detail
  }
  if (!typeName) return Object.freeze({ items: Object.freeze([]), isIncomplete: false })
  const declared = context.index.uniqueDefinitionByName(typeName, context.key)?.symbol
  const structure = declared?.kind === 'struct' ? declared : undefined
  if (structure === undefined)
    return Object.freeze({ items: Object.freeze([]), isIncomplete: false })
  const items = (structure.children ?? [])
    .filter(
      member =>
        member.kind === 'property' && member.name.toLocaleLowerCase().startsWith(prefix),
    )
    .map(member =>
      Object.freeze({
        label: member.name,
        kind: 'property',
        detail: member.detail,
        insertText: member.name,
        sortText: `00:${member.name.toLocaleLowerCase()}`,
      }),
    )
  const result = bounded(items, request)
  return Object.freeze({ items: result.items, isIncomplete: result.isIncomplete })
}

function protocolSymbol(document, symbol) {
  return Object.freeze({
    name: symbol.name,
    kind: symbolKind(symbol.kind),
    ...(symbol.detail ? { detail: symbol.detail } : {}),
    range: rangeAt(document, symbol.start, symbol.end),
    selectionRange: rangeAt(document, symbol.selection.start, symbol.selection.end),
    ...(symbol.children?.length
      ? { children: Object.freeze(symbol.children.map(child => protocolSymbol(document, child))) }
      : {}),
  })
}

function boundedProtocolSymbols(document, symbols, maximum) {
  let count = 0
  let incomplete = false
  const convert = symbol => {
    if (count >= maximum) {
      incomplete = true
      return undefined
    }
    count += 1
    const children = []
    for (const child of symbol.children ?? []) {
      const converted = convert(child)
      if (converted !== undefined) children.push(converted)
    }
    return Object.freeze({
      name: symbol.name,
      kind: symbolKind(symbol.kind),
      ...(symbol.detail ? { detail: symbol.detail } : {}),
      range: rangeAt(document, symbol.start, symbol.end),
      selectionRange: rangeAt(document, symbol.selection.start, symbol.selection.end),
      ...(children.length ? { children: Object.freeze(children) } : {}),
    })
  }
  const result = []
  for (const symbol of symbols) {
    const converted = convert(symbol)
    if (converted !== undefined) result.push(converted)
  }
  return { symbols: Object.freeze(result), incomplete }
}

function flattenSymbols(symbols, containerName) {
  const out = []
  for (const symbol of symbols) {
    out.push({ symbol, containerName })
    out.push(...flattenSymbols(symbol.children ?? [], symbol.name))
  }
  return out
}

function isFileLocalSymbol(file, symbol) {
  return /\bstatic\b/u.test(file.code.slice(symbol.start, symbol.selection.start))
}

function localDeclarations(context) {
  const fn = context.file.index.sourceFile.statements.find(
    statement =>
      statement.kind === SyntaxKind.FunctionDeclaration &&
      statement.pos <= context.offset &&
      statement.end >= context.offset,
  )
  if (fn === undefined) return undefined
  const declarations = [...(fn.parameters ?? [])]
  const visit = node => {
    if (node.kind === SyntaxKind.VariableDeclaration && node.pos <= context.offset) {
      declarations.push(node)
    }
    forEachChild(node, child => {
      visit(child)
      return undefined
    })
  }
  if (fn.body !== undefined) visit(fn.body)
  return { fn, declarations }
}

function localDefinition(context) {
  const word = galaxyWordAt(context.document.text, context.offset)
  if (word === undefined) return undefined
  const scope = localDeclarations(context)
  if (scope === undefined) return undefined
  const declaration = scope.declarations
    .filter(candidate => candidate.name?.name === word.name && candidate.name.pos <= context.offset)
    .sort((left, right) => right.name.pos - left.name.pos)[0]
  if (declaration === undefined) return undefined
  return {
    name: word.name,
    start: declaration.name.pos,
    end: declaration.name.end,
    rangeStart: word.start,
    rangeEnd: word.end,
    scopeStart: scope.fn.pos,
    scopeEnd: scope.fn.end,
    kind: declaration.kind === SyntaxKind.ParameterDeclaration ? 'parameter' : 'variable',
    detail: `${context.document.text.slice(declaration.type.pos, declaration.type.end).trim()} ${word.name}`,
  }
}

function localReferences(context, local) {
  const source = context.document.text.slice(local.scopeStart, local.scopeEnd)
  const matcher = new RegExp(`\\b${escapeRegExp(local.name)}\\b`, 'gu')
  return [...source.matchAll(matcher)].map(match => ({
    fileName: context.document.uri,
    start: local.scopeStart + (match.index ?? 0),
    end: local.scopeStart + (match.index ?? 0) + local.name.length,
  }))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function escapeMarkdownText(value) {
  return value.replace(/[\\`*_{}[\]<>#+.!|()-]/gu, '\\$&')
}

function semanticDiagnostic(document, item) {
  return Object.freeze({
    range: rangeAt(document, item.start, item.end),
    severity: item.severity === 'info' ? 'information' : item.severity,
    message: item.message,
    code: 'galaxy/semantic',
    source: 'galaxy',
  })
}

async function semanticContext(request, positioned = false) {
  assertRequest(request, positioned)
  const byUri = new Map()
  let totalChars = 0
  for (const document of request.workspaceDocuments) {
    if (document.languageId !== 'galaxy') continue
    if (byUri.has(document.uri)) throw new TypeError(`Duplicate Galaxy document ${document.uri}`)
    if (document.text.length > MAX_DOCUMENT_CHARS) {
      throw new RangeError(`Galaxy document ${document.uri} exceeds the semantic size bound`)
    }
    totalChars += document.text.length
    if (totalChars > MAX_WORKSPACE_CHARS) {
      throw new RangeError('Galaxy workspace snapshot exceeds the semantic size bound')
    }
    byUri.set(document.uri, document)
  }
  if (!byUri.has(request.document.uri)) {
    throw new TypeError('Primary Galaxy document is absent from its bounded workspace snapshot')
  }
  const index = new GalaxyWorkspaceIndex()
  for (const document of byUri.values()) {
    await checkpoint(request.signal)
    index.updateFile(document.uri, document.text)
  }
  index.addAnalyzedFile(nativeIndexedFile)
  request.signal?.throwIfAborted()
  const file = index.getFile(request.document.uri)
  if (file === undefined) throw new TypeError('Primary Galaxy document is absent from its snapshot')
  let crossLinks
  return {
    index,
    // Symbols and local answers do not need the catalog graph of every dependency.
    get crossLinks() {
      return (crossLinks ??= createSc2WorkspaceLinkIndex(request))
    },
    get crossLinksAtPosition() {
      return positioned && hasSc2CatalogLinkAt(request.document, this.offset)
        ? this.crossLinks
        : undefined
    },
    byUri,
    file,
    document: request.document,
    // The index names files by URI here; the loaded mod's server names them by layer and path.
    key: request.document.uri,
    editableDocumentUris:
      request.editableDocumentUris === undefined
        ? undefined
        : new Set(request.editableDocumentUris),
    ...(positioned ? { offset: offsetAt(request.document, request.position) } : {}),
  }
}

/**
 * The positioned context of one file of a retained index (the loaded mod's server): `key` is the
 * file's index key, `document` its text under the URI the asking editor uses. It has no other
 * workspace documents and no catalog links; positions that need them stay on the snapshot
 * (`galaxyServedFeatureApplies`).
 */
export function galaxyIndexedContext(index, key, document, offset) {
  const file = index.getFile(key)
  if (file === undefined) throw new TypeError('Galaxy document is absent from its index')
  return { index, byUri: new Map(), file, document, key, offset, crossLinksAtPosition: undefined }
}

/**
 * A snapshot past the semantic bounds is answered, not refused (plan 2.14). Galaxy documents that do
 * not fit are left out and the workspace counts as incomplete — results say they may miss something,
 * rename refuses; an open document too large to analyse gets `empty`.
 */
export function withinSemanticBounds(handler, empty) {
  return async request => {
    if (request.document?.text.length > MAX_DOCUMENT_CHARS) return empty(request)
    let total = request.document?.text.length ?? 0
    const kept = request.workspaceDocuments.filter(document => {
      if (document.languageId !== 'galaxy' || document.uri === request.document?.uri) return true
      if (document.text.length > MAX_DOCUMENT_CHARS || total + document.text.length > MAX_WORKSPACE_CHARS)
        return false
      total += document.text.length
      return true
    })
    if (kept.length === request.workspaceDocuments.length) return handler(request)
    const uris = new Set(kept.map(document => document.uri))
    return handler({
      ...request,
      workspaceDocuments: kept,
      workspaceIncomplete: true,
      ...(request.workspaceContext === undefined
        ? {}
        : { workspaceContext: { ...request.workspaceContext, semanticComplete: false } }),
      ...(request.editableDocumentUris === undefined
        ? {}
        : { editableDocumentUris: request.editableDocumentUris.filter(uri => uris.has(uri)) }),
    })
  }
}

/** The answer for an open document past the bound: nothing, said once as a diagnostic. */
export const oversizedDiagnostics = request =>
  Object.freeze({
    diagnostics: Object.freeze([
      semanticDiagnostic(request.document, {
        start: 0,
        end: 0,
        severity: 'info',
        message: `Galaxy file is larger than ${MAX_DOCUMENT_CHARS / 1024 / 1024} MiB: definitions, references and completion are off for it`,
      }),
    ]),
    isIncomplete: true,
  })

const isEditable = (context, uri) =>
  context.editableDocumentUris === undefined || context.editableDocumentUris.has(uri)

function bounded(items, request) {
  return {
    items: Object.freeze(items.slice(0, request.maxResults)),
    isIncomplete:
      languageWorkspaceIsSemanticallyIncomplete(request) || items.length > request.maxResults,
  }
}

export async function analyzeGalaxySemanticDocument(document, signal) {
  // Too large to analyse: the caller keeps its lexical tokens and symbols (plan 2.14).
  if (document.text.length > MAX_DOCUMENT_CHARS) return undefined
  await checkpoint(signal)
  const index = analyzeGalaxyLanguage(document.text, document.uri)
  signal?.throwIfAborted()
  return Object.freeze({
    diagnostics: Object.freeze(index.diagnostics.map(item => semanticDiagnostic(document, item))),
    symbols: Object.freeze(index.symbols.map(symbol => protocolSymbol(document, symbol))),
  })
}

export async function galaxyCompletion(request, modContexts) {
  const served = await askServer(request, modContexts, 'galaxy.completion', {
    maxResults: request.maxResults,
    ...(request.functionExpand === undefined ? {} : { functionExpand: request.functionExpand }),
  })
  if (served !== undefined) {
    return Object.freeze({
      items: Object.freeze(served.completion.items.map(Object.freeze)),
      isIncomplete: served.completion.isIncomplete || served.incomplete === true ||
        languageWorkspaceIsSemanticallyIncomplete(request),
    })
  }
  return galaxyCompletionIn(await semanticContext(request, true), request)
}

/**
 * Completion at a positioned context: an include path, a trigger handler, a struct member, a catalog
 * link, then the local scope, the snippets and the index's symbols. `request` gives the bound
 * (`maxResults`) and `functionExpand`; the loaded mod's server answers through it over its retained
 * index (`served-references.js`), where includes and catalog links stay on the snapshot.
 */
export function galaxyCompletionIn(context, request) {
  const include = includeCompletion(context, request)
  if (include !== undefined) return include
  const handlers = triggerHandlerCompletion(context, request)
  if (handlers !== undefined) return handlers
  const properties = propertyCompletion(context, request)
  if (properties !== undefined) return properties
  const crossLinks = context.crossLinksAtPosition
  const catalog = crossLinks?.completionsAt(context.document.uri, context.offset)
  if (catalog !== undefined) {
    const result = bounded(catalog.items, request)
    return Object.freeze({
      items: result.items,
      isIncomplete: result.isIncomplete || crossLinks.isIncomplete,
    })
  }
  const local = galaxyCompletionsAt(context.document.text, context.offset, context.document.uri)
  const all = [...local, ...GALAXY_SNIPPETS]
  const scope = localDeclarations(context)
  for (const declaration of scope?.declarations ?? []) {
    const name = declaration.name?.name
    if (!name || declaration.name.pos > context.offset) continue
    all.push({
      label: name,
      kind: declaration.kind === SyntaxKind.ParameterDeclaration ? 'parameter' : 'variable',
      detail: `${context.document.text.slice(declaration.type.pos, declaration.type.end).trim()} ${name}`,
      insertText: name,
      sortText: `05:${name.toLocaleLowerCase()}`,
    })
  }
  for (const file of context.index.listFiles()) {
    if (file.fileName === context.key) continue
    for (const { symbol } of flattenSymbols(file.index.symbols)) {
      if (isFileLocalSymbol(file, symbol)) continue
      all.push({
        label: symbol.name,
        kind: symbol.kind,
        detail: symbol.detail,
        insertText: symbol.kind === 'function' ? `${symbol.name}($0)` : symbol.name,
        sortText: `${file.fileName === GALAXY_NATIVE_API_URI ? '80' : '10'}:${symbol.name.toLocaleLowerCase()}`,
      })
    }
  }
  const seen = new Set()
  const word = galaxyWordAt(context.document.text, context.offset)
  const prefix =
    word === undefined || word.start === context.offset
      ? undefined
      : context.document.text.slice(word.start, context.offset)
  const candidates =
    prefix === undefined
      ? all
      : all.filter(item => item.label.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))
  const items = candidates
    .filter(item => {
      const key = `${item.kind}:${item.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(item => {
      const insertText = configuredFunctionInsertText(item, request)
      const documentation = completionDocumentation(context, item)
      return Object.freeze({
        label: item.label,
        kind: completionKind(item.kind),
        ...(item.detail ? { detail: item.detail } : {}),
        ...(documentation === undefined ? {} : { documentation }),
        ...(insertText
          ? {
              insertText,
              insertTextFormat: insertText.includes('$') ? 'snippet' : 'plain-text',
            }
          : {}),
        ...(item.sortText ? { sortText: item.sortText } : {}),
      })
    })
    .sort((left, right) =>
      (left.sortText ?? `90:${left.label}`).localeCompare(right.sortText ?? `90:${right.label}`),
    )
  const result = bounded(items, request)
  return Object.freeze({ items: result.items, isIncomplete: result.isIncomplete })
}

export async function galaxyFormatting(request) {
  assertRequest(request)
  const options = request.options
  if (
    options === null ||
    typeof options !== 'object' ||
    !Number.isSafeInteger(options.tabSize) ||
    options.tabSize < 1 ||
    options.tabSize > 8 ||
    typeof options.insertSpaces !== 'boolean' ||
    (options.finalNewline !== undefined && typeof options.finalNewline !== 'boolean')
  ) {
    throw new RangeError('Galaxy formatting options are invalid')
  }
  await checkpoint(request.signal)
  const formatted = formatGalaxySource(request.document.text, options)
  request.signal?.throwIfAborted()
  return Object.freeze({
    edits: Object.freeze(
      formatted === request.document.text
        ? []
        : [
            Object.freeze({
              range: rangeAt(request.document, 0, request.document.text.length),
              newText: formatted,
            }),
          ],
    ),
    isComplete: true,
  })
}

/**
 * `receiver.member`: the struct member a field access names, found through the receiver's declared
 * type. Simple identifier receivers only.
 * ponytail: `a[i].x` and `f().x` receivers are not resolved; use the type checker if they matter.
 */
function memberDefinition(context) {
  const text = context.document.text
  const word = galaxyWordAt(text, context.offset)
  if (word === undefined || text[word.start - 1] !== '.') return undefined
  const receiver = text.slice(0, word.start - 1).match(/([A-Za-z_]\w*)\s*$/u)?.[1]
  if (receiver === undefined) return undefined
  const scope = localDeclarations(context)
  const local = scope?.declarations
    .filter(candidate => candidate.name?.name === receiver && candidate.name.pos <= context.offset)
    .sort((left, right) => right.name.pos - left.name.pos)[0]
  const typeName = (
    local !== undefined
      ? text.slice(local.type.pos, local.type.end)
      : context.index.uniqueDefinitionByName(receiver, context.key)?.symbol.detail
  )?.trim()
  if (typeName === undefined) return undefined
  const struct = context.index.uniqueDefinitionByName(typeName, context.key)?.symbol
  if (struct?.kind !== 'struct') return undefined
  const member = struct.children?.find(child => child.name === word.name)
  return member === undefined ? undefined : { member, word }
}

/**
 * Hover at a caret. With a `modContexts` port and a request that names its document's place in a
 * loaded mod, the mod's server answers from its retained index (`served-references.js`) by the same
 * `galaxyHoverIn`; otherwise the request's snapshot is indexed.
 */
export async function galaxyHover(request, modContexts) {
  const served = await askServer(request, modContexts, 'galaxy.hover')
  if (served !== undefined) return served.hover ?? undefined
  return galaxyHoverIn(await semanticContext(request, true))
}

/** Hover of a positioned context: struct member, scoped local, the file itself, catalog link, index. */
export function galaxyHoverIn(context) {
  const field = memberDefinition(context)
  if (field !== undefined) {
    return Object.freeze({
      markdown: galaxySymbolHoverMarkdown(field.member),
      range: rangeAt(context.document, field.word.start, field.word.end),
    })
  }
  const scoped = localDefinition(context)
  if (scoped !== undefined) {
    return Object.freeze({
      markdown: `\`\`\`galaxy\n${scoped.detail}\n\`\`\``,
      range: rangeAt(context.document, scoped.rangeStart, scoped.rangeEnd),
    })
  }
  const local = galaxyHoverAt(context.document.text, context.offset, context.document.uri)
  if (local !== undefined) {
    return Object.freeze({
      markdown: local.markdown,
      range: rangeAt(context.document, local.range.start, local.range.end),
    })
  }
  const crossLinks = context.crossLinksAtPosition
  const cross = crossLinks?.hoverAt(context.document.uri, context.offset)
  if (cross !== undefined) {
    const reference = crossLinks.references.find(
      item =>
        item.uri === context.document.uri &&
        item.start <= context.offset &&
        context.offset <= item.end,
    )
    return Object.freeze({
      ...cross,
      ...(reference === undefined
        ? {}
        : { range: rangeAt(context.document, reference.start, reference.end) }),
    })
  }
  const definition = context.index.definitionAt(context.key, context.offset)
  if (definition === undefined) return undefined
  const word = galaxyWordAt(context.document.text, context.offset)
  if (word === undefined) return undefined
  const nativeSummary = GALAXY_NATIVE_API_SUMMARIES[definition.symbol.name]
  return Object.freeze({
    markdown:
      (definition.symbol.detail === undefined
        ? `\`\`\`galaxy\n${definition.symbol.kind} ${definition.symbol.name}\n\`\`\``
        : galaxySymbolHoverMarkdown(definition.symbol)) +
      (nativeSummary === undefined ? '' : `\n\n${escapeMarkdownText(nativeSummary)}`),
    range: rangeAt(context.document, word.start, word.end),
    ...(nativeSummary === undefined ? {} : { provenance: GALAXY_NATIVE_API_PROVENANCE }),
  })
}

/** Signature help at a caret, from the loaded mod's server like `galaxyHover` or from the snapshot. */
export async function galaxySignatureHelp(request, modContexts) {
  const served = await askServer(request, modContexts, 'galaxy.signature-help')
  if (served !== undefined) return served.signatureHelp ?? undefined
  return galaxySignatureHelpIn(await semanticContext(request, true))
}

/** Signature help of a positioned context: the file's own call, else a function of the index. */
export function galaxySignatureHelpIn(context) {
  let signature = galaxySignatureAt(context.document.text, context.offset, context.document.uri)
  if (signature === undefined) {
    const callName = context.document.text
      .slice(0, context.offset)
      .match(/([A-Za-z_]\w*)\s*\([^()]*$/u)?.[1]
    const declared = callName
      ? context.index.uniqueDefinitionByName(callName, context.key)?.symbol
      : undefined
    const functionDefinition = declared?.kind === 'function' ? declared : undefined
    if (functionDefinition !== undefined) {
      const parameters = functionDefinition.parameters ?? []
      const callStart = context.document.text.lastIndexOf('(', context.offset)
      const argumentsText = context.document.text.slice(callStart + 1, context.offset)
      const activeParameter = Math.min(
        (argumentsText.match(/,/gu) ?? []).length,
        Math.max(0, parameters.length - 1),
      )
      signature = {
        label: functionDefinition.detail,
        activeParameter,
        parameters,
      }
    }
  }
  if (signature === undefined) return undefined
  return Object.freeze({
    signatures: Object.freeze([
      Object.freeze({
        label: signature.label,
        parameters: Object.freeze(
          signature.parameters.map(parameter =>
            Object.freeze({ label: `${parameter.type} ${parameter.name}` }),
          ),
        ),
      }),
    ]),
    activeSignature: 0,
    activeParameter: signature.activeParameter,
  })
}

/**
 * `include "TriggerLibs/MeleeBuildAI"` names a workspace file without its extension; the quoted path
 * is the only thing under the cursor there, so definition resolves it to the file itself.
 */
function includeTargetAt(context) {
  for (const statement of context.file.index.sourceFile.statements) {
    if (statement.kind !== SyntaxKind.IncludeStatement) continue
    const start = statement.path.pos + 1
    const end = statement.path.end - 1
    if (context.offset < start || context.offset > end) continue
    const wanted = normalizeGalaxyIncludeIdentity(statement.path.value)
    const targets = [...context.byUri.keys()].filter(uri => {
      let path
      try { path = new URL(uri).pathname } catch { path = uri }
      const identity = normalizeGalaxyIncludeIdentity(path)
      return identity === wanted || identity.endsWith(`/${wanted}`)
    })
    return targets.length === 1 ? targets[0] : undefined
  }
  return undefined
}

/**
 * Definition at a caret, from the loaded mod's server like `galaxyHover` (it names files by layer
 * and path, the host gives their URIs) or from the snapshot.
 */
export async function galaxyDefinition(request, modContexts) {
  const key = await stringKeyLocationsAt(request, modContexts, { definitions: true, uses: false })
  if (key !== undefined) return key
  const served = await askServer(request, modContexts, 'galaxy.definition')
  if (served !== undefined) {
    const uris = served.documents.map(item => item.uri)
    const locations = served.definitions.map(item => {
      const uri = uris[item.document]
      if (typeof uri !== 'string') throw new TypeError('galaxy.definition named a document without a URI')
      return Object.freeze({ uri, range: item.range })
    })
    return Object.freeze({
      locations: Object.freeze(locations),
      isIncomplete: served.semantic === true && (served.incomplete === true || languageWorkspaceIsSemanticallyIncomplete(request)),
    })
  }
  const context = await semanticContext(request, true)
  const targets = galaxyDefinitionIn(context)
  if (targets.cross !== undefined) {
    return Object.freeze({ locations: Object.freeze([targets.cross]), isIncomplete: targets.crossIncomplete })
  }
  return Object.freeze({
    locations: Object.freeze(
      targets.definitions.map(item =>
        Object.freeze({
          uri: item.fileName,
          range: rangeAt(context.byUri.get(item.fileName) ?? nativeDocument, item.start, item.end),
        }),
      ),
    ),
    isIncomplete: targets.semantic && languageWorkspaceIsSemanticallyIncomplete(request),
  })
}

/**
 * Definition targets of a positioned context, by index key and offsets: an include's file, a scoped
 * local, a catalog link (`cross`, already a location) or the index's declaration. `semantic` says
 * the answer came from the index, whose completeness the workspace decides.
 */
export function galaxyDefinitionIn(context) {
  const included = includeTargetAt(context)
  if (included !== undefined) return { definitions: [{ fileName: included, start: 0, end: 0 }], semantic: false }
  const scoped = localDefinition(context)
  if (scoped !== undefined) {
    return { definitions: [{ fileName: context.key, start: scoped.start, end: scoped.end }], semantic: false }
  }
  const crossLinks = context.crossLinksAtPosition
  const crossDefinition = crossLinks?.definitionAt(context.document.uri, context.offset)
  if (crossDefinition !== undefined) {
    return { definitions: [], semantic: false, cross: crossDefinition, crossIncomplete: crossLinks.isIncomplete }
  }
  const definition = context.index.definitionAt(context.key, context.offset)
  // The bundled native API is a catalog for hover and completion, not a document anyone can open:
  // a native leads to the real `TriggerLibs/natives.galaxy` of the chain, which the index prefers
  // whenever the snapshot holds it, and to nothing when it does not (plan 2.1).
  return {
    definitions:
      definition === undefined || definition.fileName === GALAXY_NATIVE_API_URI
        ? []
        : [{ fileName: definition.fileName, start: definition.start, end: definition.end }],
    semantic: true,
  }
}

/**
 * Ask the loaded mod's server a positioned Galaxy question about the request's document, when the
 * request reads one (an opted-in feature with a `modContexts` port and the document's place); the
 * answer must be of the revision the request was synchronized at. Undefined: use the snapshot.
 */
/**
 * A GameStrings key a script names by literal (`StringExternal("Key")`): its definitions or uses come
 * from the Strings owner — the loaded mod's server when the request names its place, else the
 * snapshot's catalogs, layouts and scripts. Undefined when the caret is on no such literal.
 */
async function stringKeyLocationsAt(request, modContexts, mode) {
  if (stringKeyUnder(request.document, request.position) === undefined) return undefined
  const served = request.workspaceContext?.modContext
  if (modContexts !== undefined && served?.document !== undefined)
    return stringsServedLocations(request, modContexts, served, mode)
  return mode.uses ? stringsReferences(request) : stringsDefinition(request)
}

async function askServer(request, modContexts, kind, extra = {}) {
  const served = request.workspaceContext?.modContext
  if (modContexts === undefined || served?.document === undefined) return undefined
  assertRequest(request, true)
  const answer = await modContexts.query(served.scope, {
    kind,
    document: { layerId: served.document.layerId, path: served.document.path },
    uri: request.document.uri,
    offset: offsetAt(request.document, request.position),
    ...extra,
  }, request.signal)
  if (answer?.revision !== served.revision) throw new Error(`${kind} answered another revision`)
  return answer
}

/**
 * References of the declaration at the caret. Scoped locals come from the live document and catalog
 * links from the mixed workspace; the rest, with a `modContexts` port and a request that names its
 * document's place in a loaded mod, comes from that mod's server (`served-references.js`), which
 * holds the chain's scripts, instead of from an index over the request's snapshot.
 */
export async function galaxyReferences(request, modContexts) {
  const key = await stringKeyLocationsAt(request, modContexts, {
    definitions: request.includeDeclaration === true,
    uses: true,
  })
  if (key !== undefined) return key
  const context = await semanticContext(request, true)
  const scoped = localDefinition(context)
  if (scoped !== undefined) {
    let scopedReferences = localReferences(context, scoped)
    if (!request.includeDeclaration) {
      scopedReferences = scopedReferences.filter(
        item => item.start !== scoped.start || item.end !== scoped.end,
      )
    }
    const scopedLocations = scopedReferences.map(item =>
      Object.freeze({
        uri: item.fileName,
        range: rangeAt(context.document, item.start, item.end),
      }),
    )
    const scopedResult = bounded(scopedLocations, request)
    return Object.freeze({
      locations: scopedResult.items,
      isIncomplete: scopedResult.isIncomplete,
    })
  }
  const crossLinks = context.crossLinksAtPosition
  const crossReferences = crossLinks?.referencesAt(
    context.document.uri,
    context.offset,
    request.includeDeclaration === true,
  ) ?? []
  if (crossReferences.length > 0) {
    const result = bounded(crossReferences, request)
    return Object.freeze({
      locations: result.items,
      isIncomplete: result.isIncomplete || crossLinks.isIncomplete,
    })
  }
  const served = request.workspaceContext?.modContext
  if (modContexts !== undefined && served?.document !== undefined) {
    const answer = await modContexts.query(served.scope, {
      kind: 'galaxy.references',
      document: { layerId: served.document.layerId, path: served.document.path },
      offset: context.offset,
      includeDeclaration: request.includeDeclaration === true,
    }, request.signal)
    if (answer?.revision !== served.revision) throw new Error('galaxy.references answered another revision')
    const uris = answer.documents.map(item => item.uri)
    const locations = sortedReferenceLocations(
      answer.references.map(item => {
        const uri = uris[item.document]
        if (typeof uri !== 'string') throw new TypeError('galaxy.references named a document without a URI')
        return { uri, start: item.start, end: item.end, range: item.range }
      }),
    )
    const result = bounded(locations, request)
    return Object.freeze({ locations: result.items, isIncomplete: result.isIncomplete || answer.incomplete === true })
  }
  const references = galaxyIndexedReferences(
    context.index,
    context.document.uri,
    context.offset,
    request.includeDeclaration === true,
  )
  const locations = sortedReferenceLocations(
    references.map(item =>
      Object.freeze({
        uri: item.fileName,
        start: item.start,
        end: item.end,
        range: rangeAt(context.byUri.get(item.fileName), item.start, item.end),
      }),
    ),
  )
  const result = bounded(locations, request)
  return Object.freeze({ locations: result.items, isIncomplete: result.isIncomplete })
}

/**
 * The workspace index's references of the declaration at a caret, the declaration itself only when
 * asked, never the bundled native API (it has no file to open). Unsorted: one caller sorts by the
 * URIs it shows, the loaded mod's server by the URIs the host gives its files.
 */
export function galaxyIndexedReferences(index, fileName, offset, includeDeclaration) {
  const definition = index.definitionAt(fileName, offset)
  let references = index.referencesAt(fileName, offset)
  if (!includeDeclaration && definition !== undefined) {
    references = references.filter(
      item =>
        item.fileName !== definition.fileName ||
        item.start !== definition.start ||
        item.end !== definition.end,
    )
  }
  return references.filter(item => item.fileName !== GALAXY_NATIVE_API_URI)
}

/** Features the loaded mod's server answers (`galaxyServedFeatureApplies` decides per position). */
export const GALAXY_SERVED_FEATURES = Object.freeze(['hover', 'signatureHelp', 'definition', 'references', 'completion', 'diagnostics'])

/**
 * Whether the loaded mod's server can answer a feature at a position: not on a catalog link, whose
 * answer needs the mixed workspace of the other languages, and not in an include's path, which
 * names a file by the snapshot's URIs. Reads the live document only.
 */
export async function galaxyServedFeatureApplies(request) {
  if (!GALAXY_SERVED_FEATURES.includes(request.feature) || request.feature === 'completion') return false
  return galaxyServedPositionApplies(request)
}

/** Completion from the loaded mod's server, where the other served features are (no include path). */
export async function galaxyServedCompletionApplies(request) {
  return galaxyServedPositionApplies(request)
}

async function galaxyServedPositionApplies(request) {
  if (request.document.text.length > MAX_DOCUMENT_CHARS) return false
  const offset = offsetAt(request.document, request.position)
  if (hasSc2CatalogLinkAt(request.document, offset)) return false
  const lineStart = request.document.text.lastIndexOf('\n', offset - 1) + 1
  return !/^\s*include\b/u.test(request.document.text.slice(lineStart, offset + 1))
}

/** Reference locations in the order references are listed: by URI, then position. */
export function sortedReferenceLocations(locations) {
  return [...locations]
    .sort(
      (left, right) =>
        left.uri.localeCompare(right.uri) || left.start - right.start || left.end - right.end,
    )
    .map(item => Object.freeze({ uri: item.uri, range: item.range }))
}

/** The bundled native API as an indexed file, shared by every workspace index of the natives. */
export { nativeIndexedFile as galaxyNativeIndexedFile, rangeAt as galaxyRangeAt }

export async function galaxyPrepareRename(request) {
  // a StringExternal literal renames the key in its catalogs, layouts and scripts
  if (stringKeyUnder(request.document, request.position) !== undefined)
    return prepareStringsRename(request.document, request.position)
  return galaxyPrepareRenameIn(await semanticContext(request, true), request)
}

/** Prepare through the same indexed context used to plan the rename. */
export function galaxyPrepareRenameIn(context, request) {
  if (!isEditable(context, context.document.uri)) return undefined
  const scoped = localDefinition(context)
  if (scoped !== undefined) {
    return Object.freeze({
      range: rangeAt(context.document, scoped.rangeStart, scoped.rangeEnd),
      placeholder: scoped.name,
    })
  }
  const crossTarget = context.crossLinks.targetAt(context.document.uri, context.offset)
  if (crossTarget !== undefined) {
    if (context.crossLinks.isIncomplete) return undefined
    const definition = context.crossLinks.definitionAt(context.document.uri, context.offset)
    if (definition === undefined || !isEditable(context, definition.uri)) return undefined
    const word = galaxyWordAt(context.document.text, context.offset)
    if (word === undefined) return undefined
    return Object.freeze({
      range: rangeAt(context.document, word.start, word.end),
      placeholder: crossTarget.entityId,
    })
  }
  if (request.workspaceIncomplete) return undefined
  const definition = context.index.definitionAt(context.key, context.offset)
  if (
    definition === undefined ||
    definition.fileName === GALAXY_NATIVE_API_URI ||
    !isEditable(context, definition.fileName)
  ) return undefined
  const range = galaxyRenameRangeAt(context.document.text, context.offset)
  if (range === undefined) return undefined
  return Object.freeze({
    range: rangeAt(context.document, range.start, range.end),
    placeholder: context.document.text.slice(range.start, range.end),
  })
}

export async function galaxyRename(request) {
  if (stringKeyUnder(request.document, request.position) !== undefined) return renameStrings(request)
  return galaxyRenameIn(await semanticContext(request, true), request)
}

/** Rename through the canonical indexed context, shared by snapshot and retained server. */
export function galaxyRenameIn(context, request) {
  if (request.newName.length > 256 || !/^[A-Za-z_]\w*$/u.test(request.newName)) return undefined
  if (!isEditable(context, context.document.uri)) return undefined
  const scoped = localDefinition(context)
  if (scoped !== undefined) {
    const scopedReferences = localReferences(context, scoped)
    if (scopedReferences.length === 0 || scopedReferences.length > request.maxEdits)
      return undefined
    return Object.freeze({
      documentChanges: Object.freeze([
        Object.freeze({
          uri: context.document.uri,
          documentVersion: context.document.version,
          edits: Object.freeze(
            scopedReferences.map(reference =>
              Object.freeze({
                range: rangeAt(context.document, reference.start, reference.end),
                newText: request.newName,
              }),
            ),
          ),
        }),
      ]),
      isComplete: true,
    })
  }
  if (context.crossLinks.targetAt(context.document.uri, context.offset) !== undefined) {
    const edit = context.crossLinks.renameAt(
      context.document.uri,
      context.offset,
      request.newName,
      request.maxEdits,
    )
    return edit?.documentChanges.every(change => isEditable(context, change.uri)) ? edit : undefined
  }
  if (request.workspaceIncomplete) return undefined
  const definition = context.index.definitionAt(context.key, context.offset)
  if (definition === undefined || definition.fileName === GALAXY_NATIVE_API_URI) return undefined
  const references = context.index.referencesAt(context.key, context.offset)
  if (references.length === 0 || references.length > request.maxEdits) return undefined
  if (references.some(reference => !isEditable(context, reference.fileName))) return undefined
  const grouped = new Map()
  for (const reference of references) {
    const document = context.byUri.get(reference.fileName)
    if (document === undefined) return undefined
    const edits = grouped.get(reference.fileName) ?? []
    edits.push(
      Object.freeze({
        range: rangeAt(document, reference.start, reference.end),
        newText: request.newName,
      }),
    )
    grouped.set(reference.fileName, edits)
  }
  return Object.freeze({
    documentChanges: Object.freeze(
      [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([uri, edits]) =>
          Object.freeze({
            uri,
            documentVersion: context.byUri.get(uri).version,
            edits: Object.freeze(edits),
          }),
        ),
    ),
    isComplete: true,
  })
}

export async function galaxyDocumentSymbols(request) {
  const context = await semanticContext(request)
  const result = boundedProtocolSymbols(
    context.document,
    context.file.index.symbols,
    request.maxResults,
  )
  return Object.freeze({
    symbols: result.symbols,
    // Missing dependency files cannot hide a declaration in this document.
    isIncomplete: result.incomplete,
  })
}

export async function galaxyWorkspaceSymbols(request) {
  const context = await semanticContext(request)
  return galaxyWorkspaceSymbolsIn(context, request)
}

/** Symbol listing over the same retained Galaxy index used for navigation and rename. */
export function galaxyWorkspaceSymbolsIn(context, request) {
  const query = request.query.trim().toLocaleLowerCase()
  const symbols = []
  for (const file of context.index.listFiles()) {
    // The bundled native API has no location to go to; the chain's natives.galaxy lists them.
    if (file.fileName === GALAXY_NATIVE_API_URI) continue
    const document = context.byUri.get(file.fileName) ?? nativeDocument
    for (const { symbol, containerName } of flattenSymbols(file.index.symbols)) {
      if (query.length > 0 && !symbol.name.toLocaleLowerCase().includes(query)) continue
      symbols.push(
        Object.freeze({
          name: symbol.name,
          kind: symbolKind(symbol.kind),
          location: Object.freeze({
            uri: file.fileName,
            range: rangeAt(document, symbol.selection.start, symbol.selection.end),
          }),
          ...(containerName ? { containerName } : {}),
          ...(symbol.detail ? { detail: symbol.detail } : {}),
        }),
      )
    }
  }
  symbols.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.location.uri.localeCompare(right.location.uri),
  )
  const result = bounded(symbols, request)
  return Object.freeze({ symbols: result.items, isIncomplete: result.isIncomplete })
}

/**
 * A call to a name no indexed file declares. The single-file checker cannot see this: it only knows
 * the file it checks, so the whole workspace index answers instead. An incomplete snapshot cannot
 * prove a name is missing, so the finding is a warning that says which snapshot it was judged against.
 */
function undeclaredCalls(context, request) {
  const items = []
  const seen = new Set()
  const visit = node => {
    if (node.kind === SyntaxKind.CallExpression && node.expression?.kind === SyntaxKind.Identifier) {
      const name = node.expression.name
      if (typeof name === 'string' && !seen.has(name + node.expression.pos)) {
        seen.add(name + node.expression.pos)
        if (context.index.definitionsByName(name, context.key).length === 0)
          items.push({
            start: node.expression.pos,
            end: node.expression.end,
            severity: languageWorkspaceIsSemanticallyIncomplete(request) ? 'warning' : 'error',
            message: languageWorkspaceIsSemanticallyIncomplete(request)
              ? `Function '${name}' was not found in the bounded workspace snapshot.`
              : `Function '${name}' is not declared.`,
          })
      }
    }
    forEachChild(node, child => {
      visit(child)
      return undefined
    })
  }
  visit(context.file.index.sourceFile)
  return items
}

export async function galaxyDiagnostics(request, modContexts) {
  const served = request.workspaceContext?.modContext
  if (modContexts !== undefined && served?.document !== undefined) {
    // The loaded mod's server holds the chain's scripts and its cross-language link index.
    const answer = await modContexts.query(served.scope, {
      kind: 'galaxy.diagnostics',
      document: { layerId: served.document.layerId, path: served.document.path },
      uri: request.document.uri,
      offset: 0,
      maxResults: request.maxResults,
      incomplete: languageWorkspaceIsSemanticallyIncomplete(request),
    }, request.signal)
    if (answer?.revision !== served.revision) throw new Error('galaxy.diagnostics answered another revision')
    return Object.freeze({
      diagnostics: Object.freeze(answer.diagnostics.diagnostics.map(Object.freeze)),
      isIncomplete: answer.diagnostics.isIncomplete || answer.incomplete === true,
    })
  }
  return galaxyDiagnosticsIn(await semanticContext(request), request)
}

/**
 * A document's diagnostics at a context: the index's own findings, calls to nothing declared and
 * the catalog literals the link index cannot resolve (under `context.linkUri`, the document's name
 * in that index). `request` gives the bound and whether the workspace is incomplete; the loaded
 * mod's server answers through it with its index and link index (`served-references.js`).
 */
export function galaxyDiagnosticsIn(context, request) {
  const diagnostics = [
    ...context.file.index.diagnostics.map(item => semanticDiagnostic(context.document, item)),
    ...undeclaredCalls(context, request).map(item => semanticDiagnostic(context.document, item)),
    ...context.crossLinks.diagnosticsFor(context.linkUri ?? context.document.uri),
  ]
  const result = bounded(diagnostics, request)
  return Object.freeze({
    diagnostics: result.items,
    isIncomplete: result.isIncomplete || context.crossLinks.diagnosticsIncomplete,
  })
}
