/**
 * Read-only semantic completeness is independent of whether the host permits workspace edits.
 * Older hosts expose only the conservative workspaceIncomplete flag.
 *
 * @param {{ workspaceIncomplete: boolean, workspaceContext?: { semanticComplete: boolean } }} request
 */
export const languageWorkspaceIsSemanticallyIncomplete = request =>
  request.workspaceContext === undefined
    ? request.workspaceIncomplete
    : !request.workspaceContext.semanticComplete
