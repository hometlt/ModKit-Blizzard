/** Transport only; the existing SDK validators and per-language owners define all feature semantics. */
import type { LanguageFeatureRequest, LanguageProvider, LanguageCompletionList, LanguageModContextFeature, LanguageDocumentLocalFeature } from '@modkit/sdk'
export function withServedLanguageFeatures(provider: LanguageProvider,
  port: { query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown> } | undefined,
  features: readonly LanguageModContextFeature[], documentLocalFeatures?: readonly LanguageDocumentLocalFeature[]): LanguageProvider
/** SC2's canonical owners currently return ordinary completion items, rather than SDK subject placeholders. */
export function servedLanguageFeature(request: LanguageFeatureRequest,
  port: { query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown> },
  feature: 'completion'): Promise<LanguageCompletionList>
export function servedLanguageFeature<Feature extends keyof LanguageProvider>(request: LanguageFeatureRequest,
  port: { query(scope: string, question: unknown, signal?: AbortSignal): Promise<unknown> },
  feature: Feature): Promise<Awaited<ReturnType<Extract<NonNullable<LanguageProvider[Feature]>, (...args: never[]) => unknown>>>>
