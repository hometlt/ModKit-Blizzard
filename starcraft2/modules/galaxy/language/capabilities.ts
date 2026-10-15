import * as lsp from 'vscode-languageserver/node';

// Verbatim from galaxy/server.ts onInitialize (was inline lines 483-509).
export const GALAXY_CAPABILITIES: lsp.ServerCapabilities = {
    workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    textDocumentSync: { change: lsp.TextDocumentSyncKind.Incremental, openClose: true },
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    completionProvider: { triggerCharacters: ['.', '/'], resolveProvider: false },
    signatureHelpProvider: { triggerCharacters: ['(', ','] },
    documentFormattingProvider: true,
    definitionProvider: true,
    hoverProvider: true,
    referencesProvider: true,
    renameProvider: { prepareProvider: true },
};
