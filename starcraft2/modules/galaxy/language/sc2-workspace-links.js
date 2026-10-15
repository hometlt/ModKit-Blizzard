/**
 * Canonical SC2 mixed-language catalog links, bounded per request and cached per frozen document.
 * Provides targets, completion, navigation, usages, rename and diagnostics for Data/Galaxy/Layout/
 * Strings/Triggers/map resources. A partial index cannot prove that a declaration is absent;
 * known ambiguity remains reportable, while rename refuses incomplete inputs.
 */
import { analyzeGalaxyLanguage } from './language-service.js'
import { SyntaxKind, forEachChild } from '@modkit/blizzard-starcraft2/galaxy/language-core'
import { languageWorkspaceIsSemanticallyIncomplete } from '../../../shared/language/workspace-context.js'
// Package self-references: one built module whether this file runs from source or from dist.
import {
  OBJECT_CATALOG_ATTRIBUTES,
  PRELOAD_TAG_LINKS,
} from '@modkit/blizzard-starcraft2/map/catalog-usages'
import { namespaceOfClass } from '@modkit/blizzard-starcraft2/data/catalog'
import { collectAllRefs } from '@modkit/blizzard-starcraft2/data/references'
import { SC2_ENTITY_ID } from '@modkit/blizzard-starcraft2/language/entity-id'

/** A map's placed objects (`Objects`) and its preload list (`Preload.xml`). */
export const SC2_MAP_OBJECTS_LANGUAGE_ID = 'sc2-map-objects'
export const SC2_MAP_PRELOAD_LANGUAGE_ID = 'sc2-map-preload'

export const SC2_MIXED_WORKSPACE_LANGUAGE_IDS = Object.freeze([
  'galaxy',
  'sc2-data',
  'sc2-layout',
  SC2_MAP_OBJECTS_LANGUAGE_ID,
  SC2_MAP_PRELOAD_LANGUAGE_ID,
  'sc2-strings',
  'sc2-triggers',
])

export const SC2_WORKSPACE_LINK_PROVENANCE =
  'Blizzard SC2 publisher literals: NativeLib gamelink parameters, TriggerData ValueType/ValueGameType and SC2Layout @Namespace/Property/Id references; Modkit legacy cross-reference evidence e044dd5d8c4090ecf5708017ca2cce251bb1c5c7'

// Matches the host ceiling: a real mod's catalogs and scripts exceed any smaller count.
const MAX_DOCUMENTS = 4_096
const MAX_DOCUMENT_CHARS = 64 * 1024 * 1024
const MAX_WORKSPACE_CHARS = 128 * 1024 * 1024
const MAX_XML_NODES = 200_000
const MAX_XML_DEPTH = 256
// A stock chain holds tens of thousands: Core + Liberty and a small mod give 88 945 links, the full
// index built in ~2 s and ~7 MiB more heap than one cut at 50 000. A cut leaves the opened mod's own
// documents, last in chain order, unindexed — its declarations unknown to every diagnostic.
const MAX_LINKS = 500_000
/*
 * Partial reasons that can hide a declaration: a check for a literal's declaration is unproven past
 * them. Dynamic gamelinks and catalog access hide usages only — they matter to references and
 * rename, not to whether a document's literals resolve.
 */
const DECLARATION_GAPS = new Set(['link-bound-exceeded', 'xml-parse-failed'])

const COMMON_CATALOG_NAMESPACES = Object.freeze([
  'AchievementTerm',
  'AttachMethod',
  'Behavior',
  'Button',
  'Effect',
  'Footprint',
  'RequirementNode',
  'Requirement',
  'Validator',
  'Weapon',
  'Upgrade',
  'Actor',
  'Model',
  'Mover',
  'Sound',
  'Texture',
  'Abil',
  'Unit',
])
const CATALOG_NAMESPACE_SET = new Set(COMMON_CATALOG_NAMESPACES)

