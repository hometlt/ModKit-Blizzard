import type { LanguageColor } from '@modkit/sdk/language'

export declare function parseColorLiteral(
  value: string,
): { readonly color: LanguageColor; readonly decimal: boolean; readonly includesAlpha: boolean } | undefined

export declare function decimalColor(color: LanguageColor, includeAlpha: boolean): string

export declare function hexColor(color: LanguageColor, includeAlpha: boolean): string
