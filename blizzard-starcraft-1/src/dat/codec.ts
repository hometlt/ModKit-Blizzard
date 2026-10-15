/**
 * StarCraft data table codec (`arr\units.dat` and the other Brood War tables of `dat.ts`): the table
 * as rows — the entry id, its name, then every field. The file name picks the layout; a file whose
 * size is not its layout's is refused. Names come from the string table the game names them with,
 * bound as a companion from the same storage: `rez\stat_txt.tbl` for units, weapons, upgrades and
 * technologies, the table's own `arr\<file>.tbl` for images, sounds, portraits and missions.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import { codecRefusal, createInspectionCodec, createTableDataSource } from '@modkit/codec-kit'
import type { CodecCandidateSource } from '@modkit/sdk'
import { loadStringTable, stringTableRequirement } from '../tbl/companion.js'
import type { StringTable } from '../tbl/tbl.js'
import { showControlCodes, textDecoderOf } from '../text.js'
import { fileNameOf } from '../uri.js'
import { datLayoutOf, readDat, type DatLayout, type DatTable, type DatValue } from './dat.js'

const NAMES = 'names'

/** The string table that names a layout's entries, as a path from the storage root. */
function namesPath(layout: DatLayout): string | undefined {
  if (layout.names === undefined) return undefined
  return layout.names.kind === 'own-tbl' ? `arr/${layout.file.replace(/\.dat$/u, '.tbl')}` : 'rez/stat_txt.tbl'
}

function nameOf(table: DatTable, strings: StringTable | undefined, entry: number): string {
  const names = table.layout.names
  if (names === undefined || strings === undefined) return ''
  let index: number | undefined = entry
  if (names.kind !== 'stat_txt-by-index') {
    const column = table.layout.fields.findIndex(field => field.name === names.field)
    const id = table.columns[column]?.[entry]
    index = typeof id === 'number' && id > 0 ? id - 1 : undefined
  }
  return index === undefined ? '' : showControlCodes(strings.entries[index]?.parts[0] ?? '')
}

const cell = (value: DatValue) => (value === null ? '' : typeof value === 'number' ? String(value) : value.join(', '))

const definition = Object.freeze({
  id: 'blizzard/starcraft1-dat',
  format: Object.freeze({ id: 'starcraft1-dat', label: 'StarCraft data table' }),
  async planInput(source: CodecCandidateSource) {
    const layout = 'ref' in source ? datLayoutOf(fileNameOf(source.ref.uri)) : undefined
    const path = layout === undefined ? undefined : namesPath(layout)
    return Object.freeze({
      originKind: 'bundle' as const,
      candidate: Object.freeze({ bindingId: 'content', role: 'content', ownership: 'owned' as const }),
      requirements: Object.freeze(path === undefined ? [] : [stringTableRequirement(NAMES, path)]),
    })
  },
  /** No magic: the file name must be one of the game's tables; its size is checked on open. */
  async detect(_prefix: Uint8Array, uri: string) {
    const layout = datLayoutOf(fileNameOf(uri))
    return layout === undefined ? { confidence: 0 } : { confidence: 0.9, kind: 'structure' as const, note: `${layout.file} layout` }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    const layout = datLayoutOf(fileNameOf(context.source.ref.uri))
    if (layout === undefined) throw codecRefusal('blizzard.starcraft1/dat-unknown-table', 'not a StarCraft data table this codec knows')
    let table: DatTable
    try {
      table = readDat(bytes, layout)
    } catch (error) {
      throw codecRefusal('blizzard.starcraft1/dat-layout-mismatch', error instanceof Error ? error.message : String(error), { file: layout.file })
    }
    const path = namesPath(layout)
    const loaded = path === undefined ? undefined : await loadStringTable(context.input, NAMES, path, textDecoderOf(context.settings), context.signal)
    const strings = loaded?.table
    const note = loaded?.note
    const rows = Array.from({ length: layout.entries }, (_, entry) => [
      String(entry),
      nameOf(table, strings, entry),
      ...table.columns.map(column => cell(column[entry] ?? null)),
    ])
    return {
      summary: { format: 'starcraft1-dat', table: layout.file, entries: layout.entries, fields: layout.fields.length, named: strings !== undefined },
      metadata: [{
        id: 'starcraft1-dat',
        label: `StarCraft ${layout.label}`,
        entries: [
          { key: 'table', value: layout.file },
          { key: 'entries', value: layout.entries },
          { key: 'fields', value: layout.fields.length },
        ],
      }],
      traits: [],
      dataSources: {
        'common.view/table-data-source': createTableDataSource({ header: ['id', 'name', ...layout.fields.map(field => field.name)], rows }),
      },
      ...(layout.names === undefined
        ? {}
        : {
            companions: [{
              id: NAMES,
              role: 'localization',
              cardinality: 'zero-or-one' as const,
              required: false,
              ...(loaded === undefined || loaded.bindingIds.length === 0 ? { state: 'missing' as const } : { state: 'resolved' as const, bindingIds: loaded.bindingIds }),
            }],
          }),
      diagnostics: note === undefined
        ? []
        : [{ id: 'starcraft1-dat.names', code: 'blizzard/starcraft1-dat-names', category: 'dependency' as const, severity: 'information' as const, message: note }],
      unsupportedFeatures: ['write', 'orders.dat'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
