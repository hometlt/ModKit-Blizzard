import { servedLanguageFeature } from '../../../../shared/language/served-feature.js'
import {
  LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT,
} from '@modkit/sdk/language'
import { languageWorkspaceIsSemanticallyIncomplete } from '../../../../shared/language/workspace-context.js'
import { servedRenameFeature } from '../../../../shared/language/served-rename.js'
import { servedProjectDiagnostics } from '../../../../shared/language/served-project-diagnostics.js'
import {
  mergeReferenceOccurrenceBatches,
  sc2MixedReferenceOccurrenceBatches,
} from '../../../../shared/language/typed-occurrences.js'
import { styleReferenceOccurrenceBatches } from '../../../../dist/modules/style/providers/language/src/style-names.js'
import {
  createTextStyleSheet,
  mergeTextStyleSheetsInto,
  parseFontStyles,
  resolveTextStyle,
  textStyleSampleImage,
} from '../../../../dist/modules/style/shared/font-styles.js'
import { fuzzyMatches } from '../../../../dist/shared/language/symbol-match.js'
import { finalNewlineCodeActions } from '../../../../shared/language/code-actions.js'
import { decimalColor, hexColor, parseColorLiteral } from '../../../../shared/language/sc2-colors.js'
import {
  inheritedNames,
  servedModContext,
  styleNameAt,
  styleNameDefinition,
  styleNameServable,
  styleNameServedDefinition,
  styleNamePrepareRename,
  styleNameReferences,
  styleNameServedReferences,
  styleNameRename,
} from '../../../../dist/modules/style/providers/language/src/style-names.js'
import {
  prepareStringsRename,
  renameStrings,
  stringKeyAt,
  stringsDefinition,
  stringsReferences,
  stringsServedLocations,
} from '../../../../dist/modules/strings/providers/language/src/workspace.js'
import { parseSc2Strings } from '../../../../dist/modules/strings/shared/core/text-file.js'
import {
  SC2_MIXED_WORKSPACE_LANGUAGE_IDS,
  createSc2WorkspaceLinkIndex,
  hasSc2CatalogLinkAt,
} from '@modkit/blizzard-starcraft2/galaxy/sc2-workspace-links'
import { sc2EntitySubjectId } from '@modkit/blizzard-starcraft2/language/entity-id'
import {
  SC2_LAYOUT_PROVENANCE,
  createLayoutWorkspace,
  defaultLayoutBounds,
} from '../../shared/semantic.js'
import {
  attributeAtOffset,
  lineMap,
  nodeAtOffset,
  offsetAt,
  parseXmlDocument,
  rangeAt,
  walkElements,
} from '../../shared/xml.js'
import {
  layoutFrameTypes,
  layoutBindTarget,
  layoutBoundFrameProperties,
  layoutDescPathCompletions,
  layoutEventTargets,
  layoutDescSegments,
  layoutFrameMemberSites,
  layoutFrameReferenceSegments,
  layoutFrameReferenceTargets,
  layoutReferenceSite,
  layoutFrameAbbreviationCompletions,
  layoutFrameChildCompletions,
  layoutInheritedChildNames,
  layoutSchemaColorValues,
  layoutSchemaCompletions,
  layoutSchemaFindings,
  layoutSchemaHoverInfo,
  layoutStore,
  SC2_LAYOUT_SCHEMA_REVISION,
} from '../../../../dist/modules/layout/shared/schema-index.js'

// The host's ceiling for whole-document projections (symbols, links, colours, lenses): it asks
// those with up to 65 536 results, interactive features with far fewer.
const MAX_RESULTS = 65_536
// The host owns the snapshot bound (bytes, then count); a mod holds 377 core layouts alone.
const MAX_DOCUMENTS = 4_096

function assertFeatureRequest(request, positioned = false) {
  request.signal?.throwIfAborted()
  if (request.document?.languageId !== 'sc2-layout')
    throw new TypeError(`SC2Layout provider cannot inspect ${request.document?.languageId}`)
  if (
    !Number.isSafeInteger(request.maxResults) ||
    request.maxResults < 1 ||
    request.maxResults > MAX_RESULTS
  )
    throw new RangeError('SC2Layout maxResults is invalid')
  if (
    !Number.isSafeInteger(request.maxDocuments) ||
    request.maxDocuments < 1 ||
    request.maxDocuments > MAX_DOCUMENTS ||
    request.workspaceDocuments.length > request.maxDocuments
  )
    throw new RangeError('SC2Layout maxDocuments is invalid')
  if (positioned) offsetAt(request.document, request.position)
}

/*
 * The documents bound is the request's; the parse bounds are the provider's own. A feature's result
 * ceiling limits its answer, not the shared parse: keying the parse on it re-parsed every layout of
 * the snapshot for each distinct ceiling (512, 2 048, 65 536 …) a client happened to send.
 */
const boundsFor = request => ({
  ...defaultLayoutBounds,
  maxDocuments: request.maxDocuments,
})

/*
 * The snapshot's layout workspace and schema index, built once per revision of its layouts rather
 * than on every request (parity plan 3.31: one keystroke's diagnostics, symbols, colours, tokens and
 * completion each built both, parsing every layout twice). A revision is the layouts' uris, versions
 * and lengths as a lookup hint, followed by exact text comparison; a few are kept for different mods.
 * Equal-length edits can arrive under the same source revision. The build is shared, so it runs
 * without a request's signal, and each request checks its own.
 */
const revisions = new Map()
const MAX_REVISIONS = 4

function layoutRevision(layoutDocuments, request) {
  const bounds = boundsFor(request)
  const key = JSON.stringify([bounds, layoutDocuments.map(item => [item.uri, item.version, item.text.length])])
  let held = revisions.get(key)
  revisions.delete(key)
  if (held === undefined || !held.texts.every((text, index) => text === layoutDocuments[index].text)) {
    const built = (async () => ({
      workspace: await createLayoutWorkspace(layoutDocuments, bounds),
      /*
       * The same documents, indexed against the real schema: deliberately the same `Store` the
       * codec's render and validate operations use — one index, one set of rules.
       */
      store: layoutStore(layoutDocuments.map(item => ({ uri: item.uri, text: item.text }))),
    }))()
    held = { texts: layoutDocuments.map(item => item.text), built }
    const captured = held
    built.catch(() => {
      if (revisions.get(key) === captured) revisions.delete(key)
    })
  }
  revisions.set(key, held)
  while (revisions.size > MAX_REVISIONS) revisions.delete(revisions.keys().next().value)
  return held.built
}

async function contextOf(request, positioned = false) {
  assertFeatureRequest(request, positioned)
  const documents = request.workspaceDocuments.some(item => item.uri === request.document.uri)
    ? request.workspaceDocuments
    : [request.document, ...request.workspaceDocuments]
  const layoutDocuments = documents.filter(item => item.languageId === 'sc2-layout')
  const { workspace, store } = await layoutRevision(layoutDocuments, request)
  request.signal?.throwIfAborted()
  const offset = positioned ? offsetAt(request.document, request.position) : undefined
  const context = layoutPositionedContext(workspace, store, request.document.uri, offset)
  // The mixed-language link index reads every document of the snapshot; only some features ask.
  let crossLinks
  return {
    ...context,
    get crossLinks() {
      return (crossLinks ??= createSc2WorkspaceLinkIndex(request))
    },
  }
}

/**
 * The layout, element and attribute at an offset of one document of a layout workspace and its
 * schema store: the context the snapshot and the mod server's retained layouts
 * (`served-definitions.js`) both answer from.
 */
export function layoutPositionedContext(workspace, store, uri, offset) {
  const layout = workspace.byUri.get(uri)
  if (layout === undefined)
    throw new TypeError('SC2Layout current document is missing from workspace')
  const node = offset === undefined ? undefined : nodeAtOffset(layout.parsed, offset)
  const attribute = offset === undefined ? undefined : attributeAtOffset(node, offset)
  return { workspace, layout, offset, node, attribute, store }
}

/*
 * The path of the first declaration of each declared node, per layout workspace. A workspace is
 * immutable and shared between requests of one revision, so the table is built once instead of
 * scanning every declaration for every reference (tens of thousands of each in one mod closure).
 */
const declarationPaths = new WeakMap()

function declarationPathOf(workspace, node) {
  let paths = declarationPaths.get(workspace)
  if (paths === undefined) {
    paths = new Map()
    for (const item of workspace.declarations) if (!paths.has(item.node)) paths.set(item.node, item.path)
    declarationPaths.set(workspace, paths)
  }
  return paths.get(node)
}

export async function layoutReferenceOccurrenceBatches(request) {
  const host = request.workspaceContext
  if (host === undefined) return Object.freeze([])
  const context = await contextOf(request)
  const origins = new Map(host.documentOrigins.map(origin => [origin.uri, origin]))
  return Object.freeze(context.workspace.layouts.flatMap(layout => {
    const origin = origins.get(layout.uri)
    if (origin === undefined) return []
    const occurrences = []
    for (const reference of layout.references) {
      // A frame path resolves from its own frame through the schema store, not by a unique short
      // name; the provider's own references and rename answer for it (`frameReferenceSegmentsTo`).
      if (reference.kind === 'frame') continue
      const resolved = reference.kind === 'include'
        ? context.workspace.resolveInclude(layout, reference.target)
        : reference.kind === 'constant'
          ? context.workspace.resolveConstant(layout, reference.target)
          : context.workspace.resolveFrame(layout, reference.target)
      if (resolved === undefined) continue
      const id = reference.kind === 'include'
        ? resolved.uri
        : (declarationPathOf(context.workspace, resolved.node) ?? reference.target)
      const start = reference.range.start
      const at = rangeAt(layout.parsed.starts, start, start).start
      occurrences.push(Object.freeze({
        target: Object.freeze({ owner: 'blizzard/sc2-layout', kind: `layout-${reference.kind}`, id, workspace: host.id }),
        source: Object.freeze({
          uri: layout.uri,
          sourceRevision: origin.sourceRevision,
          span: Object.freeze({ utf16Offset: start, utf16Length: reference.range.end - start, line: at.line, column: at.character }),
          origin,
        }),
        semanticPath: Object.freeze([reference.kind, id]),
        role: 'reference',
        form: 'literal',
        provenance: 'blizzard/sc2-layout',
      }))
    }
    return [Object.freeze({
      contextId: host.id,
      contextRevision: host.revision,
      semanticComplete: host.semanticComplete && !languageWorkspaceIsSemanticallyIncomplete(request),
      sourceUri: layout.uri,
      sourceRevision: origin.sourceRevision,
      occurrences: Object.freeze(occurrences),
    })]
  }))
}

