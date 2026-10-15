/**
 * The SC2Layout definitions, hovers, completions and diagnostics a loaded mod's server gives (owner: [SC2] Mod & Data, Layout
 * language; served by the SC2 mod server, `modules/mod/shared/workspace/mod-contexts.ts`).
 *
 * One retained layout workspace and schema store over every `.SC2Layout` of a mod chain, with the
 * chain's style sheets — the same `createLayoutWorkspace`, `layoutStore`, `layoutDeclaredLocation`,
 * `layoutHoverIn` and `layoutCompletionItems` the language provider runs over a workspace snapshot — so a request carries
 * only its live document instead of the chain's layouts and sheets. Layouts are named by the
 * server's own `layerId` and path; include paths resolve against the path, as against a snapshot URI. The snapshot bounds apply: a layout over
 * `maxChars`, or layouts past `maxWorkspaceChars` or `maxDocuments` in all (in chain order, the
 * asked document always kept), are left out and the answer is incomplete. Sheets merge in chain
 * order, the last declaration winning, as the game merges them. Held string tables provide @ key
 * completion, value hover and image aliases. Catalog links still use the mixed link owner; a style
 * name's definition uses `style.definition`.
 */
import { createLayoutWorkspace, defaultLayoutBounds } from '../../shared/semantic.js'
import { layoutStore } from '../../../../dist/modules/layout/shared/schema-index.js'
export { entityCommands } from './runtime.js'
import {
  layoutCompletionItems,
  layoutDeclaredLocation,
  layoutDiagnosticsIn,
  layoutHoverIn,
  layoutPositionedContext,
  layoutRenameIn,
  layoutPrepareRenameIn,
  layoutReferencesIn,
  layoutWorkspaceSymbolsIn,
} from './runtime.js'

/** A URI-shaped name for a served layout that keeps its path, which include resolution compares. */
const servedUri = (layerId, path) => `modkit-served-layout://${encodeURIComponent(layerId)}/${path}`

