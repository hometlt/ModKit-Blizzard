import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import { finalNewlineCodeActions } from '../../../../shared/language/code-actions.js'
import { withServedLanguageFeatures } from '../../../../shared/language/served-feature.js'
import {
  SC2_MIXED_WORKSPACE_LANGUAGE_IDS,
  createSc2WorkspaceLinkIndex,
} from '@modkit/blizzard-starcraft2/galaxy/sc2-workspace-links'
import {
  attributeAtOffset,
  nodeAtOffset,
  offsetAt,
  parseXmlDocument,
  rangeAt,
  walkElements,
} from '../../shared/xml-document.js'
import { parseTriggerXmlSync } from '@modkit/blizzard-starcraft2/triggers/document/sax-reader.js'
import { applyTriggerStringsByType, parseTriggerStrings } from '@modkit/blizzard-starcraft2/triggers/document/trigger-strings.js'

const LANGUAGE_ID = 'sc2-triggers'
const retainedLinks = new WeakMap()

/** Execute the existing trigger feature with the mod server's canonical mixed link index. */
export async function sc2TriggersFeatureIn(request, links, feature) {
  const functions = { hover: sc2TriggersHover, completion: sc2TriggersCompletion, signatureHelp: sc2TriggersSignatureHelp,
    definition: sc2TriggersDefinition, references: sc2TriggersReferences, diagnostics: sc2TriggersDiagnostics,
    prepareRename: sc2TriggersPrepareRename, rename: sc2TriggersRename, workspaceSymbols: sc2TriggersWorkspaceSymbols,
    documentSymbols: sc2TriggersDocumentSymbols }
  if (typeof functions[feature] !== 'function') throw new TypeError('unsupported served TriggerData feature')
  retainedLinks.set(request, links)
  try { return await functions[feature](request) } finally { retainedLinks.delete(request) }
}
const BOUNDS = Object.freeze({
  maxChars: 8 * 1024 * 1024,
  maxNodes: 200_000,
  maxDepth: 256,
  maxDiagnostics: 10_000,
})
const COMPLETION_WORDS = Object.freeze([
  'TriggerData', 'TriggerLib', 'Library', 'Standard', 'Element', 'Root', 'Item',
  'Id', 'Type', 'Library', 'FunctionDef', 'FunctionCall', 'Param', 'Variable',
  'Value', 'ValueType', 'ValueGameType', 'Identifier', 'ScriptCode',
])

function assertRequest(request, positioned = false) {
  request.signal?.throwIfAborted()
  if (request.document?.languageId !== LANGUAGE_ID)
    throw new TypeError(`SC2 TriggerData provider cannot inspect ${request.document?.languageId}`)
  if (
    !Array.isArray(request.workspaceDocuments) ||
    !Number.isSafeInteger(request.maxDocuments) ||
    request.maxDocuments < 1 ||
    request.workspaceDocuments.length > request.maxDocuments ||
    !Number.isSafeInteger(request.maxResults) ||
    request.maxResults < 1
  )
    throw new RangeError('SC2 TriggerData language request bounds are invalid')
  if (positioned) offsetAt(request.document, request.position)
}

async function contextOf(request, positioned = false) {
  assertRequest(request, positioned)
  const parsed = await parseXmlDocument(request.document, BOUNDS, request.signal)
  const offset = positioned ? offsetAt(request.document, request.position) : undefined
  return {
    parsed,
    offset,
    crossLinks: retainedLinks.get(request) ?? createSc2WorkspaceLinkIndex(request),
  }
}

function xmlDiagnostic(parsed, item) {
  return Object.freeze({
    code: String(item.code).replace(/^sc2-layout/u, 'sc2-triggers'),
    message: item.message,
    severity: item.severity,
    source: 'sc2-triggers',
    range: rangeAt(parsed.starts, item.start, item.end),
  })
}

