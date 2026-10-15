import type {
  LanguageCodeActionList,
  LanguageCodeActionsRequest,
  LanguageFormattingRequest,
  LanguageTextEditList,
} from '@modkit/sdk/language'

export declare function finalNewlineFormatting(
  request: LanguageFormattingRequest,
): Promise<LanguageTextEditList>

export declare function finalNewlineCodeActions(
  request: LanguageCodeActionsRequest,
): Promise<LanguageCodeActionList>
