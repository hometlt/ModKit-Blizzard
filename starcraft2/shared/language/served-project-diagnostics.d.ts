/** Only layer/path identities, bounded diagnostics and revisions cross the query port. */
import type { LanguageFeatureRequest, LanguageProjectDiagnosticList } from '@modkit/sdk'
export function servedProjectDiagnostics(request: LanguageFeatureRequest,
  port: { query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown> }): Promise<LanguageProjectDiagnosticList>
