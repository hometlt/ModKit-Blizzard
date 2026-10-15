/**
 * TextFormatFrame `FormatText` expansion. `FormatText` holds `%N%` placeholders
 * that reference the frame's indexed `<Replacement index="N">` values, e.g.
 * `%0%%3%%1%` (the tech-tree unit-tooltip pattern). `%%` is a literal `%`.
 */

const PLACEHOLDER = /%(\d+)%|%%/g

/**
 * Expand a FormatText string, substituting each `%N%` with `getReplacement(N)`.
 * Missing replacements expand to empty string.
 */
export function expandFormatText(format: string, getReplacement: (index: number) => string | undefined): string {
  return format.replace(PLACEHOLDER, (match, digits: string | undefined) => {
    if (digits === undefined) return '%' // %% escape
    return getReplacement(Number.parseInt(digits, 10)) ?? ''
  })
}
