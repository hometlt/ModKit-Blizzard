export interface Sc2LayoutPreviewDocument {
  readonly uri: string
  readonly text: string
  readonly languageId?: string
  readonly version?: number
}

export interface Sc2LayoutPreviewInput {
  readonly document: Sc2LayoutPreviewDocument
  readonly workspaceDocuments?: readonly Sc2LayoutPreviewDocument[]
  readonly templateKind?: 'sc2-layout' | 'sc2-tech-tree-v1'
  readonly rootPath?: string
  readonly viewport?: Readonly<{ width: number; height: number }>
  readonly states?: Readonly<Record<string, unknown>>
  readonly maxNodes?: number
  readonly maxDiagnostics?: number
  readonly hardBounds?: Readonly<{
    maxChars: number
    maxWorkspaceChars: number
    maxDocuments: number
    maxNodes: number
    maxDepth: number
    maxDiagnostics: number
  }>
}

export interface Sc2LayoutPreviewOptions {
  /** Resolves a frame's `Text` and `Style` into drawable runs; absent means text as written. */
  readonly resolveText?: (
    text: string | undefined,
    style: string | undefined,
  ) => Readonly<{ resolved?: string; runs: readonly object[] }>
}

export declare function previewSc2Layout(
  input: Sc2LayoutPreviewInput,
  signal?: AbortSignal,
  options?: Sc2LayoutPreviewOptions,
): Promise<Readonly<Record<string, unknown>>>

export declare function previewSc2TechTree(
  input: Sc2LayoutPreviewInput,
  signal?: AbortSignal,
  options?: Sc2LayoutPreviewOptions,
): Promise<Readonly<Record<string, unknown>>>
