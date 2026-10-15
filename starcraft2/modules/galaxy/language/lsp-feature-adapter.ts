import * as lsp from 'vscode-languageserver/node'
import type {
  LanguageDocument,
  LanguageFeatureRequest,
  LanguageProvider,
  LanguageSymbol,
} from '@modkit/sdk/language'

export interface GalaxyLspSnapshot {
  readonly document: LanguageDocument
  readonly workspaceDocuments: readonly LanguageDocument[]
  readonly workspaceIncomplete: boolean
  readonly editableDocumentUris: readonly string[]
}

export type GalaxyLspSnapshotScope = 'document' | 'workspace' | 'current-workspace'

export interface GalaxyCompletionOptions {
  readonly functionExpand?: 'None' | 'Parenthesis' | 'ArgumentsNull' | 'ArgumentsDefault'
  readonly triggerKind?: number
  readonly triggerCharacter?: string
}

export type GalaxyLspSnapshotSource = (
  uri: string,
  scope: GalaxyLspSnapshotScope,
  signal?: AbortSignal,
) => Promise<GalaxyLspSnapshot | undefined>

const COMPLETION_KIND: Readonly<Record<string, lsp.CompletionItemKind>> = Object.freeze({
  class: lsp.CompletionItemKind.Class,
  constant: lsp.CompletionItemKind.Constant,
  enum: lsp.CompletionItemKind.Enum,
  'enum-member': lsp.CompletionItemKind.EnumMember,
  field: lsp.CompletionItemKind.Field,
  file: lsp.CompletionItemKind.File,
  function: lsp.CompletionItemKind.Function,
  interface: lsp.CompletionItemKind.Interface,
  keyword: lsp.CompletionItemKind.Keyword,
  module: lsp.CompletionItemKind.Module,
  namespace: lsp.CompletionItemKind.Module,
  parameter: lsp.CompletionItemKind.Variable,
  property: lsp.CompletionItemKind.Property,
  snippet: lsp.CompletionItemKind.Snippet,
  struct: lsp.CompletionItemKind.Struct,
  text: lsp.CompletionItemKind.Text,
  type: lsp.CompletionItemKind.TypeParameter,
  variable: lsp.CompletionItemKind.Variable,
})

const SYMBOL_KIND: Readonly<Record<string, lsp.SymbolKind>> = Object.freeze({
  class: lsp.SymbolKind.Class,
  constant: lsp.SymbolKind.Constant,
  enum: lsp.SymbolKind.Enum,
  'enum-member': lsp.SymbolKind.EnumMember,
  field: lsp.SymbolKind.Field,
  file: lsp.SymbolKind.File,
  function: lsp.SymbolKind.Function,
  interface: lsp.SymbolKind.Interface,
  module: lsp.SymbolKind.Module,
  namespace: lsp.SymbolKind.Namespace,
  property: lsp.SymbolKind.Property,
  struct: lsp.SymbolKind.Struct,
  variable: lsp.SymbolKind.Variable,
})

const DIAGNOSTIC_SEVERITY: Readonly<Record<string, lsp.DiagnosticSeverity>> = Object.freeze({
  error: lsp.DiagnosticSeverity.Error,
  warning: lsp.DiagnosticSeverity.Warning,
  information: lsp.DiagnosticSeverity.Information,
  hint: lsp.DiagnosticSeverity.Hint,
})

const MAX_RESULTS = 5_000
const MAX_DOCUMENTS = 1_024

function cancellation(token: lsp.CancellationToken) {
  const controller = new AbortController()
  if (token.isCancellationRequested) controller.abort('lsp-cancelled')
  const subscription = token.onCancellationRequested(() => controller.abort('lsp-cancelled'))
  return { signal: controller.signal, dispose: () => subscription.dispose() }
}

const symbol = (value: LanguageSymbol): lsp.DocumentSymbol => ({
  name: value.name,
  detail: value.detail ?? '',
  kind: SYMBOL_KIND[value.kind] ?? lsp.SymbolKind.Variable,
  range: value.range,
  selectionRange: value.selectionRange,
  ...(value.children === undefined ? {} : { children: value.children.map(symbol) }),
})

/** Maps the protocol-neutral Galaxy provider to the workspace LSP module contract. */
export class GalaxyLspFeatureAdapter {
  constructor(
    private readonly provider: LanguageProvider,
    private readonly snapshots: GalaxyLspSnapshotSource,
  ) {}

  private async call<T>(
    uri: string,
    token: lsp.CancellationToken,
    invoke: (request: LanguageFeatureRequest) => Promise<T> | undefined,
    additions: Readonly<Record<string, unknown>> = {},
    scope: GalaxyLspSnapshotScope = 'document',
  ): Promise<T | undefined> {
    const link = cancellation(token)
    try {
      const snapshot = await this.snapshots(uri, scope, link.signal)
      if (snapshot === undefined) return undefined
      const pending = invoke({
        ...snapshot,
        maxResults: MAX_RESULTS,
        maxDocuments: MAX_DOCUMENTS,
        ...additions,
        signal: link.signal,
      })
      return pending === undefined ? undefined : await pending
    } finally {
      link.dispose()
    }
  }

