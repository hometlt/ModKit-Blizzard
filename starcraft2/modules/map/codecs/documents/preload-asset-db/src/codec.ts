import {
  createInspectionCodec,
  createRelationGraphSource,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromInput,
  replaceBytes,
} from '@modkit/codec-kit'
import {
  preloadAssetDbEntries,
  readPreloadAssetDb,
  resolvePreloadAssetPaths,
  writePreloadAssetDb,
  type PreloadAssetDbResult,
} from '../../../../shared/format/formats/preload-asset-db.js'

const ID = 'blizzard/sc2-preload-asset-db'
const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-field', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

function diagnosticsFor(text: string) {
  const diagnostics: Array<{ id: string; category: 'syntax'; severity: 'warning'; code: string; message: string }> = []
  let section = false
  let entry = false
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    if (/^\[[^\]]+\]$/u.test(line)) { section = true; entry = false; continue }
    const equals = line.indexOf('=')
    if (equals < 1) {
      diagnostics.push({ id: `preload-asset-db-line-${index + 1}`, category: 'syntax', severity: 'warning', code: 'blizzard.sc2-preload-asset-db/malformed-line', message: `Line ${index + 1} is neither a section nor a key/value pair` })
      continue
    }
    const key = line.slice(0, equals).trim()
    if (!section) diagnostics.push({ id: `preload-asset-db-line-${index + 1}`, category: 'syntax', severity: 'warning', code: 'blizzard.sc2-preload-asset-db/field-before-section', message: `Line ${index + 1} appears before a section` })
    if (key === 'id') entry = true
    else if (!entry) diagnostics.push({ id: `preload-asset-db-line-${index + 1}`, category: 'syntax', severity: 'warning', code: 'blizzard.sc2-preload-asset-db/field-before-id', message: `Line ${index + 1} appears before an id entry` })
  }
  return Object.freeze(diagnostics)
}

function cloned(data: PreloadAssetDbResult): PreloadAssetDbResult {
  return {
    sections: data.sections.map(section => ({
      name: section.name,
      entries: section.entries.map(entry => ({
        id: entry.id,
        fields: Object.fromEntries(Object.entries(entry.fields).map(([key, values]) => [key, [...values]])),
        order: [...entry.order],
      })),
    })),
  }
}

export const definition: any = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-preload-asset-db', label: 'StarCraft II preload asset database', mediaType: 'text/plain' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    if (/(?:^|[\\/])PreloadAssetDB\.txt$/iu.test(uri)) return { confidence: 1, kind: 'context', note: 'PreloadAssetDB.txt' }
    const text = decoder.decode(prefix)
    return /^\s*\[[^\]\r\n]+\]\s*$/mu.test(text) && /^\s*id\s*=/mu.test(text)
      ? { confidence: 0.82, kind: 'structure', note: 'section-and-id-records' }
      : { confidence: 0, kind: 'structure', note: 'preload-asset-db-markers-missing' }
  },
  async inspect(bytes: Uint8Array, context: any) {
    const text = decoder.decode(bytes)
    const data = readPreloadAssetDb(text)
    const entries = preloadAssetDbEntries(data)
    const fieldCount = entries.reduce((sum, entry) => sum + Object.keys(entry.fields).length, 0)
    const resolved = data.sections.flatMap((section, sectionIndex) => section.entries.flatMap((entry, entryIndex) =>
      resolvePreloadAssetPaths(entry).map(path => ({ section, sectionIndex, entry, entryIndex, path }))))
    if (data.sections.length + entries.length + fieldCount + resolved.length > context.budget.maxNodes) {
      throw new RangeError('PreloadAssetDB exceeds the inspection node budget')
    }
    const diagnostics = diagnosticsFor(text)
    const entryNodes = data.sections.flatMap((section, sectionIndex) => section.entries.map((entry, entryIndex) => ({
      id: `entry:${sectionIndex}:${entryIndex}`,
      label: `${section.name}/${entry.id}`,
      type: 'preload-entry',
      kind: 'sc2-preload-asset-entry',
    })))
    const assetNodes = [...new Map(resolved.map(item => [item.path.toLowerCase(), {
      id: `asset:${item.path.toLowerCase()}`,
      label: item.path,
      type: 'asset',
      kind: 'asset',
    }])).values()]
    return {
      summary: { format: 'sc2-preload-asset-db', sections: data.sections.length, entries: entries.length, fields: fieldCount, resolvedAssets: resolved.length },
      metadata: [{ id: 'sc2-preload-asset-db', label: 'SC2 PreloadAssetDB', entries: [{ key: 'sections', value: data.sections.length }, { key: 'entries', value: entries.length }, { key: 'resolvedAssets', value: resolved.length }] }],
      traits: [{ id: 'content.text', parameters: { language: 'ini' } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-preload-asset-db', label: 'Preload asset database', preview: `${entries.length} entries`, children: data.sections.map(section => ({ kind: 'section', label: section.name, preview: `${section.entries.length} entries`, semanticPath: ['sections', section.name], children: section.entries.map(entry => ({ kind: 'entry', label: entry.id, preview: `${Object.keys(entry.fields).length} fields`, semanticPath: ['sections', section.name, entry.id] })) })) }),
        'common.view/table-data-source': createTableDataSource({ header: ['section', 'id', 'field', 'values'], rows: data.sections.flatMap(section => section.entries.flatMap(entry => Object.entries(entry.fields).map(([field, values]) => [section.name, entry.id, field, values.join(', ')]))) }),
        'common.view/relation-graph-source': createRelationGraphSource({ snapshotId: String(context.input.revisions.revision), nodes: [...entryNodes, ...assetNodes], edges: resolved.map(item => ({ from: `entry:${item.sectionIndex}:${item.entryIndex}`, to: `asset:${item.path.toLowerCase()}`, role: 'asset' })), completeness: 'complete' }),
      },
      diagnostics,
      unsupportedFeatures: ['formatting-preserving-structured-edit'],
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-field': async (input: any) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('edit.content requires an object')
          if (typeof input.section !== 'string' || input.section.length === 0 || typeof input.entryId !== 'string' || input.entryId.length === 0 || typeof input.field !== 'string' || input.field.length === 0) throw new TypeError('section, entryId and field must be non-empty strings')
          if (!Array.isArray(input.values) || !input.values.every((value: unknown) => typeof value === 'string')) throw new TypeError('values must be an array of strings')
          const next = cloned(data)
          const section = next.sections.find(item => item.name === input.section)
          const entry = section?.entries.find(item => item.id === input.entryId)
          if (entry === undefined) throw new RangeError(`PreloadAssetDB has no ${input.section}/${input.entryId}`)
          entry.fields[input.field] = [...input.values]
          if (!entry.order.includes(input.field)) entry.order.push(input.field)
          const output = encoder.encode(writePreloadAssetDb(next))
          const reopened = readPreloadAssetDb(decoder.decode(output))
          const written = reopened.sections.find(item => item.name === input.section)?.entries.find(item => item.id === input.entryId)?.fields[input.field]
          if (JSON.stringify(written) !== JSON.stringify(input.values)) throw new TypeError('PreloadAssetDB writer did not preserve the requested values')
          return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-preload-asset-db:set-field:${input.section}:${input.entryId}:${input.field}`, edits: [replaceBytes(0, bytes.byteLength, output, `set PreloadAssetDB ${input.section}/${input.entryId}.${input.field}`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: false, notes: ['Known sections and fields are preserved; comments, blank lines and original line endings are normalized after a structured edit'] } }) }
        },
      },
    }
  },
})

export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
