/**
 * A raw catalog entry as parsed from XML — before schema interpretation.
 * Mirrors the XML structure but in plain JS objects.
 */
export interface RawCatalogEntry {
  /** Class name, e.g. 'CUnit', 'CAbil' */
  readonly type: string
  /** id attribute from XML, e.g. 'Marine' */
  readonly id: string
  /** parent attribute if present */
  readonly parent?: string
  /** default attribute if present ('1' = is a default/template) */
  readonly default?: string
  /** All other attributes and child elements */
  readonly fields: RawFields
  /**
   * Token declarations from `<?token id="..." type="..." value="..."?>` PIs inside
   * the element. SC2 actor/sound templating: the entity references `##id##`/`$id`,
   * children supply the value via a like-named attribute. Absent when none declared.
   */
  readonly tokens?: ReadonlyArray<TokenDecl>
  /** Source information (only populated in debug mode) */
  readonly source?: EntrySource
}

/**
 * A catalog XML element as written, in document order: what the lenient raw entry model and the
 * Data provider's schema-typed analysis both read.
 */
export interface CatalogXmlElement {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: readonly CatalogXmlElement[]
  /** Direct text, trimmed; '' when none. */
  readonly text: string
  /** `<?token?>` declarations directly inside; absent when the element has none. */
  readonly tokens?: readonly TokenDecl[]
}

/** A `<?token id type value?>` declaration. */
export interface TokenDecl {
  readonly id: string
  readonly type?: string
  readonly value?: string
}

/** Recursive field structure: scalar, object, or array */
export type RawValue =
  | string
  | RawObject
  | RawArray

export type RawObject = { readonly [key: string]: RawValue }
export type RawArray = readonly RawValue[]

export type RawFields = { readonly [field: string]: RawValue }

/** Position in source file, populated when parseOptions.trackSource = true */
export interface EntrySource {
  readonly file: string
  readonly line: number
  /** The declaration's opening tag: UTF-16 offset and length, 0-based column on `line`. */
  readonly span?: EntrySpan
}

export interface EntrySpan {
  readonly offset: number
  readonly length: number
  readonly column: number
}

/**
 * Result of parsing a complete SC2 catalog XML file.
 */
export interface ParsedCatalogFile {
  /** Namespace key of the root element, e.g. 'CUnit', 'CAbilResearch' */
  readonly rootTypes: readonly string[]
  /** Entries grouped by type */
  readonly entries: Map<string, RawCatalogEntry[]>
}

export interface Sc2XmlParseOptions {
  /** File path — used only for source tracking, not for IO */
  filePath?: string
  trackSource?: boolean
  /** Additional tag names that should always parse as arrays */
  arrayTags?: Set<string>
}