function protocolRange(layout, source) {
  return rangeAt(layout.parsed.starts, source.start, source.end)
}

function selectedDeclaration(context) {
  const local = context.workspace.declarations.find(
    item =>
      item.uri === context.layout.uri &&
      item.range.start <= context.offset &&
      context.offset <= item.range.end,
  )
  if (local !== undefined) return local
  const entry = context.attribute
  if (entry === undefined) return undefined
  const value = entry.value
  if (context.node.tag === 'Include' && entry.name === 'path') {
    const target = context.workspace.resolveInclude(context.layout, value)
    if (target === undefined) return undefined
    return (
      context.workspace.declarations.find(item => item.uri === target.uri) ?? {
        kind: 'module',
        name: target.fileName,
        path: target.fileName,
        uri: target.uri,
        version: target.version,
        node: target.parsed.roots[0],
        range: { start: 0, end: Math.min(1, target.parsed.document.text.length) },
      }
    )
  }
  if (
    (context.node.tag === 'Frame' && entry.name === 'template') ||
    value.startsWith('@') ||
    value.startsWith('*@')
  ) {
    const frame = context.workspace.resolveFrame(context.layout, value)
    return frame === undefined
      ? undefined
      : context.workspace.declarations.find(item => item.node === frame.node)
  }
  if (value.startsWith('#')) {
    const constant = context.workspace.resolveConstant(context.layout, value)
    return constant === undefined
      ? undefined
      : context.workspace.declarations.find(item => item.node === constant.node)
  }
  if (entry.name === 'relative' || entry.name === 'frame') {
    // The frame the named segment under the caret reaches from this element (the last one on a handle).
    const targets = frameReferenceTargets(context, context.node, entry)
    if (targets === undefined) return undefined
    const inValue = context.offset - entry.valueStart
    const under = targets.find(item => item.start <= inValue && inValue <= item.end)
    const segment = under !== undefined && !under.text.startsWith('$') ? under : targets.at(-1)
    for (const site of segment?.sites ?? []) {
      const declared = context.workspace.declarations.find(
        item => item.kind === 'struct' && item.uri === site.uri && item.range.start === site.start,
      )
      if (declared !== undefined) return declared
    }
  }
  return undefined
}

/**
 * Each segment of a frame reference with every declaration of the frame it reaches from the
 * reference's element, through the schema store (`layoutFrameReferenceTargets`).
 */
function frameReferenceTargets(context, node, attribute) {
  const typeName = layoutSchemaHoverInfo(context.store, context.layout.uri, node.start, attribute.name)?.typeName
  return layoutFrameReferenceTargets(context.store, context.layout.uri, node.start, attribute.name, typeName, attribute.value)
}

/**
 * The segments of a frame reference that name `declaration`: their text is its name and the path
 * reaches it from the reference's own frame. A short name like `Title` belongs to many frames of
 * Core, so the text alone decides nothing. A path inside a template that reaches nothing from the
 * template itself is decided by the template's instances: it names the frame when every instance
 * reaches it, and not when none does. `'unresolved'` when a segment with that name may or may not
 * be this frame — some instances reach it and others do not (the template's text is shared), an
 * instance reaches nothing, or the game creates the template — and a rename must not guess.
 */
function frameReferenceSegmentsTo(context, reference, declaration) {
  const name = declaration.name.split('/').at(-1).toLowerCase()
  const parts = reference.target.split('/')
  const named = parts.flatMap((part, index) => (part.toLowerCase() === name ? [index] : []))
  if (named.length === 0) return undefined
  const targets = frameReferenceTargets(context, reference.node, reference.attribute)
  if (targets === undefined) return 'unresolved'
  const isDeclaration = sites => sites.some(site => site.uri === declaration.uri && site.start === declaration.range.start)
  const segments = []
  for (const index of named) {
    const target = targets[index]
    if (target === undefined) return 'unresolved'
    if (target.sites.length > 0) {
      if (isDeclaration(target.sites)) segments.push(index)
      continue
    }
    const instances = target.instances
    if (instances === undefined || !instances.complete || instances.reached.length === 0) return 'unresolved'
    const reaching = instances.reached.filter(isDeclaration).length
    if (reaching === instances.reached.length) segments.push(index)
    else if (reaching > 0) return 'unresolved'
  }
  return segments.length > 0 ? segments : undefined
}

function isReferenceTo(context, reference, declaration) {
  // @ string keys belong to Strings, even when their last segment equals a frame name.
  if (declaration.kind === 'struct' && stringKeyAt(context.layout.parsed.document,
      rangeAt(context.layout.parsed.starts, reference.range.start, reference.range.end).start)) return false
  if (declaration.kind === 'constant')
    return (
      reference.kind === 'constant' &&
      context.workspace.resolveConstant(context.layout, reference.target)?.node === declaration.node
    )
  if (declaration.kind === 'struct')
    return (
      ['template', 'alias'].includes(reference.kind) &&
      context.workspace.resolveFrame(context.layout, reference.target)?.node === declaration.node
    )
  return (
    declaration.kind === 'module' &&
    reference.kind === 'include' &&
    context.workspace.resolveInclude(context.layout, reference.target)?.uri === declaration.uri
  )
}

/**
 * Every place naming `declaration` across the workspace. A frame reference carries the indices of
 * its segments that name it; `uncertain` when a reference with the name resolves to no frame.
 */
function allReferenceLocations(context, declaration, includeDeclaration) {
  const locations = []
  let uncertain = false
  if (includeDeclaration) locations.push({ uri: declaration.uri, range: declaration.range })
  for (const layout of context.workspace.layouts) {
    const localContext = { ...context, layout }
    for (const reference of layout.references) {
      if (declaration.kind === 'struct' && reference.kind === 'frame') {
        if (stringKeyAt(layout.parsed.document, rangeAt(layout.parsed.starts, reference.range.start, reference.range.end).start))
          continue
        const segments = frameReferenceSegmentsTo(localContext, reference, declaration)
        if (segments === 'unresolved') uncertain = true
        else if (segments !== undefined) locations.push({ uri: layout.uri, range: reference.range, segments })
      } else if (isReferenceTo(localContext, reference, declaration))
        locations.push({ uri: layout.uri, range: reference.range })
    }
  }
  // A template may also be represented as a frame alias; one source span is one edit.
  return {
    locations: [...new Map(locations.map(location => [JSON.stringify([location.uri, location.range]), location])).values()],
    uncertain,
  }
}

function diagnosticItem(layout, item) {
  return Object.freeze({
    range: protocolRange(layout, item),
    severity: item.severity,
    message: item.message,
    code: item.code,
    source: 'sc2-layout',
  })
}

function workspaceDiagnostics(context) {
  const items = []
  for (const layout of context.workspace.layouts) {
    items.push(...layout.diagnostics.map(item => ({ layout, item })))
    for (const include of layout.includes)
      if (context.workspace.resolveInclude(layout, include.path) === undefined)
        items.push({
          layout,
          item: {
            code: 'sc2-layout/unresolved-include',
            message: `Include ${include.path} was not found in the bounded workspace snapshot.`,
            severity: 'warning',
            start: include.node.start,
            end: include.node.openEnd,
          },
        })
    for (const reference of layout.references) {
      // The schema checker already reports an anchor's undeclared constant; anchors are references
      // for navigation and rename, not a second diagnostic.
      if (reference.node.tag === 'Anchor') continue
      const unresolved =
        reference.kind === 'template'
          ? context.workspace.resolveFrame(layout, reference.target) === undefined
          : reference.kind === 'constant'
            ? context.workspace.resolveConstant(layout, reference.target) === undefined
            : false
      if (unresolved)
        items.push({
          layout,
          item: {
            code: `sc2-layout/unresolved-${reference.kind}`,
            message: `${reference.kind} ${reference.target} was not found in the bounded workspace snapshot.`,
            severity: 'warning',
            start: reference.range.start,
            end: reference.range.end,
          },
        })
    }
    const names = new Map()
    for (const declaration of context.workspace.declarations.filter(
      item => item.uri === layout.uri && item.kind !== 'module',
    )) {
      const key = `${declaration.kind}:${declaration.path}`.toLowerCase()
      const previous = names.get(key)
      if (previous !== undefined) {
        items.push({
          layout,
          item: {
            code: 'sc2-layout/duplicate-declaration',
            message: `Duplicate ${declaration.kind} declaration ${declaration.path}.`,
            severity: 'error',
            start: declaration.range.start,
            end: declaration.range.end,
          },
        })
      } else names.set(key, declaration)
    }
  }
  return items
}

function symbolOf(layout, declaration) {
  return Object.freeze({
    name: declaration.name,
    kind: declaration.kind,
    ...(declaration.path === declaration.name ? {} : { detail: declaration.path }),
    range: protocolRange(layout, {
      start: declaration.node.start,
      end: declaration.node.end ?? declaration.node.openEnd,
    }),
    selectionRange: protocolRange(layout, declaration.range),
  })
}