// These argument positions are pinned by Blizzard NativeLib TriggerData semantics, not inferred
// from a parameter name or an arbitrary string literal.
const GALAXY_GAMELINK_ARGUMENTS = Object.freeze({
  UnitCreate: Object.freeze({ argument: 1, namespace: 'Unit' }),
  UnitTypeFromString: Object.freeze({ argument: 0, namespace: 'Unit' }),
  UnitAbilityEnable: Object.freeze({ argument: 1, namespace: 'Abil' }),
  UnitCreateEffectPoint: Object.freeze({ argument: 1, namespace: 'Effect' }),
  UnitCreateEffectUnit: Object.freeze({ argument: 1, namespace: 'Effect' }),
  libNtve_gf_UnitCreateFacingPoint: Object.freeze({ argument: 1, namespace: 'Unit' }),
})
const CATALOG_ACCESSORS = new Set([
  'CatalogFieldValueGet',
  'CatalogFieldValueGetAsInt',
  'CatalogFieldValueGetFlagsAsInt',
  'libNtve_gf_CatalogFieldValueGetAsReal',
])

const checkpoint = signal => signal?.throwIfAborted()

function lineStarts(text) {
  const starts = [0]
  for (let offset = 0; offset < text.length; offset += 1)
    if (text[offset] === '\n') starts.push(offset + 1)
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
  return Object.freeze({ line, character: Math.max(0, offset - starts[line]) })
}

const rangeAt = (document, start, end) => {
  const starts = document.__lineStarts ?? lineStarts(document.text)
  return Object.freeze({ start: positionAt(starts, start), end: positionAt(starts, end) })
}

function attributeEntries(source, base) {
  const entries = []
  const matcher = /([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/gu
  for (const match of source.matchAll(matcher)) {
    const quoted = match[2]
    const quoteOffset = (match.index ?? 0) + match[0].lastIndexOf(quoted)
    entries.push(
      Object.freeze({
        name: match[1],
        value: quoted.slice(1, -1),
        valueStart: base + quoteOffset + 1,
        valueEnd: base + quoteOffset + quoted.length - 1,
      }),
    )
  }
  return entries
}

function scanXml(document) {
  const roots = []
  const stack = []
  let offset = 0
  let nodes = 0
  while (offset < document.text.length) {
    const open = document.text.indexOf('<', offset)
    if (open < 0) break
    if (document.text.startsWith('<!--', open)) {
      const close = document.text.indexOf('-->', open + 4)
      offset = close < 0 ? document.text.length : close + 3
      continue
    }
    if (document.text.startsWith('<![CDATA[', open)) {
      const close = document.text.indexOf(']]>', open + 9)
      offset = close < 0 ? document.text.length : close + 3
      continue
    }
    const close = document.text.indexOf('>', open + 1)
    if (close < 0) throw new TypeError(`Unclosed XML tag in ${document.uri}`)
    const body = document.text.slice(open + 1, close)
    if (/^\s*[!?]/u.test(body)) {
      offset = close + 1
      continue
    }
    const closing = /^\s*\//u.test(body)
    if (closing) {
      const name = body.replace(/^\s*\/\s*/u, '').match(/^[A-Za-z_][\w:.-]*/u)?.[0]
      const node = stack.pop()
      if (node === undefined || node.name !== name)
        throw new TypeError(`Mismatched XML close tag in ${document.uri}`)
      node.contentEnd = open
      node.end = close + 1
      offset = close + 1
      continue
    }
    const nameMatch = body.match(/^\s*([A-Za-z_][\w:.-]*)/u)
    if (nameMatch === null) {
      offset = close + 1
      continue
    }
    nodes += 1
    if (nodes > MAX_XML_NODES) throw new RangeError(`${document.uri} exceeds the XML node bound`)
    if (stack.length + 1 > MAX_XML_DEPTH)
      throw new RangeError(`${document.uri} exceeds the XML depth bound`)
    const name = nameMatch[1]
    const nameOffset = body.indexOf(name)
    const selfClosing = /\/\s*$/u.test(body)
    const node = {
      name,
      start: open,
      nameStart: open + 1 + nameOffset,
      nameEnd: open + 1 + nameOffset + name.length,
      openEnd: close + 1,
      contentStart: close + 1,
      contentEnd: selfClosing ? close + 1 : undefined,
      end: selfClosing ? close + 1 : undefined,
      attributes: attributeEntries(body, open + 1),
      children: [],
      parent: stack.at(-1),
    }
    if (node.parent === undefined) roots.push(node)
    else node.parent.children.push(node)
    if (!selfClosing) stack.push(node)
    offset = close + 1
  }
  if (stack.length > 0) throw new TypeError(`Unclosed XML element in ${document.uri}`)
  return roots
}

const attribute = (node, name) => node?.attributes.find(item => item.name === name)

function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node)
    walk(node.children, visit)
  }
}