/** A retained layout workspace over one chain's layouts, rebuilt per server revision. */
export function createLayoutServedDefinitions() {
  /** uri -> { layerId, path } of the layouts in the workspace. */
  let places = new Map()
  let held
  let incomplete = false
  /** The chain's style sheets, as documents `layoutHoverIn` reads. */
  let sheets = []
  /** The positioned context at an offset of a served layout; undefined when the layout is not held. */
  const contextAt = (layerId, path, offset) => {
    const uri = servedUri(layerId, path)
    const layout = held?.workspace.byUri.get(uri)
    if (layout === undefined) return undefined
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > layout.parsed.document.text.length)
      throw new RangeError('SC2Layout served offset is outside its document')
    return layoutPositionedContext(held.workspace, held.store, uri, offset)
  }
  return {
    /** Enumerate declarations already held in the canonical layout topology. */
    workspaceSymbols(layerId, path, query, maxResults, partial) {
      const context = contextAt(layerId, path, 0)
      return context === undefined ? { symbols: [], isIncomplete: true }
        : layoutWorkspaceSymbolsIn(context, { query, maxResults, workspaceIncomplete: partial || incomplete })
    },
    /** References use the same structural owner, with catalog calls translated to its held mixed index. */
    references(layerId, path, offset, links, linkUri, request) {
      const context = contextAt(layerId, path, offset)
      if (context === undefined) return undefined
      const crossLinks = { ...links, referencesAt: (_uri, at, declaration) => links.referencesAt(linkUri, at, declaration) }
      return layoutReferencesIn({ ...context, crossLinks }, { ...request, workspaceIncomplete: request.workspaceIncomplete || incomplete })
    },
    /** Prepare a structural name through the already-held topology. */
    prepareRename(layerId, path, offset) {
      const context = contextAt(layerId, path, offset)
      return context === undefined ? undefined : layoutPrepareRenameIn(context)
    },
    /** Structural rename through the already-held layout topology. */
    rename(layerId, path, offset, request) {
      const context = contextAt(layerId, path, offset)
      return context === undefined ? undefined : layoutRenameIn(context,
        { ...request, workspaceIncomplete: request.workspaceIncomplete || incomplete })
    },
    /**
     * Bring the workspace to these layouts and sheets (`.SC2Style`), in chain order; `keep` names
     * the asked layout (`layerId`, `path`).
     */
    async update(documents, keep, signal) {
      const bounds = defaultLayoutBounds
      const kept = []
      const wanted = new Map()
      let total = 0
      let dropped = false
      const styleSheets = []
      for (const document of documents) {
        if (/\.txt$/iu.test(document.path)) {
          styleSheets.push(Object.freeze({ uri: servedUri(document.layerId, document.path), languageId: 'sc2-strings', text: document.text }))
          continue
        }
        if (/\.sc2style$/iu.test(document.path)) {
          styleSheets.push(Object.freeze({ uri: servedUri(document.layerId, document.path), languageId: 'sc2-style', text: document.text }))
          continue
        }
        const asked = document.layerId === keep.layerId && document.path === keep.path
        const fits = document.text.length <= bounds.maxChars &&
          total + document.text.length <= bounds.maxWorkspaceChars && kept.length < bounds.maxDocuments - 1
        if (!asked && !fits) {
          dropped = true
          continue
        }
        const uri = servedUri(document.layerId, document.path)
        if (wanted.has(uri)) continue
        total += document.text.length
        wanted.set(uri, { layerId: document.layerId, path: document.path })
        kept.push(Object.freeze({ uri, languageId: 'sc2-layout', version: 0, text: document.text }))
      }
      const workspace = await createLayoutWorkspace(kept, bounds, signal)
      held = { workspace, store: layoutStore(kept.map(item => ({ uri: item.uri, text: item.text }))) }
      places = wanted
      sheets = styleSheets
      incomplete = dropped
    },
    /** The definition at an offset of a served layout; undefined when the layout is not held. */
    definition(layerId, path, offset) {
      const context = contextAt(layerId, path, offset)
      if (context === undefined) return undefined
      const location = layoutDeclaredLocation(context)
      const place = location === undefined ? undefined : places.get(location.uri)
      return Object.freeze({
        incomplete,
        documents: Object.freeze(place === undefined ? [] : [Object.freeze({ ...place })]),
        definitions: Object.freeze(place === undefined ? [] : [Object.freeze({ document: 0, range: location.range })]),
      })
    },
    /** The hover at an offset of a served layout, as the provider returns it; undefined when not held. */
    hover(layerId, path, offset) {
      const context = contextAt(layerId, path, offset)
      if (context === undefined) return undefined
      return Object.freeze({ incomplete, hover: layoutHoverIn(context, sheets) })
    },
    /**
     * A served layout's diagnostics with the server's cross-language link index (`links`, the layout
     * named `linkUri` in it); `options` gives `maxResults` and whether the asking workspace is
     * incomplete. Undefined when the layout is not held.
     */
    diagnostics(layerId, path, links, linkUri, options) {
      const context = contextAt(layerId, path, 0)
      if (context === undefined) return undefined
      const answer = layoutDiagnosticsIn({ ...context, crossLinks: links, linkUri },
        { maxResults: options.maxResults, workspaceIncomplete: options.incomplete })
      return Object.freeze({ incomplete, diagnostics: answer })
    },
    /** The first `maxResults` completion items at an offset of a served layout; undefined when not held. */
    completion(layerId, path, offset, maxResults) {
      const context = contextAt(layerId, path, offset)
      if (context === undefined) return undefined
      const items = layoutCompletionItems(context, { document: context.layout.parsed.document, workspaceDocuments: sheets })
      return Object.freeze({ incomplete, capped: items.length > maxResults, items: Object.freeze(items.slice(0, maxResults)) })
    },
  }
}
