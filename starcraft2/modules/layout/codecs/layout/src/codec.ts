import {
  createSubjectFactsSource,
  createInspectionCodec,
  editPlanFromInput,
  fact,
  replaceBytes,
} from '@modkit/codec-kit'
import { diagnostic, errorCode, ModkitError, operationId } from '@modkit/core'
import type {
  InspectionContext,
  InspectionResult,
} from '@modkit/codec-kit'
import { isJsonSerializable } from '@modkit/codec-kit'
import type {
  AssetDiagnostic,
  Codec,
  ContributionContext,
  JsonValue,
  OperationDecl,
  OperationOutput,
} from '@modkit/sdk'
import { GAME_TEMPLATE_PREVIEW_OPERATION_ID } from '@modkit/sdk/templates'
import {
  inspectSc2Layout,
  parseSc2Layout,
  rawSc2LayoutOutput,
  sc2LayoutDiagnosticHtmlOutput,
  Sc2LayoutParseError,
  type Sc2LayoutDocument,
} from '../../../shared/format/document.js'
import { detectSc2LayoutBytes } from '../../../shared/format/detect.js'
import {
  sc2LayoutDiagnostics,
  sc2LayoutMetadata,
  sc2LayoutTraits,
} from '../../../shared/format/summary.js'
import { renameSc2LayoutReferenceBytes } from '../../../shared/format/reference-rename.js'
import {
  createSc2LayoutStructureTree,
  languageSc2LayoutSnapshot,
  renderSc2LayoutVisual,
  resolveSc2Layout,
  selectSc2Layout,
  validateSc2Layout,
} from '../../../shared/runtime.js'
import { previewSc2Layout, previewSc2TechTree } from '../../../shared/preview.js'
import { createPreviewTextResolver } from '../../../shared/preview-text.js'
import { byteDocumentSourceDescriptor } from '../../../../../shared/inspection/byte-source.js'
import { createSc2LayoutRelationGraphSource } from './relation-graph.js'

const ID = 'blizzard/sc2-layout'

export const SC2_LAYOUT_OPERATION_MAP = Object.freeze({
  'sc2-layout.parse': {
    id: 'blizzard/sc2-layout.parse',
    handlerId: 'parse',
    outputKinds: ['json'],
  },
  'sc2-layout.resolve': {
    id: 'blizzard/sc2-layout.resolve',
    handlerId: 'resolve',
    outputKinds: ['json'],
  },
  'selector.resolve': {
    id: 'blizzard/sc2-layout.selector-resolve',
    handlerId: 'selector-resolve',
    outputKinds: ['json'],
  },
  'view.render': {
    id: 'view.render',
    handlerId: 'render-structural',
    outputKinds: ['bytes'],
  },
  'sc2-layout.render-visual': {
    id: 'blizzard/sc2-layout.render-visual',
    handlerId: 'render-visual',
    outputKinds: ['json'],
  },
  'view.inspect': { id: 'view.inspect', handlerId: 'inspect', outputKinds: ['json'] },
  'asset.validate': { id: 'asset.validate', handlerId: 'validate', outputKinds: ['json'] },
  'edit.structure': {
    id: 'edit.content',
    handlerId: 'rename-reference',
    outputKinds: ['edit-plan'],
  },
  'sc2-layout.language-features': {
    id: 'blizzard/sc2-layout.language-features',
    handlerId: 'language-features',
    outputKinds: ['json'],
  },
  'export.convert': {
    id: 'export.convert',
    handlerId: 'export-html',
    outputKinds: ['bytes'],
  },
  'export.raw': { id: 'export.raw', handlerId: 'export-raw', outputKinds: ['bytes'] },
  [GAME_TEMPLATE_PREVIEW_OPERATION_ID]: {
    id: GAME_TEMPLATE_PREVIEW_OPERATION_ID,
    handlerId: 'game-template-preview',
    outputKinds: ['json'],
  },
  'blizzard/sc2-layout.preview': {
    id: 'blizzard/sc2-layout.preview',
    handlerId: 'layout-preview',
    outputKinds: ['json'],
  },
  'blizzard/sc2-layout.tech-tree': {
    id: 'blizzard/sc2-layout.tech-tree',
    handlerId: 'tech-tree-preview',
    outputKinds: ['json'],
  },
} as const)

