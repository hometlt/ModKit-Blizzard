/**
 * Public field introspection over the structure-types schema (`DATA_CLASS_SCHEMA`).
 *
 * `@modkitx/data-processing/sc2-catalog` already owns the structure-types model — `resolveEntityTyped`
 * walks it to merge inheritance. This module exposes the same understanding as a
 * small, stable API so consumers (validation, completion, hover) classify fields
 * through the catalog layer instead of reaching into `@modkitx/data-processing/sc2-schema` internals
 * and re-deriving the rules.
 *
 * A class's fields come from `DATA_CLASS_SCHEMA[className].getMergedSchema()` (own +
 * inherited). Each raw field-type entry is one of: a structure-type *constructor*
 * (`CEnum` with `.enum` members, `CLink` with a `.link` target namespace, a number/
 * string/bool scalar, a nested struct class), an `[Inner]` array literal, or a
 * `{ index, value }` record spec. `classifyField` normalises that into a `FieldInfo`.
 */

import {
  DATA_CLASS_SCHEMA,
  CEnum,
  CLink,
  CFile,
  CFlags,
  CRecord,
  CTuple,
  CStringArray,
  CSArray,
  CWArray,
  CCArray,
  CSObject,
  CNumber,
  CBoolean,
  CCatalogReference,
  CGameContentCreationData,
  CDataEntryPath,
  TEditorCategories,
  typeToNamespace,
  NAMESPACE_CLASS_MAP,
} from '../sc2-schema/index.js'
import type { CatalogEntity } from './types.js'

type AnyClass = { new (...args: unknown[]): unknown } & Record<string, unknown>

/** A class's field map: field name → raw structure-type entry. */
export type SchemaFieldMap = Record<string, unknown>

export type FieldKind =
  | 'link'
  | 'catalogRef'
  | 'enum'
  | 'flags'
  | 'struct'
  | 'array'
  | 'record'
  | 'editorCategories'
  | 'file'
  | 'number'
  | 'bool'
  | 'instructions'
  | 'scalar'

export interface FieldInfo {
  kind: FieldKind
  /** Structure-type class name (e.g. 'Real32', 'CWeaponLink', 'EAbilAlignment'), when a class. */
  typeName?: string
  /** Target namespace for `link` kind (e.g. 'Unit'); 'String' for text keys. */
  linkNamespace?: string
  /** Link to a localized-text key (no entity to resolve). */
  isTextLink?: boolean
  /** Link to an asset file path (no entity to resolve). */
  isFileLink?: boolean
  /** Members for `enum`/`flags` kinds. */
  enumMembers?: readonly string[]
  /** Sentinel an enum treats as "unknown" (default "Unknown"). */
  enumUnknown?: string
  /** Nested struct field map for `struct` kind. */
  nested?: SchemaFieldMap
  /** Inner item type for `array`/`record` kinds (pass back to `classifyField`). */
  itemType?: unknown
  /** Key/index type for schema records. Positional arrays leave this undefined. */
  indexType?: unknown
  /** Minimum for `number` kind (e.g. 0 for UInt), when the type declares one. */
  numberMin?: number
  /** Maximum for `number` kind (e.g. the C-type storage limit), when declared. */
  numberMax?: number
  /** Whether a `number` field accepts fractions (false ⇒ integers only). */
  numberFloat?: boolean
  /** For `instructions` kind: keyword → positional arg FieldInfos (the keyword excluded). */
  instructions?: ReadonlyMap<string, FieldInfo[]>
  /** Delimiter separating the leading keyword from its arguments (`' '` or `'.'`). */
  instructionDelimiter?: string
  /**
   * When set, the value is a LIST of instructions joined by this delimiter (e.g. a
   * `CActorTerms = CSArray<CActorTerm>` field is `;`-separated), each segment parsed per
   * `instructions`/`instructionDelimiter`. Absent ⇒ the value is a single instruction.
   */
  instructionListDelimiter?: string
  /**
   * For `instructions` kind: when the first token names no known keyword, some classes
   * treat the whole value as a plain link (e.g. `CActorKey → CActorLink`,
   * `CDataSoupKey → CEffectLink`). This is that fallback's FieldInfo, when the class
   * declares one; absent ⇒ an unknown keyword is opaque (never flagged).
   */
  instructionFallback?: FieldInfo
}

function isClass(v: unknown): v is AnyClass {
  return typeof v === 'function'
}

function protoInstanceOf(t: unknown, base: abstract new (...args: any[]) => any): boolean {
  return isClass(t) && (t === base || t.prototype instanceof base)
}

function isArrayType(t: unknown): t is [unknown] {
  return Array.isArray(t) && t.length === 1
}