  async completion(
    params: lsp.CompletionParams,
    token: lsp.CancellationToken,
    options: GalaxyCompletionOptions = {},
  ) {
    const list = await this.call(
      params.textDocument.uri,
      token,
      request => this.provider.completion?.(request as never),
      { position: params.position, ...options },
    )
    if (list === undefined) return undefined
    const items = list.items.flatMap(item => {
      if (item.kind === 'subject-ref') return []
      return [{
        label: item.label,
        kind: COMPLETION_KIND[item.kind] ?? lsp.CompletionItemKind.Text,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.documentation === undefined ? {} : { documentation: item.documentation }),
        ...(item.insertText === undefined ? {} : { insertText: item.insertText }),
        ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
        ...(item.insertTextFormat === 'snippet'
          ? { insertTextFormat: lsp.InsertTextFormat.Snippet }
          : {}),
      }]
    })
    return { items, isIncomplete: list.isIncomplete }
  }

  async definition(params: lsp.TextDocumentPositionParams, token: lsp.CancellationToken) {
    const list = await this.call(
      params.textDocument.uri,
      token,
      request => this.provider.definition?.(request as never),
      { position: params.position },
    )
    return list?.locations.map(location => lsp.Location.create(location.uri, location.range))
  }

  async hover(params: lsp.TextDocumentPositionParams, token: lsp.CancellationToken) {
    const result = await this.call(
      params.textDocument.uri,
      token,
      request => this.provider.hover?.(request as never),
      { position: params.position },
    )
    return result === undefined
      ? undefined
      : {
          contents: { kind: lsp.MarkupKind.Markdown, value: result.markdown },
          ...(result.range === undefined ? {} : { range: result.range }),
        }
  }

  async references(
    params: lsp.ReferenceParams,
    token: lsp.CancellationToken,
    currentWorkspaceOnly = false,
  ) {
    const list = await this.call(
      params.textDocument.uri,
      token,
      request => this.provider.references?.(request as never),
      { position: params.position, includeDeclaration: params.context.includeDeclaration },
      currentWorkspaceOnly ? 'current-workspace' : 'workspace',
    )
    return list?.locations.map(location => lsp.Location.create(location.uri, location.range))
  }

  async signatureHelp(params: lsp.SignatureHelpParams, token: lsp.CancellationToken) {
    const result = await this.call(
      params.textDocument.uri,
      token,
      request => this.provider.signatureHelp?.(request as never),
      { position: params.position },
    )
    return result === undefined
      ? undefined
      : {
          signatures: result.signatures.map(signature => ({
            label: signature.label,
            ...(signature.documentation === undefined
              ? {}
              : { documentation: signature.documentation }),
            parameters: signature.parameters.map(parameter => ({
              label: parameter.label,
              ...(parameter.documentation === undefined
                ? {}
                : { documentation: parameter.documentation }),
            })),
          })),
          activeSignature: result.activeSignature,
          activeParameter: result.activeParameter,
        }
  }

  async formatting(params: lsp.DocumentFormattingParams, token: lsp.CancellationToken) {
    const result = await this.call(
      params.textDocument.uri,
      token,
      request => this.provider.formatting?.(request as never),
      {
        options: {
          tabSize: params.options.tabSize,
          insertSpaces: params.options.insertSpaces,
          ...(typeof params.options.insertFinalNewline === 'boolean'
            ? { finalNewline: params.options.insertFinalNewline }
            : {}),
        },
      },
    )
    return result?.edits.map(edit => lsp.TextEdit.replace(edit.range, edit.newText))
  }

  async documentSymbols(params: lsp.DocumentSymbolParams, token: lsp.CancellationToken) {
    const result = await this.call(
      params.textDocument.uri,
      token,
      request => this.provider.documentSymbols?.(request),
    )
    return result?.symbols.map(symbol)
  }

  async diagnostics(uri: string, token: lsp.CancellationToken) {
    const result = await this.call(
      uri,
      token,
      request => this.provider.diagnostics?.(request),
    )
    if (result === undefined) return undefined
    return {
      diagnostics: result.diagnostics.map(item => ({
        range: item.range,
        severity: DIAGNOSTIC_SEVERITY[item.severity] ?? lsp.DiagnosticSeverity.Error,
        message: item.message,
        ...(item.code === undefined ? {} : { code: item.code }),
        ...(item.source === undefined ? {} : { source: item.source }),
      })),
      isIncomplete: result.isIncomplete,
    }
  }

  async workspaceSymbols(params: lsp.WorkspaceSymbolParams, token: lsp.CancellationToken) {
    const result = await this.call(
      '',
      token,
      request => this.provider.workspaceSymbols?.(request as never),
      { query: params.query },
      'workspace',
    )
    return result?.symbols.map(item => ({
      name: item.name,
      kind: SYMBOL_KIND[item.kind] ?? lsp.SymbolKind.Variable,
      location: lsp.Location.create(item.location.uri, item.location.range),
      ...(item.containerName === undefined ? {} : { containerName: item.containerName }),
    }))
  }

  async prepareRename(params: lsp.TextDocumentPositionParams, token: lsp.CancellationToken) {
    return this.call(
      params.textDocument.uri,
      token,
      request => this.provider.prepareRename?.(request as never),
      { position: params.position },
    )
  }

  async rename(params: lsp.RenameParams, token: lsp.CancellationToken) {
    const result = await this.call(
      params.textDocument.uri,
      token,
      request => this.provider.rename?.(request as never),
      { position: params.position, newName: params.newName, maxEdits: MAX_RESULTS },
      'workspace',
    )
    if (result === undefined) return undefined
    return {
      documentChanges: result.documentChanges.map(change =>
        lsp.TextDocumentEdit.create(
          { uri: change.uri, version: change.documentVersion },
          [...change.edits],
        ),
      ),
    }
  }
}
