/**
 * Parser for `LocalizedData/Editor/EditorCategoryStrings.txt` — the localized display
 * names for editor categories and their values. Format is `key=value` per line:
 *
 *   EDSTR_CATEGORY_<Category>=Display Name
 *   EDSTR_CATEGORY_<Category>_<Value>=Display Name
 */

const PREFIX = 'EDSTR_CATEGORY_'

/** Parse the `key=value` strings file into a flat map. Lenient; ignores blanks/comments. */
export function parseEditorCategoryStrings(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return out
}

/** Localized display name for a category, e.g. 'ObjectType' → "Object Type". */
export function categoryDisplayName(strings: Map<string, string>, category: string): string | undefined {
  return strings.get(`${PREFIX}${category}`)
}

/** Localized display name for a category value, e.g. ('Climate','SpacePlatform') → "Space Platform". */
export function categoryValueDisplayName(
  strings: Map<string, string>,
  category: string,
  value: string,
): string | undefined {
  return strings.get(`${PREFIX}${category}_${value}`)
}
