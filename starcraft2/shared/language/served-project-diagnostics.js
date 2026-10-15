/** Project diagnostic projection from the retained mod; no chain document texts reach this client. */
export async function servedProjectDiagnostics(request, port) {
  const context = request.workspaceContext?.modContext
  if (context?.document === undefined || port === undefined) throw new TypeError('project diagnostics need a mod context')
  const answer = await port.query(context.scope, { kind: 'language.verify', maxResults: request.maxResults,
    maxDocuments: request.maxDocuments, incomplete: request.workspaceIncomplete === true }, request.signal)
  if (answer?.revision !== context.revision) throw new Error('project diagnostics answered another revision')
  if (!Array.isArray(answer.documents) || typeof answer.isIncomplete !== 'boolean') throw new TypeError('invalid project diagnostic answer')
  return { documents: answer.documents.map(document => {
    if (typeof document.uri !== 'string' || !Number.isSafeInteger(document.documentVersion)) throw new TypeError('project diagnostic document has no Host identity')
    return { uri: document.uri, version: document.documentVersion, diagnostics: document.diagnostics }
  }), isIncomplete: answer.isIncomplete }
}
