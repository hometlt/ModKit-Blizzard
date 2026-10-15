import { createInspectionCodec, createTreeDataSource } from '@modkit/codec-kit'
import { GAME_TEMPLATE_PREVIEW_OPERATION_ID } from '@modkit/sdk/templates'
import {
  createTableDataSource,
  decodeStructuredText,
  lineCount,
} from '../../../../shared/inspection/structured-text.js'
import {
  previewSc2Layout,
  previewSc2TechTree,
} from '../../../../dist/modules/layout/shared/preview.js'
import { SC2_LAYOUT_PROVENANCE, semanticLayout } from '../../shared/semantic.js'
import { parseXmlDocument } from '../../shared/xml.js'

const ID = 'blizzard/sc2-layout'
const ascii = new TextDecoder('ascii', { fatal: false })

function rootDesc(text) {
  return /^\s*(?:<\?xml[^>]*>\s*)?<Desc(?:\s|>)/iu.test(text)
}

function collectFrames(frame, records, depth = 0) {
  records.push(
    Object.freeze({
      kind: 'Frame',
      name: frame.name,
      detail: frame.type,
      path: frame.path,
      depth,
    }),
  )
  for (const child of frame.children) collectFrames(child, records, depth + 1)
}

function layoutRecords(layout) {
  const records = []
  for (const include of layout.includes) {
    records.push(
      Object.freeze({
        kind: 'Include',
        name: include.path,
        detail: '',
        path: include.path,
        depth: 0,
      }),
    )
  }
  for (const constant of layout.constants) {
    records.push(
      Object.freeze({
        kind: 'Constant',
        name: constant.name,
        detail: constant.val,
        path: constant.name,
        depth: 0,
      }),
    )
  }
  for (const frame of layout.frames) collectFrames(frame, records)
  for (const animation of layout.animations) {
    records.push(
      Object.freeze({
        kind: 'Animation',
        name: animation.name,
        detail: '',
        path: animation.name,
        depth: 0,
      }),
    )
  }
  return Object.freeze(records)
}

function frameTree(frame) {
  return Object.freeze({
    kind: 'frame',
    label: frame.name || '(anonymous frame)',
    preview: frame.type,
    semanticPath: Object.freeze(['Frame', ...frame.path.split('/')]),
    children: Object.freeze([
      ...frame.anchors.map(anchor =>
        Object.freeze({
          kind: 'anchor',
          label: anchor.side ?? 'all sides',
          preview:
            `${anchor.relative ?? '$parent'} ${anchor.pos ?? ''} ${anchor.offset ?? ''}`.trim(),
        }),
      ),
      ...frame.properties.map(property =>
        Object.freeze({
          kind: 'property',
          label: property.name,
          preview: property.val ?? '',
        }),
      ),
      ...frame.stateGroups.map(group =>
        Object.freeze({
          kind: 'state-group',
          label: group.name,
          preview: `${group.states.length} state(s)`,
        }),
      ),
      ...frame.children.map(frameTree),
    ]),
  })
}

const record = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}

function previewInput(value, document) {
  const input = record(value)
  const workspaceDocuments = Array.isArray(input.documents)
    ? input.documents.map((item, index) => {
        const value = record(item)
        if (typeof value.uri !== 'string' || typeof value.text !== 'string') {
          throw new TypeError(`SC2Layout preview document ${index} is invalid`)
        }
        return Object.freeze({
          uri: value.uri,
          languageId: 'sc2-layout',
          version: Number.isSafeInteger(value.version) ? value.version : 1,
          text: value.text,
        })
      })
    : [document]
  return Object.freeze({
    document,
    workspaceDocuments: Object.freeze(workspaceDocuments),
    ...(typeof input.rootPath === 'string' ? { rootPath: input.rootPath } : {}),
    ...(record(input.viewport).width === undefined
      ? {}
      : {
          viewport: Object.freeze({
            width: Number(record(input.viewport).width),
            height: Number(record(input.viewport).height),
          }),
        }),
    ...(record(input.states) === input.states ? { states: input.states } : {}),
    ...(Number.isSafeInteger(input.maxNodes) ? { maxNodes: input.maxNodes } : {}),
    ...(Number.isSafeInteger(input.maxDiagnostics) ? { maxDiagnostics: input.maxDiagnostics } : {}),
  })
}

function operationPreviewInput(value, document, budget) {
  return Object.freeze({
    ...previewInput(value, document),
    hardBounds: Object.freeze({
      maxChars: budget.maxScalarBytes,
      maxWorkspaceChars: budget.maxScalarBytes,
      maxDocuments: Math.max(1, Math.min(256, budget.maxNodes)),
      maxNodes: budget.maxNodes,
      maxDepth: budget.maxDepth,
      maxDiagnostics: budget.maxDiagnostics,
    }),
  })
}