function isRecordSpec(t: unknown): t is { index: unknown; value: unknown } {
  return (
    t !== null &&
    typeof t === 'object' &&
    !Array.isArray(t) &&
    'index' in (t as object) &&
    'value' in (t as object)
  )
}

/** Merged (own + inherited) field map for a struct/object class, if non-empty. */
function mergedSchema(t: unknown): SchemaFieldMap | undefined {
  if (!isClass(t)) return undefined
  const fn = (t as { getMergedSchema?: () => SchemaFieldMap }).getMergedSchema
  const merged = typeof fn === 'function' ? fn.call(t) : (t as { schema?: SchemaFieldMap }).schema
  if (merged && typeof merged === 'object' && Object.keys(merged).length > 0) return merged
  return undefined
}

/** The merged field map for a catalog class (e.g. 'CUnit'), or undefined if unknown. */
export function getClassFields(className: string): SchemaFieldMap | undefined {
  return mergedSchema((DATA_CLASS_SCHEMA as Record<string, unknown>)[className])
}

/** Whether the structure-types schema knows this class. */
export function hasCatalogClass(className: string): boolean {
  return isClass((DATA_CLASS_SCHEMA as Record<string, unknown>)[className])
}

/** Catalog namespace for a C-prefixed class, e.g. 'CAbilEffectTarget' → 'Abil'. */
export function namespaceOfClass(className: string): string | undefined {
  return typeToNamespace(className)
}

/** Data space targeted by a `<const>` declaration, using the same rule as the wiki export. */
export function catalogConstantNamespace(entity: CatalogEntity): string | undefined {
  const data = entity.data as Record<string, unknown>
  const path = data['path']
  if (typeof path === 'string') {
    const namespace = typeToNamespace(path.split('.')[0] ?? '')
    if (namespace !== undefined) return namespace
  }
  const type = data['type']
  return typeof type === 'string' ? typeToNamespace(type) : undefined
}

/** The catalog entity classes valid at the root of a namespace's data file (e.g.
 *  'Unit' → ['CUnit'], 'Actor' → ['CActor','CActorUnit',…]). Empty for unknown ns. */
export function catalogClassesForNamespace(namespace: string): string[] {
  return (NAMESPACE_CLASS_MAP as Record<string, string[]>)[namespace] ?? []
}

/** Namespace selected by a standard catalog file name (`UnitData.xml` → `Unit`). */
export function catalogNamespaceForFileName(fileName: string): string | undefined {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)
  const wanted = /^(.+)Data\.xml$/iu.exec(base)?.[1]
  if (wanted === undefined) return undefined
  return Object.keys(NAMESPACE_CLASS_MAP).find(
    namespace => namespace.toLowerCase() === wanted.toLowerCase(),
  )
}

/** Every catalog entity class, for intentionally untyped/custom `<Catalog>` documents. */
export function catalogClasses(): string[] {
  return [...new Set(Object.values(NAMESPACE_CLASS_MAP).flat())].sort()
}

/**
 * Structure types reachable from a namespace's catalog classes. SC2 permits these as root-level
 * defaults in typed data files; deriving them here keeps completion on the canonical schema.
 */
export function catalogStructureDefaultsForNamespace(namespace: string): string[] {
  const found = new Set<string>()
  const seen = new Set<unknown>()
  const visit = (type: unknown): void => {
    if (seen.has(type)) return
    seen.add(type)
    const info = classifyField(type)
    if (info.kind === 'array' || info.kind === 'record') {
      visit(info.itemType)
      return
    }
    if (info.kind !== 'struct' || info.nested === undefined) return
    if (/^S[A-Z]/u.test(info.typeName ?? '')) found.add(info.typeName!)
    for (const nested of Object.values(info.nested)) visit(nested)
  }
  for (const className of catalogClassesForNamespace(namespace)) {
    const fields = getClassFields(className)
    if (fields !== undefined) for (const type of Object.values(fields)) visit(type)
  }
  return [...found].sort()
}

/** Look up a field type by name, with the PascalCase fallback the walkers use. */
export function lookupField(fields: SchemaFieldMap, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name]
  if (!name) return undefined
  const upper = name[0]!.toUpperCase() + name.slice(1)
  return upper !== name && Object.prototype.hasOwnProperty.call(fields, upper)
    ? fields[upper]
    : undefined
}

/** Normalise a raw field-type entry into a `FieldInfo` (with the structure-type name). */
export function classifyField(t: unknown): FieldInfo {
  const info = classifyFieldInner(t)
  if (info.typeName === undefined && typeof t === 'function') {
    const name = (t as { name?: string }).name
    if (name) info.typeName = name
  }
  return info
}

