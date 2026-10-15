/** Typed boundary of canonical language owners over retained inputs; bounded results, paths and plans only. */
import type { LanguageWorkspaceSemanticInput } from '@modkit/sdk'
export interface ServedLanguageOwner {
  needsContentPaths(question: ServedFeatureQuestion, signal?: AbortSignal): Promise<boolean>
  contentPaths(inputs: readonly LanguageWorkspaceSemanticInput[], layers: readonly { readonly id: string; readonly sourceId: string; readonly sourcePath: string }[],
    paths: readonly string[], owners: readonly number[], incomplete: boolean): void
  feature(question: ServedFeatureQuestion, signal?: AbortSignal, links?: unknown): Promise<unknown>
  project(value: unknown): { readonly hasValue: boolean; readonly documents: readonly { readonly layerId: string; readonly path: string }[]; readonly value?: unknown }
  dataDiagnostics(question: ServedRenameQuestion, signal?: AbortSignal): Promise<{ readonly diagnostics: readonly unknown[]; readonly isIncomplete: boolean }>
  prepare(question: ServedRenameQuestion, links: unknown,
    galaxyPrepare: (question: ServedRenameQuestion, request: unknown, byUri: unknown, editable: unknown, links: unknown) => Promise<unknown>,
    layoutPrepare: (question: ServedRenameQuestion, request: unknown) => Promise<unknown>, signal?: AbortSignal): Promise<unknown>
  update(documents: readonly { readonly layerId: string; readonly path: string; readonly languageId: string; readonly text: string }[],
    layers: readonly { readonly id: string; readonly sourceId: string }[], revision: string): void
  rename(question: ServedRenameQuestion, links: unknown,
    galaxyRename: (question: ServedRenameQuestion, request: unknown, byUri: unknown, editable: unknown, links: unknown) => Promise<unknown>,
    layoutRename: (question: ServedRenameQuestion, request: unknown) => Promise<unknown>, signal?: AbortSignal): Promise<unknown>
}
export interface ServedFeatureQuestion {
  readonly semanticInputs?: readonly LanguageWorkspaceSemanticInput[]
  readonly document: { readonly layerId: string; readonly path: string }
  readonly feature: string
  readonly maxResults: number
  readonly maxDocuments: number
  readonly incomplete: boolean
  readonly parameters: Readonly<Record<string, unknown>>
}
export interface ServedRenameQuestion {
  readonly document: { readonly layerId: string; readonly path: string }
  readonly position: { readonly line: number; readonly character: number }
  readonly newName: string
  readonly maxEdits: number
  readonly maxResults: number
  readonly maxDocuments: number
  readonly incomplete: boolean
}
export function createServedLanguageOwner(dataQuestion: (question: unknown, signal?: AbortSignal) => Promise<unknown>): ServedLanguageOwner
