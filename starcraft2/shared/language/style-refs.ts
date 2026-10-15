/**
 * What counts as a reference from a localization string to a style sheet.
 *
 * Both ends of that relation ask this question and they must not answer it differently. The
 * localization codec asks it to draw edges from a key to the styles it applies; the style sheet's
 * language service asks it to answer "which strings use this style?" from the workspace snapshot.
 * When the two definitions drifted, a style would show users that its own graph did not list.
 *
 * It lives beside the other cross-format support rather than in either codec because neither owns
 * it: it is a fact about how the two formats meet.
 */
import { parseMarkup } from '../../modules/strings/shared/core/index.js'

/** `RRGGBB` or `RRGGBBAA`, the literal form a `<c val>` may carry instead of a constant name. */
const HEX_COLOR = /^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u
/** `R,G,B` or `R,G,B,A`, the other literal form. */
const DECIMAL_COLOR = /^\d{1,3}(?:\s*,\s*\d{1,3}){2,3}$/u

export interface StyleReference {
  /** `style` for `<s val>`, `color` for `<c val>` — they resolve against different declarations. */
  readonly kind: 'style' | 'color'
  readonly name: string
}

/**
 * The style and colour names one value applies, in document order.
 *
 * `parseMarkup` already walks the nesting, so this is a projection of what the ported parser found
 * rather than a second scan of the same text.
 */
export function styleRefsOf(value: string): readonly StyleReference[] {
  const found: StyleReference[] = []
  const walk = (segments: readonly unknown[]): void => {
    for (const segment of segments as readonly Record<string, unknown>[]) {
      if (segment['kind'] === 'style' && typeof segment['style'] === 'string') {
        found.push({ kind: 'style', name: segment['style'] })
      }
      /*
       * A colour is a reference only when it is not a literal, and telling them apart needs the
       * literal forms rather than "looks like an identifier": `ffcc00` is six hex digits and also a
       * perfectly good identifier. Reporting it as a link to a declaration that does not exist
       * would fill the graph with dead ends, which a reader then learns to ignore.
       */
      if (segment['kind'] === 'color' && typeof segment['color'] === 'string') {
        const name = segment['color'].replace(/^#/u, '')
        const literal = HEX_COLOR.test(name) || DECIMAL_COLOR.test(name)
        if (!literal && /^[A-Za-z_][\w-]*$/u.test(name)) found.push({ kind: 'color', name })
      }
      const children = segment['children']
      if (Array.isArray(children)) walk(children)
    }
  }
  try {
    walk(parseMarkup(value) as readonly unknown[])
  } catch {
    // A value whose markup does not parse names no styles; the diagnostics report the syntax.
  }
  return found
}

/** Every style and colour name used anywhere in a whole `.txt` catalog, for a workspace index. */
export function styleRefsInCatalog(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator <= 0 || line.startsWith('//')) continue
    for (const reference of styleRefsOf(line.slice(separator + 1))) names.push(reference.name)
  }
  return names
}