const PREVIEW_OPERATIONS = Object.freeze([
  Object.freeze({
    id: GAME_TEMPLATE_PREVIEW_OPERATION_ID,
    handlerId: 'game-template-preview',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'blizzard/sc2-layout.preview',
    handlerId: 'layout-preview',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'blizzard/sc2-layout.tech-tree',
    handlerId: 'tech-tree-preview',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
])

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({
    id: 'sc2-layout',
    label: 'StarCraft II Layout',
    mediaType: 'application/x-sc2layout+xml',
  }),
  operations: PREVIEW_OPERATIONS,
  async detect(prefix, uri) {
    const text = ascii.decode(prefix)
    return /\.sc2layout$/iu.test(uri) && rootDesc(text)
      ? { confidence: 0.98, kind: 'structure', note: 'desc-root' }
      : { confidence: 0, kind: 'structure', note: 'sc2layout-desc-root-missing' }
  },
  async inspect(bytes, context) {
    const text = decodeStructuredText(bytes, context.budget, 'SC2Layout')
    if (!rootDesc(text)) throw new TypeError('SC2Layout root must be Desc')
    const document = Object.freeze({
      uri: context.primary?.source?.uri ?? 'memory://sc2/layout.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text,
    })
    const parsed = await parseXmlDocument(
      document,
      {
        maxChars: context.budget.maxScalarBytes,
        maxWorkspaceChars: context.budget.maxScalarBytes,
        maxDocuments: 1,
        maxNodes: context.budget.maxNodes,
        maxDepth: context.budget.maxDepth,
        maxDiagnostics: context.budget.maxDiagnostics,
      },
      context.signal,
    )
    const layout = semanticLayout(parsed)
    if (layout.diagnostics.some(item => item.severity === 'error')) {
      throw new TypeError(
        layout.diagnostics
          .filter(item => item.severity === 'error')
          .map(item => item.message)
          .join('; '),
      )
    }
    const records = layoutRecords(layout)
    const frames = records.filter(record => record.kind === 'Frame')
    const includes = records.filter(record => record.kind === 'Include')
    const constants = records.filter(record => record.kind === 'Constant')
    return {
      summary: {
        format: 'sc2-layout',
        lines: lineCount(text),
        elements: parsed.nodeCount,
        frames: frames.length,
        frameNames: frames.map(frame => frame.name),
        includes: includes.map(include => include.name),
        constants: constants.length,
        animations: layout.animations.length,
        stateGroups: layout.stateGroups.length,
        provenance: SC2_LAYOUT_PROVENANCE,
      },
      metadata: [
        {
          id: 'sc2-layout-document',
          label: 'SC2 layout document',
          entries: [
            { key: 'lines', value: lineCount(text) },
            { key: 'elements', value: parsed.nodeCount },
            { key: 'frames', value: frames.length },
            { key: 'includes', value: includes.length },
            { key: 'constants', value: constants.length },
          ],
        },
      ],
      traits: [
        { id: 'content.text', parameters: { language: 'sc2-layout', lines: lineCount(text) } },
        {
          id: 'structure.hierarchy',
          parameters: { elements: parsed.nodeCount, frames: frames.length },
        },
      ],
      text: true,
      dataSources: {
        'common.view/table-data-source': createTableDataSource(
          ['Kind', 'Path', 'Type / Value'],
          records.map(record => [record.kind, record.path, record.detail]),
        ),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'layout',
          label: 'SC2 Desc layout',
          preview: `${frames.length} frame(s), ${includes.length} include(s)`,
          children: [
            ...layout.includes.map(include => ({
              kind: 'include',
              label: include.path,
            })),
            ...layout.constants.map(constant => ({
              kind: 'constant',
              label: constant.name,
              preview: constant.val,
            })),
            ...layout.frames.map(frameTree),
          ],
        }),
      },
      handlers: {
        'game-template-preview': async (input, invokeOptions) => {
          const templateKind = record(input).templateKind ?? 'sc2-layout'
          if (!['sc2-layout', 'sc2-tech-tree-v1'].includes(String(templateKind))) {
            throw new RangeError(`Unsupported SC2Layout template kind: ${String(templateKind)}`)
          }
          const normalized = operationPreviewInput(input, document, context.budget)
          return {
            kind: 'json',
            value:
              templateKind === 'sc2-tech-tree-v1'
                ? await previewSc2TechTree(normalized, invokeOptions.signal ?? context.signal)
                : await previewSc2Layout(normalized, invokeOptions.signal ?? context.signal),
          }
        },
        'layout-preview': async (input, invokeOptions) => ({
          kind: 'json',
          value: await previewSc2Layout(
            operationPreviewInput(input, document, context.budget),
            invokeOptions.signal ?? context.signal,
          ),
        }),
        'tech-tree-preview': async (input, invokeOptions) => ({
          kind: 'json',
          value: await previewSc2TechTree(
            operationPreviewInput(input, document, context.budget),
            invokeOptions.signal ?? context.signal,
          ),
        }),
      },
      unsupportedFeatures: [
        'pixel-perfect-game-rendering',
        'full-game-schema-bundle',
        'runtime-layout-event-execution',
        'all-state-action-kinds',
        'animation-controller-evaluation',
        'full-layout-expression-evaluation',
        'resolved-localization-and-assets',
        'structured-property-anchor-edit-plans',
        'automatic-installed-archive-workspace-loading',
      ],
    }
  },
})

export const abiVersion = 1
export const createCodec = context => createInspectionCodec(definition, context)