function classifyFieldInner(t: unknown): FieldInfo {
  if (isArrayType(t)) return { kind: 'array', itemType: t[0] }
  if (isRecordSpec(t)) return { kind: 'record', itemType: t.value, indexType: t.index }

  if (isClass(t)) {
    const cls = t as unknown as {
      value?: unknown
      list?: readonly string[]
      enum?: readonly string[]
      unknown?: string
      link?: unknown
    }
    // Instruction scalars (`CScalar.Dyn` dispatching on a leading keyword to a typed
    // tuple) expose their dispatch table as a static `instructions` map for tooling.
    const instr = (t as { instructions?: Record<string, unknown> }).instructions
    if (instr && typeof instr === 'object') return instructionsInfo(t, instr)
    if (protoInstanceOf(t, CRecord) && 'value' in t) return { kind: 'record', itemType: cls.value }
    // An empty member list means the members are not known (map-defined user flags, enums not
    // yet recovered) — never "nothing is allowed".
    if (protoInstanceOf(t, CFlags)) {
      return Array.isArray(cls.list) && cls.list.length > 0
        ? { kind: 'flags', enumMembers: cls.list }
        : { kind: 'flags' }
    }
    if (protoInstanceOf(t, CEnum)) {
      const enumUnknown = cls.unknown ?? 'Unknown'
      return Array.isArray(cls.enum) && cls.enum.length > 0
        ? { kind: 'enum', enumMembers: cls.enum, enumUnknown }
        : { kind: 'enum', enumUnknown }
    }
    if (protoInstanceOf(t, CLink) && typeof cls.link === 'string') {
      const link = cls.link
      // A file-path link (CImageLink/CTexturePath/…) is identified by its link namespace,
      // not by `instanceof CFile`: the file-link base in @modkitx/data-processing/sc2-schema (schema.links.ts,
      // `static link = 'File'`) is a *different, unexported* class from the exported scalar
      // `CFile` imported here (schema.primitives.ts), so an identity check never matches.
      return {
        kind: 'link',
        linkNamespace: link,
        isTextLink: link === 'String',
        isFileLink: link === 'File',
      }
    }
    if (protoInstanceOf(t, CFile)) return { kind: 'file' }
    if (protoInstanceOf(t, CBoolean)) return { kind: 'bool' }
    if (protoInstanceOf(t, CNumber)) return numberInfo(t)
    // The editor-categories field (`ObjectType:Unit,Race:Terr`) — values are defined
    // by EditorData/EditorCategories.xml, surfaced via @modkitx/editor.
    if (protoInstanceOf(t, TEditorCategories)) return { kind: 'editorCategories' }
    // Catalog-reference scalars carry the target namespace inside the value text,
    // e.g. "Effect,MyEffect,Field" (Effect/Validator/Requirement references).
    if (
      protoInstanceOf(t, CCatalogReference) ||
      protoInstanceOf(t, CGameContentCreationData) ||
      protoInstanceOf(t, CDataEntryPath)
    ) {
      return { kind: 'catalogRef' }
    }
    // A delimited string-array whose element is itself an Instructions scalar
    // (e.g. `CActorTerms = CSArray<CActorTerm>`): a LIST of instructions. Publish the
    // element grammar plus the outer list delimiter so each segment is validated/related.
    if (protoInstanceOf(t, CStringArray)) {
      const member = (t as { memberType?: unknown }).memberType
      const mInstr =
        member && typeof member === 'function'
          ? (member as { instructions?: unknown }).instructions
          : undefined
      if (mInstr && typeof mInstr === 'object') {
        const info = instructionsInfo(member, mInstr as Record<string, unknown>)
        info.instructionListDelimiter = protoInstanceOf(t, CSArray)
          ? ';'
          : protoInstanceOf(t, CWArray)
            ? ' '
            : protoInstanceOf(t, CCArray)
              ? ','
              : ';'
        return info
      }
    }
    // Tuples / string-arrays / CSObject are scalar-serialized composites — too
    // contextual to introspect field-by-field; treat as opaque scalars.
    if (
      protoInstanceOf(t, CTuple) ||
      protoInstanceOf(t, CStringArray) ||
      protoInstanceOf(t, CSObject)
    ) {
      return { kind: 'scalar' }
    }
    const nested = mergedSchema(t)
    if (nested) return { kind: 'struct', nested }
  }
  return { kind: 'scalar' }
}

/**
 * A numeric field's `FieldInfo` with its declared bounds/precision. The bounds live on
 * `CNumber` INSTANCES (baked in by `CNumber.Int/UInt/Real` — e.g. `UInt` ⇒ min 0,
 * `Real32` ⇒ float + the int32 storage range), so we instantiate once to read them.
 * Falls back to a plain number kind if instantiation fails.
 */
