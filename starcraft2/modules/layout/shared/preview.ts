// @ts-nocheck -- protocol adapter over the typed Layout runtime; emitted as preview.js.
import {
  GAME_TEMPLATE_PREVIEW_OPERATION_ID,
  GAME_TEMPLATE_PREVIEW_SCHEMA_VERSION,
} from '@modkit/sdk/templates'
import { createLayoutWorkspace, defaultLayoutBounds } from './semantic.js'
import { resolveLayoutVisualSnapshot } from './runtime.js'

/** Without the mod's strings and styles a frame's text is drawn as written. */
const TEXT_AS_WRITTEN = () => Object.freeze({ runs: Object.freeze([]) })

function sourceOfResolved(source) {
  return Object.freeze({
    uri: source.uri,
    start: source.start,
    end: source.end,
    origin: source.contribution.origin,
    frame: source.contribution.descFqn,
  })
}

function publicTree(root, rects, resolveValue, resolveText) {
  const templateOf = frame => [...frame.contributions].reverse().find(item => item.origin === 'template')
  const resolvedOf = item => {
    if (item.val === undefined) return undefined
    if (item.tag.toLowerCase() === 'text') return resolveText(item.val, undefined).resolved
    return item.val.trim().startsWith('#') ? resolveValue(item.val) : undefined
  }
  const visit = frame =>
    Object.freeze({
      name: frame.name,
      type: frame.type,
      ...(templateOf(frame)?.via === undefined ? {} : { template: templateOf(frame).via }),
      path: Object.freeze([...frame.path]),
      // The frame's strongest declaration: "Show in Text Editor" selects it, the cursor in it
      // reveals this node (parity plan 3.33).
      ...(frame.source === undefined ? {} : { source: sourceOfResolved(frame.source) }),
      rect: rects.get(frame),
      properties: Object.freeze(
        [...frame.properties.values()].map(item =>
          Object.freeze({
            name: item.tag,
            ...(item.val === undefined ? {} : { val: item.val }),
            ...(resolvedOf(item) === undefined ? {} : { resolved: resolvedOf(item) }),
            attrs: item.attrs,
            source: sourceOfResolved(item.source),
          }),
        ),
      ),
      anchors: Object.freeze(
        Object.values(frame.anchors).map(item =>
          Object.freeze({
            side: item.side,
            ...(item.relative === undefined ? {} : { relative: item.relative }),
            ...(item.pos === undefined ? {} : { pos: item.pos }),
            ...(item.offset === undefined ? {} : { offset: item.offset }),
            source: sourceOfResolved(item.source),
          }),
        ),
      ),
      stateGroups: Object.freeze(
        frame.stateGroups.map(group =>
          Object.freeze({
            name: group.name,
            ...(group.defaultState === undefined ? {} : { defaultState: group.defaultState }),
            states: Object.freeze(
              group.states.map(state =>
                Object.freeze({
                  name: state.name,
                  whens: Object.freeze(state.whens),
                  actions: Object.freeze(state.actions),
                }),
              ),
            ),
          }),
        ),
      ),
      sources: Object.freeze(frame.contributions.map(item => ({
        origin: item.origin,
        frame: item.descFqn,
        ...(item.via === undefined ? {} : { via: item.via }),
      }))),
      diagnostics: Object.freeze(frame.diagnostics),
      children: Object.freeze(frame.children.map(visit)),
    })
  return visit(root)
}