function catalogConstantNamespace(node) {
  if (node?.kind !== SyntaxKind.Identifier) return undefined
  const name = node.name ?? ''
  const namespace = /^c_gameCatalog([A-Z][A-Za-z0-9_]*)$/u.exec(name)?.[1]
  return CATALOG_NAMESPACE_SET.has(namespace) ? namespace : undefined
}

function literalReference(document, node, namespace, source) {
  if (node?.kind !== SyntaxKind.StringLiteral) return undefined
  const entityId = node.value
  if (typeof entityId !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entityId)) return undefined
  const raw = node.text ?? document.text.slice(node.pos, node.end)
  const leading = raw.startsWith('"') || raw.startsWith("'") ? 1 : 0
  const trailing = leading === 1 ? 1 : 0
  return {
    uri: document.uri,
    version: document.version,
    languageId: document.languageId,
    namespace,
    entityId,
    start: node.pos + leading,
    end: node.end - trailing,
    source,
  }
}

function literalCompletionTarget(document, node, namespace) {
  if (node?.kind !== SyntaxKind.StringLiteral) return undefined
  const raw = node.text ?? document.text.slice(node.pos, node.end)
  const quote = raw[0]
  const leading = quote === '"' || quote === "'" ? 1 : 0
  const trailing = leading === 1 && raw.at(-1) === quote ? 1 : 0
  return {
    uri: document.uri,
    namespace,
    start: node.pos + leading,
    end: node.end - trailing,
  }
}

function galaxyLinks(document, references, completionTargets, partial) {
  const analysis = analyzeGalaxyLanguage(document.text, document.uri)
  if ((analysis.sourceFile.parseDiagnostics ?? []).length > 0)
    partial.push({
      uri: document.uri,
      start: 0,
      end: Math.min(1, document.text.length),
      reason: 'galaxy-parse-diagnostics',
    })
  const visit = node => {
    if (node.kind === SyntaxKind.CallExpression) {
      const functionName = node.expression?.name
      const pinned = GALAXY_GAMELINK_ARGUMENTS[functionName]
      if (pinned !== undefined) {
        const argument = node.arguments?.[pinned.argument]
        const completionTarget = literalCompletionTarget(document, argument, pinned.namespace)
        if (completionTarget !== undefined) completionTargets.push(completionTarget)
        const reference = literalReference(
          document,
          argument,
          pinned.namespace,
          `galaxy:${functionName}:argument-${pinned.argument}`,
        )
        if (reference === undefined)
          partial.push({
            uri: document.uri,
            start: node.pos,
            end: node.end,
            reason: 'dynamic-galaxy-gamelink',
          })
        else references.push(reference)
      } else if (CATALOG_ACCESSORS.has(functionName)) {
        const namespace = catalogConstantNamespace(node.arguments?.[0])
        const completionTarget =
          namespace === undefined
            ? undefined
            : literalCompletionTarget(document, node.arguments?.[1], namespace)
        if (completionTarget !== undefined) completionTargets.push(completionTarget)
        const reference =
          namespace === undefined
            ? undefined
            : literalReference(
                document,
                node.arguments?.[1],
                namespace,
                `galaxy:${functionName}:catalog-entry`,
              )
        if (reference === undefined)
          partial.push({
            uri: document.uri,
            start: node.pos,
            end: node.end,
            reason: 'dynamic-galaxy-catalog-access',
          })
        else references.push(reference)
      }
    }
    forEachChild(node, child => {
      visit(child)
      return undefined
    })
  }
  visit(analysis.sourceFile)
}

