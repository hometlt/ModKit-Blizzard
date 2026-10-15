/**
 * Language services for Warcraft III trigger strings (`war3-wts`): outline, highlighting, the
 * text of a string on hover, where a string is used (`TRIGSTR_<n>` in the map's JASS), colours of
 * `|cAARRGGBB` codes, and diagnostics for malformed or repeated entries.
 */
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageColorInformation,
  LanguageDocument,
  LanguageFeatureRequest,
  LanguageLocation,
  LanguagePosition,
  LanguageProvider,
  LanguageRange,
  LanguageSymbol,
  LanguageToken,
} from '@modkit/sdk'
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import { lineStarts, positionAt } from '../jass/lexer.js'
import { parseWts, TRIGSTR, type WtsEntry, type WtsFile, type WtsSpan } from './format.js'

export const WTS_LANGUAGE_ID = 'war3-wts'
const JASS_LANGUAGE_ID = 'jass'
const CODE = /\|[cC][0-9A-Fa-f]{8}|\|[rRnN]/gu

interface Parsed {
  readonly document: LanguageDocument
  readonly file: WtsFile
  readonly starts: readonly number[]
}

const range = (starts: readonly number[], span: WtsSpan): LanguageRange => ({
  start: positionAt(starts, span.start),
  end: positionAt(starts, span.end),
})

