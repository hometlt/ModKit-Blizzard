/** The client projects layer/path plans to Host-owned URIs and document versions. */
import type { LanguagePositionRequest, LanguageRenamePreparation, LanguageWorkspaceEdit } from '@modkit/sdk'
export function servedRenameFeature(request: LanguagePositionRequest,
  port: { query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown> },
  feature: 'prepareRename'): Promise<LanguageRenamePreparation | undefined>
export function servedRenameFeature(request: LanguagePositionRequest,
  port: { query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown> },
  feature: 'rename'): Promise<LanguageWorkspaceEdit | undefined>
