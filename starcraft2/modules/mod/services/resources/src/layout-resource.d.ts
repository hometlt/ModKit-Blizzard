/** Narrow ABI projection; the Layout runtime remains the sole owner of resolution and models. */
export interface LayoutResourceFrame {
  readonly properties: ReadonlyMap<string, {
    readonly tag: string
    readonly val?: string
    readonly attrs: Readonly<Record<string, string>>
    readonly source: { readonly uri: string }
  }>
}

export function createSc2LayoutResourceResolver(
  documents: readonly { readonly uri: string; readonly text: string; readonly version?: number }[],
): {
  frame(entryUri: string, rootPath: string, descendantPath?: readonly string[]): LayoutResourceFrame
  value(raw: string): string | undefined
}
