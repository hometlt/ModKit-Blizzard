/**
 * Language features of a map's catalog-linked documents: placed objects (`Objects`) and the preload
 * list (`Preload.xml`). What they reference — unit types, sounds, models, actors, the preloaded
 * catalog entries — comes from the map format's own tables through the shared cross-language link
 * index, so a catalog entity's usages and rename reach the map exactly like Data, Galaxy, TriggerData,
 * Layout and Strings.
 */
import { lineStartOffsets, positionAt } from '../../../../../shared/xml/text-position.js'

/** The shared cross-language link index; the runtime hands in the one instance every SC2 language uses. */
export interface Sc2WorkspaceLinks {
  readonly references: readonly LinkItem[]
  readonly isIncomplete: boolean
  diagnosticsFor(uri: string): readonly unknown[]
  hoverAt(uri: string, offset: number): object | undefined
  definitionAt(uri: string, offset: number): unknown
  referencesAt(uri: string, offset: number, includeDeclaration: boolean): readonly unknown[]
  renameAt(uri: string, offset: number, newName: unknown, maxEdits: unknown): unknown
}

interface LinkItem {
  readonly uri: string
  readonly start: number
  readonly end: number
  readonly entityId: string
}

interface MapDocumentRequest {
  readonly document: { readonly uri: string; readonly languageId: string; readonly version: number; readonly text: string }
  readonly position?: { readonly line: number; readonly character: number }
  readonly maxResults?: number
  readonly signal?: AbortSignal
  readonly [key: string]: unknown
}

export function createSc2MapDocumentLanguage(
  languageIds: readonly string[],
  linksOf: (request: MapDocumentRequest) => Sc2WorkspaceLinks,
) {
  /** The link index over this request's workspace snapshot, and the cursor offset. */
  const contextOf = (request: MapDocumentRequest, positioned = false) => {
    request.signal?.throwIfAborted()
    if (!languageIds.includes(request.document?.languageId)) {
      throw new TypeError(`the SC2 map document provider cannot inspect ${request.document?.languageId}`)
    }
    const starts = lineStartOffsets(request.document.text)
    let offset = 0
    if (positioned) {
      const position = request.position
      const lineStart = position === undefined ? undefined : starts[position.line]
      if (position === undefined || lineStart === undefined || position.character < 0) {
        throw new RangeError('position is outside the document')
      }
      offset = Math.min(lineStart + position.character, request.document.text.length)
    }
    const links = linksOf(request)
    const rangeOf = (start: number, end: number) => ({ start: positionAt(starts, start), end: positionAt(starts, end) })
    const referenceAt = () =>
      links.references.find(item => item.uri === request.document.uri && item.start <= offset && offset <= item.end)
    return { links, offset, rangeOf, referenceAt }
  }
  const diagnosticsOf = (request: MapDocumentRequest) => {
    const { links } = contextOf(request)
    const diagnostics = links.diagnosticsFor(request.document.uri)
    const limit = request.maxResults ?? diagnostics.length
    return {
      documentUri: request.document.uri,
      documentVersion: request.document.version,
      diagnostics: Object.freeze(diagnostics.slice(0, limit)),
      isIncomplete: diagnostics.length > limit || links.isIncomplete,
    }
  }
  return Object.freeze({
    async analyze(request: MapDocumentRequest) {
      const include = request['include'] as { readonly diagnostics?: boolean } | undefined
      const { documentUri, documentVersion, diagnostics } = diagnosticsOf(request)
      return Object.freeze({
        documentUri,
        documentVersion,
        tokens: Object.freeze([]),
        diagnostics: include?.diagnostics === false ? Object.freeze([]) : diagnostics,
        symbols: Object.freeze([]),
      })
    },
    async diagnostics(request: MapDocumentRequest) {
      return Object.freeze(diagnosticsOf(request))
    },
    async hover(request: MapDocumentRequest) {
      const { links, offset, rangeOf, referenceAt } = contextOf(request, true)
      const hover = links.hoverAt(request.document.uri, offset)
      const reference = referenceAt()
      return hover === undefined
        ? undefined
        : Object.freeze({ ...hover, ...(reference === undefined ? {} : { range: rangeOf(reference.start, reference.end) }) })
    },
    async definition(request: MapDocumentRequest) {
      const { links, offset } = contextOf(request, true)
      const definition = links.definitionAt(request.document.uri, offset)
      return Object.freeze({
        locations: Object.freeze(definition === undefined ? [] : [definition]),
        isIncomplete: links.isIncomplete,
      })
    },
    async references(request: MapDocumentRequest) {
      const { links, offset } = contextOf(request, true)
      const locations = links.referencesAt(request.document.uri, offset, request['includeDeclaration'] === true)
      const limit = request.maxResults ?? locations.length
      return Object.freeze({
        locations: Object.freeze(locations.slice(0, limit)),
        isIncomplete: locations.length > limit || links.isIncomplete,
      })
    },
    async prepareRename(request: MapDocumentRequest) {
      const { rangeOf, referenceAt } = contextOf(request, true)
      const reference = referenceAt()
      return reference === undefined
        ? undefined
        : Object.freeze({ range: rangeOf(reference.start, reference.end), placeholder: reference.entityId })
    },
    async rename(request: MapDocumentRequest) {
      const { links, offset } = contextOf(request, true)
      return links.renameAt(request.document.uri, offset, request['newName'], request['maxEdits'])
    },
  })
}