export const SC2_LAYOUT_OPERATION_MAP_VERSION = 1

type LegacyOperationId = keyof typeof SC2_LAYOUT_OPERATION_MAP

function mappingFor(legacyId: LegacyOperationId) {
  return SC2_LAYOUT_OPERATION_MAP[legacyId]
}

export const operations: readonly OperationDecl[] = Object.freeze(
  (Object.entries(SC2_LAYOUT_OPERATION_MAP) as [LegacyOperationId, (typeof SC2_LAYOUT_OPERATION_MAP)[LegacyOperationId]][])
    .map(([legacyId, mapping]): OperationDecl => {
      const mutatesSource = legacyId === 'edit.structure'
      return {
        id: operationId(mapping.id, { contributionId: ID }),
        handlerId: mapping.handlerId,
        mutatesSource,
        requiredPermissions: mutatesSource
          ? ['read-source', 'write-source']
          : ['read-source'],
        outputKinds: mapping.outputKinds,
      }
    }),
)

function json(value: unknown): OperationOutput {
  const normalized = value === undefined ? null : value
  if (!isJsonSerializable(normalized)) {
    throw new TypeError('SC2Layout operation produced a non-JSON result')
  }
  return { kind: 'json', value: normalized as JsonValue }
}

function bytes(value: unknown): OperationOutput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SC2Layout byte operation produced a malformed output')
  }
  const data = (value as { readonly data?: unknown }).data
  if (!(data instanceof Uint8Array)) {
    throw new TypeError('SC2Layout byte operation did not produce bytes')
  }
  return { kind: 'bytes', value: data }
}

function previewInputFor(
  document: Sc2LayoutDocument,
  value: JsonValue,
  templateKind: 'sc2-layout' | 'sc2-tech-tree-v1',
  budget: InspectionContext['budget'],
) {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
  type PreviewDocument = Readonly<{ uri: string; text: string }> &
    Readonly<Record<string, JsonValue>>
  const isDocument = (candidate: JsonValue | undefined): candidate is PreviewDocument => {
    if (candidate === undefined || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return false
    }
    const record = candidate as Readonly<Record<string, JsonValue>>
    return typeof record['uri'] === 'string' && typeof record['text'] === 'string'
  }
  const workspaceDocuments = Array.isArray(input['documents'])
    ? input['documents'].filter(isDocument)
    : Array.isArray(input['workspaceDocuments'])
      ? input['workspaceDocuments'].filter(isDocument)
      : []
  const explicitDocument = isDocument(input['document']) ? input['document'] : undefined
  const openedDocument = explicitDocument ??
    workspaceDocuments.find(candidate => candidate['text'] === document.text) ??
    workspaceDocuments.find(candidate => candidate['uri'] === document.source.id) ?? {
      uri: document.source.id,
      text: document.text,
    }
  return {
    ...input,
    document: openedDocument,
    workspaceDocuments,
    templateKind,
    hardBounds: {
      maxChars: budget.maxScalarBytes,
      maxWorkspaceChars: budget.maxScalarBytes,
      // A mod's layouts, not a fixed 256: a template names one in any of core's 377 files, and the
      // caller's own node budget is what actually bounds the work.
      maxDocuments: Math.max(1, Math.min(4_096, budget.maxNodes)),
      maxNodes: budget.maxNodes,
      maxDepth: budget.maxDepth,
      maxDiagnostics: budget.maxDiagnostics,
    },
  }
}

/** Text and styles resolve against the same snapshot the templates do. */
function previewOptions(input: ReturnType<typeof previewInputFor>) {
  return {
    resolveText: createPreviewTextResolver(
      input.workspaceDocuments.map(document => ({
        uri: document.uri,
        text: document.text,
        languageId: typeof document['languageId'] === 'string' ? document['languageId'] : '',
      })),
    ),
  }
}

