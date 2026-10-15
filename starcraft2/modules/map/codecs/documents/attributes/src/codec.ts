import { createInspectionCodec } from '@modkit/codec-kit'
import {
  createEditorXmlDocumentDefinition,
  editorXmlDocumentOperations,
  xmlElementNode,
} from '../../../../shared/documents/editor-xml-document-codec.js'
import {
  readAttributes,
  writeAttributesEditorLayout,
  type AttributesResult,
} from '../../../../shared/format/formats/attributes.js'
import type { EditorXmlElement } from '../../../../shared/format/formats/editor-xml.js'

/** A variant's `<Id Value="…"/>`, as written. */
const variantId = (variant: EditorXmlElement): string | undefined =>
  variant.children.find(child => child.name === 'Id')?.attributes['Value']

function unknownElements(document: AttributesResult): number {
  return (document.unknown?.length ?? 0) + document.attributes.reduce(
    (sum, item) => sum + (item.unknown?.length ?? 0) + item.values.reduce((values, value) => values + (value.unknown?.length ?? 0), 0),
    0,
  )
}

export const definition = createEditorXmlDocumentDefinition<AttributesResult>({
  id: 'blizzard/sc2-attributes',
  formatId: 'sc2-attributes',
  label: 'Attributes',
  rootTag: 'Attributes',
  pathPattern: /(?:^|[\\/])Attributes$/iu,
  diagnosticPrefix: 'blizzard.sc2-attributes',
  unsupportedFeatures: ['schema-aware-variant-editing', 'lobby-workflow'],
  read: readAttributes,
  layout: writeAttributesEditorLayout,
  summary: document => ({
    attributes: document.attributes.length,
    values: document.attributes.reduce((sum, item) => sum + item.values.length, 0),
    variants: document.variants.length,
    ...(document.defaultVariants === undefined ? {} : { defaultVariants: document.defaultVariants }),
    unknownElements: unknownElements(document),
  }),
  tree: document => [
    ...document.attributes.map((item, index) => ({
      kind: 'attribute',
      label: `Attribute ${item.id}`,
      preview: [item.type, item.access, `${item.values.length} values`, item.publicLocked ? 'locked' : ''].filter(Boolean).join(', '),
      semanticPath: ['attributes', String(index)],
      children: [
        ...item.values.map((value, valueIndex) => ({
          kind: 'attribute-value',
          label: `Value ${value.id}`,
          preview: value.name ?? '',
          semanticPath: ['attributes', String(index), 'values', String(valueIndex)],
        })),
        ...item.defaults.map((element, defaultIndex) => xmlElementNode(element, ['attributes', String(index), 'defaults', String(defaultIndex)])),
      ],
    })),
    ...document.variants.map((variant, index) => ({
      ...xmlElementNode(variant, ['variants', String(index)]),
      kind: 'variant',
      label: `Variant ${variantId(variant) ?? index}`,
      preview: `${variant.children.length} settings`,
    })),
    ...(document.unknown ?? []).map((element, index) => xmlElementNode(element, ['unknown', String(index)])),
  ],
  table: document => ({
    header: ['id', 'type', 'name', 'access', 'values', 'defaults'],
    rows: document.attributes.map(item => [
      item.id,
      item.type ?? '',
      item.name ?? '',
      item.access ?? '',
      item.values.map(value => value.id).join(' '),
      String(item.defaults.length),
    ]),
  }),
})
export const operations = editorXmlDocumentOperations(definition.id)
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
