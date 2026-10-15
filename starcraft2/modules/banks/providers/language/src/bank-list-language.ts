import { scanXml } from '@modkit/codec-kit'
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDiagnosticList,
  LanguageDocumentSymbolList,
  LanguageFeatureRequest,
  LanguageHover,
  LanguageLocationList,
  LanguagePosition,
  LanguagePositionRequest,
  LanguageProvider,
  LanguageRange,
  LanguageSymbol,
  LanguageToken,
} from '@modkit/sdk'
import { SC2_BANK_LANGUAGE_ID } from './language.js'

export const SC2_BANK_LIST_LANGUAGE_ID = 'sc2-bank-list'

class Positions {
  readonly #starts = [0]
  constructor(readonly text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) this.#starts.push(index + 1)
    }
  }
  position(offset: number): LanguagePosition {
    let line = 0
    while (line + 1 < this.#starts.length && (this.#starts[line + 1] ?? 0) <= offset) line += 1
    return { line, character: offset - (this.#starts[line] ?? 0) }
  }
  offset(position: LanguagePosition): number {
    return (this.#starts[position.line] ?? 0) + position.character
  }
  range(start: number, end: number): LanguageRange {
    return { start: this.position(start), end: this.position(end) }
  }
}

interface BankEntry {
  readonly name: string
  readonly player?: string
  readonly nameStart: number
  readonly nameEnd: number
  readonly tagStart: number
  readonly tagEnd: number
  readonly attributes: readonly {
    readonly name: string
    readonly value: string
    readonly nameStart: number
    readonly nameEnd: number
    readonly valueStart: number
    readonly valueEnd: number
  }[]
}

function entries(text: string): readonly BankEntry[] {
  const root = scanXml(text).find(element => element.tag === 'BankList')
  if (root === undefined) return []
  return root.children.flatMap(element => {
    if (element.tag !== 'Bank') return []
    const name = element.attrs.find(attribute => attribute.name === 'Name')
    if (name === undefined) return []
    const player = element.attrs.find(attribute => attribute.name === 'Player')?.value
    return [
      {
        name: name.value,
        ...(player === undefined ? {} : { player }),
        nameStart: name.valueStart,
        nameEnd: name.valueEnd,
        tagStart: element.tagStart,
        tagEnd: element.tagEnd,
        attributes: element.attrs,
      },
    ]
  })
}

function diagnosticsFor(text: string): readonly LanguageDiagnostic[] {
  const index = new Positions(text)
  const roots = scanXml(text)
  const root = roots.find(element => element.tag === 'BankList')
  if (root === undefined) {
    return [
      {
        range: index.range(0, Math.min(text.length, 1)),
        severity: 'error',
        code: 'bank-list-root-missing',
        source: SC2_BANK_LIST_LANGUAGE_ID,
        message: 'BankList.xml requires a <BankList> root element.',
      },
    ]
  }
  const diagnostics: LanguageDiagnostic[] = []
  const seen = new Set<string>()
  for (const element of root.children) {
    if (element.tag !== 'Bank') {
      diagnostics.push({
        range: index.range(element.tagStart, element.tagEnd),
        severity: 'error',
        code: 'bank-list-unknown-element',
        source: SC2_BANK_LIST_LANGUAGE_ID,
        message: `BankList has no <${element.tag}> child; expected <Bank>.`,
      })
      continue
    }
    const name = element.attrs.find(attribute => attribute.name === 'Name')
    if (name === undefined || name.value.length === 0) {
      diagnostics.push({
        range: index.range(element.tagStart, element.tagEnd),
        severity: 'error',
        code: 'bank-list-name-required',
        source: SC2_BANK_LIST_LANGUAGE_ID,
        message: 'A BankList <Bank> entry requires a non-empty Name attribute.',
      })
    }
    for (const attribute of element.attrs) {
      if (attribute.name === 'Name' || attribute.name === 'Player') continue
      diagnostics.push({
        range: index.range(attribute.nameStart, attribute.nameEnd),
        severity: 'warning',
        code: 'bank-list-unknown-attribute',
        source: SC2_BANK_LIST_LANGUAGE_ID,
        message: `Unknown BankList attribute ${attribute.name}; expected Name or Player.`,
      })
    }
    if (name !== undefined && name.value.length > 0) {
      const player = element.attrs.find(attribute => attribute.name === 'Player')?.value ?? ''
      const identity = `${name.value}\0${player}`
      if (seen.has(identity)) {
        diagnostics.push({
          range: index.range(name.valueStart, name.valueEnd),
          severity: 'error',
          code: 'bank-list-duplicate-entry',
          source: SC2_BANK_LIST_LANGUAGE_ID,
          message: `Duplicate BankList entry ${name.value}${player === '' ? '' : ` for player ${player}`}.`,
        })
      }
      seen.add(identity)
    }
  }
  return diagnostics
}

function tokensFor(text: string): readonly LanguageToken[] {
  const index = new Positions(text)
  return scanXml(text).flatMap(root => {
    const elements = [root, ...root.children]
    return elements.flatMap(element => [
      { range: index.range(element.tagStart, element.tagEnd), kind: 'type' as const },
      ...element.attrs.flatMap(attribute => [
        { range: index.range(attribute.nameStart, attribute.nameEnd), kind: 'property' as const },
        {
          range: index.range(attribute.valueStart, attribute.valueEnd),
          kind: attribute.name === 'Player' ? ('number' as const) : ('string' as const),
        },
      ]),
    ])
  })
}

function symbolsFor(text: string): readonly LanguageSymbol[] {
  const index = new Positions(text)
  return entries(text).map(entry => ({
    name: entry.name,
    kind: 'module',
    detail: entry.player === undefined ? 'shared bank' : `player ${entry.player}`,
    range: index.range(entry.tagStart, entry.nameEnd),
    selectionRange: index.range(entry.nameStart, entry.nameEnd),
  }))
}

function selectedEntry(text: string, position: LanguagePosition): BankEntry | undefined {
  const offset = new Positions(text).offset(position)
  return entries(text).find(entry => offset >= entry.nameStart && offset <= entry.nameEnd)
}

function bankNameFromUri(uri: string): string | undefined {
  try {
    const pathname = decodeURIComponent(new URL(uri).pathname)
    const name = pathname.split('/').at(-1) ?? ''
    return name.replace(/\.SC2Bank$/iu, '') || undefined
  } catch {
    return undefined
  }
}

export function createSc2BankListLanguageProvider(): LanguageProvider {
  return {
    contract: 'common.language/document-analysis',
    languageIds: [SC2_BANK_LIST_LANGUAGE_ID],
    workspaceLanguageIds: [SC2_BANK_LIST_LANGUAGE_ID, SC2_BANK_LANGUAGE_ID],
    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens: tokensFor(request.document.text),
        diagnostics:
          request.include?.diagnostics === false ? [] : diagnosticsFor(request.document.text),
        symbols: request.include?.symbols === false ? [] : symbolsFor(request.document.text),
      }
    },
    async diagnostics(request: LanguageFeatureRequest): Promise<LanguageDiagnosticList> {
      const all = diagnosticsFor(request.document.text)
      return {
        diagnostics: all.slice(0, request.maxResults),
        isIncomplete: all.length > request.maxResults,
      }
    },
    async documentSymbols(request: LanguageFeatureRequest): Promise<LanguageDocumentSymbolList> {
      const all = symbolsFor(request.document.text)
      return {
        symbols: all.slice(0, request.maxResults),
        isIncomplete: all.length > request.maxResults,
      }
    },
    async completion(request: LanguagePositionRequest): Promise<LanguageCompletionList> {
      const offset = new Positions(request.document.text).offset(request.position)
      const before = request.document.text.slice(0, offset)
      const open = before.lastIndexOf('<')
      if (open < 0 || before.indexOf('>', open) >= 0) return { items: [], isIncomplete: false }
      const inside = before.slice(open + 1)
      if (!/\s/u.test(inside)) {
        return {
          items: [
            {
              label: 'Bank',
              kind: 'class',
              insertText: 'Bank Name="$1" Player="$2"/>',
              insertTextFormat: 'snippet',
            },
          ],
          isIncomplete: false,
        }
      }
      const used = new Set(/\b(Name|Player)\s*=/gu.exec(inside)?.slice(1) ?? [])
      return {
        items: ['Name', 'Player']
          .filter(name => !used.has(name))
          .map(name => ({
            label: name,
            kind: 'property',
            insertText: `${name}="$1"`,
            insertTextFormat: 'snippet' as const,
          })),
        isIncomplete: false,
      }
    },
    async hover(request: LanguagePositionRequest): Promise<LanguageHover | undefined> {
      const entry = selectedEntry(request.document.text, request.position)
      if (entry === undefined) return undefined
      return {
        markdown: `**${entry.name}** — ${entry.player === undefined ? 'shared bank' : `player ${entry.player} bank`}`,
        range: new Positions(request.document.text).range(entry.nameStart, entry.nameEnd),
        provenance: 'blizzard/sc2-bank-list',
      }
    },
    async definition(request: LanguagePositionRequest): Promise<LanguageLocationList> {
      const entry = selectedEntry(request.document.text, request.position)
      if (entry === undefined) return { locations: [], isIncomplete: false }
      const locations = request.workspaceDocuments
        .filter(
          document =>
            document.languageId === SC2_BANK_LANGUAGE_ID &&
            bankNameFromUri(document.uri) === entry.name,
        )
        .slice(0, request.maxResults)
        .map(document => ({
          uri: document.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        }))
      return {
        locations,
        isIncomplete: request.workspaceIncomplete || locations.length >= request.maxResults,
      }
    },
  }
}
