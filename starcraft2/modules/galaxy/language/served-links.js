/**
 * The cross-language catalog link index a loaded mod's server holds (owner: [SC2] Triggers & Galaxy
 * semantics, `sc2-workspace-links.js`; held by the SC2 mod server,
 * `modules/mod/shared/workspace/mod-contexts.ts`).
 *
 * The same `createSc2WorkspaceLinkIndex` the language providers build over a workspace snapshot,
 * built once per server revision over the chain's documents of the mixed SC2 languages — classified
 * by the host's language routes, as the snapshot is — so a document's diagnostics (and later other
 * cross-language answers) need no snapshot. Documents are named by the server's layer and path
 * (`servedLinkUri`). The snapshot's bounds apply in chain order: 4 096 documents, 64 MiB a document
 * and 128 MiB in all; past them, or over an incomplete chain, the index is incomplete and reports
 * no unresolved or ambiguous literal, as on a snapshot.
 */
import { SC2_MIXED_WORKSPACE_LANGUAGE_IDS, createSc2WorkspaceLinkIndex } from './sc2-workspace-links.js'
import { servedDocumentUri as servedLinkUri } from './served-document-uri.js'

const MAX_DOCUMENTS = 4_096
const MAX_DOCUMENT_CHARS = 64 * 1024 * 1024
const MAX_WORKSPACE_CHARS = 128 * 1024 * 1024

/** The languages whose documents the index reads. */
export const SERVED_LINK_LANGUAGE_IDS = SC2_MIXED_WORKSPACE_LANGUAGE_IDS

/** Preserve the published link name; semantic analyses use the same implementation. */
export { servedLinkUri }

/**
 * The link index over these documents (`{ layerId, path, languageId, text }`, chain order);
 * `incomplete` when the chain itself is (an unresolved dependency).
 */
export function createServedLinkIndex(documents, incomplete) {
  const kept = []
  let chars = 0
  let dropped = false
  for (const document of documents) {
    if (kept.length >= MAX_DOCUMENTS || document.text.length > MAX_DOCUMENT_CHARS ||
        chars + document.text.length > MAX_WORKSPACE_CHARS) {
      dropped = true
      continue
    }
    chars += document.text.length
    kept.push(Object.freeze({
      uri: servedLinkUri(document.layerId, document.path),
      languageId: document.languageId,
      version: 0,
      text: document.text,
    }))
  }
  const primary = kept[0] ?? Object.freeze({ uri: servedLinkUri('', ''), languageId: 'galaxy', version: 0, text: '' })
  return createSc2WorkspaceLinkIndex({
    document: primary,
    workspaceDocuments: kept,
    maxDocuments: Math.max(1, kept.length + 1),
    workspaceIncomplete: incomplete || dropped,
  })
}