/** A symbol for an element of the layout model, selected at its `name=`. */
function nodeSymbol(layout, node, name, kind, detail, children = []) {
  const entry = node.attributeEntries.find(item => item.name.toLowerCase() === 'name')
  return Object.freeze({
    name,
    kind,
    ...(detail === undefined ? {} : { detail }),
    range: protocolRange(layout, { start: node.start, end: node.end ?? node.openEnd }),
    selectionRange: protocolRange(
      layout,
      entry === undefined ? { start: node.start, end: node.openEnd } : { start: entry.valueStart, end: entry.valueEnd },
    ),
    ...(children.length === 0 ? {} : { children: Object.freeze(children) }),
  })
}

/** The animations and state groups (with their states) a frame or a file declares (parity plan 3.26). */
function memberSymbols(layout, owner) {
  return [
    ...owner.animations.map(item => nodeSymbol(layout, item.node, item.name, 'variable', 'Animation')),
    ...owner.stateGroups.map(group =>
      nodeSymbol(
        layout,
        group.node,
        group.name,
        'enum',
        group.defaultState === undefined ? 'State group' : `State group, default ${group.defaultState}`,
        group.states.map(state => nodeSymbol(layout, state.node, state.name, 'interface', 'State')),
      ),
    ),
  ]
}

function documentSymbolsFor(context, layout) {
  const local = context.workspace.declarations.filter(
    item => item.uri === layout.uri && item.kind !== 'module',
  )
  const byNode = new Map(local.map(item => [item.node, item]))
  const frameSymbol = frame => {
    const declaration = byNode.get(frame.node)
    if (declaration === undefined) return undefined
    const children = [...memberSymbols(layout, frame), ...frame.children.map(frameSymbol).filter(Boolean)]
    const base = symbolOf(layout, declaration)
    return Object.freeze({
      ...base,
      ...(children.length === 0 ? {} : { children: Object.freeze(children) }),
    })
  }
  const frameNodes = new Set(
    layout.frames.flatMap(frame => {
      const out = []
      const visit = item => {
        out.push(item.node)
        for (const child of item.children) visit(child)
      }
      visit(frame)
      return out
    }),
  )
  return Object.freeze([
    ...local.filter(item => item.kind === 'constant' && !frameNodes.has(item.node)).map(item => symbolOf(layout, item)),
    ...memberSymbols(layout, layout),
    ...layout.frames.map(frameSymbol).filter(Boolean),
  ])
}

function frameAtOffset(layout, offset) {
  let selected
  const visit = frame => {
    const end = frame.node.end ?? frame.node.openEnd
    if (frame.node.start <= offset && offset <= end) {
      selected = frame
      for (const child of frame.children) visit(child)
    }
  }
  for (const frame of layout.frames) visit(frame)
  return selected
}

function abbreviationAt(context, request) {
  const before = request.document.text.slice(0, context.offset)
  const match = before.match(/(?:^|[>\s])([:.@/][^\s<]*)$/u)
  if (match === null) return undefined
  const phrase = match[1]
  const start = context.offset - phrase.length
  const replacementRange = rangeAt(context.layout.parsed.starts, start, context.offset)
  const frame = frameAtOffset(context.layout, context.offset)
  if (phrase.startsWith(':')) {
    const items = layoutFrameAbbreviationCompletions(frame?.type ?? 'Frame', phrase)
    return items.map(item => ({ ...item, replacementRange }))
  }
  if (phrase.startsWith('@')) {
    if (frame === undefined) return []
    return layoutFrameAbbreviationCompletions(frame.type, phrase).map(item => ({ ...item, replacementRange }))
  }
  if (phrase.startsWith('.')) {
    if (frame === undefined) return []
    // Children through the whole template chain and the unprovided hookups, from the schema index.
    const prefix = phrase.slice(1).toLocaleLowerCase()
    return (layoutFrameChildCompletions(context.store, context.layout.uri, frame.node.start) ?? [])
      .filter(item => item.label.toLocaleLowerCase().startsWith(prefix))
      .map(item => ({ ...item, replacementRange }))
  }
  if (!phrase.startsWith('/') || frame !== undefined) return []
  return layoutDescPathCompletions(context.store, phrase.slice(1)).map(item => ({ ...item, replacementRange }))
}

const NUMBER_OR_COLOR = /^(?:-?\d+(?:\.\d+)?|[\da-f]{6}(?:[\da-f]{2})?|\d{1,3}(?:,\d{1,3}){2,3})$/iu

/**
 * What an attribute value is, for the editor's colours (parity plan 3.30): `#Const` a read-only
 * variable, `@Key` and `@@Alias` a reference, a number or colour a number, and each `$handle`
 * segment of a path a keyword, the rest of the path a string. Offsets are within the value.
 */
function valueTokens(value) {
  if (value === '') return []
  const whole = kind => [{ kind, start: 0, end: value.length }]
  if (value.startsWith('#')) return [{ kind: 'variable', modifiers: Object.freeze(['readonly']), start: 0, end: value.length }]
  if (value.startsWith('@')) return whole('variable')
  if (NUMBER_OR_COLOR.test(value)) return whole('number')
  if (!value.includes('$')) return whole('string')
  const out = []
  let start = 0
  for (const segment of value.split('/')) {
    if (segment !== '') out.push({ kind: segment.startsWith('$') ? 'keyword' : 'string', start, end: start + segment.length })
    start += segment.length + 1
  }
  return out
}

export async function analyzeSc2Layout(request) {
  request.signal?.throwIfAborted()
  if (request.document.languageId !== 'sc2-layout')
    throw new TypeError(`SC2Layout provider cannot analyze ${request.document.languageId}`)
  const workspace = await createLayoutWorkspace(
    [request.document],
    defaultLayoutBounds,
    request.signal,
  )
  const layout = workspace.byUri.get(request.document.uri)
  const tokens = []
  walkElements(layout.parsed.roots, node => {
    tokens.push(
      Object.freeze({
        kind: 'type',
        range: rangeAt(layout.parsed.starts, node.start + 1, node.start + 1 + node.tag.length),
      }),
    )
    for (const entry of node.attributeEntries) {
      tokens.push(
        Object.freeze({
          kind: 'property',
          range: rangeAt(layout.parsed.starts, entry.nameStart, entry.nameEnd),
        }),
      )
      for (const token of valueTokens(entry.value))
        tokens.push(
          Object.freeze({
            ...token,
            range: rangeAt(layout.parsed.starts, entry.valueStart + token.start, entry.valueStart + token.end),
          }),
        )
    }
  })
  const analysisContext = { workspace, layout }
  return Object.freeze({
    documentUri: request.document.uri,
    documentVersion: request.document.version,
    tokens: Object.freeze(request.include?.tokens === false ? [] : tokens),
    diagnostics: Object.freeze(
      request.include?.diagnostics === false
        ? []
        : layout.diagnostics.map(item => diagnosticItem(layout, item)),
    ),
    symbols: Object.freeze(
      request.include?.symbols === false ? [] : documentSymbolsFor(analysisContext, layout),
    ),
  })
}

/**
 * Whether an attribute's value names a FontStyles style: the schema's `Style` type, and the forms
 * the style owner reads besides it (`layoutOccurrences`): `style1`/`style2` of a
 * `<Controller type="Style">` and `Style` of an `<Action type="SetProperty">`.
 */
function isStyleValue(node, attr, schema) {
  if (schema?.typeName === 'Style') return true
  const type = node?.attributes?.type?.toLowerCase()
  const name = attr.name.toLowerCase()
  return (node?.tag === 'Controller' && type === 'style' && (name === 'style1' || name === 'style2')) ||
    (node?.tag === 'Action' && type === 'setproperty' && name === 'style')
}

/** Schema types whose value names a frame or a desc. */
const FRAME_REFERENCE_TYPES = new Set(['DescTemplateName', 'DescName', 'DescInternal', 'FrameReference'])

/**
 * What a value names, for its hover (parity plan 3.22): a constant's value through its chain and
 * the file declaring it, a string key's value from the string tables among `documents`, a frame's
 * type, full name and file. `undefined` for a value that names nothing.
 */
