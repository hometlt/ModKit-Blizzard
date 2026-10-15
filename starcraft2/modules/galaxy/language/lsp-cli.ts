#!/usr/bin/env node

import * as lsp from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT,
  type LanguageProvider,
} from '@modkit/sdk/language'
import { GALAXY_CAPABILITIES } from './capabilities.js'
import { GalaxyLspFeatureAdapter } from './lsp-feature-adapter.js'
import { createProvider } from './provider.js'
import { GalaxyWorkspaceDocumentSource } from './workspace/document-source.js'
import { GalaxyFileSystemIndex } from './workspace/file-system-index.js'

const connection = lsp.createConnection(lsp.ProposedFeatures.all)
const documents = new lsp.TextDocuments(TextDocument)
const lease = createProvider({ contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT, major: 1 })
const index = new GalaxyFileSystemIndex()
const workspaceRoots = new Set<string>()
let supportsWorkspaceFolderChanges = false
const source = new GalaxyWorkspaceDocumentSource(index, documents, {
  preparePrimary: async uri => {
    if (documents.get(uri) === undefined) await index.refresh(uri)
  },
  isCurrentWorkspaceDocument: uri => index.contains(uri),
  isEditableDocument: uri => index.contains(uri),
})
const provider = lease.value as unknown as LanguageProvider
const features = new GalaxyLspFeatureAdapter(
  provider,
  (uri, scope, signal) => source.snapshot(
    uri,
    provider.workspaceLanguageIds ?? ['galaxy'],
    scope,
    signal,
  ),
)

function roots(params: lsp.InitializeParams): string[] {
  if (params.workspaceFolders !== null && params.workspaceFolders !== undefined) {
    return params.workspaceFolders.map(folder => folder.uri)
  }
  return params.rootUri === null || params.rootUri === undefined ? [] : [params.rootUri]
}

connection.onInitialize(async params => {
  supportsWorkspaceFolderChanges = params.capabilities.workspace?.workspaceFolders === true
  workspaceRoots.clear()
  for (const uri of roots(params)) workspaceRoots.add(uri)
  await index.setRoots([...workspaceRoots])
  return { capabilities: GALAXY_CAPABILITIES }
})
connection.onInitialized(() => {
  if (!supportsWorkspaceFolderChanges) return
  connection.workspace.onDidChangeWorkspaceFolders(async event => {
    for (const folder of event.removed) workspaceRoots.delete(folder.uri)
    for (const folder of event.added) workspaceRoots.add(folder.uri)
    await index.setRoots([...workspaceRoots])
  })
})
connection.onCompletion((params, token) => features.completion(params, token))
connection.onDefinition((params, token) => features.definition(params, token))
connection.onHover((params, token) => features.hover(params, token))
connection.onReferences((params, token) => features.references(params, token))
connection.onSignatureHelp((params, token) => features.signatureHelp(params, token))
connection.onDocumentFormatting((params, token) => features.formatting(params, token))
connection.onDocumentSymbol((params, token) => features.documentSymbols(params, token))
connection.onWorkspaceSymbol((params, token) => features.workspaceSymbols(params, token))
connection.onPrepareRename((params, token) => features.prepareRename(params, token))
connection.onRenameRequest((params, token) => features.rename(params, token))
documents.onDidChangeContent(async event => {
  const result = await features.diagnostics(event.document.uri, lsp.CancellationToken.None)
  connection.sendDiagnostics({
    uri: event.document.uri,
    version: event.document.version,
    diagnostics: result?.diagnostics ?? [],
  })
})
documents.onDidSave(event => { void index.refresh(event.document.uri) })
documents.onDidClose(event => {
  void index.refresh(event.document.uri)
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] })
})
connection.onDidChangeWatchedFiles(event => {
  for (const change of event.changes) void index.refresh(change.uri)
})
documents.listen(connection)
connection.onShutdown(() => lease.release())
connection.listen()
