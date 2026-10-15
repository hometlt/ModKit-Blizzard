/** Types of `served-references.js`: the Galaxy answers a loaded mod's server gives. */
export interface GalaxyServedDocument {
  readonly layerId: string
  readonly path: string
  readonly text: string
}

export interface GalaxyServedRange {
  readonly start: { readonly line: number; readonly character: number }
  readonly end: { readonly line: number; readonly character: number }
}

export interface GalaxyServedReferences {
  readonly incomplete: boolean
  readonly documents: readonly { readonly layerId: string; readonly path: string }[]
  readonly references: readonly {
    readonly document: number
    readonly start: number
    readonly end: number
    readonly range: GalaxyServedRange
  }[]
}

export interface GalaxyServedDefinitions {
  readonly incomplete: boolean
  /** The index answered (its completeness counts); false for an include, a scoped local. */
  readonly semantic: boolean
  readonly documents: readonly { readonly layerId: string; readonly path: string }[]
  readonly definitions: readonly { readonly document: number; readonly range: GalaxyServedRange }[]
}

export interface GalaxyServedReferenceIndex {
  workspaceSymbols(layerId: string, path: string, query: string, maxResults: number, incomplete: boolean): unknown
  prepareRename(layerId: string, path: string, offset: number, request: unknown, byUri: unknown,
    editableDocumentUris: unknown, crossLinks: unknown): unknown
  rename(layerId: string, path: string, offset: number, request: unknown, byUri: unknown,
    editableDocumentUris: unknown, crossLinks: unknown): unknown
  update(documents: Iterable<GalaxyServedDocument>, keep: string): void
  references(
    layerId: string,
    path: string,
    offset: number,
    includeDeclaration: boolean,
  ): GalaxyServedReferences | undefined
  /** Hover as the language provider returns it, under the editor's `uri` for the document. */
  hover(layerId: string, path: string, offset: number, uri: string): { readonly incomplete: boolean; readonly hover: unknown } | undefined
  /** A document's diagnostics as the language provider returns them, with the server's link index. */
  diagnostics(
    layerId: string,
    path: string,
    uri: string,
    links: unknown,
    linkUri: string,
    options: { readonly maxResults: number; readonly incomplete: boolean },
  ): { readonly incomplete: boolean; readonly diagnostics: { readonly diagnostics: readonly unknown[]; readonly isIncomplete: boolean } } | undefined
  /** Completion as the language provider returns it, within `maxResults`. */
  completion(
    layerId: string,
    path: string,
    offset: number,
    uri: string,
    options: { readonly maxResults: number; readonly functionExpand?: string },
  ): { readonly incomplete: boolean; readonly completion: { readonly items: readonly unknown[]; readonly isIncomplete: boolean } } | undefined
  /** Signature help as the language provider returns it. */
  signatureHelp(
    layerId: string,
    path: string,
    offset: number,
    uri: string,
  ): { readonly incomplete: boolean; readonly signatureHelp: unknown } | undefined
  definition(layerId: string, path: string, offset: number, uri: string): GalaxyServedDefinitions | undefined
}

export function createGalaxyServedReferences(): GalaxyServedReferenceIndex