function referenceDetail(documents, context, attr, schema) {
  const value = attr.value.trim()
  // A Style value shows a sample of the style, resolved over the sheets among `documents` (parity plan 4.1).
  if (isStyleValue(context.node, attr, schema) && value !== '' && !value.startsWith('#')) {
    const merged = createTextStyleSheet()
    for (const sheet of documents.filter(document => document.languageId === 'sc2-style'))
      mergeTextStyleSheetsInto(merged, parseFontStyles(sheet.text))
    // `@`, `@@` or `@@@` may stand before the declared name, as the style owner reads it (`layoutOccurrences`).
    const style = resolveTextStyle(merged, value.replace(/^@*/u, ''))
    return style === undefined ? `Style \`${value}\` is in no style sheet of this workspace.` : `![${value}](${textStyleSampleImage(style)})`
  }
  // A property bind and an event sent by a key or an action (parity plan 3.22).
  if (value.startsWith('{')) {
    const bind = layoutBindTarget(context.store, context.layout.uri, context.node.start, value)
    return bind === undefined
      ? undefined
      : `Binds \`${bind.property}\`${bind.type === undefined ? '' : ` (\`${bind.type}\`)`} of ${bind.frameType === undefined ? 'frame' : `\`${bind.frameType}\``} \`${bind.frame}\`.`
  }
  const events = attr.name.toLowerCase() === 'event' ? layoutEventTargets(context.store, context.layout.uri, context.node.start, value) : undefined
  if (events !== undefined)
    return events.length === 0
      ? `No animation of the target frame handles event \`${value}\`.`
      : events.map(item => `Event \`${value}\` → \`${item.action}\` in animation \`${item.animation}\`.`).join('\n\n')
  if (/^#{1,2}[^#]/u.test(value)) {
    const constant = context.workspace.resolveConstant(context.layout, value)
    if (constant === undefined) return `Constant \`${value}\` resolves to nothing in this workspace.`
    const owner = context.workspace.layouts.find(layout => layout.constants.includes(constant))
    return `Constant \`${constant.name}\`${owner === undefined ? '' : ` in \`${owner.fileName}.SC2Layout\``}: ${constantChain(context.workspace, context.layout, constant)}.`
  }
  const key = /^@{1,2}(.+)$/u.exec(value)?.[1]
  if (key !== undefined) {
    for (const document of documents) {
      if (document.languageId !== 'sc2-strings') continue
      const text = parseSc2Strings(document.text).get(key)
      if (text === undefined) continue
      const file = decodeURIComponent(document.uri).split(/[\\/]/u).slice(-2).join('/')
      return `String \`${key}\` = \`${text.length > 200 ? `${text.slice(0, 200)}…` : text}\` (${file}).`
    }
    return undefined
  }
  if (attr.name.toLowerCase() !== 'template' && !FRAME_REFERENCE_TYPES.has(schema?.typeName)) return undefined
  const frame = context.workspace.resolveFrame(context.layout, value)
  if (frame === undefined) return undefined
  const path = context.workspace.declarations.find(item => item.node === frame.node)?.path ?? frame.path
  const owner = context.workspace.layoutForFrame(frame)
  return `Frame \`${frame.type}\` \`${path}\`${owner === undefined ? '' : ` in \`${owner.fileName}.SC2Layout\``}.`
}

/**
 * The names a `template=` or `file=` value takes at the segment under the caret, from the snapshot's
 * schema index; each replaces only that segment, so accepting `Item` in `Std/It` gives `Std/Item`.
 * `file=` names another file than this one.
 */
/** The value typed up to the caret, and the range of the `/`-segment under it. */
function segmentUnderCaret(request, context, attribute) {
  const text = request.document.text
  const typed = text.slice(attribute.valueStart, context.offset)
  const folder = typed.slice(0, typed.lastIndexOf('/') + 1)
  const next = text.indexOf('/', context.offset)
  const replacementRange = rangeAt(
    context.layout.parsed.starts,
    attribute.valueStart + folder.length,
    next < 0 || next > attribute.valueEnd ? attribute.valueEnd : next,
  )
  return { typed, replacementRange }
}

function descSegmentItems(request, context, attribute, filesOnly) {
  const { typed, replacementRange } = segmentUnderCaret(request, context, attribute)
  const own = context.layout.fileName.toLowerCase()
  return layoutDescSegments(context.store, typed, filesOnly)
    .filter(item => !filesOnly || item.name.toLowerCase() !== own)
    .map(item => ({ label: item.name, kind: 'struct', detail: item.detail, replacementRange }))
}

/** A layout as an Include names it: its path under the data component (`UI/Layout/X.SC2Layout`). */
function includePathOf(uri) {
  const path = decodeURIComponent(uri).replaceAll('\\', '/')
  const data = /\.sc2data\//iu.exec(path)
  return data === null ? path.split('/').at(-1) : path.slice(data.index + data[0].length)
}

/**
 * A constant's value through the constants it names, each looked up from the file that declares
 * the naming one, as the workspace resolves them: its literal, or `#Other → ff0000` for a chain;
 * `?` where a name resolves to nothing, `…` on a cycle.
 */
function constantChain(workspace, owner, constant) {
  const steps = []
  const seen = new Set()
  let layout = workspace.layouts.find(item => item.constants.includes(constant)) ?? owner
  let value = constant.val ?? ''
  while (/^#{1,2}[^#]/u.test(value)) {
    if (seen.has(value.toLowerCase()) || steps.length >= 16) return [...steps, '…'].join(' → ')
    seen.add(value.toLowerCase())
    steps.push(value)
    const next = workspace.resolveConstant(layout, value)
    if (next === undefined) return [...steps, '?'].join(' → ')
    layout = workspace.layouts.find(item => item.constants.includes(next)) ?? layout
    value = next.val ?? ''
  }
  return [...steps, value].join(' → ')
}

/**
 * String keys for a Text, Hotkey or Image value, one path segment at a time and only after the `@`
 * (or `@@`) that makes the value a reference, as MK2 offered them. Each item replaces the segment
 * under the caret, so accepting `Title` in `@UI/Ti` gives `@UI/Title`.
 */
function stringKeySegments(request, context, attribute, stringKind) {
  const text = request.document.text
  const typed = text.slice(attribute.valueStart, context.offset)
  const marker = /^@{1,2}/u.exec(typed)?.[0]
  if (marker === undefined) return []
  const key = typed.slice(marker.length)
  const folder = key.slice(0, key.lastIndexOf('/') + 1)
  const next = text.indexOf('/', context.offset)
  const replacementRange = rangeAt(
    context.layout.parsed.starts,
    attribute.valueStart + marker.length + folder.length,
    next < 0 || next > attribute.valueEnd ? attribute.valueEnd : next,
  )
  const wanted = folder.toLowerCase()
  const segments = new Map()
  for (const document of request.workspaceDocuments) {
    if (document.languageId !== 'sc2-strings' || !stringKind.test(document.uri)) continue
    for (const line of document.text.split('\n')) {
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      const name = line.slice(0, separator).trim()
      if (!name.toLowerCase().startsWith(wanted)) continue
      const rest = name.slice(folder.length)
      const slash = rest.indexOf('/')
      const segment = slash < 0 ? rest : rest.slice(0, slash)
      const id = `${slash < 0 ? 'key' : 'folder'}:${segment.toLowerCase()}`
      if (segment === '' || segments.has(id)) continue
      const value = line.slice(separator + 1).replace(/\r$/u, '')
      segments.set(
        id,
        slash < 0
          ? // `reference` is not in the document-analysis vocabulary; one item outside it makes the
            // host reject the whole list. An Assets key names its picture for the host to draw.
            {
              label: segment,
              kind: 'text',
              detail: value,
              replacementRange,
              ...(PICTURE_PATH.test(value.trim()) ? { asset: { path: value.trim() } } : {}),
            }
          : { label: segment, kind: 'namespace', detail: `${folder}${segment}/`, insertText: `${segment}/`, replacementRange },
      )
    }
  }
  return [...segments.values()]
}

/** A picture the host can draw for a path the game spells (`Assets\Textures\ui_glue_x.dds`). */
const PICTURE_PATH = /\.(?:dds|tga|png|jpe?g)$/iu

/** The picture a value names: its own path, or the path its `@` key has in the Assets tables. */
function pictureOf(documents, value) {
  const trimmed = value.trim()
  if (PICTURE_PATH.test(trimmed)) return trimmed
  const key = /^@{1,2}(.+)$/u.exec(trimmed)?.[1]
  if (key === undefined) return undefined
  for (const document of documents) {
    if (document.languageId !== 'sc2-strings' || !/Assets/iu.test(document.uri)) continue
    const path = parseSc2Strings(document.text).get(key)?.trim()
    if (path !== undefined && PICTURE_PATH.test(path)) return path
  }
  return undefined
}

/** The entity under the caret as its card, relation graph and resolved view, by the subject id its card opens on. */
export function entityCommands(target) {
  return ['card', 'graph', 'resolved'].map(view => ({
    title: view === 'card' ? 'Card' : view === 'graph' ? 'Relation graph' : 'Resolved values',
    command: { kind: 'open-subject', subjectId: sc2EntitySubjectId(target.namespace, target.entityId), view },
  }))
}

/**
 * A child element being typed after its `<`. The parser reads `<Fr` as an element of its own, so
 * the completion belongs to the element around it; and a schema snippet brings its own `<`, which
 * MK2 added only to a tag not yet opened. Each item replaces the typed name and leaves the `<`.
 */
function typedChildElements(context, request) {
  const text = request.document.text
  const typed = /<([A-Za-z_][\w:.-]*)?$/u.exec(text.slice(0, context.offset))
  if (typed === null) return undefined
  const tagStart = typed.index
  let container
  walkElements(context.layout.parsed.roots, node => {
    if (node.openEnd <= tagStart && tagStart < (node.end ?? node.openEnd) &&
        (container === undefined || node.start >= container.start)) container = node
  })
  if (container === undefined) return undefined
  const nameEnd = context.offset + (/^[\w:.-]*/u.exec(text.slice(context.offset))?.[0].length ?? 0)
  const replacementRange = rangeAt(context.layout.parsed.starts, tagStart + 1, nameEnd)
  return layoutSchemaCompletions(context.store, context.layout.uri, container.start, 'element').items
    .filter(item => item.insertText?.startsWith('<'))
    .map(item => ({ ...item, insertText: item.insertText.slice(1), replacementRange }))
}

/**
 * A property bind `{Path/@Property}` (parity plan 3.16): before `@`, the path a segment at a time
 * from the action's frame, as a frame reference; after it, the properties of the frame it leads to.
 */
function propertyBindItems(context, request) {
  const attribute = context.attribute
  if (context.node === undefined || attribute === undefined || context.offset < attribute.valueStart) return undefined
  if (!attribute.value.startsWith('{')) return undefined
  const text = request.document.text
  const typed = text.slice(attribute.valueStart + 1, context.offset)
  const at = typed.indexOf('@')
  const end = Math.min(attribute.valueEnd, ...['/', '@', '}', '['].map(stop => text.indexOf(stop, context.offset)).filter(index => index >= 0))
  if (at >= 0) {
    const replacementRange = rangeAt(context.layout.parsed.starts, attribute.valueStart + 1 + at + 1, end)
    const path = typed.slice(0, at).replace(/\/$/u, '')
    return (layoutBoundFrameProperties(context.store, context.layout.uri, context.node.start, path) ?? [])
      .map(item => ({ ...item, replacementRange }))
  }
  const start = attribute.valueStart + 1 + typed.lastIndexOf('/') + 1
  const replacementRange = rangeAt(context.layout.parsed.starts, start, end)
  // The action's own frame: the attribute is not `frame`, so a StateGroup action starts from its target.
  return (layoutFrameReferenceSegments(context.store, context.layout.uri, context.node.start, 'value', typed) ?? [])
    .map(item => ({ label: item.name, kind: item.kind, detail: item.detail, replacementRange }))
}