function xmlLinks(document, declarations, references, completionTargets, partial) {
  let roots
  try {
    roots = scanXml(document)
  } catch {
    partial.push({
      uri: document.uri,
      start: 0,
      end: Math.min(1, document.text.length),
      reason: 'xml-parse-failed',
    })
    return
  }
  if (document.languageId === 'sc2-data') {
    walk(roots, node => {
      if (node.parent?.name !== 'Catalog' || !/^C[A-Z]/u.test(node.name)) return
      const id = attribute(node, 'id')
      const namespace = namespaceOfClass(node.name)
      if (
        id === undefined ||
        namespace === undefined ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(id.value)
      )
        return
      declarations.push({
        uri: document.uri,
        version: document.version,
        languageId: document.languageId,
        namespace,
        entityId: id.value,
        typeId: node.name,
        start: id.valueStart,
        end: id.valueEnd,
      })
    })
    return
  }
  if (document.languageId === 'sc2-triggers') {
    walk(roots, node => {
      if (node.name !== 'Element') return
      const value = node.children.find(child => child.name === 'Value')
      const valueType = node.children.find(child => child.name === 'ValueType')
      const gameType = node.children.find(child => child.name === 'ValueGameType')
      if (attribute(valueType, 'Type')?.value !== 'gamelink') return
      const namespace = attribute(gameType, 'Type')?.value
      const rawStart = value?.contentStart
      const rawEnd = value?.contentEnd
      if (!CATALOG_NAMESPACE_SET.has(namespace) || rawStart === undefined || rawEnd === undefined) {
        partial.push({
          uri: document.uri,
          start: node.start,
          end: node.end ?? node.openEnd,
          reason: 'ambiguous-trigger-gamelink',
        })
        return
      }
      completionTargets.push({
        uri: document.uri,
        namespace,
        start: rawStart,
        end: rawEnd,
      })
      const raw = document.text.slice(rawStart, rawEnd)
      const entityId = raw.trim()
      const leading = raw.length - raw.trimStart().length
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entityId)) {
        partial.push({
          uri: document.uri,
          start: rawStart,
          end: rawEnd,
          reason: 'dynamic-trigger-gamelink',
        })
        return
      }
      references.push({
        uri: document.uri,
        version: document.version,
        languageId: document.languageId,
        namespace,
        entityId,
        start: rawStart + leading,
        end: rawStart + leading + entityId.length,
        source: 'triggerdata:ValueType=gamelink+ValueGameType',
      })
    })
    return
  }
  // A map's catalog links: placed objects and the preload list, by the map format's own tables.
  if (
    document.languageId === SC2_MAP_OBJECTS_LANGUAGE_ID ||
    document.languageId === SC2_MAP_PRELOAD_LANGUAGE_ID
  ) {
    const objects = document.languageId === SC2_MAP_OBJECTS_LANGUAGE_ID
    walk(roots, node => {
      const links = objects
        ? (OBJECT_CATALOG_ATTRIBUTES.get(node.name) ?? [])
        : PRELOAD_TAG_LINKS.has(node.name)
          ? [{ attribute: PRELOAD_TAG_LINKS.get(node.name).attr, namespace: PRELOAD_TAG_LINKS.get(node.name).namespace }]
          : []
      for (const link of links) {
        const value = attribute(node, link.attribute)
        if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.value)) continue
        references.push({
          uri: document.uri,
          version: document.version,
          languageId: document.languageId,
          namespace: link.namespace,
          entityId: value.value,
          start: value.valueStart,
          end: value.valueEnd,
          source: objects ? `sc2map:Objects/${node.name}@${link.attribute}` : `sc2map:Preload/${node.name}@id`,
        })
      }
    })
    return
  }
  if (document.languageId === 'sc2-layout') {
    walk(roots, node => {
      for (const entry of node.attributes) {
        const match =
          /^@@?([A-Za-z][A-Za-z0-9]*)\/[A-Za-z][A-Za-z0-9_]*\/([A-Za-z_][A-Za-z0-9_]*)$/u.exec(
            entry.value,
          )
        if (match === null || !CATALOG_NAMESPACE_SET.has(match[1])) continue
        const entityId = match[2]
        references.push({
          uri: document.uri,
          version: document.version,
          languageId: document.languageId,
          namespace: match[1],
          entityId,
          start: entry.valueEnd - entityId.length,
          end: entry.valueEnd,
          source: 'sc2layout:@Namespace/Property/Id',
        })
      }
    })
  }
}

