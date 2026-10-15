/**
 * Raw-preserving catalog/string reference rename for `.SC2Layout` values.
 *
 * Only `val="..."` attributes with `@`, `@@`, or `*@` reference syntax are considered.
 * Frame names, templates, files, anchors, and unrelated scalar values remain untouched.
 */

export interface Sc2LayoutRenameResult {
  readonly xml: string
  readonly patched: number
}

export interface Sc2LayoutRenameOptions {
  /** Maps `(namespace, oldId)` to a replacement id. */
  readonly mapped: (namespace: string, id: string) => string | undefined
  /** Resolves a raw namespace to its canonical catalog spelling. */
  readonly canon: (namespace: string) => string | undefined
  /** Full localized string key replacements produced by the catalog rename. */
  readonly textKeyRenames?: ReadonlyMap<string, string>
}

export function isSc2LayoutFilePath(path: string): boolean {
  return /\.sc2layout$/i.test(path)
}

const VALUE_ATTRIBUTE = /val="([^"]*)"/g

export function renameSc2LayoutReferences(
  xml: string,
  options: Sc2LayoutRenameOptions,
): Sc2LayoutRenameResult {
  let patched = 0
  const output = xml.replace(VALUE_ATTRIBUTE, (attribute, value: string) => {
    const replacement = rewriteReferenceValue(value, options)
    if (replacement === undefined) return attribute
    patched += 1
    return `val="${replacement}"`
  })
  return { xml: output, patched }
}

function rewriteReferenceValue(value: string, options: Sc2LayoutRenameOptions): string | undefined {
  const literalPrefix = value.startsWith('*') ? '*' : ''
  const afterLiteral = literalPrefix ? value.slice(1) : value
  if (!afterLiteral.startsWith('@')) return undefined
  const referencePrefix = afterLiteral.startsWith('@@') ? '@@' : '@'
  const key = afterLiteral.slice(referencePrefix.length)
  if (!key) return undefined

  const renamedKey = options.textKeyRenames?.get(key)
  if (renamedKey !== undefined && renamedKey !== key) {
    return `${literalPrefix}${referencePrefix}${renamedKey}`
  }

  const segments = key.split('/')
  if (segments.length < 2) return undefined
  const namespace = options.canon(segments[0] ?? '')
  const oldId = segments.at(-1) ?? ''
  if (!namespace || !oldId) return undefined
  const newId = options.mapped(namespace, oldId)
  if (newId === undefined || newId === oldId) return undefined
  segments[segments.length - 1] = newId
  return `${literalPrefix}${referencePrefix}${segments.join('/')}`
}