export async function sc2LayoutCompletion(request, modContexts) {
  const served = modContexts === undefined ? undefined : servedModContext(request)
  if (served !== undefined) {
    // The loaded mod's server holds the chain's layouts and sheets (`served-definitions.js`).
    const answer = await modContexts.query(served.scope, {
      kind: 'layout.completion',
      document: { layerId: served.document.layerId, path: served.document.path },
      offset: offsetAt(request.document, request.position),
      maxResults: request.maxResults,
    }, request.signal)
    if (answer?.revision !== served.revision) throw new Error('layout.completion answered another revision')
    return Object.freeze({
      items: Object.freeze(answer.items.map(Object.freeze)),
      isIncomplete: answer.capped === true || answer.incomplete === true || languageWorkspaceIsSemanticallyIncomplete(request),
    })
  }
  const context = await contextOf(request, true)
  const items = layoutCompletionItems(context, request)
  return Object.freeze({
    items: Object.freeze(items.slice(0, request.maxResults).map(Object.freeze)),
    isIncomplete: items.length > request.maxResults || languageWorkspaceIsSemanticallyIncomplete(request),
  })
}

/**
 * Every completion item at a positioned context, in the order they are offered. Reads the live
 * text (`request.document.text`) and the style sheets and string tables among
 * `request.workspaceDocuments` — the snapshot's, or the mod server's sheets
 * (`served-definitions.js`, which leaves `@` string keys to the snapshot).
 */
export function layoutCompletionItems(context, request) {
  const bound = propertyBindItems(context, request)
  if (bound !== undefined) return bound
  const children = typedChildElements(context, request)
  if (children !== undefined) return children
  const abbreviations = abbreviationAt(context, request)
  if (abbreviations !== undefined) {
    return [
      ...new Map(abbreviations.map(item => [item.label.toLocaleLowerCase(), item])).values(),
    ].sort((left, right) => left.label.localeCompare(right.label))
  }
  const node = context.node
  const inValue =
    node !== undefined &&
    context.attribute !== undefined &&
    context.offset >= context.attribute.valueStart
  const mode =
    node === undefined
      ? context.layout.parsed.roots.length === 0
        ? 'root'
        : 'element'
      : inValue
        ? 'attribute-value'
        : context.offset <= node.openEnd
          ? 'attribute-name'
          : 'element'
  const schemaCompletion = layoutSchemaCompletions(
    context.store,
    context.layout.uri,
    node?.start,
    mode,
    context.attribute?.name.toLocaleLowerCase(),
  )
  const items = [...schemaCompletion.items]
  if (inValue) {
    const activeNode = /** @type {NonNullable<typeof node>} */ (node)
    const attribute = /** @type {NonNullable<typeof context.attribute>} */ (context.attribute)
    const imported = context.workspace.importedLayouts(context.layout)
    const frames = context.workspace.framesFor(context.layout)
    // An item that stands for the whole value replaces the whole value. The editor's own word
    // stops at `#`, `$` and `/`, and accepting over it wrote `##Name` and `$$parent`.
    const values = []
    if (attribute.name === 'type' && activeNode.tag === 'Frame') {
      items.length = 0
      for (const value of layoutFrameTypes(request.document.text.slice(attribute.valueStart, context.offset)))
        values.push({ label: value, kind: 'enum', detail: 'EFrameType' })
    }
    const ownFile = activeNode.attributeEntries.some(entry => entry.name.toLowerCase() === 'file')
    if (schemaCompletion.valueKind === 'DescName' && !ownFile) {
      // Without `file=`, `name=` either overrides an inherited child or declares a new one.
      values.push(...layoutInheritedChildNames(context.store, context.layout.uri, activeNode.start))
    } else if (attribute.name === 'template' || schemaCompletion.valueKind === 'DescTemplateName') {
      // A template names `File/Desc/…` anywhere in the snapshot, a segment at a time (parity plan 3.14).
      items.push(...descSegmentItems(request, context, attribute, false))
    } else if (
      schemaCompletion.valueKind === 'FrameReference' &&
      layoutFrameReferenceSegments(context.store, context.layout.uri, activeNode.start, attribute.name, '') !== undefined
    ) {
      // A frame reference resolves from the current frame, a segment at a time (parity plan 3.15).
      const { typed, replacementRange } = segmentUnderCaret(request, context, attribute)
      for (const item of layoutFrameReferenceSegments(context.store, context.layout.uri, activeNode.start, attribute.name, typed) ?? [])
        items.push({ label: item.name, kind: item.kind, detail: item.detail, replacementRange })
    } else if (['DescName', 'DescInternal', 'FrameReference'].includes(schemaCompletion.valueKind)) {
      // A frame reference may start from a handle instead of a name; MK2 offered these first.
      if (!attribute.value.includes('/'))
        for (const handle of ['$this', '$parent', '$sibling', '$ancestor', '$layer'])
          values.push({ label: handle, kind: 'keyword', detail: 'SC2Layout frame handle' })
      for (const frame of frames)
        values.push({ label: frame.path, kind: 'struct', detail: 'SC2Layout frame' })
    }
    // `file=` names another layout file of the snapshot; an Include names it by its path (3.14).
    if (schemaCompletion.valueKind === 'FileDescName')
      items.push(...descSegmentItems(request, context, attribute, true))
    else if (attribute.name === 'path' && activeNode.tag === 'Include')
      for (const layout of context.workspace.layouts)
        if (layout !== context.layout)
          values.push({ label: includePathOf(layout.uri), kind: 'module', detail: 'SC2Layout file' })
    if (attribute.value.startsWith('#') || schemaCompletion.valueKind === 'ConstantName') {
      // The label keeps the `#`, `##` or `###` the reader typed, so the editor still matches it.
      // A constant resolves across every layout the mod loads (parity plan 3.18): the including
      // files first, then the rest of the snapshot, each name once; the detail is its final value.
      const hashes = /^#{0,3}/u.exec(attribute.value)?.[0] ?? ''
      const named = new Set()
      for (const layout of [...imported, ...context.workspace.layouts])
        for (const constant of layout.constants) {
          if (named.has(constant.name.toLowerCase())) continue
          named.add(constant.name.toLowerCase())
          values.push({
            label: `${hashes}${constant.name}`,
            kind: 'constant',
            detail: constantChain(context.workspace, context.layout, constant),
          })
        }
    }
    // Animation, state group, state and event names come from the frame the element addresses (3.17).
    // A Style value names a FontStyles style, never a constant (parity plan 3.12): the style owner
    // reads the sheets of the snapshot.
    if (schemaCompletion.valueKind === 'Style') {
      const sheets = request.workspaceDocuments.filter(document => document.languageId === 'sc2-style')
      for (const name of [...inheritedNames(sheets).styles].sort())
        values.push({ label: name, kind: 'class', detail: 'FontStyles style' })
    }
    const valueRange = rangeAt(context.layout.parsed.starts, attribute.valueStart, attribute.valueEnd)
    for (const item of values) items.push({ ...item, replacementRange: valueRange })
    const stringKind =
      schemaCompletion.valueKind === 'Image'
        ? /Assets/iu
        : schemaCompletion.valueKind === 'Hotkey'
          ? /GameHotkeys/iu
          : schemaCompletion.valueKind === 'Text'
            ? /GameStrings/iu
            : undefined
    if (stringKind !== undefined)
      items.push(...stringKeySegments(request, context, attribute, stringKind))
  } else if (
    mode === 'element' &&
    node !== undefined &&
    /<\/[A-Za-z0-9_.:-]*$/u.test(request.document.text.slice(0, context.offset))
  ) {
    items.push({
      label: `/${node.tag}`,
      kind: 'struct',
      insertText: `${node.tag}>`,
      detail: 'Close current element',
    })
  }
  return [...new Map(items.map(item => [item.label.toLowerCase(), item])).values()].sort(
    (left, right) => left.label.localeCompare(right.label),
  )
}

export async function sc2LayoutHover(request, modContexts) {
  const served = modContexts === undefined ? undefined : servedModContext(request)
  if (served !== undefined) {
    // The loaded mod's server holds the chain's layouts and sheets (`served-definitions.js`).
    const answer = await modContexts.query(served.scope, {
      kind: 'layout.hover',
      document: { layerId: served.document.layerId, path: served.document.path },
      offset: offsetAt(request.document, request.position),
    }, request.signal)
    if (answer?.revision !== served.revision) throw new Error('layout.hover answered another revision')
    if (answer.hover === undefined) return undefined
    if (answer.declarationUri !== undefined) {
      const uri = answer.documents?.[0]?.uri
      if (typeof uri !== 'string') throw new TypeError('catalog hover named a declaration without a Host URI')
      return { ...answer.hover, markdown: answer.hover.markdown.replaceAll(answer.declarationUri, uri) }
    }
    return answer.hover
  }
  const context = await contextOf(request, true)
  const cross = context.crossLinks.hoverAt(context.layout.uri, context.offset)
  if (cross !== undefined) {
    const reference = context.crossLinks.references.find(
      item =>
        item.uri === context.layout.uri &&
        item.start <= context.offset &&
        context.offset <= item.end,
    )
    const target = context.crossLinks.targetAt(context.layout.uri, context.offset)
    return Object.freeze({
      ...cross,
      ...(reference === undefined ? {} : { range: protocolRange(context.layout, reference) }),
      ...(target === undefined ? {} : { commands: entityCommands(target) }),
    })
  }
  return layoutHoverIn(context, request.workspaceDocuments)
}

