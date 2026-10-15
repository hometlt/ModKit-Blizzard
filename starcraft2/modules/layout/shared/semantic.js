import { parseXmlDocument } from './xml.js'

export const SC2_LAYOUT_PROVENANCE = Object.freeze({
  legacySource: 'modkit@1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
  schemaReference: 'SC2Mapster/sc2layout-schema@80ff763e735e20da8b826b1fa7e62e8ea49b92ed',
})

const valueEntry = (node, name) => node.attributeEntries.find(entry => entry.name === name)
const sourceRange = entry => ({ start: entry.valueStart, end: entry.valueEnd })

function propertyOf(node) {
  return Object.freeze({
    name: node.tag,
    val: node.attributes.val,
    attrs: node.attributes,
    node,
  })
}

function stateGroupOf(node) {
  const states = []
  let defaultState
  for (const child of node.children) {
    if (child.tag === 'DefaultState') defaultState = child.attributes.val
    if (child.tag !== 'State') continue
    const whens = []
    const actions = []
    for (const item of child.children) {
      if (item.tag === 'When') whens.push(Object.freeze({ ...item.attributes, node: item }))
      if (item.tag === 'Action') actions.push(Object.freeze({ ...item.attributes, node: item }))
    }
    states.push(
      Object.freeze({
        name: child.attributes.name ?? '',
        whens: Object.freeze(whens),
        actions: Object.freeze(actions),
        node: child,
      }),
    )
  }
  return Object.freeze({
    name: node.attributes.name ?? '',
    ...(defaultState === undefined ? {} : { defaultState }),
    states: Object.freeze(states),
    node,
  })
}

function referencesFromNode(node, ownerPath, out) {
  for (const entry of node.attributeEntries) {
    const value = entry.value
    let kind
    if (node.tag === 'Include' && entry.name === 'path') kind = 'include'
    else if (node.tag === 'Frame' && entry.name === 'template') kind = 'template'
    else if (node.tag === 'Frame' && entry.name === 'file') kind = 'file'
    else if (value.startsWith('#')) kind = 'constant'
    else if (value.startsWith('@') || value.startsWith('*@')) kind = 'alias'
    else if (entry.name === 'relative' || entry.name === 'frame') kind = 'frame'
    if (kind !== undefined) {
      out.push(
        Object.freeze({
          kind,
          target: value,
          ownerPath,
          node,
          attribute: entry,
          range: sourceRange(entry),
        }),
      )
    }
  }
}

function referencesFromTree(node, ownerPath, out) {
  referencesFromNode(node, ownerPath, out)
  for (const child of node.children) referencesFromTree(child, ownerPath, out)
}

function frameOf(node, parentPath, references) {
  const name = node.attributes.name ?? ''
  const path = parentPath === '' ? name : `${parentPath}/${name}`
  const anchors = []
  const properties = []
  const animations = []
  const stateGroups = []
  const children = []
  referencesFromNode(node, path, references)
  for (const child of node.children) {
    if (child.tag === 'Frame') children.push(frameOf(child, path, references))
    else if (child.tag === 'Anchor') {
      // `relative=` names a frame and `offset=` may name a constant: both are references.
      referencesFromNode(child, path, references)
      anchors.push(Object.freeze({ ...child.attributes, node: child }))
    }
    else {
      referencesFromNode(child, path, references)
      if (child.tag === 'Animation')
        animations.push(Object.freeze({ name: child.attributes.name ?? '', node: child }))
      else if (child.tag === 'StateGroup') {
        stateGroups.push(stateGroupOf(child))
        for (const nested of child.children) referencesFromTree(nested, path, references)
      } else if (!['Include', 'Constant', 'DescFlags', 'RequiredDefines'].includes(child.tag))
        properties.push(propertyOf(child))
    }
  }
  return Object.freeze({
    name,
    type: node.attributes.type ?? 'Frame',
    ...(node.attributes.template === undefined ? {} : { template: node.attributes.template }),
    ...(node.attributes.file === undefined ? {} : { file: node.attributes.file }),
    path,
    anchors: Object.freeze(anchors),
    properties: Object.freeze(properties),
    animations: Object.freeze(animations),
    stateGroups: Object.freeze(stateGroups),
    children: Object.freeze(children),
    node,
  })
}

