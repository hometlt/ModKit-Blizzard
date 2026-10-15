/** Types of `served-definitions.js`: the SC2Layout definitions, hovers and completions a loaded mod's server gives. */
export function entityCommands(target: { readonly namespace: string; readonly entityId: string }): readonly unknown[]
/** A layout or style sheet (`.SC2Style`) of the chain. */
export interface LayoutServedDocument {
  readonly layerId: string
  readonly path: string
  readonly text: string
}

export interface LayoutServedDefinitions {
  readonly incomplete: boolean
  readonly documents: readonly { readonly layerId: string; readonly path: string }[]
  readonly definitions: readonly {
    readonly document: number
    readonly range: {
      readonly start: { readonly line: number; readonly character: number }
      readonly end: { readonly line: number; readonly character: number }
    }
  }[]
}

export interface LayoutServedDefinitionIndex {
  workspaceSymbols(layerId: string, path: string, query: string, maxResults: number, incomplete: boolean): unknown
  references(layerId: string, path: string, offset: number, links: unknown, linkUri: string, request: unknown):
    { readonly locations: readonly { readonly uri: string; readonly range: unknown }[]; readonly isIncomplete: boolean } | undefined
  prepareRename(layerId: string, path: string, offset: number): unknown
  rename(layerId: string, path: string, offset: number, request: unknown): unknown
  update(
    documents: Iterable<LayoutServedDocument>,
    keep: { readonly layerId: string; readonly path: string },
    signal?: AbortSignal,
  ): Promise<void>
  definition(layerId: string, path: string, offset: number): LayoutServedDefinitions | undefined
  /** The hover as the language provider returns it (undefined inside: no hover there). */
  hover(layerId: string, path: string, offset: number): { readonly incomplete: boolean; readonly hover: unknown } | undefined
  /** A layout's diagnostics as the language provider returns them, with the server's link index. */
  diagnostics(
    layerId: string,
    path: string,
    links: unknown,
    linkUri: string,
    options: { readonly maxResults: number; readonly incomplete: boolean },
  ): { readonly incomplete: boolean; readonly diagnostics: { readonly diagnostics: readonly unknown[]; readonly isIncomplete: boolean } } | undefined
  /** The first `maxResults` completion items, as the language provider returns them. */
  completion(
    layerId: string,
    path: string,
    offset: number,
    maxResults: number,
  ): { readonly incomplete: boolean; readonly capped: boolean; readonly items: readonly unknown[] } | undefined
}

export function createLayoutServedDefinitions(): LayoutServedDefinitionIndex