/**
 * The hover of a positioned context that is not on a catalog link: the element or attribute's
 * schema, the value it holds and what that value names. Style sheets and string tables come from
 * `documents` (the snapshot's, or the mod server's sheets in `served-definitions.js`).
 */
export function layoutHoverIn(context, documents) {
  const node = context.node
  if (node === undefined) return undefined
  const activeNode = /** @type {NonNullable<typeof node>} */ (node)
  const attr = context.attribute
  const schema = layoutSchemaHoverInfo(
    context.store,
    context.layout.uri,
    activeNode.start,
    attr?.name,
  )
  const range =
    attr === undefined
      ? {
          start: activeNode.start + 1,
          end: activeNode.start + 1 + activeNode.tag.length,
        }
      : { start: attr.nameStart, end: attr.valueEnd }
  const title = attr === undefined ? activeNode.tag : `${activeNode.tag}.${attr.name}`
  const details = []
  if (schema !== undefined) {
    details.push(`Schema type: \`${schema.typeName}\`.`)
    if (schema.label !== undefined && schema.label !== '') details.push(schema.label)
    if (schema.documentation !== undefined && schema.documentation !== '')
      details.push(schema.documentation)
    // On the value, the value the attribute holds; on the name, what it accepts (parity plan 3.21, as MK2).
    const matched =
      attr !== undefined && context.offset >= attr.valueStart
        ? schema.values?.find(item => item.value.toLowerCase() === attr.value.toLowerCase())
        : undefined
    if (matched !== undefined) details.push(`**\`${matched.value}\`**${matched.label ? ` — ${matched.label}` : ''}`)
    else if (schema.values !== undefined)
      details.push(
        schema.values
          .slice(0, 32)
          .map(item => `- \`${item.value}\`${item.label ? ` — ${item.label}` : ''}`)
          .join('\n') +
          (schema.values.length > 32 ? `\n- … ${schema.values.length - 32} more` : ''),
      )
    if (schema.frameType !== undefined)
      details.push(`Frame type \`${schema.frameType.name}\`${schema.frameType.blizzardOnly ? ' — Blizzard restricted' : ''}.`)
    // An element lists its attributes, required first.
    if (attr === undefined && schema.attributes !== undefined && schema.attributes.length > 0)
      details.push(
        [...schema.attributes]
          .sort((left, right) => Number(right.required) - Number(left.required))
          .map(item => `- \`${item.name}\`${item.required ? ' (required)' : ''}: \`${item.typeName}\`${item.label ? ` — ${item.label}` : ''}`)
          .join('\n'),
      )
  }
  if (attr !== undefined) details.push(`Current value: \`${attr.value}\`.`)
  const target = attr === undefined ? undefined : referenceDetail(documents, context, attr, schema)
  if (target !== undefined) details.push(target)
  const markdown = `**${title}**${schema?.required === true ? ' (required)' : ''}${
    details.length === 0 ? ' — SC2Layout XML element.' : `\n\n${details.join('\n\n')}`
  }`
  const picture = attr === undefined ? undefined : pictureOf(documents, attr.value)
  return Object.freeze({
    markdown,
    range: protocolRange(context.layout, range),
    provenance: `${SC2_LAYOUT_PROVENANCE.schemaReference} (reference; compact provider summary)`,
    ...(picture === undefined ? {} : { assets: [{ path: picture }] }),
  })
}

/**
 * A caret on a Style-typed value (`<Style val>`, `Controller` `style1/style2`, `SetProperty Style`)
 * is on a FontStyles name. Those requests answer from the shared style-name model, so a layout, a
 * catalog and the sheet itself agree on the declaration, the uses and every rename edit.
 */
function onStyleName(request) {
  assertFeatureRequest(request, true)
  return styleNameAt(request)
}

/** A caret on `@Key` in a Text-typed value names a GameStrings key; the catalogs answer for it. */
export function onStringKey(request) {
  return stringKeyAt(request.document, request.position)
}

/**
 * The declaration of the segment under the caret of a template, file or frame reference value
 * (parity plan 3.23): `File` goes to the file, `File/Frame` to the frame, `$parent/Ok` to the frame
 * the handles lead to from the current one.
 */
function referenceSiteAt(context) {
  const attr = context.attribute
  if (attr === undefined || context.node === undefined) return undefined
  const typeName = layoutSchemaHoverInfo(context.store, context.layout.uri, context.node.start, attr.name)?.typeName
  const site = layoutReferenceSite(
    context.store,
    context.layout.uri,
    context.node.start,
    attr.name,
    typeName,
    attr.value,
    context.offset - attr.valueStart,
  )
  const layout = site === undefined ? undefined : context.workspace.byUri.get(site.uri)
  return layout === undefined ? undefined : { uri: site.uri, range: protocolRange(layout, site) }
}

/**
 * What the layouts themselves declare at a positioned context: the segment of a template, file or
 * frame reference, else the declaration selected (include, template, constant, frame). Undefined
 * when they declare nothing there. A protocol location of the context's workspace.
 */
export function layoutDeclaredLocation(context) {
  const site = referenceSiteAt(context)
  if (site !== undefined) return site
  const declaration = selectedDeclaration(context)
  return declaration === undefined
    ? undefined
    : { uri: declaration.uri, range: protocolRange(context.workspace.byUri.get(declaration.uri), declaration.range) }
}

export async function sc2LayoutDefinition(request, modContexts) {
  const served = modContexts === undefined ? undefined : servedModContext(request)
  if (onStyleName(request))
    return served !== undefined && styleNameServable(request)
      ? styleNameServedDefinition(request, modContexts, served)
      : styleNameDefinition(request)
  if (!hasSc2CatalogLinkAt(request.document, offsetAt(request.document, request.position)) && onStringKey(request))
    return served !== undefined
      ? stringsServedLocations(request, modContexts, served, { definitions: true, uses: false })
      : stringsDefinition(request)
  if (served !== undefined) {
    // The loaded mod's server holds the chain's layouts (`served-definitions.js`).
    const answer = await modContexts.query(served.scope, {
      kind: 'layout.definition',
      document: { layerId: served.document.layerId, path: served.document.path },
      offset: offsetAt(request.document, request.position),
    }, request.signal)
    if (answer?.revision !== served.revision) throw new Error('layout.definition answered another revision')
    const locations = answer.definitions.map(item => {
      const uri = answer.documents[item.document]?.uri
      if (typeof uri !== 'string') throw new TypeError('layout.definition named a document without a URI')
      return Object.freeze({ uri, range: item.range })
    })
    return Object.freeze({
      locations: Object.freeze(locations),
      isIncomplete: answer.incomplete === true || languageWorkspaceIsSemanticallyIncomplete(request),
    })
  }
  const context = await contextOf(request, true)
  const declared = layoutDeclaredLocation(context)
  // The mixed workspace link index spans every catalog of the chain: build it only when the layout
  // itself declares nothing here (a template is answered by its declaration, not by catalog links).
  const crossDefinition =
    declared === undefined ? context.crossLinks.definitionAt(context.layout.uri, context.offset) : undefined
  if (crossDefinition !== undefined)
    return Object.freeze({
      locations: Object.freeze([crossDefinition]),
      isIncomplete: context.crossLinks.isIncomplete,
    })
  return Object.freeze({
    locations: Object.freeze(declared === undefined ? [] : [declared]),
    isIncomplete: languageWorkspaceIsSemanticallyIncomplete(request),
  })
}

/**
 * Every navigation position is served by the held layout topology, catalogs and string tables.
 */
export async function sc2LayoutServedCompletionApplies(request) {
  return true
}

export async function sc2LayoutServedFeatureApplies(request) {
  return ['rename', 'prepareRename', 'references', 'definition', 'hover'].includes(request.feature)
}

/**
 * The animation or state group under the caret and every place naming it, through the frame each
 * element addresses (parity plan 3.24), as protocol locations of the snapshot.
 */
function frameMemberAt(context) {
  const member = layoutFrameMemberSites(context.store, context.layout.uri, context.offset)
  if (member === undefined) return undefined
  const located = sites =>
    sites.flatMap(site => {
      const layout = context.workspace.byUri.get(site.uri)
      return layout === undefined ? [] : [{ uri: site.uri, layout, range: protocolRange(layout, site) }]
    })
  return { ...member, declarations: located(member.declarations), references: located(member.references) }
}

export async function sc2LayoutReferences(request, modContexts) {
  const served = modContexts === undefined ? undefined : servedModContext(request)
  if (onStyleName(request)) return served === undefined ? styleNameReferences(request)
    : styleNameServedReferences(request, modContexts, served)
  if (!hasSc2CatalogLinkAt(request.document, offsetAt(request.document, request.position)) && onStringKey(request))
    return served === undefined ? stringsReferences(request) : stringsServedLocations(request, modContexts, served, { definitions: request.includeDeclaration === true, uses: true })
  if (served !== undefined) {
    const answer = await modContexts.query(served.scope, { kind: 'layout.references', document: served.document,
      offset: offsetAt(request.document, request.position), maxResults: request.maxResults,
      includeDeclaration: request.includeDeclaration === true, incomplete: request.workspaceIncomplete === true }, request.signal)
    if (answer?.revision !== served.revision) throw new Error('layout.references answered another revision')
    return { locations: answer.references.map(item => {
      const uri = answer.documents[item.document]?.uri
      if (typeof uri !== 'string') throw new TypeError('layout.references named a document without a URI')
      return { uri, range: item.range }
    }), isIncomplete: answer.incomplete === true }
  }
  const context = await contextOf(request, true)
  return layoutReferencesIn(context, request)
}