async function yieldBeforeLayoutWork(signal?: AbortSignal) {
  signal?.throwIfAborted()
  await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  signal?.throwIfAborted()
}

function tableDataSource(document: Sc2LayoutDocument) {
  const rows: { index: number; cells: string[] }[] = []
  for (const path of document.data.includes) {
    rows.push({ index: rows.length, cells: ['Include', path, ''] })
  }
  for (const constant of document.data.constants) {
    rows.push({ index: rows.length, cells: ['Constant', constant.name, constant.val] })
  }
  const addFrame = (frame: Sc2LayoutDocument['data']['frames'][number], path = ''): void => {
    const full = path === '' ? frame.name : `${path}/${frame.name}`
    rows.push({ index: rows.length, cells: ['Frame', full, frame.type] })
    for (const child of frame.children) addFrame(child, full)
  }
  for (const frame of document.data.frames) addFrame(frame)
  return {
    async shape() {
      return { rows: rows.length, columns: 3, header: ['Kind', 'Path', 'Type / Value'] }
    },
    async rows(request: { readonly kind: string; readonly from?: number; readonly cursor?: string; readonly count: number }) {
      if (!Number.isSafeInteger(request.count) || request.count <= 0) {
        throw new TypeError('SC2Layout table page count must be a positive safe integer')
      }
      const start = request.kind === 'range' ? request.from : Number(request.cursor)
      if (!Number.isSafeInteger(start) || (start ?? -1) < 0) {
        throw new TypeError('SC2Layout table page start is invalid')
      }
      const offset = start as number
      const items = rows.slice(offset, offset + request.count)
      return {
        items,
        ...(offset + items.length < rows.length
          ? { nextCursor: String(offset + items.length) }
          : {}),
      }
    },
    async cell(coord: { readonly row: number; readonly column: number }) {
      const value = rows[coord.row]?.cells[coord.column]
      if (value === undefined) throw new RangeError('SC2Layout table cell is outside the document')
      return { value }
    },
    async *search(query: { readonly pattern: string }, signal?: AbortSignal) {
      const needle = query.pattern.toLocaleLowerCase()
      for (const row of rows) {
        for (let column = 0; column < row.cells.length; column += 1) {
          signal?.throwIfAborted()
          if (row.cells[column]!.toLocaleLowerCase().includes(needle)) {
            yield { row: row.index, column }
          }
        }
      }
    },
  }
}

function renameOptions(value: JsonValue) {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {}
  const namespace = input['namespace']
  const oldId = input['oldId']
  const newId = input['newId']
  if (typeof namespace !== 'string' || typeof oldId !== 'string' || typeof newId !== 'string') {
    throw new TypeError('SC2Layout reference rename requires namespace, oldId and newId')
  }
  return {
    canon: (raw: string) => raw.toLocaleLowerCase() === namespace.toLocaleLowerCase()
      ? namespace
      : undefined,
    mapped: (candidateNamespace: string, candidateId: string) =>
      candidateNamespace === namespace && candidateId === oldId ? newId : undefined,
  }
}

const FINDING_CATEGORIES = { 'missing-companion': 'dependency', 'runtime-unavailable': 'dependency' } as const

function nativeDiagnostics(document: Sc2LayoutDocument): AssetDiagnostic[] {
  return sc2LayoutDiagnostics(document).map(finding => ({
    id: finding.id,
    code: errorCode<string>(`blizzard/${finding.code.replace('.', '-')}`),
    severity: finding.severity === 'info' ? 'information' : finding.severity,
    message: finding.message,
    category: FINDING_CATEGORIES[finding.category],
    source: { contributionId: ID },
    ...(finding.detail === undefined ? {} : { data: finding.detail }),
  }))
}

function nativeError(error: unknown): unknown {
  if (!(error instanceof Sc2LayoutParseError)) return error
  return new ModkitError({
    code: errorCode('blizzard/sc2-layout-parse-failed'),
    message: error.message,
    cause: error,
    context: { ...error.context, ...(error.hint === undefined ? {} : { hint: error.hint }) },
  })
}

