/** Client projection of a retained server rename: revision, document mapping and open versions. */
export async function servedRenameFeature(request, port, feature) {
  const context = request.workspaceContext?.modContext
  if (context?.document === undefined || port === undefined) throw new TypeError('served rename needs a mod context')
  const answer = await port.query(context.scope, {
    kind: feature === 'rename' ? 'language.rename' : 'language.prepare-rename',
    document: context.document, position: request.position, maxResults: request.maxResults,
    maxDocuments: request.maxDocuments, incomplete: request.workspaceIncomplete === true,
    ...(feature === 'rename' ? { newName: request.newName, maxEdits: request.maxEdits } : {}),
  }, request.signal)
  if (answer?.revision !== context.revision) throw new Error('served rename answered another revision')
  if (feature !== 'rename') return answer.preparation ?? undefined
  if (answer.edit === null) return undefined
  if (answer.edit?.isComplete !== true || !Array.isArray(answer.edit.changes)) throw new TypeError('served rename returned an invalid edit')
  return { isComplete: true, documentChanges: answer.edit.changes.map(change => {
    const document = answer.documents?.[change.document]
    if (typeof document?.uri !== 'string' || !Number.isSafeInteger(document.documentVersion)) throw new TypeError('served rename named an invalid document')
    return { uri: document.uri, documentVersion: document.documentVersion, edits: change.edits }
  }) }
}
