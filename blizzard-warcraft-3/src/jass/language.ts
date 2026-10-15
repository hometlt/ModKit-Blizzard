/**
 * Language services for JASS (`jass`) over `common.language/document-analysis@1`: highlighting,
 * outline, hover with the declaration and its comment, definition, references, rename, completion,
 * signature help and diagnostics.
 *
 * Names resolve across the JASS documents of the request's workspace, so `common.j` and
 * `Blizzard.j` in the same workspace give a map script its natives. Undefined names are reported
 * only when the workspace holds natives at all: without the game's libraries every native would
 * look undefined, which says nothing about the script.
 */
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageCompletionItem,
  LanguageDiagnostic,
  LanguageDocument,
  LanguageFeatureRequest,
  LanguageHover,
  LanguageLocation,
  LanguagePosition,
  LanguagePositionRequest,
  LanguageProvider,
  LanguageRange,
  LanguageSymbol,
  LanguageToken,
  LanguageTokenKind,
  LanguageWorkspaceEdit,
} from '@modkit/sdk'
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import { parseWts } from '../wts/format.js'
import { WTS_LANGUAGE_ID, wtsPreview } from '../wts/language.js'
import { JASS_KEYWORDS, lineStarts, positionAt, type JassToken } from './lexer.js'
import { parseJass, type JassExpression, type JassSpan, type JassStatement } from './parser.js'
import {
  functionAt,
  globalTable,
  indexJassDocument,
  resolveJassName,
  type JassDocumentIndex,
  type JassSymbol,
} from './symbols.js'

export const JASS_LANGUAGE_ID = 'jass'

interface Indexed extends JassDocumentIndex {
  readonly document: LanguageDocument
  readonly starts: readonly number[]
}

const PRIMITIVES = new Set(['integer', 'real', 'boolean', 'string', 'handle', 'code', 'nothing'])

