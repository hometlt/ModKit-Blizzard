import {
  createInspectionCodec,
  createRelationGraphSource,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromInput,
  replaceBytes,
} from '@modkit/codec-kit'
import {
  PRELOAD_TAG_LINKS,
  readPreload,
  writePreload,
  type PreloadResult,
} from '../../../../shared/format/formats/preload.js'

const ID = 'blizzard/sc2-preload'
const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-attribute', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

function diagnostic(id: string, code: string, message: string) {
  return Object.freeze({ id, category: 'syntax' as const, severity: 'warning' as const, code, message })
}

function diagnosticsFor(xml: string) {
  const diagnostics = []
  if (!/<Preload(?:\s[^>]*)?>/u.test(xml) || !/<\/Preload\s*>/u.test(xml)) {
    diagnostics.push(diagnostic('preload-root', 'blizzard.sc2-preload/missing-root', 'Document must contain a complete Preload root element'))
  }
  const child = /<([A-Za-z_][\w.-]*)(?:\s[^<>]*?)?>/gu
  let match: RegExpExecArray | null
  while ((match = child.exec(xml)) !== null) {
    const source = match[0]
    const tag = match[1]!
    if (tag === 'Preload' || source.startsWith('</') || source.endsWith('/>')) continue
    diagnostics.push(diagnostic(`preload-element-${match.index}`, 'blizzard.sc2-preload/non-self-closing-entry', `Preload entry <${tag}> must be self-closing`))
  }
  return Object.freeze(diagnostics)
}

function clone(data: PreloadResult): PreloadResult {
  return { entries: data.entries.map(entry => ({ tag: entry.tag, attrs: { ...entry.attrs } })) }
}

export const definition: any = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-preload', label: 'StarCraft II preload document', mediaType: 'application/xml' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    if (/(?:^|[\\/])Preload\.xml$/iu.test(uri)) return { confidence: 1, kind: 'context', note: 'Preload.xml' }
    return /<Preload(?:\s|>)/u.test(decoder.decode(prefix))
      ? { confidence: 0.9, kind: 'structure', note: 'Preload-root' }
      : { confidence: 0, kind: 'structure', note: 'Preload-root-missing' }
  },
  async inspect(bytes: Uint8Array, context: any) {
    const xml = decoder.decode(bytes)
    const data = readPreload(xml)
    if (data.entries.length * 3 + 1 > context.budget.maxNodes) throw new RangeError('Preload exceeds the inspection node budget')
    const diagnostics = diagnosticsFor(xml)
    const references = data.entries.flatMap((entry, index) => {
      if (entry.tag === 'Asset' && typeof entry.attrs['path'] === 'string') return [{ index, value: entry.attrs['path'], namespace: 'Asset', role: 'asset' }]
      const link = PRELOAD_TAG_LINKS.get(entry.tag)
      const value = link === undefined ? undefined : entry.attrs[link.attr]
      return value === undefined ? [] : [{ index, value, namespace: link!.namespace, role: 'catalog' }]
    })
    const entryNodes = data.entries.map((entry, index) => ({ id: `entry:${index}`, label: `${entry.tag} ${entry.attrs['id'] ?? entry.attrs['path'] ?? index}`, type: 'preload-entry', kind: 'sc2-preload-entry' }))
    const targetNodes = [...new Map(references.map(reference => {
      const key = `${reference.namespace}:${reference.value}`
      return [key.toLowerCase(), { id: `target:${key.toLowerCase()}`, label: key, type: reference.role === 'asset' ? 'asset' : 'catalog-entity', kind: reference.namespace }]
    })).values()]
    return {
      summary: { format: 'sc2-preload', entries: data.entries.length, references: references.length, tags: new Set(data.entries.map(entry => entry.tag)).size },
      metadata: [{ id: 'sc2-preload', label: 'SC2 Preload', entries: [{ key: 'entries', value: data.entries.length }, { key: 'references', value: references.length }] }],
      traits: [{ id: 'content.text', parameters: { language: 'xml' } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-preload', label: 'Preload', preview: `${data.entries.length} entries`, children: data.entries.map((entry, index) => ({ kind: 'preload-entry', label: entry.tag, preview: entry.attrs['id'] ?? entry.attrs['path'] ?? '', semanticPath: ['entries', String(index)] })) }),
        'common.view/table-data-source': createTableDataSource({ header: ['index', 'tag', 'target', 'attributes'], rows: data.entries.map((entry, index) => [String(index), entry.tag, entry.attrs['id'] ?? entry.attrs['path'] ?? '', JSON.stringify(entry.attrs)]) }),
        'common.view/relation-graph-source': createRelationGraphSource({ snapshotId: String(context.input.revisions.revision), nodes: [...entryNodes, ...targetNodes], edges: references.map(reference => ({ from: `entry:${reference.index}`, to: `target:${reference.namespace}:${reference.value}`.toLowerCase(), role: reference.role })), completeness: 'complete' }),
      },
      diagnostics,
      unsupportedFeatures: ['formatting-preserving-structured-edit'],
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-attribute': async (input: any) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('edit.content requires an object')
          if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= data.entries.length) throw new RangeError('index is outside Preload entries')
          if (typeof input.attribute !== 'string' || !/^[A-Za-z_]\w*$/u.test(input.attribute) || typeof input.value !== 'string') throw new TypeError('attribute must be an XML name and value must be a string')
          const next = clone(data)
          next.entries[input.index]!.attrs[input.attribute] = input.value
          const output = encoder.encode(writePreload(next))
          const reopened = readPreload(decoder.decode(output))
          if (reopened.entries[input.index]?.attrs[input.attribute] !== input.value) throw new TypeError('Preload writer did not preserve the requested value')
          return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-preload:set-attribute:${input.index}:${input.attribute}`, edits: [replaceBytes(0, bytes.byteLength, output, `set Preload entry ${input.index}.${input.attribute}`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: false, notes: ['Known entries and attributes are preserved; comments, whitespace and original line endings are normalized after a structured edit'] } }) }
        },
      },
    }
  },
})

export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
