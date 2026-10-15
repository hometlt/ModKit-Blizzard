/**
 * StarCraft string table codec (`.tbl`). Its strings are a table: the string id the game's data
 * files and triggers use (1-based), the string as the game shows it with control codes as `<N>`, and
 * what an entry keeps after its NUL for the editors (a unit's group and subgroup).
 */
import type { InspectionContext } from '@modkit/codec-kit'
import { createInspectionCodec, createTableDataSource } from '@modkit/codec-kit'
import { showControlCodes, textDecoderOf } from '../text.js'
import { readTbl } from './tbl.js'

export const TBL_COLUMNS = ['id', 'text', 'more'] as const

const definition = Object.freeze({
  id: 'blizzard/starcraft1-tbl',
  format: Object.freeze({ id: 'starcraft1-tbl', label: 'StarCraft string table' }),
  /** No magic: a count whose offsets fit, and a first string right after them. */
  async detect(prefix: Uint8Array) {
    if (prefix.byteLength < 2) return { confidence: 0 }
    const data = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength)
    const count = data.getUint16(0, true)
    if (count === 0) return { confidence: 0.3, kind: 'structure' as const, note: 'empty table' }
    if (prefix.byteLength < 4) return { confidence: 0 }
    return data.getUint16(2, true) >= 2 + 2 * count
      ? { confidence: 0.6, kind: 'structure' as const, note: `${String(count)} strings` }
      : { confidence: 0 }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    const table = readTbl(bytes, textDecoderOf(context.settings))
    return {
      summary: { format: 'starcraft1-tbl', strings: table.entries.length },
      metadata: [{ id: 'starcraft1-tbl', label: 'StarCraft string table', entries: [{ key: 'strings', value: table.entries.length }] }],
      traits: [],
      dataSources: {
        'common.view/table-data-source': createTableDataSource({
          header: [...TBL_COLUMNS],
          rows: table.entries.map(entry => [
            String(entry.index + 1),
            showControlCodes(entry.parts[0] ?? ''),
            entry.parts.slice(1).map(showControlCodes).join(' / '),
          ]),
        }),
      },
      diagnostics: table.diagnostics.map((message, index) => ({
        id: `starcraft1-tbl.${String(index)}`,
        code: 'blizzard/starcraft1-tbl-offset-outside',
        category: 'syntax' as const,
        severity: 'warning' as const,
        message,
      })),
      unsupportedFeatures: ['write'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