export async function analyzeSc2Triggers(request) {
  request.signal?.throwIfAborted()
  if (request.document.languageId !== LANGUAGE_ID)
    throw new TypeError(`SC2 TriggerData provider cannot analyze ${request.document.languageId}`)
  const parsed = await parseXmlDocument(request.document, BOUNDS, request.signal)
  const tokens = []
  const symbols = []
  walkElements(parsed.roots, node => {
    tokens.push(
      Object.freeze({
        kind: 'type',
        range: rangeAt(parsed.starts, node.start + 1, node.start + 1 + node.tag.length),
      }),
    )
    for (const entry of node.attributeEntries)
      tokens.push(
        Object.freeze({
          kind: entry.name === 'Id' ? 'variable' : 'string',
          range: rangeAt(parsed.starts, entry.valueStart, entry.valueEnd),
        }),
      )
    const id = node.attributeEntries.find(entry => entry.name === 'Id')
    if (id === undefined || !['Library', 'Standard', 'Element'].includes(node.tag)) return
    symbols.push(
      Object.freeze({
        name: id.value,
        kind: node.tag === 'Element' ? 'variable' : 'module',
        detail: node.tag,
        range: rangeAt(parsed.starts, node.start, node.end ?? node.openEnd),
        selectionRange: rangeAt(parsed.starts, id.valueStart, id.valueEnd),
      }),
    )
  })
  return Object.freeze({
    documentUri: request.document.uri,
    documentVersion: request.document.version,
    tokens: Object.freeze(request.include?.tokens === false ? [] : tokens),
    diagnostics: Object.freeze(
      request.include?.diagnostics === false
        ? []
        : parsed.diagnostics.map(item => xmlDiagnostic(parsed, item)),
    ),
    symbols: Object.freeze(request.include?.symbols === false ? [] : symbols),
  })
}

export async function sc2TriggersHover(request) {
  const context = await contextOf(request, true)
  const cross = context.crossLinks.hoverAt(request.document.uri, context.offset)
  if (cross === undefined) return undefined
  const reference = context.crossLinks.references.find(
    item =>
      item.uri === request.document.uri &&
      item.start <= context.offset &&
      context.offset <= item.end,
  )
  return Object.freeze({
    ...cross,
    ...(reference === undefined
      ? {}
      : { range: rangeAt(context.parsed.starts, reference.start, reference.end) }),
  })
}

export async function sc2TriggersDefinition(request) {
  const context = await contextOf(request, true)
  const definition = context.crossLinks.definitionAt(request.document.uri, context.offset)
  return Object.freeze({
    locations: Object.freeze(definition === undefined ? [] : [definition]),
    isIncomplete: context.crossLinks.isIncomplete,
  })
}

export async function sc2TriggersReferences(request) {
  const context = await contextOf(request, true)
  const locations = context.crossLinks.referencesAt(
    request.document.uri,
    context.offset,
    request.includeDeclaration === true,
  )
  return Object.freeze({
    locations: Object.freeze(locations.slice(0, request.maxResults)),
    isIncomplete: locations.length > request.maxResults || context.crossLinks.isIncomplete,
  })
}

export async function sc2TriggersDiagnostics(request) {
  const context = await contextOf(request)
  const diagnostics = [
    ...context.parsed.diagnostics.map(item => xmlDiagnostic(context.parsed, item)),
    ...context.crossLinks.diagnosticsFor(request.document.uri),
  ]
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics.slice(0, request.maxResults)),
    isIncomplete: diagnostics.length > request.maxResults || context.crossLinks.isIncomplete,
  })
}

function wordRange(document, starts, offset) {
  let start = offset
  let end = offset
  while (start > 0 && /[A-Za-z0-9_.:-]/u.test(document.text[start - 1])) start -= 1
  while (end < document.text.length && /[A-Za-z0-9_.:-]/u.test(document.text[end])) end += 1
  return rangeAt(starts, start, end)
}

