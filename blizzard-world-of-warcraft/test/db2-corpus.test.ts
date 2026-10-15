/** Public content-source route: establishes the actual native DB2 profile before typed decoding. */
import { describe, expect, it } from 'vitest'
import { createContentSources } from '../src/game/content-sources.js'
import { readWdc5 } from '../src/db2/reader.js'
import { decodeWdcRows } from '../src/db2/rows.js'
import { parseDbd, selectDbdLayout } from '../src/db2/schema.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')('installed WoW databases', () => {
  it('reads appearance table headers through the selected retail content source', { timeout: 300_000 }, async () => {
    const root = process.env['MODKIT_WOW_ROOT']
    if (root === undefined) throw new Error('Set MODKIT_WOW_ROOT for the selected database corpus')
    const cache = process.env['MODKIT_INDEX_CACHE_DIRECTORY']
    const source = await createContentSources({ installationDirectory: root }, cache === undefined ? {} : { indexCacheDirectory: cache })
    const report: Record<string, unknown>[] = []
    try {
      for (const table of ['CreatureDisplayInfo', 'CreatureModelData', 'ChrModel', 'ChrCustomizationElement',
        'ChrCustomizationMaterial', 'ChrCustomizationGeoset', 'TextureFileData']) {
        let bytes: Uint8Array
        try { bytes = await source.read('local:wow', `dbfilesclient/${table.toLowerCase()}.db2`, 64 << 20) }
        catch (error) {
          report.push({ table, state: 'unavailable', message: error instanceof Error ? error.message : String(error),
            code: error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined,
            cause: error !== null && typeof error === 'object' && 'context' in error && error.context !== null &&
              typeof error.context === 'object' && 'cause' in error.context && typeof error.context.cause === 'string'
              ? error.context.cause.slice(0, 200) : undefined })
          continue
        }
        const file = readWdc5(bytes, 1_000_000)
        report.push({ table, signature: 'WDC5', bytes: bytes.length, schema: file.schema,
          records: file.records, layoutHash: file.layoutHash.toString(16).padStart(8, '0').toUpperCase(),
          fields: file.columns.length, flags: file.flags, sections: file.sections.length,
          encryptedSections: file.sections.filter(section => section.keyName !== 0n).length,
          storageModes: [...new Set(file.columns.map(column => column.compression))] })
        expect(file.records).toBeGreaterThan(0)
      }
      console.log(JSON.stringify({ route: 'content-source-native-db2', root, report }, null, 1))
      expect(report.filter(item => item['signature'] === 'WDC5').length, 'native headers must actually decode').toBeGreaterThan(0)
      // Header admission proves the two available tables. Full appearance remains a separate
      // strict scenario: its unresolved dependencies are reported above and in the handoff.
      for (const table of ['CreatureModelData', 'TextureFileData'])
        expect(report.find(item => item['table'] === table)?.['signature'], `${table} appearance dependency`).toBe('WDC5')
      if (process.env['MODKIT_WOW_REQUIRE_APPEARANCE'] === '1')
        expect(report.every(item => item['signature'] === 'WDC5'), 'full appearance dependencies').toBe(true)
    } finally { await source.dispose() }
  })
  it.skipIf(process.env['MODKIT_WOW_DBD_DIRECTORY'] === undefined)('decodes available table rows against externally supplied pinned DBD schemas', { timeout: 300_000 }, async () => {
    const directory = process.env['MODKIT_WOW_DBD_DIRECTORY']!
    const root = process.env['MODKIT_WOW_ROOT']!
    const cache = process.env['MODKIT_INDEX_CACHE_DIRECTORY']
    const source = await createContentSources({ installationDirectory: root }, cache === undefined ? {} : { indexCacheDirectory: cache })
    try {
      const report: Record<string, unknown>[] = []
      for (const table of ['CreatureModelData', 'TextureFileData']) {
        const bytes = await source.read('local:wow', `dbfilesclient/${table.toLowerCase()}.db2`, 64 << 20)
        const file = readWdc5(bytes, 1_000_000)
        const schema = parseDbd(await readFile(join(directory, `definitions__${table}.dbd`), 'utf8'))
        const layout = selectDbdLayout(schema, file.layoutHash, '12.1.0.69933')
        const decoded = decodeWdcRows(bytes, file, layout, 1_000_000)
        expect(decoded.rows.size).toBeGreaterThanOrEqual(file.records)
        expect(decoded.unavailable).toEqual([])
        const human = table === 'CreatureModelData' ? [...decoded.rows.values()].find(row => row.values['FileDataID'] === 1011653) : undefined
        if (table === 'CreatureModelData') expect(human, 'known human model must resolve from the native table').toBeDefined()
        report.push({ table, records: file.records, decoded: decoded.rows.size,
          layoutHash: file.layoutHash.toString(16), humanModelId: human?.id })
      }
      console.log(JSON.stringify({ route: 'content-source-typed-db2', report }, null, 1))
    } finally { await source.dispose() }
  })
})
