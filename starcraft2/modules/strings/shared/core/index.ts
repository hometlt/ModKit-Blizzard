// SC2 localized strings: markup parsing, catalog-backed resolution, HTML rendering,
// and locale/string-file constants. Browser-safe core.

export {
  SC2_LOCALES, STRING_CATALOGS, canonicalLocale, localeInfo, canonicalStringFile, isStringCatalog, parseIndexSc2Locale,
} from './constants.js'
export type { SC2Locale } from './constants.js'

export { parseMarkup, serializeMarkup, markupCatalogRefs, parseBracketedDTag, validateMarkupSyntax, findColorSwatches, findSegmentAt } from './markup.js'
export type { MarkupSegment, MarkupRef, MarkupSyntaxIssue, ColorSwatch, MarkupSegmentAt } from './markup.js'

export { tokenizeStringValue, tokenizeStringKey } from './tokenize.js'
export type { StringToken, TokenScope, KeyToken, KeyTokenScope } from './tokenize.js'

export { completeStringValue, completeStringKey, isReferenceAttribute, findTagOrAttrDocAt } from './complete.js'
export type { StringCatalog, StringCompletion, StringCompletionKind, CompleteContext, CompleteResult, KeyCompleteContext, TagOrAttrDoc } from './complete.js'

export {
  resolveStringValue, resolveFieldPath, renderPlain, validateStringRefs,
} from './resolve.js'
export type { CatalogResolver, GalaxyVarInfo, GalaxyVarValue, TextStyleInfo, ResolvedSegment, ResolvedMarkup, StringRefIssue } from './resolve.js'

export { renderMarkupHtml } from './render-html.js'
export type { RenderHtmlOptions } from './render-html.js'

export { analyzeStringFile, compareLocales } from './analysis.js'
export type { StringDiagnostic, StringDiagnosticCode, LocaleComparison } from './analysis.js'

export { protectMarkup, restoreMarkup, translateText } from './translate.js'
export type { ProtectedText, TranslateOptions, TranslateProvider } from './translate.js'

export { changedStringsText, diffStringTexts, parseStringFileDiff } from './diff.js'
export type { StringChange } from './diff.js'

// Re-export the ordered string-file line-model from @modkitx/xml for convenience.
export { parseSc2StringsOrdered, serializeStringModel, effectiveValue, setStringValue, renameStringKey, addStringEntry } from './text-file.js'
export type { StringLine, StringFileModel } from './text-file.js'