/**
 * An instruction-scalar's `FieldInfo`: for each keyword, the positional argument types
 * (the keyword itself excluded). Each dispatch-table entry is a `CWTuple`/`CDTuple` whose
 * `memberTypes` are `[keywordEnum, ...argTypes]`, so args are `memberTypes.slice(1)`.
 */
function instructionsInfo(t: unknown, instr: Record<string, unknown>): FieldInfo {
  const map = new Map<string, FieldInfo[]>()
  for (const [keyword, tupleCls] of Object.entries(instr)) {
    const memberTypes = (tupleCls as { memberTypes?: unknown[] }).memberTypes
    const args = Array.isArray(memberTypes) ? memberTypes.slice(1).map(classifyField) : []
    map.set(keyword, args)
  }
  const fallbackCls = (t as { instructionFallback?: unknown }).instructionFallback
  const info: FieldInfo = {
    kind: 'instructions',
    instructions: map,
    instructionDelimiter: (t as { instructionDelimiter?: string }).instructionDelimiter ?? ' ',
  }
  if (fallbackCls) info.instructionFallback = classifyField(fallbackCls)
  return info
}

function numberInfo(t: AnyClass): FieldInfo {
  const info: FieldInfo = { kind: 'number' }
  try {
    const inst = new (t as unknown as { new (): { min?: number; max?: number; float?: boolean } })()
    if (typeof inst.min === 'number') info.numberMin = inst.min
    if (typeof inst.max === 'number') info.numberMax = inst.max
    if (typeof inst.float === 'boolean') info.numberFloat = inst.float
  } catch {
    /* keep the plain number kind */
  }
  return info
}

/** If a struct field's `Link` shorthand child is a link, return its FieldInfo. */
export function structLinkField(t: unknown): FieldInfo | undefined {
  const nested = mergedSchema(t)
  if (!nested) return undefined
  const info = classifyField(nested['Link'])
  return info.kind === 'link' ? info : undefined
}

export interface ValueIssue {
  message: string
}

function previewMembers(members: readonly string[]): string {
  const head = members.slice(0, 8).join(', ')
  return members.length > 8 ? `${head}, …` : head
}

/**
 * Validate a field's literal value against its type — the self-contained checks the
 * schema fully supports: enum membership, flag members, numeric format, and boolean.
 * Reference *existence* (links / catalog refs / editor categories) is NOT checked here
 * (it needs the loaded catalog) — the consumer does that. Empty and templated values
 * (containing `$`/`#`) are skipped. Returns undefined when the value is acceptable.
 */
export function validateFieldValue(info: FieldInfo, value: string): ValueIssue | undefined {
  if (!value || value.includes('#') || value.includes('$')) return undefined
  switch (info.kind) {
    case 'enum':
      if (!info.enumMembers || /^-?\d+$/.test(value) || value === info.enumUnknown) return undefined
      return info.enumMembers.includes(value)
        ? undefined
        : {
            message: `Invalid value '${value}' — expected one of: ${previewMembers(info.enumMembers)}`,
          }
    case 'flags': {
      if (!info.enumMembers) return undefined
      // SC2 flag strings are delimited by `,` or `;`, with optional +/- prefixes
      // (e.g. "Ally,Neutral,Enemy" or "+Visible;-Dead").
      for (const token of value.split(/[;,]/)) {
        const name = token.replace(/^[+-]/, '').trim()
        if (!name || /^-?\d+$/.test(name) || info.enumMembers.includes(name)) continue
        return {
          message: `Invalid flag '${name}' — expected one of: ${previewMembers(info.enumMembers)}`,
        }
      }
      return undefined
    }
    case 'number': {
      if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(value)) return { message: `Invalid number '${value}'` }
      const num = Number(value)
      if (info.numberFloat === false && !Number.isInteger(num)) {
        return { message: `Expected an integer, got '${value}'` }
      }
      // NB: the schema's logical min/max (`numberMin`/`numberMax`) are deliberately NOT
      // enforced. Real SC2 data routinely uses out-of-"range" numbers — `-1`/`-N` sentinels
      // in UInt fields ("unset"/"infinite"), and small-max (Bit) fields holding packed
      // counts/flags — so range checks produced false positives on valid mods with ~no real
      // bugs caught. Only well-formedness + integer-ness (both clean on real data) are kept.
      return undefined
    }
    case 'bool':
      return value === '0' || value === '1'
        ? undefined
        : { message: `Invalid boolean '${value}' — expected 0 or 1` }
    default:
      return undefined
  }
}
