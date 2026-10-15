/**
 * A codec over one of the editor's XML map documents that has a typed model (`CustomAI`,
 * `Attributes`). The model in `shared/format/formats/*` is the one reader and writer; the codec
 * only publishes it: a tree and a table to browse, the typed document as JSON, and one edit that
 * takes replacement XML or an edited document and writes it through the model.
 */
import type { JsonValue, OperationDecl, OperationOutput } from '@modkit/sdk'
import {
  createInspectionCodec,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromInput,
  replaceBytes,
  type InspectionCodecDefinition,
  type InspectionContext,
  type InspectionResult,
  type InspectionTreeNode,
} from '@modkit/codec-kit'
import type { EditorXmlElement } from '../format/formats/editor-xml.js'

export interface EditorXmlDocumentModel<T> {
  /** Codec id; the typed read is `<id>.document`. */
  readonly id: string
  readonly formatId: string
  readonly label: string
  readonly rootTag: string
  readonly pathPattern: RegExp
  /** Prefix of the diagnostic codes (`<prefix>/invalid-root`, `<prefix>/unreadable`). */
  readonly diagnosticPrefix: string
  readonly unsupportedFeatures: readonly string[]
  readonly read: (xml: string) => T
  /** The editor's layout of a document, which a document built from JSON is written in. */
  readonly layout: (document: T) => string
  readonly summary: (document: T) => Readonly<Record<string, number>>
  readonly tree: (document: T) => readonly InspectionTreeNode[]
  readonly table: (document: T) => { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
}

export function editorXmlDocumentOperations(codecId: string): readonly OperationDecl[] {
  return Object.freeze([
    Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
    Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
    Object.freeze({ id: `${codecId}.document`, handlerId: 'document', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
    Object.freeze({ id: 'edit.content', handlerId: 'replace-xml', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
  ]) as readonly OperationDecl[]
}

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()
const rootOf = (xml: string): string | undefined => /<([A-Za-z_][\w:.-]*)(?:\s|>|\/>)/u.exec(xml)?.[1]
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** An element the model keeps as written, as a tree node. */
export function xmlElementNode(element: EditorXmlElement, semanticPath: readonly string[]): InspectionTreeNode {
  const attributes = Object.entries(element.attributes).map(([name, value]) => `${name}=${value}`).join(' ')
  return {
    kind: 'xml-element',
    label: element.name,
    preview: attributes || element.text,
    semanticPath,
    children: element.children.map((child, index) => xmlElementNode(child, [...semanticPath, String(index)])),
  }
}

function countNodes(nodes: readonly InspectionTreeNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + 1 + countNodes(Array.isArray(node.children) ? node.children : []),
    0,
  )
}

export function createEditorXmlDocumentDefinition<T>(model: EditorXmlDocumentModel<T>): InspectionCodecDefinition {
  const operations = editorXmlDocumentOperations(model.id)
  /** A document edited as JSON is written in the editor's layout and must read back to that text. */
  const writeDocument = (document: unknown): string => {
    let text: string
    try {
      text = model.layout(document as T)
    } catch (error) {
      throw new TypeError(`${model.label} document cannot be written: ${messageOf(error)}`)
    }
    let reread: T
    try {
      reread = model.read(text)
    } catch (error) {
      throw new TypeError(`${model.label} document does not read back: ${messageOf(error)}`)
    }
    if (model.layout(reread) !== text) throw new TypeError(`${model.label} document does not read back to what it wrote`)
    return text
  }
  return Object.freeze({
    id: model.id,
    format: Object.freeze({ id: model.formatId, label: model.label, mediaType: 'application/xml' }),
    operations,
    async detect(prefix: Uint8Array, uri: string) {
      if (model.pathPattern.test(uri)) return { confidence: 1, kind: 'context' as const, note: model.rootTag }
      return rootOf(decoder.decode(prefix)) === model.rootTag
        ? { confidence: 0.9, kind: 'structure' as const, note: `${model.rootTag}-root` }
        : { confidence: 0, kind: 'structure' as const, note: `${model.rootTag}-root-missing` }
    },
    async inspect(bytes: Uint8Array, context: InspectionContext): Promise<InspectionResult> {
      const xml = decoder.decode(bytes)
      const rootTag = rootOf(xml)
      let document: T | undefined
      let failure: string | undefined
      try {
        document = model.read(xml)
      } catch (error) {
        failure = messageOf(error)
      }
      const nodes = document === undefined ? [] : model.tree(document)
      if (countNodes(nodes) + 1 > context.budget.maxNodes) throw new RangeError(`${model.label} exceeds the inspection node budget`)
      const diagnostics = Object.freeze(
        failure === undefined
          ? []
          : [{
              id: `${model.formatId}-document`,
              category: 'syntax' as const,
              severity: 'error' as const,
              code: rootTag === model.rootTag ? `${model.diagnosticPrefix}/unreadable` : `${model.diagnosticPrefix}/invalid-root`,
              message: rootTag === model.rootTag
                ? `${model.label} cannot be read: ${failure}`
                : rootTag === undefined
                  ? `${model.label} has no XML root element`
                  : `${model.label} root is <${rootTag}> instead of <${model.rootTag}>`,
            }],
      )
      const counts = document === undefined ? {} : model.summary(document)
      const table = document === undefined ? { header: ['property', 'value'], rows: [['document', 'unreadable']] } : model.table(document)
      const loaded = document
      return {
        summary: { format: model.formatId, rootTag: rootTag ?? null, semanticModel: document === undefined ? 'unreadable' : 'typed', ...counts },
        metadata: [{
          id: model.formatId,
          label: model.label,
          entries: [
            { key: 'rootTag', value: rootTag ?? '' },
            { key: 'semanticModel', value: document === undefined ? 'unreadable' : 'typed' },
            ...Object.entries(counts).map(([key, value]) => ({ key, value })),
          ],
        }],
        traits: [{ id: 'content.text', parameters: { language: 'xml' } }],
        dataSources: {
          'common.view/tree-data-source': createTreeDataSource({
            kind: model.formatId,
            label: model.label,
            preview: Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(', '),
            children: nodes,
          }),
          'common.view/table-data-source': createTableDataSource(table),
        },
        diagnostics,
        unsupportedFeatures: [...model.unsupportedFeatures],
        handlers: {
          validate: async (): Promise<OperationOutput> => ({ kind: 'json', value: diagnostics as unknown as JsonValue }),
          'export-raw': async (): Promise<OperationOutput> => ({ kind: 'bytes', value: bytes.slice() }),
          document: async (): Promise<OperationOutput> => {
            if (loaded === undefined) throw new TypeError(`${model.label} cannot be read: ${failure}`)
            return { kind: 'json', value: JSON.parse(JSON.stringify(loaded)) as JsonValue }
          },
          'replace-xml': async (input: JsonValue): Promise<OperationOutput> => {
            const request: Readonly<Record<string, JsonValue>> | undefined =
              input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Readonly<Record<string, JsonValue>>) : undefined
            const xml = request?.['xml']
            const edited = request?.['document']
            let text: string
            let fidelity
            if (typeof xml === 'string') {
              text = xml
              try {
                model.read(text)
              } catch (error) {
                throw new TypeError(`${model.label} replacement is not an <${model.rootTag}> document: ${messageOf(error)}`)
              }
              fidelity = { roundTrip: 'byte-identical' as const, preservesUnknownData: true as const, notes: ['The caller-provided XML is written verbatim after the model reads it'] }
            } else if (edited !== null && typeof edited === 'object' && !Array.isArray(edited)) {
              text = writeDocument(edited)
              fidelity = { roundTrip: 'semantic' as const, preservesUnknownData: true, notes: ['The edited document is written in the editor layout; elements the model does not know are kept'] }
            } else {
              throw new TypeError('edit.content requires an xml string or a document object')
            }
            const output = encoder.encode(text)
            return {
              kind: 'edit-plan',
              plan: editPlanFromInput(context.input, {
                planId: `${model.formatId}:replace`,
                edits: [replaceBytes(0, bytes.byteLength, output, `replace ${model.label}`)],
                fidelity,
              }),
            }
          },
        },
      }
    },
  }) as InspectionCodecDefinition
}

export function createEditorXmlDocumentCodec<T>(model: EditorXmlDocumentModel<T>, context?: unknown) {
  return createInspectionCodec(createEditorXmlDocumentDefinition(model), context as never)
}