export async function sc2TriggersCompletion(request) {
  const context = await contextOf(request, true)
  const catalog = context.crossLinks.completionsAt(request.document.uri, context.offset)
  if (catalog !== undefined) {
    return Object.freeze({
      items: Object.freeze(catalog.items.slice(0, request.maxResults)),
      isIncomplete:
        catalog.items.length > request.maxResults || context.crossLinks.isIncomplete,
    })
  }
  const node = nodeAtOffset(context.parsed, context.offset)
  const attribute = attributeAtOffset(node, context.offset)
  const replacementRange = wordRange(request.document, context.parsed.starts, context.offset)
  const prefix = request.document.text.slice(
    offsetAt(request.document, replacementRange.start),
    context.offset,
  ).toLocaleLowerCase()
  const candidates = COMPLETION_WORDS
    .filter(value => value.toLocaleLowerCase().startsWith(prefix))
    .slice(0, request.maxResults)
    .map(value => Object.freeze({
      label: value,
      kind: attribute === undefined ? 'keyword' : 'property',
      replacementRange,
    }))
  return Object.freeze({
    items: Object.freeze(candidates),
    isIncomplete: COMPLETION_WORDS.length > request.maxResults,
  })
}

function nodePathAt(nodes, offset, path = []) {
  for (const node of nodes) {
    const end = node.end ?? node.openEnd
    if (node.start > offset || offset > end) continue
    const next = [...path, node]
    return nodePathAt(node.children, offset, next) ?? next
  }
  return undefined
}

function triggerLibraries(request) {
  const libraries = new Map()
  const documents = [
    ...request.workspaceDocuments.filter(document =>
      document.languageId === LANGUAGE_ID && document.uri !== request.document.uri,
    ),
    request.document,
  ]
  for (const document of documents) {
    try {
      for (const [id, library] of parseTriggerXmlSync(document.text)) libraries.set(id, library)
    } catch {
      // Signature help is opportunistic while a document is being edited.
    }
  }
  return libraries
}

const parameterTypeLabel = parameter =>
  parameter?.paramType?.gameType ??
  parameter?.paramType?.variableType ??
  parameter?.paramType?.type ??
  'value'

/** Resolve a structured FunctionCall against FunctionDef/ParamDef elements in the workspace. */
export async function sc2TriggersSignatureHelp(request) {
  const context = await contextOf(request, true)
  const path = nodePathAt(context.parsed.roots, context.offset)
  const call = path?.findLast(node =>
    node.tag === 'Element' && node.attributes.Type === 'FunctionCall',
  )
  if (call === undefined) return undefined
  const definitionRef = call.children.find(node => node.tag === 'FunctionDef')
  const definitionId = definitionRef?.attributes.Id
  if (definitionId === undefined) return undefined
  const currentLibrary = path?.findLast(node =>
    node.tag === 'Library' || node.tag === 'Standard',
  )?.attributes.Id
  const libraries = triggerLibraries(request)
  const definitionLibraryId = definitionRef.attributes.Library ?? currentLibrary
  const definitionLibrary = definitionLibraryId === undefined
    ? undefined
    : libraries.get(definitionLibraryId)
  const definition = definitionLibrary?.elementsByType.FunctionDef[definitionId]
  if (definition === undefined) return undefined
  const parameters = definition.parameters.map(reference => {
    const library = libraries.get(reference.library ?? definitionLibraryId)
    const parameter = library?.elementsByType.ParamDef[reference.id]
    const name = parameter?.identifier ?? parameter?.displayName ?? reference.id
    return Object.freeze({ label: `${parameterTypeLabel(parameter)} ${name}` })
  })
  const supplied = call.children.filter(node => node.tag === 'Parameter' && node.start <= context.offset)
  const activeParameter = Math.min(
    Math.max(0, supplied.length - 1),
    Math.max(0, parameters.length - 1),
  )
  const name = definition.identifier ?? definition.displayName ?? definition.id
  const returnType = definition.returnType?.type ?? 'void'
  return Object.freeze({
    signatures: Object.freeze([
      Object.freeze({
        label: `${returnType} ${name}(${parameters.map(parameter => parameter.label).join(', ')})`,
        parameters: Object.freeze(parameters),
      }),
    ]),
    activeSignature: 0,
    activeParameter,
  })
}

