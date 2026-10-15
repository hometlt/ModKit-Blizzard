import { Store } from './layout-engine/sc2-layout-core/index/store.js'
import { DescKind, type DescNamespace } from './layout-engine/sc2-layout-core/index/desc.js'
import { createTreeDataSource, type InspectionTreeNode } from '@modkit/codec-kit'
import { LayoutChecker } from './layout-engine/sc2-layout-core/index/checker.js'
import { UIBuilder, UINavigator } from './layout-engine/sc2-layout-core/index/hierarchy.js'
import { ExpressionParser } from './layout-engine/sc2-layout-core/parser/expressions.js'
import type { Sc2LayoutDocument } from './format/document.js'
import {
  getResolvedDescendant,
  resolveFrameByPath,
} from './format/rendering/resolve/resolve.js'
import { resolvePropertyValue } from './format/rendering/resolve/constants.js'
import type {
  ResolvedFrame,
  ResolvedProperty,
} from './format/rendering/resolve/types.js'
import { applyStateGroups } from './format/rendering/states/apply.js'
import { solveLayout } from './format/rendering/solve/solver.js'
import { evaluateExpressions } from './format/rendering/expr/evaluate.js'
import { buildDisplayList } from './format/rendering/model/build.js'
import { parseColor } from './format/rendering/model/color.js'
import { emitHtml } from './format/rendering/emit/html.js'
import { layoutSchemaRegistry } from './schema-registry.js'

export const SC2_LAYOUT_PROVENANCE = Object.freeze({
  legacySource: 'modkit@1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
  schemaDataBlob: 'ff3c4e77c8dff63c5fd133dd00c711dc22d2e61b',
  schemaDataSha256: 'b2fb2c1302c9338a66a1d6787b19206eaf4bc38676ccd59de83ceb37275dba1f',
})

export interface LayoutRuntimeDocument {
  readonly uri: string
  readonly text: string
  readonly version?: number
}

interface RuntimeInput {
  readonly documents?: readonly LayoutRuntimeDocument[]
  readonly rootPath?: string
  readonly descendantPath?: readonly string[]
  readonly viewport?: { readonly width?: number; readonly height?: number }
  readonly states?: Readonly<Record<string, string>>
  readonly includeHidden?: boolean
  readonly selector?: string
  readonly completionPrefix?: string
}

export interface LayoutVisualSnapshotInput {
  readonly documents: readonly LayoutRuntimeDocument[]
  readonly entryUri: string
  readonly rootPath: string
  readonly descendantPath?: readonly string[]
  readonly viewport?: { readonly width?: number; readonly height?: number }
  readonly states?: Readonly<Record<string, string>>
  readonly includeHidden?: boolean
  readonly maxDepth?: number
  readonly maxNodes?: number
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined
}

function inputOf(value: unknown): RuntimeInput {
  const raw = record(value)
  const rawDocuments = Array.isArray(raw['documents']) ? raw['documents'] : undefined
  const documents = rawDocuments?.map((item, index): LayoutRuntimeDocument => {
    const document = record(item)
    if (typeof document['uri'] !== 'string' || typeof document['text'] !== 'string') {
      throw new TypeError(`SC2Layout workspace document ${index} requires uri and text`)
    }
    return {
      uri: document['uri'],
      text: document['text'],
      ...(Number.isSafeInteger(document['version'])
        ? { version: document['version'] as number }
        : {}),
    }
  })
  const viewport = record(raw['viewport'])
  const states = record(raw['states'])
  return {
    ...(documents === undefined ? {} : { documents }),
    ...(typeof raw['rootPath'] === 'string' ? { rootPath: raw['rootPath'] } : {}),
    ...(strings(raw['descendantPath']) === undefined
      ? {}
      : { descendantPath: strings(raw['descendantPath']) }),
    ...(viewport['width'] === undefined && viewport['height'] === undefined
      ? {}
      : {
          viewport: {
            ...(typeof viewport['width'] === 'number' ? { width: viewport['width'] } : {}),
            ...(typeof viewport['height'] === 'number' ? { height: viewport['height'] } : {}),
          },
        }),
    ...(Object.values(states).every(item => typeof item === 'string')
      ? { states: states as Readonly<Record<string, string>> }
      : {}),
    ...(typeof raw['includeHidden'] === 'boolean'
      ? { includeHidden: raw['includeHidden'] }
      : {}),
    ...(typeof raw['selector'] === 'string' ? { selector: raw['selector'] } : {}),
    ...(typeof raw['completionPrefix'] === 'string'
      ? { completionPrefix: raw['completionPrefix'] }
      : {}),
  }
}