/** The same frame/member/catalog reference resolution over the retained topology or standalone workspace. */
export function layoutReferencesIn(context, request) {
  const member = frameMemberAt(context)
  if (member !== undefined) {
    const locations = [...(request.includeDeclaration === true ? member.declarations : []), ...member.references]
    return Object.freeze({
      locations: Object.freeze(locations.slice(0, request.maxResults).map(item => Object.freeze({ uri: item.uri, range: item.range }))),
      isIncomplete: locations.length > request.maxResults || languageWorkspaceIsSemanticallyIncomplete(request),
    })
  }
  const declaration = selectedDeclaration(context)
  if (declaration === undefined) {
    const crossLocations = context.crossLinks.referencesAt(
      context.layout.uri,
      context.offset,
      request.includeDeclaration === true,
    )
    return Object.freeze({
      locations: Object.freeze(crossLocations.slice(0, request.maxResults)),
      isIncomplete:
        crossLocations.length > request.maxResults ||
        (crossLocations.length > 0 && context.crossLinks.isIncomplete) ||
        languageWorkspaceIsSemanticallyIncomplete(request),
    })
  }
  const { locations, uncertain } = allReferenceLocations(context, declaration, request.includeDeclaration === true)
  return Object.freeze({
    locations: Object.freeze(
      locations.slice(0, request.maxResults).map(item =>
        Object.freeze({
          uri: item.uri,
          range: protocolRange(context.workspace.byUri.get(item.uri), item.range),
        }),
      ),
    ),
    isIncomplete:
      uncertain || locations.length > request.maxResults || languageWorkspaceIsSemanticallyIncomplete(request),
  })
}

/**
 * The catalog entity under the caret in `@Ns/Field/Id` (its id segment), as the one cross-language
 * link index finds it: renaming there renames the entity everywhere, not the string key (parity
 * plan 3.25). The rest of the value stays a string key.
 */
async function catalogLiteralAt(request) {
  const context = await contextOf(request, true)
  const reference = context.crossLinks.references.find(
    item => item.uri === context.layout.uri && item.start <= context.offset && context.offset <= item.end,
  )
  return reference === undefined ? undefined : { context, reference }
}

export async function sc2LayoutPrepareRename(request, modContexts) {
  if (modContexts !== undefined && servedModContext(request) !== undefined) return servedRenameFeature(request, modContexts, 'prepareRename')
  if (onStyleName(request)) return styleNamePrepareRename(request)
  const literal = await catalogLiteralAt(request)
  if (literal !== undefined)
    return Object.freeze({
      range: protocolRange(literal.context.layout, literal.reference),
      placeholder: literal.reference.entityId,
    })
  if (onStringKey(request)) return prepareStringsRename(request.document, request.position)
  return layoutPrepareRenameIn(await contextOf(request, true))
}

/** Prepare a structural name from the retained layout topology. */
export function layoutPrepareRenameIn(context) {
  const member = frameMemberAt(context)
  if (member !== undefined && member.under.uri === context.layout.uri)
    return Object.freeze({ range: protocolRange(context.layout, member.under), placeholder: member.name })
  const declaration = selectedDeclaration(context)
  if (
    declaration === undefined ||
    !['constant', 'struct', 'enum', 'variable'].includes(declaration.kind)
  )
    return undefined
  // The preparation range has to be the token under the cursor in THIS document; a declaration in
  // another layout (a template or constant the file only references) is out of its bounds.
  const local =
    declaration.uri === context.layout.uri
      ? declaration.range
      : context.layout.references.find(
          item => item.range.start <= context.offset && context.offset <= item.range.end,
        )?.range
  if (local === undefined) return undefined
  return Object.freeze({
    range: protocolRange(context.layout, local),
    placeholder: declaration.name,
  })
}

export async function sc2LayoutRename(request, modContexts) {
  if (modContexts !== undefined && servedModContext(request) !== undefined) return servedRenameFeature(request, modContexts, 'rename')
  if (onStyleName(request)) return styleNameRename(request)
  const literal = await catalogLiteralAt(request)
  if (literal !== undefined)
    return literal.context.crossLinks.renameAt(
      literal.context.layout.uri,
      literal.context.offset,
      request.newName,
      request.maxEdits,
    )
  if (onStringKey(request)) return renameStrings(request)
  return layoutRenameIn(await contextOf(request, true), request)
}