export async function sc2TriggersPrepareRename(request) {
  const context = await contextOf(request, true)
  const reference = context.crossLinks.references.find(item =>
    item.uri === request.document.uri &&
    item.start <= context.offset &&
    context.offset <= item.end,
  )
  return reference === undefined
    ? undefined
    : Object.freeze({
        range: rangeAt(context.parsed.starts, reference.start, reference.end),
        placeholder: reference.entityId,
      })
}

export async function sc2TriggersRename(request) {
  const context = await contextOf(request, true)
  return context.crossLinks.renameAt(
    request.document.uri,
    context.offset,
    request.newName,
    request.maxEdits,
  )
}

const OUTLINE_KINDS = Object.freeze({
  Category: 'namespace', Trigger: 'function', FunctionDef: 'function', Variable: 'variable',
  Preset: 'enum', Structure: 'struct', Label: 'module', CustomScript: 'module',
})

/** The editor's trigger tree: each library's Root order, categories nested, named as
 *  the document names them. Elements outside the tree (calls, params) are not listed. */
function outlineSymbols(parsed, text, strings) {
  const nodes = new Map()
  // A map keeps its elements directly under <TriggerData>; the reader wants a
  // library, so give it the one the conversion service synthesizes ('Map').
  let libraries = parseTriggerXmlSync(text)
  const containers = parsed.roots.flatMap(root => root.children)
    .filter(node => ['Library', 'Standard'].includes(node.tag))
    .map(node => [node.attributes.Id, node])
  if (libraries.size === 0) {
    const root = parsed.roots.find(node => node.tag === 'TriggerData')
    if (!root) return []
    libraries = parseTriggerXmlSync(`${text.slice(0, root.openEnd)}<Standard Id="Map"/>${text.slice(root.openEnd)}`)
    containers.push(['Map', root])
  }
  for (const [libraryId, library] of containers) {
    nodes.set(`${libraryId}`, library)
    for (const node of library.children)
      if (node.tag === 'Element') nodes.set(`${libraryId}|${node.attributes.Type}|${node.attributes.Id}`, node)
  }
  const symbol = (node, name, kind, detail, children) => Object.freeze({
    name,
    kind,
    detail,
    range: rangeAt(parsed.starts, node.start, node.end ?? node.openEnd),
    selectionRange: rangeAt(parsed.starts, node.start, node.openEnd),
    ...(children.length ? { children: Object.freeze(children) } : {}),
  })
  const symbols = []
  for (const [libraryId, library] of libraries) {
    const libraryNode = nodes.get(libraryId)
    if (!libraryNode) continue
    if (strings) applyTriggerStringsByType(libraryId, library.elementsByType, strings)
    const seen = new Set()
    const items = refs => refs.flatMap(ref => {
      const libraryOfRef = ref.library || libraryId
      const key = `${libraryOfRef}|${ref.type}|${ref.id}`
      const element = library.elementsByType?.[ref.type]?.[ref.id]
      const node = nodes.get(key)
      if (libraryOfRef !== libraryId || !element || !node || seen.has(key)) return []
      seen.add(key)
      const children = ref.type === 'Category' ? items(element.items ?? []) : []
      return [symbol(node, element.displayName ?? element.name ?? element.identifier ?? ref.id, OUTLINE_KINDS[ref.type] ?? 'property', ref.type, children)]
    })
    symbols.push(symbol(libraryNode, strings?.get(`Library:${libraryId}`) ?? library.name ?? libraryId, 'module', 'Library', items(library.items ?? [])))
  }
  return symbols
}

/** The editor names triggers from the document's own TriggerStrings: the
 *  workspace copy under the same map or mod, enUS when several locales exist. */
