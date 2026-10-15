/**
 * The Galaxy answers a loaded mod's server gives (owner: [SC2] Triggers & Galaxy semantics; served
 * by the SC2 mod server, `modules/mod/shared/workspace/mod-contexts.ts`): references, hover,
 * signature help, definition, completion and diagnostics (with the server's link index).
 *
 * One retained `GalaxyWorkspaceIndex` over every Galaxy file of a mod chain — the same index and the
 * same `galaxyIndexedReferences`, `galaxyHoverIn`, `galaxySignatureHelpIn` and `galaxyDefinitionIn`
 * the language provider runs over a workspace snapshot — so a request carries only its live
 * document instead of the chain's scripts. Hover and signature text is computed under the URI the
 * editor names the document by (`uri`), as the snapshot path does. Files are keyed
 * by the server's own `layerId` and path; a new revision re-analyses only the files whose text
 * changed. The bounds of the snapshot path apply: a file over 2 MiB, or files past 16 MiB in all
 * (in chain order, the asked document always kept), are left out and the answer is incomplete.
 * Answers name documents by layer and path with UTF-16 offsets and ranges; the caller maps them to
 * its URIs, sorts and bounds them. Catalog links and scoped locals are answered by the provider.
 * Canonical served filenames share the existing bounded analysis cache with mixed links;
 * each session retains its own mutable workspace index and scope resolution.
 */
import { GalaxyWorkspaceIndex } from '@modkit/blizzard-starcraft2/galaxy/analysis/workspace-index.js'
import { servedDocumentUri as keyOf } from './served-document-uri.js'
import {
  galaxyCompletionIn,
  galaxyDiagnosticsIn,
  galaxyDefinitionIn,
  galaxyHoverIn,
  galaxyIndexedContext,
  galaxyIndexedReferences,
  galaxyNativeIndexedFile,
  galaxyRangeAt,
  galaxySignatureHelpIn,
  galaxyRenameIn,
  galaxyPrepareRenameIn,
  galaxyWorkspaceSymbolsIn,
} from './semantic-provider.js'

const MAX_DOCUMENT_CHARS = 2 * 1024 * 1024
const MAX_WORKSPACE_CHARS = 16 * 1024 * 1024