/** Structural rename through the retained layout workspace; cross-format names use their owners. */
export function layoutRenameIn(context, request) {
  if (request.workspaceIncomplete) return undefined
  if (
    !Number.isSafeInteger(request.maxEdits) ||
    request.maxEdits < 1 ||
    !/^[\w!#%&'()+,.\-/;=@\[\]^_`{}~]+$/u.test(request.newName)
  )
    return undefined
  const member = frameMemberAt(context)
  if (member !== undefined) {
    // An animation or a state group: its declarations and every element naming it (parity plan 3.24).
    const sites = [...member.declarations, ...member.references]
    if (sites.length > request.maxEdits) return undefined
    const changes = new Map()
    for (const site of sites) {
      const list = changes.get(site.uri) ?? []
      list.push(Object.freeze({ range: site.range, newText: request.newName }))
      changes.set(site.uri, list)
    }
    return renameResult(context, changes)
  }
  const declaration = selectedDeclaration(context)
  if (
    declaration === undefined ||
    !['constant', 'struct', 'enum', 'variable'].includes(declaration.kind)
  )
    return undefined
  const { locations, uncertain } = allReferenceLocations(context, declaration, true)
  // A reference with the name that reaches no frame may be this one: refuse rather than leave it.
  if (uncertain || locations.length > request.maxEdits) return undefined
  const changes = new Map()
  for (const item of locations) {
    const layout = context.workspace.byUri.get(item.uri)
    const oldText = layout.parsed.document.text.slice(item.range.start, item.range.end)
    const newText =
      item.segments !== undefined
        ? oldText.split('/').map((part, index) => (item.segments.includes(index) ? request.newName : part)).join('/')
        : declaration.kind === 'constant' && oldText.startsWith('#')
          ? `#${request.newName}`
          : oldText.includes('/')
            ? `${oldText.slice(0, oldText.lastIndexOf('/') + 1)}${request.newName}`
            : request.newName
    const list = changes.get(item.uri) ?? []
    list.push(Object.freeze({ range: protocolRange(layout, item.range), newText }))
    changes.set(item.uri, list)
  }
  return renameResult(context, changes)
}

/** Edits by document uri, as one rename over the snapshot's versions, last edit first. */
function renameResult(context, changes) {
  return Object.freeze({
    documentChanges: Object.freeze(
      [...changes].map(([uri, edits]) =>
        Object.freeze({
          uri,
          documentVersion: context.workspace.byUri.get(uri).version,
          edits: Object.freeze(
            edits.sort(
              (left, right) =>
                right.range.start.line - left.range.start.line ||
                right.range.start.character - left.range.start.character,
            ),
          ),
        }),
      ),
    ),
    isComplete: true,
  })
}

export async function sc2LayoutDocumentSymbols(request) {
  const context = await contextOf(request)
  const symbols = documentSymbolsFor(context, context.layout)
  return Object.freeze({
    symbols: Object.freeze(symbols.slice(0, request.maxResults)),
    isIncomplete: symbols.length > request.maxResults,
  })
}

export async function sc2LayoutWorkspaceSymbols(request) {
  const context = await contextOf(request)
  return layoutWorkspaceSymbolsIn(context, request)
}

/** Symbol listing over the same held topology used for frame and template navigation. */
export function layoutWorkspaceSymbolsIn(context, request) {
  // `#` asks for constants only, as MK2's workspace symbols did; the rest matches fuzzily, substrings first.
  const constantsOnly = request.query.startsWith('#')
  const needle = request.query.replace(/^#+/u, '').toLowerCase()
  const symbols = context.workspace.declarations
    .filter(item => (!constantsOnly || item.kind === 'constant') && fuzzyMatches(item.name, needle))
    .sort((left, right) => Number(!left.name.toLowerCase().includes(needle)) - Number(!right.name.toLowerCase().includes(needle)))
    .map(item =>
      Object.freeze({
        name: item.name,
        kind: item.kind,
        location: Object.freeze({
          uri: item.uri,
          range: protocolRange(context.workspace.byUri.get(item.uri), item.range),
        }),
        ...(item.path === item.name
          ? {}
          : { containerName: item.path.split('/').slice(0, -1).join('/') }),
        detail: item.path,
      }),
    )
  return Object.freeze({
    symbols: Object.freeze(symbols.slice(0, request.maxResults)),
    isIncomplete:
      symbols.length > request.maxResults || languageWorkspaceIsSemanticallyIncomplete(request),
  })
}

/**
 * Whether a schema finding says something about *this* document.
 *
 * Three of the checker's messages are about resolving a name somewhere else — a template, a
 * constant, an included file. On a complete workspace they are real defects. On the bounded snapshot
 * a language request usually carries they are just "not in the window", and reporting them turns a
 * healthy layout into a wall of errors: a single-file request on a real Blizzard layout produced
 * thirty-six of them, twenty-seven of which the provider already reports as unresolved templates
 * with the right wording.
 *
 * The template case is dropped either way, because the provider owns that message and two findings
 * on one attribute is worse than one.
 */
/** LayoutChecker's `DiagnosticCategory` (Error 1, Warning 2, Message 3, Hint 4) as a severity. */
const CHECKER_SEVERITY = Object.freeze({ 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' })

function keepSchemaFinding(message, workspaceIncomplete) {
  if (message.startsWith('Could not find template ')) return false
  if (!workspaceIncomplete) return true
  return (
    !message.startsWith('Undeclared constant ') &&
    !message.startsWith('Failed to locate specified File Desc ')
  )
}

export async function sc2LayoutDiagnostics(request, modContexts) {
  const served = modContexts === undefined ? undefined : servedModContext(request)
  if (served !== undefined) {
    // The loaded mod's server holds the chain's layouts and its cross-language link index.
    const answer = await modContexts.query(served.scope, {
      kind: 'layout.diagnostics',
      document: { layerId: served.document.layerId, path: served.document.path },
      offset: 0,
      maxResults: request.maxResults,
      incomplete: languageWorkspaceIsSemanticallyIncomplete(request),
    }, request.signal)
    if (answer?.revision !== served.revision) throw new Error('layout.diagnostics answered another revision')
    return Object.freeze({
      diagnostics: Object.freeze(answer.diagnostics.diagnostics.map(Object.freeze)),
      isIncomplete: answer.diagnostics.isIncomplete || answer.incomplete === true,
    })
  }
  return layoutDiagnosticsIn(await contextOf(request), request)
}

/**
 * A layout's diagnostics at a context: the workspace's structural findings, the schema checker's
 * and the catalog literals the link index cannot resolve (under `context.linkUri`, the layout's name
 * in that index). `request` gives the bound and whether the workspace is incomplete; the loaded
 * mod's server answers through it (`served-definitions.js`).
 */
export function layoutDiagnosticsIn(context, request) {
  const items = workspaceDiagnostics(context).filter(
    entry => entry.layout.uri === context.layout.uri,
  )
  const crossDiagnostics = context.crossLinks.diagnosticsFor(context.linkUri ?? context.layout.uri)
  /*
   * What the ported schema checker finds, alongside the structural findings above. These are the
   * rules the game's own schema states — an unknown frame type, a property that does not belong on
   * this frame, a value of the wrong type — and none of them were reported before, because the
   * provider was reading a hand-written table rather than the schema.
   */
  const schemaFindings = layoutSchemaFindings(context.store, context.layout.uri)
    .filter(finding =>
      keepSchemaFinding(finding.message, languageWorkspaceIsSemanticallyIncomplete(request)),
    )
    .map(finding => ({
      range: rangeAt(context.layout.parsed.starts, finding.start, finding.end),
      // The checker's four categories, each rule under its own code (parity plan 3.27, as MK2).
      severity: CHECKER_SEVERITY[finding.category] ?? 'error',
      code: finding.code,
      source: 'sc2-layout',
      message: finding.message,
    }))
  const all = [
    ...items.map(({ layout, item }) => diagnosticItem(layout, item)),
    ...schemaFindings,
    ...crossDiagnostics,
  ]
  return Object.freeze({
    diagnostics: Object.freeze(all.slice(0, request.maxResults)),
    isIncomplete:
      all.length > request.maxResults ||
      // the bounded parse kept only its first findings for this document
      context.layout.parsed.diagnosticsIncomplete === true ||
      context.crossLinks.diagnosticsIncomplete ||
      languageWorkspaceIsSemanticallyIncomplete(request),
  })
}

/** Preserve authored layout XML and apply only the requested final-newline policy. */
export async function sc2LayoutFormatting(request) {
  assertFeatureRequest(request)
  const desired = request.options?.finalNewline
  if (desired === undefined) return Object.freeze({ edits: Object.freeze([]), isComplete: true })
  const text = request.document.text
  const hasFinalNewline = /(?:\r?\n)$/u.test(text)
  if (desired === hasFinalNewline) {
    return Object.freeze({ edits: Object.freeze([]), isComplete: true })
  }
  const context = await contextOf(request)
  const offset = text.length
  const edit = desired
    ? { range: rangeAt(context.layout.parsed.starts, offset, offset), newText: '\n' }
    : {
        range: rangeAt(
          context.layout.parsed.starts,
          text.replace(/(?:\r?\n)+$/u, '').length,
          offset,
        ),
        newText: '',
      }
  return Object.freeze({ edits: Object.freeze([Object.freeze(edit)]), isComplete: true })
}

/**
 * A closing tag typed on a line of its own takes its opening tag's indentation (parity plan 3.20;
 * MK2 re-indented the line after completing `</Tag`, a command the closed set no longer has).
 */
export async function sc2LayoutOnTypeFormatting(request) {
  assertFeatureRequest(request, true)
  const none = Object.freeze({ edits: Object.freeze([]), isComplete: true })
  const text = request.document.text
  const offset = offsetAt(request.document, request.position)
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const typed = /^([ \t]*)<\/[^<>]*>$/u.exec(text.slice(lineStart, offset))
  if (request.ch !== '>' || typed === null) return none
  const parsed = await parseXmlDocument(request.document, request, request.signal)
  let closed
  walkElements(parsed.roots, node => {
    if (node.end === offset && node.end !== node.openEnd) closed = node
  })
  if (closed === undefined) return none
  const openLine = text.lastIndexOf('\n', closed.start - 1) + 1
  const indent = /^[ \t]*/u.exec(text.slice(openLine))?.[0] ?? ''
  // Only a tag that ends a line of its own children: `<A>…</A>` on one line keeps its place.
  if (indent === typed[1] || openLine === lineStart) return none
  const starts = lineMap(text)
  return Object.freeze({
    edits: Object.freeze([
      Object.freeze({ range: rangeAt(starts, lineStart, lineStart + typed[1].length), newText: indent }),
    ]),
    isComplete: true,
  })
}

export async function sc2LayoutDocumentColors(request) {
  const context = await contextOf(request)
  const candidates = layoutSchemaColorValues(context.store, request.document.uri)
  const colors = []
  for (const candidate of candidates) {
    const parsed = parseColorLiteral(candidate.value)
    if (parsed === undefined) continue
    colors.push(
      Object.freeze({
        range: rangeAt(context.layout.parsed.starts, candidate.start, candidate.end),
        color: parsed.color,
      }),
    )
  }
  return Object.freeze({
    colors: Object.freeze(colors.slice(0, request.maxResults)),
    isIncomplete: colors.length > request.maxResults,
  })
}

export async function sc2LayoutColorPresentations(request) {
  const context = await contextOf(request)
  const start = offsetAt(request.document, request.range.start)
  const end = offsetAt(request.document, request.range.end)
  const authored = request.document.text.slice(start, end).trim()
  const parsed = parseColorLiteral(authored)
  if (parsed === undefined)
    return Object.freeze({ presentations: Object.freeze([]), isIncomplete: false })
  const labels = [
    decimalColor(request.color, parsed.includesAlpha),
    hexColor(request.color, parsed.includesAlpha),
  ]
  return Object.freeze({
    presentations: Object.freeze(
      labels.slice(0, request.maxResults).map(label => Object.freeze({ label })),
    ),
    isIncomplete: labels.length > request.maxResults,
  })
}

export const abiVersion = 1
export const provides = Object.freeze([LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT])

export function createProvider(selection, context) {
  const modContexts = context?.modContexts
  if (selection.contract !== LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT || selection.major !== 1)
    throw new TypeError(
      `Unsupported SC2Layout language selection ${selection.contract}@${selection.major}`,
    )
  return Object.freeze({
    value: Object.freeze({
      contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT,
      languageIds: Object.freeze(['sc2-layout']),
      semanticInputs: Object.freeze([
        Object.freeze({
          kind: 'schema',
          id: 'blizzard/sc2-layout-schema@1',
          revision: SC2_LAYOUT_SCHEMA_REVISION,
        }),
        Object.freeze({ kind: 'provider', id: 'blizzard/sc2-layout-language', revision: '2' }),
      ]),
      // The mixed SC2 set plus the style sheets a `<Style val>` resolves against.
      workspaceLanguageIds: Object.freeze([...SC2_MIXED_WORKSPACE_LANGUAGE_IDS, 'sc2-style']),
      // The outline is the file's own frames and declarations (owner decision 10.10, no second copy).
      documentLocalFeatures: Object.freeze(['documentSymbols', 'formatting', 'onTypeFormatting', 'codeActions', 'documentColors', 'colorPresentations']),
      // Definition (templates, includes, constants, frames, styles), hover and completion come from
      // the loaded mod's server, which also holds string tables and catalog links. Workspace symbols,
      // structural references and rename share these same owners; standalone keeps the existing path.
      ...(modContexts === undefined
        ? {}
        : {
            semanticContextRequirements: Object.freeze([
              Object.freeze({ kind: 'mod-context', gameId: 'blizzard/starcraft-2' }),
            ]),
            modContextFeatures: Object.freeze(['definition', 'hover', 'completion', 'diagnostics', 'references', 'rename', 'prepareRename', 'projectDiagnostics', 'workspaceSymbols']),
            projectDiagnostics: request => servedProjectDiagnostics(request, modContexts),
            modContextFeatureApplies: sc2LayoutServedFeatureApplies,
            modContextCompletionApplies: sc2LayoutServedCompletionApplies,
          }),
      analyze: analyzeSc2Layout,
      completion: request => sc2LayoutCompletion(request, modContexts),
      hover: request => sc2LayoutHover(request, modContexts),
      definition: request => sc2LayoutDefinition(request, modContexts),
      references: request => sc2LayoutReferences(request, modContexts),
      prepareRename: request => sc2LayoutPrepareRename(request, modContexts),
      rename: request => sc2LayoutRename(request, modContexts),
      formatting: sc2LayoutFormatting,
      onTypeFormatting: sc2LayoutOnTypeFormatting,
      documentColors: sc2LayoutDocumentColors,
      colorPresentations: sc2LayoutColorPresentations,
      codeActions: finalNewlineCodeActions,
      documentSymbols: sc2LayoutDocumentSymbols,
      workspaceSymbols: request => modContexts !== undefined && servedModContext(request) !== undefined
        ? servedLanguageFeature(request, modContexts, 'workspaceSymbols') : sc2LayoutWorkspaceSymbols(request),
      diagnostics: request => sc2LayoutDiagnostics(request, modContexts),
      async referenceOccurrences(request) {
        const mixed = sc2MixedReferenceOccurrenceBatches(request)
        const styles = styleReferenceOccurrenceBatches(request)
        const layouts = await layoutReferenceOccurrenceBatches(request)
        return mergeReferenceOccurrenceBatches(mixed, styles, layouts)
      },
    }),
    release: async () => undefined,
  })
}