function displayItems(root, display, resolveText) {
  const frames = new Map()
  const collect = frame => {
    frames.set(frame.path.join('/'), frame)
    for (const child of frame.children) collect(child)
  }
  collect(root)
  return Object.freeze(display.items.map(item => {
    const frame = frames.get(item.descPath.join('/'))
    const rawText = frame?.properties.get('text')?.val
    const runs = rawText === undefined
      ? []
      : resolveText(rawText, frame?.properties.get('style')?.val).runs
    const asset = item.kind === 'image' && item.asset !== undefined
      ? `${item.asset.kind === 'alias' ? '@' : ''}${item.asset.value}`
      : undefined
    return Object.freeze({
      ...item,
      path: Object.freeze([...item.descPath]),
      ...(rawText === undefined ? {} : { text: runs.length > 0 ? runs : rawText }),
      ...(asset === undefined ? {} : { asset }),
      sources: Object.freeze(frame?.contributions.map(contribution => ({
        origin: contribution.origin,
        frame: contribution.descFqn,
      })) ?? []),
    })
  }))
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function digest(value) {
  const source = stable(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return Object.freeze({ algorithm: 'fnv1a-32', value: hash.toString(16).padStart(8, '0') })
}

function countTree(root) {
  let count = 1
  for (const child of root.children) count += countTree(child)
  return count
}

export async function previewSc2Layout(input, signal, options = {}) {
  signal?.throwIfAborted()
  const hardBounds = Object.freeze({ ...defaultLayoutBounds, ...(input.hardBounds ?? {}) })
  const bounds = Object.freeze({
    maxChars: Math.min(defaultLayoutBounds.maxChars, hardBounds.maxChars),
    maxWorkspaceChars: Math.min(
      defaultLayoutBounds.maxWorkspaceChars,
      hardBounds.maxWorkspaceChars,
    ),
    maxDocuments: Math.min(defaultLayoutBounds.maxDocuments, hardBounds.maxDocuments),
    maxDepth: Math.min(defaultLayoutBounds.maxDepth, hardBounds.maxDepth),
    maxNodes: Math.min(
      input.maxNodes ?? defaultLayoutBounds.maxNodes,
      defaultLayoutBounds.maxNodes,
      hardBounds.maxNodes,
    ),
    maxDiagnostics: Math.min(
      input.maxDiagnostics ?? defaultLayoutBounds.maxDiagnostics,
      defaultLayoutBounds.maxDiagnostics,
      hardBounds.maxDiagnostics,
    ),
  })
  if (
    !Number.isSafeInteger(bounds.maxNodes) ||
    bounds.maxNodes < 1 ||
    !Number.isSafeInteger(bounds.maxDiagnostics) ||
    bounds.maxDiagnostics < 1
  )
    throw new RangeError('SC2Layout preview bounds are invalid')
  const snapshot = input.workspaceDocuments ?? [input.document]
  // Only layouts are layouts: a host snapshot also carries the style sheets and strings text uses.
  const workspaceDocuments = snapshot.filter(
    item =>
      item.uri === input.document.uri ||
      item.languageId === 'sc2-layout' ||
      /\.sc2layout$/iu.test(item.uri),
  )
  const documents = workspaceDocuments.some(item => item.uri === input.document.uri)
    ? workspaceDocuments
    : [input.document, ...workspaceDocuments]
  const workspace = await createLayoutWorkspace(documents, bounds, signal)
  const layout = workspace.byUri.get(input.document.uri)
  if (layout === undefined)
    throw new TypeError('SC2Layout entry document is missing from workspace')
  const selectedPath = input.rootPath ?? layout.frames[0]?.name
  if (selectedPath === undefined)
    throw new TypeError(`SC2Layout root ${input.rootPath ?? '(first frame)'} was not found`)
  const viewport = input.viewport ?? { width: 1600, height: 1200 }
  const visual = resolveLayoutVisualSnapshot({
    documents: workspace.layouts.map(item => item.parsed.document),
    entryUri: layout.uri,
    rootPath: selectedPath,
    viewport,
    states: input.states ?? {},
    includeHidden: input.includeHidden,
    maxDepth: bounds.maxDepth,
    maxNodes: bounds.maxNodes,
  })
  const root = visual.root
  signal?.throwIfAborted()
  const resolveText = options.resolveText ?? TEXT_AS_WRITTEN
  const tree = publicTree(root, visual.solved.rects, visual.resolveValue, resolveText)
  const items = displayItems(root, visual.display, resolveText)
  const includeDiagnostics = layout.includes
    .filter(include => workspace.resolveInclude(layout, include.path) === undefined)
    .map(include => ({
      code: 'unresolved-include',
      message: `Include ${include.path} was not found in the bounded workspace snapshot.`,
    }))
  const unsupported = [
    ...visual.diagnostics,
    ...includeDiagnostics,
    ...layout.diagnostics,
  ]
  const report = Object.freeze({
    schemaVersion: GAME_TEMPLATE_PREVIEW_SCHEMA_VERSION,
    operationId: GAME_TEMPLATE_PREVIEW_OPERATION_ID,
    candidateContract: 'blizzard/game-template-preview-candidate@1',
    templateKind: input.templateKind ?? 'sc2-layout',
    entryUri: layout.uri,
    rootPath: root.path.join('/'),
    roots: Object.freeze(layout.frames.map(frame => frame.name)),
    viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
    resolvedTree: tree,
    displayItems: items,
    diagnostics: Object.freeze(unsupported.slice(0, bounds.maxDiagnostics)),
    completeness: unsupported.length === 0 ? 'complete' : 'partial',
    fidelity: Object.freeze({
      comparison: 'semantic',
      resolvedFrames: countTree(root),
      displayItems: items.length,
      sourceDocuments: workspace.layouts.length,
      resolvedText: options.resolveText !== undefined,
      sourceWriting: 'normal-editor-complete-snapshot-writer',
      unsupported: Object.freeze(unsupported.map(item => item.code)),
    }),
    provenance: workspace.provenance,
  })
  return Object.freeze({ ...report, digest: digest(report) })
}

export async function previewSc2TechTree(input, signal, options) {
  return previewSc2Layout({ ...input, templateKind: 'sc2-tech-tree-v1' }, signal, options)
}