function stringLinks(document, references) {
  let lineStart = 0
  for (const rawLine of document.text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const equals = line.indexOf('=')
    const key = equals < 0 ? line : line.slice(0, equals)
    const match = /^([A-Za-z][A-Za-z0-9]*)\/.+\/([A-Za-z_][A-Za-z0-9_]*)$/u.exec(key)
    if (match !== null && CATALOG_NAMESPACE_SET.has(match[1])) {
      const entityId = match[2]
      references.push({
        uri: document.uri,
        version: document.version,
        languageId: document.languageId,
        namespace: match[1],
        entityId,
        start: lineStart + key.length - entityId.length,
        end: lineStart + key.length,
        source: 'sc2strings:catalog-key-suffix',
      })
    }
    lineStart += rawLine.length + 1
  }
}

const keyOf = (namespace, entityId) => `${namespace}/${entityId}`
const locationOf = item =>
  Object.freeze({ uri: item.uri, range: rangeAt(item.document, item.start, item.end) })

/*
 * The links each document contributes, kept per document object. A host that leaves its documents
 * with this worker between calls (retained call values) hands every request the same deep-frozen
 * object until its text changes, so a closure of hundreds of catalogs and scripts is parsed once
 * per revision instead of on every hover, lens or definition. Only frozen documents are kept: a
 * caller's mutable object could change under the cache. Kept items are never mutated; each index
 * copies the ones it uses.
 */
const documentLinksCache = new WeakMap()

/** One document's declarations, references, completion targets and partial spans. */
function documentLinks(document) {
  const cached = documentLinksCache.get(document)
  if (cached !== undefined) return cached
  const declarations = []
  const references = []
  const completionTargets = []
  const partial = []
  if (document.languageId === 'galaxy') galaxyLinks(document, references, completionTargets, partial)
  else if (document.languageId === 'sc2-strings') stringLinks(document, references)
  else if (SC2_MIXED_WORKSPACE_LANGUAGE_IDS.includes(document.languageId))
    xmlLinks(document, declarations, references, completionTargets, partial)
  const links = Object.freeze({ declarations, references, completionTargets, partial })
  if (Object.isFrozen(document)) documentLinksCache.set(document, links)
  return links
}

/** Prove locally whether a caret can address a catalog link before assembling the mixed graph. */
export function hasSc2CatalogLinkAt(document, offset) {
  const links = documentLinks(document)
  return [links.declarations, links.references, links.completionTargets].some(items =>
    items.some(item => item.start <= offset && offset <= item.end),
  )
}

/** A Data document's own usages (`parent`, linked fields), kept like `documentLinks`. */
const dataUsageCache = new WeakMap()

