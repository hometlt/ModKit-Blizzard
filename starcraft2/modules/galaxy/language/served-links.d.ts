/** Types of `served-links.js`: the cross-language link index a loaded mod's server holds. */
export interface ServedLinkDocument {
  readonly layerId: string
  readonly path: string
  readonly languageId: string
  readonly text: string
}

/** A declaration or literal reference the index holds. */
export interface ServedLinkItem {
  readonly uri: string
  readonly start: number
  readonly end: number
  readonly namespace: string
  readonly entityId: string
}

/** The link index (`sc2-workspace-links.js`); its methods are read by the served language answers. */
export interface ServedLinkIndex {
  hoverAt(uri: string, offset: number): { readonly markdown: string; readonly provenance: string } | undefined
  targetAt(uri: string, offset: number): { readonly namespace: string; readonly entityId: string } | undefined
  definitionAt(uri: string, offset: number): ServedLinkLocation | undefined
  readonly isIncomplete: boolean
  /** A declaration may be missing (link bound, unparsed catalog, incomplete workspace). */
  readonly diagnosticsIncomplete: boolean
  readonly declarations: readonly ServedLinkItem[]
  readonly references: readonly ServedLinkItem[]
  diagnosticsFor(uri: string): readonly unknown[]
  referencesTo(namespace: string, entityId: string, includeDeclaration?: boolean): readonly {
    readonly uri: string
    readonly range: { readonly start: { line: number; character: number }; readonly end: { line: number; character: number } }
  }[]
}

export interface ServedLinkLocation {
  readonly uri: string
  readonly range: { readonly start: { line: number; character: number }; readonly end: { line: number; character: number } }
}

export const SERVED_LINK_LANGUAGE_IDS: readonly string[]
export function servedLinkUri(layerId: string, path: string): string
export function createServedLinkIndex(documents: readonly ServedLinkDocument[], incomplete: boolean): ServedLinkIndex