async function project(
  document: Sc2LayoutDocument,
  context: InspectionContext,
): Promise<InspectionResult> {
  const handlers: NonNullable<InspectionResult['handlers']> = {
    parse: async () => json(document.data),
    'render-structural': async () => bytes(sc2LayoutDiagnosticHtmlOutput(document)),
    inspect: async () => json(inspectSc2Layout(document)),
    'export-html': async () => bytes(sc2LayoutDiagnosticHtmlOutput(document)),
    'export-raw': async () => bytes(rawSc2LayoutOutput(document)),
    resolve: async input => json(resolveSc2Layout(document, input)),
    'selector-resolve': async input => json(selectSc2Layout(document, input)),
    validate: async input => json(validateSc2Layout(document, input)),
    'render-visual': async input => json(renderSc2LayoutVisual(document, input)),
    'language-features': async input => json(languageSc2LayoutSnapshot(document, input)),
    'rename-reference': async input => {
      const renamed = renameSc2LayoutReferenceBytes(document, renameOptions(input))
      return {
        kind: 'edit-plan',
        plan: editPlanFromInput(context.input, {
          planId: `${ID}:${context.input.revisions.revision}:reference-rename`,
          // A byte-identical replacement makes a valid, committable no-op plan as well. The
          // diagnostic still tells clients that no matching reference was found.
          edits: [replaceBytes(
            0,
            document.bytes.byteLength,
            renamed.bytes,
            `rename ${renamed.referencesPatched} SC2Layout reference(s)`,
          )],
          fidelity: {
            roundTrip: 'byte-identical',
            preservesUnknownData: true,
            notes: ['Only matching SC2Layout val attribute contents are replaced.'],
          },
          diagnostics: renamed.referencesPatched === 0
            ? [diagnostic(
                'information',
                'blizzard/sc2-layout-reference-rename-no-op',
                'No SC2Layout reference value matches the requested catalog rename.',
              )]
            : [],
        }),
      }
    },
    'game-template-preview': async (input, operationContext) => {
      const candidate = input !== null && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, JsonValue>
        : {}
      const templateKind = candidate['templateKind'] ?? 'sc2-layout'
      if (templateKind !== 'sc2-layout' && templateKind !== 'sc2-tech-tree-v1') {
        throw new RangeError(`Unsupported SC2Layout template kind: ${String(templateKind)}`)
      }
      const previewInput = previewInputFor(document, input, templateKind, context.budget)
      return json(await previewSc2Layout(
        previewInput,
        operationContext.signal ?? context.signal,
        previewOptions(previewInput),
      ))
    },
    'layout-preview': async (input, operationContext) => {
      const signal = operationContext.signal ?? context.signal
      await yieldBeforeLayoutWork(signal)
      const previewInput = previewInputFor(document, input, 'sc2-layout', context.budget)
      const preview = await previewSc2Layout(previewInput, signal, previewOptions(previewInput))
      signal?.throwIfAborted()
      const visual = renderSc2LayoutVisual(document, input)
      return json({ ...preview, html: visual.html, activeStates: visual.activeStates })
    },
    'tech-tree-preview': async (input, operationContext) => {
      const previewInput = previewInputFor(document, input, 'sc2-tech-tree-v1', context.budget)
      return json(await previewSc2TechTree(
        previewInput,
        operationContext.signal ?? context.signal,
        previewOptions(previewInput),
      ))
    },
  }

  return {
    summary: {
      format: 'sc2-layout',
      ...document.stats,
      includes: [...document.data.includes],
      templates: [...document.data.templates],
    },
    metadata: sc2LayoutMetadata(document).map(group => ({
      id: group.id,
      label: group.label,
      entries: group.entries.map(entry => ({ key: entry.id, value: entry.value as JsonValue })),
    })),
    traits: sc2LayoutTraits(document).map(trait => ({
      id: trait.id,
      parameters: trait.parameters,
    })),
    diagnostics: nativeDiagnostics(document),
    text: document.text,
    dataSources: {
      'common.view/table-data-source': tableDataSource(document),
      /*
       * The card for a layout. What matters at a glance is how much of the file is its own and how
       * much it inherits: a layout that declares two frames and includes six files behaves nothing
       * like one that declares two hundred, and the counts say which this is.
       */
      'common.view/subject-facts-source': createSubjectFactsSource({
        snapshotId: String(context.input.revisions.revision),
        subjectId: context.primary.source.id,
        label:
          String(context.primary.source.uri).replaceAll('\\', '/').split('/').at(-1) ?? 'layout',
        kind: 'sc2-layout',
        type: 'StarCraft II Desc layout',
        source: context.primary.source,
        groups: [
          {
            id: 'structure',
            label: 'Structure',
            facts: [
              fact(context.primary.source, 'frames', 'Frames', document.stats.frameCount),
              fact(
                context.primary.source,
                'top-level-frames',
                'Top-level frames',
                document.stats.topLevelFrameCount,
              ),
              fact(context.primary.source, 'properties', 'Properties', document.stats.propertyCount),
              fact(context.primary.source, 'anchors', 'Anchors', document.stats.anchorCount),
              fact(
                context.primary.source,
                'animations',
                'Animations',
                document.stats.animationCount,
              ),
            ],
          },
          {
            id: 'composition',
            label: 'Composition',
            facts: [
              fact(context.primary.source, 'includes', 'Includes', document.stats.includeCount),
              fact(context.primary.source, 'templates', 'Templates', document.stats.templateCount),
              fact(context.primary.source, 'constants', 'Constants', document.stats.constantCount),
              fact(context.primary.source, 'references', 'References', document.stats.referenceCount),
            ],
          },
        ],
      }),
      'common.view/tree-data-source': createSc2LayoutStructureTree(document),
      'common.view/relation-graph-source': createSc2LayoutRelationGraphSource(
        document,
        String(context.input.revisions.revision),
      ),
    },
    handlers,
    /*
     * A file of constants or animations has nothing to draw, so the template stage is not offered
     * for it and the host opens the next view instead of a preview that can only fail.
     */
    ...(document.data.frames.length > 0
      ? {}
      : {
          operationStates: operations
            .filter(operation => operation.id === GAME_TEMPLATE_PREVIEW_OPERATION_ID)
            .map(operation => ({
              id: operation.id,
              state: 'disabled' as const,
              reason: 'The layout declares no frame to preview.',
            })),
        }),
    unsupportedFeatures: [
      'installed-vscode-acceptance',
      'cross-codec-rename-coordinator',
      'automatic-installed-archive-workspace-loading',
      'resolved-asset-and-localization-bytes',
    ],
  }
}

export const abiVersion = 1

export function createCodec(_context?: ContributionContext): Codec {
  return createInspectionCodec({
    id: ID,
    format: {
      id: 'sc2-layout',
      label: 'StarCraft II Layout',
      mediaType: 'application/x-sc2layout+xml',
    },
    operations,
    async detect(prefix, uri) {
      const source = byteDocumentSourceDescriptor(prefix, { path: uri, id: uri })
      const detected = detectSc2LayoutBytes(prefix, source)
      return {
        confidence: detected.confidence,
        kind: 'structure' as const,
        note: JSON.stringify({
          evidence: detected.evidence,
          requiredRanges: detected.requiredRanges,
        }),
      }
    },
    async inspect(bytes, context) {
      try {
        context.signal?.throwIfAborted()
        const source = byteDocumentSourceDescriptor(bytes, {
          path: context.primary.source.uri,
          id: context.primary.source.id,
        })
        const document = parseSc2Layout(source, bytes, detectSc2LayoutBytes(bytes, source))
        context.signal?.throwIfAborted()
        return await project(document, context)
      } catch (error) {
        throw nativeError(error)
      }
    },
  }, _context)
}