function fileStem(uri) {
  const value = uri.replaceAll('\\', '/').split('/').at(-1) ?? uri
  return value.replace(/\.SC2Layout$/iu, '')
}

export function semanticLayout(parsed) {
  const desc = parsed.roots.find(node => node.tag === 'Desc')
  const diagnostics = [...parsed.diagnostics]
  if (desc === undefined) {
    diagnostics.push(
      Object.freeze({
        code: 'sc2-layout/root',
        message: 'SC2Layout root must be Desc.',
        severity: 'error',
        start: 0,
        end: Math.min(parsed.document.text.length, 1),
      }),
    )
  }
  const includes = []
  const constants = []
  const frames = []
  const animations = []
  const stateGroups = []
  const references = []
  for (const node of desc?.children ?? []) {
    referencesFromNode(node, '', references)
    if (node.tag === 'Include')
      includes.push(Object.freeze({ path: node.attributes.path ?? '', node }))
    else if (node.tag === 'Constant')
      constants.push(
        Object.freeze({ name: node.attributes.name ?? '', val: node.attributes.val ?? '', node }),
      )
    else if (node.tag === 'Frame') frames.push(frameOf(node, '', references))
    else if (node.tag === 'Animation')
      animations.push(Object.freeze({ name: node.attributes.name ?? '', node }))
    else if (node.tag === 'StateGroup') {
      stateGroups.push(stateGroupOf(node))
      for (const nested of node.children) referencesFromTree(nested, '', references)
    }
  }
  return Object.freeze({
    uri: parsed.document.uri,
    version: parsed.document.version,
    fileName: fileStem(parsed.document.uri),
    parsed,
    includes: Object.freeze(includes),
    constants: Object.freeze(constants),
    frames: Object.freeze(frames),
    animations: Object.freeze(animations),
    stateGroups: Object.freeze(stateGroups),
    references: Object.freeze(references),
    diagnostics: Object.freeze(diagnostics),
  })
}

function normalizePath(value) {
  const items = []
  for (const item of value.replaceAll('\\', '/').split('/')) {
    if (item === '' || item === '.') continue
    if (item === '..') items.pop()
    else items.push(item)
  }
  return items.join('/').toLowerCase()
}

function importCandidates(layout, includePath) {
  const normalized = normalizePath(includePath)
  const withExtension = normalized.endsWith('.sc2layout') ? normalized : `${normalized}.sc2layout`
  return [normalized, withExtension, withExtension.split('/').at(-1)]
}

function collectFrames(frame, out) {
  out.push(frame)
  for (const child of frame.children) collectFrames(child, out)
}

function declaration(kind, name, layout, node, path = name) {
  const entry = valueEntry(node, 'name') ?? valueEntry(node, 'path')
  return Object.freeze({
    kind,
    name,
    path,
    uri: layout.uri,
    version: layout.version,
    node,
    range: entry === undefined ? { start: node.start, end: node.openEnd } : sourceRange(entry),
  })
}

/*
 * A document's semantic layout by its version, text and bounds, kept between workspaces: a language
 * request builds the workspace of every layout in its snapshot (Core alone holds 377) while only the
 * edited one changed (parity plan 3.31). Bounded; the least recently used goes first.
 */
const parsedLayouts = new Map()
const MAX_PARSED_LAYOUTS = 2_048

async function cachedSemanticLayout(document, request, signal) {
  const bounds = JSON.stringify([request.maxChars, request.maxNodes, request.maxDepth, request.maxDiagnostics])
  const cached = parsedLayouts.get(document.uri)
  parsedLayouts.delete(document.uri)
  if (
    cached !== undefined &&
    cached.version === document.version &&
    cached.bounds === bounds &&
    cached.text === document.text
  ) {
    parsedLayouts.set(document.uri, cached)
    return cached.layout
  }
  const layout = semanticLayout(await parseXmlDocument(document, request, signal))
  parsedLayouts.set(document.uri, { version: document.version, bounds, text: document.text, layout })
  while (parsedLayouts.size > MAX_PARSED_LAYOUTS) parsedLayouts.delete(parsedLayouts.keys().next().value)
  return layout
}