function documentDataUsages(document) {
  const cached = dataUsageCache.get(document)
  if (cached !== undefined) return cached
  const usages = Object.freeze(
    collectAllRefs(document.text)
      .filter(match => match.kind !== 'definition' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(match.id))
      .map(match =>
        Object.freeze({
          uri: document.uri,
          version: document.version,
          languageId: document.languageId,
          namespace: match.namespace,
          entityId: match.id,
          start: match.start,
          end: match.end,
          source: `sc2data:${match.kind}`,
        }),
      ),
  )
  if (Object.isFrozen(document)) dataUsageCache.set(document, usages)
  return usages
}

export function createSc2WorkspaceLinkIndex(request) {
  checkpoint(request.signal)
  const semanticIncomplete = languageWorkspaceIsSemanticallyIncomplete(request)
  if (
    !Array.isArray(request.workspaceDocuments) ||
    !Number.isSafeInteger(request.maxDocuments) ||
    request.maxDocuments < 1 ||
    request.maxDocuments > MAX_DOCUMENTS ||
    request.workspaceDocuments.length > request.maxDocuments
  )
    throw new RangeError('SC2 mixed language workspace exceeds maxDocuments')
  const documents = request.workspaceDocuments.some(item => item.uri === request.document.uri)
    ? request.workspaceDocuments
    : [request.document, ...request.workspaceDocuments]
  if (documents.length > request.maxDocuments)
    throw new RangeError('SC2 mixed language workspace exceeds maxDocuments')
  const byUri = new Map()
  let chars = 0
  for (const document of documents) {
    if (byUri.has(document.uri))
      throw new TypeError(`Duplicate mixed workspace document ${document.uri}`)
    if (document.text.length > MAX_DOCUMENT_CHARS)
      throw new RangeError(`${document.uri} exceeds the mixed workspace document bound`)
    chars += document.text.length
    if (chars > MAX_WORKSPACE_CHARS)
      throw new RangeError('SC2 mixed workspace exceeds the character bound')
    let starts
    byUri.set(document.uri, {
      ...document,
      // Only documents an answer points into need their lines.
      get __lineStarts() {
        return (starts ??= lineStarts(document.text))
      },
    })
  }
  const declarations = []
  const references = []
  const completionTargets = []
  const partial = []
  const hasCatalogDocuments = [...byUri.values()].some(
    document => document.languageId === 'sc2-data',
  )
  let unindexedDocuments = []
  for (const [documentIndex, document] of documents.entries()) {
    checkpoint(request.signal)
    if (!hasCatalogDocuments) break
    const links = documentLinks(document)
    for (const item of links.declarations) declarations.push({ ...item })
    for (const item of links.references) references.push({ ...item })
    for (const item of links.completionTargets) completionTargets.push(item)
    for (const item of links.partial) partial.push(item)
    if (declarations.length + references.length > MAX_LINKS) {
      partial.push({
        uri: document.uri,
        start: 0,
        end: Math.min(1, document.text.length),
        reason: 'link-bound-exceeded',
      })
      unindexedDocuments = documents.slice(documentIndex + 1)
      break
    }
  }
  const declarationsByKey = new Map()
  for (const item of declarations) {
    item.document = byUri.get(item.uri)
    const key = keyOf(item.namespace, item.entityId)
    const list = declarationsByKey.get(key) ?? []
    list.push(item)
    declarationsByKey.set(key, list)
  }
  for (const item of references) item.document = byUri.get(item.uri)
  if (semanticIncomplete)
    partial.push({
      uri: request.document.uri,
      start: 0,
      end: Math.min(1, request.document.text.length),
      reason: 'host-workspace-incomplete',
    })
  /*
   * GameData's own usages — a `parent`, a linked field — classified by the Data library's schema,
   * the same rules the Data provider renames by. Found only when a usage question is asked, so a
   * hover or a diagnostic pass does not walk every catalog.
   */
  let dataUsages
  const dataUsagesOf = () =>
    (dataUsages ??= documents
      .filter(document => document.languageId === 'sc2-data')
      .flatMap(document => {
        const lines = byUri.get(document.uri)
        return documentDataUsages(document).map(usage => ({ ...usage, document: lines }))
      }))
  // A bounded bulk graph must not hide a targeted read in the mod's later documents.
  // Reuse each document's owner parser; retain only matching usages, within the link bound.
  const literalUsagesOf = target => {
    const matches = references.filter(
      item => item.namespace === target.namespace && item.entityId === target.entityId,
    )
    for (const document of unindexedDocuments) {
      checkpoint(request.signal)
      for (const item of documentLinks(document).references) {
        if (matches.length >= MAX_LINKS) return matches
        if (item.namespace === target.namespace && item.entityId === target.entityId)
          matches.push({ ...item, document: byUri.get(item.uri) })
      }
    }
    return matches
  }
  const usagesOf = target => [
    ...literalUsagesOf(target),
    ...dataUsagesOf().filter(
      item => item.namespace === target.namespace && item.entityId === target.entityId,
    ),
  ]
  const selectedReference = (uri, offset) =>
    references.find(item => item.uri === uri && item.start <= offset && offset <= item.end) ??
    (byUri.get(uri)?.languageId === 'sc2-data'
      ? dataUsagesOf().find(item => item.uri === uri && item.start <= offset && offset <= item.end)
      : undefined)
  const selectedDeclaration = (uri, offset) =>
    declarations.find(item => item.uri === uri && item.start <= offset && offset <= item.end)
  const targetAt = (uri, offset) => {
    const reference = selectedReference(uri, offset)
    if (reference !== undefined)
      return { namespace: reference.namespace, entityId: reference.entityId }
    const declaration = selectedDeclaration(uri, offset)
    return declaration === undefined
      ? undefined
      : { namespace: declaration.namespace, entityId: declaration.entityId }
  }
  const definitionFor = target => {
    const candidates = declarationsByKey.get(keyOf(target.namespace, target.entityId)) ?? []
    return candidates.length === 1 ? candidates[0] : undefined
  }
  const locationsFor = (target, includeDeclaration) => {
    const result = []
    const definition = definitionFor(target)
    if (includeDeclaration && definition !== undefined) result.push(locationOf(definition))
    for (const item of usagesOf(target)) result.push(locationOf(item))
    return result
  }
  const indexIncomplete = semanticIncomplete || partial.length > 0
  const declarationsIncomplete = semanticIncomplete || partial.some(item => DECLARATION_GAPS.has(item.reason))
  return Object.freeze({
    provenance: SC2_WORKSPACE_LINK_PROVENANCE,
    declarations: Object.freeze(declarations),
    references: Object.freeze(references),
    isIncomplete: indexIncomplete,
    /** Whether a declaration may be missing: what a document's diagnostics are incomplete by. */
    diagnosticsIncomplete: declarationsIncomplete,
    targetAt(uri, offset) {
      const target = targetAt(uri, offset)
      return target === undefined ? undefined : Object.freeze(target)
    },
    completionsAt(uri, offset) {
      const target = completionTargets.find(
        item => item.uri === uri && item.start <= offset && offset <= item.end,
      )
      if (target === undefined) return undefined
      const document = byUri.get(uri)
      const prefix = document.text.slice(target.start, offset).toLocaleLowerCase()
      if (!/^\w*$/u.test(prefix)) return undefined
      const seen = new Set()
      const items = declarations
        .filter(
          item =>
            item.namespace === target.namespace &&
            item.entityId.toLocaleLowerCase().startsWith(prefix) &&
            !seen.has(item.entityId) &&
            seen.add(item.entityId),
        )
        .map(item =>
          Object.freeze({
            label: item.entityId,
            kind: 'enum',
            detail: `${item.typeId} in ${item.uri}`,
            insertText: item.entityId,
            sortText: `00:${item.entityId.toLocaleLowerCase()}`,
          }),
        )
      return Object.freeze({
        namespace: target.namespace,
        items: Object.freeze(items),
      })
    },
    definitionAt(uri, offset) {
      const target = targetAt(uri, offset)
      const definition = target === undefined ? undefined : definitionFor(target)
      return definition === undefined ? undefined : locationOf(definition)
    },
    referencesAt(uri, offset, includeDeclaration = false) {
      const target = targetAt(uri, offset)
      return Object.freeze(target === undefined ? [] : locationsFor(target, includeDeclaration))
    },
    referencesTo(namespace, entityId, includeDeclaration = false) {
      return Object.freeze(locationsFor({ namespace, entityId }, includeDeclaration))
    },
    renameAt(uri, offset, newName, maxEdits) {
      const target = targetAt(uri, offset)
      if (
        target === undefined ||
        semanticIncomplete ||
        partial.length > 0 ||
        // One rule for an entity id, the one the Data provider's own rename holds (plan 1.14).
        !SC2_ENTITY_ID.test(newName)
      )
        return undefined
      const declaration = definitionFor(target)
      if (declaration === undefined) return undefined
      const items = [declaration, ...usagesOf(target)]
      if (items.length === 0 || items.length > maxEdits) return undefined
      const grouped = new Map()
      for (const item of items) {
        const edits = grouped.get(item.uri) ?? []
        edits.push(Object.freeze({ range: rangeAt(item.document, item.start, item.end), newText: newName }))
        grouped.set(item.uri, edits)
      }
      return Object.freeze({
        documentChanges: Object.freeze(
          [...grouped.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([documentUri, edits]) =>
              Object.freeze({
                uri: documentUri,
                documentVersion: byUri.get(documentUri).version,
                edits: Object.freeze(edits),
              }),
            ),
        ),
        isComplete: true,
      })
    },
    hoverAt(uri, offset) {
      const target = targetAt(uri, offset)
      if (target === undefined) return undefined
      const definition = definitionFor(target)
      return Object.freeze({
        markdown: `**${target.namespace}/${target.entityId}** — literal StarCraft II catalog reference.${definition === undefined ? '\n\nNo unique declaration is present in the bounded workspace snapshot.' : `\n\nDeclared as \`${definition.typeId}\` in \`${definition.uri}\`.`}`,
        provenance: SC2_WORKSPACE_LINK_PROVENANCE,
      })
    },
    diagnosticsFor(uri) {
      const items = []
      for (const item of references.filter(candidate => candidate.uri === uri)) {
        const matches = declarationsByKey.get(keyOf(item.namespace, item.entityId)) ?? []
        // Missing where a declaration may be hidden means unknown, not a proven missing declaration.
        if (matches.length === 1 || semanticIncomplete || (matches.length === 0 && declarationsIncomplete)) continue
        items.push(
          Object.freeze({
            code:
              matches.length === 0
                ? 'sc2-cross-language/unresolved-catalog-literal'
                : 'sc2-cross-language/ambiguous-catalog-literal',
            message:
              matches.length === 0
                ? `${item.namespace}/${item.entityId} has no declaration in the bounded mixed workspace.`
                : `${item.namespace}/${item.entityId} has more than one declaration in the bounded mixed workspace.`,
            severity: 'warning',
            source: 'sc2-cross-language',
            range: rangeAt(item.document, item.start, item.end),
          }),
        )
      }
      for (const item of partial.filter(candidate => candidate.uri === uri))
        items.push(
          Object.freeze({
            code: `sc2-cross-language/${item.reason}`,
            message: `Cross-language catalog linking is partial: ${item.reason}.`,
            severity: 'information',
            source: 'sc2-cross-language',
            range: rangeAt(byUri.get(item.uri), item.start, item.end),
          }),
        )
      return Object.freeze(items)
    },
  })
}