/** A retained index over one chain's Galaxy files, brought up to date per server revision. */
export function createGalaxyServedReferences() {
  const index = new GalaxyWorkspaceIndex()
  index.addAnalyzedFile(galaxyNativeIndexedFile)
  /** key -> { layerId, path, text } of the indexed files. */
  const files = new Map()
  let incomplete = false
  /** The positioned context of an indexed document under the editor's URI; undefined when not indexed. */
  const contextAt = (layerId, path, offset, uri) => {
    const key = keyOf(layerId, path)
    const asked = files.get(key)
    if (asked === undefined) return undefined
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > asked.text.length) {
      throw new RangeError('Galaxy served offset is outside its document')
    }
    const document = Object.freeze({ uri, languageId: 'galaxy', version: 0, text: asked.text })
    return galaxyIndexedContext(index, key, document, offset)
  }
  return {
    /** Workspace symbols enumerate this retained index; no second semantic workspace is built. */
    workspaceSymbols(layerId, path, query, maxResults, partial) {
      const key = keyOf(layerId, path)
      const context = contextAt(layerId, path, 0, key)
      if (context === undefined) return { symbols: [], isIncomplete: true }
      const byUri = new Map([...files].map(([uri, file]) => [uri, { uri, languageId: 'galaxy', version: 0, text: file.text }]))
      return galaxyWorkspaceSymbolsIn({ ...context, byUri }, { query, maxResults, workspaceIncomplete: partial || incomplete })
    },
    /** Prepare through this retained index under the same source authority as rename. */
    prepareRename(layerId, path, offset, request, byUri, editableDocumentUris, crossLinks) {
      const key = keyOf(layerId, path)
      const context = contextAt(layerId, path, offset, key)
      return context === undefined ? undefined : galaxyPrepareRenameIn({ ...context, byUri, editableDocumentUris, crossLinks },
        { ...request, workspaceIncomplete: request.workspaceIncomplete || incomplete })
    },
    /** Rename using this same retained Galaxy index; the caller provides mixed links and authority. */
    rename(layerId, path, offset, request, byUri, editableDocumentUris, crossLinks) {
      const key = keyOf(layerId, path)
      const context = contextAt(layerId, path, offset, key)
      if (context === undefined) return undefined
      return galaxyRenameIn({ ...context, byUri, editableDocumentUris, crossLinks },
        { ...request, workspaceIncomplete: request.workspaceIncomplete || incomplete })
    },
    /**
     * Bring the index to these files, in chain order (`{ layerId, path, text }`). `keep` is the
     * caller's layerId + NUL + path selection token, never left out by the bounds. Analysis
     * filenames use the canonical served URI so mixed links reuse the same parsed scripts.
     */
    update(documents, keep) {
      const wanted = new Map()
      let total = 0
      let dropped = false
      for (const document of documents) {
        const key = keyOf(document.layerId, document.path)
        if (`${document.layerId}\u0000${document.path}` !== keep) {
          if (document.text.length > MAX_DOCUMENT_CHARS || total + document.text.length > MAX_WORKSPACE_CHARS) {
            dropped = true
            continue
          }
          total += document.text.length
        }
        wanted.set(key, document)
      }
      for (const key of [...files.keys()]) {
        if (wanted.has(key)) continue
        files.delete(key)
        index.removeFile(key)
      }
      for (const [key, document] of wanted) {
        const held = files.get(key)
        if (held !== undefined && held.text === document.text) continue
        files.set(key, { layerId: document.layerId, path: document.path, text: document.text })
        index.updateFile(key, document.text)
      }
      incomplete = dropped
    },
    /** References at an offset of an indexed document, or undefined when it is not indexed. */
    references(layerId, path, offset, includeDeclaration) {
      const key = keyOf(layerId, path)
      const asked = files.get(key)
      if (asked === undefined) return undefined
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > asked.text.length) {
        throw new RangeError('galaxy.references offset is outside its document')
      }
      const documents = []
      const at = new Map()
      const references = galaxyIndexedReferences(index, key, offset, includeDeclaration).map(item => {
        const file = files.get(item.fileName)
        let slot = at.get(item.fileName)
        if (slot === undefined) {
          slot = documents.length
          at.set(item.fileName, slot)
          documents.push(Object.freeze({ layerId: file.layerId, path: file.path }))
        }
        return Object.freeze({
          document: slot,
          start: item.start,
          end: item.end,
          range: galaxyRangeAt(file, item.start, item.end),
        })
      })
      return Object.freeze({ incomplete, documents: Object.freeze(documents), references: Object.freeze(references) })
    },
    /** Hover at an offset of an indexed document, or undefined when it is not indexed. */
    hover(layerId, path, offset, uri) {
      const context = contextAt(layerId, path, offset, uri)
      if (context === undefined) return undefined
      const hover = galaxyHoverIn(context)
      return Object.freeze({ incomplete, ...(hover === undefined ? {} : { hover }) })
    },
    /**
     * Completion at an offset of an indexed document within `maxResults`, with `functionExpand` as the
     * editor asks; undefined when it is not indexed.
     */
    completion(layerId, path, offset, uri, options) {
      const context = contextAt(layerId, path, offset, uri)
      return context === undefined ? undefined : Object.freeze({ incomplete, completion: galaxyCompletionIn(context, options) })
    },
    /**
     * The diagnostics of an indexed document: `links` is the server's cross-language link index and
     * `linkUri` the document's name in it; `options` gives `maxResults` and whether the asking
     * workspace is incomplete. Undefined when the document is not indexed.
     */
    diagnostics(layerId, path, uri, links, linkUri, options) {
      const context = contextAt(layerId, path, 0, uri)
      if (context === undefined) return undefined
      const answer = galaxyDiagnosticsIn({ ...context, crossLinks: links, linkUri },
        { maxResults: options.maxResults, workspaceIncomplete: options.incomplete })
      return Object.freeze({ incomplete, diagnostics: answer })
    },
    /** Signature help at an offset of an indexed document, or undefined when it is not indexed. */
    signatureHelp(layerId, path, offset, uri) {
      const context = contextAt(layerId, path, offset, uri)
      if (context === undefined) return undefined
      const signatureHelp = galaxySignatureHelpIn(context)
      return Object.freeze({ incomplete, ...(signatureHelp === undefined ? {} : { signatureHelp }) })
    },
    /** Definition at an offset of an indexed document, files by layer and path; undefined when not indexed. */
    definition(layerId, path, offset, uri) {
      const context = contextAt(layerId, path, offset, uri)
      if (context === undefined) return undefined
      const targets = galaxyDefinitionIn(context)
      const documents = []
      const at = new Map()
      const definitions = []
      for (const item of targets.definitions) {
        const file = files.get(item.fileName)
        if (file === undefined) continue
        let slot = at.get(item.fileName)
        if (slot === undefined) {
          slot = documents.length
          at.set(item.fileName, slot)
          documents.push(Object.freeze({ layerId: file.layerId, path: file.path }))
        }
        definitions.push(Object.freeze({ document: slot, range: galaxyRangeAt(file, item.start, item.end) }))
      }
      return Object.freeze({
        incomplete,
        semantic: targets.semantic,
        documents: Object.freeze(documents),
        definitions: Object.freeze(definitions),
      })
    },
  }
}
