import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { definition as headerDefinition } from '../codecs/publication-header/src/codec.js'
import { definition as localeDefinition } from '../codecs/publication-locale/src/codec.js'
import { composePublicationHeader } from '../publishing/header-composer.js'
import { localeDocument } from '../publishing/package-compiler.js'

const budget = { budget: { maxNodes: 10000 } }

describe('reading a publication as the game describes it', () => {
  it('shows a header by the names its own schema gives the fields', async () => {
    const bytes = composePublicationHeader({
      identity: { id: 264259, version: 65536 },
      fileName: 'ModTest13.SC2Mod',
      region: 'eu',
      archiveSha256: 'a'.repeat(64),
      namespace: 339441,
      locales: [{ locale: 'enUS', sha256: 'b'.repeat(64) }],
      previews: [{ sha256: 'c'.repeat(64) }],
      dependencies: [{ id: 2, version: 0 }],
    })

    const result = await headerDefinition.inspect(bytes, budget as never)
    expect(result.summary).toMatchObject({ id: 264259, version: '1.0', name: 'ModTest13.SC2Mod' })
    const table = result.dataSources['common.view/table-data-source'] as unknown as {
      rows(request: { kind: string; from: number; count: number }): Promise<{ items: { cells: string[] }[] }>
    }
    const page = await table.rows({ kind: 'range', from: 0, count: 100 })
    const rows = Object.fromEntries(page.items.map(row => [row.cells[0], row.cells[1]]))
    expect(rows['m_mapNamespace']).toBe('339441')
    expect(rows['m_extraDependencies']).toBe('1 item(s)')
    // A depot handle says what it addresses, not just forty bytes.
    expect(rows['m_archiveCacheHandle']).toBe(`archive · EU · ${'a'.repeat(16)}…`)
  })

  it('reads a locale document as the strings it holds', async () => {
    const bytes = localeDocument('enUS', new Map([[1, 'ModTest13'], [2, 'ModTest13']]))
    const detected = await localeDefinition.detect(bytes, 'file:///x/enUS.s2ml')
    expect(detected.confidence).toBe(1)
    const result = await localeDefinition.inspect(bytes, { ...budget, input: {} } as never)
    expect(result.summary).toMatchObject({ rootTag: 'Locale', elements: 2 })
  })
})