export async function createLayoutWorkspace(documents, request, signal) {
  if (
    !Number.isSafeInteger(request.maxDocuments) ||
    request.maxDocuments < 1 ||
    documents.length > request.maxDocuments
  )
    throw new RangeError('SC2Layout workspace exceeds maxDocuments')
  const seen = new Set()
  const layouts = []
  let totalChars = 0
  for (const document of documents) {
    signal?.throwIfAborted()
    if (seen.has(document.uri)) throw new TypeError(`Duplicate SC2Layout document ${document.uri}`)
    seen.add(document.uri)
    totalChars += document.text.length
    if (totalChars > request.maxWorkspaceChars)
      throw new RangeError('SC2Layout workspace exceeds maxWorkspaceChars')
    layouts.push(await cachedSemanticLayout(document, request, signal))
  }
  const byUri = new Map(layouts.map(layout => [layout.uri, layout]))
  const normalizedUris = layouts.map(layout => normalizePath(layout.uri))
  const byNormalizedUri = new Map(layouts.map((layout, index) => [normalizedUris[index], layout]))
  const resolveInclude = (layout, path) => {
    const candidates = importCandidates(layout, path)
    return layouts.find((candidate, index) => {
      const normalizedUri = normalizedUris[index]
      return candidates.some(
        item =>
          normalizedUri === item ||
          normalizedUri.endsWith(`/${item}`) ||
          normalizedUri.endsWith(item),
      )
    })
  }
  const declarations = []
  const frameLayouts = new Map()
  const allFrames = []
  for (const layout of layouts) {
    for (const include of layout.includes)
      declarations.push(declaration('module', include.path, layout, include.node))
    for (const constant of layout.constants)
      declarations.push(declaration('constant', constant.name, layout, constant.node))
    for (const animation of layout.animations)
      declarations.push(declaration('variable', animation.name, layout, animation.node))
    for (const group of layout.stateGroups)
      declarations.push(declaration('enum', group.name, layout, group.node))
    const frames = []
    for (const frame of layout.frames) collectFrames(frame, frames)
    for (const frame of frames) {
      allFrames.push(frame)
      frameLayouts.set(frame, layout)
      declarations.push(declaration('struct', frame.name, layout, frame.node, frame.path))
    }
  }
  /*
   * Every reference resolves through a layout's include closure and frames, so the workspace answers
   * those per layout once (it is immutable) instead of on every call: a mod closure resolves tens of
   * thousands of references against a few hundred layouts. Lookups compare lower-cased paths and
   * names through per-layout tables; the frame order inside a table is the collection order.
   */
  const importedByLayout = new Map()
  const importedLayouts = layout => {
    const known = importedByLayout.get(layout)
    if (known !== undefined) return known
    const out = []
    const queued = [layout]
    const visited = new Set()
    while (queued.length > 0) {
      const current = queued.shift()
      if (visited.has(current.uri)) continue
      visited.add(current.uri)
      out.push(current)
      for (const include of current.includes) {
        const imported = resolveInclude(current, include.path)
        if (imported !== undefined) queued.push(imported)
      }
    }
    const frozen = Object.freeze(out)
    importedByLayout.set(layout, frozen)
    return frozen
  }
  const framesByLayout = new Map()
  const framesFor = layout => {
    const known = framesByLayout.get(layout)
    if (known !== undefined) return known
    const frames = []
    for (const candidate of importedLayouts(layout))
      for (const frame of candidate.frames) collectFrames(frame, frames)
    const frozen = Object.freeze(frames)
    framesByLayout.set(layout, frozen)
    return frozen
  }
  const layoutsByStem = new Map()
  for (const candidate of layouts) {
    const stem = candidate.fileName.toLowerCase()
    layoutsByStem.set(stem, [...(layoutsByStem.get(stem) ?? []), candidate])
  }
  const append = (table, key, value) => {
    const list = table.get(key)
    if (list === undefined) table.set(key, [value])
    else list.push(value)
  }
  // One layout's own frames by lower-cased path and name, and its constants by lower-cased name.
  const tablesByLayout = new Map()
  const tablesOf = candidate => {
    const known = tablesByLayout.get(candidate)
    if (known !== undefined) return known
    const framePaths = new Map()
    const frameNames = new Map()
    const frames = []
    for (const frame of candidate.frames) collectFrames(frame, frames)
    for (const frame of frames) {
      append(framePaths, frame.path.toLowerCase(), frame)
      append(frameNames, frame.name.toLowerCase(), frame)
    }
    const constantNames = new Map()
    for (const constant of candidate.constants) append(constantNames, constant.name.toLowerCase(), constant)
    const tables = { framePaths, frameNames, constantNames }
    tablesByLayout.set(candidate, tables)
    return tables
  }
  /** The one entry named `key` across `candidates` in their order; none or several give undefined. */
  const single = (candidates, table, key) => {
    let found
    for (const candidate of candidates) {
      const list = tablesOf(candidate)[table].get(key)
      if (list === undefined) continue
      if (found !== undefined || list.length > 1) return undefined
      found = list[0]
    }
    return found
  }
  /**
   * `template="StandardTemplates/StandardSmallPanelTemplate"` names a file and a frame inside it.
   * The game resolves that against every layout the mod loads, not only the files this one includes,
   * so a file-qualified target is looked up by file name across the workspace first. Unqualified
   * names keep the narrower include scope, and an ambiguous file or frame resolves to nothing rather
   * than to a guess.
   */
  const resolveFrame = (layout, target) => {
    const normalized = target
      .replace(/^\*?@@?/u, '')
      .replace(/^\//u, '')
      .toLowerCase()
    const parts = normalized.split('/').filter(Boolean)
    const imported = importedLayouts(layout)
    const exact = single(imported, 'framePaths', normalized)
    if (exact !== undefined) return exact
    if (parts.length > 1) {
      const withoutFile = parts.slice(1).join('/')
      const qualified = single(imported, 'framePaths', withoutFile)
      if (qualified !== undefined) return qualified
      const named = layoutsByStem.get(parts[0]) ?? []
      if (named.length === 1) {
        const byPath = single(named, 'framePaths', withoutFile)
        if (byPath !== undefined) return byPath
        const byLeaf = single(named, 'frameNames', parts.at(-1))
        if (byLeaf !== undefined) return byLeaf
      }
    }
    return single(imported, 'frameNames', parts.at(-1))
  }
  /**
   * `#Name` and the racial `##Name` both name a constant the game looks up across every layout the
   * mod loads, so a name the including files do not declare falls back to the whole workspace.
   */
  const resolveConstant = (layout, target) => {
    const name = target.replace(/^#{1,2}/u, '').toLowerCase()
    return single(importedLayouts(layout), 'constantNames', name) ?? single(layouts, 'constantNames', name)
  }
  return Object.freeze({
    layouts: Object.freeze(layouts),
    allFrames: Object.freeze(allFrames),
    byUri,
    byNormalizedUri,
    declarations: Object.freeze(declarations),
    resolveInclude,
    importedLayouts,
    framesFor,
    resolveFrame,
    resolveConstant,
    layoutForFrame: frame => frameLayouts.get(frame),
    provenance: SC2_LAYOUT_PROVENANCE,
  })
}

export const defaultLayoutBounds = Object.freeze({
  maxChars: 2 * 1024 * 1024,
  maxWorkspaceChars: 64 * 1024 * 1024,
  // Core alone holds 377 layouts, and a template names one in any of them.
  maxDocuments: 4_096,
  maxNodes: 100_000,
  maxDepth: 64,
  maxDiagnostics: 1_000,
})