function stem(uri: string): string {
  const clean = uri.replaceAll('\\', '/').split(/[?#]/u, 1)[0] ?? uri
  const leaf = clean.slice(clean.lastIndexOf('/') + 1)
  return leaf.replace(/\.sc2layout$/iu, '')
}

function workspace(document: Sc2LayoutDocument, value: unknown) {
  const input = inputOf(value)
  const primary: LayoutRuntimeDocument = {
    uri: document.source.path,
    text: document.text,
    version: 1,
  }
  const documents = [...(input.documents ?? [])]
  const primaryIndex = documents.findIndex(item => item.uri === primary.uri)
  if (primaryIndex < 0) documents.push(primary)
  else documents[primaryIndex] = primary
  const store = new Store(layoutSchemaRegistry())
  for (const item of documents) store.updateDocument(item.uri, item.text, item.version ?? 1)
  return { input, store, documents, primary }
}

/** Desc structure and declaration locations from the same index used by Layout resolution. */
export function createSc2LayoutStructureTree(document: Sc2LayoutDocument) {
  const { store } = workspace(document, {})
  const file = store.index.rootNs.get(stem(document.source.path))
  const schemaOf = (desc: DescNamespace): readonly InspectionTreeNode[] => {
    if (desc.kind !== DescKind.Frame || desc.stype === undefined) return []
    const frameType = store.schema.getFrameType(desc.stype)
    if (frameType === undefined) return []
    return [{
      kind: 'schema',
      label: 'Schema',
      preview: frameType.name,
      value: { frameType: frameType.name, blizzardOnly: frameType.blizzOnly },
      hasChildren: true,
      children: () => [
        {
          kind: 'hookups',
          label: 'Hookups',
          preview: `${frameType.hookups.size}`,
          children: () => [...frameType.hookups.values()].map(hookup => ({
            kind: 'hookup',
            label: hookup.path,
            preview: `${hookup.fClass.name} (${hookup.required ? 'required' : 'optional'})`,
            value: { path: hookup.path, frameClass: hookup.fClass.name, required: hookup.required },
          })),
        },
        ...store.schema.getFrameDescs(frameType).map(description => ({
          kind: 'description-structure',
          label: description.name,
          preview: `${description.struct.size} fields`,
          children: () => [...description.struct.values()].map(field => ({
            kind: 'schema-field',
            label: field.name,
            preview: field.type.name,
            value: {
              name: field.name,
              type: field.type.name,
              ...(field.label === undefined ? {} : { label: field.label }),
              ...(field.documentation === undefined ? {} : { description: field.documentation }),
            },
          })),
        })),
        ...[...frameType.fclasses.values()].map(frameClass => ({
          kind: 'frame-class',
          label: frameClass.name,
          preview: `${frameClass.properties.size} properties`,
          children: () => [...frameClass.properties.values()].map(property => ({
            kind: 'schema-property',
            label: property.name,
            preview: `${property.etype.type.name}${property.isReadonly ? ' (read-only)' : ''}`,
            value: {
              name: property.name,
              type: property.etype.type.name,
              readOnly: property.isReadonly,
              ...(property.etype.label === undefined ? {} : { label: property.etype.label }),
              ...(property.etype.documentation === undefined ? {} : { description: property.etype.documentation }),
            },
          })),
        })),
      ],
    }]
  }
  const nodeOf = (desc: DescNamespace): InspectionTreeNode => ({
    kind:
      desc.kind === DescKind.StateGroup
        ? 'state-group'
        : desc.kind === DescKind.Animation
          ? 'animation'
          : 'frame',
    label: desc.name,
    ...(desc.stype === undefined ? {} : { preview: desc.stype.name }),
    semanticPath: desc.fqn.split('/'),
    subjectId: document.source.path,
    hasChildren: desc.children.size > 0 || (desc.kind === DescKind.Frame && desc.stype !== undefined),
    children: () => [...[...desc.children.values()].map(nodeOf), ...schemaOf(desc)],
  })
  const tree = createTreeDataSource({
    kind: 'layout',
    label: 'SC2 Desc layout',
    preview: `${document.stats.frameCount} frame(s)`,
    children: () => [...(file?.children.values() ?? [])].map(nodeOf),
    hasChildren: (file?.children.size ?? 0) > 0,
  })
  return Object.freeze({
    ...tree,
    async facts(node: Parameters<typeof tree.facts>[0]) {
      const facts = await tree.facts(node)
      const desc =
        facts.semanticPath === undefined
          ? undefined
          : store.index.rootNs.getMulti(...facts.semanticPath)
      const declaration = desc?.xDecls.values().next().value
      const text = declaration?.getDocument().lang.tdoc
      if (declaration === undefined || text === undefined) return facts
      const position = text.positionAt(declaration.start)
      return Object.freeze({
        ...facts,
        range: {
          utf16Offset: declaration.start,
          utf16Length: declaration.end - declaration.start,
          line: position.line,
          column: position.character,
        },
      })
    },
  })
}

function resolveRootInStore(
  store: Store,
  entryUri: string,
  requested: string,
  descendantPath?: readonly string[],
  limits: { readonly maxDepth?: number; readonly maxNodes?: number } = {},
): ResolvedFrame {
  const candidates = requested.includes('/')
    ? [requested, `${stem(entryUri)}/${requested}`]
    : [`${stem(entryUri)}/${requested}`, requested]
  let frame: ResolvedFrame | undefined
  for (const candidate of candidates) {
    frame = resolveFrameByPath(store, candidate, limits)
    if (frame !== undefined) break
  }
  if (frame === undefined) throw new RangeError(`SC2Layout frame path was not resolved: ${requested}`)
  if (descendantPath !== undefined) {
    frame = getResolvedDescendant(frame, descendantPath)
    if (frame === undefined) {
      throw new RangeError(`SC2Layout descendant path was not resolved: ${descendantPath.join('/')}`)
    }
  }
  return frame
}

function findRoot(document: Sc2LayoutDocument, store: Store, input: RuntimeInput): ResolvedFrame {
  const requested = input.rootPath ?? document.data.frames[0]?.name
  if (requested === undefined) throw new RangeError('SC2Layout document has no frame to resolve')
  return resolveRootInStore(store, document.source.path, requested, input.descendantPath)
}

/** Reuse the Layout owner's template/hookup resolver across resource-tree expansions. */
export function createSc2LayoutResourceResolver(documents: readonly LayoutRuntimeDocument[]) {
  const store = new Store(layoutSchemaRegistry())
  for (const item of documents) store.updateDocument(item.uri, item.text, item.version ?? 1)
  const roots = new Map<string, ResolvedFrame>()
  return Object.freeze({
    frame(entryUri: string, rootPath: string, descendantPath: readonly string[] = []): ResolvedFrame {
      const key = `${entryUri}\0${rootPath}`
      let root = roots.get(key)
      if (root === undefined) {
        root = resolveRootInStore(store, entryUri, rootPath, undefined,
          { maxDepth: 32, maxNodes: 2_000 })
        roots.set(key, root)
      }
      const selected = descendantPath.length === 0 ? root : getResolvedDescendant(root, descendantPath)
      if (selected === undefined)
        throw new RangeError(`SC2Layout descendant path was not resolved: ${descendantPath.join('/')}`)
      return selected
    },
    value: (raw: string) => resolvePropertyValue(store.index, raw),
  })
}

function selectorText(document: Sc2LayoutDocument, requested: string | undefined): string {
  if (requested !== undefined) return requested
  const match = /\b(?:relative|path|frame)\s*=\s*["']([^"']*\$(?:parent|this|ancestor|root|sibling|layer)[^"']*)["']/iu.exec(document.text)
  return match?.[1] ?? '$this'
}

function selectorOrigin(document: Sc2LayoutDocument, requested: string): string {
  const find = (
    frames: Sc2LayoutDocument['data']['frames'],
    prefix = '',
  ): string | undefined => {
    for (const frame of frames) {
      const path = prefix === '' ? frame.name : `${prefix}/${frame.name}`
      if (
        frame.anchors.some(anchor => anchor.relative === requested) ||
        frame.properties.some(property => Object.values(property.attrs).includes(requested))
      ) return path
      const nested = find(frame.children, path)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  return find(document.data.frames) ?? document.data.frames[0]!.name
}

function selectorPath(selector: ReturnType<ExpressionParser['parsePathSelector']>) {
  return selector.path.map(item => ({
    selKind: item.selKind,
    name: item.name.name,
    ...(item.parameter === undefined
      ? {}
      : {
          parameter: {
            key: item.parameter.key.name,
            value: item.parameter.value.name,
          },
        }),
  }))
}

function sourceOf(value: ResolvedProperty['source']) {
  return {
    uri: value.uri,
    start: value.start,
    end: value.end,
    contribution: { ...value.contribution },
  }
}

function resolvedFrame(frame: ResolvedFrame): unknown {
  return {
    name: frame.name,
    type: frame.type,
    path: [...frame.path],
    ...(frame.source === undefined ? {} : { source: sourceOf(frame.source) }),
    contributions: frame.contributions.map(item => ({ ...item })),
    properties: [...frame.properties.entries()].map(([key, property]) => ({
      key,
      tag: property.tag,
      attrs: { ...property.attrs },
      ...(property.val === undefined ? {} : { val: property.val }),
      source: sourceOf(property.source),
      overridden: property.overridden.length,
    })),
    anchors: Object.entries(frame.anchors).map(([side, anchor]) => ({
      side,
      implicitSide: anchor.implicitSide,
      ...(anchor.relative === undefined ? {} : { relative: anchor.relative }),
      ...(anchor.pos === undefined ? {} : { pos: anchor.pos }),
      ...(anchor.offset === undefined ? {} : { offset: anchor.offset }),
      source: sourceOf(anchor.source),
    })),
    animations: [...frame.animations],
    stateGroups: frame.stateGroups.map(group => ({
      name: group.name,
      defaultState: group.defaultState,
      states: group.states.map(state => state.name),
    })),
    diagnostics: frame.diagnostics.map(item => ({ ...item })),
    children: frame.children.map(resolvedFrame),
  }
}

function diagnosticsFor(store: Store, uri: string) {
  const document = store.documents.get(uri)
  if (document === undefined) throw new RangeError(`SC2Layout document was not indexed: ${uri}`)
  return new LayoutChecker(store, store.index).checkFile(document).map(item => ({
    start: item.start,
    end: item.end,
    category: item.category,
    message: item.message,
    code: item.code ?? 'sc2-layout/schema',
  }))
}

function countFrames(frame: ResolvedFrame): number {
  return 1 + frame.children.reduce((sum, child) => sum + countFrames(child), 0)
}

/** Resolve one host-provided snapshot through the same engine used by render-visual. */
export function resolveLayoutVisualSnapshot(input: LayoutVisualSnapshotInput) {
  const store = new Store(layoutSchemaRegistry())
  for (const item of input.documents) store.updateDocument(item.uri, item.text, item.version ?? 1)
  const root = resolveRootInStore(store, input.entryUri, input.rootPath, input.descendantPath,
    { maxNodes: input.maxNodes, maxDepth: input.maxDepth })
  const states = applyStateGroups(root, { stateInputs: input.states ?? {}, index: store.index })
  const width = input.viewport?.width ?? 1600
  const height = input.viewport?.height ?? 1200
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError('SC2Layout viewport must be positive')
  }
  const resolveValue = (raw: string) => resolvePropertyValue(store.index, raw)
  const solved = solveLayout(root, {
    rootRect: { x: 0, y: 0, width, height },
    resolveValue: raw => {
      const parsed = Number.parseFloat(resolveValue(raw) ?? '')
      return Number.isFinite(parsed) ? parsed : undefined
    },
  })
  const expressions = evaluateExpressions(root)
  const display = buildDisplayList(root, solved, {
    includeHidden: input.includeHidden ?? true,
    resolveValue,
    expressions: expressions.byFrame,
  })
  const schemaDiagnostics = diagnosticsFor(store, input.entryUri).map(item => ({
    code: item.code,
    message: item.message,
    start: item.start,
    end: item.end,
  }))
  const diagnostics = [
    ...resolvedDiagnostics(root),
    ...states.diagnostics,
    ...display.diagnostics,
    ...schemaDiagnostics,
  ]
  return {
    store,
    root,
    states,
    solved,
    display,
    resolveValue,
    diagnostics,
    completeness: diagnostics.length === 0 ? 'complete' : 'partial',
  }
}

function resolvedDiagnostics(root: ResolvedFrame): Array<Record<string, unknown>> {
  return [
    ...root.diagnostics.map(item => ({ ...item, framePath: root.path })),
    ...root.children.flatMap(resolvedDiagnostics),
  ]
}

export function validateSc2Layout(document: Sc2LayoutDocument, value: unknown) {
  const { store, primary, documents } = workspace(document, value)
  return {
    schema: {
      simpleTypes: layoutSchemaRegistry().catalog.simpleType.size,
      complexTypes: layoutSchemaRegistry().catalog.complexType.size,
      elements: layoutSchemaRegistry().catalog.element.size,
      frameClasses: layoutSchemaRegistry().catalog.frameClass.size,
      frameTypes: layoutSchemaRegistry().catalog.frameType.size,
    },
    documents: documents.length,
    diagnostics: diagnosticsFor(store, primary.uri),
    provenance: SC2_LAYOUT_PROVENANCE,
  }
}

export function resolveSc2Layout(document: Sc2LayoutDocument, value: unknown) {
  const { input, store, documents } = workspace(document, value)
  if (input.rootPath === undefined && document.data.frames.length === 0) {
    return {
      root: null,
      indexed: {
        files: [...store.index.rootNs.children.values()].map(file => ({
          name: file.name,
          declarations: file.children.size,
        })),
        constants: store.index.constants.size,
        handles: store.index.handles.size,
      },
      resolvedFrames: 0,
      workspaceDocuments: documents.length,
      provenance: SC2_LAYOUT_PROVENANCE,
    }
  }
  const root = findRoot(document, store, input)
  return {
    root: resolvedFrame(root),
    resolvedFrames: countFrames(root),
    workspaceDocuments: documents.length,
    provenance: SC2_LAYOUT_PROVENANCE,
  }
}

export function selectSc2Layout(document: Sc2LayoutDocument, value: unknown) {
  const { input, store, documents } = workspace(document, value)
  const rootName = document.data.frames[0]?.name
  if (rootName === undefined) throw new RangeError('SC2Layout document has no frame to select')
  const raw = selectorText(document, input.selector)
  const originPath = selectorOrigin(document, raw)
  const desc = store.index.rootNs.getDeep(`${stem(document.source.path)}/${originPath}`)
  if (desc === undefined) throw new RangeError(`SC2Layout selector root was not indexed: ${rootName}`)
  const origin = new UIBuilder(store.schema, store.index).buildNodeFromDesc(desc)
  if (origin === undefined) throw new RangeError(`SC2Layout selector root was not built: ${rootName}`)
  const parsed = new ExpressionParser().parsePathSelector(raw)
  const selection = new UINavigator(store.schema, store.index).resolveSelection(origin, parsed.path)
  return {
    selector: raw,
    diagnostics: parsed.diagnostics.map(item => ({ ...item })),
    path: selectorPath(parsed),
    origin: { name: origin.name, fqn: origin.fqn },
    chain: selection.chain.map(item => ({ name: item.name, fqn: item.fqn })),
    valid: selection.isValid,
    ...(selection.target === undefined
      ? {}
      : { target: { name: selection.target.name, fqn: selection.target.fqn } }),
    workspaceDocuments: documents.length,
    provenance: SC2_LAYOUT_PROVENANCE,
  }
}

export function renderSc2LayoutVisual(document: Sc2LayoutDocument, value: unknown) {
  const { input, documents, primary } = workspace(document, value)
  const rootPath = input.rootPath ?? document.data.frames[0]?.name
  if (rootPath === undefined) throw new RangeError('SC2Layout document has no frame to resolve')
  const snapshot = resolveLayoutVisualSnapshot({
    documents,
    entryUri: primary.uri,
    rootPath,
    descendantPath: input.descendantPath,
    viewport: input.viewport,
    states: input.states,
    includeHidden: input.includeHidden,
  })
  const { root, states, display, diagnostics, completeness } = snapshot
  return {
    candidateContract: 'blizzard/sc2-layout-render@1',
    completeness,
    fidelity: {
      comparison: 'semantic',
      sourceDocuments: documents.length,
      resolvedFrames: countFrames(root),
    },
    resolvedTree: resolvedFrame(root),
    displayItems: display.items,
    diagnostics,
    activeStates: [...states.active.entries()].map(([path, state]) => ({ path, state })),
    html: emitHtml(display, { title: `${stem(document.source.path)} layout` }),
    provenance: SC2_LAYOUT_PROVENANCE,
  }
}

function symbols(frame: ResolvedFrame): unknown {
  return {
    name: frame.name,
    kind: 'struct',
    detail: frame.type,
    children: frame.children.map(symbols),
  }
}

export function languageSc2LayoutSnapshot(document: Sc2LayoutDocument, value: unknown) {
  const { input, store, primary } = workspace(document, value)
  const root = findRoot(document, store, input)
  const prefix = (input.completionPrefix ?? '').toLocaleLowerCase()
  const completions = [...layoutSchemaRegistry().frameTypes.keys()]
    .filter(name => name.toLocaleLowerCase().startsWith(prefix))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 256)
  const colors = [...document.text.matchAll(/(?:Color|LayerColor)\s+val="([^"]+)"/giu)]
    .map(match => ({ raw: match[1] ?? '', rgba: parseColor(match[1] ?? '') }))
    .filter(item => item.rgba !== undefined)
  const selector = input.selector === undefined
    ? undefined
    : new ExpressionParser().parsePathSelector(input.selector)
  return {
    diagnostics: diagnosticsFor(store, primary.uri),
    symbols: [symbols(root)],
    completions,
    colors,
    ...(selector === undefined
      ? {}
      : {
          selector: {
            diagnostics: selector.diagnostics.map(item => ({ ...item })),
            path: selectorPath(selector),
          },
        }),
    provenance: SC2_LAYOUT_PROVENANCE,
  }
}
