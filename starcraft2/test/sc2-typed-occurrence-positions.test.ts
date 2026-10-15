/**
 * The mixed SC2 occurrence projection gives every occurrence the line and column of its offset
 * (lines end at `\n`; a `\r` before it belongs to the line) and keeps, per document, declarations
 * before references in index order. Positions come from one line table per document.
 */
import { describe, expect, it } from 'vitest'
import { sc2MixedReferenceOccurrenceBatches } from '../shared/language/typed-occurrences.js'

const data = Object.freeze({
  uri: 'file:///Probe.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
  languageId: 'sc2-data',
  version: 1,
  text: '<Catalog>\r\n  <CUnit id="Marine"/>\r\n  <CUnit id="Medic" parent="Marine"/>\r\n</Catalog>\r\n',
})
const galaxy = Object.freeze({
  uri: 'file:///Probe.SC2Mod/MapScript.galaxy',
  languageId: 'galaxy',
  version: 1,
  text: 'void Init() {\n    point p;\n    UnitCreate(1, "Marine", 0, 1, p, 0.0);\n\n    UnitCreate(1, "Medic", 0, 1, p, 0.0);\n}\n',
})

// The line and column the projection must report: newlines before the offset, distance from the last.
const expected = (text: string, offset: number) => {
  const before = text.slice(0, offset)
  return { line: before.split('\n').length - 1, column: offset - before.lastIndexOf('\n') - 1 }
}

const documents = [galaxy, data]
const request = {
  document: galaxy,
  workspaceDocuments: documents,
  maxDocuments: 64,
  maxResults: 64,
  workspaceIncomplete: false,
  workspaceContext: {
    id: 'context',
    revision: 'revision',
    semanticComplete: true,
    documentOrigins: documents.map(document => ({
      uri: document.uri,
      layerId: 'probe',
      logicalId: document.uri,
      precedence: 1,
      sourceRevision: `rev:${document.version}`,
      readOnly: false,
    })),
  },
}

interface Occurrence {
  readonly role: string
  readonly semanticPath: readonly string[]
  readonly source: { readonly span: { utf16Offset: number; utf16Length: number; line: number; column: number } }
}

describe('SC2 mixed occurrence positions', () => {
  it('reports the line and column of every offset, including after CRLF lines', () => {
    const batches = sc2MixedReferenceOccurrenceBatches(request) as readonly {
      sourceUri: string
      occurrences: readonly Occurrence[]
    }[]
    const text = new Map(documents.map(document => [document.uri, document.text]))
    let checked = 0
    for (const batch of batches) {
      for (const occurrence of batch.occurrences) {
        const span = occurrence.source.span
        expect({ line: span.line, column: span.column }).toEqual(expected(text.get(batch.sourceUri)!, span.utf16Offset))
        checked += 1
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4)
    const script = batches.find(batch => batch.sourceUri === galaxy.uri)!
    const medic = script.occurrences.find(item => item.semanticPath.at(-1) === 'Medic')!
    expect(medic.source.span.line).toBe(4)
    expect(medic.source.span.column).toBe('    UnitCreate(1, "'.length)
    const catalog = batches.find(batch => batch.sourceUri === data.uri)!
    const marine = catalog.occurrences.find(item => item.role === 'declaration' && item.semanticPath.at(-1) === 'Marine')!
    expect(marine.source.span.line).toBe(1)
    expect(marine.source.span.column).toBe('  <CUnit id="'.length)
  })

  it('keeps declarations before references within each document', () => {
    const batches = sc2MixedReferenceOccurrenceBatches(request) as readonly { occurrences: readonly Occurrence[] }[]
    for (const batch of batches) {
      const roles = batch.occurrences.map(item => item.role)
      const firstReference = roles.indexOf('reference')
      if (firstReference >= 0) expect(roles.slice(firstReference)).not.toContain('declaration')
    }
  })
})