function companionTriggerStrings(request) {
  const owner = request.document.uri.match(/^.*?\.sc2(?:map|mod)\//iu)?.[0]?.toLowerCase()
  if (!owner) return undefined
  const candidates = (request.workspaceDocuments ?? []).filter(document =>
    document.uri.toLowerCase().startsWith(owner) && /\/triggerstrings\.txt$/iu.test(document.uri))
  const chosen = candidates.find(document => /\/enus\.sc2data\//iu.test(document.uri)) ?? candidates[0]
  return chosen ? parseTriggerStrings(chosen.text) : undefined
}

export async function sc2TriggersDocumentSymbols(request) {
  request.signal?.throwIfAborted()
  const parsed = await parseXmlDocument(request.document, BOUNDS, request.signal)
  let symbols
  try {
    symbols = outlineSymbols(parsed, request.document.text, companionTriggerStrings(request))
  } catch {
    // A document the model reader rejects still gets the XML-shaped list.
    symbols = (await analyzeSc2Triggers({
      document: request.document,
      include: { tokens: false, diagnostics: false, symbols: true },
      signal: request.signal,
    })).symbols
  }
  return Object.freeze({ symbols: Object.freeze(symbols), isIncomplete: false })
}

export async function sc2TriggersWorkspaceSymbols(request) {
  assertRequest(request)
  const query = request.query.toLocaleLowerCase()
  const symbols = []
  for (const document of request.workspaceDocuments) {
    request.signal?.throwIfAborted()
    if (document.languageId !== LANGUAGE_ID) continue
    const analysis = await analyzeSc2Triggers({
      document,
      include: { tokens: false, diagnostics: false, symbols: true },
      signal: request.signal,
    })
    for (const item of analysis.symbols) {
      if (query.length > 0 && !item.name.toLocaleLowerCase().includes(query)) continue
      symbols.push(Object.freeze({
        name: item.name,
        kind: item.kind,
        location: Object.freeze({ uri: document.uri, range: item.selectionRange }),
        detail: item.detail,
      }))
      if (symbols.length >= request.maxResults) break
    }
    if (symbols.length >= request.maxResults) break
  }
  return Object.freeze({
    symbols: Object.freeze(symbols),
    isIncomplete: request.workspaceIncomplete || symbols.length >= request.maxResults,
  })
}

/** Raw-preserving formatting: only the explicitly requested final-newline policy is changed. */
export async function sc2TriggersFormatting(request) {
  assertRequest(request)
  const desired = request.options.finalNewline
  if (desired === undefined) return Object.freeze({ edits: Object.freeze([]), isComplete: true })
  const hasFinalNewline = /(?:\r?\n)$/u.test(request.document.text)
  if (desired === hasFinalNewline) {
    return Object.freeze({ edits: Object.freeze([]), isComplete: true })
  }
  const starts = rangeAt.bind(undefined, (await parseXmlDocument(request.document, BOUNDS, request.signal)).starts)
  const offset = request.document.text.length
  const edit = desired
    ? { range: starts(offset, offset), newText: '\n' }
    : {
        range: starts(request.document.text.replace(/(?:\r?\n)+$/u, '').length, offset),
        newText: '',
      }
  return Object.freeze({ edits: Object.freeze([Object.freeze(edit)]), isComplete: true })
}

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection, context) {
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1)
    throw new TypeError(
      `Unsupported SC2 TriggerData language selection ${selection.contract}@${selection.major}`,
    )
  return Object.freeze({
    value: withServedLanguageFeatures({
      contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT,
      languageIds: Object.freeze([LANGUAGE_ID]),
      workspaceLanguageIds: SC2_MIXED_WORKSPACE_LANGUAGE_IDS,
      analyze: analyzeSc2Triggers,
      completion: sc2TriggersCompletion,
      codeActions: finalNewlineCodeActions,
      hover: sc2TriggersHover,
      signatureHelp: sc2TriggersSignatureHelp,
      definition: sc2TriggersDefinition,
      references: sc2TriggersReferences,
      prepareRename: sc2TriggersPrepareRename,
      rename: sc2TriggersRename,
      formatting: sc2TriggersFormatting,
      documentSymbols: sc2TriggersDocumentSymbols,
      workspaceSymbols: sc2TriggersWorkspaceSymbols,
      diagnostics: sc2TriggersDiagnostics,
    }, context?.modContexts, ['hover', 'completion', 'signatureHelp', 'definition', 'references', 'diagnostics', 'prepareRename', 'rename', 'workspaceSymbols', 'documentSymbols'], ['formatting', 'codeActions']),
    release: async () => undefined,
  })
}