/** A short one-line preview of a string's text. */
export const wtsPreview = (entry: WtsEntry): string => {
  const flat = entry.text.replace(CODE, '').replace(/\s+/gu, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}

/** Where `TRIGSTR_<id>` is written in `text`, as spans. */
export function trigstrSpans(text: string, id: number): WtsSpan[] {
  return [...text.matchAll(TRIGSTR)]
    .filter(match => Number(match[1]) === id)
    .map(match => ({ start: match.index, end: match.index + match[0].length }))
}

export function createWtsLanguageProvider(): LanguageProvider {
  const cache = new Map<string, Parsed>()
  const parsed = (document: LanguageDocument): Parsed => {
    const key = `${document.uri}#${String(document.version)}`
    let entry = cache.get(key)
    if (entry === undefined) {
      entry = { document, file: parseWts(document.text), starts: lineStarts(document.text) }
      if (cache.size >= 32) cache.delete(cache.keys().next().value!)
      cache.set(key, entry)
    }
    return entry
  }
  const offsetOf = (item: Parsed, position: LanguagePosition) =>
    (item.starts[position.line] ?? item.document.text.length) + position.character
  const entryAt = (item: Parsed, offset: number) =>
    item.file.entries.find(entry => entry.header.start <= offset && offset <= entry.header.end)

  const symbols = (item: Parsed): LanguageSymbol[] =>
    item.file.entries.map(entry => ({
      name: `STRING ${String(entry.id)}`,
      kind: 'constant',
      range: range(item.starts, entry),
      selectionRange: range(item.starts, entry.idSpan),
      detail: wtsPreview(entry),
    }))

  const tokens = (item: Parsed): LanguageToken[] => {
    const out: LanguageToken[] = []
    const text = item.document.text
    for (const entry of item.file.entries) {
      const keyword = text.indexOf('STRING', entry.header.start)
      out.push({ range: range(item.starts, { start: keyword, end: keyword + 6 }), kind: 'keyword' })
      out.push({ range: range(item.starts, entry.idSpan), kind: 'number' })
      // The text as strings between its format codes, the codes as operators.
      let from = entry.textSpan.start
      const body = text.slice(entry.textSpan.start, entry.textSpan.end)
      for (const match of body.matchAll(CODE)) {
        const start = entry.textSpan.start + match.index
        if (start > from) out.push({ range: range(item.starts, { start: from, end: start }), kind: 'string' })
        out.push({ range: range(item.starts, { start, end: start + match[0].length }), kind: 'operator' })
        from = start + match[0].length
      }
      if (entry.textSpan.end > from) out.push({ range: range(item.starts, { start: from, end: entry.textSpan.end }), kind: 'string' })
    }
    for (const match of text.matchAll(/^[ \t]*\/\/.*$/gmu))
      out.push({ range: range(item.starts, { start: match.index, end: match.index + match[0].replace(/\r$/u, '').length }), kind: 'comment' })
    return out
  }

  const colors = (item: Parsed): LanguageColorInformation[] =>
    [...item.document.text.matchAll(/\|[cC]([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})/gu)].map(match => ({
      range: range(item.starts, { start: match.index, end: match.index + match[0].length }),
      color: {
        alpha: parseInt(match[1]!, 16) / 255,
        red: parseInt(match[2]!, 16) / 255,
        green: parseInt(match[3]!, 16) / 255,
        blue: parseInt(match[4]!, 16) / 255,
      },
    }))

  const uses = (request: LanguageFeatureRequest, id: number): LanguageLocation[] =>
    request.workspaceDocuments
      .filter(document => document.languageId === JASS_LANGUAGE_ID)
      .flatMap(document => {
        const starts = lineStarts(document.text)
        return trigstrSpans(document.text, id).map(span => ({ uri: document.uri, range: range(starts, span) }))
      })

  return {
    contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT,
    languageIds: [WTS_LANGUAGE_ID],
    // A string is used by the map's script: references reach its JASS.
    workspaceLanguageIds: [WTS_LANGUAGE_ID, JASS_LANGUAGE_ID],

    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      const item = parsed(request.document)
      const include = request.include ?? { tokens: true, diagnostics: true, symbols: true }
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens: include.tokens === false ? [] : tokens(item),
        diagnostics:
          include.diagnostics === false
            ? []
            : item.file.errors.map(error => ({
                range: range(item.starts, error),
                severity: error.code === 'wts/duplicate' ? ('warning' as const) : ('error' as const),
                message: error.message,
                code: error.code,
                source: 'war3-wts',
              })),
        symbols: include.symbols === false ? [] : symbols(item),
      }
    },

    async documentSymbols(request) {
      return { symbols: symbols(parsed(request.document)), isIncomplete: false }
    },

    async workspaceSymbols(request) {
      const query = request.query.toLowerCase()
      const found = request.workspaceDocuments
        .filter(document => document.languageId === WTS_LANGUAGE_ID)
        .flatMap(document => {
          const item = parsed(document)
          return item.file.entries
            .filter(entry => `string ${String(entry.id)} ${entry.text}`.toLowerCase().includes(query))
            .map(entry => ({
              name: `STRING ${String(entry.id)}`,
              kind: 'constant' as const,
              location: { uri: document.uri, range: range(item.starts, entry.idSpan) },
              detail: wtsPreview(entry),
            }))
        })
      return { symbols: found.slice(0, request.maxResults), isIncomplete: found.length > request.maxResults }
    },

    async hover(request) {
      const item = parsed(request.document)
      const entry = entryAt(item, offsetOf(item, request.position))
      if (entry === undefined) return undefined
      return {
        markdown: `**TRIGSTR_${String(entry.id).padStart(3, '0')}**${entry.comment === '' ? '' : ` — ${entry.comment}`}\n\n${entry.text.replace(CODE, '')}`,
        range: range(item.starts, entry.header),
      }
    },

    async references(request) {
      const item = parsed(request.document)
      const entry = entryAt(item, offsetOf(item, request.position))
      if (entry === undefined) return { locations: [], isIncomplete: false }
      const locations = [
        ...(request.includeDeclaration === false ? [] : [{ uri: request.document.uri, range: range(item.starts, entry.idSpan) }]),
        ...uses(request, entry.id),
      ]
      return { locations: locations.slice(0, request.maxResults), isIncomplete: request.workspaceIncomplete || locations.length > request.maxResults }
    },

    async documentColors(request) {
      return { colors: colors(parsed(request.document)), isIncomplete: false }
    },

    async colorPresentations(request) {
      const hex = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
      const { color } = request
      return {
        presentations: [{ label: `|c${hex(color.alpha)}${hex(color.red)}${hex(color.green)}${hex(color.blue)}` }],
        isIncomplete: false,
      }
    },

    async diagnostics(request) {
      const item = parsed(request.document)
      return {
        diagnostics: item.file.errors.slice(0, request.maxResults).map(error => ({
          range: range(item.starts, error),
          severity: error.code === 'wts/duplicate' ? ('warning' as const) : ('error' as const),
          message: error.message,
          code: error.code,
          source: 'war3-wts',
        })),
        isIncomplete: false,
      }
    },
  }
}