export function createJassLanguageProvider(): LanguageProvider {
  // Parsed documents by uri and version: a workspace of 3 MB scripts is not parsed per keystroke.
  const cache = new Map<string, Indexed>()
  const indexed = (document: LanguageDocument): Indexed => {
    const key = `${document.uri}#${String(document.version)}`
    let entry = cache.get(key)
    if (entry === undefined) {
      entry = {
        ...indexJassDocument(document.uri, parseJass(document.text)),
        document,
        starts: lineStarts(document.text),
      }
      if (cache.size >= 64) cache.delete(cache.keys().next().value!)
      cache.set(key, entry)
    }
    return entry
  }
  const workspace = (request: LanguageFeatureRequest) => {
    const documents = [
      request.document,
      ...request.workspaceDocuments.filter(
        document => document.uri !== request.document.uri && document.languageId === JASS_LANGUAGE_ID,
      ),
    ]
    const indexes = documents.map(indexed)
    return { primary: indexes[0]!, indexes, globals: globalTable(indexes) }
  }
  const range = (index: Indexed, span: JassSpan): LanguageRange => ({
    start: positionAt(index.starts, span.start),
    end: positionAt(index.starts, span.end),
  })
  const offsetOf = (index: Indexed, position: LanguagePosition) =>
    (index.starts[position.line] ?? index.document.text.length) + position.character
  const identifierAt = (index: Indexed, offset: number): JassToken | undefined =>
    index.program.tokens.find(token => token.kind === 'identifier' && token.start <= offset && offset <= token.end)
  const indexOf = (indexes: readonly Indexed[], uri: string) => indexes.find(index => index.uri === uri)
  const location = (indexes: readonly Indexed[], symbol: JassSymbol): LanguageLocation[] => {
    const home = indexOf(indexes, symbol.uri)
    return home === undefined ? [] : [{ uri: symbol.uri, range: range(home, symbol.nameSpan) }]
  }
  const same = (left: JassSymbol | undefined, right: JassSymbol) =>
    left !== undefined && left.uri === right.uri && left.nameSpan.start === right.nameSpan.start
  /** Every identifier that means `symbol`, in the documents that can see it. */
  const occurrences = (indexes: readonly Indexed[], globals: ReadonlyMap<string, JassSymbol>, symbol: JassSymbol) =>
    indexes.flatMap(index =>
      (symbol.kind === 'parameter' || symbol.kind === 'local') && index.uri !== symbol.uri
        ? []
        : index.program.tokens
            .filter(
              token =>
                token.kind === 'identifier' &&
                token.text === symbol.name &&
                same(resolveJassName(index, globals, token.text, token.start), symbol),
            )
            .map(token => ({ index, token })),
    )
  const symbolAt = (request: LanguagePositionRequest) => {
    const space = workspace(request)
    const offset = offsetOf(space.primary, request.position)
    const token = identifierAt(space.primary, offset)
    const symbol =
      token === undefined ? undefined : resolveJassName(space.primary, space.globals, token.text, token.start)
    return { ...space, offset, token, symbol }
  }

  const comment = (index: Indexed, symbol: JassSymbol): string => {
    // The comment lines right above a declaration describe it, as the game's libraries write them.
    const line = positionAt(index.starts, symbol.span.start).line
    const lines: string[] = []
    for (let above = line - 1; above >= 0; above -= 1) {
      const text = index.document.text.slice(index.starts[above], index.starts[above + 1]).trim()
      if (!text.startsWith('//')) break
      lines.unshift(text.replace(/^\/\/+\s?/u, ''))
    }
    return lines.join('\n').trim()
  }

  const tokenKind = (index: Indexed, globals: ReadonlyMap<string, JassSymbol>, token: JassToken, next?: JassToken): LanguageTokenKind | undefined => {
    switch (token.kind) {
      case 'keyword':
        return 'keyword'
      case 'integer':
      case 'real':
      case 'rawcode':
        return 'number'
      case 'string':
        return 'string'
      case 'operator':
        return 'operator'
      case 'identifier': {
        const symbol = resolveJassName(index, globals, token.text, token.start)
        if (symbol === undefined) return next?.text === '(' ? 'function' : PRIMITIVES.has(token.text) ? 'type' : 'variable'
        return symbol.kind === 'native' || symbol.kind === 'function'
          ? 'function'
          : symbol.kind === 'type'
            ? 'type'
            : symbol.kind === 'parameter'
              ? 'parameter'
              : 'variable'
      }
      default:
        return undefined
    }
  }

  const documentSymbols = (index: Indexed): LanguageSymbol[] =>
    index.globals.map(symbol => ({
      name: symbol.name,
      kind:
        symbol.kind === 'type'
          ? 'class'
          : symbol.kind === 'global'
            ? symbol.constant === true
              ? 'constant'
              : 'variable'
            : 'function',
      range: range(index, symbol.span),
      selectionRange: range(index, symbol.nameSpan),
      detail: symbol.signature,
    }))

  const syntaxDiagnostics = (index: Indexed): LanguageDiagnostic[] =>
    index.program.errors.map(error => ({
      range: range(index, error),
      severity: 'error',
      message: error.message,
      code: 'jass/syntax',
      source: 'jass',
    }))

  /** Undefined names, unknown types and argument counts, once the workspace holds natives. */
  const semanticDiagnostics = (index: Indexed, globals: ReadonlyMap<string, JassSymbol>): LanguageDiagnostic[] => {
    const diagnostics: LanguageDiagnostic[] = []
    const report = (span: JassSpan, message: string, code: string) =>
      diagnostics.push({ range: range(index, span), severity: 'error', message, code, source: 'jass' })
    const typeKnown = (name: string) => PRIMITIVES.has(name) || globals.get(name)?.kind === 'type'
    const expression = (node: JassExpression): void => {
      switch (node.kind) {
        case 'name':
        case 'index':
          if (resolveJassName(index, globals, node.name.name, node.start) === undefined)
            report(node.name, `«${node.name.name}» is not declared`, 'jass/undeclared')
          if (node.kind === 'index') expression(node.index)
          return
        case 'function-ref':
        case 'call': {
          const target = globals.get(node.name.name)
          if (target === undefined || (target.kind !== 'function' && target.kind !== 'native'))
            report(node.name, `«${node.name.name}» is not a declared function`, 'jass/undeclared-function')
          if (node.kind === 'call') {
            if (target?.parameters !== undefined && target.parameters.length !== node.args.length)
              report(
                node,
                `«${node.name.name}» takes ${String(target.parameters.length)} argument(s), not ${String(node.args.length)}`,
                'jass/arguments',
              )
            node.args.forEach(expression)
          }
          return
        }
        case 'unary':
          return expression(node.operand)
        case 'binary':
          expression(node.left)
          return expression(node.right)
        case 'paren':
          return expression(node.inner)
        default:
          return
      }
    }
    const statement = (node: JassStatement): void => {
      switch (node.kind) {
        case 'set':
          if (resolveJassName(index, globals, node.name.name, node.start) === undefined)
            report(node.name, `«${node.name.name}» is not declared`, 'jass/undeclared')
          if (node.index !== undefined) expression(node.index)
          return expression(node.value)
        case 'call':
          return expression(node.call)
        case 'if':
          for (const branch of node.branches) {
            expression(branch.condition)
            branch.body.forEach(statement)
          }
          return node.otherwise?.forEach(statement)
        case 'loop':
          return node.body.forEach(statement)
        case 'exitwhen':
          return expression(node.condition)
        case 'return':
          return node.value === undefined ? undefined : expression(node.value)
        case 'debug':
          return statement(node.statement)
      }
    }
    for (const declaration of index.program.declarations) {
      if (declaration.kind === 'type') {
        if (!typeKnown(declaration.base.name)) report(declaration.base, `unknown type «${declaration.base.name}»`, 'jass/unknown-type')
      } else if (declaration.kind === 'globals') {
        for (const variable of declaration.variables) {
          if (!typeKnown(variable.type.name)) report(variable.type, `unknown type «${variable.type.name}»`, 'jass/unknown-type')
          if (variable.init !== undefined) expression(variable.init)
        }
      } else {
        for (const parameter of declaration.parameters)
          if (!typeKnown(parameter.type.name)) report(parameter.type, `unknown type «${parameter.type.name}»`, 'jass/unknown-type')
        if (!typeKnown(declaration.returns.name))
          report(declaration.returns, `unknown type «${declaration.returns.name}»`, 'jass/unknown-type')
        if (declaration.kind === 'function') {
          for (const variable of declaration.locals) {
            if (!typeKnown(variable.type.name)) report(variable.type, `unknown type «${variable.type.name}»`, 'jass/unknown-type')
            if (variable.init !== undefined) expression(variable.init)
          }
          declaration.body.forEach(statement)
        }
      }
    }
    return diagnostics
  }
  const librariesLoaded = (globals: ReadonlyMap<string, JassSymbol>) =>
    [...globals.values()].some(symbol => symbol.kind === 'native')

  /** A `"TRIGSTR_<n>"` string at the position, and the entry of the workspace's strings it names. */
  const trigstrAt = (request: LanguageFeatureRequest, index: Indexed, offset: number) => {
    const token = index.program.tokens.find(item => item.kind === 'string' && item.start <= offset && offset <= item.end)
    const match = token === undefined ? null : /^"TRIGSTR_(\d+)"$/u.exec(token.text)
    if (token === undefined || match === null) return undefined
    for (const document of request.workspaceDocuments) {
      if (document.languageId !== WTS_LANGUAGE_ID) continue
      const entry = parseWts(document.text).entries.find(item => item.id === Number(match[1]))
      if (entry !== undefined) return { token, document, entry }
    }
    return undefined
  }

  return {
    contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT,
    languageIds: [JASS_LANGUAGE_ID],
    // The map's strings: a "TRIGSTR_<n>" in the script shows and opens its text.
    workspaceLanguageIds: [JASS_LANGUAGE_ID, WTS_LANGUAGE_ID],

    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      const index = indexed(request.document)
      const globals = globalTable([index])
      const include = request.include ?? { tokens: true, diagnostics: true, symbols: true }
      const tokens: LanguageToken[] = []
      if (include.tokens !== false) {
        const all = index.program.tokens
        all.forEach((token, at) => {
          const kind = tokenKind(index, globals, token, all[at + 1])
          if (kind !== undefined) tokens.push({ range: range(index, token), kind })
        })
        for (const comment of index.program.comments) tokens.push({ range: range(index, comment), kind: 'comment' })
      }
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens,
        diagnostics: include.diagnostics === false ? [] : syntaxDiagnostics(index),
        symbols: include.symbols === false ? [] : documentSymbols(index),
      }
    },

    async documentSymbols(request) {
      return { symbols: documentSymbols(indexed(request.document)), isIncomplete: false }
    },

    async diagnostics(request) {
      const { primary, globals } = workspace(request)
      return {
        diagnostics: [
          ...syntaxDiagnostics(primary),
          ...(librariesLoaded(globals) ? semanticDiagnostics(primary, globals) : []),
        ].slice(0, request.maxResults),
        isIncomplete: false,
      }
    },

    async hover(request): Promise<LanguageHover | undefined> {
      const { indexes, token, symbol, primary: here, offset } = symbolAt(request)
      const string = trigstrAt(request, here, offset)
      if (string !== undefined)
        return {
          markdown: `**TRIGSTR_${String(string.entry.id).padStart(3, '0')}** — ${wtsPreview(string.entry)}`,
          range: range(here, string.token),
        }
      if (token === undefined || symbol === undefined) return undefined
      const home = indexOf(indexes, symbol.uri)
      const described = home === undefined ? '' : comment(home, symbol)
      const primary = indexes[0]!
      return {
        markdown: `\`\`\`jass\n${symbol.signature}\n\`\`\`${described === '' ? '' : `\n\n${described}`}`,
        range: range(primary, token),
      }
    },

    async definition(request) {
      const { indexes, symbol, primary: here, offset } = symbolAt(request)
      const string = trigstrAt(request, here, offset)
      if (string !== undefined) {
        const starts = lineStarts(string.document.text)
        return {
          locations: [
            {
              uri: string.document.uri,
              range: { start: positionAt(starts, string.entry.idSpan.start), end: positionAt(starts, string.entry.idSpan.end) },
            },
          ],
          isIncomplete: false,
        }
      }
      return { locations: symbol === undefined ? [] : location(indexes, symbol), isIncomplete: false }
    },

    async references(request) {
      const { indexes, globals, symbol } = symbolAt(request)
      if (symbol === undefined) return { locations: [], isIncomplete: false }
      const found = occurrences(indexes, globals, symbol)
        .filter(({ index, token }) => request.includeDeclaration !== false || !(index.uri === symbol.uri && token.start === symbol.nameSpan.start))
        .map(({ index, token }) => ({ uri: index.uri, range: range(index, token) }))
      return {
        locations: found.slice(0, request.maxResults),
        isIncomplete: found.length > request.maxResults || (symbol.kind !== 'local' && symbol.kind !== 'parameter' && request.workspaceIncomplete),
      }
    },

    async prepareRename(request) {
      const { primary, token, symbol } = symbolAt(request)
      if (token === undefined || symbol === undefined) return undefined
      return { range: range(primary, token), placeholder: token.text }
    },

    async rename(request): Promise<LanguageWorkspaceEdit | undefined> {
      const { indexes, globals, symbol } = symbolAt(request)
      if (symbol === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(request.newName) || JASS_KEYWORDS.has(request.newName))
        return undefined
      const scoped = symbol.kind === 'local' || symbol.kind === 'parameter'
      // A global renamed in a partial workspace would leave the unseen uses behind.
      if (!scoped && request.workspaceIncomplete) return undefined
      const readOnly = new Set(
        request.workspaceContext?.documentOrigins.filter(origin => origin.readOnly).map(origin => origin.uri) ?? [],
      )
      const found = occurrences(indexes, globals, symbol)
      if (found.some(({ index }) => readOnly.has(index.uri)) || found.length > request.maxEdits) return undefined
      const byDocument = new Map<Indexed, JassToken[]>()
      for (const { index, token } of found) byDocument.set(index, [...(byDocument.get(index) ?? []), token])
      return {
        documentChanges: [...byDocument].map(([index, tokens]) => ({
          uri: index.uri,
          documentVersion: index.document.version,
          edits: tokens.map(token => ({ range: range(index, token), newText: request.newName })),
        })),
        isComplete: true,
      }
    },

    async completion(request) {
      const { primary, globals, offset } = symbolAt(request)
      const items: LanguageCompletionItem[] = []
      const scope = functionAt(primary, offset)
      for (const symbol of scope?.symbols.values() ?? [])
        items.push({ label: symbol.name, kind: symbol.kind === 'parameter' ? 'parameter' : 'variable', detail: symbol.signature })
      for (const symbol of globals.values()) {
        if (scope?.symbols.has(symbol.name)) continue
        items.push({
          label: symbol.name,
          kind:
            symbol.kind === 'type'
              ? 'type'
              : symbol.kind === 'global'
                ? symbol.constant === true
                  ? 'constant'
                  : 'variable'
                : 'function',
          detail: symbol.signature,
        })
      }
      for (const keyword of JASS_KEYWORDS) items.push({ label: keyword, kind: 'keyword' })
      return { items: items.slice(0, request.maxResults), isIncomplete: items.length > request.maxResults }
    },

    async signatureHelp(request) {
      const { primary, globals, offset } = symbolAt(request)
      // The innermost call whose parentheses are still open at the cursor.
      const tokens = primary.program.tokens.filter(token => token.end <= offset)
      let depth = 0
      let commas = 0
      for (let at = tokens.length - 1; at >= 0; at -= 1) {
        const token = tokens[at]!
        if (token.text === ')') depth += 1
        else if (token.text === '(') {
          if (depth > 0) depth -= 1
          else {
            const callee = tokens[at - 1]
            const target = callee?.kind === 'identifier' ? globals.get(callee.text) : undefined
            if (target?.parameters === undefined) return undefined
            return {
              signatures: [
                {
                  label: target.signature,
                  parameters: target.parameters.map(parameter => ({ label: `${parameter.type.name} ${parameter.name.name}` })),
                },
              ],
              activeSignature: 0,
              activeParameter: Math.min(commas, Math.max(0, target.parameters.length - 1)),
            }
          }
        } else if (token.text === ',' && depth === 0) commas += 1
      }
      return undefined
    },

    async workspaceSymbols(request) {
      const { indexes } = workspace(request)
      const query = request.query.toLowerCase()
      const symbols = indexes.flatMap(index =>
        index.globals
          .filter(symbol => symbol.name.toLowerCase().includes(query))
          .map(symbol => ({
            name: symbol.name,
            kind: symbol.kind === 'type' ? ('class' as const) : symbol.kind === 'global' ? ('variable' as const) : ('function' as const),
            location: { uri: index.uri, range: range(index, symbol.nameSpan) },
            detail: symbol.signature,
          })),
      )
      return { symbols: symbols.slice(0, request.maxResults), isIncomplete: symbols.length > request.maxResults }
    },
  }
}
